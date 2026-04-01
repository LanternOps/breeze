import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import recoveryBinaryManifest from './recovery-binary-manifest.json';

type BinarySourceType = 'local' | 'github';

type BinaryChecksumManifestEntry = {
  platform: string;
  architecture: string;
  sourceType: BinarySourceType;
  sourceRef: string;
  version: string;
  sha256: string;
};

type BinaryChecksumManifest = {
  version: string;
  binaries: BinaryChecksumManifestEntry[];
};

export type VerifiedRecoveryBinary = {
  platform: string;
  architecture: string;
  sourceType: BinarySourceType;
  sourceRef: string;
  version: string;
  sha256: string;
  manifestVersion: string;
};

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function loadBinaryChecksumManifest(): Promise<BinaryChecksumManifest> {
  const manifestPath = process.env.BINARY_CHECKSUM_MANIFEST?.trim();
  if (!manifestPath) {
    return recoveryBinaryManifest as BinaryChecksumManifest;
  }

  const raw = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<BinaryChecksumManifest>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.binaries)) {
    throw new Error(`Invalid binary checksum manifest at ${manifestPath}`);
  }

  return {
    version: typeof parsed.version === 'string' ? parsed.version : '',
    binaries: parsed.binaries as BinaryChecksumManifestEntry[],
  };
}

export async function verifyBinaryChecksum(args: {
  filePath: string;
  platform: string;
  architecture: string;
  sourceType: BinarySourceType;
  sourceRef: string;
  version: string;
}): Promise<VerifiedRecoveryBinary> {
  const manifest = await loadBinaryChecksumManifest();
  const entry = manifest.binaries.find((candidate) => (
    candidate.platform === args.platform
    && candidate.architecture === args.architecture
    && candidate.sourceType === args.sourceType
    && candidate.sourceRef === args.sourceRef
    && candidate.version === args.version
  ));

  if (!entry) {
    throw new Error(
      `No recovery binary manifest entry for ${args.platform}/${args.architecture} (${args.sourceType}:${args.sourceRef}@${args.version})`
    );
  }

  const actualChecksum = sha256Hex(await readFile(args.filePath));
  if (actualChecksum !== entry.sha256) {
    const mismatchKind = args.sourceType === 'local'
      ? 'local recovery binary checksum mismatch'
      : 'github recovery binary checksum mismatch';
    throw new Error(
      `${mismatchKind} for ${args.platform}/${args.architecture} (${args.sourceRef}@${args.version}): expected ${entry.sha256}, got ${actualChecksum}`
    );
  }

  return {
    platform: entry.platform,
    architecture: entry.architecture,
    sourceType: entry.sourceType,
    sourceRef: entry.sourceRef,
    version: entry.version,
    sha256: actualChecksum,
    manifestVersion: manifest.version,
  };
}
