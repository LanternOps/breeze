import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { resolveScopedOrgId, toDateOrNull } from './helpers';
import { attachDeviceNames } from './deviceNames';
import {
  backupHealthQuerySchema,
  recoveryReadinessQuerySchema,
  verificationListSchema,
  verificationRunSchema
} from './schemas';
import {
  BACKUP_HIGH_READINESS_THRESHOLD,
  BACKUP_LOW_READINESS_THRESHOLD,
  BackupVerificationDispatchError,
  getBackupHealthSummary,
  listBackupVerifications,
  listRecoveryReadiness,
  recalculateReadinessScores,
  runBackupVerification,
  toVerificationListItem
} from './verificationService';

export const backupVerificationRoutes = new Hono();

async function isDeviceSiteDenied(orgId: string, deviceId: string, permissions: UserPermissions | undefined): Promise<boolean> {
  if (!permissions?.allowedSiteIds) return false;
  const [device] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return !device || typeof device.siteId !== 'string' || !canAccessSite(permissions, device.siteId);
}

/**
 * The caller's site ceiling. `auth.allowedSiteIds` is the primary source: the
 * auth middleware always populates it, while `c.get('permissions')` is only
 * set by `requirePermission`. The `permissions` fallback is kept so a route
 * mounted without `requirePermission` still finds a ceiling if one is present
 * — reading both can only ever make this stricter, never looser.
 */
function allowedSiteIds(
  auth: { allowedSiteIds?: string[] } | undefined,
  c: { get(key: 'permissions'): unknown },
): string[] | undefined {
  return auth?.allowedSiteIds ?? (c.get('permissions') as UserPermissions | undefined)?.allowedSiteIds;
}

/**
 * Payload for a caller whose site ceiling is defined but empty: they can see
 * no device, so there is nothing to summarize. `coveragePercent` and `status`
 * are deliberately `null`/`'unknown'` rather than `100`/`'healthy'` — a reader
 * who can see nothing has not observed a healthy fleet, and reporting full
 * coverage off zero devices is an affirmative false assurance.
 */
export function emptyHealthSummary() {
  return {
    verification: { total: 0, passedLast24h: 0, failedLast24h: 0, partialLast24h: 0, coveragePercent: null },
    readiness: { averageScore: 0, lowReadinessCount: 0, criticalDevicesAtRisk: 0 },
    escalations: { verificationFailures: 0, criticalVerificationFailures: 0 },
  };
}

/** The verdict the summary route and the `manage_backup_verification` tool both report. */
export function verificationHealthStatus(summary: Awaited<ReturnType<typeof getBackupHealthSummary>>): 'critical' | 'degraded' | 'healthy' {
  if (summary.escalations.criticalVerificationFailures > 0) return 'critical';
  return summary.readiness.lowReadinessCount > 0 ? 'degraded' : 'healthy';
}

/** The fleet roll-up the readiness route and the `manage_backup_verification` tool both report. */
export function summarizeRecoveryReadiness(rows: ReadonlyArray<{ readinessScore: number }>) {
  return {
    devices: rows.length,
    averageScore: rows.length > 0
      ? Math.round((rows.reduce((sum, row) => sum + row.readinessScore, 0) / rows.length) * 10) / 10
      : 0,
    lowReadiness: rows.filter((row) => row.readinessScore < BACKUP_LOW_READINESS_THRESHOLD).length,
    highReadiness: rows.filter((row) => row.readinessScore >= BACKUP_HIGH_READINESS_THRESHOLD).length,
  };
}

/**
 * Sorts a failed `runBackupVerification` into what its caller may repeat. The
 * service throws plain `Error`s, so validation is told apart by message; anything
 * else stays generic and is the caller's to log. Shared by POST /verify and the
 * `manage_backup_verification` tool so the two cannot disagree on what leaks.
 */
export function classifyVerificationRunError(error: unknown): { message: string; code: 'VALIDATION' | 'DISPATCH' | 'INTERNAL'; status: number } {
  const message = error instanceof Error ? error.message : 'Verification failed to start';
  if (error instanceof BackupVerificationDispatchError) {
    return { message, code: 'DISPATCH', status: error.statusCode };
  }
  const isValidation = error instanceof Error && (
    message.includes('not found') ||
    message.includes('does not belong') ||
    message.includes('required')
  );
  return isValidation
    ? { message, code: 'VALIDATION', status: 400 }
    : { message: 'Internal server error', code: 'INTERNAL', status: 500 };
}

backupVerificationRoutes.get('/health', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('query', backupHealthQuerySchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  const siteIds = allowedSiteIds(auth, c);
  if (siteIds?.length === 0) {
    return c.json({ data: { status: 'unknown', ...emptyHealthSummary() } });
  }
  if (query.refresh === true) {
    await recalculateReadinessScores(orgId, siteIds);
  }
  const summary = await getBackupHealthSummary(orgId, siteIds);

  return c.json({
    data: {
      status: verificationHealthStatus(summary),
      ...summary
    }
  });
});

backupVerificationRoutes.post(
  '/verify',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', verificationRunSchema),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const payload = c.req.valid('json');
  const verificationType = payload.verificationType ?? 'integrity';
  if (await isDeviceSiteDenied(orgId, payload.deviceId, c.get('permissions') as UserPermissions | undefined)) {
    return c.json({ error: 'Access to this site denied' }, 403);
  }

  try {
    const { verification, readiness } = await runBackupVerification({
      orgId,
      deviceId: payload.deviceId,
      verificationType,
      backupJobId: payload.backupJobId,
      snapshotId: payload.snapshotId,
      source: 'api.verify',
      requestedBy: auth?.user?.id ?? null
    });

    writeRouteAudit(c, {
      orgId,
      action: 'backup.verification.run',
      resourceType: 'backup_verification',
      resourceId: verification.id,
      details: {
        deviceId: verification.deviceId,
        backupJobId: verification.backupJobId,
        snapshotId: verification.snapshotId,
        verificationType: verification.verificationType,
        status: verification.status
      }
    });

    return c.json({
      data: {
        verification,
        readiness,
      }
    }, 201);
  } catch (error) {
    const classified = classifyVerificationRunError(error);
    if (classified.code === 'INTERNAL') {
      console.error('[backupVerification] Unexpected error in POST /verify:', error);
    }
    return c.json({ error: classified.message }, classified.status as any);
  }
});

backupVerificationRoutes.get('/verifications', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('query', verificationListSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  const siteIds = allowedSiteIds(auth, c);
  if (siteIds?.length === 0) return c.json({ data: [] });
  const rows = await listBackupVerifications(orgId, {
    deviceId: query.deviceId,
    backupJobId: query.backupJobId,
    verificationType: query.verificationType,
    status: query.status,
    from: toDateOrNull(query.from),
    to: toDateOrNull(query.to),
    limit: query.limit ?? 100,
    allowedSiteIds: siteIds,
  });

  return c.json({
    // Keep the HTTP serialization boundary explicit even though the shared
    // list service also projects for its internal callers.
    data: await attachDeviceNames(orgId, rows.map(toVerificationListItem))
  });
});

backupVerificationRoutes.get('/recovery-readiness', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('query', recoveryReadinessQuerySchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  const siteIds = allowedSiteIds(auth, c);
  if (siteIds?.length === 0) {
    return c.json({ data: { summary: { devices: 0, averageScore: 0, lowReadiness: 0, highReadiness: 0 }, devices: [] } });
  }
  if (query.refresh === true) {
    await recalculateReadinessScores(orgId, siteIds);
  }
  let rows = await listRecoveryReadiness(orgId, siteIds);
  if (query.deviceId) {
    rows = rows.filter((row) => row.deviceId === query.deviceId);
  }

  return c.json({
    data: {
      summary: summarizeRecoveryReadiness(rows),
      devices: await attachDeviceNames(orgId, rows)
    }
  });
});
