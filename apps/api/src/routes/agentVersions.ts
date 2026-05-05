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

function getUpdateManifestPublicKeys(): Buffer[] {
  const configured = [
    process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS,
    process.env.BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(",");

  return configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Buffer.from(value, "base64"))
    .filter((key) => key.length === 32);
}

function verifyEd25519ManifestSignature(
  manifest: string,
  signature: string,
): boolean {
  const keys = getUpdateManifestPublicKeys();
  if (keys.length === 0) {
    return true;
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

async function validateReleaseManifest(args: {
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

  if (!verifyEd25519ManifestSignature(args.manifest, args.signature)) {
    return { ok: false, reason: "invalid_release_manifest_signature" };
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

    return c.json({
      version: latestVersion.version,
      downloadUrl: latestVersion.downloadUrl,
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

    // Return JSON with download URL, checksum, and signed release manifest.
    return c.json({
      url: versionInfo.downloadUrl,
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
