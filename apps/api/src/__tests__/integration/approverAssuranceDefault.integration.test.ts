/**
 * Real-Postgres proof of the approver-assurance platform default on the
 * direct API decide path: `POST /approvals/:id/approve` with an empty body
 * (no proof — a session tap) on a HIGH-risk request.
 *
 * - Partner with no policy row, or a row whose enforcement choice is blank
 *   (require_enrollment NULL), after the platform date → 403
 *   step_up_required at the L3 floor, and nothing is written.
 * - The same partner before the platform date → 200 at L1 (session tap).
 * - Partner with an explicit "not required" row after the platform date →
 *   200 at L1: an explicit choice is respected.
 *
 * The web client posts to the same route (the `/mobile/approvals` mount of
 * this router), so this is the enforcement point for both surfaces. Drives
 * the real route (real JWT + authMiddleware + breeze_app RLS) with a
 * supervised Tier-3 `execute_command` intent decided by its requester — the
 * approval shape seen in production at L1.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { authenticatorPolicies } from '../../db/schema';
import { createActionIntent } from '../../services/actionIntents/intentService';
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

const PAST = '2000-01-01T00:00:00Z';
const FUTURE = '2999-01-01T00:00:00Z';

interface Scenario {
  partnerId: string;
  orgId: string;
  requester: { id: string; email: string };
  roleId: string;
}

function requesterAuth(s: Scenario): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([s.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: s.requester.id, email: s.requester.email, name: 'Requester', isPlatformAdmin: false },
    token: {
      sub: s.requester.id,
      email: s.requester.email,
      roleId: s.roleId,
      orgId: s.orgId,
      partnerId: s.partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId: s.partnerId,
    orgId: s.orgId,
    scope: 'organization',
    accessibleOrgIds: [s.orgId],
    orgCondition,
    canAccessOrg,
  };
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.DEVICES_EXECUTE]);
  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@approverassurance.test`,
  });
  await assignUserToOrganization(requester.id, org.id, role.id);
  return { partnerId: partner.id, orgId: org.id, requester: { id: requester.id, email: requester.email }, roleId: role.id };
}

async function setPolicy(partnerId: string, requireEnrollment: boolean | null): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.insert(authenticatorPolicies).values({ partnerId, requireEnrollment, floorOverrides: {}, enforceFrom: null }),
  );
}

async function seedHighRiskSupervisedIntent(s: Scenario): Promise<{ intentId: string; approvalRowId: string }> {
  const snapshot = await createActionIntent(requesterAuth(s), {
    toolName: 'execute_command',
    input: { deviceId: randomUUID(), commandType: 'kill_process' },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  const approvalRowId = snapshot.requesterApprovalRequestId!;
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ riskTier: approvalRequests.riskTier })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRowId)),
  );
  expect(row?.riskTier).toBe('high');
  return { intentId: snapshot.id, approvalRowId };
}

async function approveWithEmptyBody(s: Scenario, approvalRowId: string): Promise<Response> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.requester.id,
    email: s.requester.email,
    roleId: s.roleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa: false,
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
      .select({
        status: approvalRequests.status,
        decidedAssuranceLevel: approvalRequests.decidedAssuranceLevel,
        decidedVia: approvalRequests.decidedVia,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRowId));
    const [intent] = await db
      .select({ status: actionIntents.status })
      .from(actionIntents)
      .where(eq(actionIntents.id, intentId));
    return { row, intent };
  });
}

const originalDefaultFrom = process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
let s: Scenario;

beforeEach(async () => {
  s = await seedScenario();
});

afterEach(() => {
  if (originalDefaultFrom === undefined) delete process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
  else process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = originalDefaultFrom;
});

describe('authenticator_policies.require_enrollment', () => {
  runDb('is nullable with no default, so a blank choice stays blank', async () => {
    const rows = await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'authenticator_policies' AND column_name = 'require_enrollment'
      `),
    );
    expect([...rows]).toEqual([{ is_nullable: 'YES', column_default: null }]);
  });
});

describe('approver assurance platform default — POST /approvals/:id/approve with {} on a high-risk request', () => {
  runDb('no policy row, after the platform date: refused 403 step_up_required at L3, nothing written', async () => {
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = PAST;
    const { intentId, approvalRowId } = await seedHighRiskSupervisedIntent(s);

    const res = await approveWithEmptyBody(s, approvalRowId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', requiredLevel: 3 });

    const { row, intent } = await readDecision(approvalRowId, intentId);
    expect(row?.status).toBe('pending');
    expect(intent?.status).toBe('pending_approval');
  });

  runDb('a row with a blank enforcement choice, after the platform date: also refused', async () => {
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = PAST;
    await setPolicy(s.partnerId, null);
    const { approvalRowId } = await seedHighRiskSupervisedIntent(s);

    const res = await approveWithEmptyBody(s, approvalRowId);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('step_up_required');
  });

  runDb('no policy row, before the platform date: accepted at L1 (session tap)', async () => {
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = FUTURE;
    const { intentId, approvalRowId } = await seedHighRiskSupervisedIntent(s);

    const res = await approveWithEmptyBody(s, approvalRowId);
    expect(res.status).toBe(200);

    const { row, intent } = await readDecision(approvalRowId, intentId);
    expect(row).toMatchObject({ status: 'approved', decidedAssuranceLevel: 1, decidedVia: 'session_tap' });
    expect(intent?.status).toBe('approved');
  });

  runDb('explicit "not required" policy, after the platform date: still accepted at L1', async () => {
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = PAST;
    await setPolicy(s.partnerId, false);
    const { intentId, approvalRowId } = await seedHighRiskSupervisedIntent(s);

    const res = await approveWithEmptyBody(s, approvalRowId);
    expect(res.status).toBe(200);

    const { row, intent } = await readDecision(approvalRowId, intentId);
    expect(row).toMatchObject({ status: 'approved', decidedAssuranceLevel: 1, decidedVia: 'session_tap' });
    expect(intent?.status).toBe('approved');
  });
});
