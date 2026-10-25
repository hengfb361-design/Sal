import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';
import {
  ResolvedSeparatorConnection,
  getSeparatorConnection,
} from './separatorSettings.js';

/**
 * How much audio one request may carry.
 *
 * A quick Cloudflare tunnel cuts a request off after roughly 100 seconds (HTTP
 * 524) and a phone separating on CPU runs several times slower than realtime, so
 * sending a whole video's audio in one request always ended in 524 and a failed
 * job. The audio is therefore cut into short pieces, each separated by its own
 * request, and the stems are joined back in order — the timeline is unchanged
 * because the pieces are cut at exact offsets and each piece's two stems come
 * from the same separation.
 */
const CHUNK_SECONDS = Number(process.env.AUDIO_SEPARATOR_CHUNK_SECONDS || '15');
/** Never split below this: a shorter piece costs more in overhead than it saves. */
const MIN_CHUNK_SECONDS = Number(process.env.AUDIO_SEPARATOR_MIN_CHUNK_SECONDS || '3');
/** What one tunnel request may take before it counts as "too much audio". */
const TUNNEL_REQUEST_TIMEOUT_MS = Number(
  process.env.AUDIO_SEPARATOR_TUNNEL_TIMEOUT_MS || '110000'
);
const LONG_REQUEST_TIMEOUT_MS = 1_800_000;
/** How many times one piece is sent before its failure is believed. */
const MAX_ATTEMPTS = Math.max(1, Number(process.env.AUDIO_SEPARATOR_MAX_ATTEMPTS || '3'));
/** Wait before retrying a dropped request; it grows with the attempt number. */
const RETRY_DELAY_MS = Math.max(0, Number(process.env.AUDIO_SEPARATOR_RETRY_DELAY_MS || '6000'));
/** Tries to download one finished stem, and the wait between them. */
const STEM_ATTEMPTS = 3;
const STEM_RETRY_DELAY_MS = 3000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * About one Demucs window. The model processes a piece in whole ~7.8 second
 * windows, so a piece this long costs one window while a piece twice as long
 * costs three — which is why the first shrink is aimed here instead of at the
 * smallest size. A phone that cannot finish 15s almost always finishes 7.5s,
 * and 7.5s pieces carry two and a half times more audio per request than 3s
 * pieces do. That difference is the whole throughput of the stage.
 */
const ONE_WINDOW_SECONDS = Math.max(
  MIN_CHUNK_SECONDS,
  Number(process.env.AUDIO_SEPARATOR_WINDOW_SECONDS || '7.5')
);
/** A piece that used under this share of the request budget has room to grow. */
const GROW_FRACTION = 0.35;
/** Successful full-size pieces in a row before more audio is asked for. */
const GROW_AFTER = 3;
/** How much more audio to try then. */
const GROW_STEP_SECONDS = 2;

/**
 * How much audio one piece may carry when the service reports a GPU.
 *
 * The 15 second default exists for a phone: a quick Cloudflare tunnel cuts a
 * request at roughly 100 seconds, and a phone needs most of that window for 15
 * seconds of audio. A service running on a GPU (a Google Colab runtime, a home
 * machine with CUDA) separates a minute and a half of audio in a few seconds, so
 * the same request window buys far more audio per round trip — and fewer piece
 * boundaries in the joined stems. The cap stays under the tunnel's cutoff so the
 * bigger piece is never the reason a request is cut.
 */
const GPU_CHUNK_SECONDS = Number(process.env.AUDIO_SEPARATOR_GPU_CHUNK_SECONDS || '90');
/** Devices that mean the model is not being run on a CPU. */
const ACCELERATOR_DEVICES = /^(cuda|mps|metal|gpu|xpu|rocm|directml)/i;

/**
 * The largest piece the service has proved it can finish in time.
 *
 * A phone's speed is not a constant: it drops when the battery is low or the
 * device is warm and comes back once it is charged and cool, and a busy phone
 * (a connection test running alongside the job) looks slow for a minute. So the
 * remembered size both falls and rises:
 *
 *  - a piece that times out halves it, but the first shrink lands on one model
 *    window rather than the smallest size, so the oversized attempt is paid once
 *    and the pieces stay big enough to be efficient;
 *  - pieces that finish with the budget to spare grow it back, so a job that ran
 *    while the phone was hot does not leave every later job crippled.
 *
 * `pieceLimit()` still caps the result at the configured size, and nothing below
 * `MIN_CHUNK_SECONDS` is ever attempted.
 */
let learnedChunkSeconds = Number.POSITIVE_INFINITY;
/** Consecutive full-size pieces that finished with the budget to spare. */
let fastPieceRun = 0;

/** Remember that `length` seconds of audio could not be finished in time. */
function notePieceTimedOut(length: number): void {
  fastPieceRun = 0;

  const halved = Math.max(MIN_CHUNK_SECONDS, Number((length / 2).toFixed(3)));
  const smaller =
    length > ONE_WINDOW_SECONDS && halved < ONE_WINDOW_SECONDS ? ONE_WINDOW_SECONDS : halved;

  if (smaller < learnedChunkSeconds) {
    learnedChunkSeconds = smaller;
    logger.warn(
      `The stem service could not finish ${length.toFixed(1)}s of audio in time; pieces are now capped at ${smaller.toFixed(1)}s.`
    );
  }
}

/**
 * Remember how long one finished piece took, and ask for more audio when the
 * service keeps finishing them early. Only a piece that actually used the
 * current limit counts: a short tail piece proves nothing about what fits.
 */
function notePieceFinished(
  length: number,
  limit: number,
  elapsedMs: number,
  budgetMs: number
): void {
  if (length < limit * 0.8 || elapsedMs > budgetMs * GROW_FRACTION) {
    fastPieceRun = 0;
    return;
  }

  fastPieceRun++;
  if (fastPieceRun < GROW_AFTER) return;

  fastPieceRun = 0;
  if (!Number.isFinite(learnedChunkSeconds)) return;

  learnedChunkSeconds = Number((learnedChunkSeconds + GROW_STEP_SECONDS).toFixed(3));
  logger.info(
    `The stem service finished ${length.toFixed(1)}s pieces well inside the request window; pieces may now go up to ${learnedChunkSeconds.toFixed(1)}s.`
  );
}

/**
 * The service did not answer inside the time a request is allowed — on a quick
 * tunnel that is Cloudflare's ~100 second cutoff. It means "this much audio is
 * too much", which is answered by sending a smaller piece, not by failing.
 */
export class SlowSeparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlowSeparationError';
  }
}

/**
 * The request died before the service had a chance to answer: a quick tunnel
 * dropping its connection, a 502/530 gateway page, a reset socket. A tunnel like
 * that comes back on its own within seconds, so this is retried with the same
 * audio instead of being answered by sending less of it.
 */
class TransientSeparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientSeparationError';
  }
}

/** Cloudflare's own timeout page means the request ran out of time. */
function isTooSlowStatus(status: number): boolean {
  return status === 504 || status === 524;
}

/** Cloudflare's gateway pages for "the tunnel is not connected right now". */
function isTunnelDownStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 530;
}

/** A Cloudflare page saying the tunnel itself is down, whatever the status was. */
function isTunnelDownBody(body: string): boolean {
  return /Error 1033|Error 1016|Cloudflare Tunnel error|cloudflared/i.test(body);
}

/**
 * A connection that was lost is `too slow` when it lasted most of the time a
 * request is allowed — Cloudflare cuts a tunnel at about 100 seconds — and a
 * tunnel blip when it died early.
 */
function classifyLostRequest(detail: string, elapsedMs: number, timeoutMs: number): Error {
  const earlyLimit = Math.min(60_000, timeoutMs * 0.6);
  return elapsedMs < earlyLimit
    ? new TransientSeparationError(detail)
    : new SlowSeparationError(detail);
}

/**
 * Service failures can arrive as whole HTML documents (a 524 is a full page),
 * which is unreadable inside a job error. Keep the first meaningful line.
 */
function summariseServiceBody(body: string): string {
  const withoutNoise = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const text = /<[a-z][\s\S]*>/i.test(withoutNoise)
    ? withoutNoise.replace(/<[^>]+>/g, ' ')
    : withoutNoise;
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export interface SeparationResult {
  vocalsPath: string;
  noVocalsPath: string;
  /**
   * True when the background track still contains the original voices. Demucs
   * removes them cleanly, so this is false on every successful separation; the
   * mixer still honours it so a degraded run could never be over-dipped.
   */
  backgroundHasOriginalVoice?: boolean;
}

/**
 * Splitting the voices out of a video. Real model separation is the Demucs
 * service and nothing else — there is no substitute that removes the original
 * voices, so a run without Demucs would lay Khmer over the untouched mix and
 * keep the source dialogue audible underneath it. Demucs is therefore a
 * requirement, not an enhancement: the website refuses to start a job and the
 * pipeline refuses to continue when no stem service is connected (see
 * `DEMUCS_REQUIRED_MESSAGE`).
 */
export interface AudioSeparationProvider {
  name: string;
  isConfigured(): boolean;
  separate(inputWavPath: string, outputDir: string): Promise<SeparationResult>;
}

// --------------------------------------------------------------- remote stems

/** Where a stem lives, as whatever the service answered with. */
interface StemLocation {
  /** A URL, a path on the service, a `data:` URI, or raw base64. */
  value: string;
  /** The value is base64 audio rather than a location. */
  base64: boolean;
}

/** Multipart field names real-world stem services use for the upload. */
const UPLOAD_FIELDS = ['audio', 'file', 'video', 'track', 'input'];
/** Endpoint paths to try when the service was not told a specific one. */
const SEPARATE_PATHS = ['/separate', '/separate/', '/api/separate', '/api/v1/separate', '/stem'];

/**
 * Name a stem by its key — `vocals`, `no_vocals`, `instrumental`, `other`, …
 * The keys are compared with everything but letters and digits stripped, so
 * `no_vocals`, `noVocals` and `no-vocals` are all the same thing.
 */
function classifyStemName(rawName: string): 'vocals' | 'instrumental' | null {
  const name = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!name) return null;
  // "novocals"/"instrumental"/"accompaniment" all describe the music stem, and
  // they contain "vocal", so they have to be recognised first.
  if (/(novocal|instrumental|accompaniment|karaoke|background|music|other)/.test(name)) {
    return 'instrumental';
  }
  if (/(vocal|voice)/.test(name)) return 'vocals';
  return null;
}

interface FlatStemEntry {
  key: string;
  location: StemLocation;
}

/**
 * Walk whatever JSON came back and list every string in it, tagged with the key
 * it sat under.
 *
 * Services disagree about the shape — `{vocals, instrumental}`,
 * `{stems: [{name, url}]}`, `{output: {vocals: {url}}}`, sometimes base64 in
 * `{data, encoding}` — so the payload is flattened first and picked apart after,
 * instead of betting on one layout.
 */
function flattenStemEntries(
  value: unknown,
  key = '',
  out: FlatStemEntry[] = [],
  depth = 0
): FlatStemEntry[] {
  if (depth > 6 || out.length > 400) return out;

  if (typeof value === 'string') {
    out.push({ key, location: { value, base64: false } });
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) flattenStemEntries(item, key, out, depth + 1);
    return out;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    // `{ "data": "UklGR...", "encoding": "base64" }` and friends.
    const encoded =
      typeof record.data === 'string'
        ? record.data
        : typeof record.base64 === 'string'
        ? record.base64
        : null;
    if (encoded) out.push({ key, location: { value: encoded, base64: true } });

    for (const [childKey, childValue] of Object.entries(record)) {
      if (childKey === 'data' || childKey === 'base64' || childKey === 'encoding') continue;
      flattenStemEntries(childValue, childKey, out, depth + 1);
    }
  }

  return out;
}

/** Find the location of one stem in an answer of unknown shape. */
function pickStemLocation(payload: unknown, kind: 'vocals' | 'instrumental'): StemLocation | null {
  const entries = flattenStemEntries(payload);

  // 1. The key names the stem (`{"vocals": "..."}`).
  for (const entry of entries) {
    if (!entry.location.base64 && classifyStemName(entry.key) === kind) return entry.location;
  }

  // 2. The file name does (`{"outputs": [".../vocals.wav", ".../no_vocals.wav"]}`).
  for (const entry of entries) {
    if (entry.location.base64 || entry.location.value.startsWith('data:')) continue;
    const filename = entry.location.value.split('?')[0].split('/').pop() || '';
    if (classifyStemName(filename) === kind) return entry.location;
  }

  // 3. Only the audio itself came back, with no name attached.
  for (const entry of entries) {
    if (entry.location.base64) return entry.location;
  }

  return null;
}

function decodeBase64Audio(value: string): Buffer {
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  return Buffer.from(payload.replace(/\s+/g, ''), 'base64');
}

/**
 * `fetch` collapses every network-level failure into the bare message "fetch
 * failed" and hides the real reason in `cause` — ENOTFOUND when the address no
 * longer exists, ECONNREFUSED, a reset connection, a timeout. A quick tunnel is
 * exactly the case where that detail matters: it is handed a brand-new hostname
 * every time it is reopened, so the old one stops resolving entirely. Lifting the
 * cause into the message is what turns an opaque failure into a fixable one.
 */
function describeFetchError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (!cause) return base;

  const detail =
    typeof cause === 'object' && cause !== null
      ? (cause as { code?: string }).code ?? (cause as Error).message
      : String(cause);

  return detail && detail !== base ? `${base} (${detail})` : base;
}

/** Everything that went wrong inside `fetch`, message and all, as one string. */
function fetchErrorText(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: string }).name ?? '' : '';
  return `${name} ${describeFetchError(err)}`;
}

/**
 * A sentence naming what to check, chosen from how the connection actually
 * failed. Empty when the failure was about the stems rather than the network, so
 * a service that answered wrongly is not blamed on a dead tunnel.
 */
function connectionHint(err: unknown): string {
  const text = fetchErrorText(err);

  if (/ENOTFOUND|EAI_AGAIN|Could not resolve|getaddrinfo/i.test(text)) {
    return ' រកអាសយដ្ឋាននេះមិនឃើញ — tunnel នេះបានបិទហើយ។ Quick tunnel ទទួលបាន URL ថ្មីរាល់ពេលបើក ដូច្នេះសូមបើកវាឡើងវិញ រួច paste URL ថ្មីក្នុងកាត «ញែកភ្លេង»។ (That hostname no longer exists: the quick tunnel is closed and has a new URL — reopen it and paste the new one.)';
  }

  if (/ECONNREFUSED|ECONNRESET|other side closed|socket hang up|EPIPE/i.test(text)) {
    return ' ភ្ជាប់ទៅម៉ាស៊ីនញែកភ្លេងមិនបាន — API ឬ tunnel បានបិទ។ សូមបើកវាឡើងវិញនៅលើទូរស័ព្ទ។ (The connection was refused or dropped: the Demucs API or its tunnel is not running.)';
  }

  if (/TimeoutError|AbortError|ETIMEDOUT|UND_ERR.*TIMEOUT|timed out/i.test(text)) {
    return ' អស់ពេលរង់ចាំ — ម៉ាស៊ីនញែកភ្លេងយឺត ឬបណ្តាញទូរស័ព្ទដាច់។ សាកល្បងវីដេអូខ្លី ឬពិនិត្យបណ្តាញ។ (It timed out: the phone is slow or its network dropped.)';
  }

  if (/Error 1033|Cloudflare Tunnel error|cloudflared|\b530\b/i.test(text)) {
    return ' tunnel នេះបានដាច់ពី Cloudflare (Error 1033) — cloudflared លើទូរស័ព្ទឈប់ ឬបណ្តាញដាច់។ សូមបើក cloudflared ឡើងវិញ រួច paste URL ថ្មីក្នុងកាត «ញែកភ្លេង»។ (The tunnel is no longer connected to Cloudflare: restart cloudflared on the phone and paste the new URL.)';
  }

  if (/fetch failed|UND_ERR/i.test(text)) {
    return ' សូមពិនិត្យថា Demucs API និង tunnel កំពុងរត់នៅលើទូរស័ព្ទ រួចចុច «សាកល្បងការតភ្ជាប់» ម្តងទៀត។ (Check that the Demucs API and its tunnel are still running on the phone.)';
  }

  return '';
}

/**
 * An answer that names a folder instead of the two stems is what the phone's
 * first `demucs_api.py` replied with: it separated the audio into files only it
 * could see. Saying so matters, because that shape looks like a tunnel fault
 * and is really an out-of-date copy of the service still running.
 */
function oldServiceHint(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  if (!('output_folder' in (payload as Record<string, unknown>))) return '';
  return ' ម៉ាស៊ីននេះជា demucs_api.py ជំនាន់ចាស់ (ត្រឡប់តែថតឯកសារ មិនត្រឡប់ vocals/instrumental) — សូមធ្វើបច្ចុប្បន្នភាពវាលើទូរស័ព្ទដោយ `sh restart-api.sh` រួចសាកល្បងម្តងទៀត។ (The stem service is an out-of-date demucs_api.py: restart it with the current file and test again.)';
}

/**
 * A stem service reached over HTTP.
 *
 * The Node/FFmpeg host cannot run UVR/Demucs models itself, so the model runs
 * somewhere else — a phone in Termux, a home server, or the bundled
 * `audio-separator` sidecar in `tools/audio-separator-server/` — and this
 * provider talks to it: upload the extracted WAV, fetch the two stems back.
 *
 * The address comes from `server/services/separatorSettings.ts`: the connection
 * the app owner saved from the website first, then `AUDIO_SEPARATOR_URL`.
 *
 * Because the model removes the dialogue from the background completely, the
 * returned background is reported as carrying no original voice, which is what
 * lets the mixer hold the music at full level under the Khmer dialogue (a gentle
 * 6 dB dip) instead of gating it down to -30 dB.
 *
 * This provider never substitutes a lesser separation: it either returns real
 * Demucs stems or throws with the reason, and that reason ends the job. A run
 * that cannot separate the voices is not a cheaper dub — it is a dub played on
 * top of the original dialogue — so failing loudly is the honest answer.
 */
export class RemoteStemSeparationProvider implements AudioSeparationProvider {
  name: string;

  /**
   * How long a piece may be on this run. Set once per separation, after the
   * service has been asked what it is running on: see `resolveChunkSeconds`.
   */
  private activeChunkSeconds = 0;

  constructor(name = 'demucs_api') {
    this.name = name;
  }

  isConfigured(): boolean {
    return Boolean(getSeparatorConnection().url);
  }

  /** Model name to ask for; empty means "whatever the service defaults to". */
  getModelName(): string {
    const connection = getSeparatorConnection();
    if (connection.model) return connection.model;
    // A Demucs service rejects an MDX file name and the other way round, so the
    // sidecar name is only used for the sidecar this repository ships.
    return this.name === 'demucs_api' ? '' : 'UVR-MDX-NET-Inst_HQ_3';
  }

  async separate(inputWavPath: string, outputDir: string): Promise<SeparationResult> {
    const vocalsPath = path.join(outputDir, 'vocals.wav');
    const noVocalsPath = path.join(outputDir, 'no_vocals.wav');
    const connection = getSeparatorConnection();

    if (!connection.url) {
      throw new Error(DEMUCS_REQUIRED_MESSAGE);
    }

    // The stems are streamed straight to disk, and the caller's directory may
    // not exist yet on the "test connection" path.
    fs.mkdirSync(outputDir, { recursive: true });

    // Cut pieces and their stems live here; the finished pair is what the
    // caller keeps.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-pieces-'));

    try {
      // Ask what this service is running on before the pieces are planned: a GPU
      // takes far more audio per request than a phone, so it should be sent
      // bigger pieces (see `resolveChunkSeconds`).
      this.activeChunkSeconds = await this.resolveChunkSeconds(connection);

      const duration = await FFmpegHelper.getAudioDuration(inputWavPath).catch(() => 0);
      const pieces = this.planPieces(duration, this.pieceLimit());

      const vocalsPieces: string[] = [];
      const instrumentalPieces: string[] = [];
      let model = '';

      for (let i = 0; i < pieces.length; i++) {
        const label = `p${String(i + 1).padStart(4, '0')}`;
        const piece = await this.separatePiece(
          connection.url,
          connection.apiKey,
          connection.path,
          inputWavPath,
          pieces[i],
          workDir,
          label
        );

        vocalsPieces.push(piece.vocalsPath);
        instrumentalPieces.push(piece.noVocalsPath);
        model = piece.model || model;

        if (pieces.length > 1) {
          logger.info(
            `Stem piece ${i + 1}/${pieces.length} done (from ${pieces[i].start.toFixed(1)}s, ${pieces[i].length.toFixed(1)}s long).`
          );
        }
      }

      await this.joinPieces(vocalsPieces, vocalsPath);
      await this.joinPieces(instrumentalPieces, noVocalsPath);

      const usable = (p: string) => fs.existsSync(p) && fs.statSync(p).size > 1024;
      if (!usable(vocalsPath) || !usable(noVocalsPath)) {
        throw new Error('the service answered without usable stems');
      }

      logger.info(
        `Stem service finished (${connection.url}, ${pieces.length} piece(s), model: ${
          model || this.getModelName() || 'default'
        })`
      );
      return {
        vocalsPath,
        noVocalsPath,
        // Dialogue is gone from the background, so the music can stay loud.
        backgroundHasOriginalVoice: false,
      };
    } catch (err: any) {
      const reason = describeFetchError(err);
      logger.warn(`Stem separation via ${connection.url} failed:`, reason);
      // The reason travels with the error; the pipeline reports it on the job
      // and continues on the untouched mix rather than losing the translation.
      // A Colab-hosted service only answers while that notebook session is alive,
      // which is a way for a service to disappear that no other host has.
      const colabHint = isColabHost(connection.url)
        ? ' Colab session បានឈប់ ឬដាច់ — បើក notebook ឡើងវិញ រួច paste URL ថ្មីក្នុងកាត «ញែកភ្លេង»។ (The Colab session stopped: reopen the notebook and paste its new URL.)'
        : '';

      const slowHint =
        err instanceof SlowSeparationError
          ? ' ការភ្ជាប់ត្រូវបានកាត់ដោយ tunnel (ប្រហែល ១០០ វិនាទី) ទោះបានបែងចែកជាកំណាត់តូចរួចហើយ។ សូមសាកល្បងវីដេអូខ្លីជាង ឬបិទកម្មវិធីផ្សេងលើទូរស័ព្ទ។ (The tunnel cut the request even after the audio was split; the phone needs a shorter video or fewer apps running.)'
          : '';
      throw new Error(
        `ញែកភ្លេងដោយ Demucs បរាជ័យ៖ ${reason} (Demucs stem separation failed.)${connectionHint(
          err
        )}${slowHint}${colabHint}`
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** How long one piece may be, in seconds. */
  private getChunkSeconds(): number {
    return Number.isFinite(CHUNK_SECONDS) && CHUNK_SECONDS > 0 ? CHUNK_SECONDS : 15;
  }

  /**
   * How long a piece may be on this service right now: what was configured,
   * lowered to what this phone has proved it can finish in one request.
   */
  private pieceLimit(): number {
    return Math.min(this.activeChunkSeconds || this.getChunkSeconds(), learnedChunkSeconds);
  }

  /**
   * How much audio one piece may carry on this service.
   *
   * A phone on CPU is the reason the default is short, and a service that does
   * not say what it runs on keeps that default. A service that reports an
   * accelerator is worth sending much bigger pieces: the upload/download round
   * trip dominates a GPU's own running time, and every piece boundary is a place
   * where the joined stems can seam. Nothing is assumed from the URL — a Colab
   * tunnel looks exactly like a phone tunnel over the network — so this reads
   * what the service itself reports on its health answer.
   */
  private async resolveChunkSeconds(
    connection: ResolvedSeparatorConnection
  ): Promise<number> {
    const configured = this.getChunkSeconds();
    if (!Number.isFinite(GPU_CHUNK_SECONDS) || GPU_CHUNK_SECONDS <= configured) {
      return configured;
    }

    const device = await probeServiceDevice(connection.url, connection.apiKey);
    if (!ACCELERATOR_DEVICES.test(device)) return configured;

    logger.info(
      `The stem service runs on ${device}: pieces may now carry up to ${GPU_CHUNK_SECONDS}s of audio each.`
    );
    return GPU_CHUNK_SECONDS;
  }

  /**
   * The exact, gap-free windows that cover the whole track. A track that already
   * fits in one piece (or whose duration could not be read) yields a single
   * window with `length: 0`, which means "separate the file as it is".
   */
  private planPieces(duration: number, chunkSeconds: number): { start: number; length: number }[] {
    if (!Number.isFinite(duration) || duration <= 0 || duration <= chunkSeconds) {
      return [{ start: 0, length: 0 }];
    }

    const pieces: { start: number; length: number }[] = [];
    for (let start = 0; start < duration - 0.001; start += chunkSeconds) {
      pieces.push({
        start: Number(start.toFixed(3)),
        length: Number(Math.min(chunkSeconds, duration - start).toFixed(3)),
      });
    }
    return pieces;
  }

  /**
   * One piece, with the fallback that makes long videos work: if the phone could
   * not finish it inside the tunnel's request window, the same piece is split in
   * half and each half is sent on its own. A piece is never sent again at a size
   * that already timed out inside the same job, so splitting always terminates.
   * A piece that was the whole file (length 0) is measured first so it can shrink
   * too.
   */
  private async separatePiece(
    base: string,
    apiKey: string,
    configuredPath: string,
    source: string,
    piece: { start: number; length: number },
    workDir: string,
    label: string
  ): Promise<{ vocalsPath: string; noVocalsPath: string; model?: string }> {
    // This much audio already timed out once, so it is halved before it is sent:
    // the wasted request is paid once per job instead of once per piece.
    if (piece.length > this.pieceLimit()) {
      return this.splitPiece(base, apiKey, configuredPath, source, piece, workDir, label);
    }

    const dir = path.join(workDir, label);
    fs.mkdirSync(dir, { recursive: true });

    const input = piece.length > 0 ? path.join(dir, 'piece.wav') : source;
    if (piece.length > 0) await this.cutPiece(source, piece, input);

    const budgetMs = this.requestTimeoutMs(base);
    const startedAt = Date.now();

    try {
      const result = await this.separateWithRetries(base, apiKey, configuredPath, input, dir);
      // Evidence that this phone can take this much audio per request.
      notePieceFinished(piece.length, this.pieceLimit(), Date.now() - startedAt, budgetMs);
      return result;
    } catch (err) {
      if (!(err instanceof SlowSeparationError)) throw err;

      // A piece of length 0 means "the file as it is": the track was shorter
      // than one piece, or its duration could not be read when the split was
      // planned. Read the duration now, so even that piece can be answered by
      // sending less audio instead of failing the whole job.
      let start = piece.start;
      let length = piece.length;
      if (length <= 0) {
        const duration = await FFmpegHelper.getAudioDuration(source).catch(() => 0);
        if (duration <= 0) throw err;
        start = 0;
        length = duration;
      }

      // Even the smallest piece times out: nothing is left to shrink, so this is
      // a real failure and it is reported with the service's own words.
      if (length <= MIN_CHUNK_SECONDS) throw err;

      notePieceTimedOut(length);
      return this.splitPiece(
        base,
        apiKey,
        configuredPath,
        source,
        { start, length },
        workDir,
        label
      );
    }
  }

  /**
   * One upload, retried while the failure was the tunnel rather than the audio.
   *
   * A quick tunnel drops requests on its own schedule — Error 1033, a 530, a
   * reset socket — and normally reconnects by itself, so the same audio is sent
   * again a couple of times before the job is told the service is down.
   */
  private async separateWithRetries(
    base: string,
    apiKey: string,
    configuredPath: string,
    input: string,
    dir: string
  ): Promise<{ vocalsPath: string; noVocalsPath: string; model?: string }> {
    let lastError: unknown = new Error('the stem service was never asked');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.separateFile(base, apiKey, configuredPath, input, path.join(dir, 'raw'));
      } catch (err) {
        lastError = err;
        if (!(err instanceof TransientSeparationError) || attempt >= MAX_ATTEMPTS) break;

        const waitMs = RETRY_DELAY_MS * attempt;
        logger.warn(
          `The stem service dropped that request (${err.message}); sending the same piece again in ${(
            waitMs / 1000
          ).toFixed(0)}s.`
        );
        await delay(waitMs);
      }
    }

    throw lastError;
  }

  /** Send one window as two halves and join their stems back in order. */
  private async splitPiece(
    base: string,
    apiKey: string,
    configuredPath: string,
    source: string,
    piece: { start: number; length: number },
    workDir: string,
    label: string
  ): Promise<{ vocalsPath: string; noVocalsPath: string; model?: string }> {
    const half = Number((piece.length / 2).toFixed(3));
    if (half <= 0) throw new Error(`cannot split ${piece.length.toFixed(1)}s any further`);

    logger.warn(
      `The stem service could not finish ${piece.length.toFixed(1)}s of audio from ${piece.start.toFixed(
        1
      )}s in time; sending it as two halves instead.`
    );

    const first = await this.separatePiece(
      base,
      apiKey,
      configuredPath,
      source,
      { start: piece.start, length: half },
      workDir,
      `${label}a`
    );
    const second = await this.separatePiece(
      base,
      apiKey,
      configuredPath,
      source,
      { start: Number((piece.start + half).toFixed(3)), length: Number((piece.length - half).toFixed(3)) },
      workDir,
      `${label}b`
    );

    const dir = path.join(workDir, label);
    fs.mkdirSync(dir, { recursive: true });
    const vocalsPath = path.join(dir, 'vocals.wav');
    const noVocalsPath = path.join(dir, 'no_vocals.wav');
    await this.joinPieces([first.vocalsPath, second.vocalsPath], vocalsPath);
    await this.joinPieces([first.noVocalsPath, second.noVocalsPath], noVocalsPath);

    return { vocalsPath, noVocalsPath, model: first.model || second.model };
  }

  /** Upload one file and download both of its stems into `targetDir`. */
  private async separateFile(
    base: string,
    apiKey: string,
    configuredPath: string,
    inputWavPath: string,
    targetDir: string
  ): Promise<{ vocalsPath: string; noVocalsPath: string; model?: string }> {
    fs.mkdirSync(targetDir, { recursive: true });
    const vocalsPath = path.join(targetDir, 'vocals.wav');
    const noVocalsPath = path.join(targetDir, 'no_vocals.wav');
    const timeoutMs = this.requestTimeoutMs(base);

    const stems = await this.requestStems(inputWavPath, base, apiKey, configuredPath, timeoutMs);
    await this.writeStem(base, stems.vocals, vocalsPath, apiKey, timeoutMs);
    await this.writeStem(base, stems.instrumental, noVocalsPath, apiKey, timeoutMs);

    return { vocalsPath, noVocalsPath, model: stems.model };
  }

  /** Cut `length` seconds starting at `piece.start` out of the source audio. */
  private async cutPiece(
    source: string,
    piece: { start: number; length: number },
    target: string
  ): Promise<void> {
    await FFmpegHelper.execute([
      '-y',
      '-v',
      'error',
      '-i',
      source,
      '-ss',
      String(piece.start),
      '-t',
      String(piece.length),
      '-acodec',
      'pcm_s16le',
      '-ar',
      '44100',
      '-ac',
      '2',
      target,
    ]);
  }

  /** Put the separated pieces back together, in order, as one stem. */
  private async joinPieces(parts: string[], target: string): Promise<void> {
    if (parts.length === 0) throw new Error('no separated pieces to join');

    if (parts.length === 1) {
      if (path.resolve(parts[0]) !== path.resolve(target)) fs.copyFileSync(parts[0], target);
      return;
    }

    const listPath = path.join(
      path.dirname(target),
      `concat-${path.basename(target, path.extname(target))}.txt`
    );
    fs.writeFileSync(
      listPath,
      parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    );

    // Re-encoded rather than stream-copied: a concatenated WAV written straight
    // to a pipe keeps the first chunk's header, and some players honour that
    // length over the real file size.
    await FFmpegHelper.execute([
      '-y',
      '-v',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-acodec',
      'pcm_s16le',
      '-ar',
      '44100',
      '-ac',
      '2',
      target,
    ]);
  }

  /**
   * How long one request may take. A quick tunnel closes the connection at about
   * 100 seconds, so on a tunnel the timeout sits just past that: the request then
   * fails in our own words instead of as a Cloudflare 524 page, and the caller
   * splits the piece. Anywhere else (a LAN server, a local sidecar) the generous
   * default stands, because those requests are allowed to be slow.
   */
  private requestTimeoutMs(base: string): number {
    const configured = Number(process.env.AUDIO_SEPARATOR_TIMEOUT_MS);
    if (Number.isFinite(configured) && configured > 0) return configured;

    try {
      return /\.trycloudflare\.com$/i.test(new URL(base).hostname)
        ? TUNNEL_REQUEST_TIMEOUT_MS
        : LONG_REQUEST_TIMEOUT_MS;
    } catch {
      return LONG_REQUEST_TIMEOUT_MS;
    }
  }

  /**
   * Upload the WAV and locate both stems in the answer.
   *
   * Services differ in their endpoint and in their multipart field name, so the
   * usual combinations are tried in order: a 404/405 means "wrong path", a
   * 400/415/422 means "wrong field name". Everything else is reported as-is.
   */
  private async requestStems(
    inputWavPath: string,
    base: string,
    apiKey: string,
    configuredPath: string,
    timeoutMs: number
  ): Promise<{ vocals: StemLocation; instrumental: StemLocation; model?: string }> {
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const endpoints = this.separateEndpoints(base, configuredPath);
    const model = this.getModelName();

    const failures: string[] = [];
    let attempts = 0;

    for (const endpoint of endpoints) {
      for (const field of this.uploadFields()) {
        if (attempts >= 6) break;
        attempts++;

        const form = new FormData();
        // openAsBlob streams the file lazily, so a multi-hundred-MB WAV is not
        // read into memory just to build the multipart body.
        const blob = await fs.openAsBlob(inputWavPath, { type: 'audio/wav' });
        form.append(field, blob, path.basename(inputWavPath));
        if (model) form.append('model', model);

        logger.info(`Uploading audio to ${endpoint} (field: ${field})...`);

        const attemptStarted = Date.now();
        let upload: Response;
        try {
          upload = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: form,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          const text = fetchErrorText(err);
          const detail = describeFetchError(err);
          failures.push(`${endpoint} → ${detail}`);
          // An address that no longer resolves says nothing about the audio.
          if (/ENOTFOUND|EAI_AGAIN|Could not resolve|getaddrinfo/i.test(text)) throw err;
          // A lost connection is retried, or answered with less audio — never by
          // giving up on the job.
          throw classifyLostRequest(detail, Date.now() - attemptStarted, timeoutMs);
        }

        if (upload.status === 404 || upload.status === 405) {
          failures.push(`${endpoint} → ${upload.status}`);
          break; // this path does not exist: try the next one
        }

        if (!upload.ok) {
          const raw = await upload.text().catch(() => '');
          const detail = summariseServiceBody(raw);
          const failure = `${endpoint} → ${upload.status}${detail ? ` ${detail}` : ''}`;
          failures.push(failure);
          if (isTooSlowStatus(upload.status)) throw new SlowSeparationError(failure);
          if (isTunnelDownStatus(upload.status) || isTunnelDownBody(raw)) {
            throw new TransientSeparationError(failure);
          }
          // A refused key is refused on every endpoint of the service, so trying
          // the rest would only bury the real reason under five identical 401s —
          // which is exactly what the connection test used to print.
          if (upload.status === 401 || upload.status === 403) {
            throw new Error(stemKeyRejectedMessage(Boolean(apiKey), detail));
          }
          // 400/415/422 usually mean the field name was wrong; try the next one.
          if ([400, 415, 422].includes(upload.status)) continue;
          throw new Error(failure);
        }

        const contentType = upload.headers.get('content-type') || '';
        const payload: unknown = contentType.includes('json')
          ? await upload.json()
          : { output: await upload.text() };

        const vocals = pickStemLocation(payload, 'vocals');
        const instrumental = pickStemLocation(payload, 'instrumental');

        if (!vocals || !instrumental) {
          const shape = summariseServiceBody(JSON.stringify(payload));
          failures.push(
            `${endpoint} answered without both stems (${shape.slice(0, 200)})${oldServiceHint(payload)}`
          );
          throw new Error(failures[failures.length - 1]);
        }

        const reportedModel =
          payload && typeof payload === 'object' && typeof (payload as any).model === 'string'
            ? (payload as any).model
            : undefined;

        return { vocals, instrumental, model: reportedModel };
      }
    }

    throw new Error(
      `មិនអាចញែកភ្លេងតាម ${base} បានទេ។ (No usable endpoint on the stem service.) ${failures.join(' | ')}`
    );
  }

  /** Where to POST the audio: the configured path first, then the usual ones. */
  private separateEndpoints(base: string, configuredPath: string): string[] {
    const paths = configuredPath
      ? [configuredPath, ...SEPARATE_PATHS]
      : SEPARATE_PATHS;
    const seen = new Set<string>();
    return paths
      .map((p) => `${base}${p.startsWith('/') ? '' : '/'}${p}`)
      .filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
  }

  /** `AUDIO_SEPARATOR_FIELD` pins the field name; otherwise the common ones are tried. */
  private uploadFields(): string[] {
    const configured = (process.env.AUDIO_SEPARATOR_FIELD || '').trim();
    return configured ? [configured, ...UPLOAD_FIELDS] : UPLOAD_FIELDS;
  }

  /** Ask the service what it is; used by the "test connection" screen. */
  async describeService(): Promise<string | null> {
    const connection = getSeparatorConnection();
    if (!connection.url) return null;
    return describeRemoteService(connection.url, connection.apiKey);
  }

  /** Stem fields may be absolute URLs, paths on the service, or base64 audio. */
  private resolveStemUrl(base: string, location: string): string {
    if (/^https?:\/\//i.test(location)) return location;
    return `${base}${location.startsWith('/') ? '' : '/'}${location}`;
  }

  private async writeStem(
    base: string,
    stem: StemLocation,
    target: string,
    apiKey: string,
    timeoutMs: number
  ): Promise<void> {
    if (stem.base64 || stem.value.startsWith('data:')) {
      fs.writeFileSync(target, decodeBase64Audio(stem.value));
      return;
    }

    // The stems travel back over the same tunnel as the upload, so a blip here is
    // retried too: downloading a finished stem again is cheap, where failing
    // would throw away a separation that already ran.
    let lastError: unknown = new Error(`stem download never ran for ${stem.value}`);

    for (let attempt = 1; attempt <= STEM_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(this.resolveStemUrl(base, stem.value), {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok || !res.body) {
          // A 4xx is the service saying the stem is gone; repeating cannot help.
          throw Object.assign(new Error(`stem download failed (${res.status}) for ${stem.value}`), {
            retryable: res.status >= 500,
          });
        }
        await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(target));
        return;
      } catch (err) {
        lastError = err;
        const retryable = (err as { retryable?: boolean }).retryable ?? true;
        if (!retryable || attempt >= STEM_ATTEMPTS) throw err;
        await delay(STEM_RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError;
  }
}

/**
 * Ask a stem service what it is. Reports the `service`/`name`/`status` fields of
 * its root or `/health` answer, which is how the connection screen can tell
 * "Demucs API on the phone" apart from "something else is on this URL".
 *
 * `timeoutMs` is short by default in the connection test: a phone tunnel that is
 * up answers in well under a second, and one that is down should say so just as
 * quickly instead of holding the button for half a minute.
 */
/**
 * True when the stem service is reached through a Google Colab session.
 *
 * Colab can serve the API through its own proxy hostnames, and those only answer
 * while that notebook session is alive. Nothing else looks like that, so a
 * failure on one of these hostnames is worth naming: the fix is to reopen the
 * notebook, not to look for a fault in the app.
 */
function isColabHost(base: string): boolean {
  try {
    return /(^|\.)colab\.dev$/i.test(new URL(base).hostname);
  } catch {
    return false;
  }
}

/**
 * What a stem service says it is running the model on — `cuda`, `mps`, `cpu`.
 *
 * The phone's Demucs API reports it in `/health` and `/`; anything else that
 * does not answer, or answers without the field, is treated as a CPU. Failures
 * are swallowed on purpose: this is a hint about how much audio one request may
 * carry, and a service that will not say should never make a job fail.
 */
async function probeServiceDevice(base: string, apiKey: string): Promise<string> {
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  for (const path of ['/health', '/']) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) continue;
      const data = JSON.parse(await res.text()) as Record<string, unknown>;
      const device = typeof data.device === 'string' ? data.device.trim() : '';
      if (device) return device;
    } catch {
      // Try the next path; an unknown device is not an error.
    }
  }

  return '';
}

export async function describeRemoteService(
  base: string,
  apiKey: string,
  timeoutMs = 5_000
): Promise<string | null> {
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  for (const path of ['/', '/health']) {
    try {
      const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const text = (await res.text()).slice(0, 2000);
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        const label = data.service ?? data.name ?? data.app ?? data.status;
        if (typeof label === 'string' && label.trim()) {
          const version = typeof data.version === 'string' ? ` v${data.version}` : '';
          const model = typeof data.model === 'string' ? ` · ${data.model}` : '';
          // `cuda` here is what tells the owner the Colab GPU is really in use.
          const device =
            typeof data.device === 'string' && data.device.trim() ? ` · ${data.device.trim()}` : '';
          return `${label.trim()}${version}${model}${device}`;
        }
      } catch {
        if (text.trim()) return text.trim().slice(0, 120);
      }
    } catch {
      // Try the next path; the caller reports the failure.
    }
  }

  return null;
}

/**
 * True when the service that answered is clearly a translation API, not Demucs.
 *
 * Both answer `{ status: 'ok' }`, so a plain reachability probe would happily
 * accept a translation URL pasted into this card — and then a real job would 404
 * on every stem request. The service's own name is what tells them apart.
 */
export function looksLikeTranslationService(service: string | null): boolean {
  const text = (service || '').toLowerCase();
  return /\bnllb\b|translation|translate/.test(text);
}

/**
 * What the owner is told when the stem service refuses the key.
 *
 * One sentence that names the actual problem and the exact card to fix it in,
 * instead of the raw `401 {"detail":"Invalid or missing API key"}` wall that
 * every endpoint on the service answers with. `hasKey` picks between the two
 * causes: no key saved at all, or a stale one from an earlier Colab/phone run.
 */
export function stemKeyRejectedMessage(hasKey: boolean, detail?: string): string {
  const cause = hasKey
    ? 'key ដែលរក្សាទុកមិនផ្ទឹមគ្នានឹងម៉ាស៊ីនញែកភ្លេង — Colab/ទូរស័ព្ទបង្កើត key ថ្មីរាល់ពេលបើកសេវាថ្មី បើមិនបានកំណត់ DEMUCS_API_KEY អត្ថិភាព'
    : 'មិនទាន់មាន key រក្សាទុកក្នុងកាតទេ';
  return (
    `API key មិនត្រឹមត្រូវ — ${cause}។ ` +
    'សូមយក API key ដែល Colab (ឬទូរស័ព្ទ) បានបង្ហាញនៅពេលបើក service មក paste ក្នុងកាត «ញែកភ្លេង · Demucs API» រួចចុចរក្សាទុក ហើយសាកល្បងម្តងទៀត។ ' +
    `(The Demucs service rejected the API key: ${detail || '401 Invalid or missing API key'} — paste the key shown by the Colab/phone script into the stem card and save it.)`
  );
}

/**
 * Does the service accept the key the app has saved?
 *
 * The root answer (`/`) is public on the real Demucs service, so a plain
 * reachability probe reports "ok" even when the key is wrong — and the owner
 * only finds out later, deep inside a full separation. `/health` carries the
 * same identity but is gated by the key, so asking it first is what separates
 * "the tunnel is up but the key is not" from "everything is fine".
 *
 * `'unknown'` means no answer that could settle it (no `/health` route, the
 * tunnel dropped mid-probe) and must not be reported as a key problem.
 */
export async function probeStemServiceKey(
  base: string,
  apiKey: string,
  timeoutMs = 4_000
): Promise<'ok' | 'rejected' | 'unknown'> {
  for (const probePath of ['/health', '/']) {
    try {
      const res = await fetch(`${base}${probePath}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) return 'rejected';
      if (res.ok) return 'ok';
    } catch {
      // Try the next path; an unreachable probe is not an auth answer.
    }
  }
  return 'unknown';
}

export interface SeparatorTestReport {
  ok: boolean;
  service: string | null;
  latencyMs: number;
  detail: string;
  model?: string;
  stems?: { vocalsBytes: number; instrumentalBytes: number };
}

/**
 * End-to-end check used by the stem panel: send one short tone through the
 * configured service and confirm two real stems come back.
 *
 * It runs the same code the pipeline runs, so whatever this reports is exactly
 * what a real job would get.
 */
export async function testRemoteSeparation(
  inputWavPath: string,
  outputDir: string
): Promise<SeparatorTestReport> {
  const startedAt = Date.now();
  const provider = new RemoteStemSeparationProvider('demucs_api');
  const connection = getSeparatorConnection();

  if (!connection.url) {
    return {
      ok: false,
      service: null,
      latencyMs: 0,
      detail: 'មិនទាន់បានដាក់ URL ទេ។ (No service URL is configured.)',
    };
  }

  const service = await describeRemoteService(connection.url, connection.apiKey).catch(() => null);

  try {
    const result = await provider.separate(inputWavPath, outputDir);
    const vocalsBytes = fs.statSync(result.vocalsPath).size;
    const instrumentalBytes = fs.statSync(result.noVocalsPath).size;
    return {
      ok: true,
      service,
      latencyMs: Date.now() - startedAt,
      detail: `បានទទួល stems ពី ${connection.url}។ (Both stems returned.)`,
      model: provider.getModelName() || undefined,
      stems: { vocalsBytes, instrumentalBytes },
    };
  } catch (err: any) {
    return {
      ok: false,
      service,
      latencyMs: Date.now() - startedAt,
      detail: err?.message || 'unknown error',
    };
  }
}

/**
 * What the owner is told when Demucs is missing. One string, used by the upload
 * endpoint and repeated on the status screen, so the studio and the API can
 * never disagree about why a video was refused.
 */
export const DEMUCS_REQUIRED_MESSAGE =
  'គេហទំព័រនេះត្រូវការ Demucs ជាចាំបាច់ — បើគ្មានម៉ាស៊ីនញែកភ្លេងទេ ការបញ្ចូលសំឡេងខ្មែរមិនដំណើរការទេ ព្រោះសំឡេងដើមនឹងនៅជាប់ក្នុងវីដេអូ។ សូមភ្ជាប់ Demucs API ក្នុងផ្ទាំង «ញែកភ្លេង · Demucs API» ឬកំណត់ AUDIO_SEPARATOR_URL សិន។ (Demucs is required: without stem separation the Khmer dub would play under the original voices, so jobs are refused until a Demucs API is connected.)';

/**
 * The separation provider the pipeline uses.
 *
 * Where Demucs runs — a phone in Termux, a home server, the bundled sidecar —
 * comes from `AUDIO_SEPARATOR_URL` or the connection the owner saved from the
 * website. There is no fallback provider: `separate()` throws
 * `DEMUCS_REQUIRED_MESSAGE`-worthy reasons when nothing is connected, and
 * `isConfigured()` is what the upload endpoint checks before accepting a video.
 */
export function getAudioSeparationProvider(): AudioSeparationProvider {
  return new RemoteStemSeparationProvider('demucs_api');
}
