import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { agentVersions } from '../db/schema';
import { isS3Configured, syncDirectory } from './s3Storage';
import { getBinarySource } from './binarySource';

interface BinaryInfo {
  filename: string;
  filePath: string;
  platform: string;
  architecture: string;
  checksum: string;
  fileSize: bigint;
}

const PLATFORM_MAP: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
  windows: 'windows',
};

function parseBinaryFilename(filename: string): { platform: string; architecture: string } | null {
  // Expected format: breeze-agent-{os}-{arch}[.exe]
  const match = filename.match(/^breeze-agent-(linux|darwin|windows)-(amd64|arm64)(\.exe)?$/);
  if (!match) return null;
  const os = match[1]!;
  return {
    platform: PLATFORM_MAP[os] ?? os,
    architecture: match[2]!,
  };
}

async function computeStreamingChecksum(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest('hex');
}

async function scanBinaryDir(dir: string): Promise<BinaryInfo[]> {
  const results: BinaryInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[binarySync] Agent binary directory not found: ${dir} (${msg})`);
    return results;
  }

  for (const filename of entries) {
    const parsed = parseBinaryFilename(filename);
    if (!parsed) continue;

    const filePath = join(dir, filename);
    try {
      const checksum = await computeStreamingChecksum(filePath);
      const fileStat = await stat(filePath);

      results.push({
        filename,
        filePath,
        platform: parsed.platform,
        architecture: parsed.architecture,
        checksum,
        fileSize: BigInt(fileStat.size),
      });
    } catch (err) {
      console.error(`[binarySync] Failed to read ${filename}:`, err);
    }
  }

  return results;
}

export async function syncBinaries(): Promise<void> {
  if (getBinarySource() === 'github') {
    console.log('[binarySync] BINARY_SOURCE=github, skipping local binary sync');
    return;
  }

  const agentBinaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const viewerBinaryDir = resolve(process.env.VIEWER_BINARY_DIR || './viewer/bin');
  const versionFile = process.env.BINARY_VERSION_FILE;

  // Read version from VERSION file if available
  let version = 'unknown';
  if (versionFile) {
    try {
      version = (await readFile(versionFile, 'utf-8')).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[binarySync] Could not read version file: ${versionFile} (${msg})`);
    }
  } else {
    console.warn('[binarySync] BINARY_VERSION_FILE not set, using "unknown" as version');
  }

  // Scan and register agent binaries in DB
  const binaries = await scanBinaryDir(agentBinaryDir);
  if (binaries.length > 0) {
    const serverUrl =
      process.env.PUBLIC_APP_URL ||
      process.env.BREEZE_SERVER ||
      `http://localhost:${process.env.API_PORT || '3001'}`;

    await db.transaction(async (tx) => {
      for (const bin of binaries) {
        const osParam = bin.platform === 'macos' ? 'darwin' : bin.platform;
        const downloadUrl = `${serverUrl}/api/v1/agents/download/${osParam}/${bin.architecture}`;

        // Demote existing "isLatest" entries for this platform/arch
        await tx
          .update(agentVersions)
          .set({ isLatest: false })
          .where(
            and(
              eq(agentVersions.platform, bin.platform),
              eq(agentVersions.architecture, bin.architecture),
              eq(agentVersions.isLatest, true)
            )
          );

        // Upsert the new version
        await tx
          .insert(agentVersions)
          .values({
            version,
            platform: bin.platform,
            architecture: bin.architecture,
            downloadUrl,
            checksum: bin.checksum,
            fileSize: bin.fileSize,
            isLatest: true,
          })
          .onConflictDoUpdate({
            target: [agentVersions.version, agentVersions.platform, agentVersions.architecture],
            set: {
              downloadUrl,
              checksum: bin.checksum,
              fileSize: bin.fileSize,
              isLatest: true,
            },
          });
      }
    });

    console.log(`[binarySync] Registered ${binaries.length} agent binaries (version: ${version})`);
  } else {
    console.log('[binarySync] No agent binaries found, skipping DB registration');
  }

  // Sync to S3 if configured (runs regardless of whether agent binaries were found)
  if (isS3Configured()) {
    const logSyncResult = (label: string, result: import('./s3Storage').SyncResult) => {
      console.log(
        `[binarySync] S3 ${label} sync: ${result.uploaded} uploaded, ${result.skipped} skipped` +
          (result.errors.length > 0 ? `, ${result.errors.length} errors` : '')
      );
      for (const err of result.errors) {
        console.error(`[binarySync] S3 ${label} sync error: ${err}`);
      }
    };

    const agentSync = await syncDirectory(agentBinaryDir, 'agent');
    logSyncResult('agent', agentSync);

    const viewerSync = await syncDirectory(viewerBinaryDir, 'viewer');
    logSyncResult('viewer', viewerSync);
  }
}
