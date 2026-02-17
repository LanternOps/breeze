import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { agentVersions } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

const GITHUB_REPO = process.env.GITHUB_REPO || 'LanternOps/breeze';

// Map Go GOOS names to DB platform names
const PLATFORM_MAP: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
  windows: 'windows'
};

// Supported platform/arch combos (must match release matrix)
const ASSET_TARGETS = [
  { goos: 'linux', goarch: 'amd64' },
  { goos: 'darwin', goarch: 'amd64' },
  { goos: 'darwin', goarch: 'arm64' },
  { goos: 'windows', goarch: 'amd64' }
] as const;

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
agentVersionRoutes.post(
  '/sync-github',
  authMiddleware,
  requireScope('system'),
  async (c) => {
    const auth = c.get('auth');

    // Fetch latest release from GitHub
    const ghResp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'breeze-api'
        }
      }
    );
    if (!ghResp.ok) {
      return c.json({ error: `GitHub API error: ${ghResp.status}` }, 502);
    }

    const release = (await ghResp.json()) as {
      tag_name: string;
      body?: string;
      assets: Array<{
        name: string;
        browser_download_url: string;
        size: number;
      }>;
    };

    const version = release.tag_name.replace(/^v/, '');

    // Find and download checksums.txt
    const checksumAsset = release.assets.find((a) => a.name === 'checksums.txt');
    if (!checksumAsset) {
      return c.json({ error: 'No checksums.txt found in release assets' }, 422);
    }

    const checksumResp = await fetch(checksumAsset.browser_download_url, {
      headers: { 'User-Agent': 'breeze-api' }
    });
    if (!checksumResp.ok) {
      return c.json({ error: 'Failed to download checksums.txt' }, 502);
    }
    const checksumText = await checksumResp.text();

    // Parse checksums: "hash  filename\n"
    const checksums = new Map<string, string>();
    for (const line of checksumText.split('\n')) {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
      if (match && match[2] && match[1]) {
        checksums.set(match[2].trim(), match[1]);
      }
    }

    const upserted: string[] = [];

    for (const target of ASSET_TARGETS) {
      const suffix = target.goos === 'windows' ? '.exe' : '';
      const assetName = `breeze-agent-${target.goos}-${target.goarch}${suffix}`;

      const asset = release.assets.find((a) => a.name === assetName);
      if (!asset) continue;

      const checksum = checksums.get(assetName);
      if (!checksum) continue;

      const platform = PLATFORM_MAP[target.goos];
      if (!platform) continue;

      // Unset isLatest for this platform/arch combo
      await db
        .update(agentVersions)
        .set({ isLatest: false })
        .where(
          and(
            eq(agentVersions.platform, platform),
            eq(agentVersions.architecture, target.goarch),
            eq(agentVersions.isLatest, true)
          )
        );

      // Upsert version record
      await db
        .insert(agentVersions)
        .values({
          version,
          platform,
          architecture: target.goarch,
          downloadUrl: asset.browser_download_url,
          checksum,
          fileSize: BigInt(asset.size),
          releaseNotes: release.body ?? null,
          isLatest: true
        })
        .onConflictDoUpdate({
          target: [agentVersions.version, agentVersions.platform, agentVersions.architecture],
          set: {
            downloadUrl: asset.browser_download_url,
            checksum,
            fileSize: BigInt(asset.size),
            releaseNotes: release.body ?? null,
            isLatest: true
          }
        });

      upserted.push(`${platform}/${target.goarch}`);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'agent_version.sync_github',
      resourceType: 'agent_version',
      resourceId: version,
      resourceName: `v${version}`,
      details: { repo: GITHUB_REPO, targets: upserted }
    });

    return c.json({
      version,
      synced: upserted,
      releaseNotes: release.body ?? null
    });
  }
);
