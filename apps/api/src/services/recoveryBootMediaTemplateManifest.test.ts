import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyTemplateDirectory } from './recoveryBootMediaTemplateManifest';

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function computeTemplateDigest(templateDir: string): Promise<string> {
  const files = [
    ['README.txt', await writeAndRead(join(templateDir, 'README.txt'), Buffer.from('boot media template\n'))],
    ['boot/grub/grub.cfg', await writeAndRead(join(templateDir, 'boot', 'grub', 'grub.cfg'), Buffer.from('set timeout=5\n'))],
  ].sort(([left], [right]) => left.localeCompare(right));
  const canonical = files
    .map(([relativePath, checksum]) => `${relativePath}:${checksum}`)
    .join('\n');
  return sha256Hex(Buffer.from(canonical, 'utf8'));
}

async function writeAndRead(filePath: string, contents: Buffer): Promise<string> {
  await writeFile(filePath, contents);
  return sha256Hex(contents);
}

describe('verifyTemplateDirectory', () => {
  const originalEnv = process.env;
  let tempDir: string;
  let templateDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    tempDir = await mkdtemp(join(tmpdir(), 'recovery-template-manifest-'));
    templateDir = join(tempDir, 'template');
    await mkdir(join(templateDir, 'boot', 'grub'), { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('passes when the template directory digest matches the manifest', async () => {
    const manifestPath = join(tempDir, 'template-manifest.json');
    const templateDigest = await computeTemplateDigest(templateDir);
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1',
        templates: [
          {
            templateId: 'linux-iso-template',
            version: '2026.03.31',
            sourceRef: resolve(templateDir),
            sha256: templateDigest,
          },
        ],
      })
    );
    process.env.RECOVERY_BOOT_MEDIA_TEMPLATE_MANIFEST = manifestPath;

    await expect(verifyTemplateDirectory(templateDir)).resolves.toEqual(expect.objectContaining({
      templateId: 'linux-iso-template',
      version: '2026.03.31',
    }));
  });

  it('throws when the template digest does not match the manifest', async () => {
    const manifestPath = join(tempDir, 'template-manifest.json');
    await computeTemplateDigest(templateDir);
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1',
        templates: [
          {
            templateId: 'linux-iso-template',
            version: '2026.03.31',
            sourceRef: resolve(templateDir),
            sha256: sha256Hex(Buffer.from('wrong-template')),
          },
        ],
      })
    );
    process.env.RECOVERY_BOOT_MEDIA_TEMPLATE_MANIFEST = manifestPath;

    await expect(verifyTemplateDirectory(templateDir)).rejects.toThrow(
      /^Recovery boot template checksum mismatch for .*@2026\.03\.31: expected [0-9a-f]{64}, got [0-9a-f]{64}$/
    );
  });

  it('throws when the manifest does not contain the configured template source', async () => {
    const manifestPath = join(tempDir, 'template-manifest.json');
    await computeTemplateDigest(templateDir);
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1',
        templates: [],
      })
    );
    process.env.RECOVERY_BOOT_MEDIA_TEMPLATE_MANIFEST = manifestPath;

    await expect(verifyTemplateDirectory(templateDir)).rejects.toThrow(
      `No recovery boot template manifest entry for ${resolve(templateDir)}`
    );
  });
});
