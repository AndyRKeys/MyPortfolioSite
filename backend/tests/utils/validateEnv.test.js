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

  // #522 H4 — auth.js reads WEBAUTHN_RP_NAME at startup; it must be validated
  // like the other WEBAUTHN_* vars so a missing value fails loud, not silent.
  it('requires WEBAUTHN_RP_NAME and flags it when absent', () => {
    expect(REQUIRED_ENV).toContain('WEBAUTHN_RP_NAME');
    const env = fullEnv();
    delete env.WEBAUTHN_RP_NAME;
    expect(findMissingEnv(env)).toEqual(['WEBAUTHN_RP_NAME']);
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

  it('exits(1) when WEBAUTHN_RP_NAME is absent (#522 H4)', () => {
    const logger = fakeLogger();
    const exit = vi.fn();
    const env = fullEnv();
    delete env.WEBAUTHN_RP_NAME;
    validateEnvOrExit(logger, env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.fatal).toHaveBeenCalledWith(expect.stringContaining('WEBAUTHN_RP_NAME'));
  });
});
