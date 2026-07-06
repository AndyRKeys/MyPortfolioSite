import path       from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp      from 'sharp';
import { pool }   from '../db/pool.js';
import { logger } from '../utils/logger.js';
import {
  UPLOADS_FULL_DIR,
  UPLOADS_THUMB_DIR,
} from '../utils/paths.js';
import {
  MEDIA_JOB_NAME,
  SHARP_FULL_SIZE,
  SHARP_THUMB_SIZE,
  SHARP_QUALITY,
} from '../utils/constants.js';

const execFileAsync = promisify(execFile);

// ── Image processing ──────────────────────────────────────────────────────────

async function processImage(filePath, basename) {
  const fullPath  = path.join(UPLOADS_FULL_DIR,  basename + '.webp');
  const thumbPath = path.join(UPLOADS_THUMB_DIR, basename + '.webp');

  await sharp(filePath)
    .resize(SHARP_FULL_SIZE, SHARP_FULL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: SHARP_QUALITY })
    .toFile(fullPath);

  await sharp(filePath)
    .resize(SHARP_THUMB_SIZE, SHARP_THUMB_SIZE, { fit: 'cover' })
    .webp({ quality: SHARP_QUALITY })
    .toFile(thumbPath);

  return {
    fullUrl:  '/uploads/full/'  + basename + '.webp',
    thumbUrl: '/uploads/thumb/' + basename + '.webp',
  };
}

// ── Video processing ──────────────────────────────────────────────────────────

async function extractVideoThumb(filePath, basename) {
  const thumbPath = path.join(UPLOADS_THUMB_DIR, basename + '.jpg');

  await execFileAsync('ffmpeg', [
    '-i', filePath,
    '-ss', '1',
    '-vframes', '1',
    '-q:v', '2',
    thumbPath,
  ]);

  return { thumbUrl: '/uploads/thumb/' + basename + '.jpg' };
}

// ── DB update ─────────────────────────────────────────────────────────────────

async function updateMediaRows(mediaUrl, fullUrl, thumbUrl, status) {
  await pool.query(
    'UPDATE posts SET full_url = $1, thumb_url = $2, media_status = $3 WHERE media_url = $4',
    [fullUrl, thumbUrl, status, mediaUrl],
  );
  await pool.query(
    'UPDATE post_media SET full_url = $1, thumb_url = $2, media_status = $3 WHERE media_url = $4',
    [fullUrl, thumbUrl, status, mediaUrl],
  );
}

// ── Job handler (exported for testing) ───────────────────────────────────────

export async function processJob(job) {
  const { filePath, mimeType } = job.data;
  const basename  = path.basename(filePath, path.extname(filePath));
  const mediaUrl  = '/uploads/original/' + path.basename(filePath);
  const startedAt = Date.now();

  logger.info({ file: path.basename(filePath), mime: mimeType },
    '[mediaProcessor] job started');

  try {
    const isImage = mimeType.startsWith('image/');
    const { fullUrl = null, thumbUrl } = isImage
      ? await processImage(filePath, basename)
      : await extractVideoThumb(filePath, basename);

    await updateMediaRows(mediaUrl, fullUrl, thumbUrl, 'ready');

    logger.info(
      { file: path.basename(filePath), durationMs: Date.now() - startedAt },
      '[mediaProcessor] job complete',
    );
  } catch (err) {
    await updateMediaRows(mediaUrl, null, null, 'error').catch(() => {});
    logger.error(
      { file: path.basename(filePath), err: err.message },
      '[mediaProcessor] job failed',
    );
    throw err;
  }
}

// ── Worker registration ───────────────────────────────────────────────────────

export async function registerMediaWorker(boss) {
  await boss.createQueue(MEDIA_JOB_NAME);
  await boss.work(MEDIA_JOB_NAME, { teamSize: 1, teamConcurrency: 1 }, processJob);
  logger.info('[mediaProcessor] worker registered');
}
