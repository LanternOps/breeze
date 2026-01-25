import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { agentVersions } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const agentVersionRoutes = new Hono();

// Validation schemas
const platformEnum = z.enum(['windows', 'macos', 'linux']);
const architectureEnum = z.enum(['amd64', 'arm64']);

const latestQuerySchema = z.object({
  platform: platformEnum,
  arch: architectureEnum
});

const downloadParamsSchema = z.object({
  version: z.string().min(1).max(20)
});

const downloadQuerySchema = z.object({
  platform: platformEnum,
  arch: architectureEnum
});

const createVersionSchema = z.object({
  version: z.string().min(1).max(20),
  platform: platformEnum,
  architecture: architectureEnum,
  downloadUrl: z.string().url(),
  checksum: z.string().length(64), // SHA256 is 64 hex characters
  fileSize: z.number().int().positive().optional(),
  releaseNotes: z.string().optional(),
  isLatest: z.boolean().optional().default(false)
});

// GET /agent-versions/latest - Get latest version info for platform/arch
// This endpoint is public (no auth) so agents can check for updates
agentVersionRoutes.get(
  '/latest',
  zValidator('query', latestQuerySchema),
  async (c) => {
    const { platform, arch } = c.req.valid('query');

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
    const { platform, arch } = c.req.valid('query');

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
          eq(agentVersions.architecture, arch)
        )
      )
      .limit(1);

    if (!versionInfo) {
      return c.json({ error: 'Version not found for the specified platform and architecture' }, 404);
    }

    // Set checksum header for verification
    c.header('X-Checksum', versionInfo.checksum);

    // Redirect to download URL
    return c.redirect(versionInfo.downloadUrl, 302);
  }
);

// POST /agent-versions - Create new agent version (admin only)
agentVersionRoutes.post(
  '/',
  authMiddleware,
  requireScope('system'),
  zValidator('json', createVersionSchema),
  async (c) => {
    const data = c.req.valid('json');

    // If this version is marked as latest, unset isLatest for other versions
    // with the same platform/architecture
    if (data.isLatest) {
      await db
        .update(agentVersions)
        .set({ isLatest: false })
        .where(
          and(
            eq(agentVersions.platform, data.platform),
            eq(agentVersions.architecture, data.architecture),
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
        isLatest: data.isLatest ?? false
      })
      .returning();

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
