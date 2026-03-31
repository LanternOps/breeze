import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId, toDateOrNull } from './helpers';
import {
  backupHealthQuerySchema,
  recoveryReadinessQuerySchema,
  verificationListSchema,
  verificationRunSchema
} from './schemas';
import {
  BACKUP_HIGH_READINESS_THRESHOLD,
  BACKUP_LOW_READINESS_THRESHOLD,
  getBackupHealthSummary,
  listBackupVerifications,
  listRecoveryReadiness,
  recalculateReadinessScores,
  runBackupVerification
} from './verificationService';

export const backupVerificationRoutes = new Hono();

backupVerificationRoutes.get('/health', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('query', backupHealthQuerySchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  if (query.refresh === true) {
    await recalculateReadinessScores(orgId);
  }
  const summary = await getBackupHealthSummary(orgId);

  return c.json({
    data: {
      status: summary.escalations.criticalVerificationFailures > 0
        ? 'critical'
        : summary.readiness.lowReadinessCount > 0
          ? 'degraded'
          : 'healthy',
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
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const payload = c.req.valid('json');
  const verificationType = payload.verificationType ?? 'integrity';

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

    const simulated = !!(verification.details as Record<string, unknown>)?.simulated;
    return c.json({
      data: {
        verification,
        readiness,
        simulated,
      }
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verification failed to start';
    const isValidation = error instanceof Error && (
      message.includes('not found') ||
      message.includes('does not belong') ||
      message.includes('required')
    );
    if (!isValidation) {
      console.error('[backupVerification] Unexpected error in POST /verify:', error);
    }
    return c.json({ error: isValidation ? message : 'Internal server error' }, isValidation ? 400 : 500);
  }
});

backupVerificationRoutes.get('/verifications', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('query', verificationListSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  const rows = await listBackupVerifications(orgId, {
    deviceId: query.deviceId,
    backupJobId: query.backupJobId,
    verificationType: query.verificationType,
    status: query.status,
    from: toDateOrNull(query.from),
    to: toDateOrNull(query.to),
    limit: query.limit ?? 100
  });

  return c.json({
    data: rows
  });
});

backupVerificationRoutes.get('/recovery-readiness', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('query', recoveryReadinessQuerySchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  if (query.refresh === true) {
    await recalculateReadinessScores(orgId);
  }
  let rows = await listRecoveryReadiness(orgId);
  if (query.deviceId) {
    rows = rows.filter((row) => row.deviceId === query.deviceId);
  }

  const summary = {
    devices: rows.length,
    averageScore: rows.length > 0
      ? Math.round((rows.reduce((sum, row) => sum + row.readinessScore, 0) / rows.length) * 10) / 10
      : 0,
    lowReadiness: rows.filter((row) => row.readinessScore < BACKUP_LOW_READINESS_THRESHOLD).length,
    highReadiness: rows.filter((row) => row.readinessScore >= BACKUP_HIGH_READINESS_THRESHOLD).length
  };

  return c.json({
    data: {
      summary,
      devices: rows
    }
  });
});
