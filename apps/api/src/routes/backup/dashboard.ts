import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { getNextRun, resolveScopedOrgId, toDateOrNull } from './helpers';
import {
  backupConfigs,
  backupJobs,
  backupPolicies,
  backupSnapshots,
  configOrgById,
  jobOrgById,
  policyOrgById,
  snapshotOrgById
} from './store';
import { usageHistoryQuerySchema } from './schemas';

export const dashboardRoutes = new Hono();

dashboardRoutes.get('/usage-history', zValidator('query', usageHistoryQuerySchema), (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { days = 14 } = c.req.valid('query');
  const scopedSnapshots = backupSnapshots.filter((snapshot) => snapshotOrgById.get(snapshot.id) === orgId);
  const scopedConfigs = backupConfigs.filter((config) => configOrgById.get(config.id) === orgId);

  const configById = new Map(scopedConfigs.map((config) => [config.id, config]));
  const providers = new Set<string>(scopedConfigs.map((config) => config.provider));
  const today = new Date();
  const startDate = new Date(today);
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));

  const dailyIncrements = new Map<string, Map<string, number>>();

  for (const snapshot of scopedSnapshots) {
    const createdAt = new Date(snapshot.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt < startDate) {
      continue;
    }

    const dayKey = createdAt.toISOString().slice(0, 10);
    const provider = configById.get(snapshot.configId)?.provider ?? 'unknown';
    providers.add(provider);

    const dayMap = dailyIncrements.get(dayKey) ?? new Map<string, number>();
    dayMap.set(provider, (dayMap.get(provider) ?? 0) + snapshot.sizeBytes);
    dailyIncrements.set(dayKey, dayMap);
  }

  const providerList = Array.from(providers);
  const runningByProvider = new Map(providerList.map((provider) => [provider, 0]));
  const points: Array<{
    timestamp: string;
    totalBytes: number;
    providers: Array<{ provider: string; bytes: number }>;
  }> = [];

  for (let offset = 0; offset < days; offset += 1) {
    const dayDate = new Date(startDate);
    dayDate.setUTCDate(startDate.getUTCDate() + offset);
    const dayKey = dayDate.toISOString().slice(0, 10);
    const incrementsForDay = dailyIncrements.get(dayKey);

    for (const provider of providerList) {
      const increment = incrementsForDay?.get(provider) ?? 0;
      runningByProvider.set(provider, (runningByProvider.get(provider) ?? 0) + increment);
    }

    const providerSeries = providerList.map((provider) => ({
      provider,
      bytes: runningByProvider.get(provider) ?? 0
    }));
    const totalBytes = providerSeries.reduce((sum, item) => sum + item.bytes, 0);

    points.push({
      timestamp: dayDate.toISOString(),
      totalBytes,
      providers: providerSeries
    });
  }

  return c.json({
    data: {
      days,
      start: startDate.toISOString(),
      end: today.toISOString(),
      providers: providerList,
      points
    }
  });
});

dashboardRoutes.get('/dashboard', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const scopedPolicies = backupPolicies.filter((policy) => policyOrgById.get(policy.id) === orgId);
  const scopedJobs = backupJobs.filter((job) => jobOrgById.get(job.id) === orgId);
  const scopedSnapshots = backupSnapshots.filter((snapshot) => snapshotOrgById.get(snapshot.id) === orgId);
  const scopedConfigs = backupConfigs.filter((config) => configOrgById.get(config.id) === orgId);

  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const protectedDevices = new Set(
    scopedPolicies.flatMap((policy) => policy.targets.deviceIds)
  );
  const recentJobs = [...scopedJobs].sort((a, b) => {
    const aTime = toDateOrNull(a.startedAt ?? a.createdAt) ?? 0;
    const bTime = toDateOrNull(b.startedAt ?? b.createdAt) ?? 0;
    return bTime - aTime;
  });

  const lastDayJobs = scopedJobs.filter((job) => {
    const timestamp = toDateOrNull(job.startedAt ?? job.createdAt) ?? 0;
    return timestamp >= dayAgo;
  });

  const completed = lastDayJobs.filter((job) => job.status === 'completed').length;
  const failed = lastDayJobs.filter((job) => job.status === 'failed').length;
  const running = lastDayJobs.filter((job) => job.status === 'running').length;
  const queued = lastDayJobs.filter((job) => job.status === 'queued').length;
  const totalBytes = scopedSnapshots.reduce((sum, snap) => sum + snap.sizeBytes, 0);

  return c.json({
    data: {
      totals: {
        configs: scopedConfigs.length,
        policies: scopedPolicies.length,
        jobs: scopedJobs.length,
        snapshots: scopedSnapshots.length
      },
      jobsLast24h: {
        completed,
        failed,
        running,
        queued
      },
      storage: {
        totalBytes,
        snapshots: scopedSnapshots.length
      },
      coverage: {
        protectedDevices: protectedDevices.size
      },
      latestJobs: recentJobs.slice(0, 5)
    }
  });
});

dashboardRoutes.get('/status/:deviceId', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.param('deviceId');
  const policy = backupPolicies.find(
    (item) => item.targets.deviceIds.includes(deviceId) && policyOrgById.get(item.id) === orgId
  );
  const jobs = backupJobs
    .filter((job) => jobOrgById.get(job.id) === orgId)
    .filter((job) => job.deviceId === deviceId)
    .sort((a, b) => {
      const aTime = toDateOrNull(a.startedAt ?? a.createdAt) ?? 0;
      const bTime = toDateOrNull(b.startedAt ?? b.createdAt) ?? 0;
      return bTime - aTime;
    });

  const lastJob = jobs[0] ?? null;
  const lastSuccess = jobs.find((job) => job.status === 'completed') ?? null;
  const lastFailure = jobs.find((job) => job.status === 'failed') ?? null;

  return c.json({
    data: {
      deviceId,
      protected: Boolean(policy),
      policyId: policy?.id ?? null,
      lastJob,
      lastSuccessAt: lastSuccess?.completedAt ?? null,
      lastFailureAt: lastFailure?.completedAt ?? null,
      nextScheduledAt: policy ? getNextRun(policy.schedule) : null
    }
  });
});
