import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the uploads directory.
// UPLOADS_DIR env var overrides the default so Docker can point to /app/uploads
// without the relative path varying depending on which route file resolves it.
export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
