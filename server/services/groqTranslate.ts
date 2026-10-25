import { logger } from '../utils/logger.js';
import { getGroqApiKeys, groqChatJson, groqFetch } from '../utils/groq.js';
import { googleTargetCode } from './googleTranslate.js';

/**
 * Translation through Groq's chat models.
 *
 * Google Translate is the pipeline's translator, but Google (and the keyless
 * services behind it) rate-limits by IP, and a free host shares its address with
 * every other tenant on that machine: on Render every line came back 429. Groq is
 * already required for speech-to-text and is reached with the deployment's own
 * key, so it is the one translator that cannot be starved by a neighbour.
 *
 * Lines are batched — one request per ~20 lines instead of one per line — and the
 * answer is a JSON array, so a whole transcript costs a handful of calls.
 */

/** Upper bound on one request: lines per call and characters per call. */
const LINES_PER_CALL = Math.max(1, Number(process.env.GROQ_TRANSLATION_LINES_PER_CALL || '20'));
const CHARS_PER_CALL = Math.max(500, Number(process.env.GROQ_TRANSLATION_CHARS_PER_CALL || '3500'));

/** Models tried in order; the first one the account actually offers is used. */
const MODEL_PREFERENCE = (
  process.env.GROQ_TRANSLATION_MODEL
    ? [process.env.GROQ_TRANSLATION_MODEL]
    : ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant']
)
  .map((model) => model.trim())
  .filter(Boolean);

const LANGUAGE_NAMES: Record<string, string> = {
  km: 'Khmer',
  en: 'English',
  zh: 'Simplified Chinese',
  th: 'Thai',
  vi: 'Vietnamese',
  ko: 'Korean',
  ja: 'Japanese',
  fr: 'French',
  es: 'Spanish',
};

let resolvedModel: string | null | undefined;

/**
 * The model this deployment can actually call.
 *
 * The free tier's catalogue changes, and a hard-coded name that has been retired
 * would make the fallback fail exactly when it is needed, so the first request
 * asks `/models` and picks the first preference the account offers.
 */
async function resolveModel(): Promise<string | null> {
  if (resolvedModel !== undefined) return resolvedModel;

  try {
    const response = await groqFetch(
      '/models',
      { method: 'GET' },
      'translation model lookup',
      { timeoutMs: 15_000 }
    );
    const data = (await response.json()) as { data?: { id?: string }[] };
    const available = new Set(
      (data.data || []).map((model) => String(model.id || '')).filter(Boolean)
    );
    const chosen = MODEL_PREFERENCE.find((model) => available.has(model)) || null;
    if (!chosen) {
      logger.warn(
        `Groq translation: none of ${MODEL_PREFERENCE.join(', ')} is available on this account.`
      );
    }
    resolvedModel = chosen;
  } catch (err: any) {
    // Do not memoise a network hiccup: the next job may reach Groq fine.
    logger.warn(`Groq translation: could not read the model list (${err?.message ?? err}).`);
    return null;
  }

  return resolvedModel;
}

export function isGroqTranslationConfigured(): boolean {
  return getGroqApiKeys().length > 0;
}

/** Split the failed lines into requests that stay inside the token budget. */
function chunkLines(lines: { id: string; text: string }[]): { id: string; text: string }[][] {
  const chunks: { id: string; text: string }[][] = [];
  let current: { id: string; text: string }[] = [];
  let chars = 0;

  for (const line of lines) {
    const size = line.text.length;
    if (current.length > 0 && (current.length >= LINES_PER_CALL || chars + size > CHARS_PER_CALL)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(line);
    chars += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const SCHEMA = {
  name: 'translations',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['translations'],
    properties: {
      translations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'text'],
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

/**
 * Translate the lines Google refused, and answer `id -> translated line` for the
 * ones this service could translate. Lines it could not answer are simply absent,
 * so the caller can keep the source text for them.
 */
export async function translateLinesWithGroq(
  lines: { id: string; text: string }[],
  sourceLanguage: string | undefined,
  targetLanguage: string | undefined
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (lines.length === 0 || !isGroqTranslationConfigured()) return out;

  const model = await resolveModel();
  if (!model) return out;

  const targetCode = googleTargetCode(targetLanguage);
  const targetName = LANGUAGE_NAMES[targetCode] || 'Khmer';
  const sourceName =
    !sourceLanguage || sourceLanguage === 'auto'
      ? 'the source language'
      : LANGUAGE_NAMES[sourceLanguage] || sourceLanguage;

  const systemInstruction = [
    `You are a professional subtitle translator working from ${sourceName} into ${targetName}.`,
    'Translate every line so it sounds like natural spoken dialogue, keeping the speaker\'s tone and names intact.',
    `Write ONLY in ${targetName}. Never explain, transliterate or leave a line untranslated.`,
    'Answer with JSON: {"translations":[{"id":"<the id you were given>","text":"<the translation>"}]} — one entry per input line, same ids.',
  ].join(' ');

  for (const chunk of chunkLines(lines)) {
    const payload = {
      lines: chunk.map((line) => ({ id: line.id, text: line.text })),
    };

    try {
      const result = await groqChatJson({
        model,
        systemInstruction,
        userPrompt: JSON.stringify(payload),
        temperature: 0.2,
        operationName: 'translation',
        schema: SCHEMA,
        maxAttempts: 3,
      });

      const parsed = JSON.parse(result.content) as {
        translations?: { id?: string; text?: string }[];
      };
      const byId = new Map(chunk.map((line) => [line.id, line.text]));

      for (const entry of parsed.translations || []) {
        const id = String(entry?.id || '');
        const text = String(entry?.text || '').trim();
        const original = byId.get(id);
        if (!original || !text) continue;
        // An echoed source line means the model did not translate; let the next
        // service try instead of publishing English under a Khmer caption.
        if (text.toLowerCase() === original.trim().toLowerCase()) continue;
        out.set(id, text);
      }
    } catch (err: any) {
      logger.warn(
        `Groq translation failed for ${chunk.length} line(s): ${err?.message ?? err}`
      );
    }
  }

  if (out.size > 0) {
    logger.info(`Groq translated ${out.size}/${lines.length} line(s) Google refused (model ${model}).`);
  }
  return out;
}
