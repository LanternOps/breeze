import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import recoveryBootTemplateManifest from './recovery-boot-template-manifest.json';

type RecoveryBootTemplateManifestEntry = {
  templateId: string;
  version: string;
  sourceRef: string;
  sha256: string;
};

type RecoveryBootTemplateManifest = {
  version: string;
  templates: RecoveryBootTemplateManifestEntry[];
};

export type VerifiedBootTemplate = {
  templateId: string;
  version: string;
  sourceRef: string;
  sha256: string;
  manifestVersion: string;
};

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function loadTemplateManifest(): Promise<RecoveryBootTemplateManifest> {
  const manifestPath = process.env.RECOVERY_BOOT_MEDIA_TEMPLATE_MANIFEST?.trim();
  if (!manifestPath) {
    return recoveryBootTemplateManifest as RecoveryBootTemplateManifest;
  }

  const raw = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<RecoveryBootTemplateManifest>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.templates)) {
    throw new Error(`Invalid recovery boot media template manifest at ${manifestPath}`);
  }

  return {
    version: typeof parsed.version === 'string' ? parsed.version : '',
    templates: parsed.templates as RecoveryBootTemplateManifestEntry[],
  };
}

async function collectFileEntries(rootDir: string): Promise<Array<{ relativePath: string; checksum: string }>> {
  const entries: Array<{ relativePath: string; checksum: string }> = [];

  async function walk(currentDir: string): Promise<void> {
    const dirEntries = await readdir(currentDir, { withFileTypes: true });
    dirEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of dirEntries) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported boot template entry at ${absolutePath}`);
      }
      const relativePath = relative(rootDir, absolutePath).split(sep).join('/');
      entries.push({
        relativePath,
        checksum: sha256Hex(await readFile(absolutePath)),
      });
    }
  }

  await walk(rootDir);
  return entries;
}

async function computeTemplateDigest(templateDir: string): Promise<string> {
  const entries = await collectFileEntries(templateDir);
  const canonical = entries
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((entry) => `${entry.relativePath}:${entry.checksum}`)
    .join('\n');
  return sha256Hex(Buffer.from(canonical, 'utf8'));
}

export async function verifyTemplateDirectory(templateDir: string): Promise<VerifiedBootTemplate> {
  const manifest = await loadTemplateManifest();
  const sourceRef = process.env.RECOVERY_BOOT_MEDIA_TEMPLATE_REF?.trim() || resolve(templateDir);
  const entry = manifest.templates.find((candidate) => candidate.sourceRef === sourceRef);
  if (!entry) {
    throw new Error(`No recovery boot template manifest entry for ${sourceRef}`);
  }

  const actualChecksum = await computeTemplateDigest(templateDir);
  if (actualChecksum !== entry.sha256) {
    throw new Error(
      `Recovery boot template checksum mismatch for ${sourceRef}@${entry.version}: expected ${entry.sha256}, got ${actualChecksum}`
    );
  }

  return {
    templateId: entry.templateId,
    version: entry.version,
    sourceRef: entry.sourceRef,
    sha256: actualChecksum,
    manifestVersion: manifest.version,
  };
}
