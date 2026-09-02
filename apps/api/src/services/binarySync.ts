import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db";
import { agentVersions } from "../db/schema";
import { isS3Configured, syncDirectory } from "./s3Storage";
import {
  getBinarySource,
  getAgentAutoPromote,
  getGithubReleaseVersion,
} from "./binarySource";
import { getBinaryEdition } from "./binaryEdition";
import {
  MAX_MANIFEST_BYTES,
  isReleaseArtifactManifestVerificationConfigured,
  ReleaseAssetNotDistributableError,
  ReleaseManifestAssetAbsentError,
  ReleaseManifestAssetLookupError,
  ReleaseManifestSignatureError,
  verifyReleaseArtifactManifestAsset,
  verifyReleaseArtifactManifestIntegrity,
} from "./releaseArtifactManifest";
import { EDITION_SELF_HOST, assertGithubFetchableEdition } from "./releaseAssetTrust";
import { ensureActiveSigningKey, signManifest } from "./manifestSigning";
import {
  getReleaseSourceApiBase,
  getReleaseSourceRepository,
  isOfficialReleaseSource,
} from "./releaseSource";
import { captureException } from "./sentry";
import {
  ResponseTooLargeError,
  SsrfBlockedError,
  safeFetchFollowingRedirects,
} from "./urlSafety";

// Byte ceilings for every outbound response this module buffers (#4262).
//
// The bare `fetch` these replaced had NO ceiling at all: whatever the remote
// sent was buffered whole. `safeFetch`'s `maxBytes` is a STREAMING ceiling —
// the socket is destroyed on overrun and ResponseTooLargeError is thrown, so a
// truncated body is never handed onward to signature verification.
//
// Sized to be unreachable by any legitimate response rather than tight: this
// runs on the boot path, and a ceiling that a real release could trip would
// turn a security control into an availability bug.

/**
 * The manifest + signature ceiling. IMPORTED rather than redeclared: this module
 * fetches the same two artifacts as releaseArtifactManifest.ts, and a local copy
 * would let the two paths silently drift to different limits for one file.
 */
const MAX_RELEASE_MANIFEST_BYTES = MAX_MANIFEST_BYTES;
/** checksums.txt is one ~100-byte line per asset. */
const MAX_CHECKSUMS_BYTES = 1024 * 1024;
/** A GitHub release JSON: asset list + release notes (GitHub caps body ~125KB). */
const MAX_RELEASE_API_JSON_BYTES = 8 * 1024 * 1024;

// `safeFetch` applies NO timeout unless asked (urlSafety.ts: `if (timeoutMs &&
// timeoutMs > 0)`), and the bare `fetch` these replaced had none either. That
// matters more here than at most call sites: every one of these runs inside a
// held DB access context (see the note on assertOutsideHeldDbContext below), so
// a hung socket to GitHub pins a pooled Postgres connection idle-in-transaction
// for as long as it hangs. A ceiling on bytes without a ceiling on time only
// closes half of that.
const RELEASE_FETCH_TIMEOUT_MS = 30_000;

// #1105 tripwire — READ BEFORE ENABLING DB_CONTEXT_TRIPWIRE_STRICT.
//
// `safeFetch` calls `assertOutsideHeldDbContext`. All four call sites in this
// module run INSIDE a held DB access context:
//   - boot: index.ts wraps syncBinaries() in runWithSystemDbAccess
//     → withSystemDbAccessContext → withDbAccessContext (a real transaction);
//   - route: POST /agent-versions/sync-github takes the withDbAccessContext
//     branch in middleware/auth.ts and is NOT in SELF_MANAGED_DB_CONTEXT_ROUTES.
//
// This is PRE-EXISTING: the bare `fetch` these replaced did the identical
// round-trip inside the identical transaction. The tripwire only ever
// instrumented safeFetch, so adopting the guard made an existing problem
// VISIBLE rather than creating one. Today that is a console.warn plus a deduped
// Sentry event; DB_CONTEXT_TRIPWIRE_STRICT is set by no CI job.
//
// The latent hazard, stated so the next person is warned rather than surprised:
// under that strict flag `assertOutsideHeldDbContext` THROWS, syncBinaries
// throws, and index.ts treats that as fatal in BINARY_SOURCE=local mode — the
// API refuses to boot. Before this module adopted safeFetch, flipping the flag
// was safe here.
//
// Do NOT "fix" this by wrapping these fetches in runOutsideDbContext: that exits
// the AsyncLocalStorage store without releasing the pooled connection, silencing
// the alarm while leaving the connection pinned idle-in-transaction across the
// network round-trip. The real fix is to run the network phase before the system
// context opens and let this module open its own short contexts around only its
// DB writes — a boot-critical restructure that belongs in its own PR (#4262).

/**
 * Render an outbound-fetch failure for an operator.
 *
 * `SsrfBlockedError.message` names the refused HOST but not what it resolved
 * to: the DNS cases read `all resolved IPs for <host> are private/loopback/…`,
 * and the address list itself lives only on `.resolvedIps`. So a plain
 * `err.message` rendering tells an operator the guard fired while withholding
 * the fact they need to act on it.
 *
 * Worth distinguishing from "GitHub returned 503" for a second reason: on this
 * path a refusal means something resolved `api.github.com` or
 * `objects.githubusercontent.com` to an internal address, which is a
 * DNS-hijack/poisoned-resolver signal rather than a routine network fault.
 */
function describeFetchFailure(err: unknown): string {
  if (err instanceof SsrfBlockedError) {
    return (
      `BLOCKED BY SSRF GUARD: ${err.message} ` +
      `(host=${err.hostname ?? "?"}, resolved=${err.resolvedIps?.join(", ") ?? "n/a"}). ` +
      `The release host resolved to a private, loopback or link-local address — check DNS and egress on this host.`
    );
  }
  if (err instanceof ResponseTooLargeError) {
    return `release host returned a body over the ${err.maxBytes}-byte ceiling`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Call-site literals for the `release_sync_context` tag — closed set. */
type ReleaseSyncContext =
  | "stale-volume-fallback"
  | "no-local-binaries-fallback"
  | "ensure-current-version-registered";

/**
 * Report a guard refusal to Sentry.
 *
 * The three catch sites below deliberately DO NOT fail closed — a transient
 * resolver blip must not take boot down — so without this a refusal would be a
 * console line and nothing else. There is no console→Sentry integration in
 * `services/sentry.ts`, so `console.error` alone does not reach alerting; the
 * pre-existing comments claiming otherwise were wrong and are corrected below.
 *
 * The tags are the whole payload, not decoration: `scrubEvent` deletes
 * `message` from every outbound event, so an event whose discriminator is not
 * an ALLOWLISTED tag does not exist as far as triage is concerned. Both names
 * here are registered in `ALLOWED_TAG_NAMES` (services/sentry.ts) and asserted
 * end-to-end through both gates in `sentry.test.ts`. Values are derived from
 * the error CLASS and a hardcoded literal — never from the message, which
 * interpolates the refused hostname.
 */
function reportIfGuardRefusal(err: unknown, context: ReleaseSyncContext): void {
  const reason = err instanceof SsrfBlockedError
    ? "ssrf-blocked"
    : err instanceof ResponseTooLargeError
      ? "response-too-large"
      : null;
  if (!reason) return;
  captureException(err, undefined, {
    release_sync_failure_reason: reason,
    release_sync_context: context,
  });
}

const GH_PLATFORM_MAP: Record<string, string> = {
  linux: "linux",
  darwin: "macos",
  windows: "windows",
};

// BINARY_EDITION=hosted fail-closed (BYO signing edition follow-up): a
// hosted deployment must never silently fall back to the public GitHub
// release when its local binaries volume is missing or stale — that release
// now carries the self-host edition, which is not what a hosted deployment
// is supposed to serve. Throwing here is deliberate: syncBinaries()'s only
// caller (index.ts startup) treats a thrown error as fatal when
// BINARY_SOURCE=local, so this turns a would-be silent substitution into a
// boot failure an operator has to notice and fix.
function assertLocalGithubFallbackAllowed(context: string): void {
  if (getBinaryEdition() === "hosted") {
    throw new Error(
      `[binarySync] BINARY_EDITION=hosted refuses to fall back to the public GitHub release (${context}). Fix the local binaries volume instead.`,
    );
  }
}

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

// breeze-watchdog is the supervisor sibling of breeze-agent, shipped as its own
// per-arch GitHub release asset on every platform. It was historically only
// placed by the full installer, so once an agent auto-upgraded its watchdog
// stayed frozen at install-time version (the agent's in-place upgrade never
// touched it, and the watchdog component was never registered here). Registering
// it lets the server drive watchdog upgrades (heartbeat.ts watchdogUpgradeTo)
// and lets the agent's handleWatchdogUpgrade self-heal fetch the matching binary.
// Same asset-name shape as the agent: breeze-watchdog-{goos}-{goarch}[.exe].
const WATCHDOG_TARGETS = AGENT_TARGETS;

// breeze-backup is the standalone backup-job runner sibling of breeze-agent,
// built+signed+published per-arch on every platform the agent itself targets
// (same AGENT_TARGETS matrix). It ships as its own release asset
// (breeze-backup-{goos}-{goarch}[.exe]) so the install.sh flow and the local
// (BINARY_SOURCE=local) binary scan can fetch/register it independently of the
// agent binary — mirrors WATCHDOG_TARGETS exactly.
const BACKUP_TARGETS = AGENT_TARGETS;

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
  component = "agent",
): { platform: string; architecture: string } | null {
  // Expected format: breeze-{component}-{os}-{arch}[.exe]
  const match = filename.match(
    new RegExp(
      `^breeze-${component}-(linux|darwin|windows)-(amd64|arm64)(\\.exe)?$`,
    ),
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
  // `browser_download_url` comes from the GitHub API response, not from local
  // config, and github.com 302s release assets to objects.githubusercontent.com
  // — so following redirects is mandatory here, and following them NAIVELY is
  // the SSRF bypass #3649 was filed about. The guarded helper re-resolves,
  // filters and IP-pins every hop before it is dialed, so a redirect into
  // loopback / 169.254.169.254 / RFC1918 is refused rather than followed.
  //
  // This function fetches only release-artifact-manifest.json and its .ed25519
  // signature — the inputs to release artifact verification — so the ceiling is
  // the manifest one.
  const resp = await safeFetchFollowingRedirects(asset.browser_download_url, {
    headers: { "User-Agent": "breeze-api" },
    maxBytes: MAX_RELEASE_MANIFEST_BYTES,
    timeoutMs: RELEASE_FETCH_TIMEOUT_MS,
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

  // Same asset-URL redirect chain as fetchReleaseAssetBuffer, and this is the
  // integrity fallback when no signed manifest is present — so it is the LAST
  // thing that should be reachable by an unvalidated redirect.
  const checksumResp = await safeFetchFollowingRedirects(
    checksumAsset.browser_download_url,
    {
      headers: { "User-Agent": "breeze-api" },
      maxBytes: MAX_CHECKSUMS_BYTES,
      timeoutMs: RELEASE_FETCH_TIMEOUT_MS,
    },
  );
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
  edition: string;
} | null> {
  if (!args.trustedManifest) {
    const checksum = args.fallbackChecksums?.get(args.asset.name);
    if (!checksum) return null;
    // Legacy checksums.txt fallback (non-production only) predates the
    // edition field entirely — same default as an unset manifest field.
    return { checksum, size: args.asset.size, edition: EDITION_SELF_HOST };
  }

  const verified = await verifyReleaseArtifactManifestAsset({
    assetName: args.asset.name,
    manifestBytes: args.trustedManifest.manifestBytes,
    signatureBytes: args.trustedManifest.signatureBytes,
    expectedRepository: getReleaseSourceRepository(),
    expectedRelease: args.releaseTag,
  });

  // Defense in depth: this whole function only runs inside the GitHub sync
  // flow, so an asset labeled edition "hosted" here would mean a hosted
  // artifact somehow ended up in a public release manifest — refuse it
  // outright rather than register it.
  assertGithubFetchableEdition({ assetName: args.asset.name, edition: verified.edition });

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
    edition: verified.edition ?? EDITION_SELF_HOST,
  };
}

async function scanBinaryDir(
  dir: string,
  component = "agent",
): Promise<BinaryInfo[]> {
  const results: BinaryInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[binarySync] ${component} binary directory not found: ${dir} (${msg})`,
    );
    return results;
  }

  for (const filename of entries) {
    const parsed = parseBinaryFilename(filename, component);
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

// Registers a set of locally-scanned binaries for one component (agent,
// watchdog, …) in agent_versions, signing each manifest so
// /agent-versions/:v/download returns 200 (the strict-signing check from #568
// rejects null manifest fields). The demote is scoped to `component` so
// registering a second component (e.g. watchdog, #1802) does NOT clear the
// agent's isLatest for the same platform/arch — the GitHub path's upsertVersion
// already scopes this way; the local path historically did not because agent was
// the only locally-registered component.
async function registerLocalBinaries(args: {
  binaries: BinaryInfo[];
  component: string;
  version: string;
  keyId: string;
  downloadUrlFor: (osParam: string, arch: string) => string;
}): Promise<void> {
  const { binaries, component, version, keyId, downloadUrlFor } = args;

  // Controlled fleet rollout (AGENT_AUTO_PROMOTE=false): register the binary
  // but never promote it to the fleet upgrade target. Skip the demote UPDATE,
  // insert with isLatest:false, and OMIT isLatest from the conflict `set` so
  // re-registering an already-promoted version never demotes it. When
  // auto-promote is on (default) behavior is byte-for-byte unchanged. Mirrors
  // the GitHub-source path (upsertVersion) so both registration paths behave
  // identically regardless of component.
  const autoPromote = getAgentAutoPromote();
  // A locally-scanned binary carries no per-asset edition claim of its own
  // (unlike a manifest-covered asset — see registerFromOfficialManifest
  // below), so it's stamped with this SERVER's own configured edition.
  const edition = getBinaryEdition();

  await db.transaction(async (tx) => {
    for (const bin of binaries) {
      const osParam = bin.platform === "macos" ? "darwin" : bin.platform;
      const downloadUrl = downloadUrlFor(osParam, bin.architecture);

      const manifestObj = {
        version,
        component,
        platform: bin.platform,
        arch: bin.architecture,
        url: downloadUrl,
        checksum: bin.checksum,
        size: Number(bin.fileSize),
      };
      const releaseManifest = JSON.stringify(manifestObj);
      const manifestSignature = await signManifest(releaseManifest);

      // Demote existing "isLatest" entries for this platform/arch/component/edition.
      if (autoPromote) {
        await tx
          .update(agentVersions)
          .set({ isLatest: false })
          .where(
            and(
              eq(agentVersions.platform, bin.platform),
              eq(agentVersions.architecture, bin.architecture),
              eq(agentVersions.component, component),
              eq(agentVersions.edition, edition),
              eq(agentVersions.isLatest, true),
            ),
          );
      }

      // Upsert the new version
      await tx
        .insert(agentVersions)
        .values({
          version,
          component,
          platform: bin.platform,
          architecture: bin.architecture,
          downloadUrl,
          checksum: bin.checksum,
          fileSize: bin.fileSize,
          isLatest: autoPromote,
          releaseManifest,
          manifestSignature,
          signingKeyId: keyId,
          edition,
        })
        .onConflictDoUpdate({
          // Match the actual unique constraint
          // (version, platform, architecture, component, edition).
          target: [
            agentVersions.version,
            agentVersions.platform,
            agentVersions.architecture,
            agentVersions.component,
            agentVersions.edition,
          ],
          set: {
            downloadUrl,
            checksum: bin.checksum,
            fileSize: bin.fileSize,
            releaseManifest,
            manifestSignature,
            signingKeyId: keyId,
            ...(autoPromote ? { isLatest: true } : {}),
          },
        });
    }
  });
}

// Official-manifest local registration (BYO signing edition follow-up).
//
// AGENT_BINARY_DIR (e.g. /data/binaries/agent) is a subdirectory of the
// binaries volume root (e.g. /data/binaries — see VIEWER_BINARY_DIR and
// HELPER_BINARY_DIR, siblings under the same root in docker-compose.yml). If
// an operator has staged an official release-artifact-manifest.json +
// release-artifact-manifest.json.ed25519 pair at that root (e.g. by copying
// them alongside the binaries during their own image build or volume seed),
// registering FROM that manifest — instead of re-signing a fresh
// per-deployment manifest — lets self-host agents verify updates against the
// well-known release key embedded in the agent binary, with zero
// per-deployment key distribution required.
function officialManifestPairPaths(agentBinaryDir: string): {
  manifestPath: string;
  signaturePath: string;
} {
  const root = dirname(resolve(agentBinaryDir));
  return {
    manifestPath: join(root, "release-artifact-manifest.json"),
    signaturePath: join(root, "release-artifact-manifest.json.ed25519"),
  };
}

async function loadOfficialLocalManifestPair(
  agentBinaryDir: string,
): Promise<{ manifestBytes: Buffer; signatureBytes: Buffer } | null> {
  const { manifestPath, signaturePath } = officialManifestPairPaths(agentBinaryDir);
  try {
    const [manifestBytes, signatureBytes] = await Promise.all([
      readFile(manifestPath),
      readFile(signaturePath),
    ]);
    return { manifestBytes, signatureBytes };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Per-(component, assetName) dedup for the "policy-refused / mismatched
// manifest asset" report below (D4, #3836). syncBinaries() only runs at boot
// (index.ts), so in practice this fires at most once per process per asset —
// but it exists for the same reason warnedMissingPinBuilds
// (routes/agents/helpers.ts) does: a persistent misconfig (e.g. today's
// unsigned hosted darwin artifacts, see below) must not flood Sentry on
// every future call site that resyncs.
const warnedRefusedManifestAssets = new Set<string>();

/** Test-only: reset the per-asset refusal dedup between cases. */
export function __resetRefusedManifestAssetWarnCache(): void {
  warnedRefusedManifestAssets.clear();
}

// verifyReleaseArtifactManifestAsset's ReleaseManifestAssetLookupError covers
// two very different shapes: the asset name isn't in the manifest's `assets`
// array at all (the legitimate local/BYO case — this component simply isn't
// covered by the staged official manifest), and the asset name IS present but
// its entry is malformed (invalid/missing sha256 or size) or the manifest
// fails a repository/release identity check. Only the former is "absent";
// the latter is a manifest that affirmatively claims to cover this asset
// with garbage or mismatched metadata, which must fail closed exactly like a
// distributability-policy refusal.
//
// This checks the typed ReleaseManifestAssetAbsentError subclass — thrown
// ONLY at selectManifestAsset's "not found in assets" site
// (releaseArtifactManifest.ts) — not `.message` text. A substring match on
// the message was tried first and rejected in review: `.message` is not a
// contract, so any OTHER lookup-error message coincidentally gaining a
// matching substring would misclassify a present-but-malformed entry as
// absent and let it through the ungated fallback — the exact fail-open
// direction this task closes (D4, #3836, fix round 1).
function isAssetAbsentFromManifest(err: unknown): boolean {
  return err instanceof ReleaseManifestAssetAbsentError;
}

// BREEZE-1Z: the descriptive message below is DELETED by `scrubEvent` before
// the event leaves the process, so the production issue could not say which
// component, which asset, or why — and the INTENDED refusal (today's unsigned
// darwin artifacts, see the NOTE on registerFromOfficialManifest) was
// therefore indistinguishable from a genuine trust regression. These three
// tags are the whole triage surface, so all three are bounded on purpose.
//
// The reason is a CLASS-derived classification, never `err.message`: the
// underlying messages interpolate the offending platformTrust/edition/sha256
// values, which is unbounded and would make the tag useless for grouping. The
// mapping keys off the typed error classes for the same reason
// `isAssetAbsentFromManifest` does — `.message` text is not a contract.
export type ManifestRefusalReason =
  | "checksum-mismatch"
  | "not-distributable"
  | "manifest-entry-invalid"
  | "manifest-signature-invalid"
  | "unclassified";

export function classifyManifestRefusal(err: unknown): ManifestRefusalReason {
  if (err instanceof ReleaseAssetNotDistributableError) return "not-distributable";
  // Checked after the absent subclass is already handled by the caller, so any
  // lookup error reaching here means "present in the manifest but malformed,
  // or an identity mismatch".
  if (err instanceof ReleaseManifestAssetLookupError) return "manifest-entry-invalid";
  if (err instanceof ReleaseManifestSignatureError) return "manifest-signature-invalid";
  return "unclassified";
}

// Reports (console.error + deduped captureException) a manifest asset that
// was PRESENT but refused, or whose local file disagrees with the manifest's
// claim for it — the two "fail closed" branches of registerFromOfficialManifest
// below. Never called for the "genuinely absent from the manifest" branch,
// which is the legitimate local/BYO case and keeps its own (non-Sentry)
// console.warn.
function reportRefusedManifestAsset(
  component: string,
  assetName: string,
  err: unknown,
  // Explicit at the checksum call site, which passes a plain string rather
  // than a typed error and so cannot be classified from the value alone.
  reason: ManifestRefusalReason = classifyManifestRefusal(err),
): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    `[binarySync] Refusing to register ${component} asset ${assetName} from the official release manifest — fail closed, excluded from the per-deployment fallback too: ${detail}`,
  );
  const key = `${component}:${assetName}`;
  if (warnedRefusedManifestAssets.has(key)) return;
  warnedRefusedManifestAssets.add(key);
  captureException(
    new Error(
      `[binarySync] Official-manifest asset registration refused (D4, #3836): ${component} asset ${assetName} is present in the manifest but was rejected — ${detail}. Excluded from BOTH the official-manifest path and the per-deployment re-sign fallback (fail closed): registerLocalBinaries has no distributability gate, so falling back would silently serve the very artifact the manifest (or its checksum) refused.`,
    ),
    undefined,
    {
      binary_component: component,
      release_asset_name: assetName,
      manifest_refusal_reason: reason,
    },
  );
}

// Registers whichever of `binaries` the official manifest actually covers
// (matched by on-disk filename == manifest asset name), verifying each
// asset's checksum against the LOCAL file before trusting the manifest's
// claim for it.
//
// Three outcomes per binary:
//   - genuinely ABSENT from the manifest (no entry for this filename at all)
//     → left unregistered here; the caller falls back to registerLocalBinaries
//     (deploy-key re-sign). This is the legitimate local/BYO case: a
//     self-hoster's staged official manifest simply doesn't claim to cover
//     this component/asset.
//   - PRESENT but refused (assertDistributableReleaseAsset's policy checks,
//     unknown platformTrust/edition vocabulary, or a malformed sha256/size
//     entry) or PRESENT with a checksum that disagrees with the local file
//     → FAIL CLOSED: not registered here AND excluded from the
//     registerLocalBinaries fallback (see excludedFilenames below). A
//     policy-refused or mismatched artifact must never be served through the
//     weaker per-deployment-resign path, which has no distributability gate
//     at all — this is exactly how unsigned darwin binaries (manifest-labeled
//     release-workflow-produced, refused because darwin Mach-Os require
//     macos-developer-id-notarization-required) shipped to production macOS
//     devices with the trust policy silently bypassed (D4, #3836).
//
// NOTE: with this fail-closed behavior and TODAY's (unsigned) hosted darwin
// release artifacts, a fresh local sync registers NO macOS agent rows — every
// darwin binary hits the "present but refused" branch above. That is the
// INTENDED outcome, not a bug: macOS serving resumes once D2 (signed darwin
// artifacts + manifest coverage) ships a manifest that actually labels them
// macos-developer-id-notarization-required.
async function registerFromOfficialManifest(args: {
  binaries: BinaryInfo[];
  component: string;
  version: string;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  downloadUrlFor: (osParam: string, arch: string) => string;
}): Promise<{ registeredFilenames: Set<string>; excludedFilenames: Set<string> }> {
  const { binaries, component, version, manifestBytes, signatureBytes, downloadUrlFor } = args;
  const autoPromote = getAgentAutoPromote();
  const manifestString = manifestBytes.toString("utf8");
  const signatureString = signatureBytes.toString("utf8").trim();
  const registeredFilenames = new Set<string>();
  // Present-but-refused or checksum-mismatched assets (D4, #3836) — the
  // caller must exclude these from the registerLocalBinaries fallback too,
  // not just skip them here.
  const excludedFilenames = new Set<string>();

  await db.transaction(async (tx) => {
    for (const bin of binaries) {
      let verified;
      try {
        verified = await verifyReleaseArtifactManifestAsset({
          assetName: bin.filename,
          manifestBytes,
          signatureBytes,
        });
      } catch (err) {
        if (isAssetAbsentFromManifest(err)) {
          console.warn(
            `[binarySync] Official release manifest does not cover ${bin.filename}: ${err instanceof Error ? err.message : err}`,
          );
          continue;
        }
        // Present in the manifest but refused: distributability policy,
        // unknown platformTrust/edition vocabulary, or a malformed
        // sha256/size entry. Fail closed — see the function doc comment.
        reportRefusedManifestAsset(component, bin.filename, err);
        excludedFilenames.add(bin.filename);
        continue;
      }

      if (verified.sha256 !== bin.checksum) {
        reportRefusedManifestAsset(
          component,
          bin.filename,
          `Checksum mismatch between the local file (${bin.checksum}) and the official release manifest (${verified.sha256}) for ${bin.filename}`,
          "checksum-mismatch",
        );
        excludedFilenames.add(bin.filename);
        continue;
      }

      const edition = verified.edition ?? EDITION_SELF_HOST;
      const osParam = bin.platform === "macos" ? "darwin" : bin.platform;
      const downloadUrl = downloadUrlFor(osParam, bin.architecture);

      if (autoPromote) {
        await tx
          .update(agentVersions)
          .set({ isLatest: false })
          .where(
            and(
              eq(agentVersions.platform, bin.platform),
              eq(agentVersions.architecture, bin.architecture),
              eq(agentVersions.component, component),
              eq(agentVersions.edition, edition),
              eq(agentVersions.isLatest, true),
            ),
          );
      }

      await tx
        .insert(agentVersions)
        .values({
          version,
          component,
          platform: bin.platform,
          architecture: bin.architecture,
          downloadUrl,
          checksum: verified.sha256,
          fileSize: BigInt(verified.size),
          isLatest: autoPromote,
          releaseManifest: manifestString,
          manifestSignature: signatureString,
          signingKeyId: "release-artifact-manifest-ed25519",
          edition,
        })
        .onConflictDoUpdate({
          target: [
            agentVersions.version,
            agentVersions.platform,
            agentVersions.architecture,
            agentVersions.component,
            agentVersions.edition,
          ],
          set: {
            downloadUrl,
            checksum: verified.sha256,
            fileSize: BigInt(verified.size),
            releaseManifest: manifestString,
            manifestSignature: signatureString,
            signingKeyId: "release-artifact-manifest-ed25519",
            ...(autoPromote ? { isLatest: true } : {}),
          },
        });

      registeredFilenames.add(bin.filename);
    }
  });

  return { registeredFilenames, excludedFilenames };
}

/**
 * The GitHub release tag boot-time sync is pinned to (#3742).
 *
 * Boot sync used to fetch `/releases/latest` unconditionally, which — with
 * AGENT_AUTO_PROMOTE defaulting to true — promoted isLatest past the deployed
 * images on a mere API restart: the heartbeat then told agents to upgrade to a
 * version whose assets the redirect couldn't serve, and every attempt died on
 * checksum mismatch. Pinning sync to this version makes "a self-hoster's fleet
 * moves when THEY upgrade their server" the default.
 *
 * NOTE (#3499): this used to also be the only release whose bytes the server
 * could serve, because every `/api/v1/agents/download/*` redirect was built
 * from getGithubReleaseVersion(). That is no longer true — the redirect now
 * follows the promoted `agent_versions` row, so the bytes and the checksum
 * agree by construction and a stale sync can no longer produce the mismatch
 * described above. This pin still governs which release boot sync REGISTERS
 * (and, under AGENT_AUTO_PROMOTE=true, promotes).
 *
 * Returns undefined when no version is pinned (BREEZE_VERSION unset or
 * literally "latest"), preserving the previous /releases/latest behaviour for
 * deployments that deliberately float.
 */
export function pinnedGithubReleaseTag(): string | undefined {
  const version = getGithubReleaseVersion().trim();
  if (!version || version === "latest") return undefined;
  return `v${version.replace(/^v/, "")}`;
}

function unpublishedPinnedReleaseHint(pinnedTag: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return (
    `[binarySync] GitHub sync of pinned release ${pinnedTag} FAILED (${reason}). ` +
    `No agent binaries were registered for this version, so the fleet stays on ` +
    `the last successfully synced release: agent_versions is unchanged, and ` +
    `since #3499 the download routes serve that same promoted release, so ` +
    `installs and upgrades keep working — they just will not advance to ` +
    `${pinnedTag}. To move the fleet, publish ${pinnedTag}, or set ` +
    `BINARY_VERSION to a PUBLISHED release so boot sync can register it. There ` +
    `is deliberately no fallback to /releases/latest (#3742).`
  );
}

export async function syncBinaries(): Promise<void> {
  if (getBinarySource() === "github") {
    const pinnedTag = pinnedGithubReleaseTag();
    console.log(
      `[binarySync] BINARY_SOURCE=github, syncing from GitHub release ${pinnedTag ?? "latest"}`,
    );
    try {
      await syncFromGitHub(pinnedTag);
    } catch (err) {
      // Deliberately NOT falling back to /releases/latest: that would silently
      // move the fleet's promoted release to something the operator never
      // asked for. (Pre-#3499 it was worse still — the download redirect
      // stayed pinned to this version while isLatest moved, which is the
      // inverse of the #3742 checksum loop. The redirect now follows the
      // promoted row, so that particular mismatch is gone; the reason to
      // refuse the fallback is now intent, not divergence.)
      // Tell the operator what to do instead.
      if (pinnedTag) console.error(unpublishedPinnedReleaseHint(pinnedTag, err));
      throw err;
    }
    // Safety net: with no pinned version syncFromGitHub() hits /releases/latest
    // which EXCLUDES pre-releases, so RC deploys (APP_VERSION=x.y.z-rc.N) would
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
    assertLocalGithubFallbackAllowed(
      `stale binaries volume: v${version} but BREEZE_VERSION=${expectedVersion}`,
    );
    console.warn(
      `[binarySync] Stale binaries volume detected: volume has v${version} but BREEZE_VERSION=${expectedVersion}. ` +
        `Falling back to GitHub release sync. To fix, run: docker compose up -d --force-recreate binaries-init`,
    );
    try {
      // Pinned to the redirect's version, not /releases/latest (#3742).
      await syncFromGitHub(pinnedGithubReleaseTag());
      return;
    } catch (err) {
      // Compound failure — stale binaries volume AND GitHub fallback failed.
      // Agents will be served the wrong binary, so this must be loud. Note the
      // fall-through is deliberate and unchanged: execution continues to local
      // registration and the stale volume is served. That is right for a
      // transient GitHub outage, but an SSRF refusal is NOT transient, so
      // describeFetchFailure names it and reportIfGuardRefusal escalates it
      // rather than letting it read as "GitHub 503".
      console.error(
        `[binarySync] Stale binaries volume + GitHub sync FAILED — agents will be served the wrong version: ${describeFetchFailure(err)}`,
      );
      reportIfGuardRefusal(err, "stale-volume-fallback");
    }
  }

  // Official-manifest local registration (BYO signing edition follow-up): if
  // a release-artifact-manifest.json + .ed25519 pair is staged at the
  // binaries volume root, verify it up front so assets it covers register
  // against IT (raw manifest + official key ID) instead of a fresh
  // per-deployment re-sign. Absent files: unchanged self-host local-mode
  // behavior. Present but invalid: log + fall back UNLESS this is a hosted
  // deployment, where trusting an unverifiable local manifest is not an
  // option and sync fails outright instead of silently falling back.
  let officialManifest: { manifestBytes: Buffer; signatureBytes: Buffer } | null = null;
  const officialManifestPair = await loadOfficialLocalManifestPair(agentBinaryDir);
  if (officialManifestPair) {
    try {
      verifyReleaseArtifactManifestIntegrity(
        officialManifestPair.manifestBytes,
        officialManifestPair.signatureBytes,
      );
      officialManifest = officialManifestPair;
      console.log(
        "[binarySync] Verified official release-artifact-manifest.json in the binaries volume; registering the assets it covers against it instead of re-signing with the per-deployment key",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (getBinaryEdition() === "hosted") {
        throw new Error(
          `[binarySync] Official release manifest verification failed and BINARY_EDITION=hosted requires a valid manifest: ${msg}`,
        );
      }
      console.error(
        `[binarySync] Official release manifest found but failed verification, falling back to per-deployment re-signing: ${msg}`,
      );
    }
  }

  // Scan and register agent binaries in DB. The watchdog and backup binaries
  // ship in the same directory as their per-arch siblings
  // (breeze-watchdog-{os}-{arch}[.exe], breeze-backup-{os}-{arch}[.exe]) and are
  // served by the matching /download/watchdog and /download/backup routes.
  const binaries = await scanBinaryDir(agentBinaryDir);
  const watchdogBinaries = await scanBinaryDir(agentBinaryDir, "watchdog");
  const backupBinaries = await scanBinaryDir(agentBinaryDir, "backup");

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

    let coveredAgentFilenames = new Set<string>();
    // D4 (#3836): assets present in the official manifest but refused (policy)
    // or checksum-mismatched must be excluded from the registerLocalBinaries
    // fallback below too — that path has no distributability gate at all.
    let excludedAgentFilenames = new Set<string>();
    if (officialManifest) {
      const result = await registerFromOfficialManifest({
        binaries,
        component: "agent",
        version,
        manifestBytes: officialManifest.manifestBytes,
        signatureBytes: officialManifest.signatureBytes,
        downloadUrlFor: (osParam, arch) =>
          `${serverUrl}/api/v1/agents/download/${osParam}/${arch}`,
      });
      coveredAgentFilenames = result.registeredFilenames;
      excludedAgentFilenames = result.excludedFilenames;
      if (coveredAgentFilenames.size > 0) {
        console.log(
          `[binarySync] Registered ${coveredAgentFilenames.size} agent binaries from the official release manifest (version: ${version})`,
        );
      }
    }

    const remainingAgentBinaries = binaries.filter(
      (b) => !coveredAgentFilenames.has(b.filename) && !excludedAgentFilenames.has(b.filename),
    );
    if (remainingAgentBinaries.length > 0) {
      await registerLocalBinaries({
        binaries: remainingAgentBinaries,
        component: "agent",
        version,
        keyId,
        downloadUrlFor: (osParam, arch) =>
          `${serverUrl}/api/v1/agents/download/${osParam}/${arch}`,
      });

      console.log(
        `[binarySync] Registered ${remainingAgentBinaries.length} agent binaries via per-deployment re-signing (version: ${version})`,
      );
    }

    // #1802: register the watchdog component too, so self-hosters on
    // BINARY_SOURCE=local get watchdog auto-update (heartbeat.ts watchdogUpgradeTo
    // + the agent's handleWatchdogUpgrade). Previously only syncFromGitHub did
    // this, leaving local watchdogs frozen at install-time version.
    if (watchdogBinaries.length > 0) {
      // Isolate watchdog registration so a watchdog-only failure (e.g. signing)
      // doesn't abort the rest of syncBinaries after the agent already
      // registered — mirrors the GitHub path's per-component try/catch.
      try {
        let coveredWatchdogFilenames = new Set<string>();
        // D4 (#3836): same exclusion as the agent loop above — a
        // policy-refused or checksum-mismatched watchdog asset must not fall
        // through to registerLocalBinaries either.
        let excludedWatchdogFilenames = new Set<string>();
        if (officialManifest) {
          const result = await registerFromOfficialManifest({
            binaries: watchdogBinaries,
            component: "watchdog",
            version,
            manifestBytes: officialManifest.manifestBytes,
            signatureBytes: officialManifest.signatureBytes,
            downloadUrlFor: (osParam, arch) =>
              `${serverUrl}/api/v1/agents/download/watchdog/${osParam}/${arch}`,
          });
          coveredWatchdogFilenames = result.registeredFilenames;
          excludedWatchdogFilenames = result.excludedFilenames;
        }
        const remainingWatchdogBinaries = watchdogBinaries.filter(
          (b) =>
            !coveredWatchdogFilenames.has(b.filename) &&
            !excludedWatchdogFilenames.has(b.filename),
        );
        if (remainingWatchdogBinaries.length > 0) {
          await registerLocalBinaries({
            binaries: remainingWatchdogBinaries,
            component: "watchdog",
            version,
            keyId,
            downloadUrlFor: (osParam, arch) =>
              `${serverUrl}/api/v1/agents/download/watchdog/${osParam}/${arch}`,
          });
        }
        console.log(
          `[binarySync] Registered ${watchdogBinaries.length} watchdog binaries (version: ${version})`,
        );
      } catch (err) {
        console.error(
          `[binarySync] Failed to register local watchdog binaries — watchdog auto-update unavailable: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else {
      console.warn(
        "[binarySync] No local watchdog binaries found — watchdog auto-update unavailable on this self-hosted deploy",
      );
    }

    // Register the backup component too, mirroring the watchdog registration
    // above — same per-component try/catch isolation so a backup-only failure
    // (e.g. signing) doesn't abort the agent/watchdog registration that already
    // succeeded.
    if (backupBinaries.length > 0) {
      try {
        await registerLocalBinaries({
          binaries: backupBinaries,
          component: "backup",
          version,
          keyId,
          downloadUrlFor: (osParam, arch) =>
            `${serverUrl}/api/v1/agents/download/backup/${osParam}/${arch}`,
        });
        console.log(
          `[binarySync] Registered ${backupBinaries.length} backup binaries (version: ${version})`,
        );
      } catch (err) {
        console.error(
          `[binarySync] Failed to register local backup binaries — breeze-backup auto-update unavailable: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else {
      console.warn(
        "[binarySync] No local backup binaries found — breeze-backup auto-update unavailable on this self-hosted deploy",
      );
    }
  } else {
    assertLocalGithubFallbackAllowed(
      `no local agent binaries found in ${agentBinaryDir}`,
    );
    console.log(
      "[binarySync] No local agent binaries found, falling back to GitHub sync",
    );
    // Pinned to the redirect's version, not /releases/latest (#3742). Logged
    // rather than thrown, matching the stale-volume fallback above: in local
    // mode a sync failure is fatal at boot (index.ts), and an unpublished
    // pin must not take the whole API down with it.
    const pinnedTag = pinnedGithubReleaseTag();
    try {
      await syncFromGitHub(pinnedTag);
    } catch (err) {
      console.error(
        pinnedTag
          ? unpublishedPinnedReleaseHint(pinnedTag, err)
          : `[binarySync] No local binaries + GitHub sync FAILED — no agent binaries are registered: ${describeFetchFailure(err)}`,
      );
      reportIfGuardRefusal(err, "no-local-binaries-fallback");
    }
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
): Promise<{ version: string; synced: string[]; failed: string[] }> {
  const ghUrl = requestedVersion
    ? `${getReleaseSourceApiBase()}/releases/tags/${requestedVersion}`
    : `${getReleaseSourceApiBase()}/releases/latest`;

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

  // ghHeaders may carry `Authorization: Bearer <GITHUB_TOKEN>`; the guarded
  // helper drops credential headers on a cross-origin hop. To be precise about
  // what that is and isn't worth: it is NOT a leak this fixes. undici already
  // implements the fetch spec's step 13 and deletes authorization/cookie/host
  // on a cross-origin redirect, so bare `fetch` did not walk the token either.
  // The real win at this site is the per-hop DNS resolution and IP pinning
  // below; the header handling merely keeps parity.
  const ghResp = await safeFetchFollowingRedirects(ghUrl, {
    headers: ghHeaders,
    maxBytes: MAX_RELEASE_API_JSON_BYTES,
    timeoutMs: RELEASE_FETCH_TIMEOUT_MS,
  });
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

  // ------------------------------------------------------------------
  // Phase 1 — RESOLVE. Verify, trust-check and deployment-sign every asset
  // before touching the database.
  //
  // Everything in this phase throws on failure, aborting the whole sync. That
  // is deliberate: a manifest that fails signature verification, an asset whose
  // platformTrust contradicts its name, or an undecryptable deployment signing
  // key are all deployment-wide faults, not per-target ones. Resolving up front
  // means such a fault cannot leave agent_versions half-updated — which
  // previously it did, and asymmetrically: AGENT_TARGETS ends with
  // windows/amd64, so a bad Windows asset committed and PROMOTED all four
  // linux/darwin agents and then aborted before the helper, user-helper and
  // watchdog loops ran at all, freezing watchdogs against upgraded agents.
  // ------------------------------------------------------------------
  const componentTargets: {
    component: string;
    targets: readonly { goos: string; goarch: string; assetName?: string }[];
  }[] = [
    { component: "agent", targets: AGENT_TARGETS },
    { component: "helper", targets: HELPER_TARGETS },
    { component: "user-helper", targets: USER_HELPER_TARGETS },
    { component: "watchdog", targets: WATCHDOG_TARGETS },
  ];

  const plan: {
    component: string;
    platform: string;
    arch: string;
    downloadUrl: string;
    signedMetadata: UpsertMetadata;
  }[] = [];

  for (const { component, targets } of componentTargets) {
    for (const target of targets) {
      const suffix = target.goos === "windows" ? ".exe" : "";
      const assetName =
        target.assetName ??
        `breeze-${component}-${target.goos}-${target.goarch}${suffix}`;
      const asset = release.assets.find((a) => a.name === assetName);
      // Legitimate "this release predates that artifact" case — stay silent.
      if (!asset) continue;

      const metadata = await getReleaseAssetMetadata({
        asset,
        trustedManifest,
        fallbackChecksums,
        releaseTag: release.tag_name,
      });
      if (!metadata) {
        // Different from `!asset`: the asset IS in the release but its checksum
        // could not be resolved from the trusted manifest or the fallback
        // checksums file. An unexpected inconsistency the on-call should see.
        console.warn(
          `[binarySync] Missing metadata for ${component} asset (release=${release.tag_name}, asset=${assetName}, component=${component}); skipping`,
        );
        continue;
      }

      const platform = GH_PLATFORM_MAP[target.goos];
      if (!platform) continue;

      plan.push({
        component,
        platform,
        arch: target.goarch,
        downloadUrl: asset.browser_download_url,
        signedMetadata: await applyDeploymentSigning({
          metadata,
          version,
          component,
          platform,
          arch: target.goarch,
          downloadUrl: asset.browser_download_url,
        }),
      });
    }
  }

  // ------------------------------------------------------------------
  // Phase 2 — COMMIT. Only database writes remain, so a failure here is a
  // transient/storage fault rather than a trust one. Keep going so one bad
  // upsert does not strand every other component, but record failures and
  // raise at the end: returning HTTP 200 with `synced: []` let a fully failed
  // sync read as success while the fleet silently stayed on the old version.
  // ------------------------------------------------------------------
  const synced: string[] = [];
  const failures: string[] = [];

  for (const entry of plan) {
    const label = `${entry.component}:${entry.platform}/${entry.arch}`;
    try {
      await upsertVersion(
        version,
        entry.platform,
        entry.arch,
        entry.component,
        entry.downloadUrl,
        entry.signedMetadata,
        release.body,
      );
      synced.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[binarySync] Failed to upsert ${entry.component} version for ${entry.platform}/${entry.arch}:`,
        message,
      );
      failures.push(`${label} (${message})`);
    }
  }

  // Registering NOTHING while reporting success is the failure that matters:
  // the caller (POST /agent-versions/sync-github) answered 200 with an empty
  // `synced`, so a deployment-wide fault read as a successful sync while the
  // fleet silently stayed on its previous version. A PARTIAL failure keeps the
  // per-component isolation #816 relies on (a user-helper upsert failing must
  // not block the agent) — but it is now reported rather than only logged.
  if (synced.length === 0 && plan.length > 0) {
    throw new Error(
      `GitHub sync registered 0 of ${plan.length} binaries for ${version}: ${failures.join("; ")}`,
    );
  }

  // Sync backup binaries. Same per-arch asset shape as the agent/watchdog.
  // Missing for any release predating the backup component being published —
  // the `release.assets.find` returns undefined and the loop body
  // short-circuits.
  for (const target of BACKUP_TARGETS) {
    const suffix = target.goos === "windows" ? ".exe" : "";
    const assetName = `breeze-backup-${target.goos}-${target.goarch}${suffix}`;
    const asset = release.assets.find((a) => a.name === assetName);
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
        `[binarySync] Missing metadata for backup asset (release=${release.tag_name}, asset=${assetName}, component=backup); skipping`,
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
        "backup",
        asset.browser_download_url,
        metadata,
        release.body,
      );
      synced.push(`backup:${platform}/${target.goarch}`);
    } catch (err) {
      console.error(
        `[binarySync] Failed to upsert backup version for ${platform}/${target.goarch}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[binarySync] GitHub sync: registered ${synced.length} binaries (version: ${version})`,
  );
  return { version, synced, failed: failures };
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
    // Check both the agent row AND its version-slaved backup companion.
    // A server that registered agent rows for this version before backup
    // component support shipped would otherwise never backfill the backup
    // row — the old check only looked at component="agent" and returned
    // early, leaving breeze-backup permanently unregistered for that version.
    const existingRows = await db
      .select({
        component: agentVersions.component,
        platform: agentVersions.platform,
        architecture: agentVersions.architecture,
        isLatest: agentVersions.isLatest,
        // Selected because (version, platform, architecture, component,
        // edition) is the unique key — the same platform/arch can carry both a
        // self-host and a hosted agent row, and the backup row must mirror the
        // isLatest of its OWN edition's sibling, not whichever came back first.
        edition: agentVersions.edition,
      })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.version, currentVersion),
          inArray(agentVersions.component, ["agent", "backup"]),
        ),
      );

    const agentRows = existingRows.filter((r) => r.component === "agent");
    const hasAgent = agentRows.length > 0;
    const hasBackup = existingRows.some((r) => r.component === "backup");

    if (hasAgent && hasBackup) return; // Already registered

    if (hasAgent && !hasBackup) {
      // The agent row is already registered for this version — running the
      // FULL syncFromGitHub just to backfill the (possibly nonexistent)
      // backup row is not acceptable: with AGENT_AUTO_PROMOTE default true
      // it re-stamps isLatest on every component (silently reverting manual
      // fleet promotions), and its onConflictDoUpdate overwrites
      // locally-registered rows' downloadUrl/checksum with github.com
      // values on BINARY_SOURCE=local deploys. Do a narrow backup-only
      // backfill instead: one GitHub release fetch, touching only
      // component=backup rows for this version.
      //
      // Subject to the same hosted fail-closed rule as the !hasAgent fallback
      // below — this branch also reaches the public GitHub release from local
      // mode, so exempting it would let a hosted deployment register a
      // self-host backup binary through the side door. Logged and skipped
      // rather than thrown, matching that branch: the whole function is a
      // best-effort safety net that must never crash boot.
      if (getBinarySource() === "local" && getBinaryEdition() === "hosted") {
        console.error(
          `[binarySync] Backup rows missing for version ${currentVersion} and BINARY_EDITION=hosted refuses to fall back to the public GitHub release from local mode. Stage breeze-backup in the local binaries volume instead.`,
        );
        return;
      }
      await backfillBackupRowsForVersion(currentVersion, agentRows);
      return;
    }

    // This safety net runs after BOTH sync modes. In github mode, syncing the
    // current version from GitHub is the primary path, not a fallback — leave
    // it alone. In local mode it IS a fallback (local scan didn't produce the
    // running version), so it's subject to the same hosted-edition fail-closed
    // rule as the other local-mode fallbacks above. Unlike those, this
    // function is a best-effort safety net by design (never crashes boot), so
    // mirror that here: log and skip rather than throw.
    if (getBinarySource() === "local" && getBinaryEdition() === "hosted") {
      console.error(
        `[binarySync] Version ${currentVersion} not found in agentVersions and BINARY_EDITION=hosted refuses to fall back to the public GitHub release from local mode. Register it via the local binaries volume instead.`,
      );
      return;
    }

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
    // version 404. This catch also swallows everything thrown by
    // backfillBackupRowsForVersion, which is the ONLY caller path to that
    // function's outbound fetch — so without reportIfGuardRefusal an SSRF
    // refusal there would produce one boot-time log line and no alert at all.
    console.error(
      `[binarySync] Failed to auto-sync version ${currentVersion} from GitHub:`,
      describeFetchFailure(err),
    );
    reportIfGuardRefusal(err, "ensure-current-version-registered");
  }
}

/**
 * Narrow companion to ensureCurrentVersionRegistered's hasAgent && !hasBackup
 * branch: registers ONLY component=backup rows for currentVersion, without
 * running the full syncFromGitHub (which re-stamps isLatest on every
 * component under AGENT_AUTO_PROMOTE and overwrites locally-registered rows'
 * downloadUrl/checksum). Fetches the single GitHub release tagged for this
 * version and upserts backup rows whose isLatest mirrors the sibling agent
 * row for the same (platform, architecture) — never the auto-promote demote
 * logic, and no non-backup row is touched. If the release predates
 * breeze-backup, or has no matching assets, logs once and returns; the next
 * boot may retry (one cheap GitHub release fetch per boot is acceptable).
 */
async function backfillBackupRowsForVersion(
  currentVersion: string,
  agentRows: {
    platform: string;
    architecture: string;
    isLatest: boolean;
    edition: string;
  }[],
): Promise<void> {
  // Same resolved release source as the main sync path (line ~853), not a
  // hardcoded api.github.com/<GITHUB_REPO> — a deployment that overrides its
  // release repository must have its backup rows backfilled from THAT repo,
  // not from the upstream one.
  const ghUrl = `${getReleaseSourceApiBase()}/releases/tags/v${currentVersion}`;
  const ghToken =
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const ghHeaders: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "breeze-api",
  };
  if (ghToken) {
    ghHeaders.Authorization = `Bearer ${ghToken}`;
  }

  // ghHeaders may carry `Authorization: Bearer <GITHUB_TOKEN>`; the guarded
  // helper drops credential headers on a cross-origin hop. To be precise about
  // what that is and isn't worth: it is NOT a leak this fixes. undici already
  // implements the fetch spec's step 13 and deletes authorization/cookie/host
  // on a cross-origin redirect, so bare `fetch` did not walk the token either.
  // The real win at this site is the per-hop DNS resolution and IP pinning
  // below; the header handling merely keeps parity.
  const ghResp = await safeFetchFollowingRedirects(ghUrl, {
    headers: ghHeaders,
    maxBytes: MAX_RELEASE_API_JSON_BYTES,
    timeoutMs: RELEASE_FETCH_TIMEOUT_MS,
  });
  if (!ghResp.ok) {
    throw new Error(`GitHub API error: ${ghResp.status}`);
  }

  const release = (await ghResp.json()) as {
    tag_name: string;
    body?: string;
    assets: GitHubReleaseAsset[];
  };

  const trustedManifest = await fetchTrustedReleaseManifest(release.assets);
  const fallbackChecksums = trustedManifest
    ? null
    : await parseChecksumsFallback(release.assets);

  let backfilled = 0;
  for (const target of BACKUP_TARGETS) {
    const suffix = target.goos === "windows" ? ".exe" : "";
    const assetName = `breeze-backup-${target.goos}-${target.goarch}${suffix}`;
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) continue;
    const metadata = await getReleaseAssetMetadata({
      asset,
      trustedManifest,
      fallbackChecksums,
      releaseTag: release.tag_name,
    });
    if (!metadata) {
      console.warn(
        `[binarySync] Missing metadata for backup asset (release=${release.tag_name}, asset=${assetName}, component=backup); skipping`,
      );
      continue;
    }
    const platform = GH_PLATFORM_MAP[target.goos];
    if (!platform) continue;

    // Mirror the sibling agent row's isLatest for this (platform,
    // architecture) instead of running upsertVersion's auto-promote
    // demote/insert logic — this backfill must never flip another row's
    // isLatest or touch a non-backup component.
    // Matched on edition too: a row of a different edition is a different row
    // under the unique key, so mirroring its isLatest would promote this backup
    // row off an unrelated sibling's state.
    const siblingAgentRow = agentRows.find(
      (r) =>
        r.platform === platform &&
        r.architecture === target.goarch &&
        r.edition === metadata.edition,
    );
    const isLatest = siblingAgentRow?.isLatest ?? false;

    try {
      await upsertBackupVersionExplicit(
        currentVersion,
        platform,
        target.goarch,
        asset.browser_download_url,
        metadata,
        release.body,
        isLatest,
      );
      backfilled++;
    } catch (err) {
      console.error(
        `[binarySync] Failed to backfill backup version for ${platform}/${target.goarch}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (backfilled === 0) {
    console.log(
      `[binarySync] release v${currentVersion} has no breeze-backup assets; backup auto-update unavailable for this version`,
    );
  }
}

// Transaction ensures atomicity: without it, concurrent upserts could leave
// multiple rows with isLatest=true for the same platform/arch/component tuple,
// causing heartbeat queries to return stale versions.
type UpsertMetadata = {
  checksum: string;
  size: number;
  releaseManifest?: string;
  manifestSignature?: string;
  signingKeyId?: string;
  edition: string;
};

// Spec 3b: when syncing from an OVERRIDDEN repository, the release manifest is
// signed by the self-hoster's release key, which agents do not (and must not
// need to) trust. Re-sign a NORMALIZED per-asset update manifest — the exact
// shape registerLocalBinaries produces — with the per-deployment key and stamp
// the deploy-* key ID, so agents verify against their TOFU-pinned deployment
// key with zero agent-side changes.
//
// For the official repository this is a pass-through: that path must stay
// byte-identical (raw release manifest + "release-artifact-manifest-ed25519",
// which agents bind to the embedded official key). The checksums.txt fallback
// path (no releaseManifest, non-production only) is also passed through — there
// is no verified manifest to normalize.
async function applyDeploymentSigning(args: {
  metadata: UpsertMetadata;
  version: string;
  component: string;
  platform: string;
  arch: string;
  downloadUrl: string;
}): Promise<UpsertMetadata> {
  const { metadata } = args;
  if (isOfficialReleaseSource() || !metadata.releaseManifest) {
    return metadata;
  }

  const { keyId } = await ensureActiveSigningKey();
  const releaseManifest = JSON.stringify({
    version: args.version,
    component: args.component,
    platform: args.platform,
    arch: args.arch,
    url: args.downloadUrl,
    checksum: metadata.checksum,
    size: metadata.size,
  });
  const manifestSignature = await signManifest(releaseManifest);
  return {
    checksum: metadata.checksum,
    size: metadata.size,
    releaseManifest,
    manifestSignature,
    signingKeyId: keyId,
    edition: metadata.edition,
  };
}

// `signedMetadata` is produced by applyDeploymentSigning BEFORE this is called.
// Do not move that call in here: every caller wraps upsertVersion in a
// log-and-continue catch (a DB upsert failing for one target should not strand
// the rest), and re-signing failures — a rotated APP_ENCRYPTION_KEY, an
// undecryptable signing key — must NOT be swallowed by it. Those are
// deployment-wide faults that have to abort the whole sync loudly, the same way
// manifest-verification failures already do.
async function upsertVersion(
  version: string,
  platform: string,
  arch: string,
  component: string,
  downloadUrl: string,
  signedMetadata: UpsertMetadata,
  releaseNotes?: string | null,
) {
  // Controlled fleet rollout (AGENT_AUTO_PROMOTE=false): register but do not
  // promote. Skip the demote UPDATE, insert isLatest:false, and OMIT isLatest
  // from the conflict `set` so an existing promoted row keeps its target.
  // When auto-promote is on (default) behavior is byte-for-byte unchanged.
  const autoPromote = getAgentAutoPromote();
  const edition = signedMetadata.edition;
  await db.transaction(async (tx) => {
    if (autoPromote) {
      await tx
        .update(agentVersions)
        .set({ isLatest: false })
        .where(
          and(
            eq(agentVersions.platform, platform),
            eq(agentVersions.architecture, arch),
            eq(agentVersions.component, component),
            eq(agentVersions.edition, edition),
            eq(agentVersions.isLatest, true),
          ),
        );
    }

    await tx
      .insert(agentVersions)
      .values({
        version,
        platform,
        architecture: arch,
        downloadUrl,
        checksum: signedMetadata.checksum,
        releaseManifest: signedMetadata.releaseManifest,
        manifestSignature: signedMetadata.manifestSignature,
        signingKeyId: signedMetadata.signingKeyId,
        fileSize: BigInt(signedMetadata.size),
        releaseNotes: releaseNotes ?? null,
        isLatest: autoPromote,
        component,
        edition,
      })
      .onConflictDoUpdate({
        target: [
          agentVersions.version,
          agentVersions.platform,
          agentVersions.architecture,
          agentVersions.component,
          agentVersions.edition,
        ],
        set: {
          downloadUrl,
          checksum: signedMetadata.checksum,
          releaseManifest: signedMetadata.releaseManifest,
          manifestSignature: signedMetadata.manifestSignature,
          signingKeyId: signedMetadata.signingKeyId,
          fileSize: BigInt(signedMetadata.size),
          releaseNotes: releaseNotes ?? null,
          ...(autoPromote ? { isLatest: true } : {}),
        },
      });
  });
}

// Narrow variant used only by backfillBackupRowsForVersion. upsertVersion's
// autoPromote branch is deliberately unsuitable here: it either demotes every
// other isLatest row for the tuple (autoPromote=true) or unconditionally
// registers isLatest=false (autoPromote=false) — neither expresses "set
// isLatest to whatever the sibling agent row already has, and touch nothing
// else." Never runs the demote UPDATE and only ever inserts/updates the
// single component=backup row for this (version, platform, architecture).
async function upsertBackupVersionExplicit(
  version: string,
  platform: string,
  arch: string,
  downloadUrl: string,
  metadata: {
    checksum: string;
    size: number;
    releaseManifest?: string;
    manifestSignature?: string;
    signingKeyId?: string;
    edition: string;
  },
  releaseNotes: string | null | undefined,
  isLatest: boolean,
) {
  await db.transaction(async (tx) => {
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
        isLatest,
        component: "backup",
        edition: metadata.edition,
      })
      .onConflictDoUpdate({
        // Five columns, matching `agent_versions_version_platform_arch_component_edition_unique`.
        // A four-column target has no matching unique index, so Postgres would
        // reject the whole statement with 42P10 at runtime — invisible to the
        // mocked-DB unit tests around this function.
        target: [
          agentVersions.version,
          agentVersions.platform,
          agentVersions.architecture,
          agentVersions.component,
          agentVersions.edition,
        ],
        set: {
          downloadUrl,
          checksum: metadata.checksum,
          releaseManifest: metadata.releaseManifest,
          manifestSignature: metadata.manifestSignature,
          signingKeyId: metadata.signingKeyId,
          fileSize: BigInt(metadata.size),
          releaseNotes: releaseNotes ?? null,
          isLatest,
        },
      });
  });
}
