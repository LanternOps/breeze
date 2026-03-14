import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, like, or, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  softwareCatalog,
  softwareVersions,
  softwareDeployments,
  deploymentResults,
  softwareInventory,
  devices,
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { uploadBinary, getPresignedUrl, isS3Configured } from '../services/s3Storage';
import { sendCommandToAgent, type AgentCommand } from './agentWs';
import { createHash } from 'node:crypto';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const softwareRoutes = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveScopedOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId?: string | null;
    accessibleOrgIds?: string[] | null;
  }
) {
  if (auth.orgId) return auth.orgId;
  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }
  return null;
}

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

const ALLOWED_EXTENSIONS = new Set(['.msi', '.exe', '.dmg', '.deb', '.pkg']);
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const categorySchema = z.enum([
  'browser', 'utility', 'compression', 'productivity',
  'communication', 'developer', 'media', 'security'
]);
const platformSchema = z.enum(['windows', 'macos', 'linux']);

const listCatalogSchema = z.object({
  search: z.string().optional(),
  q: z.string().optional(),
  category: categorySchema.optional(),
  platform: platformSchema.optional(),
  page: z.string().optional(),
  limit: z.string().optional()
});

const catalogSearchSchema = z.object({
  q: z.string().min(1),
  category: categorySchema.optional()
});

const catalogIdParamSchema = z.object({ id: z.string().uuid() });

const createCatalogSchema = z.object({
  name: z.string().min(1).max(200),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  iconUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  isManaged: z.boolean().optional()
});

const updateCatalogSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  iconUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  isManaged: z.boolean().optional()
});

const versionParamSchema = z.object({ id: z.string().uuid() });
const versionIdParamSchema = z.object({ id: z.string().uuid(), versionId: z.string().uuid() });

const createVersionSchema = z.object({
  version: z.string().min(1).max(100),
  releaseDate: z.string().datetime().optional(),
  releaseNotes: z.string().max(5000).optional(),
  downloadUrl: z.string().url().optional(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  fileSize: z.number().min(0).optional(),
  supportedOs: z.array(platformSchema).optional(),
  architecture: z.string().max(20).optional(),
  silentInstallArgs: z.string().max(2000).optional(),
  silentUninstallArgs: z.string().max(2000).optional(),
  preInstallScript: z.string().optional(),
  postInstallScript: z.string().optional()
});

const listDeploymentsSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'draft']).optional(),
  page: z.string().optional(),
  limit: z.string().optional()
});

const deploymentIdParamSchema = z.object({ id: z.string().uuid() });

const createDeploymentSchema = z.object({
  name: z.string().min(1).max(255),
  softwareVersionId: z.string().uuid(),
  deploymentType: z.enum(['install', 'uninstall', 'update']),
  targetType: z.enum(['devices', 'groups', 'sites', 'all']),
  targetIds: z.array(z.string().uuid()).optional(),
  scheduleType: z.enum(['immediate', 'scheduled', 'maintenance']),
  scheduledAt: z.string().datetime().optional(),
  maintenanceWindowId: z.string().uuid().optional(),
  options: z.record(z.unknown()).optional()
});

const cancelDeploymentSchema = z.object({
  reason: z.string().max(500).optional()
});

const listInventorySchema = z.object({
  deviceId: z.string().uuid().optional(),
  search: z.string().optional()
});

const inventoryParamSchema = z.object({ deviceId: z.string().uuid() });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
softwareRoutes.use('*', authMiddleware);

// ---------------------------------------------------------------------------
// CATALOG ROUTES
// ---------------------------------------------------------------------------

// GET /catalog - List catalog items
softwareRoutes.get(
  '/catalog',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listCatalogSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const searchTerm = query.search ?? query.q;

    const conditions = [eq(softwareCatalog.orgId, orgId)];
    if (searchTerm) {
      const term = `%${searchTerm}%`;
      conditions.push(
        or(
          like(softwareCatalog.name, term),
          like(softwareCatalog.vendor, term),
          like(softwareCatalog.description, term)
        )!
      );
    }
    if (query.category) {
      conditions.push(eq(softwareCatalog.category, query.category));
    }

    const [items, countResult] = await Promise.all([
      db.select().from(softwareCatalog)
        .where(and(...conditions))
        .orderBy(softwareCatalog.name)
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(softwareCatalog)
        .where(and(...conditions))
    ]);

    return c.json({
      data: items,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// POST /catalog - Create catalog item
softwareRoutes.post(
  '/catalog',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createCatalogSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');
    const [item] = await db.insert(softwareCatalog).values({
      orgId,
      name: payload.name,
      vendor: payload.vendor ?? null,
      description: payload.description ?? null,
      category: payload.category ?? null,
      iconUrl: payload.iconUrl ?? null,
      websiteUrl: payload.websiteUrl ?? null,
      isManaged: payload.isManaged ?? false,
    }).returning();

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.create',
      resourceType: 'software_catalog_item',
      resourceId: item!.id,
      resourceName: item!.name,
      details: { vendor: item!.vendor },
    });

    return c.json({ data: item }, 201);
  }
);

// GET /catalog/search - Search catalog
softwareRoutes.get(
  '/catalog/search',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', catalogSearchSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const query = c.req.valid('query');
    const term = `%${query.q}%`;
    const conditions = [
      eq(softwareCatalog.orgId, orgId),
      or(
        like(softwareCatalog.name, term),
        like(softwareCatalog.vendor, term),
        like(softwareCatalog.description, term)
      )!
    ];
    if (query.category) {
      conditions.push(eq(softwareCatalog.category, query.category));
    }

    const items = await db.select().from(softwareCatalog).where(and(...conditions));
    return c.json({ data: items, total: items.length });
  }
);

// GET /catalog/:id - Get catalog item
softwareRoutes.get(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', catalogIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [item] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!item) return c.json({ error: 'Catalog item not found' }, 404);

    const [versionCount] = await db.select({ count: sql<number>`count(*)` })
      .from(softwareVersions).where(eq(softwareVersions.catalogId, id));

    return c.json({ data: { ...item, versionCount: Number(versionCount?.count ?? 0) } });
  }
);

// PATCH /catalog/:id - Update catalog item
softwareRoutes.patch(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', catalogIdParamSchema),
  zValidator('json', updateCatalogSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [existing] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!existing) return c.json({ error: 'Catalog item not found' }, 404);

    const [updated] = await db.update(softwareCatalog)
      .set(payload)
      .where(eq(softwareCatalog.id, id))
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.update',
      resourceType: 'software_catalog_item',
      resourceId: id,
      resourceName: updated!.name,
      details: { updatedFields: Object.keys(payload) },
    });

    return c.json({ data: updated });
  }
);

// DELETE /catalog/:id - Delete catalog item
softwareRoutes.delete(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', catalogIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!existing) return c.json({ error: 'Catalog item not found' }, 404);

    // Delete versions first (FK constraint)
    await db.delete(softwareVersions).where(eq(softwareVersions.catalogId, id));
    await db.delete(softwareCatalog).where(eq(softwareCatalog.id, id));

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.delete',
      resourceType: 'software_catalog_item',
      resourceId: existing.id,
      resourceName: existing.name,
    });

    return c.json({ success: true, id });
  }
);

// ---------------------------------------------------------------------------
// VERSION ROUTES
// ---------------------------------------------------------------------------

// GET /catalog/:id/versions - List versions for a catalog item
softwareRoutes.get(
  '/catalog/:id/versions',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', versionParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    const versions = await db.select().from(softwareVersions)
      .where(eq(softwareVersions.catalogId, id))
      .orderBy(desc(softwareVersions.releaseDate));

    return c.json({ data: versions });
  }
);

// POST /catalog/:id/versions - Create version (JSON metadata only)
softwareRoutes.post(
  '/catalog/:id/versions',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', versionParamSchema),
  zValidator('json', createVersionSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    // Clear previous isLatest
    await db.update(softwareVersions)
      .set({ isLatest: false })
      .where(and(eq(softwareVersions.catalogId, id), eq(softwareVersions.isLatest, true)));

    const [version] = await db.insert(softwareVersions).values({
      catalogId: id,
      version: payload.version,
      releaseDate: payload.releaseDate ? new Date(payload.releaseDate) : new Date(),
      releaseNotes: payload.releaseNotes ?? null,
      downloadUrl: payload.downloadUrl ?? null,
      checksum: payload.checksum ?? null,
      fileSize: payload.fileSize != null ? BigInt(payload.fileSize) : null,
      supportedOs: payload.supportedOs ?? null,
      architecture: payload.architecture ?? null,
      silentInstallArgs: payload.silentInstallArgs ?? null,
      silentUninstallArgs: payload.silentUninstallArgs ?? null,
      preInstallScript: payload.preInstallScript ?? null,
      postInstallScript: payload.postInstallScript ?? null,
      isLatest: true,
    }).returning();

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.version.create',
      resourceType: 'software_version',
      resourceId: version!.id,
      resourceName: catalogItem.name,
      details: { version: payload.version },
    });

    return c.json({ data: version }, 201);
  }
);

// POST /catalog/:id/versions/upload - Upload package file
softwareRoutes.post(
  '/catalog/:id/versions/upload',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    if (!isS3Configured()) {
      return c.json({ error: 'S3 storage is not configured' }, 503);
    }

    const catalogId = c.req.param('id')!;
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    // Parse multipart form
    const body = await c.req.parseBody({ all: true });
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: 'file is required' }, 400);
    }

    const version = typeof body.version === 'string' ? body.version.trim() : '';
    if (!version) return c.json({ error: 'version is required' }, 400);

    // Validate file
    if (file.size > MAX_UPLOAD_SIZE) {
      return c.json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }, 413);
    }

    const originalFileName = file.name || 'package';
    const ext = getFileExtension(originalFileName);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return c.json({ error: `Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` }, 400);
    }

    const fileType = ext.slice(1); // remove leading dot
    const architecture = typeof body.architecture === 'string' ? body.architecture : null;
    const releaseNotes = typeof body.releaseNotes === 'string' ? body.releaseNotes : null;
    let silentInstallArgs = typeof body.silentInstallArgs === 'string' ? body.silentInstallArgs : null;
    let silentUninstallArgs = typeof body.silentUninstallArgs === 'string' ? body.silentUninstallArgs : null;
    const preInstallScript = typeof body.preInstallScript === 'string' ? body.preInstallScript : null;
    const postInstallScript = typeof body.postInstallScript === 'string' ? body.postInstallScript : null;
    let supportedOs: string[] | null = null;
    if (typeof body.supportedOs === 'string') {
      try { supportedOs = JSON.parse(body.supportedOs); } catch { /* ignore */ }
    }

    // Auto-detect MSI silent args
    if (fileType === 'msi' && !silentInstallArgs) {
      silentInstallArgs = 'msiexec /i "{file}" /qn /norestart';
    }
    if (fileType === 'msi' && !silentUninstallArgs) {
      silentUninstallArgs = 'msiexec /x "{file}" /qn /norestart';
    }

    // Write to temp file and compute checksum
    const tempDir = join(tmpdir(), 'breeze-uploads');
    await mkdir(tempDir, { recursive: true });
    const tempPath = join(tempDir, `${randomUUID()}${ext}`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await writeFile(tempPath, buffer);

      const hash = createHash('sha256');
      hash.update(buffer);
      const checksum = hash.digest('hex');

      // Generate version ID for S3 key path
      const versionId = randomUUID();
      const s3Key = `software/${orgId}/${catalogId}/${versionId}/${originalFileName}`;

      // Upload to S3
      await uploadBinary(tempPath, s3Key, checksum);

      // Clear previous isLatest
      await db.update(softwareVersions)
        .set({ isLatest: false })
        .where(and(eq(softwareVersions.catalogId, catalogId), eq(softwareVersions.isLatest, true)));

      // Insert version record
      const [versionRecord] = await db.insert(softwareVersions).values({
        id: versionId,
        catalogId,
        version,
        releaseDate: new Date(),
        releaseNotes,
        s3Key,
        fileType,
        originalFileName,
        checksum,
        fileSize: BigInt(buffer.length),
        supportedOs,
        architecture,
        silentInstallArgs,
        silentUninstallArgs,
        preInstallScript,
        postInstallScript,
        isLatest: true,
      }).returning();

      writeRouteAudit(c, {
        orgId,
        action: 'software.catalog.version.upload',
        resourceType: 'software_version',
        resourceId: versionRecord!.id,
        resourceName: catalogItem.name,
        details: { version, fileType, fileSize: buffer.length, checksum },
      });

      return c.json({ data: versionRecord }, 201);
    } finally {
      // Clean up temp file
      await unlink(tempPath).catch(() => {});
    }
  }
);

// GET /catalog/:id/versions/:versionId/download-url - Get presigned download URL
softwareRoutes.get(
  '/catalog/:id/versions/:versionId/download-url',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const catalogId = c.req.param('id')!;
    const versionId = c.req.param('versionId')!;

    // Verify catalog belongs to org
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    const [versionRecord] = await db.select().from(softwareVersions)
      .where(and(eq(softwareVersions.id, versionId), eq(softwareVersions.catalogId, catalogId)));
    if (!versionRecord) return c.json({ error: 'Version not found' }, 404);

    if (versionRecord.s3Key) {
      const url = await getPresignedUrl(versionRecord.s3Key, 3600);
      return c.json({ data: { url, expiresIn: 3600 } });
    }

    if (versionRecord.downloadUrl) {
      return c.json({ data: { url: versionRecord.downloadUrl, expiresIn: null } });
    }

    return c.json({ error: 'No download available for this version' }, 404);
  }
);

// ---------------------------------------------------------------------------
// DEPLOYMENT ROUTES
// ---------------------------------------------------------------------------

// GET /deployments - List deployments
softwareRoutes.get(
  '/deployments',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDeploymentsSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions = [eq(softwareDeployments.orgId, orgId)];
    if (query.status) {
      conditions.push(eq(softwareDeployments.deploymentType, query.status));
    }

    const [items, countResult] = await Promise.all([
      db.select().from(softwareDeployments)
        .where(and(...conditions))
        .orderBy(desc(softwareDeployments.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(softwareDeployments)
        .where(and(...conditions))
    ]);

    return c.json({
      data: items,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// POST /deployments - Create deployment
softwareRoutes.post(
  '/deployments',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createDeploymentSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');

    // Verify version exists and get catalog info
    const [versionRecord] = await db.select().from(softwareVersions)
      .where(eq(softwareVersions.id, payload.softwareVersionId));
    if (!versionRecord) return c.json({ error: 'Software version not found' }, 404);

    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, versionRecord.catalogId), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found or access denied' }, 404);

    // Resolve target device IDs
    let targetDeviceIds: string[] = [];
    if (payload.targetType === 'devices' && payload.targetIds) {
      targetDeviceIds = payload.targetIds;
    } else if (payload.targetType === 'all') {
      const allDevices = await db.select({ id: devices.id }).from(devices)
        .where(eq(devices.orgId, orgId));
      targetDeviceIds = allDevices.map(d => d.id);
    }

    // Insert deployment
    const [deployment] = await db.insert(softwareDeployments).values({
      orgId,
      name: payload.name,
      softwareVersionId: payload.softwareVersionId,
      deploymentType: payload.deploymentType,
      targetType: payload.targetType,
      targetIds: payload.targetIds ?? null,
      scheduleType: payload.scheduleType,
      scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : null,
      maintenanceWindowId: payload.maintenanceWindowId ?? null,
      options: payload.options ?? null,
      createdBy: auth.user?.id ?? null,
    }).returning();

    // Insert per-device results
    if (targetDeviceIds.length > 0) {
      await db.insert(deploymentResults).values(
        targetDeviceIds.map(deviceId => ({
          deploymentId: deployment!.id,
          deviceId,
          status: 'pending' as const,
        }))
      );
    }

    // For immediate deployments, dispatch install commands to online agents
    if (payload.scheduleType === 'immediate' && payload.deploymentType === 'install' && targetDeviceIds.length > 0) {
      // Get presigned URL for download
      let downloadUrl: string | null = null;
      if (versionRecord.s3Key && isS3Configured()) {
        try {
          downloadUrl = await getPresignedUrl(versionRecord.s3Key, 3600);
        } catch { /* S3 may not be available */ }
      }
      downloadUrl = downloadUrl ?? versionRecord.downloadUrl;

      if (downloadUrl) {
        // Get agentIds for target devices
        const targetDevices = await db.select({ id: devices.id, agentId: devices.agentId })
          .from(devices)
          .where(inArray(devices.id, targetDeviceIds));

        for (const device of targetDevices) {
          const command: AgentCommand = {
            id: `sw-install-${deployment!.id}-${device.id}`,
            type: 'software_install',
            payload: {
              deploymentId: deployment!.id,
              downloadUrl,
              checksum: versionRecord.checksum,
              fileName: versionRecord.originalFileName ?? `package.${versionRecord.fileType ?? 'exe'}`,
              fileType: versionRecord.fileType ?? 'exe',
              silentInstallArgs: versionRecord.silentInstallArgs,
              softwareName: catalogItem.name,
              version: versionRecord.version,
            },
          };
          sendCommandToAgent(device.agentId, command);
        }
      }
    }

    writeRouteAudit(c, {
      orgId,
      action: 'software.deployment.create',
      resourceType: 'software_deployment',
      resourceId: deployment!.id,
      resourceName: payload.name,
      details: {
        deploymentType: payload.deploymentType,
        targetType: payload.targetType,
        deviceCount: targetDeviceIds.length,
      },
    });

    return c.json({ data: deployment }, 201);
  }
);

// POST /deploy - Legacy deployment endpoint (used by DeploymentWizard)
softwareRoutes.post(
  '/deploy',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const body = await c.req.json();
    const softwareId = body.softwareId;
    const version = body.version;
    const deviceIds = body.targets?.deviceIds ?? [];
    const scheduleType = body.configuration?.scheduleType ?? 'immediate';

    if (!softwareId || !version) {
      return c.json({ error: 'softwareId and version are required' }, 400);
    }

    // Look up the catalog item + version
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, softwareId), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    const [versionRecord] = await db.select().from(softwareVersions)
      .where(and(eq(softwareVersions.catalogId, softwareId), eq(softwareVersions.version, version)));

    if (!versionRecord) return c.json({ error: 'Version not found' }, 404);

    // Insert deployment
    const [deployment] = await db.insert(softwareDeployments).values({
      orgId,
      name: `Deploy ${catalogItem.name} v${version}`,
      softwareVersionId: versionRecord.id,
      deploymentType: 'install',
      targetType: 'devices',
      targetIds: deviceIds,
      scheduleType,
      createdBy: auth.user?.id ?? null,
    }).returning();

    // Insert per-device results
    if (Array.isArray(deviceIds) && deviceIds.length > 0) {
      await db.insert(deploymentResults).values(
        deviceIds.map((deviceId: string) => ({
          deploymentId: deployment!.id,
          deviceId,
          status: 'pending' as const,
        }))
      );

      // Dispatch immediate installs
      if (scheduleType === 'immediate') {
        let downloadUrl: string | null = null;
        if (versionRecord.s3Key && isS3Configured()) {
          try { downloadUrl = await getPresignedUrl(versionRecord.s3Key, 3600); } catch { /* */ }
        }
        downloadUrl = downloadUrl ?? versionRecord.downloadUrl;

        if (downloadUrl) {
          const targetDevices = await db.select({ id: devices.id, agentId: devices.agentId })
            .from(devices)
            .where(inArray(devices.id, deviceIds));

          for (const device of targetDevices) {
            const command: AgentCommand = {
              id: `sw-install-${deployment!.id}-${device.id}`,
              type: 'software_install',
              payload: {
                deploymentId: deployment!.id,
                downloadUrl,
                checksum: versionRecord.checksum,
                fileName: versionRecord.originalFileName ?? `package.${versionRecord.fileType ?? 'exe'}`,
                fileType: versionRecord.fileType ?? 'exe',
                silentInstallArgs: versionRecord.silentInstallArgs,
                softwareName: catalogItem.name,
                version: versionRecord.version,
              },
            };
            sendCommandToAgent(device.agentId, command);
          }
        }
      }
    }

    writeRouteAudit(c, {
      orgId,
      action: 'software.deployment.create',
      resourceType: 'software_deployment',
      resourceId: deployment!.id,
      resourceName: catalogItem.name,
      details: { version, deviceCount: deviceIds.length },
    });

    return c.json({ data: deployment, id: deployment!.id }, 201);
  }
);

// GET /deployments/:id - Get deployment
softwareRoutes.get(
  '/deployments/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deploymentIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [deployment] = await db.select().from(softwareDeployments)
      .where(and(eq(softwareDeployments.id, id), eq(softwareDeployments.orgId, orgId)));
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

    return c.json({ data: deployment });
  }
);

// POST /deployments/:id/cancel - Cancel deployment
softwareRoutes.post(
  '/deployments/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deploymentIdParamSchema),
  zValidator('json', cancelDeploymentSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [deployment] = await db.select().from(softwareDeployments)
      .where(and(eq(softwareDeployments.id, id), eq(softwareDeployments.orgId, orgId)));
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

    // Update pending results to cancelled
    await db.update(deploymentResults)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(and(
        eq(deploymentResults.deploymentId, id),
        eq(deploymentResults.status, 'pending')
      ));

    writeRouteAudit(c, {
      orgId,
      action: 'software.deployment.cancel',
      resourceType: 'software_deployment',
      resourceId: id,
      resourceName: deployment.name,
    });

    return c.json({ data: { ...deployment, status: 'cancelled' } });
  }
);

// GET /deployments/:id/results - Get per-device results
softwareRoutes.get(
  '/deployments/:id/results',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deploymentIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [deployment] = await db.select().from(softwareDeployments)
      .where(and(eq(softwareDeployments.id, id), eq(softwareDeployments.orgId, orgId)));
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

    const results = await db.select().from(deploymentResults)
      .where(eq(deploymentResults.deploymentId, id));

    return c.json({ data: results });
  }
);

// ---------------------------------------------------------------------------
// INVENTORY ROUTES
// ---------------------------------------------------------------------------

// GET /inventory - List software inventory
softwareRoutes.get(
  '/inventory',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listInventorySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const query = c.req.valid('query');

    // Get devices for org, then filter inventory
    const orgDevices = await db.select({ id: devices.id }).from(devices)
      .where(eq(devices.orgId, orgId));
    const orgDeviceIds = orgDevices.map(d => d.id);

    if (orgDeviceIds.length === 0) {
      return c.json({ data: [], total: 0 });
    }

    const conditions = [inArray(softwareInventory.deviceId, orgDeviceIds)];
    if (query.deviceId) {
      conditions.push(eq(softwareInventory.deviceId, query.deviceId));
    }
    if (query.search) {
      conditions.push(like(softwareInventory.name, `%${query.search}%`));
    }

    const items = await db.select().from(softwareInventory)
      .where(and(...conditions))
      .orderBy(softwareInventory.name);

    return c.json({ data: items, total: items.length });
  }
);

// GET /inventory/:deviceId - Get device software inventory
softwareRoutes.get(
  '/inventory/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', inventoryParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { deviceId } = c.req.valid('param');

    // Verify device belongs to org
    const [device] = await db.select().from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)));
    if (!device) return c.json({ error: 'Device not found' }, 404);

    const items = await db.select().from(softwareInventory)
      .where(eq(softwareInventory.deviceId, deviceId))
      .orderBy(softwareInventory.name);

    return c.json({ data: items });
  }
);
