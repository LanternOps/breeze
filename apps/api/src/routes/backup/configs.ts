import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
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
import {
  assertBackupStorageEncryptionSupported,
  buildBackupStorageEncryptionResponse,
} from '../../services/backupEncryption';
import { checkBackupProviderCapabilities, type ProviderCapabilityStatus } from '../../services/backupSnapshotStorage';
import { PERMISSIONS } from '../../services/permissions';
import { coerceS3EndpointUrl, deriveS3RegionFromEndpoint } from '@breeze/shared';
import { resolveScopedOrgId } from './helpers';
import { configSchema, configUpdateSchema, validateS3Details } from './schemas';

export const configsRoutes = new Hono();

const configIdParamSchema = z.object({ id: z.string().guid() });
const MASKED_SECRET = '********';
const SECRET_FIELD_NAMES = new Set([
  'accesskey',
  'accesskeyid',
  'apikey',
  'apisecret',
  'authtoken',
  'clientsecret',
  'credential',
  'credentials',
  'password',
  'secret',
  'secretaccesskey',
  'secretkey',
  'sessiontoken',
  'token',
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSecretField(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return SECRET_FIELD_NAMES.has(normalized) || normalized.endsWith('token') || normalized.endsWith('secret');
}

function isRedactedSecretMarker(value: unknown): boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === MASKED_SECRET || /^\*+$/.test(trimmed);
  }
  if (isRecord(value)) {
    return value.redacted === true || value.hasSecret === true || value.masked === MASKED_SECRET;
  }
  return false;
}

function redactProviderConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactProviderConfig);
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: JsonRecord = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSecretField(key)) {
      redacted[key] = {
        redacted: true,
        hasSecret: nestedValue !== null && nestedValue !== undefined && nestedValue !== '',
        masked: MASKED_SECRET,
      };
    } else {
      redacted[key] = redactProviderConfig(nestedValue);
    }
  }
  return redacted;
}

function preserveSecretFields(incoming: unknown, existing: unknown): unknown {
  if (!isRecord(incoming)) {
    return incoming;
  }

  const existingRecord = isRecord(existing) ? existing : {};
  const merged: JsonRecord = {};

  for (const [key, value] of Object.entries(incoming)) {
    const previous = existingRecord[key];
    if (isSecretField(key) && isRedactedSecretMarker(value)) {
      merged[key] = previous;
    } else if (isRecord(value) && isRecord(previous)) {
      merged[key] = preserveSecretFields(value, previous);
    } else {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(existingRecord)) {
    if (isSecretField(key) && !(key in merged)) {
      merged[key] = value;
    } else if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = preserveSecretFields(merged[key], value);
    }
  }

  return merged;
}

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
  const storedRegion = typeof details.region === 'string' ? details.region.trim() : '';
  const accessKeyId = typeof details.accessKey === 'string' ? details.accessKey : '';
  const secretAccessKey = typeof details.secretKey === 'string' ? details.secretKey : '';
  const endpoint = typeof details.endpoint === 'string' ? details.endpoint : undefined;
  const prefix = typeof details.prefix === 'string' ? details.prefix.replace(/\/+$/, '') : '';

  if (!bucket.trim() || !accessKeyId.trim() || !secretAccessKey.trim()) {
    throw new Error('S3 bucket and credentials are required');
  }

  // Configs saved before region validation existed can carry '' — derive
  // from the endpoint (required for B2 etc., where the signing region must
  // match) and only fall back to us-east-1 for endpoint-less AWS configs.
  const region = storedRegion || deriveS3RegionFromEndpoint(endpoint) || (endpoint ? '' : 'us-east-1');
  if (!region) {
    throw new Error('S3 region is not configured — edit the storage configuration and set the region for this endpoint');
  }

  // Coerce here too (not just at config-save time in validateS3Details) —
  // configs saved before that validation existed can still carry a
  // scheme-less endpoint, which would otherwise reach the SDK and fail
  // opaquely deep inside @smithy/core's endpoint resolver instead of giving a
  // message a user can act on (Sentry BREEZE-P). See coerceS3EndpointUrl for
  // the two distinct failure modes a scheme-less value produces.
  const normalizedEndpoint = coerceS3EndpointUrl(endpoint);

  const client = new S3Client({
    region,
    endpoint: normalizedEndpoint,
    forcePathStyle: Boolean(normalizedEndpoint),
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

configsRoutes.get('/configs', requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('json', configSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const details: Record<string, unknown> = { ...(payload.details ?? {}) };
    if (payload.provider === 's3') {
      // Schema already rejected unresolvable configs; persist the resolved
      // region AND the normalized endpoint so both are explicit in storage.
      // The endpoint matters most: it is shipped verbatim to the Go agent
      // (jobs/backupWorker.ts -> agent/internal/backup/providers/s3.go), which
      // does no scheme coercion of its own, so a scheme-less value stored here
      // fails on every device while this API's own test probe passes.
      const { region, endpoint } = validateS3Details(details);
      if (region) details.region = region;
      if (endpoint) details.endpoint = endpoint;
    }
    const encryption = payload.encryption ?? false;
    try {
      assertBackupStorageEncryptionSupported({
        encryption,
        provider: payload.provider,
        providerConfig: details,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Backup encryption is not supported for this config' }, 400);
    }

    const now = new Date();
    // Demote + insert atomically: a failed insert must not leave the org with
    // its previous default already cleared and no new one to replace it (the
    // org default is the destination every partner-wide backup resolves to).
    // The partial unique index on (org_id) WHERE is_default enforces at most one.
    const [row] = await db.transaction(async (tx) => {
      if (payload.isDefault === true) {
        await tx
          .update(backupConfigs)
          .set({ isDefault: false, updatedAt: now })
          .where(and(eq(backupConfigs.orgId, orgId), eq(backupConfigs.isDefault, true)));
      }
      return tx
        .insert(backupConfigs)
        .values({
          orgId,
          name: payload.name,
          type: 'file',
          provider: payload.provider,
          providerConfig: details,
          providerCapabilities: null,
          providerCapabilitiesCheckedAt: null,
          encryption,
          isActive: payload.enabled ?? true,
          isDefault: payload.isDefault ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    });

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

configsRoutes.get('/configs/:id', requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action), zValidator('param', configIdParamSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', configIdParamSchema),
  zValidator('json', configUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: configId } = c.req.valid('param');
    const payload = c.req.valid('json');

    // Every validation and existence check runs BEFORE any write. Demoting the
    // org's current default and then bailing out with a 400/404 would leave the
    // org with NO default destination — and the org default is what every
    // partner-wide and profile-linked backup resolves to, so their scheduled
    // backups would start skipping with no obvious cause.
    const [current] = await db
      .select()
      .from(backupConfigs)
      .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
      .limit(1);

    if (!current) {
      return c.json({ error: 'Config not found' }, 404);
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.enabled !== undefined) updateData.isActive = payload.enabled;
    if (payload.encryption !== undefined) updateData.encryption = payload.encryption;
    if (payload.isDefault !== undefined) updateData.isDefault = payload.isDefault;

    if (payload.details !== undefined || payload.encryption !== undefined) {
      const nextProviderConfig = payload.details !== undefined
        ? preserveSecretFields(payload.details, current.providerConfig)
        : current.providerConfig;
      if (payload.details !== undefined && current.provider === 's3' && isRecord(nextProviderConfig)) {
        // NOTE: configUpdateSchema has no superRefine (it cannot — `provider`
        // is not part of an update payload, so the schema can't tell an s3
        // config from a local one). This hand-rolled call is therefore the
        // ONLY thing standing between a malformed endpoint and the database on
        // the PATCH path. Do not remove it without adding equivalent
        // validation elsewhere. Covered by the PATCH tests in configs.test.ts.
        const { error, region, endpoint } = validateS3Details(nextProviderConfig);
        if (error) {
          return c.json({ error }, 400);
        }
        if (region) nextProviderConfig.region = region;
        if (endpoint) nextProviderConfig.endpoint = endpoint;
      }
      const nextEncryption = payload.encryption ?? current.encryption;

      try {
        assertBackupStorageEncryptionSupported({
          encryption: nextEncryption,
          provider: current.provider,
          providerConfig: nextProviderConfig,
        });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Backup encryption is not supported for this config' }, 400);
      }

      if (payload.details !== undefined) {
        updateData.providerConfig = nextProviderConfig;
        updateData.providerCapabilities = null;
        updateData.providerCapabilitiesCheckedAt = null;
      }
    }

    // Demote + promote atomically: the partial unique index on (org_id) WHERE
    // is_default allows at most one default, so a concurrent promote must not
    // see a half-applied swap.
    const [row] = await db.transaction(async (tx) => {
      if (payload.isDefault === true) {
        await tx
          .update(backupConfigs)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(backupConfigs.orgId, orgId), eq(backupConfigs.isDefault, true)));
      }
      return tx
        .update(backupConfigs)
        .set(updateData)
        .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
        .returning();
    });

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
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', configIdParamSchema),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', configIdParamSchema),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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
    isDefault: row.isDefault,
    encryption: buildBackupStorageEncryptionResponse({
      encryption: row.encryption,
      provider: row.provider,
      providerConfig: row.providerConfig ?? {},
    }),
    details: redactProviderConfig(row.providerConfig ?? {}) as Record<string, unknown>,
    providerCapabilities: buildCapabilityState(
      checkedAt,
      (row.providerCapabilities as ProviderCapabilityStatus | null | undefined) ?? null,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
