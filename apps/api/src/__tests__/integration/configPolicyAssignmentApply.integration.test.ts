/**
 * #12466 (plan W02b G6): the staged Apply and the Site page target listing,
 * through the REAL routes (authMiddleware → requirePermission → requireMfa →
 * handler) on real Postgres, as `breeze_app` under forced RLS, with minted
 * tokens. The mocked route tests prove the branching; this proves the one thing
 * mocks cannot: a 409 inside the request transaction rolls the WHOLE Apply
 * back, because the writes run in a `withDbTransaction` savepoint. Without it,
 * the request transaction would commit the earlier writes with the 409.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/configPolicyAssignmentApply.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { configPolicyRoutes } from '../../routes/configurationPolicies';
import { configPolicyAssignments, configurationPolicies } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { shutdownPeripheralJobs } from '../../jobs/peripheralJobs';
import { closeRedis } from '../../services/redis';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

afterAll(async () => {
  await shutdownPeripheralJobs();
  await closeRedis();
});

function buildApp(): Hono {
  const app = new Hono();
  app.route('/configuration-policies', configPolicyRoutes);
  return app;
}

function call(app: Hono, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function orgToken(partnerId: string, orgId: string) {
  const user = await createUser({ partnerId, orgId, email: `apply-${randomUUID().slice(0, 8)}@example.test` });
  const role = await createRole({ scope: 'organization', orgId, partnerId });
  await grantRolePermissions(role.id, [
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'write' },
  ]);
  await assignUserToOrganization(user.id, orgId, role.id);
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, scope: 'organization',
    orgId, partnerId: null, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function partnerToken(partnerId: string) {
  const user = await createUser({ partnerId, orgId: null, email: `apply-p-${randomUUID().slice(0, 8)}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, [
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'write' },
  ]);
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, scope: 'partner',
    orgId: null, partnerId, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id });
  const siteB = await createSite({ orgId: org.id });
  const siteC = await createSite({ orgId: org.id });
  const token = await orgToken(partner.id, org.id);
  const [policy] = await (getTestDb() as any)
    .insert(configurationPolicies)
    .values({ orgId: org.id, name: `Apply ${randomUUID().slice(0, 8)}`, status: 'active' })
    .returning({ id: configurationPolicies.id });
  return { partner, org, siteA, siteB, siteC, token, policyId: policy.id as string };
}

async function insertRow(policyId: string, level: string, targetId: string, priority = 0) {
  const [row] = await (getTestDb() as any)
    .insert(configPolicyAssignments)
    .values({ configPolicyId: policyId, level, targetId, priority })
    .returning();
  return row as { id: string };
}

async function rowsOf(policyId: string) {
  return (getTestDb() as any)
    .select({
      id: configPolicyAssignments.id,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      priority: configPolicyAssignments.priority,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
    })
    .from(configPolicyAssignments)
    .where(eq(configPolicyAssignments.configPolicyId, policyId))
    .orderBy(asc(configPolicyAssignments.targetId)) as Promise<Array<Record<string, unknown>>>;
}

describe('POST /configuration-policies/:id/assignments/apply on real Postgres (#12466)', () => {
  runDb('a colliding add rolls back the whole Apply', async () => {
    const app = buildApp();
    const { siteA, siteB, siteC, token, policyId } = await seed();
    const existing = await insertRow(policyId, 'site', siteA.id, 3);
    const removable = await insertRow(policyId, 'site', siteC.id);

    // A remove and a fresh add land first in the savepoint; the second add
    // duplicates the stored site A row, so assignPolicy returns null.
    const res = await call(app, token, 'POST', `/configuration-policies/${policyId}/assignments/apply`, {
      remove: [removable.id],
      add: [{ level: 'site', targetId: siteB.id }, { level: 'site', targetId: siteA.id }],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'assignment_conflict', entry: { op: 'add', index: 1 } });
    const rows = await rowsOf(policyId);
    // The first add is absent and the removed row is back: nothing committed.
    expect(rows.map((r) => r.id).sort()).toEqual([existing.id, removable.id].sort());
    expect(rows.find((r) => r.targetId === siteB.id)).toBeUndefined();
  });

  runDb('an Apply leaves a row it was not told about', async () => {
    const app = buildApp();
    const { siteA, siteB, siteC, token, policyId } = await seed();
    const toRemove = await insertRow(policyId, 'site', siteA.id);
    // Added from the Site page after the panel loaded: the request never names it.
    const untouched = await insertRow(policyId, 'site', siteB.id, 7);

    const res = await call(app, token, 'POST', `/configuration-policies/${policyId}/assignments/apply`, {
      remove: [toRemove.id],
      add: [{ level: 'site', targetId: siteC.id, priority: 2 }],
    });

    expect(res.status).toBe(201);
    const rows = await rowsOf(policyId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === untouched.id)).toMatchObject({ targetId: siteB.id, priority: 7 });
    expect(rows.find((r) => r.targetId === siteC.id)).toMatchObject({ priority: 2 });
    expect(rows.find((r) => r.id === toRemove.id)).toBeUndefined();
  });

  runDb('update changes priority and filters in place', async () => {
    const app = buildApp();
    const { siteA, token, policyId } = await seed();
    const row = await insertRow(policyId, 'site', siteA.id);

    const res = await call(app, token, 'POST', `/configuration-policies/${policyId}/assignments/apply`, {
      update: [{ id: row.id, priority: 5, roleFilter: ['server'], osFilter: [] }],
    });

    expect(res.status).toBe(201);
    expect(await rowsOf(policyId)).toEqual([
      { id: row.id, level: 'site', targetId: siteA.id, priority: 5, roleFilter: ['server'], osFilter: null },
    ]);
  });

  runDb('a cross-partner target is refused', async () => {
    const app = buildApp();
    const { siteA, token, policyId } = await seed();
    const kept = await insertRow(policyId, 'site', siteA.id);
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const foreignSite = await createSite({ orgId: otherOrg.id });

    const res = await call(app, token, 'POST', `/configuration-policies/${policyId}/assignments/apply`, {
      remove: [kept.id],
      add: [{ level: 'site', targetId: foreignSite.id }],
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ entry: { op: 'add', index: 0 } });
    // The checks run before any write: the remove did not happen either.
    expect((await rowsOf(policyId)).map((r) => r.id)).toEqual([kept.id]);
  });

  runDb('dry run leaves the table unchanged', async () => {
    const app = buildApp();
    const { org, siteA, siteB, token, policyId } = await seed();
    await createDevice({ orgId: org.id, siteId: siteA.id });
    await createDevice({ orgId: org.id, siteId: siteB.id });
    await createDevice({ orgId: org.id, siteId: siteB.id });
    const row = await insertRow(policyId, 'site', siteA.id);
    const before = await rowsOf(policyId);

    const res = await call(app, token, 'POST', `/configuration-policies/${policyId}/assignments/apply`, {
      remove: [row.id],
      add: [{ level: 'site', targetId: siteB.id }],
      dryRun: true,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: true, delta: { added: 2, removed: 1 } });
    expect(await rowsOf(policyId)).toEqual(before);
  });
});

describe('GET /configuration-policies/assignments/target lists MSP-managed policies (#12466)', () => {
  runDb('a partner-scope caller sees its own MSP-managed policy on a site; an org-scope caller does not', async () => {
    const app = buildApp();
    const { partner, siteA, token: orgScopeToken, policyId: orgPolicyId } = await seed();
    const [mspPolicy] = await (getTestDb() as any)
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: partner.id, name: `MSP ${randomUUID().slice(0, 8)}`, status: 'active' })
      .returning({ id: configurationPolicies.id });
    await insertRow(mspPolicy.id, 'site', siteA.id);
    await insertRow(orgPolicyId, 'site', siteA.id);

    const asPartner = await call(app, await partnerToken(partner.id), 'GET',
      `/configuration-policies/assignments/target?level=site&targetId=${siteA.id}`);
    expect(asPartner.status).toBe(200);
    const partnerIds = (await asPartner.json()).data.map((r: { assignment: { configPolicyId: string } }) => r.assignment.configPolicyId);
    expect(partnerIds.sort()).toEqual([mspPolicy.id, orgPolicyId].sort());

    const asOrg = await call(app, orgScopeToken, 'GET',
      `/configuration-policies/assignments/target?level=site&targetId=${siteA.id}`);
    expect(asOrg.status).toBe(200);
    const orgIds = (await asOrg.json()).data.map((r: { assignment: { configPolicyId: string } }) => r.assignment.configPolicyId);
    expect(orgIds).toEqual([orgPolicyId]);
  });
});
