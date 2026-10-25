import fs from 'fs';
import os from 'os';
import path from 'path';
import { TargetLanguage } from '../types.js';
import { logger } from '../utils/logger.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';

export interface TTSOptions {
  gender?: 'male' | 'female' | 'neutral';
  emotion?: string;
  speed?: number; // 0.8 to 1.5
  voiceStyle?: string;
  /**
   * The job's target language, so the voice engine speaks the language the dub
   * was translated into. Absent means Khmer — the dub the pipeline used to
   * always produce.
   */
  language?: TargetLanguage;
}

export interface TTSResult {
  audioPath: string;
  duration: number;
}

export interface TTSProvider {
  name: string;
  isConfigured(): boolean;
  getModelName(): string;
  synthesizeSpeech(
    text: string,
    outputPath: string,
    options: TTSOptions
  ): Promise<TTSResult>;
}

/** The target that old jobs and missing values fall back to. */
const DEFAULT_TTS_LANGUAGE = 'km';

/** The label the settings card shows for the voice engine. */
export const GTTS_MODEL = 'Google Translate TTS (gTTS)';

/**
 * The language codes `translate_tts` expects. Same as Google Translate's, so
 * Mandarin is `zh-CN` and everything else keeps the studio's own code.
 */
const GTTS_LANGUAGE_CODES: Record<string, string> = {
  km: 'km',
  en: 'en',
  zh: 'zh-CN',
  th: 'th',
  vi: 'vi',
  ko: 'ko',
  ja: 'ja',
  fr: 'fr',
  es: 'es',
};

/**
 * The endpoint gTTS wraps: one MP3 per request, no key, no model download.
 *
 * Two hosts, same service — a throttled host (429) is skipped for the next
 * attempt instead of costing the line its voice.
 */
const GTTS_HOSTS = ['translate.google.com', 'translate.googleapis.com'];

/**
 * How much text one request may carry.
 *
 * `translate_tts` rejects long queries (gTTS itself splits at ~100 characters),
 * so a line longer than this is cut into pieces that are joined back into one
 * WAV below. Cutting at punctuation/spaces keeps the seam between two requests
 * inside a natural pause.
 */
const GTTS_MAX_CHARS = Number(process.env.GTTS_MAX_CHARS || '180');

const GTTS_TIMEOUT_MS = Number(process.env.GTTS_TIMEOUT_MS || '20000');
const GTTS_MAX_ATTEMPTS = Math.max(1, Number(process.env.GTTS_MAX_ATTEMPTS || '4'));
const GTTS_RETRY_BACKOFF_MS = Math.max(0, Number(process.env.GTTS_RETRY_BACKOFF_MS || '900'));

const GTTS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** The gTTS code for a target language; unknown values speak Khmer. */
export function gttsLanguageCode(language: string | undefined): string {
  const key = (language || '').trim().toLowerCase();
  return GTTS_LANGUAGE_CODES[key] || GTTS_LANGUAGE_CODES[DEFAULT_TTS_LANGUAGE];
}

/**
 * Split one dialogue line into the pieces a single `translate_tts` request can
 * carry.
 *
 * The split is made after sentence/clause punctuation first and only hard-cuts a
 * piece that has none, so the two requests are never joined mid-phrase when the
 * text gives any choice. Khmer words are not space-separated, so a very long
 * Khmer line is the one case that can be cut mid-word — the alternative is
 * losing the line entirely.
 */
export function splitForGoogleTts(
  text: string,
  maxChars = Number.isFinite(GTTS_MAX_CHARS) && GTTS_MAX_CHARS >= 20 ? GTTS_MAX_CHARS : 180
): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const clauses = clean.match(/[^.!?…។៕,;:]+[.!?…។៕,;:]?/g) || [clean];
  const pieces: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };

  for (const clause of clauses) {
    const piece = clause.trim();
    if (!piece) continue;

    if (piece.length > maxChars) {
      flush();
      for (let i = 0; i < piece.length; i += maxChars) {
        const slice = piece.slice(i, i + maxChars).trim();
        if (slice) pieces.push(slice);
      }
      continue;
    }

    if (`${current} ${piece}`.trim().length > maxChars) flush();
    current = `${current} ${piece}`.trim();
  }

  flush();
  return pieces;
}

class GttsRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GttsRequestError';
  }
}

/** One `translate_tts` request. No retry — the caller owns the rotation. */
async function requestGttsAudio(
  host: string,
  text: string,
  language: string
): Promise<Buffer> {
  const params = new URLSearchParams({
    ie: 'UTF-8',
    client: 'tw-ob',
    tl: language,
    ttsspeed: '1',
    q: text,
  });

  let response: Response;
  try {
    response = await fetch(`https://${host}/translate_tts?${params.toString()}`, {
      headers: {
        'User-Agent': GTTS_USER_AGENT,
        Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
        Referer: 'https://translate.google.com/',
      },
      signal: AbortSignal.timeout(GTTS_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error';
    throw new GttsRequestError(`Google TTS request failed (${reason}).`);
  }

  if (!response.ok) {
    await response.text().catch(() => '');
    throw new GttsRequestError(`Google TTS answered ${response.status}.`, response.status);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new GttsRequestError('Google TTS returned no audio.');
  }
  return audio;
}

/** Download one line's audio, rotating hosts and backing off on a throttle. */
async function fetchSpeech(
  text: string,
  language: string,
  destinationPath: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GTTS_MAX_ATTEMPTS; attempt++) {
    const host = GTTS_HOSTS[(attempt - 1) % GTTS_HOSTS.length];
    try {
      const audio = await requestGttsAudio(host, text, language);
      fs.writeFileSync(destinationPath, audio);
      return;
    } catch (err) {
      lastError = err;
      const status = err instanceof GttsRequestError ? err.status : undefined;
      const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt >= GTTS_MAX_ATTEMPTS) break;
      const wait = GTTS_RETRY_BACKOFF_MS * attempt;
      logger.warn(
        `Google TTS failed on ${host} (attempt ${attempt}/${GTTS_MAX_ATTEMPTS}); retrying in ${wait}ms: ${
          err instanceof Error ? err.message : err
        }`
      );
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError instanceof Error ? lastError : new GttsRequestError('Google TTS failed.');
}

/**
 * Google Translate's own text-to-speech — the service the `gTTS` package wraps.
 *
 * It needs no key and no downloaded voice model: the text is sent to
 * `translate_tts` and an MP3 comes back, which FFmpeg turns into the 44.1 kHz
 * stereo WAV the mixing stage expects. One voice exists per language, so the
 * `gender` setting cannot pick between a male and a female speaker here; the
 * dialogue is spoken by the language's single gTTS voice.
 */
export class GoogleTTSProvider implements TTSProvider {
  name = 'gtts';

  isConfigured(): boolean {
    // No key required — this is the always-available voice engine.
    return process.env.GTTS_ENABLED !== 'false';
  }

  getModelName(): string {
    return GTTS_MODEL;
  }

  async synthesizeSpeech(
    text: string,
    outputPath: string,
    options: TTSOptions
  ): Promise<TTSResult> {
    const cleanText = text.trim();
    if (!cleanText) {
      throw new Error('Cannot synthesize empty speech text.');
    }

    const language = gttsLanguageCode(options.language);
    const pieces = splitForGoogleTts(cleanText);
    if (pieces.length === 0) {
      throw new Error('Cannot synthesize empty speech text.');
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtts-'));

    try {
      const mp3Paths: string[] = [];
      for (let i = 0; i < pieces.length; i++) {
        const mp3Path = path.join(workDir, `part-${String(i + 1).padStart(3, '0')}.mp3`);
        await fetchSpeech(pieces[i], language, mp3Path);
        mp3Paths.push(mp3Path);
      }

      if (mp3Paths.length === 1) {
        // gTTS returns 24 kHz mono MP3; the mixing stage works in 44.1 kHz stereo.
        await FFmpegHelper.execute([
          '-y',
          '-i', mp3Paths[0],
          '-ar', '44100',
          '-ac', '2',
          outputPath,
        ]);
      } else {
        // Several requests for one long line: join them in order, then transcode.
        const listPath = path.join(workDir, 'parts.txt');
        const list = mp3Paths
          .map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
          .join('\n');
        fs.writeFileSync(listPath, `${list}\n`, 'utf8');
        await FFmpegHelper.execute([
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-ar', '44100',
          '-ac', '2',
          outputPath,
        ]);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    return {
      audioPath: outputPath,
      duration: await FFmpegHelper.getAudioDuration(outputPath),
    };
  }
}

export function getTTSProvider(): TTSProvider {
  // gTTS is the voice engine, full stop: keyless, model-free, and able to speak
  // every target the studio offers.
  return new GoogleTTSProvider();
}
