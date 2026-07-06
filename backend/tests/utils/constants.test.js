import { describe, it, expect } from 'vitest';
import {
  MEDIA_MAX_FILE_SIZE,
  MEDIA_JOB_NAME,
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
});
