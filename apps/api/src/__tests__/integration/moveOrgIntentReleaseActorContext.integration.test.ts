/**
 * Real-Postgres end-to-end coverage for #4650: the AI `move_org` ticket tool
 * was structurally unreachable because BOTH release-time actor-context
 * rebuild paths (`services/actionIntents/actorContext.ts`) pinned
 * `accessibleOrgIds` to the intent's single (source) org — so
 * `aiToolsTicketing.ts`'s `auth.canAccessOrg(targetOrgId)` gate always 403'd,
 * for every approved `move_org` intent, regardless of the requester's real
 * access.
 *
 * The fix (`resolveTenantMutationTargetOrgId` + a small allowlist in
 * `actorContext.ts`) widens `accessibleOrgIds` to also cover the TARGET org
 * recorded on the intent's immutable `arguments` snapshot at creation time —
 * but ONLY for allowlisted tool/action pairs, and ONLY when the releasing
 * identity's own (re-verified, real-time) access already covers that target.
 *
 * This file proves the three properties the fix must hold, driving the REAL
 * pipeline (`createActionIntent` -> approve via `approvalRoutes` ->
 * `releaseApprovedIntent`, the exact function the durable worker's job
 * processor calls — no BullMQ needed), same pattern as
 * `intentSupervisedFourEyes.integration.test.ts`:
 *
 *   (a) an approved `move_org` intent, requested by a partner-scope user
 *       whose partner grants org_access='all', actually RELEASES: the tool
 *       executes, the ticket's `org_id` really changes in Postgres, and the
 *       intent lands `completed`.
 *   (b) the widening is allowlist-scoped, not generic: a DIFFERENT
 *       `manage_tickets` action (`assign`) whose stored arguments happen to
 *       carry a same-named `targetOrgId` field never gets accessibleOrgIds
 *       widened, proven directly against the real `buildAuthContextForIntent`
 *       function (no mocks) reading a real `action_intents` row.
 *   (c) a requester whose partner grants only `orgAccess: 'selected'`
 *       covering the SOURCE org, not the recorded target, still gets 403'd —
 *       now via the tool's own `auth.canAccessOrg(targetOrgId)` gate (the
 *       CORRECT reason), landing the intent `failed:tool_returned_error`,
 *       never `actor_invalid` and never a silent success.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { partnerUsers } from '../../db/schema/users';
import { tickets } from '../../db/schema/portal';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildAuthContextForIntent } from '../../services/actionIntents/actorContext';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { PERMISSIONS } from '../../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { approvalRoutes } from '../../routes/approvals';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const TOOL_NAME = 'manage_tickets';

/** Unique-ifier for ticket numbers within the same test run. */
function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Real PARTNER-scope AuthContext, same shape a live request would carry
 * (reuses `buildOrgAccessClosures`, mirroring the sibling suites' `orgAuth`
 * helper). `orgId` is pinned to the SOURCE org — same as a real partner-scope
 * session that is currently "in" one org — so `resolveWritableToolOrgId`
 * resolves the intent to that org without needing an explicit `input.orgId`.
 */
function partnerAuth(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Test User', isPlatformAdmin: false },
    token: {
      sub: user.id,
      email: user.email,
      roleId,
      orgId,
      partnerId,
      scope: 'partner',
      type: 'access',
      mfa: true,
    },
    partnerId,
    orgId,
    scope: 'partner',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
}

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
  orgAId: string;
  orgBId: string;
  requester: { id: string; email: string };
  requesterRoleId: string;
  approver: { id: string; email: string };
  approverRoleId: string;
  ticketId: string;
}

/**
 * Seeds partner P -> orgA (source) + orgB (target), a ticket in orgA, a
 * partner-scope requester (holds `tickets:write` via a partner role — the
 * RBAC entry `TOOL_PERMISSIONS.manage_tickets.move_org` maps to, needed for
 * both the create-path and the release worker's requester-RBAC
 * revalidation), and an ORG-scoped admin of orgA holding `approvals:decide`
 * (the four_eyes approver — deliberately a DIFFERENT axis from the
 * requester, same as the sibling suite's two-admin pattern).
 *
 * `orgAccess` on the requester's partner membership is the parameter under
 * test: 'all' lets the widening apply (scenario a); 'selected' covering only
 * orgA does not (scenario c).
 */
async function seedScenario(orgAccess: 'all' | 'selected'): Promise<Scenario> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });

  const requesterRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(requesterRole.id, [PERMISSIONS.TICKETS_WRITE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: null,
    email: `requester-${randomUUID()}@moveOrg4650.test`,
  });
  const assignment = await assignUserToPartner(requester.id, partner.id, requesterRole.id, orgAccess);
  if (orgAccess === 'selected') {
    await getTestDb()
      .update(partnerUsers)
      .set({ orgIds: [orgA.id] })
      .where(eq(partnerUsers.id, assignment.id));
  }

  const approverRole = await createRole({ scope: 'organization', orgId: orgA.id });
  await grantRolePermissions(approverRole.id, [PERMISSIONS.APPROVALS_DECIDE]);
  const approver = await createUser({
    partnerId: partner.id,
    orgId: orgA.id,
    email: `approver-${randomUUID()}@moveOrg4650.test`,
  });
  await assignUserToOrganization(approver.id, orgA.id, approverRole.id);

  const unique = uid();
  const [ticket] = await getTestDb()
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partner.id,
      ticketNumber: `MO4650-${unique}`,
      subject: `move_org release test ${unique}`,
      source: 'manual',
    })
    .returning();

  return {
    partnerId: partner.id,
    orgAId: orgA.id,
    orgBId: orgB.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: requesterRole.id,
    approver: { id: approver.id, email: approver.email },
    approverRoleId: approverRole.id,
    ticketId: ticket!.id,
  };
}

async function createMoveOrgIntent(
  s: Scenario,
  targetOrgId: string,
): Promise<{ intentId: string; approvalRequestIds: string[] }> {
  const auth = partnerAuth(s.requester, s.orgAId, s.partnerId, s.requesterRoleId);
  const snapshot = await createActionIntent(auth, {
    toolName: TOOL_NAME,
    input: { action: 'move_org', ticketId: s.ticketId, targetOrgId },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  return { intentId: snapshot.id, approvalRequestIds: snapshot.approvalRequestIds };
}

async function approveViaRoute(
  approver: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
  approvalRowId: string,
): Promise<Response> {
  const token = await accessTokenFor(approver, orgId, partnerId, roleId);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function soleApprovalRowFor(intentId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.intentId, intentId)),
  );
  expect(row).toBeTruthy();
  return row!.id;
}

async function readIntent(intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row!;
  });
}

async function readTicketOrgId(ticketId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId)).limit(1),
  );
  return row!.orgId;
}

describe('#4650 move_org action-intent release: real-Postgres end-to-end coverage', () => {
  runDb(
    '(a) approved move_org releases cross-org: requester with partner orgAccess=all -> ticket really moves, intent completes',
    async () => {
      const s = await seedScenario('all');
      const { intentId } = await createMoveOrgIntent(s, s.orgBId);

      const approvalRowId = await soleApprovalRowFor(intentId);
      const res = await approveViaRoute(s.approver, s.orgAId, s.partnerId, s.approverRoleId, approvalRowId);
      expect(res.status).toBe(200);

      const approvedIntent = await readIntent(intentId);
      expect(approvedIntent.status).toBe('approved');

      await releaseApprovedIntent(intentId);

      const executedIntent = await readIntent(intentId);
      expect(executedIntent.status).toBe('completed');
      expect(executedIntent.errorCode).toBeNull();

      // The real, load-bearing assertion: the ticket's org_id genuinely
      // changed in Postgres — this is the tool's actual side effect, not
      // just an accessibleOrgIds check in isolation.
      expect(await readTicketOrgId(s.ticketId)).toBe(s.orgBId);
    },
  );

  runDb(
    '(c) requester with partner orgAccess=selected (source org only) is still refused — via the TOOL gate, not actor_invalid',
    async () => {
      const s = await seedScenario('selected');
      const { intentId } = await createMoveOrgIntent(s, s.orgBId);

      const approvalRowId = await soleApprovalRowFor(intentId);
      const res = await approveViaRoute(s.approver, s.orgAId, s.partnerId, s.approverRoleId, approvalRowId);
      expect(res.status).toBe(200);

      await releaseApprovedIntent(intentId);

      const executedIntent = await readIntent(intentId);
      // Refused for the RIGHT reason (issue #4650's own diagnosis): the tool
      // returned an error body, not a thrown/actor_invalid failure — the
      // requester's own re-verified permissions genuinely don't cover the
      // target org, so accessibleOrgIds correctly stayed single-org and the
      // tool's `canAccessOrg(targetOrgId)` gate 403'd it.
      expect(executedIntent.status).toBe('failed');
      expect(executedIntent.errorCode).toBe('tool_returned_error');
      expect(JSON.stringify(executedIntent.result)).toContain('Access to target organization denied');

      // And, unlike the pre-fix bug, this is a genuine access decision, not a
      // structural one: the ticket never moved.
      expect(await readTicketOrgId(s.ticketId)).toBe(s.orgAId);
    },
  );

  runDb(
    '(b) the widening is allowlist-scoped: a DIFFERENT manage_tickets action carrying a same-shaped targetOrgId argument is never widened',
    async () => {
      // Same requester population as scenario (a) — orgAccess='all' would
      // trivially satisfy the widening's own access bound if the allowlist
      // keying were broken (e.g. matching on argument NAME instead of the
      // tool/action pair), which is exactly the regression this proves.
      const s = await seedScenario('all');

      const now = new Date();
      const [intentRow] = await withSystemDbAccessContext(() =>
        db
          .insert(actionIntents)
          .values({
            orgId: s.orgAId,
            partnerId: s.partnerId,
            requestedByUserId: s.requester.id,
            source: 'chat',
            originPrincipalKind: 'user_session',
            actionName: TOOL_NAME,
            // 'assign' is a real manage_tickets action (TOOL_PERMISSIONS,
            // aiGuardrails.ts) that is NOT in the #4650 allowlist — only
            // `move_org` is. It carries a `targetOrgId`-named argument on
            // purpose: if the widening ever keyed off argument NAME instead
            // of the (tool, action) pair, this would incorrectly widen too.
            arguments: { action: 'assign', ticketId: s.ticketId, targetOrgId: s.orgBId },
            argumentDigest: 'digest-4650-nonallowlisted',
            targetSummary: 'manage_tickets:assign (non-allowlisted, #4650 regression guard)',
            impactSummary: 'Assigns a ticket',
            riskTier: 3,
            idempotencyKey: `idem-4650-${randomUUID()}`,
            correlationId: randomUUID(),
            status: 'executing',
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          })
          .returning(),
      );

      const auth = await buildAuthContextForIntent(intentRow as ActionIntent);

      expect(auth).not.toBeNull();
      expect(auth!.accessibleOrgIds).toEqual([s.orgAId]);
      expect(auth!.canAccessOrg(s.orgBId)).toBe(false);
    },
  );
});
