import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyBinaryChecksum } from './binaryManifest';

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('verifyBinaryChecksum', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    tempDir = await mkdtemp(join(tmpdir(), 'binary-manifest-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('passes when the binary checksum matches the manifest entry', async () => {
    const binaryPath = join(tempDir, 'breeze-backup-linux-amd64');
    const binaryContents = Buffer.from('valid-binary');
    const manifestPath = join(tempDir, 'checksums.json');

    await writeFile(binaryPath, binaryContents);
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1',
        binaries: [
          {
            platform: 'linux',
            architecture: 'amd64',
            sourceType: 'local',
            sourceRef: '/opt/binaries/breeze-backup-linux-amd64',
            version: '1.2.3',
            sha256: sha256Hex(binaryContents),
          },
        ],
      })
    );
    process.env.BINARY_CHECKSUM_MANIFEST = manifestPath;

    await expect(verifyBinaryChecksum({
      filePath: binaryPath,
      platform: 'linux',
      architecture: 'amd64',
      sourceType: 'local',
      sourceRef: '/opt/binaries/breeze-backup-linux-amd64',
      version: '1.2.3',
    })).resolves.toEqual(expect.objectContaining({
      sourceType: 'local',
      sourceRef: '/opt/binaries/breeze-backup-linux-amd64',
      version: '1.2.3',
    }));
  });

  it('throws when the binary checksum does not match the manifest', async () => {
    const binaryPath = join(tempDir, 'breeze-backup-linux-amd64');
    const manifestPath = join(tempDir, 'checksums.json');

    await writeFile(binaryPath, Buffer.from('tampered-binary'));
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1',
        binaries: [
          {
            platform: 'linux',
            architecture: 'amd64',
            sourceType: 'github',
            sourceRef: 'github-release:v1.2.3',
            version: '1.2.3',
            sha256: sha256Hex(Buffer.from('expected-binary')),
          },
        ],
      })
    );
    process.env.BINARY_CHECKSUM_MANIFEST = manifestPath;

    await expect(verifyBinaryChecksum({
      filePath: binaryPath,
      platform: 'linux',
      architecture: 'amd64',
      sourceType: 'github',
      sourceRef: 'github-release:v1.2.3',
      version: '1.2.3',
    })).rejects.toThrow(
      /^github recovery binary checksum mismatch for linux\/amd64 \(github-release:v1\.2\.3@1\.2\.3\): expected [0-9a-f]{64}, got [0-9a-f]{64}$/
    );
  });

  it('throws when no manifest entry matches the source tuple', async () => {
    const binaryPath = join(tempDir, 'breeze-backup-linux-amd64');
    const manifestPath = join(tempDir, 'checksums.json');

    await writeFile(binaryPath, Buffer.from('valid-binary'));
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1',
        binaries: [],
      })
    );
    process.env.BINARY_CHECKSUM_MANIFEST = manifestPath;

    await expect(verifyBinaryChecksum({
      filePath: binaryPath,
      platform: 'linux',
      architecture: 'amd64',
      sourceType: 'local',
      sourceRef: '/opt/binaries/breeze-backup-linux-amd64',
      version: '1.2.3',
    })).rejects.toThrow(
      'No recovery binary manifest entry for linux/amd64 (local:/opt/binaries/breeze-backup-linux-amd64@1.2.3)'
    );
  });
});
