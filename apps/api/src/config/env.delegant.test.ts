import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('delegant env config', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('reads DELEGANT_* vars when present', async () => {
    process.env.DELEGANT_BASE_URL = 'https://delegant.example';
    process.env.DELEGANT_SERVICE_TOKEN = 'svc-token';
    process.env.DELEGANT_PRINCIPAL_SIGNING_KEY = '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----';
    process.env.DELEGANT_PRINCIPAL_KID = 'kid-1';

    vi.resetModules();
    const mod = await import('./env');

    expect(mod.DELEGANT_BASE_URL).toBe('https://delegant.example');
    expect(mod.DELEGANT_SERVICE_TOKEN).toBe('svc-token');
    expect(mod.DELEGANT_PRINCIPAL_KID).toBe('kid-1');
    expect(mod.DELEGANT_PRINCIPAL_SIGNING_KEY).toContain('BEGIN PRIVATE KEY');
  });

  it('defaults to empty strings when absent', async () => {
    delete process.env.DELEGANT_BASE_URL;
    delete process.env.DELEGANT_SERVICE_TOKEN;
    delete process.env.DELEGANT_PRINCIPAL_SIGNING_KEY;
    delete process.env.DELEGANT_PRINCIPAL_KID;

    vi.resetModules();
    const mod = await import('./env');

    expect(typeof mod.DELEGANT_BASE_URL).toBe('string');
    expect(typeof mod.DELEGANT_SERVICE_TOKEN).toBe('string');
    expect(typeof mod.DELEGANT_PRINCIPAL_SIGNING_KEY).toBe('string');
    expect(typeof mod.DELEGANT_PRINCIPAL_KID).toBe('string');
    expect(mod.DELEGANT_BASE_URL).toBe('');
    expect(mod.DELEGANT_SERVICE_TOKEN).toBe('');
    expect(mod.DELEGANT_PRINCIPAL_SIGNING_KEY).toBe('');
    expect(mod.DELEGANT_PRINCIPAL_KID).toBe('');
  });
});
