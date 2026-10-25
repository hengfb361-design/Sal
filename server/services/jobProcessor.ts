import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { JobRecord, JobSettings, JobStatus, DialogueSegment } from '../types.js';
import { getDatabase } from './db.js';
import { getStorage } from './storage.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import {
  getAudioSeparationProvider,
  DEMUCS_REQUIRED_MESSAGE,
  SeparationResult,
} from './audioSeparation.js';
import { getTranscriptionProvider } from './transcription.js';
import { SpeakerDetector } from './speakerDetection.js';
import { getTranslationService, subtitleLanguageTag } from './translation.js';
import { getTTSProvider } from './tts.js';
import { AudioMixingService } from './audioMixing.js';
import { VideoRenderingService } from './videoRendering.js';
import { logger } from '../utils/logger.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

export const jobEvents = new EventEmitter();

/**
 * Raised at a pipeline checkpoint once the owner asked the run to stop. It is
 * caught before the generic failure handler so a cancelled job reads as
 * "cancelled by the user", not as an error the user must investigate.
 */
export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled by the user');
    this.name = 'JobCancelledError';
  }
}

export const KHMER_CANCELLED_MESSAGE =
  'បានបោះបង់ការងារដោយអ្នកប្រើ។ (Cancelled by user)';

// Khmer status messages matching pipeline steps
export const KHMER_STEP_MESSAGES: Record<JobStatus, string> = {
  queued: 'កំពុងស្ថិតក្នុងជួររង់ចាំ...',
  uploading: 'កំពុងផ្ទុកវីដេអូឡើង...',
  extracting_audio: 'កំពុងញែកសំឡេងពីវីដេអូ...',
  separating_audio: 'កំពុងបំបែកសំឡេងមនុស្សចេញដោយ Demucs...',
  transcribing: 'កំពុងបម្លែងសំឡេងទៅជាអក្សរដោយ Whisper...',
  detecting_speakers: 'កំពុងកំណត់អត្តសញ្ញាណអ្នកនិយាយ...',
  translating: 'កំពុងបកប្រែអត្ថបទទៅភាសាគោលដៅ (Google Translate)...',
  generating_voice: 'កំពុងបង្កើតសំឡេងពីអក្សរ (gTTS)...',
  mixing: 'កំពុងដាក់សំឡេងខ្មែរចូលវីដេអូ ជាមួយភ្លេងផ្ទៃខាងក្រោយ...',
  rendering: 'កំពុងដាក់សំឡេងខ្មែរចូលវីដេអូ — Render MP4 ចុងក្រោយ (H.264/AAC)...',
  quality_check: 'កំពុងត្រួតពិនិត្យវីដេអូចុងក្រោយ...',
  completed: 'វីដេអូបកប្រែ និងបញ្ចូលសំឡេងរួចរាល់ជាស្ថាពរ!',
  failed: 'មានបញ្ហាក្នុងការដំណើរការ',
};

export const ENGLISH_STEP_MESSAGES: Record<JobStatus, string> = {
  queued: 'Job queued...',
  uploading: 'Uploading video...',
  extracting_audio: 'Splitting the audio out of the video...',
  separating_audio: 'Demucs: separating human voices from the music...',
  transcribing: 'Whisper: converting speech to text...',
  detecting_speakers: 'Identifying speakers and vocal characteristics...',
  translating: 'Google Translate: translating the dialogue...',
  generating_voice: 'gTTS: generating the dubbed voice from the translated text...',
  mixing: 'Writing the Khmer voice back into the video, under the music...',
  rendering: 'Writing the Khmer voice back into the video: final H.264/AAC MP4...',
  quality_check: 'Checking the finished video...',
  completed: 'Khmer dubbed video completed successfully!',
  failed: 'Processing failed',
};

/**
 * Progress percentage mapping, spread across the four stages the studio shows:
 *
 *   Upload → Demucs → Speech-to-Text → Google Translate
 *   (then the closing steps: subtitles + gTTS voice, and the final render)
 *
 * `detecting_speakers` is no longer reported — speaker naming happens inside the
 * Whisper pass — but it stays in the map because jobs recorded before that change
 * still carry it.
 */
const STATUS_PROGRESS: Record<JobStatus, number> = {
  queued: 5,
  uploading: 10,
  extracting_audio: 16,
  separating_audio: 26,
  transcribing: 40,
  detecting_speakers: 48,
  translating: 56,
  generating_voice: 68,
  mixing: 84,
  rendering: 92,
  quality_check: 97,
  completed: 100,
  failed: 100,
};

export class JobProcessor {
  private static activeJobs = new Set<string>();

  /** Whether a pipeline is still running this job in this process. */
  public static isActive(jobId: string): boolean {
    return this.activeJobs.has(jobId);
  }

  /**
   * Update job status in database and broadcast via SSE
   */
  public static async updateJobState(
    jobId: string,
    status: JobStatus,
    customKhmerMsg?: string,
    extraUpdates: Partial<JobRecord> = {}
  ): Promise<JobRecord | null> {
    const db = getDatabase();
    // A failed or cancelled run keeps the percentage it had when it stopped.
    // Jumping to 100% would tell the user a red bar finished the whole job.
    const progress = status === 'failed' ? undefined : STATUS_PROGRESS[status] ?? 50;
    const khmerMessage = customKhmerMsg || KHMER_STEP_MESSAGES[status] || status;
    const englishMessage = ENGLISH_STEP_MESSAGES[status] || status;

    const updated = await db.updateJob(jobId, {
      status,
      ...(progress !== undefined ? { progress } : {}),
      message: englishMessage,
      khmerMessage,
      ...extraUpdates,
    });

    if (updated) {
      jobEvents.emit(`job:${jobId}`, updated);
      jobEvents.emit('job:updated', updated);
    }

    return updated;
  }

  /**
   * The language the studio picked for this video, or undefined when the speech-to-text
   * model should work it out itself. Jobs saved before the picker existed have no value,
   * which also means "detect it".
   */
  private static getSourceLanguage(settings?: JobSettings): string | undefined {
    const code = settings?.sourceLanguage;
    return code && code !== 'auto' ? code : undefined;
  }

  /**
   * Stop at the next checkpoint when the owner asked to cancel this run.
   *
   * The database flag is the source of truth: the cancel request and the
   * pipeline may run on different processes after a deploy, and a flag in
   * memory would be lost exactly when it matters.
   */
  private static async throwIfCancelled(jobId: string): Promise<void> {
    const fresh = await getDatabase().getJob(jobId);
    if (fresh?.cancelRequested) throw new JobCancelledError();
  }

  /**
   * Main asynchronous pipeline processor
   */
  public static async processJob(jobId: string): Promise<void> {
    if (this.activeJobs.has(jobId)) {
      logger.warn(`Job ${jobId} is already actively processing`);
      return;
    }

    this.activeJobs.add(jobId);
    const db = getDatabase();
    const storage = getStorage();
    const job = await db.getJob(jobId);

    if (!job) {
      logger.error(`Job ${jobId} not found in database`);
      this.activeJobs.delete(jobId);
      return;
    }

    const jobTempDir = path.join(process.cwd(), 'data', 'processing', jobId);
    if (!fs.existsSync(jobTempDir)) {
      fs.mkdirSync(jobTempDir, { recursive: true });
    }

    // Degraded-but-usable runs collect their reasons here instead of failing.
    const warnings: string[] = [];

    // How long each stage of this run really took.
    //
    // "It is slow" is only actionable once the log says *which* stage spent the
    // time: the model calls, the stem service, the ffmpeg passes and the render
    // all look identical from the progress bar. The numbers are logged as one
    // line when the job ends, so a slow job can be diagnosed from its own log
    // instead of by guessing.
    const stageTimings: { stage: string; ms: number }[] = [];
    let stageStartedAt = Date.now();
    const markStage = (stage: string) => {
      stageTimings.push({ stage, ms: Date.now() - stageStartedAt });
      stageStartedAt = Date.now();
    };
    const timingsLine = () =>
      stageTimings.map((entry) => `${entry.stage}=${(entry.ms / 1000).toFixed(1)}s`).join(' ');
    const addWarning = async (message: string) => {
      if (!warnings.includes(message)) warnings.push(message);
      await db.updateJob(jobId, { warning: warnings.join('\n\n') });
    };

    try {
      logger.info(`Starting asynchronous processing for job ${jobId}`);

      // A cancel that landed while the job sat in the queue stops it here.
      await this.throwIfCancelled(jobId);

      // STEP 1: VALIDATE VIDEO
      await this.updateJobState(jobId, 'extracting_audio');

      const videoFilePath = job.inputFile;
      if (!fs.existsSync(videoFilePath)) {
        throw new Error('Video source file not found on disk.');
      }

      // Probe video metadata
      const meta = await FFmpegHelper.probeVideo(videoFilePath);
      if (!meta.duration || meta.duration <= 0.1) {
        throw new Error('Video file has invalid duration or cannot be decoded.');
      }

      await db.updateJob(jobId, { metadata: meta });

      // STEP 2: EXTRACT AUDIO
      const rawAudioPath = path.join(jobTempDir, 'extracted_audio.wav');
      await FFmpegHelper.extractAudio(videoFilePath, rawAudioPath, 44100);

      // STEP 3: VOICE / MUSIC SEPARATION
      await this.throwIfCancelled(jobId);
      await this.updateJobState(jobId, 'separating_audio');

      // Stem separation is a requirement, not an enhancement: the only way the
      // music can stay loud under the Khmer voice is if the original dialogue is
      // gone from the background, and no other step in this pipeline removes it.
      // So a job with no Demucs service, or with one that breaks, stops here with
      // the reason instead of shipping a Khmer dub played over the source voices.
      const separationProvider = getAudioSeparationProvider();
      if (!separationProvider.isConfigured()) {
        throw new Error(DEMUCS_REQUIRED_MESSAGE);
      }

      const separationResult: SeparationResult = await separationProvider.separate(
        rawAudioPath,
        jobTempDir
      );

      markStage('demucs');

      const vocalsTrack = separationResult.vocalsPath;
      const noVocalsTrack = separationResult.noVocalsPath; // music/background track

      // STEP 3: SPEECH-TO-TEXT (Whisper)
      await this.throwIfCancelled(jobId);
      await this.updateJobState(jobId, 'transcribing');
      const transcriptionProvider = getTranscriptionProvider();

      // Naming the spoken language up front is what keeps Whisper from guessing
      // wrong on mixed-language audio; `auto` leaves the guess to the model.
      const sourceLanguage = this.getSourceLanguage(job.settings);
      if (sourceLanguage) {
        logger.info(`Job ${jobId}: speech-to-text is pinned to "${sourceLanguage}".`);
      }

      // Transcribe dialogue with timestamps
      let dialogueSegments = await transcriptionProvider.transcribe(vocalsTrack, meta.duration, {
        language: sourceLanguage,
      });

      // If no speech was detected, create fallback placeholder segment or notify
      if (dialogueSegments.length === 0) {
        logger.info(`No distinct speech detected in job ${jobId}. Checking full audio track...`);
        // Retry transcription on raw audio in case vocals filter was too aggressive
        try {
          dialogueSegments = await transcriptionProvider.transcribe(rawAudioPath, meta.duration, {
            language: sourceLanguage,
          });
        } catch {}
      }

      if (dialogueSegments.length === 0) {
        logger.warn(`No linguistic dialogue detected in ${jobId}`);
        // Create an informational segment
        dialogueSegments = [
          {
            id: 'seg_1',
            speaker: 'speaker_1',
            start: 0.5,
            end: Math.min(meta.duration, 3.5),
            text: 'Audio track ready for natural Khmer dubbing',
            khmer: 'វីដេអូរួចរាល់សម្រាប់ការបញ្ចូលសំឡេងខ្មែរ',
          },
        ];
      }

      markStage('whisper');

      // Speaker names and voice genders are settled here, inside the Whisper
      // step instead of as a stage of their own: it is in-memory bookkeeping
      // with no model call behind it, so a separate "identifying speakers" row
      // only made the pipeline look longer than it is.
      const speakerProfiles = SpeakerDetector.identifySpeakers(dialogueSegments);
      await db.updateJob(jobId, { speakers: speakerProfiles });

      // STEP 4: CONTEXT ANALYSIS & KHMER TRANSLATION
      await this.throwIfCancelled(jobId);
      await this.updateJobState(jobId, 'translating');
      const translationService = getTranslationService();

      try {
        // The translator reports progress block by block so a long transcript
        // shows movement instead of sitting on one percentage.
        const outcome = await translationService.translateDialogue(
          dialogueSegments,
          job.settings,
          async (completedLines, totalLines) => {
            // Translation is the longest stage: honour a cancel between blocks
            // so a two-minute video does not keep burning quota after the stop.
            await this.throwIfCancelled(jobId);
            const pct = 56 + Math.round((completedLines / Math.max(1, totalLines)) * 8);
            await this.updateJobState(
              jobId,
              'translating',
              `កំពុងបកប្រែជាភាសាខ្មែរ ${completedLines}/${totalLines} បន្ទាត់...`,
              { progress: Math.min(pct, 64) }
            );
          }
        );

        dialogueSegments = outcome.segments;
        for (const warning of outcome.warnings) {
          await addWarning(warning);
        }
      } catch (translationErr: any) {
        // A cancel is a deliberate stop — never paper over it with a warning.
        if (translationErr instanceof JobCancelledError) throw translationErr;
        // A translator hiccup should not discard a good transcription: keep the
        // original lines and tell the user the subtitles stay in the source language.
        logger.warn(`Translation failed for job ${jobId}, keeping original dialogue:`, translationErr);
        await addWarning(
          `ការបកប្រែជាខ្មែរមិនបានសម្រេចទេ ដូច្នេះអក្សររត់នឹងនៅជាភាសាដើម។ (Translation failed: ${translationErr?.message ?? 'unknown error'}. Subtitles keep the original language.)`
        );
      }

      await db.saveSegments(jobId, dialogueSegments);

      markStage('translate');

      // STEP 5: KHMER TTS SPEECH SYNTHESIS & TIMING MATCH
      await this.throwIfCancelled(jobId);
      await this.updateJobState(jobId, 'generating_voice');
      const ttsProvider = getTTSProvider();

      // Voice-over needs a Khmer-capable TTS engine. When none is configured we
      // still deliver the Khmer translation as subtitles instead of failing the
      // whole job, and we keep the original audio so nobody ends up muted.
      const ttsAvailable = ttsProvider.isConfigured();

      const segmentsDir = path.join(jobTempDir, 'tts_segments');
      if (!fs.existsSync(segmentsDir)) fs.mkdirSync(segmentsDir, { recursive: true });

      if (ttsAvailable) {
        // Lines are independent, so synthesize several at once instead of the
        // old one-at-a-time loop; a 60-line video used to spend a full minute here.
        // gTTS is a keyless public endpoint that throttles by IP, so it runs a few
        // lines wide rather than as many as possible.
        const defaultTtsConcurrency = 3;
        const ttsConcurrency = Math.max(
          1,
          Number(process.env.TTS_CONCURRENCY) || defaultTtsConcurrency
        );

        let voicedSoFar = 0;
        // One database write (and one SSE frame) per line is a lot of chatter for
        // a bar that moves the same way whether it is told 40 times or 400: on a
        // long video the writes themselves become part of the wait. At most one
        // update a second, plus the final line, keeps the bar smooth.
        let lastVoiceProgressAt = 0;

        await mapWithConcurrency(dialogueSegments, ttsConcurrency, async (seg, i) => {
          // Stop asking for new lines as soon as the cancel arrives; the lines
          // already synthesised are simply discarded with the temp folder.
          await this.throwIfCancelled(jobId);
          const segOutPath = path.join(segmentsDir, `segment_${i + 1}.wav`);

          // Determine voice gender
          let gender: 'male' | 'female' | 'neutral' = seg.speakerGender || 'male';
          if (job.settings.voice === 'male') gender = 'male';
          if (job.settings.voice === 'female') gender = 'female';

          const khmerText = (seg.khmer || seg.text).trim();

          try {
            const ttsResult = await ttsProvider.synthesizeSpeech(khmerText, segOutPath, {
              gender,
              emotion: seg.emotion,
              voiceStyle: job.settings.voiceStyle,
              // The voice follows the target the studio chose; Khmer by default.
              language: job.settings.targetLanguage,
            });

            seg.audioFile = ttsResult.audioPath;
            seg.audioDuration = ttsResult.duration;
          } catch (ttsErr) {
            logger.warn(`TTS synthesis failed for segment ${seg.id}:`, ttsErr);
          }

          voicedSoFar++;
          const isLastVoiceLine = voicedSoFar === dialogueSegments.length;
          const nowMs = Date.now();
          if (isLastVoiceLine || nowMs - lastVoiceProgressAt >= 1000) {
            lastVoiceProgressAt = nowMs;
            const pct = 68 + Math.round((voicedSoFar / dialogueSegments.length) * 8);
            await this.updateJobState(
              jobId,
              'generating_voice',
              `កំពុងបង្កើតសំឡេងបកប្រែ ${voicedSoFar}/${dialogueSegments.length} បន្ទាត់...`,
              { progress: Math.min(pct, 75) }
            );
          }
        });
      }

      await db.saveSegments(jobId, dialogueSegments);

      // Voice-over only counts as usable when at least one line produced audio.
      // Otherwise the mix would strip the dialogue out and ship a silent cast.
      const voicedSegments = dialogueSegments.filter((seg) => seg.audioFile);
      const canDub = ttsAvailable && voicedSegments.length > 0;

      if (!ttsAvailable) {
        logger.warn(
          `No Khmer TTS provider configured for job ${jobId}; producing a Khmer-subtitled release.`
        );
        await addWarning(
          'សំឡេងខ្មែរ (Khmer voice-over) មិនទាន់អាចបង្កើតបានទេ។ វីដេអូនឹងរក្សាសំឡេងដើម ហើយអក្សររត់ខ្មែរត្រូវបានបង្កើតរួចរាល់។ (Khmer voice-over unavailable: original audio kept, Khmer subtitles still generated.)'
        );
      } else if (!canDub) {
        logger.warn(
          `Khmer voice generation failed for every line in job ${jobId}; keeping original audio.`
        );
        await addWarning(
          'ការបង្កើតសំឡេងខ្មែរបរាជ័យសម្រាប់គ្រប់បន្ទាត់។ វីដេអូនឹងរក្សាសំឡេងដើម និងអក្សររត់ខ្មែរ។ (Khmer voice generation failed for every line; original audio kept, Khmer subtitles still generated.)'
        );
      } else if (voicedSegments.length < dialogueSegments.length) {
        logger.warn(
          `${dialogueSegments.length - voicedSegments.length} of ${dialogueSegments.length} lines could not be voiced in job ${jobId}.`
        );
        await addWarning(
          `សំឡេងខ្មែរបង្កើតបានតែ ${voicedSegments.length}/${dialogueSegments.length} បន្ទាត់។ បន្ទាត់ដែលនៅសល់រក្សាសំឡេងដើម។ (Khmer voice generated for ${voicedSegments.length}/${dialogueSegments.length} lines; the rest keep the original audio.)`
        );
      }

      markStage('tts');

      const finalMixedAudioTrack = path.join(jobTempDir, 'final_mixed_audio.wav');

      if (canDub) {
        // STEP 6: PUT THE KHMER VOICE BACK INTO THE VIDEO
        //
        // Laying each voiced line on the original timeline and mixing it under
        // the kept music read as two stages to the user, so they are one stage
        // here as well — no extra status round-trip in between.
        await this.throwIfCancelled(jobId);
        await this.updateJobState(jobId, 'mixing');
        const masterSpeechTrack = path.join(jobTempDir, 'master_khmer_speech.wav');
        await AudioMixingService.assembleDialogueTrack(
          dialogueSegments,
          meta.duration,
          masterSpeechTrack
        );

        // The assembler placed every line on its own timestamp and padded the
        // track to the video's length, and the render caps the result at that
        // same length, so the voice is in time without a measuring pass in
        // between — one fewer full-length audio decode per job.

        // Mixing walks the whole track and is the slowest step on a small host,
        // so it reports how much audio it has written instead of leaving the bar
        // parked on one number for minutes. It is mapped onto the mixing band
        // (never past it), and it never goes backwards — the mixer's fallback
        // retry restarts FFmpeg from zero.
        const mixCeiling = STATUS_PROGRESS.rendering - 1;
        let mixPct = STATUS_PROGRESS.mixing;
        const reportMixProgress = (writtenSeconds: number) => {
          if (!meta.duration) return;
          const span = mixCeiling - STATUS_PROGRESS.mixing;
          const pct = Math.min(
            mixCeiling,
            STATUS_PROGRESS.mixing + Math.round((writtenSeconds / meta.duration) * span)
          );
          if (pct <= mixPct) return;
          mixPct = pct;
          void this.updateJobState(jobId, 'mixing', undefined, { progress: pct });
        };

        await AudioMixingService.mixDubbedWithBackground(
          masterSpeechTrack,
          noVocalsTrack,
          finalMixedAudioTrack,
          job.settings,
          {
            segments: dialogueSegments,
            backgroundHasOriginalVoice: separationResult.backgroundHasOriginalVoice,
            onProgress: reportMixProgress,
          }
        );
      } else {
        // No usable Khmer voice track: carry the untouched original audio through
        // so the released video keeps its dialogue and only adds Khmer subtitles.
        await this.updateJobState(jobId, 'mixing', 'កំពុងរក្សាសំឡេងដើម និងបន្ថែមអក្សររត់ខ្មែរ...');
        fs.copyFileSync(rawAudioPath, finalMixedAudioTrack);
      }

      // The mixed track is deliberately not exported as its own WAV any more.
      // A full-length 44.1 kHz WAV is hundreds of megabytes on a long video and
      // has to be written and uploaded before the MP4 is even started, while
      // the studio ships exactly one deliverable — the dubbed MP4. Dropping it
      // removes that write and upload from every job.

      markStage('mix');

      // STEP 7: SUBTITLES
      //
      // The Khmer lines are written out before the video is rendered and are
      // carried inside the MP4 as a caption track, so whoever downloads the
      // video gets the Khmer text without having to hunt for a side-car file.
      // The SRT/VTT copies are still saved as well, so the subtitles can be
      // edited or switched on as a track in a player.
      const srtContent = VideoRenderingService.generateSrt(dialogueSegments);
      const vttContent = VideoRenderingService.generateVtt(dialogueSegments);
      const srtFilename = `subtitles-${jobId}.srt`;
      const vttFilename = `subtitles-${jobId}.vtt`;

      const savedSrtPath = await storage.saveFile('outputs', srtFilename, Buffer.from(srtContent, 'utf8'));
      const savedVttPath = await storage.saveFile('outputs', vttFilename, Buffer.from(vttContent, 'utf8'));

      // The picture stays clean. The Khmer lines are carried **inside** the MP4
      // as a caption track instead of being painted onto every frame: the video
      // keeps its own image, and the captions still play in sync because the
      // player lines them up against the audio. They stay hidden until the
      // viewer asks for them (the toggle on the result page, or the CC button of
      // any phone player).
      const captionsEnabled = job.settings.subtitle !== false;
      const srtOnDisk = path.join(jobTempDir, 'khmer-subtitles.srt');
      if (captionsEnabled && srtContent.trim()) {
        fs.writeFileSync(srtOnDisk, srtContent, 'utf8');
      } else {
        logger.info(`Subtitles are turned off for job ${jobId}; shipping a video without captions.`);
      }

      // STEP 8: RENDER FINAL MP4 VIDEO (H.264 / AAC)
      await this.throwIfCancelled(jobId);
      await this.updateJobState(jobId, 'rendering');
      const tempFinalMp4 = path.join(jobTempDir, `khmer-dubbed-${jobId}.mp4`);

      // Rendering re-encodes the video, which is the other long step: report its
      // own progress across the rendering band the same way mixing does.
      const renderCeiling = STATUS_PROGRESS.quality_check - 1;
      let renderPct = STATUS_PROGRESS.rendering;
      const reportRenderProgress = (writtenSeconds: number) => {
        if (!meta.duration) return;
        const span = renderCeiling - STATUS_PROGRESS.rendering;
        const pct = Math.min(
          renderCeiling,
          STATUS_PROGRESS.rendering + Math.round((writtenSeconds / meta.duration) * span)
        );
        if (pct <= renderPct) return;
        renderPct = pct;
        void this.updateJobState(jobId, 'rendering', undefined, { progress: pct });
      };

      // One render, one file: no text is painted on the picture, so there is no
      // second "clean" variant to keep in step with the first.
      await VideoRenderingService.renderMp4(
        videoFilePath,
        finalMixedAudioTrack,
        tempFinalMp4,
        job.settings,
        reportRenderProgress,
        undefined,
        undefined,
        captionsEnabled && fs.existsSync(srtOnDisk) ? srtOnDisk : undefined,
        // The CC badge names the language the captions are written in.
        subtitleLanguageTag(job.settings.targetLanguage)
      );

      markStage('render');

      // Final check before the file is published — still part of the same
      // "dub into video" step, not a stage the user has to wait through.
      await this.throwIfCancelled(jobId);
      await this.updateJobState(jobId, 'quality_check');
      const qualityResult = await FFmpegHelper.verifyOutputQuality(tempFinalMp4);
      if (!qualityResult.valid) {
        throw new Error(`Quality verification failed: ${qualityResult.reason}`);
      }

      // Save final video to outputs storage
      const finalMp4Filename = `khmer-dubbed-${jobId}.mp4`;
      const savedMp4Path = await storage.saveFile('outputs', finalMp4Filename, tempFinalMp4);

      // STEP 9: COMPLETED
      await this.updateJobState(jobId, 'completed', KHMER_STEP_MESSAGES.completed, {
        outputFile: savedMp4Path,
        outputSubtitlesSrt: savedSrtPath,
        outputSubtitlesVtt: savedVttPath,
        completedAt: new Date().toISOString(),
      });

      markStage('verify+save');
      logger.info(`Job ${jobId} stage timings — ${timingsLine()}`);
      logger.info(`Job ${jobId} successfully completed! Output: ${savedMp4Path}`);

      // Clean up temporary processing folder
      await storage.cleanProcessingDir(jobId);
    } catch (err: any) {
      // The owner pressed cancel: stop cleanly, keep the entry readable in the
      // history, and free the half-written temp files.
      if (err instanceof JobCancelledError) {
        logger.info(`Job ${jobId} cancelled by the user`);
        await this.updateJobState(jobId, 'failed', KHMER_CANCELLED_MESSAGE, {
          error: KHMER_CANCELLED_MESSAGE,
          cancelled: true,
          completedAt: new Date().toISOString(),
        });
        try {
          await storage.cleanProcessingDir(jobId);
        } catch {}
        return;
      }

      logger.error(`Job ${jobId} processing failed with error:`, err);
      logger.info(`Job ${jobId} stage timings before failure — ${timingsLine()}`);

      // Friendly Khmer error messages
      let friendlyKhmer = 'មិនអាចដំណើរការសំឡេងក្នុងវីដេអូនេះបានទេ។ សូមសាកល្បងវីដេអូមួយផ្សេងទៀត។';
      const errMsg = err?.message || '';

      if (
        errMsg === DEMUCS_REQUIRED_MESSAGE ||
        errMsg.includes('ញែកភ្លេងដោយ Demucs') ||
        errMsg.includes('ម៉ាស៊ីនញែកភ្លេង')
      ) {
        // Demucs has no substitute, so the reason it failed is the whole story:
        // show it instead of the generic "try another video" line.
        friendlyKhmer = errMsg;
      } else if (/\(429\)|rate limit|too many requests/i.test(errMsg)) {
        friendlyKhmer =
          'អត្រាប្រើប្រាស់ AI ពេញ (rate limit)។ សូមរង់ចាំបន្តិច រួចសាកល្បងម្តងទៀត។ (AI rate limit reached: wait a moment and try again.)';
      } else if (
        errMsg.includes('is not configured') ||
        errMsg.includes('Google Translate')
      ) {
        friendlyKhmer =
          'ការបកប្រែដោយ Google Translate មិនអាចដំណើរការបានទេ។ សូមពិនិត្យការតភ្ជាប់អ៊ីនធឺណិតរបស់ម៉ាស៊ីនបម្រើ រួចសាកល្បងម្តងទៀត។ (Google Translate could not be reached from the server — check its network and try again.)';
      } else if (/\(401\)|invalid api key/i.test(errMsg)) {
        friendlyKhmer =
          'API key មិនត្រឹមត្រូវ ឬត្រូវបានលុបចោល។ សូមពិនិត្យ GROQ_API_KEY ម្តងទៀត។ (Invalid or revoked API key.)';
      } else if (/\(402\)|\(403\)|quota|billing/i.test(errMsg)) {
        friendlyKhmer =
          'គណនី AI គ្មានសិទ្ធិ ឬអស់កូតា។ សូមពិនិត្យគណនី Groq របស់អ្នក។ (AI account permission or quota problem.)';
      } else if (errMsg.includes('API key')) {
        friendlyKhmer =
          'មិនទាន់បានកំណត់ API key សម្រាប់ AI ឬ key នោះមានបញ្ហាតភ្ជាប់ទេ។ សូមពិនិត្យ GROQ_API_KEY។';
      } else if (errMsg.includes('TTS') || errMsg.includes('synthesize')) {
        friendlyKhmer = 'មិនអាចបង្កើតសំឡេងខ្មែរបានទេ សូមពិនិត្យការកំណត់សំឡេង។';
      } else if (errMsg.includes('Quality verification')) {
        friendlyKhmer = 'ការត្រួតពិនិត្យគុណភាពវីដេអូមិនបានសម្រេច។ សូមសាកល្បងជាមួយវីដេអូផ្សេងទៀត។';
      }

      await this.updateJobState(jobId, 'failed', friendlyKhmer, {
        error: friendlyKhmer,
        technicalError: errMsg,
        completedAt: new Date().toISOString(),
      });

      // Cleanup
      try {
        await storage.cleanProcessingDir(jobId);
      } catch {}
    } finally {
      this.activeJobs.delete(jobId);
    }
  }
}
