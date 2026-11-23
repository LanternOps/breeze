/**
 * "Outranked on N devices" under real forced RLS (#12472, plan W05a O2).
 *
 * THE PARITY PROOF. On a seeded tree, for every reached device and every
 * feature, `outranked` agrees with whether `resolveEffectiveConfig`'s winner is
 * another policy. Both run in the same caller context on the unprivileged
 * `breeze_app` connection, with contexts built by the real
 * `buildDbAccessContext`, once as a partner-scope caller and once as an
 * organization-scope caller.
 *
 * The tree covers every rule the resolver applies: a more specific level, a
 * priority win at the same level, assignment age at the same priority, an
 * inactive competitor, a weaker partner-level competitor, an inherited feature,
 * an MSP-owned competitor, and a refused (hostname-keyed) dynamic group that
 * delivers a protective feature but not an execution-gated one.
 */
import './setup';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { configPolicyRoutes } from '../../routes/configurationPolicies';
import { createAccessToken } from '../../services/jwt';
import { shutdownPeripheralJobs } from '../../jobs/peripheralJobs';
import { shutdownPolicyEvaluationWorker } from '../../jobs/policyEvaluationWorker';
import { closeRedis } from '../../services/redis';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
} from '../../db/schema';
import { computePolicyPrecedence, type PolicyPrecedence } from '../../services/configPolicyPrecedence';
import { resolveEffectiveConfig } from '../../services/configurationPolicy';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
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

const FEATURES = ['patch', 'automation', 'backup'] as const;
type Feature = (typeof FEATURES)[number];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId, userId: null });
}

function partnerCtx(partnerId: string, orgIds: string[]): DbAccessContext {
  return buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, partnerId, userId: null });
}

function orgAuth(orgId: string, partnerId: string, extra: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: randomUUID(), email: 'org@example.com', name: 'Org User', isPlatformAdmin: false },
    token: {} as never,
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: unknown) => eq(col as never, orgId),
    canAccessOrg: (id: string) => id === orgId,
    ...extra,
  } as unknown as AuthContext;
}

function partnerAuth(partnerId: string, orgIds: string[]): AuthContext {
  return {
    user: { id: randomUUID(), email: 'msp@example.com', name: 'MSP User', isPlatformAdmin: false },
    token: {} as never,
    partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: orgIds,
    orgCondition: (col: unknown) => inArray(col as never, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
  } as unknown as AuthContext;
}

const createdPolicies: string[] = [];
const createdGroups: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdPolicies.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.parentPolicyId, createdPolicies));
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, createdPolicies));
    }
    if (createdGroups.length > 0) {
      await db.delete(deviceGroupMemberships).where(inArray(deviceGroupMemberships.groupId, createdGroups));
      await db.delete(deviceGroups).where(inArray(deviceGroups.id, createdGroups));
    }
  });
  createdPolicies.length = 0;
  createdGroups.length = 0;
});

const T0 = new Date('2026-01-01T00:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function seedPolicy(
  owner: { orgId: string | null; partnerId: string | null },
  opts: { name: string; status: 'active' | 'inactive'; features: Feature[]; parentPolicyId?: string },
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: `${opts.name} ${randomUUID().slice(0, 8)}`,
        status: opts.status,
        parentPolicyId: opts.parentPolicyId ?? null,
      })
      .returning();
    createdPolicies.push(policy!.id);
    for (const featureType of opts.features) {
      await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType });
    }
    return policy!;
  });
}

async function assign(
  configPolicyId: string,
  level: 'partner' | 'organization' | 'site' | 'device_group' | 'device',
  targetId: string,
  priority: number,
  createdAt: Date,
  roleFilter: string[] | null = null,
) {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority, createdAt, roleFilter });
  });
}

async function seedDevice(orgId: string, siteId: string, deviceRole: 'workstation' | 'server' = 'workstation') {
  const { id } = await createDevice({ orgId, siteId });
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.update(devices).set({ deviceRole }).where(eq(devices.id, id));
  });
  return id;
}

/** A device parked in a holding org, admitted the way enrollment admits one. */
async function seedParkedDevice(orgId: string, siteId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const unique = randomUUID().slice(0, 8);
    const [device] = await db.insert(devices).values({
      orgId, siteId, agentId: `prec-${unique}`, hostname: `prec-${unique}`,
      osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.0.0-test',
      status: 'online', deviceRole: 'workstation',
    }).returning();
    return device!.id;
  });
}

async function seedGroup(orgId: string, filterFieldsUsed: string[], members: string[]) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [group] = await db
      .insert(deviceGroups)
      .values({ orgId, partnerId: null, name: `group ${randomUUID().slice(0, 8)}`, filterFieldsUsed })
      .returning();
    createdGroups.push(group!.id);
    await db.insert(deviceGroupMemberships).values(members.map((deviceId) => ({ groupId: group!.id, orgId, deviceId })));
    return group!.id;
  });
}

async function setStatus(policyId: string, status: 'active' | 'inactive') {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.update(configurationPolicies).set({ status }).where(eq(configurationPolicies.id, policyId));
  });
}

/**
 * The resolver's answer, per feature: the devices where the winner is another
 * policy. The subject must be active here (the resolver skips inactive ones).
 */
async function resolverOutranked(
  ctx: DbAccessContext,
  auth: AuthContext,
  subjectId: string,
  deviceIds: string[],
): Promise<Record<Feature, string[]>> {
  const out: Record<Feature, string[]> = { patch: [], automation: [], backup: [] };
  await withDbAccessContext(ctx, async () => {
    for (const deviceId of deviceIds) {
      const effective = await resolveEffectiveConfig(deviceId, auth);
      expect(effective, `device ${deviceId} must resolve in this context`).not.toBeNull();
      for (const ft of FEATURES) {
        const winner = effective!.features[ft];
        if (winner && winner.sourcePolicyId !== subjectId) out[ft].push(deviceId);
      }
    }
  });
  return out;
}

function precedenceAs(ctx: DbAccessContext, auth: AuthContext, policyId: string, limits = {}): Promise<PolicyPrecedence | null> {
  return withDbAccessContext(ctx, () => computePolicyPrecedence(auth, policyId, limits));
}

/**
 * One partner, two organizations. The subject policy S is MSP-owned and
 * INACTIVE (Q6: evaluated as if active), the child of a parent that gives it
 * `backup`. Its own links are `patch` and `automation` (execution-gated).
 */
async function seedTree() {
  const partner = await createPartner();
  const orgA = (await createOrganization({ partnerId: partner.id, name: 'Acme' }))!;
  const orgB = (await createOrganization({ partnerId: partner.id, name: 'Birch' }))!;
  const siteA1 = (await createSite({ orgId: orgA.id, name: 'Acme HQ' }))!;
  const siteA2 = (await createSite({ orgId: orgA.id, name: 'Acme Annex' }))!;
  const siteB = (await createSite({ orgId: orgB.id, name: 'Birch HQ' }))!;
  const a1 = await seedDevice(orgA.id, siteA1.id);
  const a2 = await seedDevice(orgA.id, siteA1.id, 'server');
  const a3 = await seedDevice(orgA.id, siteA2.id);
  const b1 = await seedDevice(orgB.id, siteB.id);
  const b2 = await seedDevice(orgB.id, siteB.id);
  // A dynamic group keyed on hostname: refused for execution-gated features.
  const hostnameGroup = await seedGroup(orgA.id, ['hostname'], [a1, a3]);

  const msp = { orgId: null, partnerId: partner.id };
  const parent = await seedPolicy(msp, { name: 'Parent', status: 'inactive', features: ['backup'] });
  const subject = await seedPolicy(msp, {
    name: 'Subject',
    status: 'inactive',
    features: ['patch', 'automation'],
    parentPolicyId: parent.id,
  });
  await assign(subject.id, 'organization', orgA.id, 10, at(0));
  await assign(subject.id, 'organization', orgB.id, 10, at(0));
  await assign(subject.id, 'device_group', hostnameGroup, 5, at(1));

  // Device level beats S's group/org rows on a2 for patch.
  const deviceLevel = await seedPolicy({ orgId: orgA.id, partnerId: null }, { name: 'Server patching', status: 'active', features: ['patch'] });
  await assign(deviceLevel.id, 'device', a2, 0, at(2));
  // MSP-owned site row: beats S's org row on a3 for gated automation (S's
  // group row is refused there), but not S's group row for protective backup.
  const mspSite = await seedPolicy(msp, { name: 'Annex automation', status: 'active', features: ['automation', 'backup'] });
  await assign(mspSite.id, 'site', siteA2.id, 0, at(3));
  // Same level as S's org-B row, lower priority number: wins patch on b1, b2.
  const priorityWin = await seedPolicy({ orgId: orgB.id, partnerId: null }, { name: 'Birch patching', status: 'active', features: ['patch'] });
  await assign(priorityWin.id, 'organization', orgB.id, 1, at(4));
  // Same level and priority as S's org-A row, assigned earlier: wins backup on a2.
  const olderTie = await seedPolicy({ orgId: orgA.id, partnerId: null }, { name: 'Acme backup', status: 'active', features: ['backup'] });
  await assign(olderTie.id, 'organization', orgA.id, 10, at(-1));
  // Would win patch on a1, but inactive.
  const inactive = await seedPolicy({ orgId: orgA.id, partnerId: null }, { name: 'Draft', status: 'inactive', features: ['patch'] });
  await assign(inactive.id, 'device', a1, 0, at(5));
  // Weaker than every S row: never wins.
  const partnerWide = await seedPolicy(msp, { name: 'Baseline', status: 'active', features: ['patch', 'automation', 'backup'] });
  await assign(partnerWide.id, 'partner', partner.id, 0, at(-10));

  return {
    partner, orgA, orgB, siteA1, siteA2, siteB, a1, a2, a3, b1, b2,
    subject, competitors: [deviceLevel, mspSite, priorityWin, olderTie, inactive, partnerWide, parent],
  };
}

/**
 * The paths the first tree leaves out. Subject S is MSP-owned and inactive,
 * with `patch` and `automation`; its rows are site A1 (a1, a2), a refused
 * hostname group (a3 only) and the holding org (parked device p1).
 */
async function seedEdgeTree() {
  const partner = await createPartner();
  const orgA = (await createOrganization({ partnerId: partner.id, name: 'Acme' }))!;
  const holding = (await createOrganization({ partnerId: partner.id, name: 'Holding', type: 'unassigned_pool' }))!;
  const siteA1 = (await createSite({ orgId: orgA.id, name: 'Acme HQ' }))!;
  const siteA2 = (await createSite({ orgId: orgA.id, name: 'Acme Annex' }))!;
  const siteH = (await createSite({ orgId: holding.id, name: 'Holding' }))!;
  const a1 = await seedDevice(orgA.id, siteA1.id);
  const a2 = await seedDevice(orgA.id, siteA1.id, 'server');
  const a3 = await seedDevice(orgA.id, siteA2.id);
  const p1 = await seedParkedDevice(holding.id, siteH.id);
  const plainGroup = await seedGroup(orgA.id, [], [a1]);
  const taggedGroup = await seedGroup(orgA.id, ['hostname'], [a2]);
  const subjectGroup = await seedGroup(orgA.id, ['hostname'], [a3]);

  const msp = { orgId: null, partnerId: partner.id };
  const acme = { orgId: orgA.id, partnerId: null };
  const subject = await seedPolicy(msp, { name: 'Subject', status: 'inactive', features: ['patch', 'automation'] });
  await assign(subject.id, 'site', siteA1.id, 10, at(0));
  await assign(subject.id, 'device_group', subjectGroup, 0, at(1));
  await assign(subject.id, 'organization', holding.id, 10, at(0));

  // An allowed group beats S's site row on a1 (patch only).
  const plain = await seedPolicy(acme, { name: 'Group patching', status: 'active', features: ['patch'] });
  await assign(plain.id, 'device_group', plainGroup, 0, at(2));
  // A refused group: wins protective patch on a2, never gated automation.
  const tagged = await seedPolicy(acme, { name: 'Tagged ring', status: 'active', features: ['patch', 'automation'] });
  await assign(tagged.id, 'device_group', taggedGroup, 0, at(3));
  // Same level as S's site row, lower priority number, servers only: wins
  // automation on a2 and not on the workstation a1.
  const servers = await seedPolicy(acme, { name: 'Server scripts', status: 'active', features: ['automation'] });
  await assign(servers.id, 'site', siteA1.id, 1, at(4), ['server']);
  // MSP-owned, partner-level: wins automation on a3, where S's only row is the
  // refused group; S's site row beats it everywhere else.
  const baseline = await seedPolicy(msp, { name: 'Baseline scripts', status: 'active', features: ['automation'] });
  await assign(baseline.id, 'partner', partner.id, 0, at(-10));
  // A child with no links of its own, inheriting patch, assigned to a3.
  const inheritedParent = await seedPolicy(acme, { name: 'Patch base', status: 'inactive', features: ['patch'] });
  const inheritedChild = await seedPolicy(acme, {
    name: 'Annex device', status: 'active', features: [], parentPolicyId: inheritedParent.id,
  });
  await assign(inheritedChild.id, 'device', a3, 0, at(5));
  // The holding org's own policy: wins patch on p1, where no MSP-owned policy applies.
  const parkedOwn = await seedPolicy({ orgId: holding.id, partnerId: null }, { name: 'Holding patching', status: 'active', features: ['patch'] });
  await assign(parkedOwn.id, 'organization', holding.id, 50, at(6));
  // MSP-owned and more specific on p1, but not delivered there either.
  const mspParked = await seedPolicy(msp, { name: 'Parked override', status: 'active', features: ['patch', 'automation'] });
  await assign(mspParked.id, 'device', p1, 0, at(7));

  return { partner, orgA, holding, a1, a2, a3, p1, subject };
}

function expectCountsMatch(precedence: PolicyPrecedence | null, reached: number, resolver: Record<Feature, string[]>) {
  expect(precedence).toEqual({
    capped: false,
    features: {
      patch: { reached, outranked: resolver.patch.length },
      automation: { reached, outranked: resolver.automation.length },
      backup: { reached, outranked: resolver.backup.length },
    },
  });
}

describe('computePolicyPrecedence parity with resolveEffectiveConfig', () => {
  it('agrees with the resolver for a partner-scope caller on every reached device and feature', async () => {
    const t = await seedTree();
    const orgs = [t.orgA.id, t.orgB.id];
    const ctx = partnerCtx(t.partner.id, orgs);
    const auth = partnerAuth(t.partner.id, orgs);

    const whileInactive = await precedenceAs(ctx, auth, t.subject.id);
    await setStatus(t.subject.id, 'active');
    const resolver = await resolverOutranked(ctx, auth, t.subject.id, [t.a1, t.a2, t.a3, t.b1, t.b2]);

    // The tree's intended outcome, so the parity is not vacuous.
    expect(resolver.patch.sort()).toEqual([t.a2, t.b1, t.b2].sort());
    expect(resolver.automation).toEqual([t.a3]);
    expect(resolver.backup).toEqual([t.a2]);

    expectCountsMatch(whileInactive, 5, resolver);
    // Q6: the answer does not depend on the subject's own status.
    expect(await precedenceAs(ctx, auth, t.subject.id)).toEqual(whileInactive);
  });

  it('agrees with the resolver for an organization-scope caller, counting an MSP-owned competitor', async () => {
    const t = await seedTree();
    const ctx = orgCtx(t.orgA.id, t.partner.id);
    const auth = orgAuth(t.orgA.id, t.partner.id);

    const precedence = await precedenceAs(ctx, auth, t.subject.id);
    await setStatus(t.subject.id, 'active');
    const resolver = await resolverOutranked(ctx, auth, t.subject.id, [t.a1, t.a2, t.a3]);

    // automation on a3 is won by the MSP-owned site policy, which this caller cannot list.
    expect(resolver).toEqual({ patch: [t.a2], automation: [t.a3], backup: [t.a2] });
    expectCountsMatch(precedence, 3, resolver);
  });
});

describe('computePolicyPrecedence parity on the edge tree', () => {
  it('agrees with the resolver on group, partner-level, role-filtered, inherited and parked-device competitors', async () => {
    const t = await seedEdgeTree();
    const orgs = [t.orgA.id, t.holding.id];
    const ctx = partnerCtx(t.partner.id, orgs);
    const auth = partnerAuth(t.partner.id, orgs);

    const precedence = await precedenceAs(ctx, auth, t.subject.id);
    await setStatus(t.subject.id, 'active');
    const resolver = await resolverOutranked(ctx, auth, t.subject.id, [t.a1, t.a2, t.a3, t.p1]);

    expect(resolver.patch.sort()).toEqual([t.a1, t.a2, t.a3, t.p1].sort());
    expect(resolver.automation.sort()).toEqual([t.a2, t.a3].sort());
    expect(precedence).toEqual({
      capped: false,
      features: {
        patch: { reached: 4, outranked: resolver.patch.length },
        automation: { reached: 4, outranked: resolver.automation.length },
      },
    });
  });
});

describe('computePolicyPrecedence under forced RLS', () => {
  it('a partner caller limited to one organization counts only that organization', async () => {
    const t = await seedTree();
    const ctx = partnerCtx(t.partner.id, [t.orgA.id]);
    const auth = partnerAuth(t.partner.id, [t.orgA.id]);

    const precedence = await precedenceAs(ctx, auth, t.subject.id);
    await setStatus(t.subject.id, 'active');
    const resolver = await resolverOutranked(ctx, auth, t.subject.id, [t.a1, t.a2, t.a3]);

    // Birch's devices and the Birch patching win stay out.
    expect(resolver).toEqual({ patch: [t.a2], automation: [t.a3], backup: [t.a2] });
    expectCountsMatch(precedence, 3, resolver);
  });


  it('names no competitor, organization or device in its answer', async () => {
    const t = await seedTree();
    const precedence = await precedenceAs(orgCtx(t.orgA.id, t.partner.id), orgAuth(t.orgA.id, t.partner.id), t.subject.id);

    expect(Object.keys(precedence!).sort()).toEqual(['capped', 'features']);
    if (precedence!.capped) throw new Error('expected counts');
    for (const counts of Object.values(precedence!.features)) {
      expect(Object.keys(counts!).sort()).toEqual(['outranked', 'reached']);
    }
    const body = JSON.stringify(precedence);
    for (const competitor of t.competitors) {
      expect(body).not.toContain(competitor.id);
      expect(body).not.toContain(competitor.name);
    }
    for (const id of [t.orgA.id, t.orgB.id, t.partner.id, t.siteA1.id, t.siteA2.id, t.a1, t.a2, t.a3, t.b1, t.b2]) {
      expect(body).not.toContain(id);
    }
  });

  it("counts only the devices in a site-restricted caller's sites", async () => {
    const t = await seedTree();
    const restricted = orgAuth(t.orgA.id, t.partner.id, { allowedSiteIds: [t.siteA1.id] } as Partial<AuthContext>);

    // a1 and a2 only: a3 (and the automation win there) sits in another site.
    await expect(precedenceAs(orgCtx(t.orgA.id, t.partner.id), restricted, t.subject.id)).resolves.toEqual({
      capped: false,
      features: {
        patch: { reached: 2, outranked: 1 },
        automation: { reached: 2, outranked: 0 },
        backup: { reached: 2, outranked: 1 },
      },
    });
  });

  it('answers capped past the statement budget or the scan cap, and exact under them', async () => {
    const t = await seedTree();
    const orgs = [t.orgA.id, t.orgB.id];
    const ctx = partnerCtx(t.partner.id, orgs);
    const auth = partnerAuth(t.partner.id, orgs);

    await expect(precedenceAs(ctx, auth, t.subject.id, { statementBudget: 8 })).resolves.toEqual({ capped: true });
    await expect(precedenceAs(ctx, auth, t.subject.id, { scanCap: 4 })).resolves.toEqual({ capped: true });
    await expect(precedenceAs(ctx, auth, t.subject.id, { scanCap: 5 })).resolves.toMatchObject({ capped: false });
  });

  it('answers null for a policy the caller context cannot read', async () => {
    const t = await seedTree();
    const other = await createPartner();
    const otherOrg = (await createOrganization({ partnerId: other.id, name: 'Cedar' }))!;
    await expect(
      precedenceAs(orgCtx(otherOrg.id, other.id), orgAuth(otherOrg.id, other.id), t.subject.id),
    ).resolves.toBeNull();
  });
});

/**
 * GET /:id/precedence through the REAL route (authMiddleware → requireScope →
 * requirePermission → the W03a read gate → computePolicyPrecedence) with
 * minted org-session tokens, on `breeze_app` under forced RLS.
 *
 * The subject is MSP-managed and applies to organizations A and B, with
 * competitors in both. An org-scope session of A is answered over A's devices
 * only; one of organization C (same partner, no target of the subject) is
 * refused by the read gate, not by RLS.
 */
describe('GET /configuration-policies/:id/precedence for an organization session', () => {
  afterAll(async () => {
    await shutdownPeripheralJobs();
    await shutdownPolicyEvaluationWorker();
    await closeRedis();
  });

  function buildApp(): Hono {
    const app = new Hono();
    app.route('/configuration-policies', configPolicyRoutes);
    return app;
  }

  function get(app: Hono, token: string, path: string) {
    return app.request(path, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  }

  const READ = [{ resource: 'devices', action: 'read' }];

  async function orgToken(partnerId: string, orgId: string) {
    const user = await createUser({ partnerId, orgId, email: `prec-o-${randomUUID().slice(0, 8)}@example.test` });
    const role = await createRole({ scope: 'organization', orgId, partnerId });
    await grantRolePermissions(role.id, READ);
    await assignUserToOrganization(user.id, orgId, role.id);
    // A real org session carries its org's partner (bindOrganizationSessionPartner).
    return createAccessToken({
      sub: user.id, email: user.email, roleId: role.id, scope: 'organization',
      orgId, partnerId, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
  }

  async function partnerToken(partnerId: string) {
    const user = await createUser({ partnerId, orgId: null, email: `prec-p-${randomUUID().slice(0, 8)}@example.test` });
    const role = await createRole({ scope: 'partner', partnerId });
    await grantRolePermissions(role.id, READ);
    await assignUserToPartner(user.id, partnerId, role.id, 'all');
    return createAccessToken({
      sub: user.id, email: user.email, roleId: role.id, scope: 'partner',
      orgId: null, partnerId, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
  }

  it("counts org A's devices only for an org A session, names nothing, and 404s an org the policy does not apply to", async () => {
    const app = buildApp();
    const t = await seedTree();
    // Same partner as the subject, with a device, and no target of the subject.
    const orgC = (await createOrganization({ partnerId: t.partner.id, name: 'Cedar' }))!;
    const siteC = (await createSite({ orgId: orgC.id, name: 'Cedar HQ' }))!;
    const c1 = await seedDevice(orgC.id, siteC.id);

    const orgA = await orgToken(t.partner.id, t.orgA.id);
    const msp = await partnerToken(t.partner.id);
    const path = `/configuration-policies/${t.subject.id}/precedence`;

    // A's devices only: a2 (patch, backup) and a3 (automation). B's devices and
    // the Birch patching win on them are not in the answer.
    const first = await get(app, orgA, path);
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(JSON.parse(firstText)).toEqual({
      capped: false,
      features: {
        patch: { reached: 3, outranked: 1 },
        automation: { reached: 3, outranked: 1 },
        backup: { reached: 3, outranked: 1 },
      },
    });

    // The partner sees A and B, so organization B really is in this policy's reach.
    const mspBefore = await get(app, msp, path);
    expect(mspBefore.status).toBe(200);
    expect(await mspBefore.json()).toEqual({
      capped: false,
      features: {
        patch: { reached: 5, outranked: 3 },
        automation: { reached: 5, outranked: 1 },
        backup: { reached: 5, outranked: 1 },
      },
    });

    // Org B only: a new device the subject reaches, and a site-level competitor
    // that beats the subject's org-B row for backup on every B device.
    const b3 = await seedDevice(t.orgB.id, t.siteB.id);
    const birchBackup = await seedPolicy(
      { orgId: t.orgB.id, partnerId: null },
      { name: 'Birch backup', status: 'active', features: ['backup'] },
    );
    await assign(birchBackup.id, 'site', t.siteB.id, 0, at(8));

    // The additions move the partner's numbers ...
    const mspAfter = await get(app, msp, path);
    expect(await mspAfter.json()).toEqual({
      capped: false,
      features: {
        patch: { reached: 6, outranked: 4 },
        automation: { reached: 6, outranked: 1 },
        backup: { reached: 6, outranked: 4 },
      },
    });
    // ... and change nothing in org A's answer.
    const second = await get(app, orgA, path);
    expect(second.status).toBe(200);
    const secondText = await second.text();
    expect(secondText).toBe(firstText);

    // Counts only: no policy, organization, site or device of any tenant, A's included.
    for (const body of [firstText, secondText]) {
      expect(Object.keys(JSON.parse(body)).sort()).toEqual(['capped', 'features']);
      for (const policy of [...t.competitors, birchBackup]) {
        expect(body).not.toContain(policy.id);
        expect(body).not.toContain(policy.name);
      }
      for (const id of [
        t.subject.id, t.partner.id, t.orgA.id, t.orgB.id, orgC.id, t.siteA1.id, t.siteA2.id, t.siteB.id, siteC.id,
        t.a1, t.a2, t.a3, t.b1, t.b2, b3, c1,
      ]) {
        expect(body).not.toContain(id);
      }
      for (const name of ['Acme', 'Birch', 'Cedar']) expect(body).not.toContain(name);
    }

    // Organization C is the subject's partner's but no target: the read gate
    // refuses it. Under RLS alone the count would run and answer zero, so the
    // 404 below is the gate's, not the database's.
    const underRlsAlone = await precedenceAs(orgCtx(orgC.id, t.partner.id), orgAuth(orgC.id, t.partner.id), t.subject.id);
    expect(underRlsAlone).toMatchObject({ capped: false, features: { patch: { reached: 0, outranked: 0 } } });
    const orgCToken = await orgToken(t.partner.id, orgC.id);
    const refused = await get(app, orgCToken, path);
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain(t.subject.id);
    expect((await get(app, orgCToken, `/configuration-policies/${t.subject.id}`)).status).toBe(404);
  });
});
