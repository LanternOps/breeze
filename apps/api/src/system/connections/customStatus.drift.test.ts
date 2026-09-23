/**
 * Drift guard for invariant 5 / D10. redisStatus and emailStatus re-implement
 * resolvers that read process.env directly (services/redis.ts resolveRedisUrl,
 * services/email.ts resolveEmailProviderConfig), so the fixed-expectation
 * tests in customStatus.test.ts cannot notice when those resolvers change.
 * Here every fixture runs through BOTH the real resolver (process.env stubbed)
 * and the status function, and the outcomes must agree:
 *   resolver throws  <=> status is not 'enabled'
 *   resolver returns <=> status is 'enabled' (except Redis with no host, which
 *                        resolves to a localhost fallback and is reported as
 *                        required_missing on purpose — plan ambiguity 9)
 * databaseStatus needs no drift test: it calls the real resolver.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailStatus, redisStatus } from './customStatus';
import type { EnvSnapshot } from './types';

const REDIS_VARS = [
  'NODE_ENV',
  'IS_HOSTED',
  'BREEZE_ALLOW_UNAUTH_REDIS',
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'REDIS_PASSWORD_FILE',
] as const;

const EMAIL_VARS = [
  'EMAIL_PROVIDER',
  'EMAIL_FROM',
  'RESEND_API_KEY',
  'SMTP_HOST',
  'SMTP_FROM',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_TIMEOUT_MS',
  'MAILGUN_API_KEY',
  'MAILGUN_DOMAIN',
  'MAILGUN_FROM',
  'MAILGUN_BASE_URL',
  'MAILGUN_TIMEOUT_MS',
] as const;

/** Stubs process.env to exactly `env` for the listed names (others untouched). */
function stubOnly(names: readonly string[], env: EnvSnapshot): void {
  for (const name of names) vi.stubEnv(name, env[name]);
}

/** A harness error (e.g. a missing mock export) must fail the test, not count as "resolver threw". */
function rethrowHarnessError(err: unknown): void {
  if (String(err).includes('[vitest]')) throw err;
}

function resolves(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    rethrowHarnessError(err);
    return false;
  }
}

// The global test setup mocks services/redis (and may mock others); the drift
// check needs the real resolvers.
const { resolveRedisUrl } = await vi.importActual<typeof import('../../services/redis')>('../../services/redis');
const { resolveEmailProviderConfig } = await vi.importActual<typeof import('../../services/email')>('../../services/email');

afterEach(() => {
  vi.unstubAllEnvs();
});

const redisFixtures: Array<[string, EnvSnapshot]> = [
  ['dev, nothing set', {}],
  ['dev, host only', { REDIS_HOST: 'redis' }],
  ['prod, host + password', { NODE_ENV: 'production', REDIS_HOST: 'redis', REDIS_PASSWORD: 'pw' }],
  ['prod, host, no password', { NODE_ENV: 'production', REDIS_HOST: 'redis' }],
  ['prod, host, no password, opt-out', { NODE_ENV: 'production', REDIS_HOST: 'redis', BREEZE_ALLOW_UNAUTH_REDIS: 'true' }],
  ['hosted prod, host, no password, opt-out', { NODE_ENV: 'production', IS_HOSTED: 'true', REDIS_HOST: 'redis', BREEZE_ALLOW_UNAUTH_REDIS: 'true' }],
  ['prod (tolerant "Prod"), url without password', { NODE_ENV: 'Prod', REDIS_URL: 'redis://redis:6379' }],
  ['prod, url with password', { NODE_ENV: 'production', REDIS_URL: 'redis://:pw@redis:6379' }],
  ['prod, url without password, opt-out', { NODE_ENV: 'production', REDIS_URL: 'redis://redis:6379', BREEZE_ALLOW_UNAUTH_REDIS: 'TRUE' }],
  ['hosted prod, url with password', { NODE_ENV: 'production', IS_HOSTED: 'true', REDIS_URL: 'redis://:pw@redis:6379' }],
];

describe('redisStatus agrees with resolveRedisUrl', () => {
  it.each(redisFixtures)('%s', (_label, env) => {
    stubOnly(REDIS_VARS, env);
    const ok = resolves(() => resolveRedisUrl());
    const { status } = redisStatus(env);
    if (!ok) {
      expect(status).toBe('misconfigured');
    } else if (!env.REDIS_URL && !env.REDIS_HOST) {
      expect(status).toBe('required_missing'); // localhost fallback, surfaced on purpose
    } else {
      expect(status).toBe('enabled');
    }
  });
});

const smtp = { SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'a@b.c' };
const mailgun = { MAILGUN_API_KEY: 'k', MAILGUN_DOMAIN: 'mg.example.com', EMAIL_FROM: 'a@b.c' };

const emailFixtures: Array<[string, EnvSnapshot]> = [
  ['nothing set', {}],
  ['compose defaults only', { EMAIL_PROVIDER: 'auto', EMAIL_FROM: 'noreply@breeze.local' }],
  ['resend + from', { RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c' }],
  ['resend, no from', { RESEND_API_KEY: 're_x' }],
  ['explicit resend, no key', { EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.c' }],
  ['unknown provider', { EMAIL_PROVIDER: 'sendgrid', ...smtp }],
  ['blank provider', { EMAIL_PROVIDER: ' ', ...smtp }],
  ['smtp via EMAIL_FROM', smtp],
  ['smtp via SMTP_FROM', { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'a@b.c' }],
  ['smtp user without pass', { ...smtp, SMTP_USER: 'u' }],
  ['smtp pass without user', { ...smtp, SMTP_PASS: 'p' }],
  ['smtp user + pass', { ...smtp, SMTP_USER: 'u', SMTP_PASS: 'p' }],
  ['smtp bad port', { ...smtp, SMTP_PORT: '70000' }],
  ['smtp port with suffix (parseInt accepts)', { ...smtp, SMTP_PORT: '587abc' }],
  ['smtp bad secure', { ...smtp, SMTP_SECURE: 'maybe' }],
  ['smtp good secure', { ...smtp, SMTP_SECURE: 'On' }],
  ['smtp bad timeout', { ...smtp, SMTP_TIMEOUT_MS: '30s' }],
  ['smtp good timeout', { ...smtp, SMTP_TIMEOUT_MS: '30000' }],
  ['explicit smtp, no host', { EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'a@b.c' }],
  ['mailgun', mailgun],
  ['mailgun, no domain', { MAILGUN_API_KEY: 'k', EMAIL_FROM: 'a@b.c' }],
  ['mailgun bad timeout', { ...mailgun, MAILGUN_TIMEOUT_MS: '2m' }],
  ['mailgun ignores bad smtp port', { ...mailgun, SMTP_PORT: 'abc' }],
  ['resend wins over bad smtp', { RESEND_API_KEY: 're_x', ...smtp, SMTP_PORT: 'abc' }],
  ['bad smtp does not fall through to mailgun', { ...mailgun, SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'abc' }],
];

describe('emailStatus agrees with resolveEmailProviderConfig', () => {
  it.each(emailFixtures)('%s', (_label, env) => {
    stubOnly(EMAIL_VARS, env);
    let provider: string | null = null;
    try {
      provider = resolveEmailProviderConfig().provider;
    } catch (err) {
      rethrowHarnessError(err);
      provider = null;
    }
    const result = emailStatus(env);
    if (provider === null) {
      expect(result.status).not.toBe('enabled');
    } else {
      expect(result.status).toBe('enabled');
      expect(result.reason).toContain(provider);
    }
  });
});
