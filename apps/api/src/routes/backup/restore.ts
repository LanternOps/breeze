import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'crypto';
import { writeRouteAudit } from '../../services/auditEvents';
import type { RestoreJob } from './types';
import { resolveScopedOrgId } from './helpers';
import { backupJobs, backupSnapshots, jobOrgById, restoreJobs, restoreOrgById, snapshotOrgById } from './store';
import { restoreSchema } from './schemas';

export const restoreRoutes = new Hono();

restoreRoutes.post('/restore', zValidator('json', restoreSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const payload = c.req.valid('json');
  const snapshot = backupSnapshots.find(
    (item) => item.id === payload.snapshotId && snapshotOrgById.get(item.id) === orgId
  );
  if (!snapshot) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  const now = new Date().toISOString();
  const restoreJob: RestoreJob = {
    id: randomUUID(),
    snapshotId: snapshot.id,
    deviceId: payload.deviceId ?? snapshot.deviceId,
    status: 'queued',
    targetPath: payload.targetPath,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    progress: 0
  };

  restoreJobs.push(restoreJob);
  restoreOrgById.set(restoreJob.id, orgId);
  backupJobs.push({
    id: restoreJob.id,
    type: 'restore',
    trigger: 'restore',
    deviceId: restoreJob.deviceId,
    configId: snapshot.configId,
    snapshotId: snapshot.id,
    status: 'queued',
    createdAt: now,
    updatedAt: now
  });
  jobOrgById.set(restoreJob.id, orgId);

  writeRouteAudit(c, {
    orgId,
    action: 'backup.restore.create',
    resourceType: 'restore_job',
    resourceId: restoreJob.id,
    details: {
      snapshotId: snapshot.id,
      deviceId: restoreJob.deviceId
    }
  });

  return c.json(restoreJob, 201);
});

restoreRoutes.get('/restore/:id', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const restoreId = c.req.param('id');
  if (restoreOrgById.get(restoreId) !== orgId) {
    return c.json({ error: 'Restore job not found' }, 404);
  }
  const restoreJob = restoreJobs.find((item) => item.id === restoreId);
  if (!restoreJob) {
    return c.json({ error: 'Restore job not found' }, 404);
  }
  return c.json(restoreJob);
});
