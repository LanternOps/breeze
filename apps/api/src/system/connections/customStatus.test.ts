/**
 * Invariant 5 — status truthfulness. Each core entry's status follows the
 * real resolver (spec D10), not raw env presence. Fixtures are compose-shaped
 * (docker-compose.yml:25-33, 66-68, 187-189) where that matters.
 */
import { describe, expect, it } from 'vitest';
import { resolveRequestDatabaseConfig } from '../../db/requestDatabaseConfig';
import {
  agentBinariesStatus,
  databaseStatus,
  emailStatus,
  redisStatus,
  transportSecurityStatus,
  workspaceExtensionStatus,
} from './customStatus';

describe('redisStatus (mirrors services/redis.ts resolveRedisUrl)', () => {
  it('compose-style REDIS_HOST + REDIS_PASSWORD_FILE, no REDIS_URL => enabled (file never opened)', () => {
    const env = {
      NODE_ENV: 'production',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6379',
      REDIS_PASSWORD_FILE: '/nonexistent/run/secrets/redis_password',
    };
    expect(redisStatus(env).status).toBe('enabled');
  });

  it('REDIS_URL with a password => enabled', () => {
    expect(redisStatus({ NODE_ENV: 'production', REDIS_URL: 'redis://:pw@redis:6379' }).status).toBe('enabled');
  });

  it('production REDIS_URL without a password => misconfigured', () => {
    const result = redisStatus({ NODE_ENV: 'production', REDIS_URL: 'redis://redis:6379' });
    expect(result.status).toBe('misconfigured');
    expect(result.reason).toMatch(/REDIS_URL/);
  });

  it('production REDIS_HOST without any password => misconfigured, unless BREEZE_ALLOW_UNAUTH_REDIS=true', () => {
    expect(redisStatus({ NODE_ENV: 'prod', REDIS_HOST: 'redis' }).status).toBe('misconfigured');
    expect(
      redisStatus({ NODE_ENV: 'production', REDIS_HOST: 'redis', BREEZE_ALLOW_UNAUTH_REDIS: 'true' }).status,
    ).toBe('enabled');
  });

  it('hosted SaaS (IS_HOSTED=true) ignores BREEZE_ALLOW_UNAUTH_REDIS: no password => misconfigured', () => {
    // services/redis.ts failOrWarnAboutInsecureRedis: hosted is always fail-closed.
    expect(
      redisStatus({ NODE_ENV: 'production', IS_HOSTED: 'true', REDIS_HOST: 'redis', BREEZE_ALLOW_UNAUTH_REDIS: 'true' }).status,
    ).toBe('misconfigured');
    expect(
      redisStatus({ NODE_ENV: 'production', IS_HOSTED: 'TRUE', REDIS_URL: 'redis://redis:6379', BREEZE_ALLOW_UNAUTH_REDIS: 'true' }).status,
    ).toBe('misconfigured');
  });

  it('development REDIS_HOST without a password => enabled (the resolver only warns outside production)', () => {
    expect(redisStatus({ NODE_ENV: 'development', REDIS_HOST: 'localhost' }).status).toBe('enabled');
  });

  it('nothing set => required_missing', () => {
    expect(redisStatus({}).status).toBe('required_missing');
  });
});

describe('databaseStatus (mirrors db/requestDatabaseConfig.ts resolveRequestDatabaseConfig)', () => {
  const composeEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://breeze:pw@postgres:5432/breeze',
    POSTGRES_PASSWORD: 'pw',
  };

  it('DATABASE_URL + POSTGRES_PASSWORD, no DATABASE_URL_APP => enabled (derived)', () => {
    expect(resolveRequestDatabaseConfig(composeEnv).source).toBe('derived');
    expect(databaseStatus(composeEnv).status).toBe('enabled');
  });

  it('explicit DATABASE_URL_APP => enabled', () => {
    const env = { ...composeEnv, POSTGRES_PASSWORD: '', DATABASE_URL_APP: 'postgresql://breeze_app:x@db:5432/breeze' };
    expect(databaseStatus(env)).toEqual({ status: 'enabled', reason: 'Request pool uses DATABASE_URL_APP' });
  });

  it('production DATABASE_URL alone => misconfigured (the resolver refuses to boot)', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://breeze:pw@postgres:5432/breeze' };
    expect(() => resolveRequestDatabaseConfig(env)).toThrow();
    expect(databaseStatus(env).status).toBe('misconfigured');
  });

  it('development DATABASE_URL alone => misconfigured (development fallback to the admin URL)', () => {
    const env = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://breeze:pw@localhost:5432/breeze' };
    expect(resolveRequestDatabaseConfig(env).source).toBe('development-fallback');
    expect(databaseStatus(env).status).toBe('misconfigured');
  });

  it('invalid DATABASE_URL_APP => misconfigured naming the var', () => {
    const result = databaseStatus({ ...composeEnv, DATABASE_URL_APP: 'mysql://nope' });
    expect(result).toEqual({ status: 'misconfigured', reason: 'DATABASE_URL_APP is not a valid postgres:// URL' });
  });

  it('multi-host DATABASE_URL with a derivation password => misconfigured', () => {
    const env = { ...composeEnv, DATABASE_URL: 'postgresql://breeze:pw@db1:5432,db2:5432/breeze' };
    expect(databaseStatus(env).status).toBe('misconfigured');
  });

  it('no DATABASE_URL => required_missing', () => {
    expect(databaseStatus({ POSTGRES_PASSWORD: 'pw' }).status).toBe('required_missing');
  });
});

describe('emailStatus (mirrors services/email.ts resolveEmailProviderConfig)', () => {
  it('compose-style RESEND_API_KEY with the compose EMAIL_FROM default => enabled, provider resend', () => {
    const env = { EMAIL_PROVIDER: 'auto', RESEND_API_KEY: 're_x', EMAIL_FROM: 'noreply@breeze.local' };
    expect(emailStatus(env)).toEqual({ status: 'enabled', reason: 'Provider: resend (auto-detected)' });
  });

  it('RESEND_API_KEY with no EMAIL_FROM at all => misconfigured (the resolver throws "EMAIL_FROM is not set")', () => {
    expect(emailStatus({ RESEND_API_KEY: 're_x' })).toEqual({
      status: 'misconfigured',
      reason: 'resend is partly configured: EMAIL_FROM is missing',
    });
  });

  it('SMTP_HOST + EMAIL_FROM fallback => enabled, provider smtp', () => {
    expect(emailStatus({ SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'a@b.c' })).toEqual({
      status: 'enabled',
      reason: 'Provider: smtp (auto-detected)',
    });
  });

  it('SMTP_USER without SMTP_PASS => misconfigured', () => {
    const result = emailStatus({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'a@b.c', SMTP_USER: 'u' });
    expect(result.status).toBe('misconfigured');
    expect(result.reason).toMatch(/SMTP_USER and SMTP_PASS/);
  });

  it('explicit EMAIL_PROVIDER=mailgun without MAILGUN_DOMAIN => misconfigured', () => {
    const result = emailStatus({ EMAIL_PROVIDER: 'mailgun', MAILGUN_API_KEY: 'k', EMAIL_FROM: 'a@b.c' });
    expect(result).toEqual({ status: 'misconfigured', reason: 'EMAIL_PROVIDER selects mailgun but MAILGUN_DOMAIN is missing' });
  });

  it('unknown EMAIL_PROVIDER => misconfigured', () => {
    expect(emailStatus({ EMAIL_PROVIDER: 'sendgrid' }).status).toBe('misconfigured');
  });

  it('only the compose defaults (EMAIL_PROVIDER=auto, EMAIL_FROM) => required_missing', () => {
    expect(emailStatus({ EMAIL_PROVIDER: 'auto', EMAIL_FROM: 'noreply@breeze.local' }).status).toBe('required_missing');
  });
});

describe('non-core custom statuses', () => {
  it('agent binaries are always enabled; unset BINARY_SOURCE explains the default', () => {
    expect(agentBinariesStatus({}).status).toBe('enabled');
    expect(agentBinariesStatus({}).reason).toMatch(/BINARY_SOURCE/);
    expect(agentBinariesStatus({ BINARY_SOURCE: 'local' })).toEqual({ status: 'enabled' });
  });

  it('workspace extension uses the strict === "true" check of builtinExtensions.ts', () => {
    expect(workspaceExtensionStatus({ BREEZE_WORKSPACE_ENABLED: 'true' }).status).toBe('enabled');
    expect(workspaceExtensionStatus({ BREEZE_WORKSPACE_ENABLED: '1' }).status).toBe('disabled');
  });

  it('transport security needs FORCE_HTTPS and PUBLIC_API_URL', () => {
    expect(transportSecurityStatus({}).status).toBe('disabled');
    expect(transportSecurityStatus({ FORCE_HTTPS: '1' }).status).toBe('misconfigured');
    expect(transportSecurityStatus({ FORCE_HTTPS: 'true', PUBLIC_API_URL: 'https://x.example' }).status).toBe('enabled');
  });
});
