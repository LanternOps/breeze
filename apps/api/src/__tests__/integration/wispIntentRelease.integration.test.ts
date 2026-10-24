/**
 * Wisp W04a — the delegation ceiling at DURABLE release of a chat-originated
 * action intent, against real Postgres.
 *
 * A Tier-3 call in a Wisp chat session becomes an action intent whose approval
 * can arrive after the inline wait budget. The durable worker
 * (`releaseApprovedIntent`) then executes it with no live chat session — so the
 * release itself must re-read the session's pinned grant and check the live
 * ceiling ("Wisp never exceeds its human", Wisp design §4). This suite drives
 * the REAL pipeline — `createActionIntent` (with the chat AI origin stamped, as
 * `withChatAiOrigin` does) → approve via `approvalRoutes` →
 * `releaseApprovedIntent` — and proves:
 *
 *   - control: a Wisp intent inside an active grant releases and the ticket moves;
 *   - the grant revoked AFTER approval → `failed:wisp_grant_inactive`, nothing
 *     executed, `wisp.ceiling_refused` audited;
 *   - a call the pinned ceiling forbids → `failed:wisp_ceiling_refused`;
 *   - an ordinary (non-Wisp) chat session releases exactly as before.
 *
 * Placement is load-bearing: `src/__tests__/integration/**` +
 * `.integration.test.ts` puts it in the blocking Integration Tests job.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { aiSessions, auditLogs, wispGrantRevisions, wispGrants } from '../../db/schema';
import { tickets } from '../../db/schema/portal';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { PERMISSIONS } from '../../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { attachSession, getOrCreateThread } from '../../services/wisp/threads';
import { approvalRoutes } from '../../routes/approvals';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
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

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const GRANT_KEYS = ['ai_sessions:use', 'tickets:read', 'tickets:write', 'organizations:write'];
const perm = (key: string) => {
  const [resource, action] = key.split(':') as [string, string];
  return { resource, action };
};

type Scenario = Awaited<ReturnType<typeof seed>>;

/**
 * Partner P → orgs A + B, a ticket in A. Grantor U (partner role holding the
 * grant keys, org_access 'all') is the requester; an org-A admin holding
 * `approvals:decide` is the (four-eyes) approver. Grant G is partner-wide with
 * a pinned revision; the chat session row is pinned to it and linked to G's
 * thread, exactly as `createSession` leaves it.
 */
async function seed(options: { deniedTools?: string[]; wisp?: boolean } = {}) {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });

  const grantorRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(grantorRole.id, GRANT_KEYS.map(perm));
  const grantor = await createUser({ partnerId: partner.id, orgId: null, email: `wisp-release-${randomUUID()}@wisp.test` });
  await assignUserToPartner(grantor.id, partner.id, grantorRole.id, 'all');

  const approverRole = await createRole({ scope: 'organization', orgId: orgA.id });
  await grantRolePermissions(approverRole.id, [PERMISSIONS.APPROVALS_DECIDE]);
  const approver = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `wisp-approver-${randomUUID()}@wisp.test` });
  await assignUserToOrganization(approver.id, orgA.id, approverRole.id);

  const [ticket] = await getTestDb()
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partner.id,
      ticketNumber: `WISP-REL-${randomUUID().slice(0, 8)}`,
      subject: 'wisp release ceiling',
      source: 'manual',
    })
    .returning();

  let pinned: { grantId: string; revisionId: string } | null = null;
  if (options.wisp !== false) {
    const snapshot: WispCeilingSnapshot = {
      version: 1,
      permissionKeys: GRANT_KEYS,
      orgIds: [orgA.id, orgB.id],
      siteIds: null,
      toolAllowlist: null,
      deniedTools: options.deniedTools ?? [],
      partnerWide: true,
    };
    pinned = await withSystemDbAccessContext(async () => {
      const [g] = await db.insert(wispGrants).values({
        partnerId: partner.id, orgId: null, grantorUserId: grantor.id,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      }).returning({ id: wispGrants.id });
      const [r] = await db.insert(wispGrantRevisions).values({
        grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
        factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
      }).returning({ id: wispGrantRevisions.id });
      await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
      return { grantId: g!.id, revisionId: r!.id };
    });
  }

  const sessionId = await withSystemDbAccessContext(async () => {
    const [s] = await db.insert(aiSessions).values({
      orgId: orgA.id, userId: grantor.id, model: 'claude-sonnet-5-5',
      ...(pinned ? { wispGrantId: pinned.grantId, wispGrantRevisionId: pinned.revisionId } : {}),
    }).returning({ id: aiSessions.id });
    return s!.id;
  });
  if (pinned) {
    const thread = await getOrCreateThread(pinned.grantId);
    await attachSession(thread.id, sessionId);
  }

  return {
    partnerId: partner.id,
    orgAId: orgA.id,
    orgBId: orgB.id,
    grantor: { id: grantor.id, email: grantor.email },
    grantorRoleId: grantorRole.id,
    approver: { id: approver.id, email: approver.email },
    approverRoleId: approverRole.id,
    ticketId: ticket!.id,
    pinned,
    sessionId,
  };
}

/** The grantor's partner-scope chat auth, carrying the chat AI origin the session stamps. */
function chatAuth(s: Scenario): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([s.orgAId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: s.grantor.id, email: s.grantor.email, name: 'Grantor', isPlatformAdmin: false },
    token: {
      sub: s.grantor.id, email: s.grantor.email, roleId: s.grantorRoleId, orgId: s.orgAId,
      partnerId: s.partnerId, scope: 'partner', type: 'access', mfa: true,
    },
    partnerId: s.partnerId,
    orgId: s.orgAId,
    scope: 'partner',
    accessibleOrgIds: [s.orgAId],
    orgCondition,
    canAccessOrg,
    aiOrigin: { kind: 'ai_assistant', sessionId: s.sessionId },
  } as AuthContext;
}

async function createApprovedMoveOrgIntent(s: Scenario): Promise<string> {
  const snapshot = await createActionIntent(chatAuth(s), {
    toolName: 'manage_tickets',
    input: { action: 'move_org', ticketId: s.ticketId, targetOrgId: s.orgBId },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');

  const [approvalRow] = await withSystemDbAccessContext(() =>
    db.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.intentId, snapshot.id)));
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.approver.id, email: s.approver.email, roleId: s.approverRoleId, orgId: s.orgAId,
    partnerId: s.partnerId, scope: 'organization', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  };
  const token = await createAccessToken(payload);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  const res = await app.request(`/approvals/${approvalRow!.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);

  const intent = await readIntent(snapshot.id);
  expect(intent.status).toBe('approved');
  expect(intent.aiOriginSessionId).toBe(s.sessionId);
  return snapshot.id;
}

async function readIntent(intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row!;
  });
}

async function readTicketOrgId(ticketId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId)).limit(1));
  return row!.orgId;
}

/** writeAuditEvent is fire-and-forget: poll briefly for the row. */
async function waitForAudit(intentId: string, action: string) {
  for (let i = 0; i < 40; i++) {
    const rows = await getTestDb().select().from(auditLogs)
      .where(and(eq(auditLogs.resourceId, intentId), eq(auditLogs.action, action)));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

describe('durable release of a Wisp chat intent re-checks the delegation ceiling (real Postgres)', () => {
  runDb('control: inside an active grant the approved intent releases and the ticket moves', async () => {
    const s = await seed();
    const intentId = await createApprovedMoveOrgIntent(s);

    await releaseApprovedIntent(intentId);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('completed');
    expect(intent.errorCode).toBeNull();
    expect(await readTicketOrgId(s.ticketId)).toBe(s.orgBId);
  });

  runDb('the grant revoked after approval: the release refuses with wisp_grant_inactive and nothing executes', async () => {
    const s = await seed();
    const intentId = await createApprovedMoveOrgIntent(s);

    await withSystemDbAccessContext(() =>
      db.update(wispGrants).set({ status: 'revoked', revokedAt: new Date() }).where(eq(wispGrants.id, s.pinned!.grantId)));

    await releaseApprovedIntent(intentId);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('wisp_grant_inactive');
    expect(intent.executedAt).toBeNull();
    expect(await readTicketOrgId(s.ticketId)).toBe(s.orgAId);

    const refusals = await waitForAudit(intentId, 'wisp.ceiling_refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.details).toMatchObject({ code: 'wisp_grant_inactive', grantId: s.pinned!.grantId, phase: 'release' });
  });

  runDb('a call the pinned ceiling forbids refuses with wisp_ceiling_refused', async () => {
    const s = await seed({ deniedTools: ['manage_tickets'] });
    const intentId = await createApprovedMoveOrgIntent(s);

    await releaseApprovedIntent(intentId);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('wisp_ceiling_refused');
    expect(await readTicketOrgId(s.ticketId)).toBe(s.orgAId);
  });

  runDb('an ordinary (non-Wisp) chat session releases exactly as before', async () => {
    const s = await seed({ wisp: false });
    const intentId = await createApprovedMoveOrgIntent(s);

    await releaseApprovedIntent(intentId);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('completed');
    expect(await readTicketOrgId(s.ticketId)).toBe(s.orgBId);
  });
});
