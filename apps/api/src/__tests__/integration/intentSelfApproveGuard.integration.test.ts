/**
 * Real-Postgres proof of the sole-operator self-approve guard (#2685).
 *
 * Four-eyes for a Tier-3 action intent used to be decided exactly ONCE, at
 * fan-out (`services/actionIntents/intentService.ts`), by branch mutual
 * exclusion: the multi-approver branch fans rows out to OTHER users, and only
 * the sole-operator branch ever creates a requester-owned row. The decide
 * handler then inferred "you were the only eligible approver" purely from
 * "a row exists that you own" (`linkedIntent.requestedByUserId === userId`)
 * plus an assurance >= L3 step-up. Since release is first-wins CAS, ANY future
 * fan-out regression that leaked a requester-owned row into a multi-approver
 * intent would have let the requester unilaterally release it, with no
 * server-side check catching it.
 *
 * This suite forges exactly that state — a genuine multi-approver intent with
 * a requester-owned `approval_requests` row inserted directly — and drives the
 * REAL decide route (real JWT + `authMiddleware` + `breeze_app` RLS) against
 * the test Postgres. `approvals.test.ts` mocks `../db` and
 * `resolveIntentApprovers` wholesale, so only a real-DB suite can prove the
 * resolver actually re-derives the live approver population (org members via
 * `organization_users` AND partner members via `partner_users`, which is
 * Shape-3 partner-axis RLS and invisible from an org-scoped context).
 *
 * Lives under `src/__tests__/integration/` so the directory-wide glob in
 * `vitest.integration.config.ts` (include) and `vitest.config.ts` (exclude)
 * both pick it up automatically — no dual hand-list edit to forget.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents, intentOutbox } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { PERMISSIONS } from '../../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { approvalRoutes } from '../../routes/approvals';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Real AuthContext for the requester acting on `orgId`, the same shape
 * authMiddleware produces (reuses `buildOrgAccessClosures` so org-access
 * semantics can't drift from the live path). Mirrors intentFanout's helper. */
function requesterAuth(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    user: { id: user.id, email: user.email, name: 'Requester', isPlatformAdmin: false },
    token: {
      sub: user.id,
      email: user.email,
      roleId,
      orgId,
      partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
}

/** A real org-scoped access token, minted the way db-utils.setupTestEnvironment
 * does (aep/mep = 1 matches the seeded row's default epochs; sid must be
 * non-empty for authMiddleware). */
async function accessTokenFor(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

interface Scenario {
  partnerId: string;
  orgId: string;
  orgRoleId: string;
  requester: { id: string; email: string };
  /** Second eligible approver — seeded only for the multi-approver scenario. */
  otherApprover: { id: string; email: string } | null;
}

/**
 * Seeds one org under one partner and a requester who HOLDS approvals:decide
 * (so they are genuinely in the eligible set — the guard must turn on whether
 * anyone ELSE is, not on the requester's own eligibility).
 *
 * `withSecondApprover` adds a partner-scope approver (`partner_users`,
 * org_access='all', NO organization_users row) — the CRITICAL-2 population
 * that only the real resolver, under a system context, can see.
 */
async function seedScenario(opts: { withSecondApprover: boolean }): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(orgRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@soleop.test`,
  });
  await assignUserToOrganization(requester.id, org.id, orgRole.id);

  let otherApprover: { id: string; email: string } | null = null;
  if (opts.withSecondApprover) {
    const partnerApprover = await createUser({
      partnerId: partner.id,
      orgId: null,
      email: `partner-approver-${randomUUID()}@soleop.test`,
    });
    await assignUserToPartner(partnerApprover.id, partner.id, partnerRole.id, 'all');
    otherApprover = { id: partnerApprover.id, email: partnerApprover.email };
  }

  return {
    partnerId: partner.id,
    orgId: org.id,
    orgRoleId: orgRole.id,
    requester: { id: requester.id, email: requester.email },
    otherApprover,
  };
}

/** Creates a Tier-3 intent as the requester. `execute_command` is a base
 * Tier-3 tool and createActionIntent never verifies the device exists (that
 * happens at release time), so a bare random UUID is fine (mirrors
 * intentFanout). */
async function createIntent(s: Scenario) {
  const auth = requesterAuth(s.requester, s.orgId, s.partnerId, s.orgRoleId);
  return createActionIntent(auth, {
    toolName: 'execute_command',
    input: { deviceId: randomUUID(), commandType: 'list_processes' },
    source: 'chat',
  });
}

/**
 * Forges the exact state a future fan-out regression would produce: a
 * requester-owned `approval_requests` row on a MULTI-approver intent. Cloned
 * from a real sibling row (so every NOT NULL column and the
 * approval_requests_one_source_chk source-exclusivity constraint are satisfied
 * exactly as the real fan-out satisfies them) with `user_id` swapped to the
 * requester. Inserted under system scope — Shape-6 user-scoped RLS would deny
 * a cross-user insert otherwise (42501).
 */
async function forgeRequesterOwnedRow(intentId: string, requesterId: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [sibling] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.intentId, intentId));
    if (!sibling) throw new Error('forge: no sibling approval row to clone');
    const { id: _ignoredId, ...rest } = sibling;
    const [forged] = await db
      .insert(approvalRequests)
      .values({ ...rest, userId: requesterId })
      .returning({ id: approvalRequests.id });
    if (!forged) throw new Error('forge: insert returned no row');
    return forged.id;
  });
}

async function decideViaRoute(
  s: Scenario,
  user: { id: string; email: string },
  approvalRowId: string,
  decision: 'approve' | 'deny',
): Promise<Response> {
  const token = await accessTokenFor(user, s.orgId, s.partnerId, s.orgRoleId);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/${decision}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(decision === 'deny' ? { reason: 'changed my mind' } : {}),
  });
}

describe('sole-operator self-approve guard — re-derived at decide time (#2685, real Postgres)', () => {
  runDb('refuses a self-approve on a MULTI-approver intent even when a requester-owned row is forced into existence', async () => {
    const s = await seedScenario({ withSecondApprover: true });
    const snapshot = await createIntent(s);

    // Sanity: the real fan-out is correct today — one row, to the OTHER
    // approver, never the requester. Without this the forge below could be
    // asserting against an already-broken fan-out.
    expect(snapshot.status).toBe('pending_approval');
    expect(snapshot.approvalRequestIds).toHaveLength(1);
    const fannedOut = await withSystemDbAccessContext(() =>
      db
        .select({ userId: approvalRequests.userId })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, snapshot.id)),
    );
    expect(fannedOut.map((r) => r.userId)).toEqual([s.otherApprover!.id]);

    // Now simulate the regression this guard exists for.
    const forgedRowId = await forgeRequesterOwnedRow(snapshot.id, s.requester.id);

    const res = await decideViaRoute(s, s.requester, forgedRowId, 'approve');

    // A distinguishable refusal, not a generic 403 — the client can explain it
    // and it is greppable in logs / audit details.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'not_sole_approver' });

    await withSystemDbAccessContext(async () => {
      // THE property: the intent was never released. On the pre-#2685 handler
      // this row is `approved` (the L3 gate is the only thing in the way, and
      // it is an assurance check, not a four-eyes check).
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, snapshot.id));
      expect(intent?.status).toBe('pending_approval');

      // No outbox row → the release worker never sees it.
      const outbox = await db
        .select({ id: intentOutbox.id })
        .from(intentOutbox)
        .where(and(eq(intentOutbox.intentId, snapshot.id), eq(intentOutbox.eventType, 'intent_approved')));
      expect(outbox).toHaveLength(0);

      // The refusal is BEFORE the CAS, so no approval row flipped — the real
      // approver's row is still decidable.
      const rows = await db
        .select({ id: approvalRequests.id, userId: approvalRequests.userId, status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, snapshot.id));
      expect(rows.every((r) => r.status === 'pending')).toBe(true);
      expect(rows.find((r) => r.userId === s.otherApprover!.id)?.status).toBe('pending');
    });
  });

  runDb('a genuinely SOLE-operator self-approve is not blocked by the guard (it reaches the L3 step-up gate)', async () => {
    // Only the requester holds approvals:decide in this org, so the real
    // fan-out takes the sole-operator branch. The guard must let this through;
    // the ONLY thing that stops the L1 session-tap approve is the pre-existing
    // assurance >= L3 step-up — proving the new check is not a blanket refusal
    // and that it is ordered BEFORE the assurance proof.
    const s = await seedScenario({ withSecondApprover: false });
    const snapshot = await createIntent(s);
    expect(snapshot.approvalRequestIds).toHaveLength(1);

    const [ownRow] = await withSystemDbAccessContext(() =>
      db
        .select({ id: approvalRequests.id, userId: approvalRequests.userId })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, snapshot.id)),
    );
    expect(ownRow?.userId).toBe(s.requester.id);

    const res = await decideViaRoute(s, s.requester, ownRow!.id, 'approve');
    expect(res.status).toBe(403);
    // step_up_required, NOT not_sole_approver.
    expect(await res.json()).toMatchObject({ error: 'step_up_required', requiredLevel: 3 });
  });

  runDb('a self-DENY is never blocked, even on a multi-approver intent', async () => {
    // Denying only cancels the action, so it must stay available in every
    // case — the guard is gated to `approved` only.
    const s = await seedScenario({ withSecondApprover: true });
    const snapshot = await createIntent(s);
    const forgedRowId = await forgeRequesterOwnedRow(snapshot.id, s.requester.id);

    const res = await decideViaRoute(s, s.requester, forgedRowId, 'deny');
    expect(res.status).toBe(200);

    await withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, snapshot.id));
      expect(intent?.status).toBe('rejected');
    });
  });
});
