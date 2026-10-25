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
 * Hosts are rotated. They are the same service, but a single host that starts
 * answering 429/5xx (Google throttles by IP, and a free host shares its IP with
 * everyone else on that machine) is skipped for the next attempt instead of
 * failing the line.
 *
 * A whole datacenter IP can be refused by Google for every request, which is
 * what happened to this app on Render: every line came back 429. So one keyless
 * third-party service sits behind Google — MyMemory, which is a different
 * company and therefore a different blocklist — and answers only for the lines
 * Google refused. `GOOGLE_TRANSLATE_FALLBACK=off` removes it, and
 * `GOOGLE_TRANSLATE_HOSTS` overrides the host list (comma separated).
 */
const TRANSLATE_HOSTS = (process.env.GOOGLE_TRANSLATE_HOSTS || 'translate.googleapis.com,translate.google.com,clients5.google.com')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

/** Hosts that answer the compact `translate_a/t` shape instead of `single`. */
const COMPACT_HOSTS = new Set(['clients5.google.com']);

/** Keyless fallback, used only for lines Google refused. */
const FALLBACK_HOST = 'api.mymemory.translated.net';
const FALLBACK_ENABLED = (process.env.GOOGLE_TRANSLATE_FALLBACK || 'on').toLowerCase() !== 'off';

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
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'GoogleTranslateError';
  }
}

/**
 * Set when Google refuses this host with 429/403 on every attempt, which is how
 * a blocked datacenter IP answers. While it is in the future the remaining
 * lines skip Google altogether instead of spending four backoff rounds each.
 */
let googleBlockedUntil = 0;
const BLOCK_WINDOW_MS = Math.max(0, Number(process.env.GOOGLE_TRANSLATE_BLOCK_MS || '600000'));
/** Refusals in a row that mean "this server is blocked", not "this line". */
const REFUSAL_THRESHOLD = Math.max(1, Number(process.env.GOOGLE_TRANSLATE_REFUSALS || '3'));
let consecutiveRefusals = 0;

function googleIsBlocked(): boolean {
  return Date.now() < googleBlockedUntil;
}

/**
 * Counts refusals so a blocked IP is recognised within the first few requests
 * instead of after every line has spent its retries.
 */
function noteGoogleAnswer(status: number | undefined) {
  // 429 is throttling, 403 is a refusal; anything else may be this one line.
  if (status !== 429 && status !== 403) {
    if (status !== undefined) consecutiveRefusals = 0;
    return;
  }
  consecutiveRefusals++;
  if (consecutiveRefusals >= REFUSAL_THRESHOLD) rememberBlock(status);
}

function rememberBlock(status: number | undefined) {
  if (googleIsBlocked()) return;
  googleBlockedUntil = Date.now() + BLOCK_WINDOW_MS;
  logger.warn(
    `Google Translate is refusing this server (status ${status}); using the fallback translator for the next ${Math.round(
      BLOCK_WINDOW_MS / 1000
    )}s.`
  );
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
  const compact = COMPACT_HOSTS.has(host);
  const params = compact
    ? new URLSearchParams({ client: 'dict-chrome-ex', sl: source, tl: target, q: text })
    : new URLSearchParams({
        client: 'gtx',
        ie: 'UTF-8',
        oe: 'UTF-8',
        sl: source,
        tl: target,
        dt: 't',
        q: text,
      });
  const path = compact ? '/translate_a/t' : '/translate_a/single';

  let response: Response;
  try {
    response = await fetch(`https://${host}${path}?${params.toString()}`, {
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
      isRetryableStatus(response.status),
      response.status
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new GoogleTranslateError('Google Translate answered something that is not JSON.', true);
  }

  // `translate_a/single` answers [[[text, original], ...], ...]; the compact
  // endpoint answers [text, detectedLanguage]. Both are handled here so a caller
  // only ever sees the translated line.
  let translated: string;
  if (compact) {
    const first = Array.isArray(data) ? data[0] : data;
    translated = Array.isArray(first) ? String(first[0] ?? '') : String(first ?? '');
  } else {
    const pieces = Array.isArray(data?.[0]) ? data[0] : [];
    translated = pieces
      .map((piece: any) => (Array.isArray(piece) ? String(piece[0] ?? '') : ''))
      .join('');
  }
  translated = translated.trim();

  if (!translated) {
    throw new GoogleTranslateError('Google Translate returned an empty translation.', true);
  }
  return translated;
}

/**
 * The keyless fallback: MyMemory's public translation memory.
 *
 * It takes a language pair (`autodetect` when the source is unknown) and answers
 * JSON. It is a completely separate service from Google, so an IP that Google
 * refuses can still be translated here — which is the point of having it.
 */
async function requestMyMemory(
  text: string,
  source: string,
  target: string
): Promise<string> {
  const params = new URLSearchParams({
    q: text,
    langpair: `${source === 'auto' ? 'autodetect' : source}|${target}`,
  });

  let response: Response;
  try {
    response = await fetch(`https://${FALLBACK_HOST}/get?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error';
    throw new GoogleTranslateError(`Fallback translator request failed (${reason}).`, true);
  }

  if (!response.ok) {
    await response.text().catch(() => '');
    throw new GoogleTranslateError(
      `Fallback translator answered ${response.status}.`,
      isRetryableStatus(response.status)
    );
  }

  const data = (await response.json().catch(() => null)) as any;
  const status = Number(data?.responseStatus ?? 0);
  const translated = String(data?.responseData?.translatedText ?? '').trim();

  // MyMemory reports its own quota ("MYMEMORY WARNING: YOU USED ALL AVAILABLE
  // FREE TRANSLATIONS...") in `responseData` with a non-200 status. Treat that
  // as a failure so the caller keeps the source line instead of echoing the note
  // into the dub.
  if (status !== 200 || !translated || /MYMEMORY WARNING/i.test(translated)) {
    throw new GoogleTranslateError(
      `Fallback translator refused the line (status ${status || 'unknown'}).`,
      false
    );
  }

  // A same-language pair comes back unchanged; the caller would treat that as a
  // real translation, so say it failed instead.
  if (translated.toLowerCase() === text.trim().toLowerCase()) {
    throw new GoogleTranslateError('Fallback translator returned the source text.', false);
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
  // Already known to refuse this server: do not spend the retries again.
  const skipGoogle = googleIsBlocked() && FALLBACK_ENABLED;
  for (let attempt = 1; !skipGoogle && attempt <= MAX_ATTEMPTS; attempt++) {
    const host = TRANSLATE_HOSTS[(attempt - 1) % TRANSLATE_HOSTS.length];
    try {
      const translated = await requestTranslation(host, clean, source, target);
      consecutiveRefusals = 0;
      return translated;
    } catch (err) {
      lastError = err;
      const retryable = err instanceof GoogleTranslateError ? err.retryable : true;
      noteGoogleAnswer(err instanceof GoogleTranslateError ? err.status : undefined);
      // The breaker just tripped: stop spending attempts on a host that will
      // answer the same for every line.
      if (googleIsBlocked()) break;
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

  if (!skipGoogle) {
    rememberBlock(lastError instanceof GoogleTranslateError ? lastError.status : undefined);
  }
  // Google refused every host for this line — ask the separate service rather
  // than leaving the line in the source language.
  if (FALLBACK_ENABLED) {
    try {
      const translated = await requestMyMemory(clean, source, target);
      logger.warn(
        `Google Translate refused a line; translated it with the ${FALLBACK_HOST} fallback instead.`
      );
      return translated;
    } catch (fallbackError: any) {
      logger.warn(
        `Translation fallback failed too: ${fallbackError?.message ?? fallbackError}`
      );
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
