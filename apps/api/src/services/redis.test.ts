import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('./redis');

describe('resolveRedisUrl', () => {
  const originalEnv = {
    REDIS_URL: process.env.REDIS_URL,
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
    REDIS_PASSWORD_FILE: process.env.REDIS_PASSWORD_FILE,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds an authenticated URL from REDIS_PASSWORD_FILE', async () => {
    vi.resetModules();
    const { resolveRedisUrl } = await import('./redis');
    const dir = mkdtempSync(join(tmpdir(), 'breeze-redis-secret-'));
    const secretPath = join(dir, 'redis_password');
    writeFileSync(secretPath, 'redis secret with spaces\n', { mode: 0o600 });

    delete process.env.REDIS_URL;
    delete process.env.REDIS_PASSWORD;
    process.env.REDIS_HOST = 'redis.internal';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD_FILE = secretPath;

    try {
      expect(resolveRedisUrl()).toBe('redis://:redis%20secret%20with%20spaces@redis.internal:6380');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws in hosted-SaaS production when REDIS_URL has no password', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalIsHosted = process.env.IS_HOSTED;
    vi.resetModules();
    const { resolveRedisUrl } = await import('./redis');

    process.env.NODE_ENV = 'production';
    process.env.IS_HOSTED = 'true';
    process.env.REDIS_URL = 'redis://redis:6379';
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_PASSWORD_FILE;

    try {
      expect(() => resolveRedisUrl()).toThrow(/REDIS_URL must include a password/);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalIsHosted === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = originalIsHosted;
    }
  });

  it('throws in self-hosted production with no Redis password (fail-closed by default)', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalIsHosted = process.env.IS_HOSTED;
    const originalOverride = process.env.BREEZE_ALLOW_UNAUTH_REDIS;
    vi.resetModules();
    const { resolveRedisUrl } = await import('./redis');

    process.env.NODE_ENV = 'production';
    process.env.IS_HOSTED = 'false';
    process.env.REDIS_URL = 'redis://redis:6379';
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_PASSWORD_FILE;
    delete process.env.BREEZE_ALLOW_UNAUTH_REDIS;

    try {
      expect(() => resolveRedisUrl()).toThrow(/REDIS_URL must include a password/);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalIsHosted === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = originalIsHosted;
      if (originalOverride === undefined) delete process.env.BREEZE_ALLOW_UNAUTH_REDIS;
      else process.env.BREEZE_ALLOW_UNAUTH_REDIS = originalOverride;
    }
  });

  it('warns but does not throw in self-hosted prod when BREEZE_ALLOW_UNAUTH_REDIS=true', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalIsHosted = process.env.IS_HOSTED;
    const originalOverride = process.env.BREEZE_ALLOW_UNAUTH_REDIS;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { resolveRedisUrl } = await import('./redis');

    process.env.NODE_ENV = 'production';
    process.env.IS_HOSTED = 'false';
    process.env.REDIS_URL = 'redis://redis:6379';
    process.env.BREEZE_ALLOW_UNAUTH_REDIS = 'true';
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_PASSWORD_FILE;

    try {
      expect(() => resolveRedisUrl()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('BREEZE_ALLOW_UNAUTH_REDIS=true')
      );
    } finally {
      warnSpy.mockRestore();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalIsHosted === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = originalIsHosted;
      if (originalOverride === undefined) delete process.env.BREEZE_ALLOW_UNAUTH_REDIS;
      else process.env.BREEZE_ALLOW_UNAUTH_REDIS = originalOverride;
    }
  });

  it('throws in self-hosted prod even when BREEZE_ALLOW_UNAUTH_REDIS=true if hosted is also true', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalIsHosted = process.env.IS_HOSTED;
    const originalOverride = process.env.BREEZE_ALLOW_UNAUTH_REDIS;
    vi.resetModules();
    const { resolveRedisUrl } = await import('./redis');

    // Hosted SaaS always fails closed — opt-out is a self-hosted-only escape.
    process.env.NODE_ENV = 'production';
    process.env.IS_HOSTED = 'true';
    process.env.BREEZE_ALLOW_UNAUTH_REDIS = 'true';
    process.env.REDIS_URL = 'redis://redis:6379';
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_PASSWORD_FILE;

    try {
      expect(() => resolveRedisUrl()).toThrow(/REDIS_URL must include a password/);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalIsHosted === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = originalIsHosted;
      if (originalOverride === undefined) delete process.env.BREEZE_ALLOW_UNAUTH_REDIS;
      else process.env.BREEZE_ALLOW_UNAUTH_REDIS = originalOverride;
    }
  });

  it('treats NODE_ENV=Production (mixed case) as production', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalIsHosted = process.env.IS_HOSTED;
    const originalOverride = process.env.BREEZE_ALLOW_UNAUTH_REDIS;
    vi.resetModules();
    const { resolveRedisUrl } = await import('./redis');

    // Pre-fix exact-string match would have silently downgraded `Production`
    // to dev mode and allowed unauthenticated Redis without complaint.
    process.env.NODE_ENV = 'Production';
    process.env.IS_HOSTED = 'true';
    process.env.REDIS_URL = 'redis://redis:6379';
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_PASSWORD_FILE;
    delete process.env.BREEZE_ALLOW_UNAUTH_REDIS;

    try {
      expect(() => resolveRedisUrl()).toThrow(/REDIS_URL must include a password/);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalIsHosted === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = originalIsHosted;
      if (originalOverride === undefined) delete process.env.BREEZE_ALLOW_UNAUTH_REDIS;
      else process.env.BREEZE_ALLOW_UNAUTH_REDIS = originalOverride;
    }
  });
});
