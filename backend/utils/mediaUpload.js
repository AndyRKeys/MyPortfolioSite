import multer from 'multer';
import { MEDIA_MAX_FILE_SIZE, MEDIA_ALLOWED_MIME, MEDIA_EXTENSION_BY_MIME } from './constants.js';
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
    // multer only calls storage after fileFilter accepts the file, so
    // file.mimetype is guaranteed to be a MEDIA_ALLOWED_MIME member here —
    // mapping from it (rather than path.extname(file.originalname)) keeps
    // the generated path free of any client-supplied input (#511, CodeQL
    // js/path-injection).
    const ext = MEDIA_EXTENSION_BY_MIME[file.mimetype] ?? '';
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
