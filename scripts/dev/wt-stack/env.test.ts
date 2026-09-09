import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEnvStack, readStackEnvValue } from './env';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeEnvStack', () => {
  it('writes all secrets the API config validator requires to boot', () => {
    const p = writeEnvStack(dir);
    const env = readFileSync(p, 'utf8');
    for (const key of [
      'POSTGRES_PASSWORD', 'ENROLLMENT_KEY_PEPPER', 'MFA_RECOVERY_CODE_PEPPER',
      'TURN_SECRET', 'IS_HOSTED', 'CADDY_SITE_ADDRESS', 'BREEZE_PORTAL_IMAGE_REF',
    ]) {
      expect(env).toContain(`${key}=`);
    }
    expect(env).toContain('CADDY_SITE_ADDRESS=:80');
    expect(env).toContain('IS_HOSTED=false');
  });

  // #5266 — the seeded system Partner Admin role stores force_mfa=true, so a
  // stack that lets the API's own default decide bounces the seeded
  // admin@breeze.local login to /auth/mfa/setup and every Playwright spec dies
  // in globalSetup. The stack pins the relief valve OFF so the dev stack does
  // not follow the shipping default (which flips back ON once #5306 lands).
  it('pins the partner-admin forced-MFA relief valve off for the dev stack', () => {
    const env = readFileSync(writeEnvStack(dir), 'utf8');
    expect(env).toContain('MFA_FORCE_FOR_PARTNER_ADMIN=false');
  });
});

// #5266 — `wt-stack test` reads REDIS_PASSWORD this way to hand it to
// Playwright's globalSetup, which needs it to clear the login rate limiter.
describe('readStackEnvValue', () => {
  it('resolves the way compose does: .env.stack overrides .env', () => {
    writeFileSync(path.join(dir, '.env'), 'REDIS_PASSWORD=from-root\nOTHER=x\n');
    writeFileSync(path.join(dir, '.env.stack'), 'REDIS_PASSWORD=from-stack\n');
    expect(readStackEnvValue(dir, 'REDIS_PASSWORD')).toBe('from-stack');
    expect(readStackEnvValue(dir, 'OTHER')).toBe('x');
  });

  it('falls back to .env when the key is only there, and strips quotes', () => {
    writeFileSync(path.join(dir, '.env'), 'REDIS_PASSWORD="quoted pw"\n');
    writeFileSync(path.join(dir, '.env.stack'), 'UNRELATED=1\n');
    expect(readStackEnvValue(dir, 'REDIS_PASSWORD')).toBe('quoted pw');
  });

  it('returns undefined for a missing key, a commented-out key, and a missing file', () => {
    writeFileSync(path.join(dir, '.env'), '# REDIS_PASSWORD=commented\n');
    expect(readStackEnvValue(dir, 'REDIS_PASSWORD')).toBeUndefined();
    expect(readStackEnvValue(dir, 'NOPE')).toBeUndefined();
  });
});
