import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { agentVersions } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { syncFromGitHub } from '../services/binarySync';

// Map Go GOOS / user-facing platform names to DB platform names
const PLATFORM_MAP: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
  windows: 'windows'
};

export const agentVersionRoutes = new Hono();

// Validation schemas
const platformEnum = z.enum(['windows', 'macos', 'linux', 'darwin']);
const architectureEnum = z.enum(['amd64', 'arm64']);

const latestQuerySchema = z.object({
  platform: platformEnum,
  arch: architectureEnum,
  component: z.enum(['agent', 'helper', 'viewer']).optional().default('agent')
});

const downloadParamsSchema = z.object({
  version: z.string().min(1).max(20)
});

const downloadQuerySchema = z.object({
  platform: platformEnum,
  arch: architectureEnum,
  component: z.enum(['agent', 'helper', 'viewer']).optional().default('agent')
});

const createVersionSchema = z.object({
  version: z.string().min(1).max(20),
  platform: platformEnum,
  architecture: architectureEnum,
  downloadUrl: z.string().url(),
  checksum: z.string().length(64), // SHA256 is 64 hex characters
  fileSize: z.number().int().positive().optional(),
  releaseNotes: z.string().optional(),
  isLatest: z.boolean().optional().default(false),
  component: z.enum(['agent', 'helper', 'viewer']).optional().default('agent')
});

// GET /agent-versions/latest - Get latest version info for platform/arch
// This endpoint is public (no auth) so agents can check for updates
agentVersionRoutes.get(
  '/latest',
  zValidator('query', latestQuerySchema),
  async (c) => {
    const { platform: rawPlatform, arch, component } = c.req.valid('query');
    const platform = PLATFORM_MAP[rawPlatform] ?? rawPlatform;

    const [latestVersion] = await db
      .select({
        version: agentVersions.version,
        downloadUrl: agentVersions.downloadUrl,
        checksum: agentVersions.checksum,
        fileSize: agentVersions.fileSize,
        releaseNotes: agentVersions.releaseNotes
      })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.platform, platform),
          eq(agentVersions.architecture, arch),
          eq(agentVersions.component, component),
          eq(agentVersions.isLatest, true)
        )
      )
      .limit(1);

    if (!latestVersion) {
      return c.json({ error: 'No version found for the specified platform and architecture' }, 404);
    }

    return c.json({
      version: latestVersion.version,
      downloadUrl: latestVersion.downloadUrl,
      checksum: latestVersion.checksum,
      fileSize: latestVersion.fileSize ? Number(latestVersion.fileSize) : null,
      releaseNotes: latestVersion.releaseNotes
    });
  }
);

// GET /agent-versions/:version/download - Get download URL for specific version
// This endpoint is public (no auth) so agents can download updates
agentVersionRoutes.get(
  '/:version/download',
  zValidator('param', downloadParamsSchema),
  zValidator('query', downloadQuerySchema),
  async (c) => {
    const { version } = c.req.valid('param');
    const { platform: rawPlatform, arch, component } = c.req.valid('query');
    const platform = PLATFORM_MAP[rawPlatform] ?? rawPlatform;

    const [versionInfo] = await db
      .select({
        downloadUrl: agentVersions.downloadUrl,
        checksum: agentVersions.checksum
      })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.version, version),
          eq(agentVersions.platform, platform),
          eq(agentVersions.architecture, arch),
          eq(agentVersions.component, component)
        )
      )
      .limit(1);

    if (!versionInfo) {
      return c.json({ error: 'Version not found for the specified platform and architecture' }, 404);
    }

    // Return JSON with download URL and checksum (avoids lost headers on redirect)
    return c.json({
      url: versionInfo.downloadUrl,
      checksum: versionInfo.checksum
    });
  }
);

// POST /agent-versions - Create new agent version (admin only)
agentVersionRoutes.post(
  '/',
  authMiddleware,
  requireScope('system'),
  zValidator('json', createVersionSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

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
            eq(agentVersions.isLatest, true)
          )
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
        fileSize: data.fileSize ? BigInt(data.fileSize) : null,
        releaseNotes: data.releaseNotes,
        isLatest: data.isLatest ?? false,
        component: data.component
      })
      .returning();
    if (!newVersion) {
      return c.json({ error: 'Failed to create agent version' }, 500);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'agent_version.create',
      resourceType: 'agent_version',
      resourceId: newVersion.id,
      resourceName: newVersion.version,
      details: {
        platform: newVersion.platform,
        architecture: newVersion.architecture
      }
    });

    return c.json({
      id: newVersion.id,
      version: newVersion.version,
      platform: newVersion.platform,
      architecture: newVersion.architecture,
      downloadUrl: newVersion.downloadUrl,
      checksum: newVersion.checksum,
      fileSize: newVersion.fileSize ? Number(newVersion.fileSize) : null,
      releaseNotes: newVersion.releaseNotes,
      isLatest: newVersion.isLatest,
      createdAt: newVersion.createdAt
    }, 201);
  }
);

// POST /agent-versions/sync-github - Sync latest release from GitHub (admin only)
// Optional query param ?version=v0.11.3-rc.1 to sync a specific (e.g. prerelease) version
agentVersionRoutes.post(
  '/sync-github',
  authMiddleware,
  requireScope('system'),
  async (c) => {
    const auth = c.get('auth');
    const requestedVersion = c.req.query('version');

    try {
      const result = await syncFromGitHub(requestedVersion);

      writeRouteAudit(c, {
        orgId: auth.orgId,
        action: 'agent_version.sync_github',
        resourceType: 'agent_version',
        resourceId: result.version,
        resourceName: `v${result.version}`,
        details: { targets: result.synced }
      });

      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('GitHub API error') ? 502 : 422;
      return c.json({ error: msg }, status);
    }
  }
);
