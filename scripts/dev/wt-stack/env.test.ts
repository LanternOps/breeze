import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEnvStack, readStackEnvValue, setStackEnvValues, pinWebAuthnForStack } from './env';

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

  // #6447 — every Playwright context in a run is built from the ONE
  // storageState globalSetup mints, so they all share a single refresh-token
  // FAMILY, and `apps/web` spends one `POST /auth/refresh` per full-page
  // navigation. The family budget is 60/60s, which parallel workers exhaust in
  // seconds; the API then 429s and the app masks itself with "Too many
  // requests — reconnecting". E2E_MODE is the API's own switch for exactly
  // this, so the dev stack must pin it on.
  it('disables the rate limiters that a parallel Playwright run trips', () => {
    const env = readFileSync(writeEnvStack(dir), 'utf8');
    expect(env).toContain('E2E_MODE=true');
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

  it('strips a trailing inline comment from an unquoted value but not from a quoted one', () => {
    writeFileSync(
      path.join(dir, '.env'),
      'REDIS_PASSWORD=plain-pw   # the redis password\nHASHY="pw # not a comment"\nNOSPACE=a#b\n'
    );
    expect(readStackEnvValue(dir, 'REDIS_PASSWORD')).toBe('plain-pw');
    expect(readStackEnvValue(dir, 'HASHY')).toBe('pw # not a comment');
    // No preceding whitespace — compose treats this as part of the value.
    expect(readStackEnvValue(dir, 'NOSPACE')).toBe('a#b');
  });

  it('returns undefined for a missing key, a commented-out key, and a missing file', () => {
    writeFileSync(path.join(dir, '.env'), '# REDIS_PASSWORD=commented\n');
    expect(readStackEnvValue(dir, 'REDIS_PASSWORD')).toBeUndefined();
    expect(readStackEnvValue(dir, 'NOPE')).toBeUndefined();
  });
});

// #6443 — the WebAuthn origin is the caddy port compose picks at `up`, so it
// is upserted after the fact and must survive the next writeEnvStack.
describe('setStackEnvValues', () => {
  it('adds a key once and replaces it in place on a later call', () => {
    writeEnvStack(dir);
    setStackEnvValues(dir, { WEBAUTHN_ORIGIN: 'http://localhost:55001' });
    setStackEnvValues(dir, { WEBAUTHN_ORIGIN: 'http://localhost:55002' });
    const env = readFileSync(path.join(dir, '.env.stack'), 'utf8');
    expect(env.match(/^WEBAUTHN_ORIGIN=/gm)).toHaveLength(1);
    expect(readStackEnvValue(dir, 'WEBAUTHN_ORIGIN')).toBe('http://localhost:55002');
    expect(env).toContain('IS_HOSTED=false');
  });

  it('is kept when writeEnvStack rewrites the file on the next up', () => {
    writeEnvStack(dir);
    setStackEnvValues(dir, { WEBAUTHN_ORIGIN: 'http://localhost:55001' });
    writeEnvStack(dir);
    expect(readStackEnvValue(dir, 'WEBAUTHN_ORIGIN')).toBe('http://localhost:55001');
    expect(readFileSync(path.join(dir, '.env.stack'), 'utf8').match(/^WEBAUTHN_ORIGIN=/gm)).toHaveLength(1);
  });

  it('is absent on a fresh stack until up sets it', () => {
    writeEnvStack(dir);
    expect(readStackEnvValue(dir, 'WEBAUTHN_ORIGIN')).toBeUndefined();
  });
});

describe('writeEnvStack runtime keys', () => {
  it('does not copy a root .env WEBAUTHN_ORIGIN into .env.stack', () => {
    writeFileSync(path.join(dir, '.env'), 'WEBAUTHN_ORIGIN=https://prod.example.com\n');
    writeEnvStack(dir);
    writeEnvStack(dir);
    expect(readFileSync(path.join(dir, '.env.stack'), 'utf8')).not.toContain('WEBAUTHN_ORIGIN=');
  });
});

// #6443 — the orchestration `wt-stack up` runs once caddy's port is known.
describe('pinWebAuthnForStack', () => {
  function fakeDeps() {
    const calls: string[] = [];
    return { calls, deps: { recreateApi: () => calls.push('recreate'), waitApiHealthy: () => calls.push('wait') } };
  }

  it('pins origin and RP ID on a fresh stack and recreates api once', () => {
    writeEnvStack(dir);
    const { calls, deps } = fakeDeps();
    expect(pinWebAuthnForStack(dir, 'http://localhost:55001', deps)).toBe(true);
    expect(calls).toEqual(['recreate', 'wait']);
    expect(readStackEnvValue(dir, 'WEBAUTHN_ORIGIN')).toBe('http://localhost:55001');
    expect(readStackEnvValue(dir, 'WEBAUTHN_RP_ID')).toBe('localhost');
  });

  it('does not recreate api when the stack is already pinned to that port', () => {
    writeEnvStack(dir);
    pinWebAuthnForStack(dir, 'http://localhost:55001', fakeDeps().deps);
    writeEnvStack(dir); // next `up`
    const { calls, deps } = fakeDeps();
    expect(pinWebAuthnForStack(dir, 'http://localhost:55001', deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('re-pins and recreates when caddy came back on a different port', () => {
    writeEnvStack(dir);
    pinWebAuthnForStack(dir, 'http://localhost:55001', fakeDeps().deps);
    const { calls, deps } = fakeDeps();
    expect(pinWebAuthnForStack(dir, 'http://localhost:55002', deps)).toBe(true);
    expect(calls).toEqual(['recreate', 'wait']);
    expect(readStackEnvValue(dir, 'WEBAUTHN_ORIGIN')).toBe('http://localhost:55002');
  });

  it('overrides a root .env WEBAUTHN_RP_ID and origin for the local stack', () => {
    writeFileSync(path.join(dir, '.env'), 'WEBAUTHN_RP_ID=prod.example.com\nWEBAUTHN_ORIGIN=https://prod.example.com\n');
    writeEnvStack(dir);
    const { calls, deps } = fakeDeps();
    expect(pinWebAuthnForStack(dir, 'http://localhost:55001', deps)).toBe(true);
    expect(calls).toEqual(['recreate', 'wait']);
    // compose reads .env then .env.stack; the stack's value is what api sees.
    expect(readStackEnvValue(dir, 'WEBAUTHN_RP_ID')).toBe('localhost');
    expect(readStackEnvValue(dir, 'WEBAUTHN_ORIGIN')).toBe('http://localhost:55001');
  });
});

describe('compose passes the pinned WebAuthn values through to api', () => {
  it('maps WEBAUTHN_ORIGIN and WEBAUTHN_RP_ID from the env files', () => {
    const compose = readFileSync(path.resolve(__dirname, '../../../docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/^\s*WEBAUTHN_ORIGIN: \$\{WEBAUTHN_ORIGIN:-\}\s*$/m);
    expect(compose).toMatch(/^\s*WEBAUTHN_RP_ID: \$\{WEBAUTHN_RP_ID:-\}\s*$/m);
  });
});
