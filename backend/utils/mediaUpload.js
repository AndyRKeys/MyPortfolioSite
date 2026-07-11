import multer from 'multer';
import path from 'path';
import { MEDIA_MAX_FILE_SIZE, MEDIA_ALLOWED_MIME } from './constants.js';
import { UPLOADS_ORIGINAL_DIR } from './paths.js';

// ── Shared media upload config
// Single source of truth for the media multer setup — used by the single-file
// upload route (POST /upload) and the travel bulk upload route
// (POST /travel/:id/photos/bulk). Writes originals to UPLOADS_ORIGINAL_DIR
// with a timestamp-random filename and rejects MIME types outside
// MEDIA_ALLOWED_MIME.

const mediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_ORIGINAL_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

export const mediaUpload = multer({
  storage:    mediaStorage,
  limits:     { fileSize: MEDIA_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    MEDIA_ALLOWED_MIME.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('File type not allowed'));
  },
});
