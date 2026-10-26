/**
 * Every state a run can be in. `detecting_speakers` is no longer reported —
 * speaker naming happens inside the Whisper pass — but it stays in the union
 * because jobs recorded before that change still carry it. `syncing` reports
 * the timing pass: the short per-line time-stretch that pulls a dubbed line back
 * into the slot it was spoken in, so the studio's checklist can show sync as a
 * row of its own. It is not the old full-length measuring pass — that was
 * removed and never came back.
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
  start: number;
  end: number;
  text: string;
  /** The translated line in the job's target language (Khmer unless changed). */
  khmer?: string;
  emotion?: string;
  audioDuration?: number;
}

export interface SpeakerInfo {
  speakerId: string;
  gender: 'male' | 'female' | 'neutral';
  segments: DialogueSegment[];
}

/**
 * The language spoken in the video. Whisper guesses the language per segment when
 * this is `auto`, which is where most transcription mistakes come from — naming the
 * language is the single biggest accuracy win for mixed-language libraries.
 */
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

export interface SourceLanguageOption {
  code: SourceLanguage;
  label: string;
}

export const SOURCE_LANGUAGES: SourceLanguageOption[] = [
  { code: 'auto', label: 'រកឃើញដោយស្វ័យប្រវត្តិ (Auto detect)' },
  { code: 'en', label: 'អង់គ្លេស (English)' },
  { code: 'zh', label: 'ចិន (Mandarin)' },
  { code: 'th', label: 'ថៃ (Thai)' },
  { code: 'vi', label: 'វៀតណាម (Vietnamese)' },
  { code: 'ko', label: 'កូរ៉េ (Korean)' },
  { code: 'ja', label: 'ជប៉ុន (Japanese)' },
  { code: 'km', label: 'ខ្មែរ (Khmer)' },
  { code: 'fr', label: 'បារាំង (French)' },
  { code: 'es', label: 'អេស្ប៉ាញ (Spanish)' },
];

/**
 * The language the dialogue is translated **into** — the studio used to always
 * dub into Khmer, and now the viewer picks. There is no `auto`: a target has to
 * name one language, and Khmer stays the default so nothing changes for anyone
 * who does not open the picker.
 */
export type TargetLanguage = 'en' | 'zh' | 'th' | 'vi' | 'ko' | 'ja' | 'km' | 'fr' | 'es';

export interface TargetLanguageOption {
  code: TargetLanguage;
  label: string;
}

/** Khmer is first so it stays the default target. */
export const TARGET_LANGUAGES: TargetLanguageOption[] = [
  { code: 'km', label: 'ខ្មែរ (Khmer)' },
  { code: 'en', label: 'អង់គ្លេស (English)' },
  { code: 'zh', label: 'ចិន (Mandarin)' },
  { code: 'th', label: 'ថៃ (Thai)' },
  { code: 'vi', label: 'វៀតណាម (Vietnamese)' },
  { code: 'ko', label: 'កូរ៉េ (Korean)' },
  { code: 'ja', label: 'ជប៉ុន (Japanese)' },
  { code: 'fr', label: 'បារាំង (French)' },
  { code: 'es', label: 'អេស្ប៉ាញ (Spanish)' },
];

export interface JobSettings {
  voice: 'auto' | 'male' | 'female';
  voiceStyle: 'natural' | 'calm' | 'energetic' | 'dramatic';
  backgroundMusic: 'keep' | 'reduce' | 'remove';
  subtitle: boolean;
  outputQuality: '720p' | '1080p' | 'original';
  translationStyle: 'natural' | 'formal';
  sourceLanguage: SourceLanguage;
  /** The language the dialogue is translated into. Khmer unless changed. */
  targetLanguage: TargetLanguage;
  /**
   * Brand glossary: names, brands and technical terms the translator must leave
   * alone. One entry per line — a bare term is kept verbatim in the Khmer line,
   * `term = translation` forces one exact Khmer rendering instead.
   */
  glossary?: string;
}

export interface VideoMetadata {
  duration: number;
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
  progress: number;
  message: string;
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
  /** The owner asked the server to stop this run. */
  cancelRequested?: boolean;
  /** The run ended because it was cancelled, not because it failed. */
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
