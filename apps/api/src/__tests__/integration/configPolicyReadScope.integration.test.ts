/**
 * #12462 W03a (plan S5): which MSP-managed configuration policies a caller may
 * list, open or name, through the REAL routes (authMiddleware → requireScope →
 * requirePermission → handler) on real Postgres, as `breeze_app` under forced
 * RLS, with minted tokens. The AI read tools and the id-level filter run
 * inside contexts built by the real `buildDbAccessContext`.
 *
 * Callers: an org-scope user of organization A (its session carries its
 * partner, as `bindOrganizationSessionPartner` mints it), a partner user with
 * selected access to A only, a partner user with full access, and system.
 *
 * Policies, all MSP-managed (partner-owned) unless noted:
 *   P1  targeted only at organization B
 *   P2  at the partner level (with a partner-owned child K targeted at B only)
 *   P3  at a site in A (and a site in B)
 *   P4  at an MSP-owned device group whose only member is in B
 *   P5  no targets, with an org-managed child C5 in A
 *   P6  no targets, no children (inactive)
 *   P7  at organization A          P8  at a device in A
 *   P9  at A's own device group    P10 at an MSP-owned group with a member in A
 *
 * The limited callers read P2, P3, P5, P7–P10 on every surface and never P1,
 * P4, P6 or K. Full access and system read all of them.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/configPolicyReadScope.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { configPolicyRoutes } from '../../routes/configurationPolicies';
import {
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  partnerUsers,
} from '../../db/schema';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createAccessToken } from '../../services/jwt';
import { listConfigPolicies } from '../../services/configurationPolicy';
import { keepReadablePolicies, readablePolicyIds } from '../../services/configPolicyReadable';
import { registerConfigPolicyTools } from '../../services/aiToolsConfigPolicy';
import type { AiTool } from '../../services/aiTools';
import { shutdownPeripheralJobs } from '../../jobs/peripheralJobs';
import { shutdownPolicyEvaluationWorker } from '../../jobs/policyEvaluationWorker';
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
  await shutdownPolicyEvaluationWorker();
  await closeRedis();
});

const READ_WRITE = [
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
];

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
  const user = await createUser({ partnerId, orgId, email: `rs-o-${randomUUID().slice(0, 8)}@example.test` });
  const role = await createRole({ scope: 'organization', orgId, partnerId });
  await grantRolePermissions(role.id, READ_WRITE);
  await assignUserToOrganization(user.id, orgId, role.id);
  // A real org session carries its org's partner (bindOrganizationSessionPartner).
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, scope: 'organization',
    orgId, partnerId, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function partnerToken(partnerId: string, orgAccess: 'all' | 'selected', selectedOrgIds: string[] = []) {
  const user = await createUser({ partnerId, orgId: null, email: `rs-p-${randomUUID().slice(0, 8)}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, READ_WRITE);
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  if (orgAccess === 'selected') {
    await (getTestDb() as any).update(partnerUsers).set({ orgIds: selectedOrgIds }).where(eq(partnerUsers.userId, user.id));
  }
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, scope: 'partner',
    orgId: null, partnerId, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

/** AuthContext + DB context for the service-level surfaces (AI tools, id filters). */
function principal(kind: 'org' | 'selected' | 'full' | 'system', partnerId: string, orgA: string, allOrgs: string[]) {
  const orgIds = kind === 'org' || kind === 'selected' ? [orgA] : kind === 'full' ? allOrgs : null;
  const scope = kind === 'org' ? 'organization' : kind === 'system' ? 'system' : 'partner';
  const auth = {
    principal: { kind: 'user_session' },
    user: { id: randomUUID(), email: 'rs@example.test', name: 'RS', isPlatformAdmin: false },
    token: { mfa: true },
    partnerId: kind === 'system' ? null : partnerId,
    orgId: kind === 'org' ? orgA : null,
    scope,
    accessibleOrgIds: orgIds,
    partnerOrgAccess: kind === 'selected' ? 'selected' : kind === 'full' ? 'all' : undefined,
    orgCondition: (col: never) => (orgIds === null ? undefined : inArray(col, orgIds)),
    canAccessOrg: (id: string) => orgIds === null || orgIds.includes(id),
  } as unknown as AuthContext;
  const ctx: DbAccessContext = kind === 'system'
    ? { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null }
    : buildDbAccessContext({ scope, orgId: auth.orgId, accessibleOrgIds: orgIds, partnerId, userId: null });
  return { auth, ctx };
}

async function seedMatrix() {
  const tdb = getTestDb() as any;
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Birch' });
  const siteA = await createSite({ orgId: orgA.id, name: 'Acme HQ' });
  const siteB = await createSite({ orgId: orgB.id, name: 'Birch HQ' });
  const deviceA = await createDevice({ orgId: orgA.id, siteId: siteA.id });
  const deviceB = await createDevice({ orgId: orgB.id, siteId: siteB.id });

  const policy = async (name: string, owner: { orgId: string | null }, extra: Record<string, unknown> = {}) => {
    const [row] = await tdb.insert(configurationPolicies).values({
      orgId: owner.orgId,
      partnerId: owner.orgId ? null : partner.id,
      name: `${name} ${randomUUID().slice(0, 6)}`,
      status: 'active',
      ...extra,
    }).returning({ id: configurationPolicies.id });
    return row.id as string;
  };
  const assign = (configPolicyId: string, level: string, targetId: string) =>
    tdb.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority: 0 });
  const group = async (owner: { orgId: string | null }, members: Array<{ deviceId: string; orgId: string }>) => {
    const [g] = await tdb.insert(deviceGroups).values({
      orgId: owner.orgId, partnerId: owner.orgId ? null : partner.id, name: `G ${randomUUID().slice(0, 6)}`,
    }).returning({ id: deviceGroups.id });
    if (members.length) await tdb.insert(deviceGroupMemberships).values(members.map((m) => ({ groupId: g.id, ...m })));
    return g.id as string;
  };

  const msp = { orgId: null };
  const P1 = await policy('P1 Birch only', msp); await assign(P1, 'organization', orgB.id);
  const P2 = await policy('P2 all orgs', msp); await assign(P2, 'partner', partner.id);
  const K = await policy('K Birch child', msp, { parentPolicyId: P2 }); await assign(K, 'organization', orgB.id);
  const P3 = await policy('P3 Acme site', msp); await assign(P3, 'site', siteA.id); await assign(P3, 'site', siteB.id);
  const groupB = await group(msp, [{ deviceId: deviceB.id, orgId: orgB.id }]);
  const P4 = await policy('P4 MSP group in Birch', msp); await assign(P4, 'device_group', groupB);
  const P5 = await policy('P5 parent of Acme child', msp);
  const C5 = await policy('C5 Acme child', { orgId: orgA.id }, { parentPolicyId: P5 });
  const P6 = await policy('P6 nowhere', msp, { status: 'inactive' });
  const P7 = await policy('P7 Acme org', msp); await assign(P7, 'organization', orgA.id);
  const P8 = await policy('P8 Acme device', msp); await assign(P8, 'device', deviceA.id);
  const groupOwnA = await group({ orgId: orgA.id }, []);
  const P9 = await policy('P9 Acme own group', msp); await assign(P9, 'device_group', groupOwnA);
  const groupMixed = await group(msp, [{ deviceId: deviceA.id, orgId: orgA.id }]);
  const P10 = await policy('P10 MSP group with Acme member', msp); await assign(P10, 'device_group', groupMixed);

  const readable = { P2, P3, P5, P7, P8, P9, P10 };
  const hidden = { P1, P4, P6, K };
  const all = { ...readable, ...hidden };
  return { partner, orgA, orgB, siteA, siteB, deviceA, deviceB, readable, hidden, all, C5, P1, P2, P3, P5, P6, K };
}

type Matrix = Awaited<ReturnType<typeof seedMatrix>>;

async function tokens(m: Matrix) {
  return {
    org: await orgToken(m.partner.id, m.orgA.id),
    selected: await partnerToken(m.partner.id, 'selected', [m.orgA.id]),
    full: await partnerToken(m.partner.id, 'all'),
  };
}

async function listedIds(app: Hono, token: string, query = '') {
  const res = await call(app, token, 'GET', `/configuration-policies?limit=100${query}`);
  expect(res.status).toBe(200);
  return new Set(((await res.json()).data as Array<{ id: string }>).map((p) => p.id));
}

describe('configuration policy read scoping on real Postgres (#12462 W03a)', () => {
  runDb('a caller limited to one organization cannot list, open or name a policy targeted only at another', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);

    for (const [who, token] of [['org', t.org], ['selected', t.selected]] as const) {
      const listed = await listedIds(app, token);
      for (const [name, id] of Object.entries(m.readable)) {
        expect(listed.has(id), `${who} lists ${name}`).toBe(true);
        expect((await call(app, token, 'GET', `/configuration-policies/${id}`)).status, `${who} opens ${name}`).toBe(200);
      }
      for (const [name, id] of Object.entries(m.hidden)) {
        expect(listed.has(id), `${who} must not list ${name}`).toBe(false);
        expect((await call(app, token, 'GET', `/configuration-policies/${id}`)).status, `${who} must not open ${name}`).toBe(404);
        expect((await call(app, token, 'GET', `/configuration-policies/${id}/features`)).status).toBe(404);
        expect((await call(app, token, 'GET', `/configuration-policies/${id}/assignments`)).status).toBe(404);
        expect((await call(app, token, 'GET', `/configuration-policies/${id}/reach`)).status).toBe(404);
      }
      // The batch reach route drops the hidden ids.
      const reach = await call(app, token, 'GET', `/configuration-policies/reach?ids=${Object.values(m.all).join(',')}`);
      expect(reach.status).toBe(200);
      const reachIds = Object.keys((await reach.json()).data);
      expect(reachIds.sort()).toEqual(Object.values(m.readable).sort());
    }

    // Full access reads every one of them.
    const fullListed = await listedIds(app, t.full);
    for (const id of Object.values(m.all)) expect(fullListed.has(id)).toBe(true);
    for (const id of Object.values(m.hidden)) {
      expect((await call(app, t.full, 'GET', `/configuration-policies/${id}`)).status).toBe(200);
    }
  });

  runDb('GET /:id returns access: read-only for the org user and the limited partner, editable for full access', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);
    const access = async (token: string) => (await (await call(app, token, 'GET', `/configuration-policies/${m.P2}`)).json()).access;
    expect(await access(t.org)).toEqual({ canEdit: false, reason: 'msp_managed_org_user' });
    expect(await access(t.selected)).toEqual({ canEdit: false, reason: 'msp_managed_limited_access' });
    expect(await access(t.full)).toEqual({ canEdit: true, reason: null });
  });

  runDb('the parent and child embeds name only policies the caller may read', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);

    for (const token of [t.org, t.selected]) {
      // P5 is readable through its Acme child; its embed names that child.
      const p5 = await (await call(app, token, 'GET', `/configuration-policies/${m.P5}`)).json();
      expect(p5.childPolicies.map((c: { id: string }) => c.id)).toEqual([m.C5]);
      // The child's parent embed names P5.
      const c5 = await (await call(app, token, 'GET', `/configuration-policies/${m.C5}`)).json();
      expect(c5.parentPolicy?.id).toBe(m.P5);
      // P2's MSP-managed child K applies only to Birch: not named.
      const p2 = await (await call(app, token, 'GET', `/configuration-policies/${m.P2}`)).json();
      expect(p2.childPolicies).toEqual([]);
    }
    const p2Full = await (await call(app, t.full, 'GET', `/configuration-policies/${m.P2}`)).json();
    expect(p2Full.childPolicies.map((c: { id: string }) => c.id)).toEqual([m.K]);
  });

  runDb('eligible parents are only the policies the caller may read', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);
    const roots = [m.P1, m.P2, m.P3, m.P5, m.P6, m.readable.P7, m.readable.P8, m.readable.P9, m.readable.P10];
    const readableRoots = [m.P2, m.P3, m.P5, m.readable.P7, m.readable.P8, m.readable.P9, m.readable.P10];

    for (const token of [t.org, t.selected]) {
      const res = await call(app, token, 'GET', `/configuration-policies/eligible-parents?ownerScope=organization&orgId=${m.orgA.id}`);
      expect(res.status).toBe(200);
      const ids = ((await res.json()).data as Array<{ id: string }>).map((p) => p.id).filter((id) => roots.includes(id));
      expect(ids.sort()).toEqual(readableRoots.sort());
    }
    const full = await call(app, t.full, 'GET', `/configuration-policies/eligible-parents?ownerScope=organization&orgId=${m.orgA.id}`);
    const fullIds = ((await full.json()).data as Array<{ id: string }>).map((p) => p.id).filter((id) => roots.includes(id));
    expect(fullIds.sort()).toEqual(roots.sort());
  });

  runDb('a caller cannot make a hidden policy readable by naming it as a parent', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);
    const refused = await call(app, t.org, 'POST', '/configuration-policies', { name: 'Child of hidden', parentPolicyId: m.P1 });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'INVALID_PARENT_POLICY' });
    expect((await call(app, t.org, 'GET', `/configuration-policies/${m.P1}`)).status).toBe(404);

    // Control: a readable MSP-managed root may still be inherited.
    const allowed = await call(app, t.org, 'POST', '/configuration-policies', { name: 'Child of readable', parentPolicyId: m.P3 });
    expect(allowed.status).toBe(201);
  });

  runDb('the policy page lists only its own targets; the target listing names readable MSP-managed policies', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);

    for (const token of [t.org, t.selected]) {
      const rows = (await (await call(app, token, 'GET', `/configuration-policies/${m.P3}/assignments`)).json()).data;
      expect(rows.map((r: { targetId: string }) => r.targetId)).toEqual([m.siteA.id]);

      const target = await call(app, token, 'GET', `/configuration-policies/assignments/target?level=site&targetId=${m.siteA.id}`);
      expect(target.status).toBe(200);
      const named = (await target.json()).data.map((r: { assignment: { configPolicyId: string } }) => r.assignment.configPolicyId);
      expect(named).toContain(m.P3);
    }
    const fullRows = (await (await call(app, t.full, 'GET', `/configuration-policies/${m.P3}/assignments`)).json()).data;
    expect(fullRows.map((r: { targetId: string }) => r.targetId).sort()).toEqual([m.siteA.id, m.siteB.id].sort());
  });

  runDb('writes by the limited callers on readable MSP-managed policies are refused as today', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);
    for (const id of [m.P2, m.P3, m.P5]) {
      // Org scope: the write-side reader never admits an MSP-managed policy.
      expect((await call(app, t.org, 'PATCH', `/configuration-policies/${id}`, { name: 'x' })).status).toBe(404);
      // Limited partner: the partner-wide capability refuses.
      expect((await call(app, t.selected, 'PATCH', `/configuration-policies/${id}`, { name: 'x' })).status).toBe(403);
      expect((await call(app, t.selected, 'DELETE', `/configuration-policies/${id}`)).status).toBe(403);
    }
    // A limited partner can no longer reach an unreadable one even to be refused.
    expect((await call(app, t.selected, 'PATCH', `/configuration-policies/${m.P1}`, { name: 'x' })).status).toBe(404);
  });

  runDb('the effective-config preview refuses a policy the caller may not read', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);
    for (const token of [t.org, t.selected]) {
      const res = await call(app, token, 'POST', `/configuration-policies/effective/${m.deviceA.id}/diff`, {
        add: [{ configPolicyId: m.P1, level: 'device', targetId: m.deviceA.id }],
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Configuration policy not found' });
    }
  });

  runDb('list filters: appliesToOrgId and notApplied', async () => {
    const app = buildApp();
    const m = await seedMatrix();
    const t = await tokens(m);
    const ours = new Set<string>([...Object.values(m.all), m.C5]);
    const pick = (ids: Set<string>) => [...ids].filter((id) => ours.has(id)).sort();

    // Full access: applying to Acme, plus the inactive policy that applies nowhere (Q3).
    expect(pick(await listedIds(app, t.full, `&appliesToOrgId=${m.orgA.id}`)))
      .toEqual([...Object.values(m.readable), m.P6].sort());
    // The org user: the same rule, ANDed with what it may read.
    expect(pick(await listedIds(app, t.org, `&appliesToOrgId=${m.orgA.id}`)))
      .toEqual(Object.values(m.readable).sort());
    // No rows and no children: P6, and the org-owned child C5.
    expect(pick(await listedIds(app, t.full, '&notApplied=true'))).toEqual([m.P6, m.C5].sort());
    // Another org the caller cannot access is refused.
    expect((await call(app, t.org, 'GET', `/configuration-policies?appliesToOrgId=${m.orgB.id}`)).status).toBe(403);
    // orgId keeps its meaning: Birch's own policies plus every MSP-managed one of its partner.
    const byOrg = pick(await listedIds(app, t.full, `&orgId=${m.orgB.id}`));
    expect(byOrg).toEqual(Object.values(m.all).sort());
  });

  runDb('the AI read tools, the id filter and system scope follow the same rule', async () => {
    const m = await seedMatrix();
    const allOrgs = [m.orgA.id, m.orgB.id];
    const tools = new Map<string, AiTool>();
    registerConfigPolicyTools(tools);
    const everything = Object.values(m.all);

    for (const kind of ['org', 'selected', 'full', 'system'] as const) {
      const { auth, ctx } = principal(kind, m.partner.id, m.orgA.id, allOrgs);
      const expected = kind === 'org' || kind === 'selected' ? Object.values(m.readable) : everything;

      const listed = await withDbAccessContext(ctx, async () =>
        JSON.parse(await tools.get('list_configuration_policies')!.handler({ limit: 100 }, auth)));
      const listedIds = (listed.policies as Array<{ id: string }>).map((p) => p.id).filter((id) => everything.includes(id));
      expect(listedIds.sort(), `${kind} list_configuration_policies`).toEqual([...expected].sort());

      for (const id of everything) {
        const got = await withDbAccessContext(ctx, async () =>
          JSON.parse(await tools.get('get_configuration_policy')!.handler({ policyId: id }, auth)));
        expect(!got.error, `${kind} get_configuration_policy ${id}`).toBe(expected.includes(id));
      }

      const readableIds = await withDbAccessContext(ctx, () => readablePolicyIds(auth, everything));
      expect(readableIds.sort()).toEqual([...expected].sort());
      // The chokepoint the monitor, group and attachment readers use.
      const kept = await withDbAccessContext(ctx, () =>
        keepReadablePolicies(auth, everything.map((id) => ({ id, orgId: null })), (r) => r));
      expect(kept.map((r) => r.id).sort()).toEqual([...expected].sort());

      const page = await withDbAccessContext(ctx, () => listConfigPolicies(auth, {}, { page: 1, limit: 100 }));
      expect(page.data.map((p) => p.id).filter((id) => everything.includes(id)).sort()).toEqual([...expected].sort());
    }

    // The AI get tool returns only the org user's own targets of P3, with the honest total.
    const { auth, ctx } = principal('org', m.partner.id, m.orgA.id, allOrgs);
    const p3 = await withDbAccessContext(ctx, async () =>
      JSON.parse(await tools.get('get_configuration_policy')!.handler({ policyId: m.P3 }, auth)));
    expect(p3.assignmentCount).toBe(2);
    expect(p3.assignments.map((a: { targetId: string }) => a.targetId)).toEqual([m.siteA.id]);
  });
});
