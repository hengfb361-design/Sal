import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../services/db.js';
import { getStorage, resolveStoredArtifact } from '../services/storage.js';
import { JobProcessor, jobEvents, KHMER_CANCELLED_MESSAGE } from '../services/jobProcessor.js';
import {
  getAudioSeparationProvider,
  DEMUCS_REQUIRED_MESSAGE,
} from '../services/audioSeparation.js';
import {
  DEFAULT_TARGET_LANGUAGE,
  JobRecord,
  JobSettings,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
} from '../types.js';
import { logger } from '../utils/logger.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';

const router = express.Router();

const maxVideoSizeMb = parseInt(process.env.MAX_VIDEO_SIZE_MB || '500', 10);
const maxBytes = maxVideoSizeMb * 1024 * 1024;

// Temporary upload folder
const uploadDir = path.join(process.cwd(), 'data', 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storageEngine = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `upload_${Date.now()}_${randomSuffix}${ext}`);
  },
});

const upload = multer({
  storage: storageEngine,
  limits: { fileSize: maxBytes },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMime = [
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'video/x-matroska',
      'video/avi',
      'video/x-msvideo',
    ];

    if (allowedExtensions.includes(ext) || allowedMime.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`ទម្រង់វីដេអូមិនត្រូវបានគាំទ្រទេ។ សូមបញ្ចូលឯកសារ MP4, MOV ឬ WEBM។ (Unsupported format: ${ext})`));
    }
  },
});

/**
 * POST /api/jobs
 * Upload video and start asynchronous processing
 */
router.post('/', upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'សូមជ្រើសរើសវីដេអូដើម្បីបញ្ចូល។ (No video file provided)' });
    }

    // Demucs is part of the product, not an optional extra: the pipeline removes
    // the original voices with it, so without a stem service there is nothing to
    // translate that would not be heard over the source dialogue. The video is
    // refused before it is stored, so no half-made job is left in the history.
    if (!getAudioSeparationProvider().isConfigured()) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
      return res.status(400).json({ error: DEMUCS_REQUIRED_MESSAGE });
    }

    const jobId = `kd_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const storage = getStorage();
    const db = getDatabase();

    // Parse settings
    let settings: JobSettings = {
      voice: 'auto',
      voiceStyle: 'natural',
      backgroundMusic: 'keep',
      subtitle: true,
      outputQuality: 'original',
      translationStyle: 'natural',
      sourceLanguage: 'auto',
      targetLanguage: DEFAULT_TARGET_LANGUAGE,
    };

    if (req.body.settings) {
      try {
        const parsed = typeof req.body.settings === 'string' ? JSON.parse(req.body.settings) : req.body.settings;
        settings = { ...settings, ...parsed };
      } catch (e) {
        logger.warn('Failed to parse custom settings string, using defaults');
      }
    }

    // Only allow languages the studio offers; anything else falls back to auto-detect.
    if (settings.sourceLanguage && !SOURCE_LANGUAGES.includes(settings.sourceLanguage)) {
      logger.warn(`Unknown source language "${settings.sourceLanguage}" — using auto-detect.`);
      settings.sourceLanguage = 'auto';
    }

    // Same for the target: the studio's list is the only source of truth, and an
    // unknown value dubs into Khmer (what the pipeline always did).
    if (settings.targetLanguage && !TARGET_LANGUAGES.includes(settings.targetLanguage)) {
      logger.warn(`Unknown target language "${settings.targetLanguage}" — using Khmer.`);
      settings.targetLanguage = DEFAULT_TARGET_LANGUAGE;
    }

    // Save uploaded file into storage uploads directory
    const savedFilename = `input_${jobId}${path.extname(req.file.originalname)}`;
    const savedInputPath = await storage.saveFile('uploads', savedFilename, req.file.path);

    // Clean temp multer file if different
    if (req.file.path !== savedInputPath && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    // Probe initial metadata
    const meta = await FFmpegHelper.probeVideo(savedInputPath);

    const newJob: JobRecord = {
      id: jobId,
      status: 'queued',
      progress: 5,
      message: 'Job queued...',
      khmerMessage: 'កំពុងស្ថិតក្នុងជួររង់ចាំ...',
      inputFile: savedInputPath,
      originalFilename: req.file.originalname,
      inputMimeType: req.file.mimetype,
      metadata: meta,
      settings,
      createdAt: new Date().toISOString(),
    };

    await db.createJob(newJob);

    // Trigger asynchronous processing pipeline
    setImmediate(() => {
      JobProcessor.processJob(jobId).catch((err) => {
        logger.error(`Error processing job ${jobId}:`, err);
      });
    });

    return res.status(201).json({
      jobId,
      status: 'queued',
      message: 'វីដេអូបានបញ្ចូលដោយជោគជ័យ និងកំពុងចាប់ផ្តើមដំណើរការ...',
      job: newJob,
    });
  } catch (err: any) {
    logger.error('Failed to create job:', err);
    return res.status(500).json({
      error: 'មានបញ្ហាក្នុងការបញ្ចូលវីដេអូ។ សូមសាកល្បងម្តងទៀត។',
      details: err?.message,
    });
  }
});

/**
 * GET /api/jobs/:id
 * Get single job details
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'រកមិនឃើញការងារនេះទេ។ (Job not found)' });
    }
    return res.json(job);
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to get job details' });
  }
});

/**
 * GET /api/jobs/:id/events
 * Server-Sent Events for real-time progress updates
 */
router.get('/:id/events', async (req: Request, res: Response) => {
  const jobId = req.params.id;
  const db = getDatabase();
  const job = await db.getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial state
  res.write(`data: ${JSON.stringify(job)}\n\n`);

  const onUpdate = (updatedJob: JobRecord) => {
    if (updatedJob.id === jobId) {
      res.write(`data: ${JSON.stringify(updatedJob)}\n\n`);
      if (updatedJob.status === 'completed' || updatedJob.status === 'failed') {
        res.end();
      }
    }
  };

  jobEvents.on(`job:${jobId}`, onUpdate);

  req.on('close', () => {
    jobEvents.off(`job:${jobId}`, onUpdate);
  });
});

/**
 * GET /api/jobs/:id/download
 * Download final dubbed MP4 file
 *
 * `?variant=clean` serves the subtitle-free twin instead, which is what the
 * player's subtitles on/off switch plays. `?inline=1` asks for playback
 * headers so the browser shows the video rather than saving it.
 */
router.get('/:id/download', async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const job = await db.getJob(req.params.id);

    if (!job) {
      return res.status(404).send('Job not found');
    }

    const wantsClean = (req.query.variant as string || '').toLowerCase() === 'clean';

    // A restart wipes the local disk, so the file usually has to come back from
    // object storage before it can be streamed.
    const videoFile = await resolveStoredArtifact(
      wantsClean ? job.outputFileClean || job.outputFile : job.outputFile
    );
    if (job.status !== 'completed' || !videoFile) {
      return res.status(400).send('វីដេអូបកប្រែមិនទាន់រួចរាល់ ឬមានបញ្ហា។ (Output video not ready)');
    }

    const disposition =
      (req.query.inline as string || '') === '1'
        ? 'inline'
        : 'attachment';
    const safeFilename = wantsClean
      ? `khmer-dubbed-nosubtitles-${job.id}.mp4`
      : `khmer-dubbed-${job.id}.mp4`;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeFilename}"`);

    // Byte ranges let the player seek instead of waiting for the whole file,
    // and switching the subtitles off loads only what it needs.
    const size = fs.statSync(videoFile).size;
    const range = req.headers.range;
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (match) {
      const startRaw = match[1];
      const endRaw = match[2];
      let start = startRaw ? Number(startRaw) : 0;
      let end = endRaw ? Number(endRaw) : size - 1;
      if (!startRaw && endRaw) {
        // A suffix range ("bytes=-500") asks for the last N bytes.
        start = Math.max(0, size - Number(endRaw));
        end = size - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      end = Math.min(end, size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(end - start + 1));
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(videoFile, { start, end }).pipe(res);
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(size));
    if (req.method === 'HEAD') return res.end();
    const fileStream = fs.createReadStream(videoFile);
    fileStream.pipe(res);
  } catch (err: any) {
    logger.error('Download error:', err);
    res.status(500).send('Download failed');
  }
});

/**
 * GET /api/jobs/:id/subtitles
 * Download or stream subtitles (SRT or VTT)
 */
router.get('/:id/subtitles', async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    if (!job) {
      return res.status(404).send('Job not found');
    }

    const format = (req.query.format as string || 'vtt').toLowerCase();
    const storedSubFile = format === 'srt' ? job.outputSubtitlesSrt : job.outputSubtitlesVtt;
    const subFile = await resolveStoredArtifact(storedSubFile);

    if (!subFile) {
      return res.status(404).send('Subtitles not ready');
    }

    const mimeType = format === 'srt' ? 'application/x-subrip' : 'text/vtt; charset=utf-8';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="khmer-subtitles-${job.id}.${format}"`);
    fs.createReadStream(subFile).pipe(res);
  } catch (e) {
    res.status(500).send('Failed to read subtitles');
  }
});

/**
 * GET /api/jobs/:id/audio
 * Download mixed dubbed audio
 */
router.get('/:id/audio', async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    if (!job) {
      return res.status(404).send('Job not found');
    }
    const audioFile = await resolveStoredArtifact(job.outputAudioFile);
    if (!audioFile) {
      return res.status(404).send('Audio not ready');
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="khmer-audio-${job.id}.wav"`);
    fs.createReadStream(audioFile).pipe(res);
  } catch (e) {
    res.status(500).send('Failed to download audio');
  }
});

/** A job still being processed writes into its directories, so never delete it. */
function isBusy(job: JobRecord): boolean {
  return job.status !== 'completed' && job.status !== 'failed';
}

/**
 * POST /api/jobs/:id/cancel
 * Stop a run that is still processing.
 *
 * The flag lives in the database because the pipeline checks it at every step
 * boundary — a job may be running in another process after a deploy, and an
 * in-memory flag would not reach it. A job nobody is running (queued before the
 * server restarted, for example) is finished right here so the button never
 * appears to do nothing.
 */
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const job = await db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'រកមិនឃើញការងារនេះទេ។ (Job not found)' });
    }
    if (!isBusy(job)) {
      return res.json({ ok: true, status: job.status });
    }

    const flagged = await db.updateJob(job.id, { cancelRequested: true });
    jobEvents.emit(`job:${job.id}`, flagged);

    // Nothing is running this job in any process: mark it cancelled now instead
    // of leaving a forever-spinning entry in the history.
    if (!JobProcessor.isActive(job.id)) {
      const cancelled = await db.updateJob(job.id, {
        status: 'failed',
        progress: 100,
        message: 'Cancelled by user',
        khmerMessage: KHMER_CANCELLED_MESSAGE,
        error: KHMER_CANCELLED_MESSAGE,
        cancelled: true,
        completedAt: new Date().toISOString(),
      });
      await getStorage().cleanProcessingDir(job.id);
      jobEvents.emit(`job:${job.id}`, cancelled);
      return res.json({ ok: true, status: 'failed', cancelled: true });
    }

    logger.info(`Cancel requested for job ${job.id} by the studio`);
    return res.json({ ok: true, cancelling: true });
  } catch (err: any) {
    logger.error('Failed to cancel job:', err);
    return res.status(500).json({ error: 'មិនអាចបោះបង់ការងារនេះបានទេ។' });
  }
});

export default router;
