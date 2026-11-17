/**
 * #12098 — a Tier-3 intent decided in the last seconds before its approval
 * deadline (real Postgres, breeze_app, real approve/deny route, real release
 * worker; only the outbound Google call is faked).
 *
 * The chat path (`aiAgentSdk.ts`, Tier-3 branch) waits with
 * `waitForIntentDecision`, which polls and sleeps. Before #12098 it did no
 * read after its last sleep, so a decision landing in that sleep came back as
 * `pending_approval`; once the deadline had passed the chat told the model
 * "expired, not executed, re-issue it" while the release worker still ran the
 * approved intent (its claim checks `release_by`, not the approval deadline).
 *
 * The fix has two halves, both proven here:
 *  1. `waitForIntentDecision` reads once more after the loop, so a decision
 *     made during the last sleep is returned.
 *  2. `closeOutUndecidedIntent` is the one place the chat may call an intent
 *     expired: a conditional `pending_approval -> expired` (one statement) with
 *     the reaper's side effects in the same transaction. It either wins (the
 *     intent is expired for good: no approve, no release) or loses to a
 *     decision and returns that decision from a fresh read.
 *
 * Under `src/__tests__/integration/**`, so covered by the integration config's
 * shared glob and excluded from the unit runner.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

const h = vi.hoisted(() => {
  const usersUpdate = vi.fn(async () => ({ data: {} }));
  return { usersUpdate };
});

vi.mock('../../services/googleClient', () => ({
  getDirectoryClient: vi.fn(() => ({
    users: { update: h.usersUpdate, get: vi.fn() },
    members: {},
    groups: {},
    mobiledevices: {},
  })),
  getGmailClient: vi.fn(() => ({})),
  getCalendarClient: vi.fn(() => ({})),
  getLicensingClient: vi.fn(() => ({})),
  normalizeGoogleError: (err: unknown) => ({
    code: 'google_error',
    message: err instanceof Error ? err.message : String(err),
  }),
  GoogleApiError: class GoogleApiError extends Error {},
}));

import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { actionIntents, intentOutbox } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { auditLogs } from '../../db/schema/audit';
import { googleWorkspaceConnections } from '../../db/schema/google';
import { encryptSecret } from '../../services/secretCrypto';
import {
  createActionIntent,
  transitionIntent,
  waitForIntentDecision,
} from '../../services/actionIntents/intentService';
import { closeOutUndecidedIntent } from '../../services/actionIntents/intentExpiry';
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
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// TIER3_FOUR_EYES and headless-executable: a real release-worker path whose
// only fake is the outbound Google call, so "executed" is countable.
const TOOL_NAME = 'google_suspend_user';
const GOOGLE_EXECUTE = { resource: 'organizations', action: 'write' } as const;

function orgAuth(
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
  requester: { id: string; email: string };
  requesterRoleId: string;
  admin: { id: string; email: string };
  adminRoleId: string;
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const requesterRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(requesterRole.id, [GOOGLE_EXECUTE]);
  const adminRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(adminRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@deadline-race.test`,
  });
  await assignUserToOrganization(requester.id, org.id, requesterRole.id);
  const admin = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `admin-${randomUUID()}@deadline-race.test`,
  });
  await assignUserToOrganization(admin.id, org.id, adminRole.id);

  await getTestDb()
    .insert(googleWorkspaceConnections)
    .values({
      orgId: org.id,
      customerDomain: 'customer.example',
      adminEmail: 'admin@customer.example',
      serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com',
      serviceAccountKey: encryptSecret('{"fake":"key"}')!,
      status: 'active',
    });

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: requesterRole.id,
    admin: { id: admin.id, email: admin.email },
    adminRoleId: adminRole.id,
  };
}

async function createIntent(s: Scenario): Promise<{ intentId: string; approvalRowId: string }> {
  const snapshot = await createActionIntent(orgAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId), {
    toolName: TOOL_NAME,
    input: { userEmail: 'target@customer.example', reason: 'offboarding' },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  expect(snapshot.approvalRequestIds).toHaveLength(1);
  return { intentId: snapshot.id, approvalRowId: snapshot.approvalRequestIds[0]! };
}

/**
 * Moves the approval deadline to `msFromNow` (negative = already passed), on
 * both the intent (`approval_expires_at`, the column the reaper and the
 * close-out read) and its approval row (`expires_at`, the column the decide
 * route reads). `action_intents.expires_at` is immutable (content trigger),
 * so only the mutable deadline column moves.
 */
async function setApprovalDeadline(intentId: string, msFromNow: number): Promise<void> {
  const deadline = new Date(Date.now() + msFromNow);
  await withSystemDbAccessContext(async () => {
    await db.update(actionIntents).set({ approvalExpiresAt: deadline }).where(eq(actionIntents.id, intentId));
    await db.update(approvalRequests).set({ expiresAt: deadline }).where(eq(approvalRequests.intentId, intentId));
  });
}

async function decideViaRoute(
  s: Scenario,
  approvalRowId: string,
  decision: 'approve' | 'deny',
): Promise<Response> {
  const token = await accessTokenFor(s.admin, s.orgId, s.partnerId, s.adminRoleId);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/${decision}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function readIntent(intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row!;
  });
}

async function readApprovalRowStatus(approvalRowId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRowId))
      .limit(1);
    return row?.status;
  });
}

async function outboxEvents(intentId: string): Promise<string[]> {
  const rows = await withSystemDbAccessContext(() =>
    db.select({ eventType: intentOutbox.eventType }).from(intentOutbox).where(eq(intentOutbox.intentId, intentId)),
  );
  return rows.map((r) => r.eventType).sort();
}

/** The audit write is fire-and-forget; poll briefly for it. */
async function auditActions(intentId: string, want: string, timeoutMs = 3_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(eq(auditLogs.resourceType, 'action_intent'), eq(auditLogs.resourceId, intentId))),
    );
    const actions = rows.map((r) => r.action);
    if (actions.includes(want) || Date.now() >= deadline) return actions;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const POLL_SLEEPS = new Set([500, 750, 1125, 1687.5, 2531.25, 3000]);

/**
 * Runs `decide` at the moment `waitForIntentDecision` goes into the sleep that
 * outlasts its timeout (the last sleep), and lets that sleep end only once
 * the decision has committed. Deterministic: no reliance on wall-clock
 * timing between the poll and the decision.
 */
function decideDuringLastSleep(timeoutMs: number, decide: () => Promise<void>): { fired: () => boolean } {
  const realSetTimeout = globalThis.setTimeout;
  const waitEndsAt = Date.now() + timeoutMs;
  let fired = false;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    cb: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (!fired && typeof ms === 'number' && POLL_SLEEPS.has(ms) && Date.now() + ms > waitEndsAt) {
      fired = true;
      return realSetTimeout(() => {
        void decide().finally(() => cb(...args));
      }, ms);
    }
    return realSetTimeout(cb, ms, ...args);
  }) as typeof setTimeout);
  return { fired: () => fired };
}

beforeEach(() => {
  h.usersUpdate.mockClear();
  h.usersUpdate.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#12098 — Tier-3 decision in the last seconds before the approval deadline (real Postgres)', () => {
  runDb('an approval landing during the wait\'s last sleep is returned, not read as still pending', async () => {
    const s = await seedScenario();
    const { intentId, approvalRowId } = await createIntent(s);

    let routeStatus = 0;
    const hook = decideDuringLastSleep(1, async () => {
      routeStatus = (await decideViaRoute(s, approvalRowId, 'approve')).status;
    });

    const status = await waitForIntentDecision(intentId, 1);

    expect(hook.fired()).toBe(true);
    expect(routeStatus).toBe(200);
    expect(status).toBe('approved');
  });

  runDb('a denial landing during the wait\'s last sleep is returned as rejected', async () => {
    const s = await seedScenario();
    const { intentId, approvalRowId } = await createIntent(s);

    let routeStatus = 0;
    const hook = decideDuringLastSleep(1, async () => {
      routeStatus = (await decideViaRoute(s, approvalRowId, 'deny')).status;
    });

    const status = await waitForIntentDecision(intentId, 1);

    expect(hook.fired()).toBe(true);
    expect(routeStatus).toBe(200);
    expect(status).toBe('rejected');
  });

  runDb('approved just before the deadline, closed out just after: reported approved, never expired, executed exactly once', async () => {
    const s = await seedScenario();
    const { intentId, approvalRowId } = await createIntent(s);
    await setApprovalDeadline(intentId, 1_500);

    // The approval lands inside the window...
    expect((await decideViaRoute(s, approvalRowId, 'approve')).status).toBe(200);
    // ...and the chat only gets to its close-out after the deadline.
    await setApprovalDeadline(intentId, -1_000);

    const closeOut = await closeOutUndecidedIntent(intentId);
    expect(closeOut).toEqual({ kind: 'decided', status: 'approved' });

    const after = await readIntent(intentId);
    expect(after.status).toBe('approved');
    expect(await outboxEvents(intentId)).not.toContain('intent_expired');

    // Both releasers race for it; exactly one claim wins and it runs once.
    await releaseApprovedIntent(intentId);
    const inlineClaim = await transitionIntent(
      intentId,
      'approved',
      'executing',
      { executedAt: null, executionStartedAt: new Date() },
      { requireNotExpired: 'release' },
    );
    expect(inlineClaim).toBe(false);
    expect(h.usersUpdate).toHaveBeenCalledTimes(1);
    expect((await readIntent(intentId)).status).toBe('completed');
  });

  runDb('denied just before the deadline: reported rejected, not expired', async () => {
    const s = await seedScenario();
    const { intentId, approvalRowId } = await createIntent(s);

    expect((await decideViaRoute(s, approvalRowId, 'deny')).status).toBe(200);
    await setApprovalDeadline(intentId, -1_000);

    expect(await closeOutUndecidedIntent(intentId)).toEqual({ kind: 'decided', status: 'rejected' });
    expect((await readIntent(intentId)).status).toBe('rejected');
    expect(await outboxEvents(intentId)).not.toContain('intent_expired');
  });

  runDb('undecided past the deadline: expired for good — the reaper\'s side effects land, a late approve is refused, nothing runs', async () => {
    const s = await seedScenario();
    const { intentId, approvalRowId } = await createIntent(s);
    await setApprovalDeadline(intentId, -1_000);
    // The decide route's own deadline is its approval row's expires_at; put
    // that back in the future so the only thing refusing the late approve
    // below is the close-out's expiry, not the route's clock check.
    await withSystemDbAccessContext(() =>
      db
        .update(approvalRequests)
        .set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(approvalRequests.intentId, intentId)),
    );

    expect(await closeOutUndecidedIntent(intentId)).toEqual({ kind: 'expired' });

    expect((await readIntent(intentId)).status).toBe('expired');
    expect(await readApprovalRowStatus(approvalRowId)).toBe('expired');
    expect(await outboxEvents(intentId)).toContain('intent_expired');
    expect(await auditActions(intentId, 'action_intent.expired')).toContain('action_intent.expired');

    const late = await decideViaRoute(s, approvalRowId, 'approve');
    expect(late.status).not.toBe(200);
    expect((await readIntent(intentId)).status).toBe('expired');

    await releaseApprovedIntent(intentId);
    expect(h.usersUpdate).not.toHaveBeenCalled();
    expect((await readIntent(intentId)).status).toBe('expired');

    // A second close-out (or the reaper) finds nothing left to expire.
    expect(await closeOutUndecidedIntent(intentId)).toEqual({ kind: 'decided', status: 'expired' });
    expect((await outboxEvents(intentId)).filter((e) => e === 'intent_expired')).toHaveLength(1);
  });

  runDb('before the deadline (database clock) the close-out leaves the intent pending', async () => {
    const s = await seedScenario();
    const { intentId } = await createIntent(s);
    await setApprovalDeadline(intentId, 60_000);

    expect(await closeOutUndecidedIntent(intentId)).toEqual({ kind: 'decided', status: 'pending_approval' });
    expect((await readIntent(intentId)).status).toBe('pending_approval');
    expect(await outboxEvents(intentId)).not.toContain('intent_expired');
  });
});
