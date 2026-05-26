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

  it('warns but does not throw in self-hosted production with no Redis password', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalIsHosted = process.env.IS_HOSTED;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { resolveRedisUrl } = await import('./redis');

    process.env.NODE_ENV = 'production';
    process.env.IS_HOSTED = 'false';
    process.env.REDIS_URL = 'redis://redis:6379';
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_PASSWORD_FILE;

    try {
      expect(() => resolveRedisUrl()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('REDIS_PASSWORD')
      );
    } finally {
      warnSpy.mockRestore();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalIsHosted === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = originalIsHosted;
    }
  });
});
