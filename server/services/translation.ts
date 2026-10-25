import { DialogueSegment, JobSettings, TargetLanguage } from '../types.js';
import { logger } from '../utils/logger.js';
import { googleTargetCode, translateLines } from './googleTranslate.js';
import { isGroqTranslationConfigured, translateLinesWithGroq } from './groqTranslate.js';

export interface TranslationResult {
  segments: DialogueSegment[];
  summary?: string;
}

export interface TranslationOutcome {
  segments: DialogueSegment[];
  /** Non-fatal problems (e.g. one line kept the original text) for the job warning. */
  warnings: string[];
}

export type TranslationProgressCallback = (
  completedLines: number,
  totalLines: number
) => void | Promise<void>;

/**
 * Translation runs on Google Translate, reached over HTTPS with no key and no
 * model download — the same service the Python `googletrans` package uses.
 *
 * Google refuses whole datacenter IP ranges with 429, so the lines it refuses are
 * handed to Groq (whose key the speech-to-text step already needs) and, failing
 * that, to a keyless public service. `translateDialogue` therefore names both
 * engines: Google first, Groq when Google is blocked.
 */
export type TranslationProviderName = 'googletrans' | 'groq';

/** What the settings panel calls the engine. */
export const GOOGLE_TRANSLATE_MODEL = 'google-translate (googletrans)';

/**
 * Khmer is U+1780-U+17FF. Thai (U+0E00-U+0E7F) and Lao (U+0E80-U+0EFF) look close
 * enough that a translator sometimes substitutes them for Khmer characters.
 *
 * All of this only applies when the target **is** Khmer: for any other target
 * Thai/Lao (or Latin, Han, Hangul…) is the correct output and must survive
 * untouched, so the wrong-script passes are skipped entirely.
 */
const THAI_OR_LAO_SCRIPT = /[\u0E00-\u0E7F\u0E80-\u0EFF]/;
const KHMER_SCRIPT = /[\u1780-\u17FF]/;

export function hasWrongScript(text: string): boolean {
  return THAI_OR_LAO_SCRIPT.test(text);
}

/** Remove every Thai/Lao codepoint and collapse whitespace. Deterministic, no LLM needed. */
export function stripWrongScript(text: string): string {
  return text.replace(/[\u0E00-\u0E7F\u0E80-\u0EFF]/g, '').replace(/\s+/g, ' ').trim();
}

/** A Khmer line is usable when it has at least one Khmer character, no Thai/Lao, and is not trivial. */
export function isValidKhmer(text: string): boolean {
  const t = text.trim();
  return t.length >= 2 && KHMER_SCRIPT.test(t) && !hasWrongScript(t);
}

/** Best-effort local repair: strip Thai/Lao and keep the result only when it is still valid Khmer. */
export function sanitizeKhmer(text: string): string | null {
  const cleaned = stripWrongScript(text);
  if (cleaned && isValidKhmer(cleaned)) return cleaned;
  return null;
}

/** Written at the end of a sentence, in Latin or Khmer script. */
const ENDS_A_SENTENCE = /[.!?…។៕]["'’”)]?$|["'’”)]$/;

/**
 * Whisper's decode windows cut speech wherever its silence detector fires, which
 * regularly lands in the middle of a sentence: "I told him we should leave" /
 * "before the storm arrives". Translated one window at a time, each fragment is
 * judged on its own — the first half loses its subject, the second half loses its
 * verb — and the dub stops sounding like the line the actor actually says.
 *
 * So adjacent fragments of the same speaker are welded back together first, under
 * three conditions that keep the weld from ever crossing a real pause:
 *
 *  - they are the same speaker (so two people talking over each other stay apart);
 *  - the silence between them is short (so a new utterance after a beat stays on
 *    its own line and the mouth on screen still matches the voice);
 *  - the earlier fragment does not already end in a full stop, so a finished
 *    sentence is never glued to the next one and the subtitle cue is kept.
 *
 * Merging only ever lengthens a line inside gaps the dub already had: the welded
 * line starts where the first fragment started and ends where the last one ended,
 * so nothing moves on the timeline and no time is invented.
 */
export function mergeDialogueFragments(
  segments: DialogueSegment[],
  maxGapSeconds = Number(process.env.TRANSLATION_MERGE_GAP || '0.7'),
  maxSeconds = Number(process.env.TRANSLATION_MERGE_MAX_SECONDS || '14'),
  maxChars = Number(process.env.TRANSLATION_MERGE_MAX_CHARS || '320')
): DialogueSegment[] {
  if (segments.length < 2) return segments;

  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const merged: DialogueSegment[] = [];

  for (const segment of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...segment });
      continue;
    }

    const gap = segment.start - previous.end;
    const sameSpeaker = !previous.speaker || !segment.speaker || previous.speaker === segment.speaker;
    const previousUnfinished = !ENDS_A_SENTENCE.test(previous.text.trim());
    const shortEnough =
      segment.end - previous.start <= maxSeconds &&
      previous.text.length + segment.text.length + 1 <= maxChars;

    if (sameSpeaker && previousUnfinished && gap >= -0.05 && gap <= maxGapSeconds && shortEnough) {
      // One space joins the words; Khmer already breaks on its own.
      merged[merged.length - 1] = {
        ...previous,
        end: Math.max(previous.end, segment.end),
        text: `${previous.text.trim()} ${segment.text.trim()}`.trim(),
        khmer: previous.khmer ? `${previous.khmer} ${segment.khmer || ''}`.trim() : segment.khmer,
      };
      continue;
    }

    merged.push({ ...segment });
  }

  return merged;
}

/**
 * ISO 639-3 tags for the MP4's caption track (`khm`, `eng`, `zho`, …).
 *
 * The muxer wants that three-letter code, and it is what makes the player's CC
 * badge name the right language instead of "und".
 */
const SUBTITLE_LANGUAGE_TAGS: Record<TargetLanguage, string> = {
  km: 'khm',
  en: 'eng',
  zh: 'zho',
  th: 'tha',
  vi: 'vie',
  ko: 'kor',
  ja: 'jpn',
  fr: 'fra',
  es: 'spa',
};

/** The caption tag for the studio's chosen target; Khmer is the default. */
export function subtitleLanguageTag(targetLanguage: string | undefined): string {
  const key = (targetLanguage || '').trim().toLowerCase() as TargetLanguage;
  return SUBTITLE_LANGUAGE_TAGS[key] || SUBTITLE_LANGUAGE_TAGS.km;
}

/**
 * Google Translate is the translator, so the stage is always ready: there is no
 * service URL or key left for the owner to connect.
 */
export function resolveTranslationProvider(): TranslationProviderName {
  return 'googletrans';
}

export class KhmerDubTranslationService {
  private modelName: string;
  private provider: TranslationProviderName;

  constructor() {
    this.provider = resolveTranslationProvider();
    // No model is loaded anywhere: the label names the service, not a checkpoint.
    this.modelName = GOOGLE_TRANSLATE_MODEL;
  }

  public getProviderName(): TranslationProviderName {
    return this.provider;
  }

  public getModelName(): string {
    return this.modelName;
  }

  /** Keyless and model-free, so nothing has to be configured first. */
  public isConfigured(): boolean {
    return process.env.GOOGLE_TRANSLATE_ENABLED !== 'false';
  }

  /**
   * How many lines are translated at the same time.
   *
   * The free endpoint answers one line per request, so a few in flight keeps the
   * stage as fast as the service allows without tripping its per-IP throttling.
   * `GOOGLE_TRANSLATE_CONCURRENCY` overrides it.
   */
  public getConcurrency(): number {
    const configured = Number(process.env.GOOGLE_TRANSLATE_CONCURRENCY);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 6;
  }

  /** There is no model rotation behind Google Translate, so never a fallback model. */
  public getFallbackModelNames(): string[] {
    return [];
  }

  /** Groq takes over the lines Google refuses, when its key is configured. */
  public getFallbackProviderName(): TranslationProviderName | null {
    return isGroqTranslationConfigured() ? 'groq' : null;
  }

  /**
   * Translates dialogue segments into the studio's chosen target language —
   * Khmer by default, or whichever language the picker names.
   *
   * Every line is its own Google Translate request (that is how the free endpoint
   * works), sent a few at a time. A line the service could not answer keeps the
   * original text and is reported in the job warning, so one throttled request
   * cannot discard a whole transcript.
   */
  public async translateDialogue(
    segments: DialogueSegment[],
    settings: JobSettings,
    onProgress?: TranslationProgressCallback
  ): Promise<TranslationOutcome> {
    if (!this.isConfigured()) {
      throw new Error(
        'Google Translate ត្រូវបានបិទនៅក្នុងការកំណត់របស់ម៉ាស៊ីនបម្រើ។ (Google Translate is disabled on this server: GOOGLE_TRANSLATE_ENABLED=false.)'
      );
    }

    if (segments.length === 0) {
      return { segments: [], warnings: [] };
    }

    // Whisper's windows are cut where its silence detector fired, which regularly
    // lands mid-sentence. Welding those fragments back together before anything
    // is translated is what lets the service read a whole thought — and keeps the
    // dub saying what the actor said instead of two halves of it.
    const ordered = mergeDialogueFragments(segments);
    const mergedCount = segments.length - ordered.length;
    if (mergedCount > 0) {
      logger.info(
        `Joined ${mergedCount} transcript fragment(s) that had been split mid-sentence: ${segments.length} line(s) -> ${ordered.length}.`
      );
    }

    const warnings: string[] = [];
    const targetIsKhmer = googleTargetCode(settings.targetLanguage) === 'km';
    const startedAt = Date.now();

    const translations = await translateLines(
      ordered.map((segment) => ({ id: segment.id, text: segment.text })),
      {
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        concurrency: this.getConcurrency(),
        onLineDone: onProgress ? (completed, total) => onProgress(completed, total) : undefined,
        // Google refused these lines (a throttled IP does that to all of them at
        // once), so the deployment's own Groq key finishes the job.
        fallback: isGroqTranslationConfigured()
          ? (refused) =>
              translateLinesWithGroq(refused, settings.sourceLanguage, settings.targetLanguage)
          : undefined,
      }
    );

    const translatedSegments = ordered.map((segment) => {
      const line = (translations.get(segment.id) || '').trim();

      // Any target but Khmer: the service's answer is the dub line as-is. Thai,
      // Lao, Latin or Han output is the point here, so nothing is stripped and
      // no Khmer-script rule applies — a line the service skipped keeps the
      // original text so the timeline still says something.
      if (!targetIsKhmer) {
        return {
          ...segment,
          khmer: line || segment.text,
          emotion: segment.emotion || 'neutral',
        };
      }

      let khmer = line;
      // Definitive output sanitization: never ship Thai/Lao.
      if (khmer && hasWrongScript(khmer)) {
        const cleaned = sanitizeKhmer(khmer);
        khmer = cleaned || '';
      }
      // A valid Khmer line must contain Khmer script. If the source itself is
      // already Khmer (e.g. sourceLanguage=km), keeping it is correct.
      const sourceIsKhmer = KHMER_SCRIPT.test(segment.text) && !hasWrongScript(segment.text);
      const usable = khmer && isValidKhmer(khmer);
      const finalKhmer = usable ? khmer : sourceIsKhmer ? segment.text : khmer || segment.text;
      // If fallback is still Thai/Lao (source was Thai), sanitize that too
      const finalSanitized =
        hasWrongScript(finalKhmer) ? sanitizeKhmer(finalKhmer) || segment.text : finalKhmer;
      return {
        ...segment,
        khmer: finalSanitized,
        emotion: segment.emotion || 'neutral',
      };
    });

    // Post-flight audit: log if any line still has wrong script (should be zero).
    // Only meaningful for a Khmer target — other targets are *supposed* to use
    // scripts this check would flag.
    const auditBad = targetIsKhmer
      ? translatedSegments.filter((s) => s.khmer && hasWrongScript(s.khmer)).length
      : 0;
    if (auditBad > 0) {
      logger.error(`Post-translation audit: ${auditBad} line(s) still have Thai/Lao script after sanitization!`);
    }

    const missing = ordered.length - translations.size;
    if (missing > 0) {
      warnings.push(
        `បន្ទាត់ចំនួន ${missing}/${ordered.length} មិនអាចបកប្រែបានទេ ដូច្នេះវារក្សាអក្សរដើម។ (${missing} of ${ordered.length} line(s) could not be translated; they keep the original text.)`
      );
    }

    logger.info(
      `Translated ${translations.size}/${ordered.length} dialogue lines into ${googleTargetCode(
        settings.targetLanguage
      )} with Google Translate, ${this.getConcurrency()} at a time, ${(
        (Date.now() - startedAt) /
        1000
      ).toFixed(1)}s${isGroqTranslationConfigured() ? ' (Groq for refused lines)' : ''}.`
    );

    return { segments: translatedSegments, warnings };
  }

  /** Convenience wrapper for callers that only need the translated lines. */
  public async translate(
    segments: DialogueSegment[],
    settings: JobSettings,
    onProgress?: TranslationProgressCallback
  ): Promise<DialogueSegment[]> {
    const outcome = await this.translateDialogue(segments, settings, onProgress);
    return outcome.segments;
  }
}

let translationInstance: KhmerDubTranslationService | null = null;

export function getTranslationService(): KhmerDubTranslationService {
  if (!translationInstance) {
    translationInstance = new KhmerDubTranslationService();
  }
  return translationInstance;
}
