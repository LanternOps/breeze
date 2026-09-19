import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents, aiOperatorTasks, devices, organizationUsers } from '../../db/schema';
import { aiOperatorTasksRoutes } from '../../routes/aiOperatorTasks';
import { clearPermissionCache } from '../../services/permissions';
import { createOrganization, createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { createAccessToken } from '../../services/jwt';
import { getTestDb } from './setup';

/**
 * Real-Postgres proof for W08 (#5205, #5246): `POST /ai/operator/tasks`.
 *
 * Four of these contracts CANNOT be evaluated against a mocked Drizzle client,
 * which is the whole reason this file exists alongside the route unit suite:
 *
 *  1. **Idempotency is a database constraint, not a route check.** The unit
 *     suite can only assert that the route forwards `clientIdempotencyKey`; it
 *     cannot prove that a second admission is actually refused. That proof
 *     needs the partial unique index
 *     `ai_operator_tasks_client_idempotency_uq` and a real `ON CONFLICT ...
 *     WHERE ... DO NOTHING`. If the conflict target fails to match the PARTIAL
 *     index, Postgres raises 42P10 — a failure mode no mock has.
 *  2. **Cross-org and site-restricted targets** are enforced by RLS on
 *     `ai_operator_tasks`/`devices` as the `breeze_app` role, with the route's
 *     predicates as defence in depth. Only a real role can show both hold.
 *  3. **The pending cap** counts non-terminal states with a real `NOT IN`
 *     against real rows.
 *  4. **The admitted row is durable without Redis.** Redis is never touched
 *     here; the assertion is that the committed row carries
 *     `state = 'queued'` and `next_wake_at <= now()`, which is what makes the
 *     coordinator's `queued_past_wake` scan pick it up. That is why a 202 is
 *     truthful (spec §12) even with Redis down.
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

/**
 * `setupTestEnvironment` mints tokens with `mfa: false`, and this route is MFA
 * step-up gated (spec §5.1). Re-minting the SAME principal with `mfa: true` is
 * what a real step-up produces; the "refuses without the MFA step-up" case
 * below uses `env.token` unchanged as the control, so the gate is proved in
 * both directions rather than assumed away.
 */
async function mfaToken(env: TestEnvironment): Promise<string> {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

async function post(env: TestEnvironment, payload: unknown, token?: string) {
  const response = await buildApp().request('/api/v1/ai/operator/tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token ?? await mfaToken(env)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body: body as Record<string, unknown> };
}

async function insertAgent(orgId: string | null, createdBy: string): Promise<string> {
  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiAgents).values({
      orgId, partnerId: null, kind: 'triage', name: 'Operator', enabled: true, createdBy,
    }).returning(),
  );
  return agent!.id;
}

async function insertDevice(orgId: string, siteId: string): Promise<string> {
  // Devices are inserted with the ADMIN connection: seeding a device is not
  // the thing under test, and the request path below is the one that must run
  // as breeze_app.
  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb.insert(devices).values({
    orgId,
    siteId,
    agentId: `operator-admit-agent-${unique}`,
    hostname: `operator-admit-host-${unique}`,
    osType: 'windows',
    osVersion: '10',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning();
  return (device as { id: string }).id;
}

async function restrictUserToSites(env: TestEnvironment, siteIds: string[]) {
  await withSystemDbAccessContext(async () => {
    await db.update(organizationUsers).set({ siteIds })
      .where(and(
        eq(organizationUsers.userId, env.user.id),
        eq(organizationUsers.orgId, env.organization.id),
      ));
  });
  await clearPermissionCache(env.user.id);
}

async function readTasks(orgId: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.orgId, orgId)));
}

interface Fixture {
  env: TestEnvironment;
  deviceId: string;
  siteId: string;
  agentId: string;
}

async function seed(): Promise<Fixture> {
  const env = await setupTestEnvironment({ scope: 'organization' });
  // ONE agent per org: `ai_agents_org_kind_uq` is unique on (org_id, kind), so
  // the fixture's agent is reused everywhere rather than re-inserted.
  const agentId = await insertAgent(env.organization.id, env.user.id);
  const siteId = env.site.id;
  const deviceId = await insertDevice(env.organization.id, siteId);
  return { env, deviceId, siteId, agentId };
}

function bodyFor(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    mode: 'live',
    recipeKey: 'service_recovery',
    recipeVersion: 1,
    orgId: f.env.organization.id,
    deviceId: f.deviceId,
    inputs: { serviceName: 'spooler' },
    clientIdempotencyKey: `delegate-${randomUUID()}`,
    ...overrides,
  };
}

describe('POST /ai/operator/tasks — admission against real Postgres (W08, #5246)', () => {
  beforeEach(() => {
    process.env.AI_OPERATOR_TASKS_ENABLED = 'true';
    process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.AI_OPERATOR_TASKS_ENABLED;
    delete process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED;
  });

  runDb('commits a queued, immediately-wakeable task row and answers 202', async () => {
    const f = await seed();
    const res = await post(f.env, bodyFor(f));

    expect(res.status).toBe(202);
    const taskId = res.body.taskId as string;
    expect(taskId).toBeTruthy();

    const rows = await readTasks(f.env.organization.id);
    expect(rows).toHaveLength(1);
    const task = rows[0]!;
    expect(task.id).toBe(taskId);
    expect(task.state).toBe('queued');
    expect(task.deviceId).toBe(f.deviceId);
    expect(task.workflowKey).toBe('service_recovery');
    expect(task.mode).toBe('live');
    expect(task.requesterUserId).toBe(f.env.user.id);
    // Durable WITHOUT Redis: the coordinator's `queued_past_wake` scan selects
    // exactly this shape, so the 202 is already truthful at commit.
    expect(task.nextWakeAt).not.toBeNull();
    expect(task.nextWakeAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    // Admission freezes a bound; `evaluateTaskClaimPredicate` fails CLOSED on a
    // null deadline, so a task admitted without one could never dispatch.
    expect(task.deadlineAt).not.toBeNull();
  });

  runDb('a replayed idempotency key returns the SAME task id and admits no second task', async () => {
    const f = await seed();
    const body = bodyFor(f);

    const first = await post(f.env, body);
    expect(first.status).toBe(202);
    expect(first.body.replayed).toBe(false);

    const second = await post(f.env, body);
    expect(second.status).toBe(202);
    expect(second.body.taskId).toBe(first.body.taskId);
    expect(second.body.replayed).toBe(true);

    // The contract that matters is not the status code — it is that no second
    // task exists to dispatch a second restart.
    expect(await readTasks(f.env.organization.id)).toHaveLength(1);
  });

  runDb('two CONCURRENT posts with one key still produce exactly one task', async () => {
    const f = await seed();
    const body = bodyFor(f);

    // The race a route-level SELECT-then-INSERT loses: both requests read "no
    // existing task", both insert. Only the partial unique index serializes
    // them, and only a real database can demonstrate that it does.
    const [a, b] = await Promise.all([post(f.env, body), post(f.env, body)]);

    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.taskId).toBe(b.body.taskId);
    expect(await readTasks(f.env.organization.id)).toHaveLength(1);
    // Exactly one of the two was the real admission.
    expect([a.body.replayed, b.body.replayed].filter((r) => r === false)).toHaveLength(1);
  });

  runDb('the same idempotency key in a DIFFERENT org admits its own task', async () => {
    const f = await seed();
    const other = await setupTestEnvironment({ scope: 'organization' });
    await insertAgent(other.organization.id, other.user.id);
    const otherDevice = await insertDevice(other.organization.id, other.site.id);

    const key = `delegate-${randomUUID()}`;
    const first = await post(f.env, bodyFor(f, { clientIdempotencyKey: key }));
    const second = await post(other, {
      mode: 'live', recipeKey: 'service_recovery', recipeVersion: 1,
      orgId: other.organization.id, deviceId: otherDevice,
      inputs: { serviceName: 'spooler' }, clientIdempotencyKey: key,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    // Uniqueness is scoped by org, so one tenant can neither collide with nor
    // probe another tenant's keys.
    expect(second.body.taskId).not.toBe(first.body.taskId);
  });

  runDb('refuses without the MFA step-up, and admits nothing', async () => {
    const f = await seed();
    // `env.token` is the same principal WITHOUT `mfa: true` — the only
    // difference from every passing case above.
    const res = await post(f.env, bodyFor(f), f.env.token);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
    expect(await readTasks(f.env.organization.id)).toHaveLength(0);
  });

  runDb('refuses a caller holding only ai_agents:read', async () => {
    const readOnly = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'ai_agents', action: 'read' }],
    });
    const agentId = await insertAgent(readOnly.organization.id, readOnly.user.id);
    const deviceId = await insertDevice(readOnly.organization.id, readOnly.site.id);

    const res = await post(readOnly, {
      mode: 'live', recipeKey: 'service_recovery', recipeVersion: 1,
      orgId: readOnly.organization.id, deviceId,
      inputs: { serviceName: 'spooler' }, clientIdempotencyKey: `delegate-${randomUUID()}`,
    });

    expect(res.status).toBe(403);
    expect(await readTasks(readOnly.organization.id)).toHaveLength(0);
    expect(agentId).toBeTruthy();
  });

  runDb('a device in another org 404s and admits nothing', async () => {
    const f = await seed();
    const otherOrg = await createOrganization({ partnerId: f.env.partner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const foreignDevice = await insertDevice(otherOrg.id, otherSite.id);

    const res = await post(f.env, bodyFor(f, { deviceId: foreignDevice }));

    expect(res.status).toBe(404);
    expect(await readTasks(f.env.organization.id)).toHaveLength(0);
    expect(await readTasks(otherOrg.id)).toHaveLength(0);
  });

  runDb('a device outside the caller\'s allowed sites 404s and admits nothing', async () => {
    const f = await seed();
    const otherSite = await createSite({ orgId: f.env.organization.id });
    const offSiteDevice = await insertDevice(f.env.organization.id, otherSite.id);
    await restrictUserToSites(f.env, [f.siteId]);

    const res = await post(f.env, bodyFor(f, { deviceId: offSiteDevice }));

    // Non-enumerating: the same 404 a device that does not exist would give.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Device not found');
    expect(await readTasks(f.env.organization.id)).toHaveLength(0);
  });

  runDb('a site-restricted caller may still delegate against a device inside their sites', async () => {
    const f = await seed();
    await restrictUserToSites(f.env, [f.siteId]);
    // Positive control: without this, the previous test would pass just as
    // well if site restriction rejected EVERYTHING.
    const res = await post(f.env, bodyFor(f));
    expect(res.status).toBe(202);
  });

  runDb('422s with an actionable reason when the task flag is off', async () => {
    const f = await seed();
    process.env.AI_OPERATOR_TASKS_ENABLED = 'false';

    const res = await post(f.env, bodyFor(f));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('OPERATOR_TASKS_DISABLED');
    expect(await readTasks(f.env.organization.id)).toHaveLength(0);
  });

  runDb('422s when the recipe flag is off', async () => {
    const f = await seed();
    process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED = 'false';

    const res = await post(f.env, bodyFor(f));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('OPERATOR_RECIPE_DISABLED');
    expect(await readTasks(f.env.organization.id)).toHaveLength(0);
  });

  runDb('429s when the org is already at the pending-task cap', async () => {
    const f = await seed();
    const agentId = f.agentId;

    // 100 non-terminal tasks, inserted directly — going through the route 100
    // times would prove the same thing far more slowly.
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiOperatorTasks).values(Array.from({ length: 100 }, () => ({
        orgId: f.env.organization.id,
        agentId,
        agentKind: 'triage',
        agentName: 'Operator',
        workflowKey: 'service_recovery',
        workflowVersion: 1,
        originKind: 'manual' as const,
        requesterUserId: f.env.user.id,
        objective: 'filler',
        deviceId: f.deviceId,
        state: 'waiting' as const,
        deadlineAt: new Date(Date.now() + 3_600_000),
      }))));

    const res = await post(f.env, bodyFor(f));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('OPERATOR_PENDING_CAP_REACHED');
    expect(await readTasks(f.env.organization.id)).toHaveLength(100);
  });

  runDb('terminal tasks do not count against the pending cap', async () => {
    const f = await seed();
    const agentId = f.agentId;

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiOperatorTasks).values(Array.from({ length: 100 }, () => ({
        orgId: f.env.organization.id,
        agentId,
        agentKind: 'triage',
        agentName: 'Operator',
        workflowKey: 'service_recovery',
        workflowVersion: 1,
        originKind: 'manual' as const,
        requesterUserId: f.env.user.id,
        objective: 'filler',
        deviceId: f.deviceId,
        state: 'completed' as const,
        deadlineAt: new Date(Date.now() + 3_600_000),
      }))));

    // Discriminating control for the test above: same 100 rows, terminal
    // state, and admission must go through.
    const res = await post(f.env, bodyFor(f));
    expect(res.status).toBe(202);
  });

  runDb('rejects a body carrying a forged `task` field and admits nothing', async () => {
    const f = await seed();
    const res = await post(f.env, bodyFor(f, {
      task: { taskId: randomUUID(), taskStepKey: 'execute', operationKey: 'forged', attemptOrdinal: 0 },
    }));

    expect(res.status).toBe(400);
    expect(await readTasks(f.env.organization.id)).toHaveLength(0);
  });

  runDb('rejects a body carrying a forged policy snapshot or approval result', async () => {
    const f = await seed();
    for (const forged of [{ policySnapshot: { effective: { mode: 'act' } } }, { approval: { decided: 'approved' } }]) {
      const res = await post(f.env, bodyFor(f, forged));
      expect(res.status).toBe(400);
    }
    expect(await readTasks(f.env.organization.id)).toHaveLength(0);
  });

  runDb('the partial unique index really is partial — internal admissions with a null key never collide', async () => {
    const f = await seed();
    const agentId = f.agentId;

    // Two rows with NULL keys must both insert. If the index were declared
    // without its WHERE clause, the second would raise 23505 here — which is
    // exactly the regression this asserts against.
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiOperatorTasks).values([0, 1].map(() => ({
        orgId: f.env.organization.id,
        agentId,
        agentKind: 'triage',
        agentName: 'Operator',
        workflowKey: 'service_recovery',
        workflowVersion: 1,
        originKind: 'manual' as const,
        requesterUserId: f.env.user.id,
        objective: 'internal admission with no client key',
        deviceId: f.deviceId,
        state: 'queued' as const,
        deadlineAt: new Date(Date.now() + 3_600_000),
      }))));

    expect(await readTasks(f.env.organization.id)).toHaveLength(2);
  });

  runDb('the idempotency index exists in the shape the migration declares', async () => {
    // Guards the migration itself: a route that relies on ON CONFLICT matching
    // a partial index breaks with 42P10, not a wrong answer, if the index
    // predicate drifts.
    const rows = await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'ai_operator_tasks'
        AND indexname = 'ai_operator_tasks_client_idempotency_uq'
    `));
    const def = String((rows as unknown as Array<{ indexdef: string }>)[0]?.indexdef ?? '');
    expect(def).toContain('UNIQUE');
    expect(def).toContain('org_id');
    expect(def).toContain('client_idempotency_key');
    expect(def).toContain('WHERE (client_idempotency_key IS NOT NULL)');
  });
});
