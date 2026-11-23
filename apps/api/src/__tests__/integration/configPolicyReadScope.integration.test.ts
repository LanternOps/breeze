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
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { loadDesignEvidence } from '../../services/aiAgents/designEvidence';
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
function principal(kind: 'org' | 'selected' | 'mcp' | 'full' | 'system', partnerId: string, orgA: string, allOrgs: string[]) {
  // `mcp`: a partner MCP credential, whose context never carries partnerOrgAccess.
  const orgIds = kind === 'org' || kind === 'selected' || kind === 'mcp' ? [orgA] : kind === 'full' ? allOrgs : null;
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

/** The same principal with a site allowlist and/or a device pin (SR5-07, #6096). */
function restricted(base: { auth: AuthContext; ctx: DbAccessContext }, limits: { sites?: string[]; devices?: string[] }) {
  const auth = {
    ...base.auth,
    allowedSiteIds: limits.sites,
    canAccessSite: limits.sites ? (id: string | null | undefined) => !!id && limits.sites!.includes(id) : undefined,
    allowedDeviceIds: limits.devices,
  } as unknown as AuthContext;
  return { auth, ctx: base.ctx };
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
  return { partner, orgA, orgB, siteA, siteB, deviceA, deviceB, groupB, groupMixed, readable, hidden, all, C5, P1, P2, P3, P5, P6, K };
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

  runDb('an org user reads an untargeted MSP-managed parent through an MSP-managed child that applies to its org (D14 clause 5)', async () => {
    // The matrix covers clause 5 only through an org-owned child (P5 ← C5);
    // K's parent P2 is readable on its own (clause 1). Here the parent has no
    // rows of its own and its only child is MSP-managed too.
    const app = buildApp();
    const tdb = getTestDb() as any;
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme' });
    const orgB = await createOrganization({ partnerId: partner.id, name: 'Birch' });
    const msp = async (name: string, parentPolicyId?: string) => {
      const [row] = await tdb.insert(configurationPolicies).values({
        orgId: null, partnerId: partner.id, name: `${name} ${randomUUID().slice(0, 6)}`, status: 'active',
        ...(parentPolicyId ? { parentPolicyId } : {}),
      }).returning({ id: configurationPolicies.id });
      return row.id as string;
    };
    const parentA = await msp('Parent of an Acme MSP child');
    const childA = await msp('Acme MSP child', parentA);
    const parentB = await msp('Parent of a Birch MSP child');
    const childB = await msp('Birch MSP child', parentB);
    await tdb.insert(configPolicyAssignments).values([
      { configPolicyId: childA, level: 'organization', targetId: orgA.id, priority: 0 },
      { configPolicyId: childB, level: 'organization', targetId: orgB.id, priority: 0 },
    ]);

    const token = await orgToken(partner.id, orgA.id);
    const listed = await listedIds(app, token);
    expect(listed.has(parentA)).toBe(true);
    expect(listed.has(childA)).toBe(true);
    expect((await call(app, token, 'GET', `/configuration-policies/${parentA}`)).status).toBe(200);
    const child = await (await call(app, token, 'GET', `/configuration-policies/${childA}`)).json();
    expect(child.parentPolicy?.id).toBe(parentA);
    const parents = await call(app, token, 'GET', `/configuration-policies/eligible-parents?ownerScope=organization&orgId=${orgA.id}`);
    expect(((await parents.json()).data as Array<{ id: string }>).map((p) => p.id)).toContain(parentA);

    // Control: the parent whose MSP-managed child applies only to Birch stays hidden.
    expect(listed.has(parentB)).toBe(false);
    expect(listed.has(childB)).toBe(false);
    expect((await call(app, token, 'GET', `/configuration-policies/${parentB}`)).status).toBe(404);
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
    // A limited partner can no longer reach an unreadable one even to be refused,
    // on every write door, not only PATCH.
    expect((await call(app, t.selected, 'PATCH', `/configuration-policies/${m.P1}`, { name: 'x' })).status).toBe(404);
    const assignBody = { level: 'site', targetId: m.siteA.id };
    expect((await call(app, t.selected, 'POST', `/configuration-policies/${m.P1}/assignments`, assignBody)).status).toBe(404);
    expect((await call(app, t.selected, 'POST', `/configuration-policies/${m.P1}/assignments/apply`, { add: [assignBody] })).status).toBe(404);
    const featureBody = { featureType: 'event_log', inlineSettings: {} };
    expect((await call(app, t.selected, 'POST', `/configuration-policies/${m.P1}/features`, featureBody)).status).toBe(404);
    // Control: a readable one reaches the capability gate.
    expect((await call(app, t.selected, 'POST', `/configuration-policies/${m.P3}/assignments`, assignBody)).status).toBe(403);
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
    // ...and never widens what a limited caller may read.
    for (const token of [t.org, t.selected]) {
      expect(pick(await listedIds(app, token, `&orgId=${m.orgA.id}`))).toEqual([...Object.values(m.readable), m.C5].sort());
    }
  });

  runDb('the AI read tools, the id filter and system scope follow the same rule', async () => {
    const m = await seedMatrix();
    const allOrgs = [m.orgA.id, m.orgB.id];
    const tools = new Map<string, AiTool>();
    registerConfigPolicyTools(tools);
    const everything = Object.values(m.all);

    for (const kind of ['org', 'selected', 'mcp', 'full', 'system'] as const) {
      const { auth, ctx } = principal(kind, m.partner.id, m.orgA.id, allOrgs);
      const expected = kind === 'full' || kind === 'system' ? everything : Object.values(m.readable);

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

  runDb('the fleet-design evidence for an org names only the MSP-managed policies that apply to it', async () => {
    const m = await seedMatrix();
    const idsFor = async (orgId: string) => {
      const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(orgId, {}));
      // A failing statement would land here silently: assert it did not.
      expect(evidence.unavailable).not.toContain('configuration');
      return new Set(evidence.configuration.policies.map((p) => p.id));
    };
    const acme = await idsFor(m.orgA.id);
    for (const id of [...Object.values(m.readable), m.C5]) expect(acme.has(id)).toBe(true);
    for (const id of Object.values(m.hidden)) expect(acme.has(id)).toBe(false);

    // Birch is governed by P1, P2, P3, P4 and K; not by the Acme-only ones.
    const birch = await idsFor(m.orgB.id);
    for (const id of [m.P1, m.P2, m.P3, m.hidden.P4, m.K]) expect(birch.has(id)).toBe(true);
    for (const id of [m.P5, m.P6, m.readable.P7, m.readable.P8, m.readable.P9, m.readable.P10, m.C5]) expect(birch.has(id)).toBe(false);
  });

  runDb('the AI get tool keeps a site-restricted and a device-pinned caller to the targets they may reach (Strix round two)', async () => {
    const tdb = getTestDb() as any;
    const m = await seedMatrix();
    const siteA2 = await createSite({ orgId: m.orgA.id, name: 'Acme Annex' });
    const deviceA2 = await createDevice({ orgId: m.orgA.id, siteId: siteA2.id });
    const insertPolicy = async (orgId: string | null, name: string) => {
      const [row] = await tdb.insert(configurationPolicies).values({
        orgId, partnerId: orgId ? null : m.partner.id, name: `${name} ${randomUUID().slice(0, 6)}`, status: 'active',
      }).returning({ id: configurationPolicies.id });
      return row.id as string;
    };
    const assign = (configPolicyId: string, level: string, targetId: string) =>
      tdb.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority: 0 });

    // An MSP-managed policy across Acme's two sites (and Birch), and an Acme-owned one.
    const Q = await insertPolicy(null, 'Q Acme wide');
    for (const [level, id] of [
      ['organization', m.orgA.id], ['site', m.siteA.id], ['site', siteA2.id],
      ['device', m.deviceA.id], ['device', deviceA2.id], ['site', m.siteB.id],
    ] as const) await assign(Q, level, id);
    const O = await insertPolicy(m.orgA.id, 'O Acme own');
    for (const [level, id] of [
      ['organization', m.orgA.id], ['site', m.siteA.id], ['site', siteA2.id], ['device', deviceA2.id],
    ] as const) await assign(O, level, id);

    const tools = new Map<string, AiTool>();
    registerConfigPolicyTools(tools);
    const org = principal('org', m.partner.id, m.orgA.id, [m.orgA.id, m.orgB.id]);
    const targetsOf = async (who: { auth: AuthContext; ctx: DbAccessContext }, policyId: string) => {
      const got = await withDbAccessContext(who.ctx, async () =>
        JSON.parse(await tools.get('get_configuration_policy')!.handler({ policyId }, who.auth)));
      expect(got.error, `get ${policyId}`).toBeUndefined();
      return { count: got.assignmentCount as number, ids: (got.assignments as Array<{ targetId: string }>).map((a) => a.targetId).sort() };
    };

    // Control: an unrestricted Acme user sees every Acme target, never Birch's.
    expect(await targetsOf(org, Q)).toEqual({ count: 6, ids: [m.orgA.id, m.siteA.id, siteA2.id, m.deviceA.id, deviceA2.id].sort() });
    expect((await targetsOf(org, O)).ids).toEqual([m.orgA.id, m.siteA.id, siteA2.id, deviceA2.id].sort());

    // Restricted to Acme HQ: that site and its device; never the org row or the annex.
    const siteTech = restricted(org, { sites: [m.siteA.id] });
    expect(await targetsOf(siteTech, Q)).toEqual({ count: 6, ids: [m.siteA.id, m.deviceA.id].sort() });
    expect(await targetsOf(siteTech, O)).toEqual({ count: 4, ids: [m.siteA.id] });

    // Pinned to one device (a device-bound agent run): that device row only.
    const pinned = restricted(org, { devices: [m.deviceA.id] });
    expect(await targetsOf(pinned, Q)).toEqual({ count: 6, ids: [m.deviceA.id] });
    expect(await targetsOf(pinned, O)).toEqual({ count: 4, ids: [] });
    // Both axes at once: the pin and the site must both admit the row.
    const both = restricted(org, { sites: [m.siteA.id], devices: [deviceA2.id] });
    expect((await targetsOf(both, Q)).ids).toEqual([]);
  });

  runDb('the fleet-design evidence for one org carries no target id of another org on a shared MSP-managed policy (Strix round two)', async () => {
    const tdb = getTestDb() as any;
    const m = await seedMatrix();
    const [ownB] = await tdb.insert(deviceGroups).values({ orgId: m.orgB.id, partnerId: null, name: `Birch own ${randomUUID().slice(0, 6)}` })
      .returning({ id: deviceGroups.id });
    const [S] = await tdb.insert(configurationPolicies).values({
      orgId: null, partnerId: m.partner.id, name: `S shared ${randomUUID().slice(0, 6)}`, status: 'active',
    }).returning({ id: configurationPolicies.id });
    for (const [level, id] of [
      ['partner', m.partner.id],
      ['organization', m.orgA.id], ['organization', m.orgB.id],
      ['site', m.siteA.id], ['site', m.siteB.id],
      ['device', m.deviceA.id], ['device', m.deviceB.id],
      ['device_group', m.groupMixed], ['device_group', m.groupB], ['device_group', ownB.id],
    ] as const) await tdb.insert(configPolicyAssignments).values({ configPolicyId: S.id, level, targetId: id, priority: 0 });

    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(m.orgA.id, {}));
    // A failing statement lands silently in `unavailable` with no rows: assert it did not.
    expect(evidence.unavailable).not.toContain('configuration');
    const rowsOf = (policyId: string) => evidence.configuration.assignments
      .filter((a) => a.policyId === policyId).map((a) => `${a.level}:${a.targetId}`).sort();

    // Acme's own rows of the shared policy are all there.
    expect(rowsOf(S.id)).toEqual([
      `partner:${m.partner.id}`, `organization:${m.orgA.id}`, `site:${m.siteA.id}`,
      `device:${m.deviceA.id}`, `device_group:${m.groupMixed}`,
    ].sort());
    expect(rowsOf(m.P3)).toEqual([`site:${m.siteA.id}`]);
    expect(rowsOf(m.P2)).toEqual([`partner:${m.partner.id}`]);

    // Nowhere in the bundle: Birch, its site, device and groups, or an MSP group only Birch uses.
    const bundle = JSON.stringify(evidence);
    for (const id of [m.orgB.id, m.siteB.id, m.deviceB.id, ownB.id, m.groupB]) expect(bundle).not.toContain(id);

    // Birch's own bundle still carries Birch's rows of the same policy.
    const birch = await withSystemDbAccessContext(() => loadDesignEvidence(m.orgB.id, {}));
    const birchRows = birch.configuration.assignments.filter((a) => a.policyId === S.id).map((a) => a.targetId);
    expect(birchRows.sort()).toEqual([m.partner.id, m.orgB.id, m.siteB.id, m.deviceB.id, m.groupB, ownB.id].sort());
    expect(JSON.stringify(birch)).not.toContain(m.siteA.id);
  });
});
