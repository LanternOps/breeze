import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEnvStack, readStackEnvValue, setStackEnvValues, pinWebAuthnForStack, caddyPortPin } from './env';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeEnvStack', () => {
  // #8155 W03 — e2e-tests/helpers/tunnelOriginStack.ts turns Network Proxy host
  // mode on after `up` (the template carries caddy's published port). A re-up
  // must keep it, or the next `up` silently drops the stack back to path mode.
  it('keeps the tunnel-origin runtime keys across a re-up', () => {
    writeFileSync(path.join(dir, '.env'), '');
    const values = {
      TUNNEL_ORIGIN_TEMPLATE: 'http://{id}.tunnel.localhost:5',
      TUNNEL_FRAME_ANCESTOR: 'http://app.localhost:5',
      TUNNEL_SITE_ADDRESS: 'http://*.tunnel.localhost, http://*.*.tunnel.localhost',
      TUNNEL_HOST_SUFFIX: 'tunnel.localhost',
      PUBLIC_PORTAL_URL: 'http://app.localhost:5/portal',
    };
    setStackEnvValues(dir, values);
    writeEnvStack(dir, { arch: 'x64' });
    for (const [k, v] of Object.entries(values)) expect(readStackEnvValue(dir, k)).toBe(v);
  });

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

// #8718 — `docker restart` re-allocates a random published port, so a storm run
// that restarts caddy needs a fixed host port. Opt-in via BREEZE_WT_CADDY_PORT.
describe('caddyPortPin (#8718)', () => {
  it('is null when unset or empty (random port, unchanged behaviour)', () => {
    expect(caddyPortPin({})).toBeNull();
    expect(caddyPortPin({ BREEZE_WT_CADDY_PORT: '' })).toBeNull();
  });
  it('parses a valid port', () => {
    expect(caddyPortPin({ BREEZE_WT_CADDY_PORT: '18080' })).toBe(18080);
  });
  it.each(['abc', '0', '70000', '80.5', '-1'])('rejects %s', (v) => {
    expect(() => caddyPortPin({ BREEZE_WT_CADDY_PORT: v })).toThrow(/BREEZE_WT_CADDY_PORT/);
  });
});

describe('worktree override caddy publish (#8718)', () => {
  it('publishes caddy as ${BREEZE_WT_CADDY_PORT:-0}:80 (the :-0 keeps the random-port default)', () => {
    const override = readFileSync(path.resolve(__dirname, '../../../docker-compose.override.yml.worktree'), 'utf8');
    expect(override).toMatch(/^\s*-\s*"\$\{BREEZE_WT_CADDY_PORT:-0\}:80"\s*$/m);
  });
});

describe('writeEnvStack caddy pin (#8718)', () => {
  const prev = process.env.BREEZE_WT_CADDY_PORT;
  afterEach(() => {
    if (prev === undefined) delete process.env.BREEZE_WT_CADDY_PORT; else process.env.BREEZE_WT_CADDY_PORT = prev;
  });
  it('writes BREEZE_WT_CADDY_PORT when pinned', () => {
    process.env.BREEZE_WT_CADDY_PORT = '18080';
    expect(readFileSync(writeEnvStack(dir), 'utf8')).toMatch(/^BREEZE_WT_CADDY_PORT=18080$/m);
  });
  it('omits it when unset, and drops a stale pin on re-up', () => {
    process.env.BREEZE_WT_CADDY_PORT = '18080';
    writeEnvStack(dir);
    delete process.env.BREEZE_WT_CADDY_PORT;
    expect(readFileSync(writeEnvStack(dir), 'utf8')).not.toContain('BREEZE_WT_CADDY_PORT');
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

// The dev images are built locally from the worktree, but docker-compose.yml
// defaults DOCKER_PLATFORM to linux/amd64. On an arm64 host that runs the API
// under emulation: the main thread blocks ~15 s after boot and every detached
// startup task (registry reconcile, storage key history, built-in monitors)
// times out on its database prologue. Build native unless the root .env says
// otherwise.
describe('writeEnvStack — DOCKER_PLATFORM', () => {
  it('builds native arm64 images on an arm64 host when the root .env leaves it unset', () => {
    const env = readFileSync(writeEnvStack(dir, { arch: 'arm64' }), 'utf8');
    expect(env).toContain('DOCKER_PLATFORM=linux/arm64');
  });

  it('keeps an explicit DOCKER_PLATFORM from the root .env', () => {
    writeFileSync(path.join(dir, '.env'), 'FOO=1\nDOCKER_PLATFORM=linux/amd64\n', 'utf8');
    const env = readFileSync(writeEnvStack(dir, { arch: 'arm64' }), 'utf8');
    expect(env).not.toContain('DOCKER_PLATFORM=');
  });

  it('adds nothing on an x64 host (the compose default is already native)', () => {
    const env = readFileSync(writeEnvStack(dir, { arch: 'x64' }), 'utf8');
    expect(env).not.toContain('DOCKER_PLATFORM=');
  });
});

// A wt-stack is a throwaway QA stack: the developer's root .env carries a real
// RESEND_API_KEY, which must never reach the stack's containers.
describe('writeEnvStack — no live outbound mail', () => {
  afterEach(() => { delete process.env.BREEZE_WT_STACK_LIVE_MAIL; });

  it('blanks the mail provider keys over the root .env, across rewrites', () => {
    writeFileSync(path.join(dir, '.env'),
      'RESEND_API_KEY=re_live\nMAILGUN_API_KEY=mg_live\nSMTP_HOST=smtp.example.com\n');
    writeEnvStack(dir);
    for (const k of ['RESEND_API_KEY', 'MAILGUN_API_KEY', 'SMTP_HOST']) {
      expect(readStackEnvValue(dir, k)).toBe('');
    }
    writeEnvStack(dir);
    expect(readStackEnvValue(dir, 'RESEND_API_KEY')).toBe('');
    expect(readFileSync(path.join(dir, '.env.stack'), 'utf8').match(/^RESEND_API_KEY=/gm)).toHaveLength(1);
  });

  it('leaves them untouched when BREEZE_WT_STACK_LIVE_MAIL=1', () => {
    process.env.BREEZE_WT_STACK_LIVE_MAIL = '1';
    writeFileSync(path.join(dir, '.env'), 'RESEND_API_KEY=re_live\n');
    writeEnvStack(dir);
    expect(readStackEnvValue(dir, 'RESEND_API_KEY')).toBe('re_live');
    expect(readFileSync(path.join(dir, '.env.stack'), 'utf8')).not.toContain('RESEND_API_KEY');
  });
});
