import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { agentVersions } from "../db/schema";
import { isS3Configured, syncDirectory } from "./s3Storage";
import { getBinarySource } from "./binarySource";
import {
  isReleaseArtifactManifestVerificationConfigured,
  verifyReleaseArtifactManifestAsset,
} from "./releaseArtifactManifest";
import { ensureActiveSigningKey, signManifest } from "./manifestSigning";

const GITHUB_REPO = process.env.GITHUB_REPO || "LanternOps/breeze";

const GH_PLATFORM_MAP: Record<string, string> = {
  linux: "linux",
  darwin: "macos",
  windows: "windows",
};

const AGENT_TARGETS = [
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" },
  { goos: "darwin", goarch: "arm64" },
  { goos: "windows", goarch: "amd64" },
] as const;

const HELPER_TARGETS = [
  { goos: "windows", goarch: "amd64", assetName: "breeze-helper-windows.msi" },
  { goos: "darwin", goarch: "amd64", assetName: "breeze-helper-macos.dmg" },
  { goos: "darwin", goarch: "arm64", assetName: "breeze-helper-macos.dmg" },
  { goos: "linux", goarch: "amd64", assetName: "breeze-helper-linux.AppImage" },
] as const;

// Issue #816: breeze-user-helper is the GUI-subsystem Windows sibling of
// breeze-agent that the sessionbroker spawns into interactive user sessions.
// It's signed by the same Azure Trusted Signing pipeline as the agent and
// shipped as its own GitHub release asset so the agent's in-place auto-upgrade
// (heartbeat.doUpgrade) can fetch it as a separate component. Windows-only.
const USER_HELPER_TARGETS = [
  {
    goos: "windows",
    goarch: "amd64",
    assetName: "breeze-user-helper-windows-amd64.exe",
  },
] as const;

interface BinaryInfo {
  filename: string;
  filePath: string;
  platform: string;
  architecture: string;
  checksum: string;
  fileSize: bigint;
}

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type TrustedReleaseManifest = {
  manifest: string;
  manifestBytes: Buffer;
  signature: string;
  signatureBytes: Buffer;
};

const PLATFORM_MAP: Record<string, string> = {
  linux: "linux",
  darwin: "macos",
  windows: "windows",
};

function parseBinaryFilename(
  filename: string,
): { platform: string; architecture: string } | null {
  // Expected format: breeze-agent-{os}-{arch}[.exe]
  const match = filename.match(
    /^breeze-agent-(linux|darwin|windows)-(amd64|arm64)(\.exe)?$/,
  );
  if (!match) return null;
  const os = match[1]!;
  return {
    platform: PLATFORM_MAP[os] ?? os,
    architecture: match[2]!,
  };
}

async function computeStreamingChecksum(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest("hex");
}

async function fetchReleaseAssetBuffer(
  asset: GitHubReleaseAsset,
  label: string,
): Promise<Buffer> {
  const resp = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "breeze-api" },
  });
  if (!resp.ok) {
    throw new Error(`Failed to download ${label}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function fetchTrustedReleaseManifest(
  assets: GitHubReleaseAsset[],
): Promise<TrustedReleaseManifest | null> {
  const manifestAsset = assets.find(
    (a) => a.name === "release-artifact-manifest.json",
  );
  const signatureAsset = assets.find(
    (a) => a.name === "release-artifact-manifest.json.ed25519",
  );
  const verificationRequired =
    process.env.NODE_ENV === "production" ||
    isReleaseArtifactManifestVerificationConfigured();

  if (!manifestAsset || !signatureAsset) {
    if (verificationRequired) {
      throw new Error(
        "No signed release artifact manifest found in release assets",
      );
    }
    console.warn(
      "[binarySync] Signed release artifact manifest not found; falling back to checksums.txt for non-production compatibility",
    );
    return null;
  }

  if (!isReleaseArtifactManifestVerificationConfigured()) {
    console.warn(
      "[binarySync] Release artifact manifest trust root is not configured; falling back to checksums.txt for non-production compatibility",
    );
    return null;
  }

  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchReleaseAssetBuffer(manifestAsset, "release-artifact-manifest.json"),
    fetchReleaseAssetBuffer(
      signatureAsset,
      "release-artifact-manifest.json.ed25519",
    ),
  ]);

  return {
    manifest: manifestBytes.toString("utf8"),
    manifestBytes,
    signature: signatureBytes.toString("utf8").trim(),
    signatureBytes,
  };
}

async function parseChecksumsFallback(
  assets: GitHubReleaseAsset[],
): Promise<Map<string, string>> {
  const checksumAsset = assets.find((a) => a.name === "checksums.txt");
  if (!checksumAsset) {
    throw new Error("No checksums.txt found in release assets");
  }

  const checksumResp = await fetch(checksumAsset.browser_download_url, {
    headers: { "User-Agent": "breeze-api" },
  });
  if (!checksumResp.ok) {
    throw new Error("Failed to download checksums.txt");
  }
  const checksumText = await checksumResp.text();

  const checksums = new Map<string, string>();
  for (const line of checksumText.split("\n")) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match?.[2] && match[1]) {
      checksums.set(match[2].trim(), match[1]);
    }
  }
  return checksums;
}

async function getReleaseAssetMetadata(args: {
  asset: GitHubReleaseAsset;
  trustedManifest: TrustedReleaseManifest | null;
  fallbackChecksums: Map<string, string> | null;
  releaseTag: string;
}): Promise<{
  checksum: string;
  size: number;
  releaseManifest?: string;
  manifestSignature?: string;
  signingKeyId?: string;
} | null> {
  if (!args.trustedManifest) {
    const checksum = args.fallbackChecksums?.get(args.asset.name);
    if (!checksum) return null;
    return { checksum, size: args.asset.size };
  }

  const verified = await verifyReleaseArtifactManifestAsset({
    assetName: args.asset.name,
    manifestBytes: args.trustedManifest.manifestBytes,
    signatureBytes: args.trustedManifest.signatureBytes,
    expectedRepository: GITHUB_REPO,
    expectedRelease: args.releaseTag,
  });

  if (verified.size !== args.asset.size) {
    throw new Error(
      `Release artifact size mismatch for ${args.asset.name}: GitHub reports ${args.asset.size}, signed manifest reports ${verified.size}`,
    );
  }

  return {
    checksum: verified.sha256,
    size: verified.size,
    releaseManifest: args.trustedManifest.manifest,
    manifestSignature: args.trustedManifest.signature,
    signingKeyId: "release-artifact-manifest-ed25519",
  };
}

async function scanBinaryDir(dir: string): Promise<BinaryInfo[]> {
  const results: BinaryInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[binarySync] Agent binary directory not found: ${dir} (${msg})`,
    );
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
  if (getBinarySource() === "github") {
    console.log(
      "[binarySync] BINARY_SOURCE=github, syncing from GitHub releases",
    );
    await syncFromGitHub();
    // Safety net: syncFromGitHub() with no args hits /releases/latest which
    // EXCLUDES pre-releases, so RC deploys (APP_VERSION=x.y.z-rc.N) would
    // otherwise never land in agent_versions. ensureCurrentVersionRegistered()
    // reads APP_VERSION and explicitly fetches that tag if it's missing.
    // It's idempotent and cheap for non-RC releases (early-returns on hit).
    await ensureCurrentVersionRegistered();
    return;
  }

  const agentBinaryDir = resolve(process.env.AGENT_BINARY_DIR || "./agent/bin");
  const viewerBinaryDir = resolve(
    process.env.VIEWER_BINARY_DIR || "./viewer/bin",
  );
  const versionFile = process.env.BINARY_VERSION_FILE;
  const expectedVersion = process.env.BREEZE_VERSION;

  // Read version from VERSION file if available
  let version = "unknown";
  if (versionFile) {
    try {
      version = (await readFile(versionFile, "utf-8")).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[binarySync] Could not read version file: ${versionFile} (${msg})`,
      );
    }
  } else {
    console.warn(
      '[binarySync] BINARY_VERSION_FILE not set, using "unknown" as version',
    );
  }

  // Detect stale binaries volume: if BREEZE_VERSION is set but doesn't match
  // the VERSION file from the binaries-init container, the volume wasn't refreshed.
  // Fall back to GitHub sync so agents get the correct binary via direct download.
  if (
    expectedVersion &&
    expectedVersion !== "latest" &&
    version !== "unknown" &&
    version !== expectedVersion
  ) {
    console.warn(
      `[binarySync] Stale binaries volume detected: volume has v${version} but BREEZE_VERSION=${expectedVersion}. ` +
        `Falling back to GitHub release sync. To fix, run: docker compose up -d --force-recreate binaries-init`,
    );
    try {
      await syncFromGitHub();
      return;
    } catch (err) {
      // Compound failure — stale binaries volume AND GitHub fallback failed.
      // Agents will be served the wrong binary; surface as error so Sentry
      // and log alerting catch it (#644).
      console.error(
        `[binarySync] Stale binaries volume + GitHub sync FAILED — agents will be served the wrong version: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Scan and register agent binaries in DB
  const binaries = await scanBinaryDir(agentBinaryDir);
  if (binaries.length > 0) {
    const serverUrl =
      process.env.PUBLIC_APP_URL ||
      process.env.BREEZE_SERVER ||
      `http://localhost:${process.env.API_PORT || "3001"}`;

    // Sign every locally-registered manifest so /agent-versions/:v/download
    // returns 200 (the strict-signing check from #568 hard-rejects null
    // manifest fields). Key is generated lazily on first call and reused
    // across the loop. See docs/deploy/agent-update-trust-bootstrap.md.
    const { keyId } = await ensureActiveSigningKey();

    await db.transaction(async (tx) => {
      for (const bin of binaries) {
        const osParam = bin.platform === "macos" ? "darwin" : bin.platform;
        const downloadUrl = `${serverUrl}/api/v1/agents/download/${osParam}/${bin.architecture}`;

        const manifestObj = {
          version,
          component: "agent",
          platform: bin.platform,
          arch: bin.architecture,
          url: downloadUrl,
          checksum: bin.checksum,
          size: Number(bin.fileSize),
        };
        const releaseManifest = JSON.stringify(manifestObj);
        const manifestSignature = await signManifest(releaseManifest);

        // Demote existing "isLatest" entries for this platform/arch
        await tx
          .update(agentVersions)
          .set({ isLatest: false })
          .where(
            and(
              eq(agentVersions.platform, bin.platform),
              eq(agentVersions.architecture, bin.architecture),
              eq(agentVersions.isLatest, true),
            ),
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
            releaseManifest,
            manifestSignature,
            signingKeyId: keyId,
          })
          .onConflictDoUpdate({
            // Match the actual unique constraint
            // (version, platform, architecture, component). `component`
            // defaults to 'agent' in the schema for the local-binary path.
            target: [
              agentVersions.version,
              agentVersions.platform,
              agentVersions.architecture,
              agentVersions.component,
            ],
            set: {
              downloadUrl,
              checksum: bin.checksum,
              fileSize: bin.fileSize,
              isLatest: true,
              releaseManifest,
              manifestSignature,
              signingKeyId: keyId,
            },
          });
      }
    });

    console.log(
      `[binarySync] Registered ${binaries.length} agent binaries (version: ${version})`,
    );
  } else {
    console.log(
      "[binarySync] No local agent binaries found, falling back to GitHub sync",
    );
    await syncFromGitHub();
  }

  // Verify the current version is registered — catches stale volumes and missed syncs.
  // This is the safety net for self-hosted deployments where binaries-init may not refresh.
  await ensureCurrentVersionRegistered();

  // Sync to S3 if configured (runs regardless of whether agent binaries were found)
  if (isS3Configured()) {
    const logSyncResult = (
      label: string,
      result: import("./s3Storage").SyncResult,
    ) => {
      console.log(
        `[binarySync] S3 ${label} sync: ${result.uploaded} uploaded, ${result.skipped} skipped` +
          (result.errors.length > 0 ? `, ${result.errors.length} errors` : ""),
      );
      for (const err of result.errors) {
        console.error(`[binarySync] S3 ${label} sync error: ${err}`);
      }
    };

    const agentSync = await syncDirectory(agentBinaryDir, "agent");
    logSyncResult("agent", agentSync);

    const viewerSync = await syncDirectory(viewerBinaryDir, "viewer");
    logSyncResult("viewer", viewerSync);
  }
}

/**
 * Sync latest release from GitHub Releases API.
 * Called automatically on startup when BINARY_SOURCE=github or when no
 * local binaries are found. Also used by the POST /sync-github route.
 */
export async function syncFromGitHub(
  requestedVersion?: string,
): Promise<{ version: string; synced: string[] }> {
  const ghUrl = requestedVersion
    ? `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${requestedVersion}`
    : `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

  // Authenticate the API call when a token is available. Unauthenticated
  // requests are capped at 60/hour per IP — fine for prod droplets where
  // binarySync runs once at boot, but breaks shared-IP environments like
  // CI runners. Operators behind NAT with multiple deployments may also
  // benefit. Token is opt-in via env; no breaking change for existing
  // deployments. Accepts both GITHUB_TOKEN (used by GitHub Actions) and
  // GH_TOKEN (used by the gh CLI).
  const ghToken =
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const ghHeaders: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "breeze-api",
  };
  if (ghToken) {
    ghHeaders.Authorization = `Bearer ${ghToken}`;
  }

  const ghResp = await fetch(ghUrl, { headers: ghHeaders });
  if (!ghResp.ok) {
    throw new Error(`GitHub API error: ${ghResp.status}`);
  }

  const release = (await ghResp.json()) as {
    tag_name: string;
    body?: string;
    assets: GitHubReleaseAsset[];
  };

  const version = release.tag_name.replace(/^v/, "");
  const trustedManifest = await fetchTrustedReleaseManifest(release.assets);
  const fallbackChecksums = trustedManifest
    ? null
    : await parseChecksumsFallback(release.assets);

  const synced: string[] = [];

  // Sync agent binaries
  for (const target of AGENT_TARGETS) {
    const suffix = target.goos === "windows" ? ".exe" : "";
    const assetName = `breeze-agent-${target.goos}-${target.goarch}${suffix}`;
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) continue;
    const metadata = await getReleaseAssetMetadata({
      asset,
      trustedManifest,
      fallbackChecksums,
      releaseTag: release.tag_name,
    });
    if (!metadata) {
      // `!asset` above is silent (legitimate "release predates this artifact"
      // case). `!metadata` is different: the asset IS in the release but its
      // checksum could not be resolved from the trusted manifest or the
      // fallback checksums file. That's an unexpected manifest/checksums
      // inconsistency the on-call should be told about — don't skip silently.
      console.warn(
        `[binarySync] Missing metadata for agent asset (release=${release.tag_name}, asset=${assetName}, component=agent); skipping`,
      );
      continue;
    }
    const platform = GH_PLATFORM_MAP[target.goos];
    if (!platform) continue;

    try {
      await upsertVersion(
        version,
        platform,
        target.goarch,
        "agent",
        asset.browser_download_url,
        metadata,
        release.body,
      );
      synced.push(`agent:${platform}/${target.goarch}`);
    } catch (err) {
      console.error(
        `[binarySync] Failed to upsert agent version for ${platform}/${target.goarch}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Sync helper binaries
  for (const target of HELPER_TARGETS) {
    const asset = release.assets.find((a) => a.name === target.assetName);
    if (!asset) continue;
    const metadata = await getReleaseAssetMetadata({
      asset,
      trustedManifest,
      fallbackChecksums,
      releaseTag: release.tag_name,
    });
    if (!metadata) {
      // See agent loop above: `!metadata` after `!asset` passed indicates an
      // unexpected manifest/checksums inconsistency, not a missing artifact.
      console.warn(
        `[binarySync] Missing metadata for helper asset (release=${release.tag_name}, asset=${target.assetName}, component=helper); skipping`,
      );
      continue;
    }
    const platform = GH_PLATFORM_MAP[target.goos];
    if (!platform) continue;

    try {
      await upsertVersion(
        version,
        platform,
        target.goarch,
        "helper",
        asset.browser_download_url,
        metadata,
        release.body,
      );
      synced.push(`helper:${platform}/${target.goarch}`);
    } catch (err) {
      console.error(
        `[binarySync] Failed to upsert helper version for ${platform}/${target.goarch}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Sync user-helper binaries (Windows-only; issue #816). Missing for any
  // pre-#816 release — `release.assets.find` returns undefined and the loop
  // body short-circuits. The agent treats a 404 here as non-fatal and falls
  // back to an agent-only upgrade.
  for (const target of USER_HELPER_TARGETS) {
    const asset = release.assets.find((a) => a.name === target.assetName);
    if (!asset) continue;
    const metadata = await getReleaseAssetMetadata({
      asset,
      trustedManifest,
      fallbackChecksums,
      releaseTag: release.tag_name,
    });
    if (!metadata) {
      // See agent loop above: `!metadata` after `!asset` passed indicates an
      // unexpected manifest/checksums inconsistency, not a missing artifact.
      console.warn(
        `[binarySync] Missing metadata for user-helper asset (release=${release.tag_name}, asset=${target.assetName}, component=user-helper); skipping`,
      );
      continue;
    }
    const platform = GH_PLATFORM_MAP[target.goos];
    if (!platform) continue;

    try {
      await upsertVersion(
        version,
        platform,
        target.goarch,
        "user-helper",
        asset.browser_download_url,
        metadata,
        release.body,
      );
      synced.push(`user-helper:${platform}/${target.goarch}`);
    } catch (err) {
      console.error(
        `[binarySync] Failed to upsert user-helper version for ${platform}/${target.goarch}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[binarySync] GitHub sync: registered ${synced.length} binaries (version: ${version})`,
  );
  return { version, synced };
}

/**
 * Safety net: verify the agentVersions table has entries for the current
 * API version. If not, sync from GitHub. This catches stale Docker volumes,
 * missed CI syncs, and fresh deployments where binaries-init didn't run.
 */
async function ensureCurrentVersionRegistered(): Promise<void> {
  const currentVersion = (
    process.env.APP_VERSION ||
    process.env.BREEZE_VERSION ||
    ""
  ).replace(/^v/, "");
  if (
    !currentVersion ||
    currentVersion === "dev" ||
    currentVersion === "latest"
  )
    return;

  try {
    const [existing] = await db
      .select({ version: agentVersions.version })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.version, currentVersion),
          eq(agentVersions.component, "agent"),
        ),
      )
      .limit(1);

    if (existing) return; // Already registered

    console.log(
      `[binarySync] Version ${currentVersion} not found in agentVersions, syncing from GitHub`,
    );
    const result = await syncFromGitHub(`v${currentVersion}`);
    console.log(
      `[binarySync] Auto-synced ${result.synced.length} binaries for v${currentVersion}`,
    );
  } catch (err) {
    // ensureCurrentVersionRegistered is the safety net for the agent_versions
    // table — if it fails, agents trying to download the currently-running
    // version 404. Surface as error so Sentry and log alerting catch it (#644).
    console.error(
      `[binarySync] Failed to auto-sync version ${currentVersion} from GitHub:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// Transaction ensures atomicity: without it, concurrent upserts could leave
// multiple rows with isLatest=true for the same platform/arch/component tuple,
// causing heartbeat queries to return stale versions.
async function upsertVersion(
  version: string,
  platform: string,
  arch: string,
  component: string,
  downloadUrl: string,
  metadata: {
    checksum: string;
    size: number;
    releaseManifest?: string;
    manifestSignature?: string;
    signingKeyId?: string;
  },
  releaseNotes?: string | null,
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
          eq(agentVersions.isLatest, true),
        ),
      );

    await tx
      .insert(agentVersions)
      .values({
        version,
        platform,
        architecture: arch,
        downloadUrl,
        checksum: metadata.checksum,
        releaseManifest: metadata.releaseManifest,
        manifestSignature: metadata.manifestSignature,
        signingKeyId: metadata.signingKeyId,
        fileSize: BigInt(metadata.size),
        releaseNotes: releaseNotes ?? null,
        isLatest: true,
        component,
      })
      .onConflictDoUpdate({
        target: [
          agentVersions.version,
          agentVersions.platform,
          agentVersions.architecture,
          agentVersions.component,
        ],
        set: {
          downloadUrl,
          checksum: metadata.checksum,
          releaseManifest: metadata.releaseManifest,
          manifestSignature: metadata.manifestSignature,
          signingKeyId: metadata.signingKeyId,
          fileSize: BigInt(metadata.size),
          releaseNotes: releaseNotes ?? null,
          isLatest: true,
        },
      });
  });
}
