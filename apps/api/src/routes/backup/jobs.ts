import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'crypto';
import { writeRouteAudit } from '../../services/auditEvents';
import type { BackupJob } from './types';
import { resolveScopedOrgId, toDateOrNull } from './helpers';
import { backupConfigs, backupJobs, backupPolicies, configOrgById, jobOrgById, policyOrgById } from './store';
import { jobListSchema } from './schemas';

export const jobsRoutes = new Hono();

jobsRoutes.get('/jobs', zValidator('query', jobListSchema), (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  const deviceFilter = query.deviceId ?? query.device;
  const from = toDateOrNull(query.from);
  const to = toDateOrNull(query.to);

  let results = backupJobs.filter((job) => jobOrgById.get(job.id) === orgId);

  if (query.status) {
    results = results.filter((job) => job.status === query.status);
  }

  if (deviceFilter) {
    results = results.filter((job) => job.deviceId === deviceFilter);
  }

  if (query.date) {
    const datePrefix = query.date.slice(0, 10);
    results = results.filter((job) => (job.startedAt ?? job.createdAt).startsWith(datePrefix));
  }

  if (from) {
    results = results.filter((job) => {
      const timestamp = toDateOrNull(job.startedAt ?? job.createdAt);
      return timestamp !== null && timestamp >= from;
    });
  }

  if (to) {
    results = results.filter((job) => {
      const timestamp = toDateOrNull(job.startedAt ?? job.createdAt);
      return timestamp !== null && timestamp <= to;
    });
  }

  results.sort((a, b) => {
    const aTime = toDateOrNull(a.startedAt ?? a.createdAt) ?? 0;
    const bTime = toDateOrNull(b.startedAt ?? b.createdAt) ?? 0;
    return bTime - aTime;
  });

  return c.json({ data: results });
});

jobsRoutes.get('/jobs/:id', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const jobId = c.req.param('id');
  if (jobOrgById.get(jobId) !== orgId) {
    return c.json({ error: 'Job not found' }, 404);
  }
  const job = backupJobs.find((item) => item.id === jobId);
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }
  return c.json(job);
});

jobsRoutes.post('/jobs/run/:deviceId', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.param('deviceId');
  const policy = backupPolicies.find(
    (item) => item.targets.deviceIds.includes(deviceId) && policyOrgById.get(item.id) === orgId
  );
  const configId = policy?.configId ?? backupConfigs.find((item) => configOrgById.get(item.id) === orgId)?.id;
  if (!configId || configOrgById.get(configId) !== orgId) {
    return c.json({ error: 'No backup config available' }, 400);
  }

  const now = new Date().toISOString();
  const job: BackupJob = {
    id: randomUUID(),
    type: 'backup',
    trigger: 'manual',
    deviceId,
    configId,
    policyId: policy?.id ?? null,
    status: 'running',
    startedAt: now,
    createdAt: now,
    updatedAt: now
  };

  backupJobs.push(job);
  jobOrgById.set(job.id, orgId);
  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.run',
    resourceType: 'backup_job',
    resourceId: job.id,
    details: { deviceId, configId, policyId: policy?.id ?? null }
  });
  return c.json(job, 201);
});

jobsRoutes.post('/jobs/:id/cancel', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const jobId = c.req.param('id');
  if (jobOrgById.get(jobId) !== orgId) {
    return c.json({ error: 'Job not found' }, 404);
  }
  const job = backupJobs.find((item) => item.id === jobId);
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  if (job.status !== 'running' && job.status !== 'queued') {
    return c.json({ error: 'Job is not cancelable' }, 409);
  }

  job.status = 'canceled';
  job.completedAt = new Date().toISOString();
  job.updatedAt = job.completedAt;
  job.error = 'Canceled by user';

  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.cancel',
    resourceType: 'backup_job',
    resourceId: job.id,
    details: { deviceId: job.deviceId }
  });

  return c.json(job);
});
