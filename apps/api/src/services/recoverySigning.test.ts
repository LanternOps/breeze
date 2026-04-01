import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('recoverySigning key registry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads configured historical signing keys and current key env', async () => {
    process.env.RECOVERY_SIGNING_KEYS_JSON = JSON.stringify([
      {
        keyId: 'old-key',
        publicKey: 'RWQOLDPUBLICKEY',
        isCurrent: false,
        activatedAt: '2026-01-01T00:00:00Z',
        deprecatedAt: '2026-02-01T00:00:00Z',
      },
    ]);
    process.env.RECOVERY_SIGNING_PUBLIC_KEY = 'RWQCURRENTPUBLICKEY';
    process.env.RECOVERY_SIGNING_PRIVATE_KEY = 'RWSCURRENTPRIVATEKEY';
    process.env.RECOVERY_SIGNING_KEY_ID = 'current-key';

    vi.resetModules();
    const mod = await import('./recoverySigning');
    expect(mod.getRecoverySigningKeys()).toEqual([
      expect.objectContaining({
        keyId: 'current-key',
        publicKey: 'RWQCURRENTPUBLICKEY',
        isCurrent: true,
      }),
      expect.objectContaining({
        keyId: 'old-key',
        publicKey: 'RWQOLDPUBLICKEY',
        isCurrent: false,
      }),
    ]);
    expect(mod.getCurrentRecoverySigningKey()).toEqual(expect.objectContaining({
      keyId: 'current-key',
    }));
    expect(mod.getRecoverySigningKey('old-key')).toEqual(expect.objectContaining({
      publicKey: 'RWQOLDPUBLICKEY',
    }));
  });
});
