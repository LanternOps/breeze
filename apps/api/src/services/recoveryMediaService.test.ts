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

describe('buildLaunchScript / buildBundleReadme (binary signature verification)', () => {
  it('bash launch script fetches and verifies the binary signature before executing the binary, failing closed on missing minisign/curl or a failed check', async () => {
    const { buildLaunchScript } = await import('./recoveryMediaService');
    const script = buildLaunchScript({
      platform: 'linux',
      architecture: 'amd64',
      fileName: 'breeze-backup',
      serverUrl: 'https://breeze.example.com',
    });
    expect(script.fileName).toBe('run-recovery.sh');
    // Verification must happen, and must happen BEFORE the binary is exec'd.
    const verifyIdx = script.content.indexOf('minisign -V');
    const execIdx = script.content.indexOf('"$BINARY" bmr-recover');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(execIdx);
    // Fails closed: every one of these guards must `exit 1` before ever
    // reaching the exec line, not merely print a warning.
    expect(script.content).toContain('command -v minisign');
    expect(script.content).toContain('/api/v1/backup/bmr/recover/binary-signature');
    expect(script.content).toContain('exit 1');
  });

  it('windows launch script fetches and verifies the binary signature before executing the binary, failing closed', async () => {
    const { buildLaunchScript } = await import('./recoveryMediaService');
    const script = buildLaunchScript({
      platform: 'windows',
      architecture: 'amd64',
      fileName: 'breeze-backup.exe',
      serverUrl: 'https://breeze.example.com',
    });
    expect(script.fileName).toBe('run-recovery.ps1');
    const verifyIdx = script.content.indexOf('-V -P');
    const execIdx = script.content.indexOf('& $binary bmr-recover');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(execIdx);
    expect(script.content).toContain('minisign.exe');
    expect(script.content).toContain('/api/v1/backup/bmr/recover/binary-signature');
    expect(script.content).toContain('exit 1');
  });

  it('bash launch script verifies against a public key baked into the bundle at build time, never one the server hands back', async () => {
    const { buildLaunchScript } = await import('./recoveryMediaService');
    const script = buildLaunchScript({
      platform: 'linux',
      architecture: 'amd64',
      fileName: 'breeze-backup',
      serverUrl: 'https://breeze.example.com',
      signingPublicKey: 'RWRUZXN0UHViS2V5MTIzNA==',
    });
    // The key must be a literal baked into the script text, not something
    // parsed out of the /binary-signature response — the response must
    // never be trusted for the key, only the signature.
    expect(script.content).toContain('RWRUZXN0UHViS2V5MTIzNA==');
    expect(script.content).not.toContain('"publicKey"');
    const bakedKeyIdx = script.content.indexOf('RWRUZXN0UHViS2V5MTIzNA==');
    const verifyIdx = script.content.indexOf('minisign -V');
    expect(bakedKeyIdx).toBeGreaterThan(-1);
    expect(bakedKeyIdx).toBeLessThan(verifyIdx);
  });

  it('windows launch script verifies against a public key baked into the bundle at build time, never one the server hands back', async () => {
    const { buildLaunchScript } = await import('./recoveryMediaService');
    const script = buildLaunchScript({
      platform: 'windows',
      architecture: 'amd64',
      fileName: 'breeze-backup.exe',
      serverUrl: 'https://breeze.example.com',
      signingPublicKey: 'RWRUZXN0UHViS2V5MTIzNA==',
    });
    expect(script.content).toContain('RWRUZXN0UHViS2V5MTIzNA==');
    expect(script.content).not.toContain('.publicKey');
    const bakedKeyIdx = script.content.indexOf('RWRUZXN0UHViS2V5MTIzNA==');
    const verifyIdx = script.content.indexOf('-V -P');
    expect(bakedKeyIdx).toBeGreaterThan(-1);
    expect(bakedKeyIdx).toBeLessThan(verifyIdx);
  });

  it('bash launch script fails closed before any network fetch when no signing key was embedded at build time', async () => {
    const { buildLaunchScript } = await import('./recoveryMediaService');
    const script = buildLaunchScript({
      platform: 'linux',
      architecture: 'amd64',
      fileName: 'breeze-backup',
      serverUrl: 'https://breeze.example.com',
      signingPublicKey: null,
    });
    const emptyKeyGuardIdx = script.content.indexOf('EXPECTED_PUBKEY');
    const fetchIdx = script.content.indexOf('/api/v1/backup/bmr/recover/binary-signature');
    expect(emptyKeyGuardIdx).toBeGreaterThan(-1);
    expect(emptyKeyGuardIdx).toBeLessThan(fetchIdx);
    expect(script.content).toContain('exit 1');
  });

  it('bundle README documents the verification step', async () => {
    const { buildBundleReadme } = await import('./recoveryMediaService');
    const readme = buildBundleReadme({
      platform: 'linux',
      architecture: 'amd64',
      serverUrl: 'https://breeze.example.com',
      tokenId: 'token-1',
      snapshotId: 'snapshot-1',
      restoreType: 'bare_metal',
      fileName: 'breeze-backup',
    });
    expect(readme).toMatch(/minisign/i);
    expect(readme).toMatch(/verif/i);
  });
});
