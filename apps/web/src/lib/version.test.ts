import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('WEB_VERSION', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses PUBLIC_APP_VERSION when set', async () => {
    vi.stubEnv('PUBLIC_APP_VERSION', '0.81.0');
    const { WEB_VERSION } = await import('./version');
    expect(WEB_VERSION).toBe('0.81.0');
  });

  it('falls back to the non-semver "dev" sentinel when unset (not a fake "0.1.0")', async () => {
    vi.stubEnv('PUBLIC_APP_VERSION', '');
    const { WEB_VERSION } = await import('./version');
    expect(WEB_VERSION).toBe('dev');
    // A semver-shaped fallback would be flagged stale/red by the footer's
    // staleness check; the sentinel renders neutral instead.
    expect(WEB_VERSION).not.toMatch(/^\d+\.\d+\.\d+$/);
  });
});
