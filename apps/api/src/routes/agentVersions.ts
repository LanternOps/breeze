import { Hono } from "hono";
import { zValidator } from '../lib/validation';
import { z } from "zod";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db";
import { agentVersions } from "../db/schema";
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
} from "../middleware/auth";
import { platformAdminMiddleware } from "../middleware/platformAdmin";
import { writeRouteAudit } from "../services/auditEvents";
import { syncFromGitHub } from "../services/binarySync";
import { captureException } from "../services/sentry";
import { ResponseTooLargeError, SsrfBlockedError } from "../services/urlSafety";
import { getBinaryEdition } from "../services/binaryEdition";
import { getBinarySource, getGithubReleaseVersion } from "../services/binarySource";
import { getPromotedComponentVersion } from "../services/promotedAgentVersion";
import { PERMISSIONS } from "../services/permissions";
import {
  verifyReleaseArtifactManifestAsset,
  ReleaseAssetNotDistributableError,
  ReleaseManifestAssetLookupError,
  ReleaseManifestSignatureError,
  verifyManifestSignatureAgainstOfficialKeysOnly,
} from "../services/releaseArtifactManifest";
import { EDITION_HOSTED, EDITION_SELF_HOST } from "../services/releaseAssetTrust";
import {
  getActivePublicKeys as getActiveDeploymentSigningPubKeys,
  getActiveTrustKeyset,
} from "../services/manifestSigning";

// The one key ID hard-bound in every agent build to the embedded LanternOps
// release-signing public key (agent/internal/updater/updater.go, ~line 395).
// Any OTHER signingKeyId value is either a `deploy-*` per-deployment key
// (manifest_signing_keys) or unrecognized/absent (legacy normalized rows
// predating signingKeyId).
const OFFICIAL_MANIFEST_SIGNING_KEY_ID = "release-artifact-manifest-ed25519";

// Map Go GOOS / user-facing platform names to DB platform names
const PLATFORM_MAP: Record<string, string> = {
  linux: "linux",
  darwin: "macos",
  windows: "windows",
};

export const agentVersionRoutes = new Hono();
const requireAgentVersionAdmin = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action,
);

// Validation schemas
const platformEnum = z.enum(["windows", "macos", "linux", "darwin"]);
const architectureEnum = z.enum(["amd64", "arm64"]);
// "watchdog" lets the agent's reconcile path (and the watchdog's own failover
// self-update) resolve and download the watchdog component. Omitting it here is
// why watchdog auto-update 400'd server-side regardless of registration.
// "backup" lets install.sh (and any future self-heal fetch) resolve and
// download the breeze-backup binary the same way.
const componentEnum = z.enum([
  "agent",
  "helper",
  "viewer",
  "user-helper",
  "watchdog",
  "backup",
]);

// Release edition ("self-host" | "hosted"): lets the same version/platform/
// arch/component be registered twice — once per edition — so a hosted
// deployment's own build can coexist with the public self-host build. Admin
// create defaults to this server's own edition when omitted.
const editionEnum = z.enum([EDITION_SELF_HOST, EDITION_HOSTED]);

const latestQuerySchema = z.object({
  platform: platformEnum,
  arch: architectureEnum,
  component: componentEnum.optional().default("agent"),
});

const downloadParamsSchema = z.object({
  version: z.string().min(1).max(20),
});

const downloadQuerySchema = z.object({
  platform: platformEnum,
  arch: architectureEnum,
  component: componentEnum.optional().default("agent"),
});

const createVersionSchema = z.object({
  version: z.string().min(1).max(20),
  platform: platformEnum,
  architecture: architectureEnum,
  downloadUrl: z.string().url(),
  checksum: z.string().length(64), // SHA256 is 64 hex characters
  releaseManifest: z.string().min(1).optional(),
  manifestSignature: z.string().min(1).optional(),
  signingKeyId: z.string().max(128).optional(),
  fileSize: z.number().int().positive().optional(),
  releaseNotes: z.string().optional(),
  isLatest: z.boolean().optional().default(false),
  component: componentEnum.optional().default("agent"),
  edition: editionEnum.optional(),
});

// Controlled fleet rollout: explicitly promote a registered version to the
// fleet upgrade target. Omitting `component` promotes ALL components of the
// version. See docs/superpowers/specs/agent/2026-06-23-controlled-agent-fleet-rollout.md.
const promoteSchema = z.object({
  version: z.string().min(1).max(20),
  component: componentEnum.optional(),
});

type ReleaseManifest = {
  version?: unknown;
  component?: unknown;
  platform?: unknown;
  arch?: unknown;
  url?: unknown;
  checksum?: unknown;
  size?: unknown;
};

type ReleaseArtifactManifest = {
  schemaVersion?: unknown;
  release?: unknown;
  assets?: unknown;
};

async function getUpdateManifestPublicKeys(): Promise<Buffer[]> {
  const configured = [
    process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS,
    process.env.BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(",");

  const fromEnv = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  // Per-deployment signing keys (self-host BINARY_SOURCE=local). The set is
  // small (typically one active key) and on a hot lookup path; cache layered
  // higher up if this becomes a bottleneck. See #625.
  let fromDb: string[] = [];
  let dbLoadFailed = false;
  try {
    fromDb = await getActiveDeploymentSigningPubKeys();
  } catch (err) {
    console.warn(
      `[agentVersions] Failed to load deployment signing pubkeys (failing closed):`,
      err
    );
    dbLoadFailed = true;
  }

  const result = [...fromEnv, ...fromDb]
    .map((value) => Buffer.from(value, "base64"))
    .filter((key) => key.length === 32);

  // Defense in depth: if the DB returned rows but every one decoded to a
  // non-32-byte value (corrupt row, schema regression, encoding mismatch),
  // the filter strips them all and we'd reach the empty-keyset soft-pass in
  // verifyEd25519ManifestSignature with dbLoadFailed=false — silently
  // accepting unsigned manifests. Treat that as a load failure.
  if (fromDb.length > 0 && result.length === fromEnv.length) {
    console.error(
      `[agentVersions] manifest_signing_keys returned ${fromDb.length} row(s) but none decode to valid 32-byte Ed25519 keys — failing closed`,
    );
    dbLoadFailed = true;
  }

  // Tag the result so verifyEd25519ManifestSignature can fail closed when
  // the only reason we have no keys is "DB load failed".
  return Object.assign(result, { dbLoadFailed });
}

/**
 * Verify an Ed25519 signature over `manifest` against the active trust roots
 * (env-pinned + DB-provisioned deployment signing keys).
 *
 * Default is **fail-closed** when no keys are configured. Callers that want
 * the hosted-SaaS "no trust roots = trust everything" bootstrap behavior
 * (e.g. fresh deploy before any deployment signing key is provisioned and no
 * env-pinned trust root has been added) must explicitly pass
 * `allowEmptyKeysetSoftPass: true`.
 *
 * When the DB lookup fails outright (`dbLoadFailed`), we always return false
 * regardless of the opt-in — never soft-pass on a transient DB outage
 * (#625 review-CRIT-1).
 */
export async function verifyEd25519ManifestSignature(
  manifest: string,
  signature: string,
  options: { allowEmptyKeysetSoftPass?: boolean } = {},
): Promise<boolean> {
  const keys = await getUpdateManifestPublicKeys();
  if (keys.length === 0) {
    const dbLoadFailed = !!(keys as { dbLoadFailed?: boolean }).dbLoadFailed;
    if (dbLoadFailed) {
      // DB lookup actually failed — never soft-pass, even if the caller
      // opted in. Transient outages must not bypass signature verification.
      return false;
    }
    if (options.allowEmptyKeysetSoftPass) {
      // Caller opted into the legacy hosted-SaaS bootstrap behavior. Empty
      // keyset by intent (no env + no DB rows on a fresh hosted deploy) is
      // treated as "trust everything" until the first key is provisioned.
      return true;
    }
    console.error(
      "[agentVersions] verifyEd25519ManifestSignature: no trust roots configured and allowEmptyKeysetSoftPass not set — failing closed",
    );
    return false;
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    // Make abuse probes greppable: malformed base64 is rare in normal traffic
    // and worth logging (without echoing the signature itself).
    console.warn(
      "[agentVersions] verifyEd25519ManifestSignature: signature base64 parse failed — rejecting",
    );
    return false;
  }
  if (signatureBytes.length !== 64) {
    console.warn(
      `[agentVersions] verifyEd25519ManifestSignature: signature is ${signatureBytes.length} bytes, expected 64 — rejecting`,
    );
    return false;
  }

  return keys.some((rawKey) => {
    try {
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        rawKey,
      ]);
      const publicKey = createPublicKey({
        key: spki,
        format: "der",
        type: "spki",
      });
      return verifySignature(
        null,
        Buffer.from(manifest, "utf8"),
        publicKey,
        signatureBytes,
      );
    } catch {
      return false;
    }
  });
}

// Verifies `signature` against exactly ONE raw 32-byte Ed25519 key — the
// deploy-* single-key-row branch of verifyManifestSignatureForSigningKeyId
// below. Deliberately duplicates the small signature-bytes check inline
// (rather than refactoring the well-tested verifyEd25519ManifestSignature
// above to take a caller-supplied key list) so that function's existing
// logging/soft-pass semantics — which several tests pin — stay untouched.
function verifyEd25519SignatureAgainstSingleRawKey(
  manifest: string,
  signature: string,
  rawKey: Buffer,
): boolean {
  if (rawKey.length !== 32) return false;
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;

  try {
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      rawKey,
    ]);
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    return verifySignature(
      null,
      Buffer.from(manifest, "utf8"),
      publicKey,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

// Key-ID-aware verification for the LEGACY (non schema-v1) manifest shape —
// Task 2 (#3836). Mirrors the agent's exact-ID semantics (agent/internal/
// updater/updater.go verifyManifestSignature, ~line 769): when a key ID is
// present it binds verification to that ONE key, with no fallback across
// the rest of the trusted set. This narrows what an EXPLICIT signingKeyId
// can accept — it never widens acceptance relative to the prior whole-set
// behavior, and unrecognized/absent IDs keep exactly that prior behavior.
//
//  - OFFICIAL_MANIFEST_SIGNING_KEY_ID: the OFFICIAL configured key set
//    (RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS / getConfiguredPublicKeys via
//    verifyManifestSignatureAgainstOfficialKeysOnly) ONLY — a DB deployment
//    key must never satisfy a claim of official provenance.
//  - `deploy-*`: exactly the one manifest_signing_keys row with that keyId
//    — env keys and every OTHER deploy key must NOT satisfy it. A missing
//    row (rotated out, never existed, DB load failure) fails closed.
//  - absent/unrecognized (legacy normalized rows predating signingKeyId, or
//    any other value): unchanged whole-set verifyEd25519ManifestSignature
//    behavior — this task narrows what an explicit ID accepts, it does not
//    newly require one.
async function verifyManifestSignatureForSigningKeyId(
  manifest: string,
  signature: string,
  signingKeyId: string | null | undefined,
): Promise<boolean> {
  const id = signingKeyId?.trim();

  if (id === OFFICIAL_MANIFEST_SIGNING_KEY_ID) {
    return verifyManifestSignatureAgainstOfficialKeysOnly(manifest, signature);
  }

  if (id && id.startsWith("deploy-")) {
    let keyset: { keyId: string; publicKeyB64: string }[];
    try {
      keyset = await getActiveTrustKeyset();
    } catch (err) {
      console.warn(
        `[agentVersions] Failed to load manifest_signing_keys for signingKeyId=${id} lookup (failing closed):`,
        err,
      );
      return false;
    }
    const row = keyset.find((k) => k.keyId === id);
    if (!row) return false;
    const rawKey = Buffer.from(row.publicKeyB64, "base64");
    return verifyEd25519SignatureAgainstSingleRawKey(manifest, signature, rawKey);
  }

  return verifyEd25519ManifestSignature(manifest, signature, {
    allowEmptyKeysetSoftPass: true,
  });
}

function assetNameFromDownloadUrl(downloadUrl: string): string | null {
  try {
    const parsed = new URL(downloadUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const basename = parts[parts.length - 1];
    return basename ? decodeURIComponent(basename) : null;
  } catch {
    return null;
  }
}

// D1 (issue #3836): canonical asset-name resolution for schema-v1
// release-artifact manifests.
//
// validateReleaseManifest's schema-v1 branch used to derive the manifest
// asset name to look up SOLELY from assetNameFromDownloadUrl(downloadUrl) —
// the URL's last path segment. That is correct for a GitHub-sourced
// downloadUrl (".../releases/download/v1.0.0/breeze-agent-linux-amd64") but
// wrong for a BINARY_SOURCE=local row: registerFromOfficialManifest
// (services/binarySync.ts) stores a server-relative downloadUrl
// (".../api/v1/agents/download/{os}/{arch}" — see
// buildServerRelativeAgentDownloadUrl above), whose last path segment is the
// ARCH, not an asset name. Every local-mode row's schema-v1 lookup therefore
// searched the manifest for e.g. "amd64", never found it, and the failure
// collapsed into invalid_release_manifest_signature — a fleet-wide 409 on
// every agent heartbeat for a correctly-signed row.
//
// This function reproduces EXACTLY the filenames binarySync.ts's
// scanBinaryDir/parseBinaryFilename (agent/watchdog/backup) and
// USER_HELPER_TARGETS (user-helper) produce for every (component, platform,
// arch) triple this server can register locally — see the cross-check list
// in the D1 unit tests. It is the preferred source of truth for those
// shapes; assetNameFromDownloadUrl(downloadUrl) remains the fallback for
// every other (component, platform) combination, INCLUDING component=
// "helper" (see that branch below for why it always falls through) and the
// GitHub-sourced case, so behavior for BINARY_SOURCE=github rows is
// unchanged.
export function canonicalReleaseAssetName(
  component: string,
  platform: string,
  architecture: string,
): string | null {
  // DB / manifest platform values use "macos"; on-disk/release asset
  // filenames use Go's GOOS naming, "darwin".
  const goos = platform === "macos" ? "darwin" : platform;
  const isKnownArch = architecture === "amd64" || architecture === "arm64";
  if (!isKnownArch) return null;

  if (component === "agent" || component === "watchdog" || component === "backup") {
    if (goos !== "windows" && goos !== "linux" && goos !== "darwin") return null;
    const suffix = goos === "windows" ? ".exe" : "";
    return `breeze-${component}-${goos}-${architecture}${suffix}`;
  }

  // breeze-user-helper (#816/#1878): Windows-only GUI-subsystem sibling of
  // breeze-agent.
  if (component === "user-helper") {
    if (goos !== "windows") return null;
    return `breeze-user-helper-windows-${architecture}.exe`;
  }

  // component="helper" (the Tauri Helper app) has NO canonical raw-binary
  // name here: its real registration is HELPER_TARGETS
  // (services/binarySync.ts, ~line 59) — windows -> breeze-helper-windows.msi,
  // darwin (amd64 AND arm64, same file) -> breeze-helper-macos.dmg, linux ->
  // breeze-helper-linux.AppImage. That shape is per-OS, not per-arch, and
  // isn't derivable from (component, platform, arch) alone (darwin/amd64 and
  // darwin/arm64 both resolve to the SAME asset name). An earlier version of
  // this function returned "breeze-desktop-helper-darwin-<arch>" for
  // component="helper" — that is a DIFFERENT artifact (the raw Mach-O binary
  // bundled inside the agent .pkg, never its own agentVersions row) and,
  // being non-null, wrongly WON over the correct URL-basename fallback for
  // real BINARY_SOURCE=github helper rows, which would have 409'd them.
  // Falling through to the final `return null` below lets
  // assetNameFromDownloadUrl(downloadUrl) resolve "helper" instead, which is
  // correct for every helper row that exists today.
  return null;
}

// Server-origin discovery for handing agents a download URL that matches
// their configured control-plane host. The agent's downloadFromURL enforces
// host equality with its ServerURL to prevent leaking the bearer token to a
// third-party origin (e.g. github.com). When PUBLIC_API_URL is set, the
// API rewrites the response's downloadUrl to a server-relative path; the
// existing /api/v1/agents/download/:os/:arch route then 302s to github (or
// streams locally) — credentials stay on the trusted origin. Issue #646.
function getServerOriginForDownloadResponse(): string | null {
  const candidate =
    process.env.PUBLIC_API_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.BREEZE_SERVER?.trim();
  if (!candidate) {
    return null;
  }
  return candidate.replace(/\/+$/, "");
}

// Maps the DB platform value (which uses "macos") to the Go GOOS value that
// the /api/v1/agents/download/:os/:arch route expects (which uses "darwin").
function dbPlatformToRouteOs(dbPlatform: string): string {
  return dbPlatform === "macos" ? "darwin" : dbPlatform;
}

// Construct the server-relative download URL the agent should use. Applies to
// component=agent, helper, user-helper, watchdog, and backup: all are pulled
// by the agent's verified downloader (updater.downloadFromURL), which enforces host
// equality with the agent's configured ServerURL. Without this rewrite the
// response would hand back the canonical github.com asset URL, which the agent
// rejects — and, more importantly, the helper used to be fetched via an
// UNVERIFIED redirect to that CDN and run as SYSTEM/root (the HIGH-severity RCE
// fixed alongside this). Rewriting to the control-plane origin keeps the
// download inside the trusted origin; the existing /download[/...]/:os/:arch
// route then 302s to github server-side, and the signed-manifest SHA-256 binds
// the bytes either way. Returns null to signal "fall back to the canonical
// (github) URL" (components without a server-relative route, or no origin).
//
// NOTE: `user-helper` (breeze-user-helper.exe, the GUI-subsystem agent sibling)
// is distinct from `helper` (the Tauri Helper app). It has its own route; it
// was omitted here originally, so the agent fell back to the github URL and the
// host check rejected the user-helper auto-update (#1878, sibling of #646).
function buildServerRelativeAgentDownloadUrl(
  dbPlatform: string,
  architecture: string,
  component: string,
): string | null {
  if (
    component !== "agent" &&
    component !== "helper" &&
    component !== "user-helper" &&
    component !== "watchdog" &&
    component !== "backup"
  ) {
    return null;
  }
  const origin = getServerOriginForDownloadResponse();
  if (!origin) {
    return null;
  }
  const os = dbPlatformToRouteOs(dbPlatform);
  if (component === "helper") {
    return `${origin}/api/v1/agents/download/helper/${os}/${architecture}`;
  }
  if (component === "user-helper") {
    return `${origin}/api/v1/agents/download/user-helper/${os}/${architecture}`;
  }
  if (component === "watchdog") {
    return `${origin}/api/v1/agents/download/watchdog/${os}/${architecture}`;
  }
  if (component === "backup") {
    return `${origin}/api/v1/agents/download/backup/${os}/${architecture}`;
  }
  return `${origin}/api/v1/agents/download/${os}/${architecture}`;
}

export async function validateReleaseManifest(args: {
  manifest: string | null | undefined;
  signature: string | null | undefined;
  version: string;
  platform: string;
  arch: string;
  component: string;
  downloadUrl: string;
  checksum: string;
  fileSize?: number | bigint | null;
  signingKeyId?: string | null;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!args.manifest || !args.signature) {
    return { ok: false, reason: "signed_release_manifest_required" };
  }

  let parsed: ReleaseManifest & ReleaseArtifactManifest;
  try {
    parsed = JSON.parse(args.manifest) as ReleaseManifest &
      ReleaseArtifactManifest;
  } catch {
    return { ok: false, reason: "invalid_release_manifest_json" };
  }

  if (parsed.schemaVersion === 1 && Array.isArray(parsed.assets)) {
    // Task 2 (#3836) key-ID-aware guard: verifyReleaseArtifactManifestAsset
    // below only ever trusts the OFFICIAL configured key set
    // (getConfiguredPublicKeys) — it has no DB-deployment-key code path, so
    // a schema-v1 row can only ever validly prove OFFICIAL provenance. A
    // `deploy-*` (or other non-official) signingKeyId reaching this branch
    // can never be honestly satisfied: an official signature wouldn't
    // verify against an agent's TOFU-pinned deploy key either, so accepting
    // it here would just be a claim the agent itself would reject. Reject
    // before even asking whether the signature verifies, since no outcome
    // of that check could make the ID claim true. No row
    // registerFromOfficialManifest/getReleaseAssetMetadata (binarySync.ts)
    // produces today hits this — it's defense in depth against a
    // future/corrupted row.
    const claimedKeyId = args.signingKeyId?.trim();
    if (claimedKeyId && claimedKeyId !== OFFICIAL_MANIFEST_SIGNING_KEY_ID) {
      return { ok: false, reason: "invalid_release_manifest_signature" };
    }

    // D1 (#3836): canonical resolution wins when the (component, platform,
    // arch) shape is known — the URL basename stays only as a fallback for
    // shapes canonicalReleaseAssetName doesn't recognize (e.g. a genuine
    // GitHub-sourced downloadUrl). See canonicalReleaseAssetName's own
    // comment for why the URL-basename-only approach was wrong for
    // BINARY_SOURCE=local rows.
    const assetName =
      canonicalReleaseAssetName(args.component, args.platform, args.arch) ??
      assetNameFromDownloadUrl(args.downloadUrl);
    if (!assetName) {
      return { ok: false, reason: "release_manifest_metadata_mismatch" };
    }

    try {
      const verified = await verifyReleaseArtifactManifestAsset({
        assetName,
        manifestBytes: Buffer.from(args.manifest, "utf8"),
        signatureBytes: Buffer.from(args.signature, "utf8"),
        expectedRelease: args.version.startsWith("v")
          ? args.version
          : `v${args.version}`,
      });
      const expectedSize = args.fileSize == null ? null : Number(args.fileSize);
      const sizeMatches =
        expectedSize == null || verified.size === expectedSize;
      if (verified.sha256 !== args.checksum || !sizeMatches) {
        return { ok: false, reason: "release_manifest_metadata_mismatch" };
      }
      return { ok: true };
    } catch (err) {
      // D3 (#3836): verifyReleaseArtifactManifestAsset verifies the Ed25519
      // signature FIRST, unconditionally, before it ever attempts an asset
      // lookup or a distributability check (releaseArtifactManifest.ts) — so
      // reaching either typed branch below already implies a signature that
      // verified. That preserves the #641 anti-probing property: a reason
      // more specific than "signature invalid" is only ever returned after a
      // real signature check passed. Never leak `err.message` to the agent
      // response body — log it server-side only.
      if (err instanceof ReleaseAssetNotDistributableError) {
        console.error(
          "[agentVersions] Release asset not distributable:",
          err.message,
        );
        return { ok: false, reason: "release_asset_not_distributable" };
      }
      if (err instanceof ReleaseManifestAssetLookupError) {
        console.error(
          "[agentVersions] Release manifest asset lookup failed:",
          err.message,
        );
        return { ok: false, reason: "release_manifest_asset_lookup_failed" };
      }
      if (err instanceof ReleaseManifestSignatureError) {
        console.error(
          "[agentVersions] Release manifest signature verification failed:",
          err.message,
        );
        return { ok: false, reason: "invalid_release_manifest_signature" };
      }
      // Any unrecognized error shape — fail closed to the least-specific
      // reason rather than assume it's safe to be more specific.
      console.error(
        "[agentVersions] Unrecognized error verifying release manifest asset, failing closed:",
        err instanceof Error ? err.message : err,
      );
      return { ok: false, reason: "invalid_release_manifest_signature" };
    }
  }

  // Verify the signature BEFORE comparing metadata. If we leak the more
  // specific `release_manifest_metadata_mismatch` reason to a caller whose
  // signature was forged, we let attackers probe which DB-row field would
  // have mismatched without ever holding a valid signing key (#641).
  //
  // Task 2 (#3836): key-ID-aware dispatch replaces the unconditional
  // whole-set verifyEd25519ManifestSignature call — see
  // verifyManifestSignatureForSigningKeyId's own comment for the exact
  // binding this enforces.
  if (
    !(await verifyManifestSignatureForSigningKeyId(
      args.manifest,
      args.signature,
      args.signingKeyId,
    ))
  ) {
    return { ok: false, reason: "invalid_release_manifest_signature" };
  }

  const expectedSize = args.fileSize == null ? null : Number(args.fileSize);
  const sizeMatches = expectedSize == null || parsed.size === expectedSize;

  if (
    parsed.version !== args.version ||
    parsed.platform !== args.platform ||
    parsed.arch !== args.arch ||
    parsed.component !== args.component ||
    parsed.url !== args.downloadUrl ||
    parsed.checksum !== args.checksum ||
    !sizeMatches
  ) {
    return { ok: false, reason: "release_manifest_metadata_mismatch" };
  }

  return { ok: true };
}

// GET /agent-versions/latest - Get latest version info for platform/arch
// This endpoint is public (no auth) so agents can check for updates
agentVersionRoutes.get(
  "/latest",
  zValidator("query", latestQuerySchema),
  async (c) => {
    const { platform: rawPlatform, arch, component } = c.req.valid("query");
    const platform = PLATFORM_MAP[rawPlatform] ?? rawPlatform;

    const [latestVersion] = await db
      .select({
        version: agentVersions.version,
        downloadUrl: agentVersions.downloadUrl,
        checksum: agentVersions.checksum,
        releaseManifest: agentVersions.releaseManifest,
        manifestSignature: agentVersions.manifestSignature,
        signingKeyId: agentVersions.signingKeyId,
        fileSize: agentVersions.fileSize,
        releaseNotes: agentVersions.releaseNotes,
      })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.platform, platform),
          eq(agentVersions.architecture, arch),
          eq(agentVersions.component, component),
          eq(agentVersions.isLatest, true),
          // Each server only serves its own build edition (default
          // self-host, unchanged for every deployment that never sets
          // BINARY_EDITION).
          eq(agentVersions.edition, getBinaryEdition()),
        ),
      )
      // MUST match the tiebreak in services/promotedAgentVersion.ts, which
      // resolves the bytes these checksums are verified against (#3499).
      // Nothing enforces one promoted row per (component, platform, arch,
      // edition) — the invariant is maintained by demote-then-insert, not a
      // unique constraint — so if only one of the two ordered, a duplicate
      // isLatest row would make them select DIFFERENT rows and hand out a
      // checksum for a release the download route does not serve. That is
      // #3499 all over again, and silent.
      .orderBy(desc(agentVersions.createdAt))
      .limit(1);

    if (!latestVersion) {
      return c.json(
        {
          error: "No version found for the specified platform and architecture",
        },
        404,
      );
    }

    const serverRelativeUrl = buildServerRelativeAgentDownloadUrl(
      platform,
      arch,
      component,
    );

    return c.json({
      version: latestVersion.version,
      // Server-relative URL when PUBLIC_API_URL is set (hosted SaaS); the
      // existing /api/v1/agents/download/:os/:arch route redirects to github
      // or serves locally. Otherwise fall back to the canonical URL stored
      // in agent_versions. Issue #646.
      downloadUrl: serverRelativeUrl ?? latestVersion.downloadUrl,
      checksum: latestVersion.checksum,
      releaseManifest: latestVersion.releaseManifest,
      manifestSignature: latestVersion.manifestSignature,
      signingKeyId: latestVersion.signingKeyId,
      fileSize: latestVersion.fileSize ? Number(latestVersion.fileSize) : null,
      releaseNotes: latestVersion.releaseNotes,
    });
  },
);

// GET /agent-versions/:version/download - Get download URL for specific version
// This endpoint is public (no auth) so agents can download updates
agentVersionRoutes.get(
  "/:version/download",
  zValidator("param", downloadParamsSchema),
  zValidator("query", downloadQuerySchema),
  async (c) => {
    const { version } = c.req.valid("param");
    const { platform: rawPlatform, arch, component } = c.req.valid("query");
    const platform = PLATFORM_MAP[rawPlatform] ?? rawPlatform;

    const [versionInfo] = await db
      .select({
        version: agentVersions.version,
        platform: agentVersions.platform,
        architecture: agentVersions.architecture,
        component: agentVersions.component,
        downloadUrl: agentVersions.downloadUrl,
        checksum: agentVersions.checksum,
        fileSize: agentVersions.fileSize,
        releaseManifest: agentVersions.releaseManifest,
        manifestSignature: agentVersions.manifestSignature,
        signingKeyId: agentVersions.signingKeyId,
        isLatest: agentVersions.isLatest,
      })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.version, version),
          eq(agentVersions.platform, platform),
          eq(agentVersions.architecture, arch),
          eq(agentVersions.component, component),
          // Each server only serves its own build edition.
          eq(agentVersions.edition, getBinaryEdition()),
        ),
      )
      .limit(1);

    if (!versionInfo) {
      return c.json(
        {
          error:
            "Version not found for the specified platform and architecture",
        },
        404,
      );
    }

    const manifestCheck = await validateReleaseManifest({
      manifest: versionInfo.releaseManifest,
      signature: versionInfo.manifestSignature,
      version: versionInfo.version,
      platform: versionInfo.platform,
      arch: versionInfo.architecture,
      component: versionInfo.component,
      downloadUrl: versionInfo.downloadUrl,
      checksum: versionInfo.checksum,
      fileSize: versionInfo.fileSize,
      signingKeyId: versionInfo.signingKeyId,
    });
    if (!manifestCheck.ok) {
      return c.json(
        {
          error: "Release manifest is not trusted",
          reason: manifestCheck.reason,
        },
        409,
      );
    }

    // breeze-backup is version-slaved to the agent but requested by EXACT
    // version (unlike agent/helper/watchdog, which always want "latest").
    // The versionless /download/backup/:os/:arch route can only ever serve ONE
    // release, so rewriting a NON-servable backup version to it would hand an
    // agent healing to an older pinned version different bytes than it asked
    // for; the updater verifies checksum+manifest against the pinned version
    // and fails safe, but can never actually heal. So for component=backup
    // only, rewrite exclusively when this row IS the one that route serves.
    //
    // WHICH row that is changed in #3499, so rather than restate the route's
    // rule here and let the two drift, ask the route's OWN resolver what it
    // will serve and compare. Restating it is what made this guard subtly
    // wrong twice: it used to hardcode "the env version", correct only while
    // the route resolved BINARY_VERSION/BREEZE_VERSION; a plain `isLatest`
    // test would be equally wrong for a never-synced deployment, where no row
    // is promoted and the route legitimately falls back to the env version.
    // Deriving it keeps both cases right by construction.
    //
    // A resolver fault throws rather than guessing, and this endpoint is
    // already DB-dependent (it just read versionInfo), so it surfaces as a 5xx
    // instead of a rewrite that might not match. Every other component keeps
    // the unconditional rewrite.
    let backupVersionIsServableByVersionlessRoute = true;
    if (versionInfo.component === "backup") {
      // Mirror the route's own BINARY_SOURCE branch. Only the github branch
      // resolves the promoted row; in local mode the route streams ONE
      // unversioned file from disk/S3 whose version is the binaries-volume
      // build — i.e. the env version, which is what this guard has always
      // compared against there. Deriving the promoted row in local mode would
      // withhold the rewrite (and cost a query) whenever the promoted row and
      // the disk build differ, e.g. AGENT_AUTO_PROMOTE=false or after a
      // rollback via POST /agent-versions/promote.
      const versionlessRouteServes =
        getBinarySource() === "github"
          ? ((await getPromotedComponentVersion(
              "backup",
              dbPlatformToRouteOs(versionInfo.platform),
              versionInfo.architecture,
            )) ?? getGithubReleaseVersion())
          : getGithubReleaseVersion();
      backupVersionIsServableByVersionlessRoute =
        versionInfo.version === versionlessRouteServes;
    }

    const serverRelativeUrl = backupVersionIsServableByVersionlessRoute
      ? buildServerRelativeAgentDownloadUrl(
          versionInfo.platform,
          versionInfo.architecture,
          versionInfo.component,
        )
      : null;

    // Return JSON with download URL, checksum, and signed release manifest.
    // url is server-relative when PUBLIC_API_URL is set so the agent's
    // host check passes; the binary itself is served via the existing
    // /api/v1/agents/download/:os/:arch route (302 to github in
    // BINARY_SOURCE=github mode, local stream otherwise). Issue #646.
    return c.json({
      url: serverRelativeUrl ?? versionInfo.downloadUrl,
      checksum: versionInfo.checksum,
      manifest: versionInfo.releaseManifest,
      manifestSignature: versionInfo.manifestSignature,
      signingKeyId: versionInfo.signingKeyId,
    });
  },
);

// POST /agent-versions - Create new agent version (admin only)
agentVersionRoutes.post(
  "/",
  authMiddleware,
  requireScope("system"),
  requireAgentVersionAdmin,
  requireMfa(),
  zValidator("json", createVersionSchema),
  async (c) => {
    const auth = c.get("auth");
    const data = c.req.valid("json");
    const edition = data.edition ?? getBinaryEdition();

    // Reject a row that GET /:version/download would refuse to serve, BEFORE
    // any write. `validateReleaseManifest` is mandatory on the serving path
    // (line ~526), and there is no route that can complete a half-registered
    // row afterwards — so a row failing it here is dead on arrival: every
    // agent pointed at it 409s on every heartbeat, forever, with no terminal
    // state. Issue #3544 is exactly that: manifest-less rows were accepted
    // silently at write time and only surfaced as thousands of opaque 409s.
    // The columns being nullable in the schema while the serving path treats
    // them as mandatory is the inconsistency; this closes it at the door.
    //
    // Ordering matters: this runs before the isLatest demotion below.
    // Demoting first and validating later would strip the last WORKING
    // upgrade target off the fleet on behalf of a row we are about to
    // refuse — turning a rejected request into an outage.
    const createManifestCheck = await validateReleaseManifest({
      manifest: data.releaseManifest,
      signature: data.manifestSignature,
      version: data.version,
      platform: data.platform,
      arch: data.architecture,
      component: data.component,
      downloadUrl: data.downloadUrl,
      checksum: data.checksum,
      fileSize: data.fileSize,
      signingKeyId: data.signingKeyId,
    });
    if (!createManifestCheck.ok) {
      return c.json(
        {
          error: "Release manifest is not trusted",
          reason: createManifestCheck.reason,
        },
        422,
      );
    }

    // If this version is marked as latest, unset isLatest for other versions
    // with the same platform/architecture/component/edition. Scoped by
    // edition too — otherwise promoting a "self-host" row could demote a
    // coexisting "hosted" row's isLatest for the same platform/arch/component.
    if (data.isLatest) {
      await db
        .update(agentVersions)
        .set({ isLatest: false })
        .where(
          and(
            eq(agentVersions.platform, data.platform),
            eq(agentVersions.architecture, data.architecture),
            eq(agentVersions.component, data.component),
            eq(agentVersions.edition, edition),
            eq(agentVersions.isLatest, true),
          ),
        );
    }

    const [newVersion] = await db
      .insert(agentVersions)
      .values({
        version: data.version,
        platform: data.platform,
        architecture: data.architecture,
        downloadUrl: data.downloadUrl,
        checksum: data.checksum,
        releaseManifest: data.releaseManifest,
        manifestSignature: data.manifestSignature,
        signingKeyId: data.signingKeyId,
        fileSize: data.fileSize ? BigInt(data.fileSize) : null,
        releaseNotes: data.releaseNotes,
        isLatest: data.isLatest ?? false,
        component: data.component,
        edition,
      })
      .returning();
    if (!newVersion) {
      return c.json({ error: "Failed to create agent version" }, 500);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: "agent_version.create",
      resourceType: "agent_version",
      resourceId: newVersion.id,
      resourceName: newVersion.version,
      details: {
        platform: newVersion.platform,
        architecture: newVersion.architecture,
      },
    });

    return c.json(
      {
        id: newVersion.id,
        version: newVersion.version,
        platform: newVersion.platform,
        architecture: newVersion.architecture,
        downloadUrl: newVersion.downloadUrl,
        checksum: newVersion.checksum,
        releaseManifest: newVersion.releaseManifest,
        manifestSignature: newVersion.manifestSignature,
        signingKeyId: newVersion.signingKeyId,
        fileSize: newVersion.fileSize ? Number(newVersion.fileSize) : null,
        releaseNotes: newVersion.releaseNotes,
        isLatest: newVersion.isLatest,
        edition: newVersion.edition,
        createdAt: newVersion.createdAt,
      },
      201,
    );
  },
);

// POST /agent-versions/sync-github - Sync latest release from GitHub (admin only)
// Optional query param ?version=v0.11.3-rc.1 to sync a specific (e.g. prerelease) version
agentVersionRoutes.post(
  "/sync-github",
  authMiddleware,
  requireScope("system"),
  requireAgentVersionAdmin,
  requireMfa(),
  async (c) => {
    const auth = c.get("auth");
    const requestedVersion = c.req.query("version");

    try {
      const result = await syncFromGitHub(requestedVersion);

      writeRouteAudit(c, {
        orgId: auth.orgId,
        action: "agent_version.sync_github",
        resourceType: "agent_version",
        resourceId: result.version,
        resourceName: `v${result.version}`,
        details: { targets: result.synced, failed: result.failed },
      });

      // Partial failures are isolated per component (#816) but must not be
      // invisible: surface them in the response body so an operator sees a
      // short registration instead of assuming a clean sync.
      return c.json(result);
    } catch (err) {
      // A guard refusal (#4262) is not a routine sync failure: it means the
      // release host resolved to a private/loopback/link-local address, which
      // is a DNS-hijack signal. Left in the generic branch it became a 422 with
      // no server-side trace at all — no log, no Sentry (writeRouteAudit only
      // runs on success), so nobody could reconstruct it later. Log and
      // escalate, and answer 502: the fault is upstream, not in the request.
      // The response deliberately does NOT echo err.resolvedIps — internal
      // addresses stay in the server-side log.
      if (err instanceof SsrfBlockedError) {
        console.error(
          `[agentVersions] sync-github REFUSED by the SSRF guard (host=${err.hostname ?? "?"}, resolved=${err.resolvedIps?.join(", ") ?? "n/a"})`,
        );
        captureException(err, c, {
          release_sync_failure_reason: "ssrf-blocked",
          release_sync_context: "sync-github-route",
        });
        return c.json(
          {
            error:
              "Release sync refused: the release host resolved to a private or link-local address. Check DNS and egress on the API host.",
          },
          502,
        );
      }
      if (err instanceof ResponseTooLargeError) {
        console.error(
          `[agentVersions] sync-github aborted: response exceeded the ${err.maxBytes}-byte ceiling`,
        );
        captureException(err, c, {
          release_sync_failure_reason: "response-too-large",
          release_sync_context: "sync-github-route",
        });
        return c.json(
          {
            error: `Release sync aborted: the release host returned a body over the ${err.maxBytes}-byte limit.`,
          },
          502,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("GitHub API error") ? 502 : 422;
      console.error(`[agentVersions] sync-github failed: ${msg}`);
      return c.json({ error: msg }, status);
    }
  },
);

// GET /agent-versions - List registered versions and the currently-promoted
// fleet target per (component, platform, architecture). Platform-admin only.
// This is the operator view used to decide what to promote after a release is
// registered (with AGENT_AUTO_PROMOTE=false). Returns every registered row,
// newest-first, with an isLatest flag marking the current upgrade target.
// GET /agent-versions/pinnable — the registered agent + watchdog versions an
// org/partner admin may pin as their update target (issue #2124). Distinct from
// the platform-admin `GET /` (which exposes every component + upload metadata):
// this is a narrow, read-only picker feed available to any authenticated
// org/partner/system user configuring settings. agent_versions is a GLOBAL,
// non-tenant table, so exposing the version STRINGS carries no tenant data.
agentVersionRoutes.get(
  "/pinnable",
  authMiddleware,
  requireScope("organization", "partner", "system"),
  async (c) => {
    const rows = await db
      .select({
        version: agentVersions.version,
        component: agentVersions.component,
        isLatest: agentVersions.isLatest,
      })
      .from(agentVersions)
      // Scoped to this server's own build edition — a picker offering a
      // version string that only exists for the OTHER edition would 404 when
      // promoted (promote is edition-scoped too, see below).
      .where(eq(agentVersions.edition, getBinaryEdition()))
      .orderBy(desc(agentVersions.createdAt)); // newest-first drives the dedupe order

    // Only the two operator-facing binaries are pinnable (agent, watchdog).
    type Bucket = {
      versions: string[];
      promoted: string[];
      seen: Set<string>;
      promotedSeen: Set<string>;
    };
    const newBucket = (): Bucket => ({
      versions: [],
      promoted: [],
      seen: new Set(),
      promotedSeen: new Set(),
    });
    const buckets = { agent: newBucket(), watchdog: newBucket() };

    for (const row of rows) {
      const bucket =
        row.component === 'agent'
          ? buckets.agent
          : row.component === 'watchdog'
            ? buckets.watchdog
            : null; // skip helper/viewer/user-helper — not pinnable
      if (!bucket) continue;
      if (!bucket.seen.has(row.version)) {
        bucket.seen.add(row.version);
        bucket.versions.push(row.version);
      }
      if (row.isLatest && !bucket.promotedSeen.has(row.version)) {
        bucket.promotedSeen.add(row.version);
        bucket.promoted.push(row.version);
      }
    }

    return c.json({
      components: {
        agent: { versions: buckets.agent.versions, promoted: buckets.agent.promoted },
        watchdog: { versions: buckets.watchdog.versions, promoted: buckets.watchdog.promoted },
      },
    });
  },
);

agentVersionRoutes.get("/", platformAdminMiddleware, async (c) => {
  const rows = await db
    .select({
      id: agentVersions.id,
      version: agentVersions.version,
      platform: agentVersions.platform,
      architecture: agentVersions.architecture,
      component: agentVersions.component,
      edition: agentVersions.edition,
      isLatest: agentVersions.isLatest,
      fileSize: agentVersions.fileSize,
      releaseNotes: agentVersions.releaseNotes,
      createdAt: agentVersions.createdAt,
    })
    .from(agentVersions)
    .orderBy(desc(agentVersions.createdAt));

  return c.json({
    // Platform-admin diagnostic view: intentionally NOT filtered by this
    // server's own edition, so an operator can see both editions' registered
    // rows side by side. Contrast with /pinnable and /promote, which are
    // scoped to getBinaryEdition() because they drive actual fleet targeting.
    versions: rows.map((r) => ({
      ...r,
      fileSize: r.fileSize != null ? Number(r.fileSize) : null,
    })),
    // Convenience map: the version currently promoted (isLatest=true) for each
    // component/platform/arch tuple, so the UI can show "current target".
    promoted: rows
      .filter((r) => r.isLatest)
      .map((r) => ({
        component: r.component,
        platform: r.platform,
        architecture: r.architecture,
        version: r.version,
        edition: r.edition,
      })),
  });
});

// POST /agent-versions/promote - Explicitly promote a registered version to the
// fleet upgrade target. Platform-admin only. This is the deliberate lever that
// AGENT_AUTO_PROMOTE=false hands to operators: registration no longer auto-
// promotes, so the fleet only moves to a new version when this endpoint runs.
// Body: { version, component? }. Omitting component promotes every component of
// the version. Per affected (component, platform, architecture), the current
// isLatest=true rows are demoted and the target version's rows are promoted —
// all in a single transaction so heartbeat never observes a split target.
agentVersionRoutes.post(
  "/promote",
  platformAdminMiddleware,
  requireMfa(),
  zValidator("json", promoteSchema),
  async (c) => {
    const { version, component } = c.req.valid("json");
    const edition = getBinaryEdition();

    // Target rows for this version (optionally narrowed to one component).
    // Scoped to this server's own edition — promote only ever affects rows
    // this server actually serves, so it can never flip a coexisting other-
    // edition row's isLatest as a side effect.
    const targetRows = await db
      .select({
        component: agentVersions.component,
        platform: agentVersions.platform,
        architecture: agentVersions.architecture,
        version: agentVersions.version,
        downloadUrl: agentVersions.downloadUrl,
        checksum: agentVersions.checksum,
        fileSize: agentVersions.fileSize,
        releaseManifest: agentVersions.releaseManifest,
        manifestSignature: agentVersions.manifestSignature,
        signingKeyId: agentVersions.signingKeyId,
      })
      .from(agentVersions)
      .where(
        component
          ? and(
              eq(agentVersions.version, version),
              eq(agentVersions.component, component),
              eq(agentVersions.edition, edition),
            )
          : and(
              eq(agentVersions.version, version),
              eq(agentVersions.edition, edition),
            ),
      );

    if (targetRows.length === 0) {
      return c.json(
        {
          error: component
            ? `No registered rows for version ${version} (component=${component})`
            : `No registered rows for version ${version}`,
        },
        404,
      );
    }

    // Refuse to promote a version any of whose rows GET /:version/download
    // would reject. Promotion is what actually points the fleet at a version,
    // so an untrusted row here is the difference between a harmless
    // unreachable DB row and every device in the fleet retrying a 409 every
    // ~60s indefinitely (issue #3544).
    //
    // Rejected if ANY target row fails, not merely if all do: promotion is
    // atomic across its slots by design, and a partial promotion would split
    // the fleet — some platforms or components moved to the new version while
    // the rest stayed behind — which is the very all-or-nothing-vs-partial
    // confusion that made #3544 hard to diagnose. This also runs BEFORE the
    // demotion transaction below, so a refused promotion never strips the
    // currently-working target.
    const invalidTargets: Array<{
      component: string;
      platform: string;
      architecture: string;
      reason: string;
    }> = [];
    for (const row of targetRows) {
      const check = await validateReleaseManifest({
        manifest: row.releaseManifest,
        signature: row.manifestSignature,
        version: row.version,
        platform: row.platform,
        arch: row.architecture,
        component: row.component,
        downloadUrl: row.downloadUrl,
        checksum: row.checksum,
        fileSize: row.fileSize,
        signingKeyId: row.signingKeyId,
      });
      if (!check.ok) {
        invalidTargets.push({
          component: row.component,
          platform: row.platform,
          architecture: row.architecture,
          reason: check.reason,
        });
      }
    }
    if (invalidTargets.length > 0) {
      return c.json(
        {
          error: "Release manifest is not trusted",
          reason: invalidTargets[0]!.reason,
          invalidTargets,
        },
        409,
      );
    }

    // Distinct (component, platform, architecture) tuples affected by this
    // promotion. Each tuple is an independent isLatest "slot".
    const tuples = Array.from(
      new Map(
        targetRows.map((r) => [
          `${r.component}|${r.platform}|${r.architecture}`,
          r,
        ]),
      ).values(),
    );

    const result = await db.transaction(async (tx) => {
      const demoted: Array<{
        component: string;
        platform: string;
        architecture: string;
        version: string;
      }> = [];

      for (const t of tuples) {
        // Capture the version currently promoted in this slot (the prior
        // target) before demoting it, so the response/audit records what the
        // fleet was moving FROM.
        const [prior] = await tx
          .select({ version: agentVersions.version })
          .from(agentVersions)
          .where(
            and(
              eq(agentVersions.component, t.component),
              eq(agentVersions.platform, t.platform),
              eq(agentVersions.architecture, t.architecture),
              eq(agentVersions.edition, edition),
              eq(agentVersions.isLatest, true),
            ),
          )
          .limit(1);

        if (prior && prior.version !== version) {
          demoted.push({
            component: t.component,
            platform: t.platform,
            architecture: t.architecture,
            version: prior.version,
          });
        }

        // Demote the current target for this slot.
        await tx
          .update(agentVersions)
          .set({ isLatest: false })
          .where(
            and(
              eq(agentVersions.component, t.component),
              eq(agentVersions.platform, t.platform),
              eq(agentVersions.architecture, t.architecture),
              eq(agentVersions.edition, edition),
              eq(agentVersions.isLatest, true),
            ),
          );

        // Promote the requested version for this slot.
        await tx
          .update(agentVersions)
          .set({ isLatest: true })
          .where(
            and(
              eq(agentVersions.version, version),
              eq(agentVersions.component, t.component),
              eq(agentVersions.platform, t.platform),
              eq(agentVersions.architecture, t.architecture),
              eq(agentVersions.edition, edition),
            ),
          );
      }

      return {
        promoted: tuples.map((t) => ({
          component: t.component,
          platform: t.platform,
          architecture: t.architecture,
          version,
        })),
        demoted,
      };
    });

    const components = Array.from(new Set(tuples.map((t) => t.component)));
    writeRouteAudit(c, {
      orgId: null,
      action: "agent_version.promote",
      resourceType: "agent_version",
      resourceId: version,
      resourceName: version,
      details: {
        version,
        component: component ?? "all",
        components,
        promotedCount: result.promoted.length,
        demotedTargets: result.demoted,
      },
    });

    return c.json(result);
  },
);
