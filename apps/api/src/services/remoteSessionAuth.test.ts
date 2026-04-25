import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Redis so module load doesn't reach out to a real instance.
vi.mock('./redis', () => ({
  getRedis: () => null,
}));

describe('shouldUseRedis', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.WS_TICKETS_REQUIRE_REDIS;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.NODE_ENV;
    delete process.env.WS_TICKETS_REQUIRE_REDIS;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalOverride === undefined) delete process.env.WS_TICKETS_REQUIRE_REDIS;
    else process.env.WS_TICKETS_REQUIRE_REDIS = originalOverride;
  });

  async function loadShouldUseRedis(): Promise<() => boolean> {
    const mod = await import('./remoteSessionAuth');
    return mod.shouldUseRedis;
  }

  it('returns false in NODE_ENV=development (no override)', async () => {
    process.env.NODE_ENV = 'development';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(false);
  });

  it('returns false in NODE_ENV=test (no override)', async () => {
    process.env.NODE_ENV = 'test';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(false);
  });

  it('returns true in NODE_ENV=staging (no override)', async () => {
    process.env.NODE_ENV = 'staging';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });

  it('returns true in NODE_ENV=production (no override)', async () => {
    process.env.NODE_ENV = 'production';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });

  it('WS_TICKETS_REQUIRE_REDIS=true forces true even in development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.WS_TICKETS_REQUIRE_REDIS = 'true';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });

  it('WS_TICKETS_REQUIRE_REDIS=1 forces true even in development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.WS_TICKETS_REQUIRE_REDIS = '1';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });

  it('WS_TICKETS_REQUIRE_REDIS=false forces false even in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_TICKETS_REQUIRE_REDIS = 'false';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(false);
  });

  it('WS_TICKETS_REQUIRE_REDIS=0 forces false even in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_TICKETS_REQUIRE_REDIS = '0';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(false);
  });

  it('unrecognized override value falls back to NODE_ENV-based default', async () => {
    process.env.NODE_ENV = 'staging';
    process.env.WS_TICKETS_REQUIRE_REDIS = 'yes';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });
});
