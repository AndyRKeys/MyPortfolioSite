import { describe, it, expect, vi } from 'vitest';
import { findMissingEnv, validateEnvOrExit, REQUIRED_ENV } from '../../utils/validateEnv.js';

// A fully-populated env to start from, so each test can knock out one var.
function fullEnv() {
  return Object.fromEntries(REQUIRED_ENV.map((k) => [k, 'value']));
}

describe('findMissingEnv', () => {
  it('returns [] when every required var is present', () => {
    expect(findMissingEnv(fullEnv())).toEqual([]);
  });

  it('flags an undefined var', () => {
    const env = fullEnv();
    delete env.SITE_HOST;
    expect(findMissingEnv(env)).toEqual(['SITE_HOST']);
  });

  it('flags an empty-string var (the compose ${SITE_HOST:-} case)', () => {
    const env = fullEnv();
    env.SITE_HOST = '';
    expect(findMissingEnv(env)).toEqual(['SITE_HOST']);
  });

  it('flags a whitespace-only var', () => {
    const env = fullEnv();
    env.JWT_SECRET = '   ';
    expect(findMissingEnv(env)).toEqual(['JWT_SECRET']);
  });

  it('reports multiple missing vars', () => {
    const env = fullEnv();
    delete env.DB_PASSWORD;
    delete env.ADMIN_EMAIL;
    expect(findMissingEnv(env).sort()).toEqual(['ADMIN_EMAIL', 'DB_PASSWORD']);
  });
});

describe('validateEnvOrExit', () => {
  const fakeLogger = () => ({ fatal: vi.fn() });

  it('does not exit when all vars are present', () => {
    const logger = fakeLogger();
    const exit = vi.fn();
    validateEnvOrExit(logger, fullEnv(), exit);
    expect(exit).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it('logs each missing var and exits(1)', () => {
    const logger = fakeLogger();
    const exit = vi.fn();
    const env = fullEnv();
    delete env.SITE_HOST;
    validateEnvOrExit(logger, env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    // one per-var line + one summary line
    expect(logger.fatal).toHaveBeenCalledWith(expect.stringContaining('SITE_HOST'));
  });
});
