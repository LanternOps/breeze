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
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

// Required for the agent-owned scenario below: checkAgentGuardrails
// (aiGuardrails.ts) denies every agent proposal outright when this env flag
// is off, same precedent as aiAgentTicketTriage.integration.test.ts.
vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { partnerUsers } from '../../db/schema/users';
import { tickets } from '../../db/schema/portal';
import { aiAgents, aiAgentRuns } from '../../db/schema/aiAgents';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildAuthContextForIntent } from '../../services/actionIntents/actorContext';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
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

  runDb(
    "(d) orgAccess='all' does not widen into a target org under a DIFFERENT partner — independent tenancy check, not permsCanAccessOrg alone",
    async () => {
      // permsCanAccessOrg('all') returns true for ANY org id — it never
      // checks tenancy. This proves the widening's SECOND, independent
      // check (the recorded target org's live partnerId vs intent.partnerId)
      // actually runs against real Postgres, not just the mocked unit test.
      const s = await seedScenario('all');
      const otherPartner = await createPartner();
      const orgC = await createOrganization({ partnerId: otherPartner.id }); // different partner than s.partnerId

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
            arguments: { action: 'move_org', ticketId: s.ticketId, targetOrgId: orgC.id },
            argumentDigest: 'digest-4650-cross-partner',
            targetSummary: 'manage_tickets:move_org (cross-partner target, #4650 regression guard)',
            impactSummary: 'Moves a ticket to another organization',
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
      expect(auth!.canAccessOrg(orgC.id)).toBe(false);
    },
  );
});

/**
 * Agent-owned release: the SAME allowlisted widening, but for a `move_org`
 * intent originated by an `ai_agent` principal (`requestingAgentRunId` set)
 * rather than a human requester — the pipeline `buildAgentOwnedAuthContext`
 * rebuilds, not `buildUserOwnedAuthContext`. Separate `describe` because the
 * fixtures (a real `ai_agents` + `ai_agent_runs` row) are shaped differently
 * from the human-requester scenario above.
 *
 * `manage_tickets` mutates from a DEVICE-LESS run, so `checkAgentGuardrails`
 * (aiGuardrails.ts) would deny it as unbound UNLESS the intent carries an
 * explicit ticket scope (`scope: { ticketId }`, the P2-4 carve-out) — that is
 * threaded through `createActionIntent`'s `input.scope` below.
 */
interface AgentScenario {
  partnerId: string;
  orgAId: string;
  orgBId: string;
  agentId: string;
  runId: string;
  approver: { id: string; email: string };
  approverRoleId: string;
  ticketId: string;
}

async function seedAgentScenario(): Promise<AgentScenario> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });

  const approverRole = await createRole({ scope: 'organization', orgId: orgA.id });
  await grantRolePermissions(approverRole.id, [PERMISSIONS.APPROVALS_DECIDE]);
  const approver = await createUser({
    partnerId: partner.id,
    orgId: orgA.id,
    email: `agent-approver-${randomUUID()}@moveOrg4650.test`,
  });
  await assignUserToOrganization(approver.id, orgA.id, approverRole.id);

  const unique = uid();
  const [ticket] = await getTestDb()
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partner.id,
      ticketNumber: `MO4650AGT-${unique}`,
      subject: `agent move_org release test ${unique}`,
      source: 'manual',
    })
    .returning();

  // PARTNER-scoped agent (orgId: null) — an org-scoped agent's home IS a
  // single org and is never eligible for the widening (proven at the unit
  // level); the release-pipeline gap this closes is specifically the
  // partner-scoped, cross-org-eligible case.
  const [agent] = await getTestDb()
    .insert(aiAgents)
    .values({
      partnerId: partner.id,
      orgId: null,
      kind: 'helpdesk',
      name: 'Test Ticket Agent',
      enabled: true,
      mode: 'shadow',
      toolAllowlist: ['manage_tickets'],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {},
      triggers: {},
      recipients: { userIds: [], roleIds: [] },
      createdBy: approver.id,
    })
    .returning();

  const policySnapshot = {
    effective: {
      enabled: true,
      mode: 'shadow',
      toolAllowlist: ['manage_tickets'],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {},
      triggers: {},
    },
  };

  const [run] = await getTestDb()
    .insert(aiAgentRuns)
    .values({
      agentId: agent!.id,
      orgId: orgA.id,
      deviceId: null,
      ticketId: ticket!.id,
      triggerKind: 'ticket',
      dedupeKey: `agent-move-org-4650-${randomUUID()}`,
      modeAtStart: 'shadow',
      policySnapshot: policySnapshot as never,
    })
    .returning();

  return {
    partnerId: partner.id,
    orgAId: orgA.id,
    orgBId: orgB.id,
    agentId: agent!.id,
    runId: run!.id,
    approver: { id: approver.id, email: approver.email },
    approverRoleId: approverRole.id,
    ticketId: ticket!.id,
  };
}

async function createAgentMoveOrgIntent(
  s: AgentScenario,
  targetOrgId: string,
): Promise<{ intentId: string; approvalRequestIds: string[] }> {
  const auth = buildAgentAuthContext(
    { id: s.agentId, orgId: null, partnerId: s.partnerId, name: 'Test Ticket Agent', kind: 'helpdesk' },
    { id: s.runId, orgId: s.orgAId, deviceId: null },
    { id: s.orgAId, partnerId: s.partnerId },
  );
  const snapshot = await createActionIntent(auth, {
    toolName: TOOL_NAME,
    input: { action: 'move_org', ticketId: s.ticketId, targetOrgId },
    source: 'ai_agent',
    scope: { ticketId: s.ticketId },
  });
  expect(snapshot.status).toBe('pending_approval');
  return { intentId: snapshot.id, approvalRequestIds: snapshot.approvalRequestIds };
}

describe('#4650 move_org action-intent release (agent-owned): real-Postgres end-to-end coverage', () => {
  runDb(
    '(e) an approved agent-owned move_org intent widens accessibleOrgIds cross-org when rebuilt for release (partner-scoped agent, same-partner target)',
    async () => {
      // Drives the REAL creation + four-eyes approval pipeline (createActionIntent
      // -> approvalRoutes decide), then calls the exact release-time function,
      // buildAuthContextForIntent, against the resulting real, approved
      // action_intents row (real aiAgents/aiAgentRuns/organizations reads, no
      // mocks) — proving buildAgentOwnedAuthContext's widening end-to-end for a
      // genuinely approved agent-owned intent.
      //
      // Deliberately stops at the rebuilt AuthContext rather than also calling
      // `releaseApprovedIntent` through to tool execution: doing so surfaced a
      // SEPARATE, pre-existing bug unrelated to accessibleOrgIds — `moveTicketOrg`'s
      // "moved" system-comment insert (ticketService.ts) writes `actor.userId`
      // (== `auth.user.id`, the agent's synthetic id for an ai_agent principal,
      // per `agentRunIdFrom`'s doc comment in aiToolsTicketing.ts) into
      // `ticket_comments.user_id`, which is not a real `users` row and violates
      // that table's RLS/FK — every OTHER manage_tickets action routes an
      // ai_agent principal through a dedicated AI-safe executor instead of the
      // shared human-actor ticketService functions; `move_org` does not. This
      // was unreachable before #4650 (accessibleOrgIds always 403'd first) and
      // needs its own fix/design decision — tracked separately, not fixed here.
      const s = await seedAgentScenario();
      const { intentId } = await createAgentMoveOrgIntent(s, s.orgBId);

      const approvalRowId = await soleApprovalRowFor(intentId);
      const res = await approveViaRoute(s.approver, s.orgAId, s.partnerId, s.approverRoleId, approvalRowId);
      expect(res.status).toBe(200);

      const approvedIntent = await readIntent(intentId);
      expect(approvedIntent.status).toBe('approved');

      const auth = await buildAuthContextForIntent(approvedIntent as ActionIntent);

      expect(auth).not.toBeNull();
      expect(auth!.accessibleOrgIds).toEqual([s.orgAId, s.orgBId]);
      expect(auth!.canAccessOrg(s.orgAId)).toBe(true);
      expect(auth!.canAccessOrg(s.orgBId)).toBe(true);
      expect(auth!.principal).toEqual({ kind: 'ai_agent', agentId: s.agentId, runId: s.runId });
    },
  );

  runDb(
    '(f) does NOT widen an approved agent-owned move_org intent whose recorded target belongs to a DIFFERENT partner than the agent',
    async () => {
      const s = await seedAgentScenario();
      const otherPartner = await createPartner();
      const orgC = await createOrganization({ partnerId: otherPartner.id });
      const { intentId } = await createAgentMoveOrgIntent(s, orgC.id);

      const approvalRowId = await soleApprovalRowFor(intentId);
      const res = await approveViaRoute(s.approver, s.orgAId, s.partnerId, s.approverRoleId, approvalRowId);
      expect(res.status).toBe(200);

      const approvedIntent = await readIntent(intentId);
      const auth = await buildAuthContextForIntent(approvedIntent as ActionIntent);

      expect(auth).not.toBeNull();
      expect(auth!.accessibleOrgIds).toEqual([s.orgAId]);
      expect(auth!.canAccessOrg(orgC.id)).toBe(false);
    },
  );
});
