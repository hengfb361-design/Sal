import { logger } from '../utils/logger.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

/**
 * Google Translate, the free public endpoint — the same one the Python
 * `googletrans` package talks to.
 *
 * It needs no API key and loads no model: the sentence goes out over HTTPS and
 * the translation comes back in the response, so a job can translate without a
 * Colab session, a downloaded NLLB checkpoint, or any credential at the owner's
 * side. That is the whole point of this stage in the pipeline.
 *
 * Two hosts are rotated. They are the same service, but a single host that
 * starts answering 429/5xx (Google throttles by IP, and a free host shares its
 * IP with everyone else on that machine) is skipped for the next attempt instead
 * of failing the line.
 */
const TRANSLATE_HOSTS = ['translate.googleapis.com', 'translate.google.com'];

/** One line may take this long before the attempt is treated as failed. */
const REQUEST_TIMEOUT_MS = Number(process.env.GOOGLE_TRANSLATE_TIMEOUT_MS || '15000');

/** Attempts per line, across the hosts above. */
const MAX_ATTEMPTS = Math.max(1, Number(process.env.GOOGLE_TRANSLATE_MAX_ATTEMPTS || '4'));

/** Base backoff between attempts; multiplied by the attempt number. */
const RETRY_BACKOFF_MS = Math.max(0, Number(process.env.GOOGLE_TRANSLATE_RETRY_BACKOFF_MS || '700'));

/** Now many lines are in flight at once. */
const DEFAULT_CONCURRENCY = 6;

/**
 * The studio's language codes and the codes Google Translate expects. Only
 * Mandarin differs (`zh` is `zh-CN`); the rest are the same two-letter codes.
 */
const GOOGLE_CODES: Record<string, string> = {
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

/** The target code Google Translate speaks; unknown values fall back to Khmer. */
export function googleTargetCode(targetLanguage: string | undefined): string {
  const key = (targetLanguage || '').trim().toLowerCase();
  return GOOGLE_CODES[key] || 'km';
}

/** `auto` lets Google detect the spoken language, which is the studio's default. */
export function googleSourceCode(sourceLanguage: string | undefined): string {
  const key = (sourceLanguage || '').trim().toLowerCase();
  if (!key || key === 'auto') return 'auto';
  return GOOGLE_CODES[key] || 'auto';
}

/** A failure classified so the caller knows whether asking again is worth it. */
class GoogleTranslateError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'GoogleTranslateError';
  }
}

function isRetryableStatus(status: number): boolean {
  // 429 is Google's throttling; 5xx is its edge. A 4xx is a malformed request.
  return status === 408 || status === 429 || status >= 500;
}

/**
 * One request, no retry.
 *
 * `dt=t` asks for the plain translated text. The answer is nested arrays whose
 * first element is a list of `[translated, original]` pieces — a long sentence is
 * split there, so the pieces are joined back into one line.
 */
async function requestTranslation(
  host: string,
  text: string,
  source: string,
  target: string
): Promise<string> {
  const params = new URLSearchParams({
    client: 'gtx',
    ie: 'UTF-8',
    oe: 'UTF-8',
    sl: source,
    tl: target,
    dt: 't',
    q: text,
  });

  let response: Response;
  try {
    response = await fetch(`https://${host}/translate_a/single?${params.toString()}`, {
      headers: {
        // Google answers a bare fetch() agent with a consent page; a normal
        // browser string keeps `translate_a/single` returning JSON.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error';
    throw new GoogleTranslateError(`Google Translate request failed (${reason}).`, true);
  }

  if (!response.ok) {
    // Drop the body: a blocked request gets an HTML page, not JSON.
    await response.text().catch(() => '');
    throw new GoogleTranslateError(
      `Google Translate answered ${response.status}.`,
      isRetryableStatus(response.status)
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new GoogleTranslateError('Google Translate answered something that is not JSON.', true);
  }

  const pieces = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = pieces
    .map((piece: any) => (Array.isArray(piece) ? String(piece[0] ?? '') : ''))
    .join('')
    .trim();

  if (!translated) {
    throw new GoogleTranslateError('Google Translate returned an empty translation.', true);
  }
  return translated;
}

/**
 * Translate one line, rotating hosts and backing off between attempts.
 *
 * The last failure is thrown, so the caller can keep the source line and say so
 * in the job warning.
 */
export async function translateLine(
  text: string,
  sourceLanguage: string | undefined,
  targetLanguage: string | undefined
): Promise<string> {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  const source = googleSourceCode(sourceLanguage);
  const target = googleTargetCode(targetLanguage);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const host = TRANSLATE_HOSTS[(attempt - 1) % TRANSLATE_HOSTS.length];
    try {
      return await requestTranslation(host, clean, source, target);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof GoogleTranslateError ? err.retryable : true;
      if (!retryable || attempt >= MAX_ATTEMPTS) break;
      const wait = RETRY_BACKOFF_MS * attempt;
      logger.warn(
        `Google Translate failed on ${host} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${wait}ms: ${
          err instanceof Error ? err.message : err
        }`
      );
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new GoogleTranslateError('Google Translate failed.', true);
}

export interface TranslateLinesOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
  concurrency?: number;
  /** Called once per finished line, whatever the outcome. */
  onLineDone?: (completed: number, total: number) => void | Promise<void>;
}

/**
 * Translate a list of lines and answer `id -> translated line`.
 *
 * One HTTP request per line is how the free endpoint works (it translates a
 * single `q`), so lines are asked several at a time instead of one after the
 * other. A line that could not be translated is left out of the map — never
 * filled with an error string — and the caller keeps the source text for it.
 */
export async function translateLines(
  lines: { id: string; text: string }[],
  options: TranslateLinesOptions = {}
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (lines.length === 0) return out;

  const configured = Number(options.concurrency || process.env.GOOGLE_TRANSLATE_CONCURRENCY);
  const concurrency = Math.max(
    1,
    Math.min(
      Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DEFAULT_CONCURRENCY,
      lines.length
    )
  );

  let completed = 0;
  await mapWithConcurrency(lines, concurrency, async (line) => {
    try {
      const translated = await translateLine(line.text, options.sourceLanguage, options.targetLanguage);
      if (translated) out.set(line.id, translated);
    } catch (err: any) {
      logger.warn(`Google Translate could not translate line ${line.id}: ${err?.message ?? err}`);
    }
    completed++;
    if (options.onLineDone) await options.onLineDone(completed, lines.length);
  });

  return out;
}

/** Where `client=gtx` lives, so a test panel can name the service it probes. */
export const GOOGLE_TRANSLATE_HOST = TRANSLATE_HOSTS[0];
