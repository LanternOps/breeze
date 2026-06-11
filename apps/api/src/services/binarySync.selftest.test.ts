import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cover both branches: pass (sign + validate agree) and fail (validator rejects).

describe('runManifestSelfTest', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws when validateReleaseManifest rejects the round-tripped manifest', async () => {
    vi.doMock('./manifestSigning', () => ({
      ensureActiveSigningKey: vi.fn(async () => ({
        keyId: 'deploy-test',
        publicKeyB64: 'AAA=',
      })),
      signManifest: vi.fn(async () => 'sig-not-actually-valid'),
      getActivePublicKeys: vi.fn(async () => []),
    }));
    vi.doMock('../routes/agentVersions', () => ({
      validateReleaseManifest: vi.fn(async () => ({
        ok: false,
        reason: 'invalid_release_manifest_signature',
      })),
    }));

    const { runManifestSelfTest } = await import('./binarySync.selftest');
    await expect(runManifestSelfTest()).rejects.toThrow(/self-test failed/);
  });

  it('passes when validator accepts the round-tripped manifest', async () => {
    vi.doMock('./manifestSigning', () => ({
      ensureActiveSigningKey: vi.fn(async () => ({
        keyId: 'deploy-test',
        publicKeyB64: 'AAA=',
      })),
      signManifest: vi.fn(async () => 'sig-base64'),
      getActivePublicKeys: vi.fn(async () => []),
    }));
    vi.doMock('../routes/agentVersions', () => ({
      validateReleaseManifest: vi.fn(async () => ({ ok: true as const })),
    }));

    const { runManifestSelfTest } = await import('./binarySync.selftest');
    await expect(runManifestSelfTest()).resolves.not.toThrow();
  });
});
