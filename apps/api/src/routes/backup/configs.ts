import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { db } from '../../db';
import { backupConfigs } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { checkBackupProviderCapabilities, type ProviderCapabilityStatus } from '../../services/backupSnapshotStorage';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { configSchema, configUpdateSchema } from './schemas';

export const configsRoutes = new Hono();

const configIdParamSchema = z.object({ id: z.string().uuid() });

function buildCapabilityState(
  checkedAt: string | null,
  capability?: ProviderCapabilityStatus | null,
) {
  if (!checkedAt || !capability) {
    return null;
  }

  return {
    objectLock: {
      supported: capability.objectLock.supported,
      checkedAt,
      error: capability.objectLock.error,
    },
  };
}

async function probeLocalConfig(details: Record<string, unknown>): Promise<void> {
  const rootPath = typeof details.path === 'string' ? details.path : '';
  if (!rootPath.trim()) {
    throw new Error('Local backup path is not configured');
  }

  await mkdir(rootPath, { recursive: true });
  const probePath = join(rootPath, `.breeze-probe-${randomUUID()}`);
  await writeFile(probePath, 'breeze-backup-probe');
  await rm(probePath, { force: true });
}

async function probeS3Config(details: Record<string, unknown>): Promise<void> {
  const bucket = typeof details.bucket === 'string' ? details.bucket : '';
  const region = typeof details.region === 'string' ? details.region : 'us-east-1';
  const accessKeyId = typeof details.accessKey === 'string' ? details.accessKey : '';
  const secretAccessKey = typeof details.secretKey === 'string' ? details.secretKey : '';
  const endpoint = typeof details.endpoint === 'string' ? details.endpoint : undefined;
  const prefix = typeof details.prefix === 'string' ? details.prefix.replace(/\/+$/, '') : '';

  if (!bucket.trim() || !accessKeyId.trim() || !secretAccessKey.trim()) {
    throw new Error('S3 bucket and credentials are required');
  }

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: Boolean(endpoint),
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const key = `${prefix ? `${prefix}/` : ''}.breeze-probe-${randomUUID()}`;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: 'breeze-backup-probe',
  }));
  await client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
}

configsRoutes.get('/configs', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const rows = await db
    .select()
    .from(backupConfigs)
    .where(eq(backupConfigs.orgId, orgId));

  const data = rows.map(toConfigResponse);
  return c.json({ data });
});

configsRoutes.post(
  '/configs',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', configSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const now = new Date();
    const [row] = await db
      .insert(backupConfigs)
      .values({
        orgId,
        name: payload.name,
        type: 'file',
        provider: payload.provider,
        providerConfig: payload.details ?? {},
        providerCapabilities: null,
        providerCapabilitiesCheckedAt: null,
        isActive: payload.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) {
      return c.json({ error: 'Failed to create config' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.config.create',
      resourceType: 'backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { provider: row.provider, enabled: row.isActive },
    });

    return c.json(toConfigResponse(row), 201);
  }
);

configsRoutes.get('/configs/:id', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('param', configIdParamSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: configId } = c.req.valid('param');
  const [row] = await db
    .select()
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Config not found' }, 404);
  }
  return c.json(toConfigResponse(row));
});

configsRoutes.patch(
  '/configs/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', configIdParamSchema),
  zValidator('json', configUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: configId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.enabled !== undefined) updateData.isActive = payload.enabled;
    if (payload.details !== undefined) {
      updateData.providerConfig = payload.details;
      updateData.providerCapabilities = null;
      updateData.providerCapabilitiesCheckedAt = null;
    }

    const [row] = await db
      .update(backupConfigs)
      .set(updateData)
      .where(
        and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId))
      )
      .returning();

    if (!row) {
      return c.json({ error: 'Config not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.config.update',
      resourceType: 'backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { changedFields: Object.keys(payload) },
    });

    return c.json(toConfigResponse(row));
  }
);

configsRoutes.delete(
  '/configs/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', configIdParamSchema),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: configId } = c.req.valid('param');
  const [deleted] = await db
    .delete(backupConfigs)
    .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
    .returning();

  if (!deleted) {
    return c.json({ error: 'Config not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.config.delete',
    resourceType: 'backup_config',
    resourceId: deleted.id,
    resourceName: deleted.name,
  });

  return c.json({ deleted: true });
});

configsRoutes.post(
  '/configs/:id/test',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', configIdParamSchema),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: configId } = c.req.valid('param');
  const [row] = await db
    .select()
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Config not found' }, 404);
  }

  const checkedAt = new Date().toISOString();
  const checkedAtDate = new Date(checkedAt);
  writeRouteAudit(c, {
    orgId,
    action: 'backup.config.test',
    resourceType: 'backup_config',
    resourceId: row.id,
    resourceName: row.name,
  });

  const details = (row.providerConfig ?? {}) as Record<string, unknown>;
  let status: 'success' | 'failed' | 'unsupported' = 'success';
  let errorMessage: string | null = null;
  let capability: ProviderCapabilityStatus | null = null;

  try {
    if (row.provider === 'local') {
      await probeLocalConfig(details);
      capability = await checkBackupProviderCapabilities({
        provider: row.provider,
        providerConfig: details,
      });
    } else if (row.provider === 's3') {
      await probeS3Config(details);
      capability = await checkBackupProviderCapabilities({
        provider: row.provider,
        providerConfig: details,
      });
    } else {
      status = 'unsupported';
      errorMessage = `Connection testing is not implemented for provider ${row.provider}`;
      capability = await checkBackupProviderCapabilities({
        provider: row.provider,
        providerConfig: details,
      });
    }
  } catch (error) {
    status = 'failed';
    errorMessage = error instanceof Error ? error.message : 'Connection test failed';
    capability = {
      objectLock: {
        supported: false,
        error: errorMessage,
      },
    };
  }

  const [updated] = await db
    .update(backupConfigs)
    .set({
      providerCapabilities: capability,
      providerCapabilitiesCheckedAt: checkedAtDate,
      updatedAt: new Date(),
    })
    .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
    .returning();

  const response = {
    id: row.id,
    provider: row.provider,
    status,
    checkedAt,
    error: errorMessage,
    providerCapabilities: buildCapabilityState(checkedAt, capability),
    config: updated ? toConfigResponse(updated) : undefined,
  };

  if (status === 'failed' || status === 'unsupported') {
    return c.json(response, 400);
  }

  return c.json(response);
});

function toConfigResponse(row: typeof backupConfigs.$inferSelect) {
  const checkedAt = row.providerCapabilitiesCheckedAt?.toISOString() ?? null;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    enabled: row.isActive,
    details: row.providerConfig as Record<string, unknown>,
    providerCapabilities: buildCapabilityState(
      checkedAt,
      (row.providerCapabilities as ProviderCapabilityStatus | null | undefined) ?? null,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
