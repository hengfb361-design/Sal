import express, { Request, Response } from 'express';
import { FFmpegHelper, RENDER_ENCODER_ARGS } from '../utils/ffmpeg.js';
import { getStorage } from '../services/storage.js';
import { getTranscriptionProvider } from '../services/transcription.js';
import { getTranslationService } from '../services/translation.js';
import { getTTSProvider } from '../services/tts.js';
import {
  getAudioSeparationProvider,
  DEMUCS_REQUIRED_MESSAGE,
} from '../services/audioSeparation.js';
import { getSeparatorConnection } from '../services/separatorSettings.js';
import { SystemConfigStatus } from '../types.js';

const router = express.Router();

router.get('/status', async (req: Request, res: Response) => {
  const ffmpegInfo = await FFmpegHelper.checkAvailability();
  const storage = getStorage();
  const storageInfo = storage.getInfo();

  const sttInstance = getTranscriptionProvider();
  const sttConfigured = sttInstance.isConfigured();
  const sttProvider = sttInstance.name;
  const sttModel =
    sttProvider === 'assemblyai'
      ? 'AssemblyAI Conformer-2 + Diarization'
      : sttProvider === 'groq'
      ? process.env.GROQ_STT_MODEL || 'whisper-large-v3'
      : process.env.STT_MODEL || 'gemini-3.5-transcribe';

  const translationService = getTranslationService();
  // Reported from the same service the pipeline sends its requests with, so this
  // screen can never name a model the job would not actually use. Translation is
  // Google Translate only now, which loads no model and has no rotation behind it.
  const translationFallbackModels = translationService.getFallbackModelNames().slice(1);

  const ttsInstance = getTTSProvider();
  const ttsConfigured = ttsInstance.isConfigured();
  const ttsProvider = ttsInstance.name;
  const ttsModel = ttsInstance.getModelName();

  // Stem separation runs on the Demucs service and nothing else, so this reads
  // `false` until one is connected — there is no built-in substitute. Asking the
  // provider itself keeps that honest.
  const audioSeparationInstance = getAudioSeparationProvider();
  const audioSeparationProvider = audioSeparationInstance.name;
  const audioSeparationConfigured = audioSeparationInstance.isConfigured();
  const audioSeparationConnection = getSeparatorConnection();

  const maxVideoSizeMb = parseInt(process.env.MAX_VIDEO_SIZE_MB || '500', 10);
  const videoSegmentSeconds = parseInt(process.env.VIDEO_SEGMENT_SECONDS || '300', 10);

  const status: SystemConfigStatus = {
    translation: {
      configured: translationService.isConfigured(),
      provider: translationService.getProviderName(),
      model: translationService.getModelName(),
      fallbackModels: translationFallbackModels,
      // Google Translate is the only translator, so there is no service to take
      // over: this stays undefined and the panel draws no fallback line.
      fallbackProvider: translationService.getFallbackProviderName() ?? undefined,
    },
    stt: {
      configured: sttConfigured,
      provider: sttProvider,
      model: sttModel,
    },
    tts: {
      configured: ttsConfigured,
      provider: ttsProvider,
      model: ttsModel,
    },
    audioSeparation: {
      configured: audioSeparationConfigured,
      provider: audioSeparationProvider,
      ...(audioSeparationProvider === 'demucs_api'
        ? { model: audioSeparationConnection.model || 'service default' }
        : {}),
      ...(audioSeparationConfigured ? {} : { message: DEMUCS_REQUIRED_MESSAGE }),
    },
    storage: {
      configured: storage.isConfigured(),
      provider: storageInfo.provider,
      bucket: storageInfo.bucket,
      endpoint: storageInfo.endpoint,
      hasCredentials: storageInfo.hasCredentials,
      message: storageInfo.message,
    },
    ffmpeg: {
      configured: ffmpegInfo.available,
      version: ffmpegInfo.version,
    },
    // What the release MP4 is encoded with. The final render is the longest step
    // on a free host, so "why is this slow today" should be answerable here
    // rather than by reading the code that runs on the server.
    rendering: { encoder: RENDER_ENCODER_ARGS.join(' ') },
    maxVideoSizeMb,
    videoSegmentSeconds,
  };

  res.json(status);
});

export default router;
