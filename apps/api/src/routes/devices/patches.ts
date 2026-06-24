import { Hono } from 'hono';
import { eq, desc, inArray, and, sql, gte } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { patches, devicePatches, patchApprovals, deviceCommands, users } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { queueCommandForExecution } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolvePartnerIdForOrg } from '../patches/helpers';

export const patchesRoutes = new Hono();

patchesRoutes.use('*', authMiddleware);

const installPatchesSchema = z.object({
  patchIds: z.array(z.string().guid()).min(1)
});

const rollbackPatchParamsSchema = z.object({
  id: z.string().guid(),
  patchId: z.string().guid()
});

const patchHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  type: z.enum(['install', 'scan', 'rollback', 'all']).default('all'),
  status: z.enum(['completed', 'failed', 'pending', 'timeout', 'all']).default('all'),
  completedAfter: z.string().datetime({ offset: true }).optional()
});

const PATCH_COMMAND_TYPES = ['install_patches', 'patch_scan', 'rollback_patches', 'download_patches'] as const;
const LINUX_SOFTWARE_UPDATE_COMMAND_TYPE = 'software_update';

const TYPE_FILTER_MAP: Record<string, string[]> = {
  install: ['install_patches'],
  scan: ['patch_scan'],
  rollback: ['rollback_patches'],
  all: [...PATCH_COMMAND_TYPES]
};

function commandTypesForPatchHistory(type: string, osType?: string | null): string[] {
  const commandTypes = [...(TYPE_FILTER_MAP[type] ?? PATCH_COMMAND_TYPES)];
  const normalizedOsType = (osType ?? '').toLowerCase();
  if ((type === 'install' || type === 'all') && normalizedOsType === 'linux') {
    commandTypes.push(LINUX_SOFTWARE_UPDATE_COMMAND_TYPE);
  }
  return commandTypes;
}

function safeParsePatchResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const raw = result as Record<string, unknown>;

  // The agent sends {status, exitCode, stdout, error, durationMs} where stdout
  // is a JSON string containing the actual patch results (installedCount,
  // failedCount, results[], rebootRequired, etc.).  The UI expects those fields
  // directly on the result object, so we parse stdout and merge its contents up.
  let parsed: Record<string, unknown> | null = null;
  if (typeof raw.stdout === 'string') {
    try {
      const obj = JSON.parse(raw.stdout);
      if (obj && typeof obj === 'object') {
        parsed = obj as Record<string, unknown>;
      }
    } catch (parseErr) {
      // Log a warning when stdout looks like JSON but fails to parse
      if (raw.stdout && (raw.stdout as string).trimStart().startsWith('{')) {
        console.warn('[patches] Failed to parse agent stdout as JSON:', parseErr instanceof Error ? parseErr.message : parseErr);
      }
    }
  } else if (raw.stdout && typeof raw.stdout === 'object') {
    parsed = raw.stdout as Record<string, unknown>;
  }

  if (parsed) {
    // Merge patch-specific fields up to the top level so the UI can find them
    const { results, installedCount, failedCount, rebootRequired, success,
            rolledBackCount, pendingCount, scannedCount, ...rest } = parsed;
    if (results !== undefined) raw.results = results;
    if (installedCount !== undefined) raw.installedCount = installedCount;
    if (failedCount !== undefined) raw.failedCount = failedCount;
    if (rebootRequired !== undefined) raw.rebootRequired = rebootRequired;
    if (success !== undefined) raw.success = success;
    if (rolledBackCount !== undefined) raw.rolledBackCount = rolledBackCount;
    if (pendingCount !== undefined) raw.pendingCount = pendingCount;
    if (scannedCount !== undefined) raw.scannedCount = scannedCount;
    // Keep parsed stdout for debugging but don't overwrite merged fields
    raw.stdout = parsed;
  }

  // Map agent's "error" field to "errorMessage" which the UI expects
  if (raw.error && !raw.errorMessage) {
    raw.errorMessage = raw.error;
  }

  // Also map per-patch "error" → "errorMessage" in the results array
  if (Array.isArray(raw.results)) {
    for (const item of raw.results) {
      if (item && typeof item === 'object') {
        const patch = item as Record<string, unknown>;
        if (patch.error && !patch.errorMessage) {
          patch.errorMessage = patch.error;
        }
      }
    }
  }

  return raw;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePatchHistoryResult(
  commandType: string,
  payload: unknown,
  result: unknown,
  osType?: string | null
): unknown {
  const parsed = safeParsePatchResult(result);
  if (commandType !== LINUX_SOFTWARE_UPDATE_COMMAND_TYPE || (osType ?? '').toLowerCase() !== 'linux') {
    return parsed;
  }

  const raw = asRecord(parsed);
  if (!raw) return parsed;

  const stdout = asRecord(raw.stdout);
  if (stdout?.success !== true) {
    return parsed;
  }

  const payloadRecord = asRecord(payload);
  const name = stringField(stdout, 'name') || stringField(payloadRecord, 'name');
  if (!name) {
    return parsed;
  }

  const packageId = stringField(stdout, 'packageId');
  const version = stringField(stdout, 'version');
  return {
    ...raw,
    installedCount: 1,
    failedCount: 0,
    success: true,
    results: [
      {
        id: packageId || name,
        installId: packageId || name,
        name,
        title: name,
        source: 'linux',
        externalId: packageId || name,
        packageId: packageId || undefined,
        version: version || undefined,
        status: 'installed',
      }
    ]
  };
}

/**
 * Resolve which of the given patch IDs carry an explicit partner-wide manual-approval
 * record (`patchApprovals.status = 'approved'`) for the partner.
 *
 * This is intentionally only the partner-wide manual-approval gate. It does NOT consider
 * the device's effective patch ring or category/auto-approve rules — for the full
 * ring + category-aware evaluation see `resolveApprovedPatchesForDevice` in
 * `services/patchApprovalEvaluator.ts`.
 *
 * Known limitation: because this gate is partner-wide and ring-agnostic, a patch that is
 * approved for ring A passes this gate for a device in ring B. Wiring the install
 * endpoint through the full evaluator (`resolveApprovedPatchesForDevice`) is a tracked
 * follow-up.
 */
async function getApprovedPatchIdsForPartner(partnerId: string, patchIds: string[]): Promise<Set<string>> {
  if (patchIds.length === 0) return new Set();

  // patch_approvals is partner-axis RLS. An org-scoped caller's DB context has
  // accessiblePartnerIds=[] → the table returns 0 rows in request context.
  // Escape to system context: the partnerId is SERVER-DERIVED from the device's
  // org (already access-checked), so reading their approvals does not leak
  // cross-partner data (#rls_silent_zero_row_read_sdk_poll).
  const approvals = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ patchId: patchApprovals.patchId })
        .from(patchApprovals)
        .where(
          and(
            eq(patchApprovals.partnerId, partnerId),
            inArray(patchApprovals.patchId, patchIds),
            eq(patchApprovals.status, 'approved')
          )
        )
    )
  );

  return new Set(approvals.map((approval) => approval.patchId));
}

// GET /devices/:id/patches/history - Get patch operation history for a device
patchesRoutes.get(
  '/:id/patches/history',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', patchHistoryQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { limit, offset, type, status, completedAfter } = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const commandTypes = commandTypesForPatchHistory(type, device.osType);

    const conditions = [
      eq(deviceCommands.deviceId, deviceId),
      inArray(deviceCommands.type, commandTypes)
    ];
    if (status !== 'all') {
      conditions.push(eq(deviceCommands.status, status));
    }
    if (completedAfter) {
      conditions.push(gte(deviceCommands.completedAt, new Date(completedAfter)));
    }
    const whereClause = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceCommands)
      .where(whereClause);
    const total = Number(countResult[0]?.count ?? 0);

    // Get paginated results with user join
    const rows = await db
      .select({
        id: deviceCommands.id,
        type: deviceCommands.type,
        payload: deviceCommands.payload,
        status: deviceCommands.status,
        createdAt: deviceCommands.createdAt,
        completedAt: deviceCommands.completedAt,
        result: deviceCommands.result,
        createdBy: deviceCommands.createdBy,
        createdByEmail: users.email
      })
      .from(deviceCommands)
      .leftJoin(users, eq(deviceCommands.createdBy, users.id))
      .where(whereClause)
      .orderBy(desc(deviceCommands.createdAt))
      .limit(limit)
      .offset(offset);

    const history = rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      result: normalizePatchHistoryResult(row.type, row.payload, row.result, device.osType),
      createdBy: row.createdBy,
      createdByEmail: row.createdByEmail
    }));

    return c.json({ history, total });
  }
);

// GET /devices/:id/patches - Get patch status for a device
patchesRoutes.get(
  '/:id/patches',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Get all patches associated with this device
    const devicePatchList = await db
      .select({
        id: devicePatches.id,
        patchId: devicePatches.patchId,
        status: devicePatches.status,
        installedAt: devicePatches.installedAt,
        lastCheckedAt: devicePatches.lastCheckedAt,
        failureCount: devicePatches.failureCount,
        lastError: devicePatches.lastError,
        // Join patch details
        title: patches.title,
        externalId: patches.externalId,
        description: patches.description,
        severity: patches.severity,
        category: patches.category,
        source: patches.source,
        packageId: patches.packageId,
        releaseDate: patches.releaseDate,
        requiresReboot: patches.requiresReboot
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(eq(devicePatches.deviceId, deviceId))
      .orderBy(desc(devicePatches.lastCheckedAt));

    const lastPatchScanRows = await db
      .select({
        status: deviceCommands.status,
        createdAt: deviceCommands.createdAt,
        completedAt: deviceCommands.completedAt,
      })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.type, 'patch_scan'),
          inArray(deviceCommands.status, ['completed', 'failed', 'timeout'])
        )
      )
      .orderBy(desc(sql`coalesce(${deviceCommands.completedAt}, ${deviceCommands.createdAt})`))
      .limit(1);

    const lastPatchScan = lastPatchScanRows[0] ?? null;
    const patchIds = [...new Set(devicePatchList.map((patch) => patch.patchId))];
    // Derive the partner from the device's org. If the lookup returns null (no partner
    // found), treat the approved set as empty — all patches are unapproved (fail-safe).
    const partnerId = await resolvePartnerIdForOrg(device.orgId);
    const approvedPatchIds = partnerId
      ? await getApprovedPatchIdsForPartner(partnerId, patchIds)
      : new Set<string>();

    // Separate actionable pending updates from stale missing records.
    const pending = devicePatchList
      .filter(p => p.status === 'pending')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
        externalId: p.externalId,
        packageId: p.packageId,
        description: p.description,
        severity: p.severity,
        status: p.status,
        releaseDate: p.releaseDate,
        category: p.category,
        source: p.source,
        requiresReboot: p.requiresReboot,
        approvalStatus: approvedPatchIds.has(p.patchId) ? 'approved' : 'pending'
      }));

    const missing = devicePatchList
      .filter(p => p.status === 'missing')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
        externalId: p.externalId,
        packageId: p.packageId,
        description: p.description,
        severity: p.severity,
        status: p.status,
        releaseDate: p.releaseDate,
        category: p.category,
        source: p.source,
        requiresReboot: p.requiresReboot,
        approvalStatus: approvedPatchIds.has(p.patchId) ? 'approved' : 'pending'
      }));

    const installed = devicePatchList
      .filter(p => p.status === 'installed' && p.source !== 'linux')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
        externalId: p.externalId,
        packageId: p.packageId,
        description: p.description,
        severity: p.severity,
        status: p.status,
        installedAt: p.installedAt,
        category: p.category,
        source: p.source,
        approvalStatus: approvedPatchIds.has(p.patchId) ? 'approved' : 'pending'
      }));

    const failed = devicePatchList
      .filter(p => p.status === 'failed')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
        externalId: p.externalId,
        description: p.description,
        severity: p.severity,
        status: p.status,
        lastError: p.lastError,
        failureCount: p.failureCount
      }));

    const total = pending.length + installed.length;
    const compliancePercent = total > 0
      ? Math.round((installed.length / total) * 100)
      : 100;

    return c.json({
      data: {
        compliancePercent,
        lastPatchScanAt: lastPatchScan?.completedAt ?? lastPatchScan?.createdAt ?? null,
        lastPatchScanStatus: lastPatchScan?.status ?? null,
        pending,
        missing,
        installed,
        failed,
        patches: devicePatchList.map(p => ({
          id: p.patchId,
          name: p.title,
          title: p.title,
          externalId: p.externalId,
          packageId: p.packageId,
          description: p.description,
          severity: p.severity,
          status: p.status,
          releaseDate: p.releaseDate,
          installedAt: p.installedAt,
          source: p.source,
          approvalStatus: approvedPatchIds.has(p.patchId) ? 'approved' : 'pending'
        }))
      }
    });
  }
);

// POST /devices/:id/patches/install - Queue patch install command for a device
patchesRoutes.post(
  '/:id/patches/install',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', installPatchesSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const patchRefs = await db
      .select({
        id: patches.id,
        source: patches.source,
        externalId: patches.externalId,
        packageId: patches.packageId,
        title: patches.title
      })
      .from(patches)
      .where(inArray(patches.id, data.patchIds));

    if (patchRefs.length === 0) {
      return c.json({ error: 'No matching patches found' }, 404);
    }
    const foundPatchIds = new Set(patchRefs.map((patch) => patch.id));
    const missingPatchIds = data.patchIds.filter((patchId) => !foundPatchIds.has(patchId));
    if (missingPatchIds.length > 0) {
      return c.json({
        error: 'Some patches were not found',
        missingPatchIds
      }, 404);
    }

    // Derive the partner from the device's org. If null (no partner found), approved
    // set is empty — all patches are treated as unapproved and installs are BLOCKED
    // (fail-safe: an orphaned org cannot install any patches).
    const partnerId = await resolvePartnerIdForOrg(device.orgId);
    const approvedPatchIds = partnerId
      ? await getApprovedPatchIdsForPartner(partnerId, data.patchIds)
      : new Set<string>();
    const unapprovedPatchIds = data.patchIds.filter((patchId) => !approvedPatchIds.has(patchId));
    if (unapprovedPatchIds.length > 0) {
      return c.json({
        error: 'Only approved patches can be installed',
        unapprovedPatchIds
      }, 409);
    }

    const queued = await queueCommandForExecution(
      deviceId,
      'install_patches',
      {
        patchIds: data.patchIds,
        patches: patchRefs
      },
      {
        userId: auth.user.id,
        preferHeartbeat: false
      }
    );

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue install_patches command' }, 503);
    }

    const command = queued.command;

    const patchNames = patchRefs.map(p => p.title).filter(Boolean);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.patch.install.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: command.id,
        commandStatus: command.status,
        patchCount: data.patchIds.length,
        patchNames
      }
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      patchCount: data.patchIds.length,
      patchNames
    });
  }
);

// POST /devices/:id/patches/:patchId/rollback - Queue patch rollback command for a device
patchesRoutes.post(
  '/:id/patches/:patchId/rollback',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', rollbackPatchParamsSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, patchId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [patch] = await db
      .select({
        id: patches.id,
        source: patches.source,
        externalId: patches.externalId,
        title: patches.title
      })
      .from(patches)
      .where(eq(patches.id, patchId))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    const queued = await queueCommandForExecution(
      deviceId,
      'rollback_patches',
      {
        patchIds: [patchId],
        patches: [patch]
      },
      {
        userId: auth.user.id,
        preferHeartbeat: false
      }
    );

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue rollback_patches command' }, 503);
    }

    const command = queued.command;

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.patch.rollback.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: command.id,
        commandStatus: command.status,
        patchId
      }
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      patchId
    });
  }
);
