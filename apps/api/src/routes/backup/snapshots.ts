import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { backupConfigs, backupSnapshots, organizations } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  applyBackupSnapshotImmutability,
  backupLayoutManifestKey,
  checkBackupProviderCapabilities,
} from '../../services/backupSnapshotStorage';
import { resolveSnapshotPlatform } from '../../services/bareMetalRebuildSchemas';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import {
  snapshotImmutabilityApplySchema,
  snapshotListSchema,
  snapshotProtectionReasonSchema,
} from './schemas';
import { attachDeviceNames } from './deviceNames';
import {
  BROWSE_DEFAULT_LIMIT,
  BROWSE_MAX_LIMIT,
  decodeBrowseCursor,
  decodeSearchCursor,
  dirSegments,
  IndexQueryTimeoutError,
  listSnapshotDirectory,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
  searchSnapshotFiles,
} from '../../services/backupSnapshotBrowse';
import { readSnapshotIndexView, type SnapshotIndexView } from '../../services/backupSnapshotIndexView';
import { enqueueSnapshotFileIndexHydration } from '../../jobs/backupSnapshotFileIndexWorker';
import { requestFileIndexHydrationAfterContext } from './fileIndexHydrationRequest';
import { captureException } from '../../services/sentry';
import { getRedis } from '../../services/redis';
import { ERROR_CODES } from '@breeze/shared';
import {
  authorizeRouteResilienceResources,
  resolveRouteAuthorizedDeviceIds,
} from './resilienceAuthorization';

export const snapshotsRoutes = new Hono();

const snapshotIdParamSchema = z.object({ id: z.string().guid() });

/** How long after an accepted rebuild the same snapshot refuses another (#11180). */
export const FILE_INDEX_REBUILD_COOLDOWN_SECONDS = 10 * 60;

const rebuildCooldownKey = (snapshotDbId: string) => `backup:file-index-rebuild:${snapshotDbId}`;

/**
 * Claim the snapshot's rebuild slot (SET NX EX). Fails OPEN when Redis is
 * unavailable: the cooldown only bounds how often a rebuild runs, and the
 * queue's own job-id dedupe still applies, so an outage must not stop a person
 * from recovering their file list.
 */
async function takeRebuildCooldown(
  snapshotDbId: string,
): Promise<{ blocked: false } | { blocked: true; retryAfterSeconds: number }> {
  try {
    const redis = getRedis();
    if (!redis) return { blocked: false };
    const key = rebuildCooldownKey(snapshotDbId);
    const taken = await redis.set(key, '1', 'EX', FILE_INDEX_REBUILD_COOLDOWN_SECONDS, 'NX');
    if (taken === 'OK') return { blocked: false };
    // The key is held, so the request is blocked even if the TTL read fails.
    const remaining = await redis.ttl(key).catch(() => -1);
    return {
      blocked: true,
      retryAfterSeconds: remaining > 0 ? remaining : FILE_INDEX_REBUILD_COOLDOWN_SECONDS,
    };
  } catch (err) {
    console.error(`[backup] File-index rebuild cooldown check failed for snapshot ${snapshotDbId} (allowing the rebuild):`, err);
    return { blocked: false };
  }
}

async function releaseRebuildCooldown(snapshotDbId: string): Promise<void> {
  try {
    await getRedis()?.del(rebuildCooldownKey(snapshotDbId));
  } catch (err) {
    console.error(`[backup] Could not release the file-index rebuild cooldown for snapshot ${snapshotDbId}:`, err);
  }
}

// #8230: browse is one directory level per request. `dir` is a tree path as
// returned in a previous page's directory entries (or a raw Windows path);
// omitted = the snapshot root.
const snapshotBrowseQuerySchema = z.object({
  dir: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(BROWSE_MAX_LIMIT).default(BROWSE_DEFAULT_LIMIT),
  cursor: z.string().max(2048).optional(),
});

// #11026: `cursor` carries a stored path (up to 32k on Windows), base64url.
const snapshotSearchQuerySchema = z.object({
  // Postgres cannot take a NUL as text: a 400, not a 500 from the query.
  q: z.string().min(SEARCH_QUERY_MIN_LENGTH).max(SEARCH_QUERY_MAX_LENGTH).refine((q) => !q.includes('\0'), 'q must not contain a NUL'),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
  cursor: z.string().max(65_536).optional(),
});

/** A browse or search past its statement timeout: try again, nothing is wrong with the snapshot. */
function indexQueryTimeout(c: Context) {
  return c.json({ error: 'Listing this snapshot took too long. Try again in a moment.', code: 'index_query_timeout' }, 503);
}

/**
 * True once this org's erasure cascade has been handed to the worker
 * (`organizations.status = 'purging'` — the same marker
 * `jobs/tenantErasure.ts`'s status guard and `routes/orgs.ts`'s lifecycle
 * freeze read). A hold accepted after that point cannot retroactively protect
 * anything: the cascade's own `backup_snapshots` step re-checks for an active
 * hold immediately before deleting (`services/tenantCascade.ts`), so a hold
 * placed here either loses that race outright or gives the requester a false
 * sense that the snapshot is now safe. Refuse up front instead of letting the
 * write silently do nothing useful.
 */
async function isOrgErasureInProgress(orgId: string): Promise<boolean> {
  const [org] = await db
    .select({ status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.status === 'purging';
}

type SnapshotProtectionState = {
  legalHold: boolean;
  legalHoldReason: string | null;
  legalHoldSource: 'policy' | 'manual' | null;
  isImmutable: boolean;
  immutableUntil: string | null;
  immutabilityEnforcement: string | null;
  requestedImmutabilityEnforcement: string | null;
  immutabilityFallbackReason: string | null;
  retentionBlockedReason: 'legal_hold' | 'immutable_until' | null;
};

function computeImmutableUntilFromNow(immutableDays: number): Date {
  const immutableUntil = new Date();
  immutableUntil.setUTCDate(immutableUntil.getUTCDate() + immutableDays);
  return immutableUntil;
}

function normalizeSnapshotMetadata(
  metadata: unknown,
): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

function resolveLegalHoldSource(
  metadata: unknown,
): 'policy' | 'manual' | null {
  const normalized = normalizeSnapshotMetadata(metadata);
  const protection =
    normalized.snapshotProtection && typeof normalized.snapshotProtection === 'object' && !Array.isArray(normalized.snapshotProtection)
      ? normalized.snapshotProtection as Record<string, unknown>
      : null;
  return protection?.legalHoldSource === 'policy' || protection?.legalHoldSource === 'manual'
    ? protection.legalHoldSource
    : null;
}

function withLegalHoldSource(
  metadata: unknown,
  source: 'policy' | 'manual' | null,
): Record<string, unknown> {
  const normalized = normalizeSnapshotMetadata(metadata);
  const protection =
    normalized.snapshotProtection && typeof normalized.snapshotProtection === 'object' && !Array.isArray(normalized.snapshotProtection)
      ? { ...(normalized.snapshotProtection as Record<string, unknown>) }
      : {};

  return {
    ...normalized,
    snapshotProtection: {
      ...protection,
      legalHoldSource: source,
    },
  };
}

function computeRetentionBlockedReason(
  row: typeof backupSnapshots.$inferSelect,
): 'legal_hold' | 'immutable_until' | null {
  if (row.legalHold === true) {
    return 'legal_hold';
  }
  if (row.isImmutable === true && row.immutableUntil && row.immutableUntil > new Date()) {
    return 'immutable_until';
  }
  return null;
}

function toProtectionState(row: typeof backupSnapshots.$inferSelect): SnapshotProtectionState {
  return {
    legalHold: row.legalHold === true,
    legalHoldReason: row.legalHoldReason ?? null,
    legalHoldSource: resolveLegalHoldSource(row.metadata),
    isImmutable: row.isImmutable === true,
    immutableUntil: row.immutableUntil?.toISOString() ?? null,
    immutabilityEnforcement: row.immutabilityEnforcement ?? null,
    requestedImmutabilityEnforcement: row.requestedImmutabilityEnforcement ?? null,
    immutabilityFallbackReason: row.immutabilityFallbackReason ?? null,
    retentionBlockedReason: computeRetentionBlockedReason(row),
  };
}

async function resolveSnapshotStorageConfig(
  configId: string | null | undefined,
): Promise<{ provider: string | null; providerConfig: unknown } | null> {
  if (!configId) return null;

  const [row] = await db
    .select({
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupConfigs)
    .where(eq(backupConfigs.id, configId))
    .limit(1);

  return row ?? null;
}

snapshotsRoutes.get(
  '/snapshots',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', snapshotListSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const query = c.req.valid('query');
    const conditions = [eq(backupSnapshots.orgId, orgId)];
    const allowedDeviceIds = await resolveRouteAuthorizedDeviceIds(c, orgId);

    if (query.deviceId) {
      conditions.push(eq(backupSnapshots.deviceId, query.deviceId));
    }
    if (allowedDeviceIds) {
      if (query.deviceId && !allowedDeviceIds!.includes(query.deviceId)) {
        return c.json({ error: 'site_access_denied' }, 403);
      }
      if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
        return c.json({ data: [] });
      }
      conditions.push(inArray(backupSnapshots.deviceId, allowedDeviceIds));
    }
    if (query.configId) {
      conditions.push(eq(backupSnapshots.configId, query.configId));
    }
    if (query.bareMetalRestorable !== undefined) {
      conditions.push(eq(backupSnapshots.bareMetalRestorable, query.bareMetalRestorable));
    }

    const rows = await db
      .select()
      .from(backupSnapshots)
      .where(and(...conditions))
      .orderBy(desc(backupSnapshots.timestamp));

    return c.json({ data: await attachDeviceNames(orgId, rows.map(toSnapshotResponse)) });
  }
);

snapshotsRoutes.get('/snapshots/:id', requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action), zValidator('param', snapshotIdParamSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: snapshotId } = c.req.valid('param');
  const authorization = await authorizeRouteResilienceResources(c, orgId, [
    { kind: 'snapshot', id: snapshotId, role: 'source' },
  ], 'read');
  if (!authorization.ok) return authorization.response;

  const [row] = await db
    .select()
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.id, snapshotId),
        eq(backupSnapshots.orgId, orgId)
      )
    )
    .limit(1);

  if (!row) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  return c.json(toSnapshotResponse(row));
});

snapshotsRoutes.get('/snapshots/:id/browse', requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action), zValidator('param', snapshotIdParamSchema), zValidator('query', snapshotBrowseQuerySchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: snapshotId } = c.req.valid('param');
  const query = c.req.valid('query');
  const authorization = await authorizeRouteResilienceResources(c, orgId, [
    { kind: 'snapshot', id: snapshotId, role: 'source' },
  ], 'read');
  if (!authorization.ok) return authorization.response;

  const index = await readSnapshotIndexView(snapshotId, orgId);
  if (!index) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  const cursor = query.cursor ? decodeBrowseCursor(query.cursor) : null;
  if (query.cursor && !cursor) {
    return c.json({ error: 'Invalid cursor' }, 400);
  }

  // #11026: a snapshot with no index to list (persisted before eager
  // hydration, or whose request or job failed) builds one from its manifest
  // when someone browses it, instead of staying empty until a restore asks.
  if (index.shouldRequestHydration) {
    requestFileIndexHydrationAfterContext(index.id, 'browse');
  }

  // Bounded, SQL-side one-level listing: only `limit + 1` grouped entries
  // leave Postgres, so the request's DB context is held for one cheap query
  // instead of materialising and serialising the whole file index (#8230).
  // The listing itself only reads an index that may be trusted.
  const segments = dirSegments(query.dir);
  let page: Awaited<ReturnType<typeof listSnapshotDirectory>>;
  try {
    page = await listSnapshotDirectory({
      snapshotDbId: index.id,
      segments,
      limit: query.limit,
      cursor,
    });
  } catch (err) {
    if (err instanceof IndexQueryTimeoutError) return indexQueryTimeout(c);
    throw err;
  }

  // Kept for web bundles that predate `index`.
  const manifestUnavailable =
    segments.length === 0 && !cursor && page.entries.length === 0 && (index.fileCount ?? 0) > 0;
  return c.json({
    snapshotId: index.id,
    manifestUnavailable,
    index: index.view,
    dir: segments.length > 0 ? `/${segments.join('/')}` : '',
    data: page.entries,
    nextCursor: page.nextCursor,
  });
});

// #11026: find a snapshot's files by part of a name or folder, without walking
// the tree. Same authorization and index gate as browse.
snapshotsRoutes.get('/snapshots/:id/search', requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action), zValidator('param', snapshotIdParamSchema), zValidator('query', snapshotSearchQuerySchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: snapshotId } = c.req.valid('param');
  const query = c.req.valid('query');
  const authorization = await authorizeRouteResilienceResources(c, orgId, [
    { kind: 'snapshot', id: snapshotId, role: 'source' },
  ], 'read');
  if (!authorization.ok) return authorization.response;

  const index = await readSnapshotIndexView(snapshotId, orgId);
  if (!index) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  const after = query.cursor ? decodeSearchCursor(query.cursor) : null;
  if (query.cursor && after === null) {
    return c.json({ error: 'Invalid cursor' }, 400);
  }

  if (index.shouldRequestHydration) {
    requestFileIndexHydrationAfterContext(index.id, 'browse');
  }

  try {
    const page = await searchSnapshotFiles({ snapshotDbId: index.id, query: query.q, limit: query.limit, after });
    return c.json({ data: page.entries, nextCursor: page.nextCursor, index: index.view });
  } catch (err) {
    if (err instanceof IndexQueryTimeoutError) return indexQueryTimeout(c);
    throw err;
  }
});

// #11026: build a snapshot's file list again from its manifest, for a person
// whose browse ended in "can't read the list". Changes derived data only (the
// index is rebuilt from bytes the attestation names), so it needs backup write
// but not a fresh second factor.
snapshotsRoutes.post(
  '/snapshots/:id/file-index/rebuild',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  zValidator('param', snapshotIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: snapshotId } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'snapshot', id: snapshotId, role: 'source' },
    ], 'verify');
    if (!authorization.ok) return authorization.response;

    const index = await readSnapshotIndexView(snapshotId, orgId);
    if (!index) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }
    // Rebuilding cannot help a snapshot whose stored bytes are not the
    // attested ones: it would only fail the same way.
    if (
      index.view.state === 'unavailable'
      && (index.view.failure === 'attestation_failed' || index.view.failure === 'manifest_differs_from_attestation')
    ) {
      return c.json({ error: "This snapshot failed its integrity check, so its file list can't be rebuilt.", code: 'attestation_failed' }, 409);
    }

    // BullMQ's job id only dedupes a rebuild that is still queued; a client
    // that asks again after each completion would re-hydrate a large manifest
    // back to back (#11180). Take the per-snapshot cooldown before any write.
    const cooldown = await takeRebuildCooldown(index.id);
    if (cooldown.blocked) {
      c.header('Retry-After', String(cooldown.retryAfterSeconds));
      return c.json({
        error: "This snapshot's file list was rebuilt recently. Try again in a few minutes.",
        code: ERROR_CODES.RATE_LIMITED,
        retryAfterSeconds: cooldown.retryAfterSeconds,
      }, 429);
    }

    // A failed index stays failed until the worker claims it, and a person
    // polling meanwhile would read the old failure back and stop. Set it to
    // not-built first: the view then reads as building (and asks again on its
    // own if this request is lost). Only a failed row: never one a hydration
    // is running on or one that is complete.
    try {
      await db
        .update(backupSnapshots)
        .set({ fileIndexStatus: 'none', fileIndexError: null })
        .where(and(
          eq(backupSnapshots.id, index.id),
          eq(backupSnapshots.orgId, orgId),
          eq(backupSnapshots.fileIndexStatus, 'failed'),
        ));
    } catch (err) {
      // Nothing was started: do not lock the person out for the window. The
      // error is rethrown unchanged (not caught into a 4xx/200), so the request
      // still fails as before.
      await releaseRebuildCooldown(index.id);
      throw err;
    }

    try {
      await enqueueSnapshotFileIndexHydration(index.id, 'rebuild', { force: true });
    } catch (err) {
      console.error(`[backup] Failed to request a file-index rebuild for snapshot ${index.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      // Nothing was started, so the person may try again at once.
      await releaseRebuildCooldown(index.id);
      return c.json({ error: "Couldn't start rebuilding the file list. Try again in a moment.", code: 'rebuild_unavailable' }, 503);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.snapshot.file_index.rebuild',
      resourceType: 'backup_snapshot',
      resourceId: index.id,
      details: {
        snapshotIds: [index.id],
        previousState: index.view.state,
        ...(index.view.state === 'unavailable' ? { previousFailure: index.view.failure } : {}),
      },
    });

    const building: SnapshotIndexView = { state: 'building' };
    return c.json({ index: building }, 202);
  },
);

snapshotsRoutes.post(
  '/snapshots/:id/legal-hold',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotProtectionReasonSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: snapshotId } = c.req.valid('param');
    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'snapshot', id: snapshotId, role: 'source' },
    ], 'verify');
    if (!authorization.ok) return authorization.response;

    if (await isOrgErasureInProgress(orgId)) {
      return c.json(
        { error: 'This organization is being erased; a new legal hold cannot be placed.' },
        409,
      );
    }

    const [before] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!before) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const [updated] = await db
      .update(backupSnapshots)
      .set({
        legalHold: true,
        legalHoldReason: payload.reason.trim(),
        metadata: withLegalHoldSource(before.metadata, 'manual'),
      })
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.snapshot.legal_hold.apply',
      resourceType: 'backup_snapshot',
      resourceId: updated.id,
      resourceName: updated.label ?? updated.snapshotId,
      details: {
        snapshotIds: [updated.id],
        reason: payload.reason.trim(),
        before: toProtectionState(before),
        after: toProtectionState(updated),
      },
    });

    return c.json(toSnapshotResponse(updated));
  },
);

async function releaseLegalHold(c: any) {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: snapshotId } = c.req.valid('param');
  const payload = c.req.valid('json');
  const authorization = await authorizeRouteResilienceResources(c, orgId, [
    { kind: 'snapshot', id: snapshotId, role: 'source' },
  ], 'verify');
  if (!authorization.ok) return authorization.response;

  const [before] = await db
    .select()
    .from(backupSnapshots)
    .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
    .limit(1);

  if (!before) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  const [updated] = await db
    .update(backupSnapshots)
    .set({
      legalHold: false,
      legalHoldReason: null,
      metadata: withLegalHoldSource(before.metadata, null),
    })
    .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
    .returning();

  if (!updated) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.snapshot.legal_hold.release',
    resourceType: 'backup_snapshot',
    resourceId: updated.id,
    resourceName: updated.label ?? updated.snapshotId,
    details: {
      snapshotIds: [updated.id],
      reason: payload.reason.trim(),
      before: toProtectionState(before),
      after: toProtectionState(updated),
    },
  });

  return c.json(toSnapshotResponse(updated));
}

snapshotsRoutes.post(
  '/snapshots/:id/legal-hold/release',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotProtectionReasonSchema),
  releaseLegalHold,
);

snapshotsRoutes.delete(
  '/snapshots/:id/legal-hold',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotProtectionReasonSchema),
  releaseLegalHold,
);

snapshotsRoutes.post(
  '/snapshots/:id/immutability',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotImmutabilityApplySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: snapshotId } = c.req.valid('param');
    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'snapshot', id: snapshotId, role: 'source' },
    ], 'verify');
    if (!authorization.ok) return authorization.response;

    const [before] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!before) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const [updated] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!updated) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const immutableUntil = payload.extendUntil
      ? new Date(payload.extendUntil)
      : computeImmutableUntilFromNow(payload.immutableDays ?? 0);
    if (Number.isNaN(immutableUntil.getTime())) {
      return c.json({ error: 'extendUntil must be a valid ISO-8601 timestamp' }, 400);
    }
    if (immutableUntil <= new Date()) {
      return c.json({ error: 'Immutability must end in the future' }, 400);
    }

    if (before.immutableUntil && immutableUntil <= before.immutableUntil) {
      return c.json({
        error: 'Immutability can only be extended forward. Use the release endpoint to weaken application protection.',
      }, 409);
    }

    let immutabilityEnforcement: 'application' | 'provider' =
      before.immutabilityEnforcement === 'provider'
        ? 'provider'
        : payload.enforcement;

    if (payload.enforcement === 'provider') {
      const storage = await resolveSnapshotStorageConfig(updated.configId ?? null);
      if (!storage) {
        return c.json({ error: 'Snapshot storage configuration is unavailable' }, 409);
      }
      // checkBackupProviderCapabilities now throws (rather than answering
      // "unsupported") when the stored config itself is unusable — e.g. a
      // malformed endpoint. Surface that as its own message instead of
      // reporting a config error to the user as "object lock is not enabled".
      let capability: Awaited<ReturnType<typeof checkBackupProviderCapabilities>>;
      try {
        capability = await checkBackupProviderCapabilities({
          provider: storage.provider,
          providerConfig: storage.providerConfig,
        });
      } catch (error) {
        return c.json({
          error: error instanceof Error
            ? `Snapshot storage configuration is invalid: ${error.message}`
            : 'Snapshot storage configuration is invalid',
        }, 409);
      }
      if (!capability.objectLock.supported) {
        return c.json({
          error: capability.objectLock.error ?? 'Bucket object lock is not enabled',
        }, 409);
      }
      try {
        await applyBackupSnapshotImmutability({
          provider: storage.provider,
          providerConfig: storage.providerConfig,
          snapshotId: updated.snapshotId,
          keyLayout: updated.keyLayout,
          keyPrefix: updated.keyPrefix,
          metadata: updated.metadata,
          retainUntil: immutableUntil,
        });
      } catch (err) {
        return c.json({
          error: err instanceof Error ? err.message : 'Failed to apply provider-enforced immutability',
        }, 409);
      }
      immutabilityEnforcement = 'provider';
    }

    const [saved] = await db
      .update(backupSnapshots)
      .set({
        isImmutable: true,
        immutableUntil,
        immutabilityEnforcement,
        requestedImmutabilityEnforcement: immutabilityEnforcement,
        immutabilityFallbackReason: null,
      })
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .returning();

    if (!saved) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: `backup.snapshot.immutability.apply.${immutabilityEnforcement}`,
      resourceType: 'backup_snapshot',
      resourceId: saved.id,
      resourceName: saved.label ?? saved.snapshotId,
      details: {
        snapshotIds: [saved.id],
        reason: payload.reason.trim(),
        immutableDays: payload.immutableDays,
        before: toProtectionState(before),
        requestedEnforcement: payload.enforcement,
        after: toProtectionState(saved),
      },
    });

    return c.json(toSnapshotResponse(saved));
  },
);

snapshotsRoutes.post(
  '/snapshots/:id/immutability/release',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotProtectionReasonSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: snapshotId } = c.req.valid('param');
    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'snapshot', id: snapshotId, role: 'source' },
    ], 'verify');
    if (!authorization.ok) return authorization.response;

    const [before] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!before) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    if (before.immutabilityEnforcement === 'provider') {
      return c.json({ error: 'Provider-enforced immutability must be released by the storage provider' }, 409);
    }

    const [updated] = await db
      .update(backupSnapshots)
      .set({
        isImmutable: false,
        immutableUntil: null,
        immutabilityEnforcement: null,
        requestedImmutabilityEnforcement: null,
        immutabilityFallbackReason: null,
      })
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.snapshot.immutability.release',
      resourceType: 'backup_snapshot',
      resourceId: updated.id,
      resourceName: updated.label ?? updated.snapshotId,
      details: {
        snapshotIds: [updated.id],
        reason: payload.reason.trim(),
        before: toProtectionState(before),
        after: toProtectionState(updated),
      },
    });

    return c.json(toSnapshotResponse(updated));
  },
);

type SnapshotHardwareSizing = {
  cpuCores: number | null;
  totalMemoryMB: number | null;
  disks: { sizeBytes: number }[];
};

/**
 * Restore-as-VM snapshot cards show CPU / memory / disk chips. The stored
 * profile (the agent's systemstate.HardwareProfile) also carries NICs with MAC
 * addresses, BIOS and board strings the list has no use for, so only the
 * sizing fields ride, under their stored names. Null when none was captured.
 */
function toHardwareSizing(profile: unknown): SnapshotHardwareSizing | null {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const stored = profile as Record<string, unknown>;
  const positive = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  const disks = Array.isArray(stored.disks)
    ? stored.disks.flatMap((disk) => {
        const sizeBytes = disk && typeof disk === 'object' ? positive((disk as Record<string, unknown>).sizeBytes) : null;
        return sizeBytes === null ? [] : [{ sizeBytes }];
      })
    : [];
  return {
    cpuCores: positive(stored.cpuCores),
    totalMemoryMB: positive(stored.totalMemoryMB),
    disks,
  };
}

function toSnapshotResponse(row: typeof backupSnapshots.$inferSelect) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    configId: row.configId ?? null,
    jobId: row.jobId,
    createdAt: row.timestamp.toISOString(),
    backupType: row.backupType ?? 'file',
    bareMetalRestorable: row.bareMetalRestorable ?? null,
    bareMetalReasons: row.bareMetalReasons ?? [],
    // Storage key of the disk-layout manifest (bare-metal W01), null when the
    // run captured none. Restore-as-VM offers the rebuild engine only for
    // snapshots that carry one (W05a); the manifest body stays off the list.
    layoutManifestKey: row.layoutManifest ? backupLayoutManifestKey(row.snapshotId) : null,
    // W06d: the layout's platform ('linux' | 'windows', null when absent or
    // unknown). The rebuild engine is platform-matched, so Restore-as-VM
    // filters rebuild hosts by it; a null platform cannot be rebuilt.
    layoutPlatform: resolveSnapshotPlatform(row.layoutManifest),
    hardwareProfile: toHardwareSizing(row.hardwareProfile),
    sizeBytes: row.size ?? null,
    fileCount: row.fileCount ?? null,
    label: row.label ?? null,
    location: row.location ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    legalHold: row.legalHold === true,
    legalHoldReason: row.legalHoldReason ?? null,
    legalHoldSource: resolveLegalHoldSource(row.metadata),
    isImmutable: row.isImmutable === true,
    immutableUntil: row.immutableUntil?.toISOString() ?? null,
    immutabilityEnforcement: row.immutabilityEnforcement ?? null,
    requestedImmutabilityEnforcement: row.requestedImmutabilityEnforcement ?? null,
    immutabilityFallbackReason: row.immutabilityFallbackReason ?? null,
    retentionBlockedReason: computeRetentionBlockedReason(row),
    // Display projection of the snapshot attestation (restores decide on the
    // attestation itself): 'attested' | 'producer_only' | 'pending' |
    // 'unattested' | 'unattested_legacy' | 'attestation_failed'. A row read
    // without the column reads as written before attestations.
    integrityStatus: row.integrityStatus ?? 'unattested_legacy',
  };
}
