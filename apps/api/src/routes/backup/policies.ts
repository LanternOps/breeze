import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'crypto';
import { writeRouteAudit } from '../../services/auditEvents';
import type { BackupPolicy } from './types';
import { resolveScopedOrgId } from './helpers';
import { backupConfigs, backupPolicies, configOrgById, policyOrgById } from './store';
import { policySchema, policyUpdateSchema } from './schemas';

export const policiesRoutes = new Hono();

policiesRoutes.get('/policies', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  return c.json({ data: backupPolicies.filter((policy) => policyOrgById.get(policy.id) === orgId) });
});

policiesRoutes.post('/policies', zValidator('json', policySchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const payload = c.req.valid('json');
  const config = backupConfigs.find(
    (item) => item.id === payload.configId && configOrgById.get(item.id) === orgId
  );
  if (!config) {
    return c.json({ error: 'Config not found' }, 400);
  }

  const now = new Date().toISOString();
  const policy: BackupPolicy = {
    id: randomUUID(),
    name: payload.name,
    configId: payload.configId,
    enabled: payload.enabled ?? true,
    targets: {
      deviceIds: payload.targets?.deviceIds ?? [],
      siteIds: payload.targets?.siteIds ?? [],
      groupIds: payload.targets?.groupIds ?? []
    },
    schedule: {
      frequency: payload.schedule.frequency,
      time: payload.schedule.time,
      timezone: payload.schedule.timezone ?? 'UTC',
      dayOfWeek: payload.schedule.dayOfWeek,
      dayOfMonth: payload.schedule.dayOfMonth
    },
    retention: {
      keepDaily: payload.retention?.keepDaily ?? 7,
      keepWeekly: payload.retention?.keepWeekly ?? 4,
      keepMonthly: payload.retention?.keepMonthly ?? 3
    },
    createdAt: now,
    updatedAt: now
  };

  backupPolicies.push(policy);
  policyOrgById.set(policy.id, orgId);
  writeRouteAudit(c, {
    orgId,
    action: 'backup.policy.create',
    resourceType: 'backup_policy',
    resourceId: policy.id,
    resourceName: policy.name
  });
  return c.json(policy, 201);
});

policiesRoutes.patch('/policies/:id', zValidator('json', policyUpdateSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const policyId = c.req.param('id');
  if (policyOrgById.get(policyId) !== orgId) {
    return c.json({ error: 'Policy not found' }, 404);
  }
  const policy = backupPolicies.find((item) => item.id === policyId);
  if (!policy) {
    return c.json({ error: 'Policy not found' }, 404);
  }

  const payload = c.req.valid('json');
  if (payload.name !== undefined) policy.name = payload.name;
  if (payload.enabled !== undefined) policy.enabled = payload.enabled;
  if (payload.configId !== undefined) {
    const configExists = backupConfigs.some(
      (item) => item.id === payload.configId && configOrgById.get(item.id) === orgId
    );
    if (!configExists) {
      return c.json({ error: 'Config not found' }, 400);
    }
    policy.configId = payload.configId;
  }
  if (payload.targets !== undefined) {
    policy.targets = {
      deviceIds: payload.targets.deviceIds ?? policy.targets.deviceIds,
      siteIds: payload.targets.siteIds ?? policy.targets.siteIds,
      groupIds: payload.targets.groupIds ?? policy.targets.groupIds
    };
  }
  if (payload.schedule !== undefined) {
    policy.schedule = {
      frequency: payload.schedule.frequency ?? policy.schedule.frequency,
      time: payload.schedule.time ?? policy.schedule.time,
      timezone: payload.schedule.timezone ?? policy.schedule.timezone,
      dayOfWeek: payload.schedule.dayOfWeek ?? policy.schedule.dayOfWeek,
      dayOfMonth: payload.schedule.dayOfMonth ?? policy.schedule.dayOfMonth
    };
  }
  if (payload.retention !== undefined) {
    policy.retention = {
      keepDaily: payload.retention.keepDaily ?? policy.retention.keepDaily,
      keepWeekly: payload.retention.keepWeekly ?? policy.retention.keepWeekly,
      keepMonthly: payload.retention.keepMonthly ?? policy.retention.keepMonthly
    };
  }
  policy.updatedAt = new Date().toISOString();

  writeRouteAudit(c, {
    orgId,
    action: 'backup.policy.update',
    resourceType: 'backup_policy',
    resourceId: policy.id,
    resourceName: policy.name,
    details: { changedFields: Object.keys(payload) }
  });

  return c.json(policy);
});

policiesRoutes.delete('/policies/:id', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const policyId = c.req.param('id');
  if (policyOrgById.get(policyId) !== orgId) {
    return c.json({ error: 'Policy not found' }, 404);
  }
  const index = backupPolicies.findIndex((item) => item.id === policyId);
  if (index === -1) {
    return c.json({ error: 'Policy not found' }, 404);
  }
  const [deleted] = backupPolicies.splice(index, 1);
  if (deleted) {
    policyOrgById.delete(deleted.id);
  }
  writeRouteAudit(c, {
    orgId,
    action: 'backup.policy.delete',
    resourceType: 'backup_policy',
    resourceId: deleted?.id,
    resourceName: deleted?.name
  });
  return c.json({ deleted: true });
});
