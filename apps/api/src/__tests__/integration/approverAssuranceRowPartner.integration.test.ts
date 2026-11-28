/**
 * Real-Postgres proof that the approval-security policy applied to an approve
 * is the STRICTER of the session partner's and the partner that owns the
 * approval row's org.
 *
 * One identity holds memberships in two partners: an org in partner A (the
 * session's) and an org in partner B (where the supervised Tier 3 intent
 * lives, raised by the same person). The approve is driven through the real
 * route (real JWT + authMiddleware + breeze_app RLS) from the partner-A
 * session, with an empty body (a session tap) and a session that cleared MFA.
 *
 * Also pins the tenancy side of the lookup: under the caller's own org-scoped
 * RLS context, partner B's policy row is NOT readable (RLS unchanged); the
 * decide path reads it under a system context and only applies it.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { authenticatorPolicies } from '../../db/schema';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { isApprovalPolicySetEnforcing, loadApprovalPolicySet } from '../../services/approvalAssurancePolicy';
import { PERMISSIONS } from '../../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { approvalRoutes } from '../../routes/approvals';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Membership {
  partnerId: string;
  orgId: string;
  roleId: string;
}

interface Scenario {
  user: { id: string; email: string };
  /** Where the session is signed in. */
  a: Membership;
  /** Where the approval row's org lives. */
  b: Membership;
}

async function seedMembership(userId: string | null, partnerId: string): Promise<Membership> {
  const org = await createOrganization({ partnerId });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.DEVICES_EXECUTE]);
  if (userId) await assignUserToOrganization(userId, org.id, role.id);
  return { partnerId, orgId: org.id, roleId: role.id };
}

async function seedScenario(): Promise<Scenario> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const roleA = await createRole({ scope: 'organization', orgId: orgA.id });
  await grantRolePermissions(roleA.id, [PERMISSIONS.DEVICES_EXECUTE]);
  const user = await createUser({
    partnerId: partnerA.id,
    orgId: orgA.id,
    email: `two-partners-${randomUUID()}@rowpartner.test`,
  });
  await assignUserToOrganization(user.id, orgA.id, roleA.id);
  const b = await seedMembership(user.id, partnerB.id);
  return {
    user: { id: user.id, email: user.email },
    a: { partnerId: partnerA.id, orgId: orgA.id, roleId: roleA.id },
    b,
  };
}

function authIn(s: Scenario, m: Membership): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([m.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: s.user.id, email: s.user.email, name: 'Two Partners', isPlatformAdmin: false },
    token: {
      sub: s.user.id,
      email: s.user.email,
      roleId: m.roleId,
      orgId: m.orgId,
      partnerId: m.partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId: m.partnerId,
    orgId: m.orgId,
    scope: 'organization',
    accessibleOrgIds: [m.orgId],
    orgCondition,
    canAccessOrg,
  };
}

async function setPolicy(partnerId: string, requireEnrollment: boolean): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.insert(authenticatorPolicies).values({
      partnerId,
      requireEnrollment,
      floorOverrides: {},
      enforceFrom: requireEnrollment ? new Date('2000-01-01T00:00:00Z') : null,
    }),
  );
}

/** A supervised Tier 3 intent in partner B's org, raised by the scenario user. */
async function seedRowInB(s: Scenario): Promise<{ intentId: string; approvalRowId: string }> {
  const snapshot = await createActionIntent(authIn(s, s.b), {
    toolName: 'execute_command',
    input: { deviceId: randomUUID(), commandType: 'kill_process' },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  const approvalRowId = snapshot.requesterApprovalRequestId!;
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ riskTier: approvalRequests.riskTier }).from(approvalRequests).where(eq(approvalRequests.id, approvalRowId)),
  );
  expect(row?.riskTier).toBe('high');
  return { intentId: snapshot.id, approvalRowId };
}

/** Approve with an empty body (a session tap) from a session signed in to partner A. */
async function approveFromA(s: Scenario, approvalRowId: string): Promise<Response> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.user.id,
    email: s.user.email,
    roleId: s.a.roleId,
    orgId: s.a.orgId,
    partnerId: s.a.partnerId,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const token = await createAccessToken(payload);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function readDecision(approvalRowId: string, intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: approvalRequests.status, decidedAssuranceLevel: approvalRequests.decidedAssuranceLevel })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRowId));
    const [intent] = await db.select({ status: actionIntents.status }).from(actionIntents).where(eq(actionIntents.id, intentId));
    return { row, intent };
  });
}

let s: Scenario;

beforeEach(async () => {
  s = await seedScenario();
});

describe('approve from a partner-A session on a partner-B row', () => {
  runDb('A opted out, B enforcing: B’s floor applies — 403 step_up_required, nothing written', async () => {
    await setPolicy(s.a.partnerId, false);
    await setPolicy(s.b.partnerId, true);
    const { intentId, approvalRowId } = await seedRowInB(s);

    const res = await approveFromA(s, approvalRowId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', requiredLevel: 3 });

    const { row, intent } = await readDecision(approvalRowId, intentId);
    expect(row?.status).toBe('pending');
    expect(intent?.status).toBe('pending_approval');
  });

  runDb('A enforcing, B opted out: still the stricter one — 403 step_up_required', async () => {
    await setPolicy(s.a.partnerId, true);
    await setPolicy(s.b.partnerId, false);
    const { approvalRowId } = await seedRowInB(s);

    const res = await approveFromA(s, approvalRowId);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('step_up_required');
  });

  runDb('both opted out: allowed at L1 — a partner mismatch alone is never a refusal', async () => {
    await setPolicy(s.a.partnerId, false);
    await setPolicy(s.b.partnerId, false);
    const { intentId, approvalRowId } = await seedRowInB(s);

    const res = await approveFromA(s, approvalRowId);
    expect(res.status).toBe(200);

    const { row, intent } = await readDecision(approvalRowId, intentId);
    expect(row).toMatchObject({ status: 'approved', decidedAssuranceLevel: 1 });
    expect(intent?.status).toBe('approved');
  });
});

describe('the row partner policy lookup and RLS', () => {
  runDb("the caller's own RLS context cannot read B's policy; the decide-side lookup applies it", async () => {
    await setPolicy(s.a.partnerId, false);
    await setPolicy(s.b.partnerId, true);
    const callerContext = {
      scope: 'organization' as const,
      orgId: s.a.orgId,
      accessibleOrgIds: [s.a.orgId],
      accessiblePartnerIds: [],
      userId: s.user.id,
    };

    const visible = await withDbAccessContext(callerContext, () =>
      db.select().from(authenticatorPolicies).where(eq(authenticatorPolicies.partnerId, s.b.partnerId)),
    );
    expect(visible).toEqual([]);

    const policies = await withDbAccessContext(callerContext, () =>
      loadApprovalPolicySet({ sessionPartnerId: s.a.partnerId, rowOrgIds: [s.b.orgId] }),
    );
    expect(policies.map((p) => p?.partnerId ?? null).sort()).toEqual([s.a.partnerId, s.b.partnerId].sort());
    expect(isApprovalPolicySetEnforcing(policies, new Date(), 'high')).toBe(true);
  });
});
