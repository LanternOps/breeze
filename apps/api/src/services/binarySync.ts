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

const GITHUB_REPO = process.env.GITHUB_REPO || 'LanternOps/breeze';

const GH_PLATFORM_MAP: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
  windows: 'windows'
};

const AGENT_TARGETS = [
  { goos: 'linux', goarch: 'amd64' },
  { goos: 'darwin', goarch: 'amd64' },
  { goos: 'darwin', goarch: 'arm64' },
  { goos: 'windows', goarch: 'amd64' }
] as const;

const HELPER_TARGETS = [
  { goos: 'windows', goarch: 'amd64', assetName: 'breeze-helper-windows.msi' },
  { goos: 'darwin', goarch: 'amd64', assetName: 'breeze-helper-macos.dmg' },
  { goos: 'darwin', goarch: 'arm64', assetName: 'breeze-helper-macos.dmg' },
  { goos: 'linux', goarch: 'amd64', assetName: 'breeze-helper-linux.AppImage' },
] as const;

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
    console.log('[binarySync] BINARY_SOURCE=github, syncing from GitHub releases');
    await syncFromGitHub();
    // Safety net: syncFromGitHub() with no args hits /releases/latest which
    // EXCLUDES pre-releases, so RC deploys (APP_VERSION=x.y.z-rc.N) would
    // otherwise never land in agent_versions. ensureCurrentVersionRegistered()
    // reads APP_VERSION and explicitly fetches that tag if it's missing.
    // It's idempotent and cheap for non-RC releases (early-returns on hit).
    await ensureCurrentVersionRegistered();
    return;
  }

  const agentBinaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const viewerBinaryDir = resolve(process.env.VIEWER_BINARY_DIR || './viewer/bin');
  const versionFile = process.env.BINARY_VERSION_FILE;
  const expectedVersion = process.env.BREEZE_VERSION;

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

  // Detect stale binaries volume: if BREEZE_VERSION is set but doesn't match
  // the VERSION file from the binaries-init container, the volume wasn't refreshed.
  // Fall back to GitHub sync so agents get the correct binary via direct download.
  if (expectedVersion && expectedVersion !== 'latest' && version !== 'unknown' && version !== expectedVersion) {
    console.warn(
      `[binarySync] Stale binaries volume detected: volume has v${version} but BREEZE_VERSION=${expectedVersion}. ` +
      `Falling back to GitHub release sync. To fix, run: docker compose up -d --force-recreate binaries-init`
    );
    try {
      await syncFromGitHub();
      return;
    } catch (err) {
      console.warn(`[binarySync] GitHub sync failed, continuing with local binaries: ${err instanceof Error ? err.message : err}`);
    }
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
    console.log('[binarySync] No local agent binaries found, falling back to GitHub sync');
    await syncFromGitHub();
  }

  // Verify the current version is registered — catches stale volumes and missed syncs.
  // This is the safety net for self-hosted deployments where binaries-init may not refresh.
  await ensureCurrentVersionRegistered();

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

/**
 * Sync latest release from GitHub Releases API.
 * Called automatically on startup when BINARY_SOURCE=github or when no
 * local binaries are found. Also used by the POST /sync-github route.
 */
export async function syncFromGitHub(requestedVersion?: string): Promise<{ version: string; synced: string[] }> {
  const ghUrl = requestedVersion
    ? `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${requestedVersion}`
    : `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

  const ghResp = await fetch(ghUrl, {
    headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'breeze-api' }
  });
  if (!ghResp.ok) {
    throw new Error(`GitHub API error: ${ghResp.status}`);
  }

  const release = (await ghResp.json()) as {
    tag_name: string;
    body?: string;
    assets: Array<{ name: string; browser_download_url: string; size: number }>;
  };

  const version = release.tag_name.replace(/^v/, '');

  const checksumAsset = release.assets.find((a) => a.name === 'checksums.txt');
  if (!checksumAsset) {
    throw new Error('No checksums.txt found in release assets');
  }

  const checksumResp = await fetch(checksumAsset.browser_download_url, {
    headers: { 'User-Agent': 'breeze-api' }
  });
  if (!checksumResp.ok) {
    throw new Error('Failed to download checksums.txt');
  }
  const checksumText = await checksumResp.text();

  const checksums = new Map<string, string>();
  for (const line of checksumText.split('\n')) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match?.[2] && match[1]) {
      checksums.set(match[2].trim(), match[1]);
    }
  }

  const synced: string[] = [];

  // Sync agent binaries
  for (const target of AGENT_TARGETS) {
    const suffix = target.goos === 'windows' ? '.exe' : '';
    const assetName = `breeze-agent-${target.goos}-${target.goarch}${suffix}`;
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) continue;
    const checksum = checksums.get(assetName);
    if (!checksum) continue;
    const platform = GH_PLATFORM_MAP[target.goos];
    if (!platform) continue;

    try {
      await upsertVersion(version, platform, target.goarch, 'agent', asset.browser_download_url, checksum, asset.size, release.body);
      synced.push(`agent:${platform}/${target.goarch}`);
    } catch (err) {
      console.error(`[binarySync] Failed to upsert agent version for ${platform}/${target.goarch}:`, err instanceof Error ? err.message : err);
    }
  }

  // Sync helper binaries
  for (const target of HELPER_TARGETS) {
    const asset = release.assets.find((a) => a.name === target.assetName);
    if (!asset) continue;
    const checksum = checksums.get(target.assetName);
    if (!checksum) continue;
    const platform = GH_PLATFORM_MAP[target.goos];
    if (!platform) continue;

    try {
      await upsertVersion(version, platform, target.goarch, 'helper', asset.browser_download_url, checksum, asset.size, release.body);
      synced.push(`helper:${platform}/${target.goarch}`);
    } catch (err) {
      console.error(`[binarySync] Failed to upsert helper version for ${platform}/${target.goarch}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[binarySync] GitHub sync: registered ${synced.length} binaries (version: ${version})`);
  return { version, synced };
}

/**
 * Safety net: verify the agentVersions table has entries for the current
 * API version. If not, sync from GitHub. This catches stale Docker volumes,
 * missed CI syncs, and fresh deployments where binaries-init didn't run.
 */
async function ensureCurrentVersionRegistered(): Promise<void> {
  const currentVersion = (process.env.APP_VERSION || process.env.BREEZE_VERSION || '').replace(/^v/, '');
  if (!currentVersion || currentVersion === 'dev' || currentVersion === 'latest') return;

  try {
    const [existing] = await db
      .select({ version: agentVersions.version })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.version, currentVersion),
          eq(agentVersions.component, 'agent')
        )
      )
      .limit(1);

    if (existing) return; // Already registered

    console.log(`[binarySync] Version ${currentVersion} not found in agentVersions, syncing from GitHub`);
    const result = await syncFromGitHub(`v${currentVersion}`);
    console.log(`[binarySync] Auto-synced ${result.synced.length} binaries for v${currentVersion}`);
  } catch (err) {
    console.warn(`[binarySync] Failed to auto-sync version ${currentVersion} from GitHub:`, err instanceof Error ? err.message : err);
  }
}

// Transaction ensures atomicity: without it, concurrent upserts could leave
// multiple rows with isLatest=true for the same platform/arch/component tuple,
// causing heartbeat queries to return stale versions.
async function upsertVersion(
  version: string, platform: string, arch: string, component: string,
  downloadUrl: string, checksum: string, size: number, releaseNotes?: string | null
) {
  await db.transaction(async (tx) => {
    await tx
      .update(agentVersions)
      .set({ isLatest: false })
      .where(
        and(
          eq(agentVersions.platform, platform),
          eq(agentVersions.architecture, arch),
          eq(agentVersions.component, component),
          eq(agentVersions.isLatest, true)
        )
      );

    await tx
      .insert(agentVersions)
      .values({
        version, platform, architecture: arch, downloadUrl, checksum,
        fileSize: BigInt(size), releaseNotes: releaseNotes ?? null,
        isLatest: true, component
      })
      .onConflictDoUpdate({
        target: [agentVersions.version, agentVersions.platform, agentVersions.architecture, agentVersions.component],
        set: { downloadUrl, checksum, fileSize: BigInt(size), releaseNotes: releaseNotes ?? null, isLatest: true }
      });
  });
}
