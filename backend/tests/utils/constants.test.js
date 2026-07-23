import { describe, it, expect } from 'vitest';
import {
  MEDIA_MAX_FILE_SIZE,
  MEDIA_JOB_NAME,
  MEDIA_ALLOWED_MIME,
  MEDIA_EXTENSION_BY_MIME,
  SHARP_FULL_SIZE,
  SHARP_THUMB_SIZE,
  SHARP_QUALITY,
} from '../../utils/constants.js';

describe('media processing constants', () => {
  it('MEDIA_MAX_FILE_SIZE is 1 GB', () => {
    expect(MEDIA_MAX_FILE_SIZE).toBe(1 * 1024 * 1024 * 1024);
  });

  it('MEDIA_JOB_NAME is the expected string', () => {
    expect(MEDIA_JOB_NAME).toBe('process-media');
  });

  it('SHARP_FULL_SIZE is 2400', () => {
    expect(SHARP_FULL_SIZE).toBe(2400);
  });

  it('SHARP_THUMB_SIZE is 400', () => {
    expect(SHARP_THUMB_SIZE).toBe(400);
  });

  it('SHARP_QUALITY is 85', () => {
    expect(SHARP_QUALITY).toBe(85);
  });

  // mediaUpload.js and travel.js's importUpload both generate on-disk
  // filenames by looking up file.mimetype in MEDIA_EXTENSION_BY_MIME rather
  // than trusting the client-supplied filename's extension (#511, CodeQL
  // js/path-injection). A MIME type present in the allow-list but missing
  // here would silently produce an extensionless file for that type.
  it('every MEDIA_ALLOWED_MIME entry has a MEDIA_EXTENSION_BY_MIME entry', () => {
    for (const mime of MEDIA_ALLOWED_MIME) {
      expect(MEDIA_EXTENSION_BY_MIME[mime], `missing extension mapping for ${mime}`).toBeTruthy();
    }
  });

  it('MEDIA_EXTENSION_BY_MIME has no entries outside MEDIA_ALLOWED_MIME', () => {
    for (const mime of Object.keys(MEDIA_EXTENSION_BY_MIME)) {
      expect(MEDIA_ALLOWED_MIME.has(mime), `${mime} has an extension mapping but isn't in MEDIA_ALLOWED_MIME`).toBe(true);
    }
  });

  it('every mapped extension starts with a dot and has no path separators', () => {
    for (const ext of Object.values(MEDIA_EXTENSION_BY_MIME)) {
      expect(ext).toMatch(/^\.[a-z0-9]+$/);
    }
  });
});
