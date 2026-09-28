import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Server-only images carry BREEZE_BINARIES_VERSION (the full release whose
// binaries they pair with). Recovery-media helpers must come from — and be
// labelled with — that release, never the server's own version.

vi.mock('../db', () => ({ db: {}, assertOutsideHeldDbContext: vi.fn() }));
vi.mock('./recoveryBootstrap', () => ({
  asRecord: (v: unknown) => (v && typeof v === 'object' ? v : {}),
  getStringValue: () => null,
  resolveServerUrl: () => 'https://breeze.example.com',
  resolveSnapshotProviderConfig: vi.fn(),
}));
vi.mock('./urlSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./urlSafety')>()),
  safeFetchFollowingRedirects: (url: string) => globalThis.fetch(url),
}));
vi.mock('./recoverySigning', () => ({
  getRecoverySigningKey: () => null,
  isRecoverySigningConfigured: () => false,
  signRecoveryArtifact: vi.fn(),
}));
const checksumMock = vi.hoisted(() => ({
  verifyBinaryChecksum: vi.fn(async (args: Record<string, unknown>) => ({ ...args, sha256: 'x' })),
}));
vi.mock('./binaryManifest', () => checksumMock);
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  copyFile: vi.fn(async () => undefined),
}));

import { resolveBackupBinary } from './recoveryMediaService';

describe('resolveBackupBinary follows the binaries pairing', () => {
  const originalEnv = process.env;
  let workingDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    for (const name of ['BINARY_SOURCE', 'BINARY_GITHUB_REPOSITORY', 'GITHUB_REPO', 'BINARY_VERSION']) {
      delete process.env[name];
    }
    process.env.BREEZE_VERSION = '0.118.2';
    process.env.BREEZE_BINARIES_VERSION = '0.118.0';
    workingDir = await mkdtemp(join(tmpdir(), 'recovery-pairing-'));
    checksumMock.verifyBinaryChecksum.mockClear();
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    await rm(workingDir, { recursive: true, force: true });
  });

  it('github mode: downloads and verifies the helper from the paired release', async () => {
    const bytes = Buffer.from('backup binary bytes');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = der.subarray(der.length - 32).toString('base64');
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: 'LanternOps/breeze',
        release: 'v0.118.0',
        assets: [
          {
            name: 'breeze-backup-linux-amd64',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
            platformTrust: 'release-workflow-produced',
          },
        ],
      }),
    );
    const signature = Buffer.from(sign(null, manifest, privateKey).toString('base64'));
    const fetchSpy = vi.fn(async (url: string) => {
      if (!url.includes('/releases/download/v0.118.0/')) return new Response('wrong release', { status: 404 });
      if (url.endsWith('/breeze-backup-linux-amd64')) return new Response(new Uint8Array(bytes));
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(new Uint8Array(manifest));
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(new Uint8Array(signature));
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await resolveBackupBinary('linux', 'amd64', workingDir);

    expect(result.verified).toMatchObject({
      sourceRef: 'github-release:v0.118.0',
      version: '0.118.0',
      manifestVersion: 'v0.118.0',
    });
    for (const [url] of fetchSpy.mock.calls) expect(String(url)).not.toContain('0.118.2');
  });

  it('local mode: labels the staged helper with the paired release', async () => {
    process.env.BINARY_SOURCE = 'local';
    process.env.AGENT_BINARY_DIR = '/fake/agent/bin';

    await resolveBackupBinary('linux', 'amd64', workingDir);

    expect(checksumMock.verifyBinaryChecksum).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.118.0' }),
    );
  });

  it('local mode, full-release image (pairing empty): unchanged — BREEZE_VERSION', async () => {
    process.env.BINARY_SOURCE = 'local';
    process.env.AGENT_BINARY_DIR = '/fake/agent/bin';
    process.env.BREEZE_BINARIES_VERSION = '';

    await resolveBackupBinary('linux', 'amd64', workingDir);

    expect(checksumMock.verifyBinaryChecksum).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.118.2' }),
    );
  });

  it('local mode: an explicit BINARY_VERSION still wins over the pairing', async () => {
    process.env.BINARY_SOURCE = 'local';
    process.env.AGENT_BINARY_DIR = '/fake/agent/bin';
    process.env.BINARY_VERSION = '0.117.9';

    await resolveBackupBinary('linux', 'amd64', workingDir);

    expect(checksumMock.verifyBinaryChecksum).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.117.9' }),
    );
  });
});
