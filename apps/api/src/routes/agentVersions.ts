import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentVersions } from "../db/schema";
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
} from "../middleware/auth";
import { writeRouteAudit } from "../services/auditEvents";
import { syncFromGitHub } from "../services/binarySync";
import { PERMISSIONS } from "../services/permissions";
import { verifyReleaseArtifactManifestAsset } from "../services/releaseArtifactManifest";
import { getActivePublicKeys as getActiveDeploymentSigningPubKeys } from "../services/manifestSigning";

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

const latestQuerySchema = z.object({
  platform: platformEnum,
  arch: architectureEnum,
  component: z.enum(["agent", "helper", "viewer"]).optional().default("agent"),
});

const downloadParamsSchema = z.object({
  version: z.string().min(1).max(20),
});

const downloadQuerySchema = z.object({
  platform: platformEnum,
  arch: architectureEnum,
  component: z.enum(["agent", "helper", "viewer"]).optional().default("agent"),
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
  component: z.enum(["agent", "helper", "viewer"]).optional().default("agent"),
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
 *
 * Exported so unit tests can exercise the empty-keyset behavior directly.
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
    return false;
  }
  if (signatureBytes.length !== 64) {
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

// Construct the server-relative download URL the agent should use. Only
// applies to component=agent today — helper/viewer auto-update flows have
// their own update mechanisms and aren't served through the agent download
// route. Returns null to signal "fall back to the canonical (github) URL".
function buildServerRelativeAgentDownloadUrl(
  dbPlatform: string,
  architecture: string,
  component: string,
): string | null {
  if (component !== "agent") {
    return null;
  }
  const origin = getServerOriginForDownloadResponse();
  if (!origin) {
    return null;
  }
  const os = dbPlatformToRouteOs(dbPlatform);
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
    const assetName = assetNameFromDownloadUrl(args.downloadUrl);
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
    } catch {
      return { ok: false, reason: "invalid_release_manifest_signature" };
    }
  }

  // Verify the signature BEFORE comparing metadata. If we leak the more
  // specific `release_manifest_metadata_mismatch` reason to a caller whose
  // signature was forged, we let attackers probe which DB-row field would
  // have mismatched without ever holding a valid signing key (#641).
  if (
    !(await verifyEd25519ManifestSignature(args.manifest, args.signature, {
      allowEmptyKeysetSoftPass: true,
    }))
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
        ),
      )
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
      })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.version, version),
          eq(agentVersions.platform, platform),
          eq(agentVersions.architecture, arch),
          eq(agentVersions.component, component),
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

    const serverRelativeUrl = buildServerRelativeAgentDownloadUrl(
      versionInfo.platform,
      versionInfo.architecture,
      versionInfo.component,
    );

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

    // If this version is marked as latest, unset isLatest for other versions
    // with the same platform/architecture/component
    if (data.isLatest) {
      await db
        .update(agentVersions)
        .set({ isLatest: false })
        .where(
          and(
            eq(agentVersions.platform, data.platform),
            eq(agentVersions.architecture, data.architecture),
            eq(agentVersions.component, data.component),
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
        details: { targets: result.synced },
      });

      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("GitHub API error") ? 502 : 422;
      return c.json({ error: msg }, status);
    }
  },
);
