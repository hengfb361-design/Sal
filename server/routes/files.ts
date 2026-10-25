import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getStorage } from '../services/storage.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/files/:category/:filename
 * Stream video/audio with HTTP 206 partial content support for seamless seek/playback
 */
router.get('/:category/:filename', async (req: Request, res: Response) => {
  try {
    const { category, filename } = req.params;
    if (!['uploads', 'processing', 'outputs'].includes(category)) {
      return res.status(400).send('Invalid category');
    }

    // Sanitize filename to prevent path traversal
    const safeFilename = path.basename(filename);
    const storage = getStorage();
    const filePath = await storage.ensureFileAvailable(category as any, safeFilename);

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(safeFilename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.vtt': 'text/vtt',
      '.srt': 'application/x-subrip',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize) {
        res.status(416).send(`Requested range not satisfiable\n${start} >= ${fileSize}`);
        return;
      }

      const chunksize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };

      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err: any) {
    logger.error('File streaming error:', err);
    res.status(500).send('Internal server error');
  }
});

export default router;
