import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// recoveryMediaService pulls in the db and the recovery-bootstrap/signing
// stack at module load; none of it is exercised by resolveBackupBinary.
// `safeFetch` (now on the download path) calls `assertOutsideHeldDbContext`,
// so the `../db` mock has to expose it or the import fails at call time.
vi.mock('../db', () => ({ db: {}, assertOutsideHeldDbContext: vi.fn() }));
vi.mock('./recoveryBootstrap', () => ({
  asRecord: (v: unknown) => (v && typeof v === 'object' ? v : {}),
  getStringValue: () => null,
  resolveServerUrl: () => 'https://breeze.example.com',
  resolveSnapshotProviderConfig: vi.fn(),
}));
// `downloadFile` now goes through the SSRF-guarded `safeFetchFollowingRedirects`,
// which resolves DNS and dials a pinned IP itself — it never touches global
// `fetch`, so `stubFetch` below would otherwise be bypassed and these cases
// would make real network calls. Route it back to the stubbed global; that the
// guard is actually adopted here is covered by `backupSsrfAdoption.test.ts`, and
// the redirect/SSRF semantics of the real helper by
// `recoveryMediaService.redirect.test.ts` + `urlSafety.test.ts`.
vi.mock('./urlSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./urlSafety')>()),
  safeFetchFollowingRedirects: (url: string) => globalThis.fetch(url),
}));
vi.mock('./recoverySigning', () => ({
  getRecoverySigningKey: () => null,
  isRecoverySigningConfigured: () => false,
  signRecoveryArtifact: vi.fn(),
}));

import { resolveBackupBinary } from './recoveryMediaService';

function makeSignedBackupManifest(assetName: string, assetBuffer: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString('base64');
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: 'LanternOps/breeze',
      release: 'v1.2.3',
      assets: [
        {
          name: assetName,
          sha256: createHash('sha256').update(assetBuffer).digest('hex'),
          size: assetBuffer.length,
          platformTrust: 'release-workflow-produced',
        },
      ],
    }),
  );
  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString('base64')),
    publicKey: rawPublicKey,
  };
}

describe('resolveBackupBinary (github mode, spec 3d)', () => {
  const originalEnv = process.env;
  let workingDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_SOURCE; // github is the default
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    process.env.BINARY_VERSION = '1.2.3';
    workingDir = await mkdtemp(join(tmpdir(), 'recovery-test-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    await rm(workingDir, { recursive: true, force: true });
  });

  function stubFetch(assetName: string, bytes: Buffer, signed: ReturnType<typeof makeSignedBackupManifest>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith(`/${assetName}`)) return new Response(new Uint8Array(bytes));
        if (url.endsWith('/release-artifact-manifest.json')) return new Response(new Uint8Array(signed.manifest));
        if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(new Uint8Array(signed.signature));
        return new Response('not found', { status: 404 });
      }),
    );
  }

  it('verifies the backup binary against the signed release manifest, not the static table', async () => {
    const bytes = Buffer.from('backup binary bytes');
    const signed = makeSignedBackupManifest('breeze-backup-linux-amd64', bytes);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    stubFetch('breeze-backup-linux-amd64', bytes, signed);

    const result = await resolveBackupBinary('linux', 'amd64', workingDir);
    expect(result.verified).toMatchObject({
      platform: 'linux',
      architecture: 'amd64',
      sourceType: 'github',
      sourceRef: 'github-release:v1.2.3',
      version: '1.2.3',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      manifestVersion: 'v1.2.3',
    });
  });

  it('fails closed when the downloaded bytes do not match the manifest hash', async () => {
    const bytes = Buffer.from('backup binary bytes');
    const signed = makeSignedBackupManifest('breeze-backup-linux-amd64', bytes);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    stubFetch('breeze-backup-linux-amd64', Buffer.from('TAMPERED bytes!!!!!'), signed);

    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      /mismatch/,
    );
  });

  it('fails closed when no manifest trust root is configured', async () => {
    const bytes = Buffer.from('backup binary bytes');
    const signed = makeSignedBackupManifest('breeze-backup-linux-amd64', bytes);
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    stubFetch('breeze-backup-linux-amd64', bytes, signed);

    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      /RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS/,
    );
  });

  it('still requires a pinned version (never "latest")', async () => {
    process.env.BINARY_VERSION = 'latest';
    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      /pinned GitHub release version/,
    );
  });
});
