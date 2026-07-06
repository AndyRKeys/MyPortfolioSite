import path from 'path';
import fs   from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the uploads directory.
// UPLOADS_DIR env var overrides the default so Docker can point to /app/uploads
// without the relative path varying depending on which route file resolves it.
export const UPLOADS_DIR          = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
export const UPLOADS_ORIGINAL_DIR = path.join(UPLOADS_DIR, 'original');
export const UPLOADS_FULL_DIR     = path.join(UPLOADS_DIR, 'full');
export const UPLOADS_THUMB_DIR    = path.join(UPLOADS_DIR, 'thumb');

// Creates uploads subdirs if they do not exist. Called at server startup
// so the worker never encounters a missing destination directory.
export function ensureUploadDirs() {
  [UPLOADS_ORIGINAL_DIR, UPLOADS_FULL_DIR, UPLOADS_THUMB_DIR].forEach(dir => {
    fs.mkdirSync(dir, { recursive: true });
  });
}
