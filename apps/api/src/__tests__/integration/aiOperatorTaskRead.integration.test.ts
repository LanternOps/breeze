import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents, aiOperatorTasks, devices, organizationUsers } from '../../db/schema';
import { aiOperatorTasksRoutes } from '../../routes/aiOperatorTasks';
import { clearPermissionCache } from '../../services/permissions';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * Real-Postgres proof for W07 (#5205, #5212) of two contracts a mocked
 * Drizzle client cannot evaluate:
 *  1. Cross-org task reads 404 as `breeze_app` — the RLS policy on
 *     `ai_operator_tasks` (2026-10-14-100000-ai-operator-thin-slice.sql) is
 *     the real boundary; the route's `auth.orgCondition` predicate is
 *     defence-in-depth.
 *  2. Site restriction is genuinely NEW app-layer behaviour (baseline §9.5 —
 *     `GET /ai/agents/runs` has no site gate at all): a task whose device
 *     sits outside the caller's `allowedSiteIds` must 404 on detail and be
 *     omitted from the list, same posture as
 *     `policyComplianceSiteScope.integration.test.ts`'s "site axis is
 *     app-layer only" proof for automation-policy compliance.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/ai/operator', aiOperatorTasksRoutes);
  return app;
}

async function get(env: TestEnvironment, path: string) {
  const response = await buildApp().request(`/api/v1/ai/operator${path}`, {
    headers: { Authorization: `Bearer ${env.token}` },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body: body as any };
}

async function restrictUserToSites(env: TestEnvironment, siteIds: string[]) {
  await withSystemDbAccessContext(async () => {
    await db
      .update(organizationUsers)
      .set({ siteIds })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
  });
  await clearPermissionCache(env.user.id);
}

async function insertAgent(orgId: string, createdBy: string): Promise<string> {
  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiAgents).values({ orgId, partnerId: null, kind: 'triage', name: 'Triage', createdBy }).returning(),
  );
  return agent!.id;
}

async function insertDevice(orgId: string, siteId: string): Promise<string> {
  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `operator-read-agent-${unique}`,
      hostname: `operator-read-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning();
  return (device as { id: string }).id;
}

async function insertTask(
  orgId: string,
  agentId: string,
  userId: string,
  overrides: Partial<typeof aiOperatorTasks.$inferInsert> = {},
): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(aiOperatorTasks)
      .values({
        orgId,
        agentId,
        agentKind: 'triage',
        agentName: 'Triage',
        workflowKey: 'service_recovery',
        workflowVersion: 1,
        originKind: 'manual' as const,
        requesterUserId: userId,
        objective: 'Restart the print spooler',
        ...overrides,
      })
      .returning({ id: aiOperatorTasks.id }),
  );
  return row!.id;
}

describe('AI Operator task read routes (W07, #5205/#5212) — real Postgres', () => {
  describe('cross-org isolation (RLS as breeze_app)', () => {
    runDb('GET /tasks/:id 404s non-enumerating for another org\'s task', async () => {
      const envA = await setupTestEnvironment({ scope: 'organization' });
      const envB = await setupTestEnvironment({ scope: 'organization' });
      const agentB = await insertAgent(envB.organization.id, envB.user.id);
      const taskB = await insertTask(envB.organization.id, agentB, envB.user.id);

      const res = await get(envA, `/tasks/${taskB}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Task not found');
    });

    runDb('GET /tasks list never includes another org\'s task', async () => {
      const envA = await setupTestEnvironment({ scope: 'organization' });
      const envB = await setupTestEnvironment({ scope: 'organization' });
      const agentB = await insertAgent(envB.organization.id, envB.user.id);
      await insertTask(envB.organization.id, agentB, envB.user.id);

      const res = await get(envA, '/tasks');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    runDb('GET /tasks/:id returns 200 with the safe DTO for the caller\'s own org', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const agentId = await insertAgent(env.organization.id, env.user.id);
      const taskId = await insertTask(env.organization.id, agentId, env.user.id);

      const res = await get(env, `/tasks/${taskId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(taskId);
      expect(res.body.data.orgId).toBe(env.organization.id);
      expect(res.body.data.agent).toEqual({ id: agentId, kind: 'triage', name: 'Triage' });
      expect(res.body.data.operations).toEqual([]);
      expect(res.body.data.runs).toEqual([]);
      // Never present regardless of column additions: proof the route only
      // ever selects the named TASK_ROW_COLUMNS.
      expect(res.body.data).not.toHaveProperty('checkpoint');
      expect(res.body.data).not.toHaveProperty('frozenScope');
    });
  });

  describe('site visibility (app-layer only, new behaviour per baseline §9.5)', () => {
    runDb('a site-restricted user cannot see a task whose device sits outside their sites — detail 404s', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const inSite = env.site;
      const outSite = await createSite({ orgId: env.organization.id, name: 'Out-of-scope site' });
      await restrictUserToSites(env, [inSite.id]);

      const agentId = await insertAgent(env.organization.id, env.user.id);
      const outDeviceId = await insertDevice(env.organization.id, outSite.id);
      const outTaskId = await insertTask(env.organization.id, agentId, env.user.id, {
        deviceId: outDeviceId,
        targetLabel: 'OUT-OF-SCOPE-HOST',
      });

      const res = await get(env, `/tasks/${outTaskId}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Task not found');
    });

    runDb('a site-restricted user\'s list omits a task whose device sits outside their sites', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const inSite = env.site;
      const outSite = await createSite({ orgId: env.organization.id, name: 'Out-of-scope site' });
      await restrictUserToSites(env, [inSite.id]);

      const agentId = await insertAgent(env.organization.id, env.user.id);
      const inDeviceId = await insertDevice(env.organization.id, inSite.id);
      const outDeviceId = await insertDevice(env.organization.id, outSite.id);
      const inTaskId = await insertTask(env.organization.id, agentId, env.user.id, {
        deviceId: inDeviceId,
        targetLabel: 'IN-SCOPE-HOST',
      });
      const outTaskId = await insertTask(env.organization.id, agentId, env.user.id, {
        deviceId: outDeviceId,
        targetLabel: 'OUT-OF-SCOPE-HOST',
      });

      const res = await get(env, '/tasks');
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(inTaskId);
      expect(ids).not.toContain(outTaskId);
      expect(res.body.data).toHaveLength(1);
    });

    runDb('a site-restricted user still sees a task with NO device target (nothing to site-gate)', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      await restrictUserToSites(env, [env.site.id]);

      const agentId = await insertAgent(env.organization.id, env.user.id);
      const deviceless = await insertTask(env.organization.id, agentId, env.user.id);

      const detail = await get(env, `/tasks/${deviceless}`);
      expect(detail.status).toBe(200);

      const list = await get(env, '/tasks');
      expect(list.status).toBe(200);
      const ids = (list.body.data as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(deviceless);
    });

    runDb('an org-scoped caller with no site restriction (siteIds unset) sees a task regardless of device site', async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const agentId = await insertAgent(env.organization.id, env.user.id);
      const otherSite = await createSite({ orgId: env.organization.id, name: 'Another site, still unrestricted' });
      const deviceId = await insertDevice(env.organization.id, otherSite.id);
      const taskId = await insertTask(env.organization.id, agentId, env.user.id, { deviceId });

      const res = await get(env, `/tasks/${taskId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(taskId);
    });
  });
});
