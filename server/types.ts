/**
 * Every state a run can be in. `detecting_speakers` is no longer reported —
 * speaker naming happens inside the Whisper pass — but it stays in the union
 * because jobs recorded before that change still carry it. `syncing` reports
 * the timing pass: the short per-line time-stretch that pulls a dubbed line back
 * into the slot it was spoken in (`AudioMixingService.fitDialogueToSlots`), so
 * the studio can show sync as a row of its own. It is not the old full-length
 * measuring pass — that was removed and never came back.
 */
export type JobStatus =
  | 'queued'
  | 'uploading'
  | 'extracting_audio'
  | 'separating_audio'
  | 'transcribing'
  | 'detecting_speakers'
  | 'translating'
  | 'generating_voice'
  | 'syncing'
  | 'mixing'
  | 'rendering'
  | 'quality_check'
  | 'completed'
  | 'failed';

export interface DialogueSegment {
  id: string;
  speaker: string;
  speakerGender?: 'male' | 'female' | 'neutral';
  start: number; // in seconds
  end: number;   // in seconds
  text: string;  // original text
  /**
   * The translated line in the job's target language. Named `khmer` for history:
   * it was Khmer-only before the target picker, and the field keeps that name so
   * stored jobs and the rest of the pipeline stay compatible.
   */
  khmer?: string;
  emotion?: string; // e.g. neutral, energetic, calm, dramatic
  audioDuration?: number; // generated audio duration in seconds
  audioFile?: string; // path to synthesized segment audio
}

export interface SpeakerInfo {
  speakerId: string;
  gender: 'male' | 'female' | 'neutral';
  segments: DialogueSegment[];
}

/** Languages the transcription step can be told to expect. `auto` lets the model guess. */
export type SourceLanguage =
  | 'auto'
  | 'en'
  | 'zh'
  | 'th'
  | 'vi'
  | 'ko'
  | 'ja'
  | 'km'
  | 'fr'
  | 'es';

/** Same codes the studio offers, used to reject anything else from a request. */
export const SOURCE_LANGUAGES: SourceLanguage[] = [
  'auto',
  'en',
  'zh',
  'th',
  'vi',
  'ko',
  'ja',
  'km',
  'fr',
  'es',
];

/**
 * The language the dialogue is translated into. The studio used to dub into
 * Khmer only; the viewer now chooses. There is no `auto` — a target must name
 * one language — and Khmer is the default so old jobs keep behaving the same.
 */
export type TargetLanguage = 'en' | 'zh' | 'th' | 'vi' | 'ko' | 'ja' | 'km' | 'fr' | 'es';

/** Any code the studio may send as a target; anything else is rejected. */
export const TARGET_LANGUAGES: TargetLanguage[] = [
  'km',
  'en',
  'zh',
  'th',
  'vi',
  'ko',
  'ja',
  'fr',
  'es',
];

/** The default target, and the value old jobs without the field fall back to. */
export const DEFAULT_TARGET_LANGUAGE: TargetLanguage = 'km';

/**
 * `sourceLanguage` is optional because jobs stored before the studio offered the
 * picker do not have it — those fall back to `auto`.
 */
export interface JobSettings {
  voice: 'auto' | 'male' | 'female';
  voiceStyle: 'natural' | 'calm' | 'energetic' | 'dramatic';
  backgroundMusic: 'keep' | 'reduce' | 'remove';
  subtitle: boolean;
  outputQuality: '720p' | '1080p' | 'original';
  translationStyle: 'natural' | 'formal';
  sourceLanguage?: SourceLanguage;
  /**
   * Optional because jobs stored before the picker existed do not have it —
   * those fall back to Khmer, which is what the pipeline always did.
   */
  targetLanguage?: TargetLanguage;
  /**
   * Brand glossary: names, brands and technical terms the translator must leave
   * alone. One entry per line — a bare term is kept verbatim in the Khmer line,
   * `term = translation` forces one exact Khmer rendering instead.
   */
  glossary?: string;
}

export interface VideoMetadata {
  duration: number; // in seconds
  width?: number;
  height?: number;
  format?: string;
  sizeBytes: number;
  videoCodec?: string;
  audioCodec?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  progress: number; // 0 to 100
  message: string; // User-facing status message (Khmer or English)
  khmerMessage?: string;
  inputFile: string;
  originalFilename: string;
  inputMimeType: string;
  metadata?: VideoMetadata;
  settings: JobSettings;
  segments?: DialogueSegment[];
  speakers?: SpeakerInfo[];
  outputFile?: string;
  /** Legacy subtitle-free twin from the old burn-in flow; new jobs only set `outputFile`. */
  outputFileClean?: string;
  outputSubtitlesSrt?: string;
  outputSubtitlesVtt?: string;
  /** Legacy mixed-audio WAV from before the single-MP4 release; new jobs leave it unset. */
  outputAudioFile?: string;
  warning?: string;
  error?: string;
  technicalError?: string;
  /** Set by the owner to stop a run that is still processing. */
  cancelRequested?: boolean;
  /** True when the run ended because it was cancelled, not because it failed. */
  cancelled?: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface SystemConfigStatus {
  /** `fallbackProvider` is the service that takes over when `provider` fails, and
   * `fallbackModels` is the model rotation inside it. */
  translation: {
    configured: boolean;
    provider: string;
    model: string;
    fallbackModels?: string[];
    fallbackProvider?: string;
  };
  stt: { configured: boolean; provider: string; model: string };
  tts: { configured: boolean; provider: string; model: string };
  audioSeparation: { configured: boolean; provider: string; model?: string; message?: string };
  storage: {
    configured: boolean;
    provider: string;
    bucket?: string;
    endpoint?: string;
    hasCredentials?: boolean;
    message?: string;
  };
  ffmpeg: { configured: boolean; version?: string };
  /** x264 settings the release MP4 is encoded with (see `RENDER_ENCODER_ARGS`). */
  rendering?: { encoder: string };
  maxVideoSizeMb: number;
  videoSegmentSeconds: number;
}
