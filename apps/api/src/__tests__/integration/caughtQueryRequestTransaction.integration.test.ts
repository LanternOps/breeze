/**
 * #11203: a statement that fails inside the request transaction is rethrown by
 * postgres.js when that transaction ends, even when the caller caught it. A
 * route that catches such a failure answers its degraded 200 or its mapped 4xx,
 * and then the commit turns that answer into a 500. Mocked-Drizzle unit tests
 * cannot see this, so these run through the real router and real Postgres as
 * `breeze_app`.
 *
 * The forced failures are real statement errors (division by zero), issued
 * through the ambient `db`, in the place the optional read would run.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const failures = vi.hoisted(() => ({ attention: false, assigned: false, providerAttention: false }));

vi.mock('../../services/backupJobOrdering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/backupJobOrdering')>();
  return {
    ...actual,
    // Read per query: `1/0` as a window ordering fails the attention query at
    // plan time. The read model shares this ordering, but only reads it for
    // assigned devices, and these fixtures have none, so the attention query
    // is the only statement this breaks.
    get latestBackupRunWindowOrder() {
      return failures.attention ? sql`1/0` : actual.latestBackupRunWindowOrder;
    },
  };
});

vi.mock('../../services/featureConfigResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/featureConfigResolver')>();
  return {
    ...actual,
    resolveAllBackupAssignedDevices: async (orgId: string) => {
      if (failures.assigned) {
        const { db } = await import('../../db');
        await db.execute(sql`SELECT 1/0`);
      }
      return actual.resolveAllBackupAssignedDevices(orgId);
    },
  };
});

vi.mock('../../services/backupHealthReadModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/backupHealthReadModel')>();
  return {
    ...actual,
    getProviderAttentionItems: async (...args: Parameters<typeof actual.getProviderAttentionItems>) => {
      if (failures.providerAttention) {
        const { db } = await import('../../db');
        await db.execute(sql`SELECT 1/0`);
      }
      return actual.getProviderAttentionItems(...args);
    },
  };
});

import { aiAgents, aiAgentSchedules, backupConfigs, backupJobs, devices } from '../../db/schema';
import { aiAgentSchedulesRoutes } from '../../routes/aiAgentSchedules';
import { backupRoutes } from '../../routes/backup';
import { createAccessToken } from '../../services/jwt';
import { PERMISSIONS } from '../../services/permissions';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function dashboardFixture() {
  const env = await setupTestEnvironment({
    scope: 'organization',
    rolePermissions: [{ resource: PERMISSIONS.ORGS_READ.resource, action: PERMISSIONS.ORGS_READ.action }],
  });
  const [device] = await getTestDb().insert(devices).values({
    orgId: env.organization.id,
    siteId: env.site.id,
    agentId: `caught-query-${randomUUID()}`,
    hostname: 'caught-query-device',
    osType: 'linux',
    osVersion: 'test',
    architecture: 'x86_64',
    agentVersion: 'test',
    status: 'online',
    enrolledAt: new Date(),
  }).returning();
  const [config] = await getTestDb().insert(backupConfigs).values({
    orgId: env.organization.id,
    name: `Local ${randomUUID()}`,
    type: 'file',
    provider: 'local',
    providerConfig: { path: '/backups' },
  }).returning({ id: backupConfigs.id });
  await getTestDb().insert(backupJobs).values({
    orgId: env.organization.id,
    configId: config!.id,
    deviceId: device!.id,
    type: 'scheduled',
    status: 'failed',
    errorLog: 'disk gone',
    completedAt: new Date(),
  });
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/backup', backupRoutes);
  const get = () => app.request('/backup/dashboard', { headers: { Authorization: `Bearer ${token}` } });
  return { get };
}

describe('backup dashboard degraded paths inside the request transaction (real PostgreSQL)', () => {
  beforeEach(() => {
    failures.attention = false;
    failures.assigned = false;
    failures.providerAttention = false;
  });

  runDb('CONTROL: with nothing failing, the attention item is listed and no degraded flag is set', async () => {
    const { get } = await dashboardFixture();
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.attentionError).toBe(false);
    expect(data.attentionItems).toHaveLength(1);
    expect(data.totals.jobs).toBe(1);
  });

  runDb('a failed attention query answers the degraded 200, not a 500, and keeps every other figure', async () => {
    const { get } = await dashboardFixture();
    failures.attention = true;
    const res = await get();
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = await res.json();
    expect(data.attentionError).toBe(true);
    expect(data.attentionItems).toEqual([]);
    expect(data.totals.jobs).toBe(1);
    expect(data.latestJobs).toHaveLength(1);
  });

  runDb('a failed assigned-devices read answers 200 with no assigned devices, not a 500', async () => {
    const { get } = await dashboardFixture();
    failures.assigned = true;
    const res = await get();
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = await res.json();
    expect(data.totals.policies).toBe(0);
    expect(data.totals.jobs).toBe(1);
    // No assigned devices means no overdue list, so the panel has to say it
    // could not vouch for that, or it reads as an all-clear.
    expect(data.attentionError).toBe(true);
    // The first-party attention list is unrelated to assignment and still loads.
    expect(data.attentionItems).toHaveLength(1);
  });

  runDb('a failed provider read answers the degraded 200, not a 500, and keeps the first-party attention items', async () => {
    const { get } = await dashboardFixture();
    failures.providerAttention = true;
    const res = await get();
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = await res.json();
    expect(data.attentionError).toBe(true);
    expect(data.overdueDevices).toEqual([]);
    expect(data.attentionItems).toHaveLength(1);
    expect(data.totals.jobs).toBe(1);
  });

  runDb('both optional reads failing together still answer the degraded 200', async () => {
    const { get } = await dashboardFixture();
    failures.assigned = true;
    failures.providerAttention = true;
    const res = await get();
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = await res.json();
    expect(data.attentionError).toBe(true);
    expect(data.totals.jobs).toBe(1);
  });
});

describe('POST /ai/agents/schedules duplicate override (real PostgreSQL)', () => {
  runDb('a second override of one baseline answers 409 override_exists, not a 500, and writes no row', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'ai_agents', action: 'write' }, { resource: 'ai_agents', action: 'read' }],
    });
    const [agent] = await getTestDb().insert(aiAgents).values({
      partnerId: env.partner.id, orgId: null, kind: 'triage', name: `Sweep ${randomUUID()}`, enabled: true, createdBy: env.user.id, limits: {},
    } as never).returning();
    const [baseline] = await getTestDb().insert(aiAgentSchedules).values({
      partnerId: env.partner.id, orgId: null, agentId: agent!.id, baselineScheduleId: null, kind: 'sweep', cron: '0 6 * * *', timezone: 'UTC', sweepKinds: ['disk_pressure'], enabled: true, updatedAt: new Date(),
    } as never).returning();
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id,
      scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono();
    app.route('/schedules', aiAgentSchedulesRoutes);
    const post = () => app.request('/schedules', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'organization', orgId: env.organization.id, baselineScheduleId: baseline!.id, enabled: true, sweepKinds: ['disk_pressure'] }),
    });

    const first = await post();
    expect(first.status, await first.clone().text()).toBe(201);

    const second = await post();
    expect(second.status, await second.clone().text()).toBe(409);
    expect(await second.json()).toEqual({ error: 'override_exists' });

    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.orgId, env.organization.id))).resolves.toHaveLength(1);
  });
});
