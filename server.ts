// Must stay first: loads .env / .env.local before other modules read process.env.
import './server/env.js';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import jobsRouter from './server/routes/jobs.js';
import filesRouter from './server/routes/files.js';
import configRouter from './server/routes/config.js';
import separatorRouter from './server/routes/separator.js';
import authRouter from './server/routes/auth.js';
import usageRouter from './server/routes/usage.js';
import billingRouter, { handleLemonSqueezyWebhook } from './server/routes/billing.js';
import proPaymentsRouter from './server/routes/proPayments.js';
import { logger } from './server/utils/logger.js';
import { FFmpegHelper } from './server/utils/ffmpeg.js';
import { getDatabase } from './server/services/db.js';
import { getBilling } from './server/services/billing.js';
import { hydrateSeparatorSettings } from './server/services/separatorSettings.js';

const app = express();
// Honour the port injected by the host, falling back to 3000 for local runs.
const PORT = Number(process.env.PORT) || 3000;

// Must be mounted before the JSON parser: the LemonSqueezy webhook signature is
// an HMAC over the exact request bytes, so the body has to stay raw.
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '2mb' }), handleLemonSqueezyWebhook);

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'AI translate video',
    timestamp: new Date().toISOString(),
  });
});

// Mount API routes
app.use('/api/jobs', jobsRouter);
app.use('/api/files', filesRouter);
app.use('/api/config', configRouter);
// Where the stem separation runs (the phone's Demucs API, a home server, the
// audio-separator sidecar) — admin only.
app.use('/api/config/separator', separatorRouter);
app.use('/api/auth', authRouter);
app.use('/api/usage', usageRouter);
app.use('/api/billing', billingRouter);
// Pro by bank transfer: the customer uploads a receipt of the QR payment and
// the owner turns it into a Pro plan from the studio.
app.use('/api/pro', proPaymentsRouter);

// Anything still unmatched under /api has to answer like an API. Without this
// the static fallback below would serve index.html with a 200 for a removed or
// mistyped endpoint, and the client would try to parse HTML as JSON instead of
// seeing a plain 404.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'រកមិនឃើញ API នេះទេ។ (Unknown API endpoint.)' });
});

async function startServer() {
  // Recover job history from object storage: hosts like Render free wipe the local
  // disk on every restart, but uploads and results live on in Cloudflare R2.
  await getDatabase().hydrateFromRemote();
  // Pro entitlements live in object storage too, so paying customers keep access
  // across the restarts that free hosts perform.
  await getBilling().hydrateFromRemote();
  // The stem service the owner pointed the app at from the website, so a job
  // started right after a restart still uses the phone. Demucs is a prerequisite
  // for a job — with no stem service connected the upload endpoint refuses the
  // video — so this hydration is what makes the pipeline ready at boot.
  await hydrateSeparatorSettings();
  // Translation needs no service to hydrate: Google Translate is reached over
  // HTTPS from the request itself, with no key and nothing to reconnect.

  // Check system dependencies on start
  const ffmpegInfo = await FFmpegHelper.checkAvailability();
  if (ffmpegInfo.available) {
    logger.info(`FFmpeg initialized: ${ffmpegInfo.version}`);
  } else {
    logger.warn('FFmpeg binary not detected in PATH. Audio/video rendering might be restricted.');
  }

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    logger.info('Vite development server middleware loaded.');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    logger.info(`Serving static production build from ${distPath}`);
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`KhmerDub AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
