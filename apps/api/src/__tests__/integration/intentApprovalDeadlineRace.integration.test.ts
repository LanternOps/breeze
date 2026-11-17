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
import { and, eq, sql } from 'drizzle-orm';
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
import { aiSessions } from '../../db/schema/ai';
import { createSessionPreToolUse, settleApprovalWaits } from '../../services/aiAgentSdk';
import type { ActiveSession } from '../../services/streamingSessionManager';

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
/** Shorter than the first 500 ms sleep, so that sleep is the last one. */
const WAIT_MS = 50;

/**
 * Runs `fn` with a temporary deferred constraint trigger on `intent_outbox`
 * that RAISEs on `intent_expired` rows AT COMMIT — a genuine database fault
 * after every statement of the close-out has run (installed with the
 * superuser test client, so it fires whatever role inserts). With `failures`,
 * only the first N commits fail (a sequence counts them; nextval is not rolled
 * back with the failing transaction). Dropped in `finally`.
 */
async function withIntentExpiredOutboxFault<T>(failures: number | 'always', fn: () => Promise<T>): Promise<T> {
  const sdb = getTestDb();
  const limit = failures === 'always' ? 2147483647 : failures;
  await sdb.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_block_intent_expired_trg ON intent_outbox'));
  await sdb.execute(sql.raw('DROP SEQUENCE IF EXISTS breeze_test_intent_expired_fault_seq'));
  await sdb.execute(sql.raw('CREATE SEQUENCE breeze_test_intent_expired_fault_seq'));
  await sdb.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION breeze_test_block_intent_expired() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'intent_expired'
           AND nextval('breeze_test_intent_expired_fault_seq') <= ${limit} THEN
          RAISE EXCEPTION 'injected fault: intent_expired outbox insert blocked';
        END IF;
        RETURN NEW;
      END;
      $fn$;
    `),
  );
  await sdb.execute(
    sql.raw(`
      CREATE CONSTRAINT TRIGGER breeze_test_block_intent_expired_trg
        AFTER INSERT ON intent_outbox
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION breeze_test_block_intent_expired();
    `),
  );
  try {
    return await fn();
  } finally {
    await sdb.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_block_intent_expired_trg ON intent_outbox'));
    await sdb.execute(sql.raw('DROP FUNCTION IF EXISTS breeze_test_block_intent_expired()'));
    await sdb.execute(sql.raw('DROP SEQUENCE IF EXISTS breeze_test_intent_expired_fault_seq'));
  }
}

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
    const hook = decideDuringLastSleep(WAIT_MS, async () => {
      routeStatus = (await decideViaRoute(s, approvalRowId, 'approve')).status;
    });

    const status = await waitForIntentDecision(intentId, WAIT_MS);

    expect(hook.fired()).toBe(true);
    expect(routeStatus).toBe(200);
    expect(status).toBe('approved');
  });

  runDb('a denial landing during the wait\'s last sleep is returned as rejected', async () => {
    const s = await seedScenario();
    const { intentId, approvalRowId } = await createIntent(s);

    let routeStatus = 0;
    const hook = decideDuringLastSleep(WAIT_MS, async () => {
      routeStatus = (await decideViaRoute(s, approvalRowId, 'deny')).status;
    });

    const status = await waitForIntentDecision(intentId, WAIT_MS);

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

    // The chat's inline claim and the release worker race for it at once;
    // the approved -> executing CAS lets exactly one run it.
    const [inlineClaim] = await Promise.all([
      transitionIntent(
        intentId,
        'approved',
        'executing',
        { executedAt: null, executionStartedAt: new Date() },
        { requireNotExpired: 'release' },
      ),
      releaseApprovedIntent(intentId),
    ]);
    const after2 = await readIntent(intentId);
    if (inlineClaim) {
      // The inline claim won: the worker must not have run the tool.
      expect(h.usersUpdate).not.toHaveBeenCalled();
      expect(after2.status).toBe('executing');
    } else {
      expect(h.usersUpdate).toHaveBeenCalledTimes(1);
      expect(after2.status).toBe('completed');
    }
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

  runDb('a close-out whose COMMIT fails rolls back whole: still pending, no outbox or audit row, reported unknown', async () => {
    const s = await seedScenario();
    const { intentId, approvalRowId } = await createIntent(s);
    await setApprovalDeadline(intentId, -1_000);

    const closeOut = await withIntentExpiredOutboxFault('always', () => closeOutUndecidedIntent(intentId));

    expect(closeOut).toEqual({ kind: 'unknown' });
    expect((await readIntent(intentId)).status).toBe('pending_approval');
    expect(await readApprovalRowStatus(approvalRowId)).toBe('pending');
    expect(await outboxEvents(intentId)).not.toContain('intent_expired');
    // The audit write is deferred to commit, so an expiry that never
    // committed leaves no audit row (it runs on its own connection).
    expect(await auditActions(intentId, 'action_intent.expired', 1_500)).not.toContain('action_intent.expired');
  });

  runDb('a close-out whose first COMMIT fails is retried and expires the intent exactly once, with one audit row', async () => {
    const s = await seedScenario();
    const { intentId, approvalRowId } = await createIntent(s);
    await setApprovalDeadline(intentId, -1_000);

    const closeOut = await withIntentExpiredOutboxFault(1, () => closeOutUndecidedIntent(intentId));

    expect(closeOut).toEqual({ kind: 'expired' });
    expect((await readIntent(intentId)).status).toBe('expired');
    expect(await readApprovalRowStatus(approvalRowId)).toBe('expired');
    expect((await outboxEvents(intentId)).filter((e) => e === 'intent_expired')).toHaveLength(1);
    const audits = await auditActions(intentId, 'action_intent.expired');
    expect(audits.filter((a) => a === 'action_intent.expired')).toHaveLength(1);
  });

  runDb('an intent row that no longer exists is reported missing, without retries', async () => {
    const started = Date.now();
    expect(await closeOutUndecidedIntent(randomUUID())).toEqual({ kind: 'missing' });
    // No retry backoff (250 ms + 500 ms).
    expect(Date.now() - started).toBeLessThan(700);
  });

  // Review follow-up: the chat gate itself (`createSessionPreToolUse`) on a
  // real database. An approval lands in the wait's sleep and the wait is then
  // ended early (teardown, or a new message / interrupt). The dying turn must
  // not take the inline `approved -> executing` claim: on teardown the SDK
  // never calls the tool (the intent would sit in `executing` until the
  // stale-execution reaper fails it), and on a new message the tool would run
  // in a turn the user has moved past. The release worker runs it, once.
  describe.each([
    ['session teardown', (session: ActiveSession) => session.abortController.abort()],
    ['a new user message or interrupt', (session: ActiveSession) => { settleApprovalWaits(session); }],
  ])('an approval that lands just before the wait is ended early (%s)', (_label, endWait) => {
    runDb('is handed to the release worker, executed exactly once, never left executing, never reported expired', async () => {
      const s = await seedScenario();
      const [aiSession] = await withSystemDbAccessContext(() =>
        db
          .insert(aiSessions)
          .values({ orgId: s.orgId, userId: s.requester.id, model: 'claude-sonnet-4-5-20250929' })
          .returning({ id: aiSessions.id }),
      );
      const session = {
        breezeSessionId: aiSession!.id,
        orgId: s.orgId,
        auth: orgAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId),
        approvalMode: 'per_step',
        isPaused: false,
        eventBus: { publish: () => undefined },
        abortController: new AbortController(),
        activePlanId: null,
        approvedPlanSteps: new Map(),
        currentPlanStepIndex: 0,
        toolUseIdQueue: ['tool-use-1'],
        auditSnapshot: null,
        allowedTools: undefined,
        // Long enough that only the early end stops the wait.
        approvalWaitBudgetMs: 60_000,
      } as unknown as ActiveSession;

      // At the wait's first sleep: approve through the real route, then end
      // the wait, then let the sleep finish. The wait returns without
      // another poll (it was ended), so the close-out is what finds the
      // approval.
      const realSetTimeout = globalThis.setTimeout;
      let fired = false;
      let routeStatus = 0;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        cb: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) => {
        if (!fired && ms === 500) {
          fired = true;
          return realSetTimeout(() => {
            void (async () => {
              const [row] = await withSystemDbAccessContext(() =>
                db
                  .select({ id: approvalRequests.id })
                  .from(approvalRequests)
                  .innerJoin(actionIntents, eq(actionIntents.id, approvalRequests.intentId))
                  .where(and(eq(actionIntents.orgId, s.orgId), eq(actionIntents.status, 'pending_approval'))),
              );
              routeStatus = (await decideViaRoute(s, row!.id, 'approve')).status;
              endWait(session);
            })().finally(() => cb(...args));
          }, ms);
        }
        return realSetTimeout(cb, ms, ...args);
      }) as typeof setTimeout);

      const result = await createSessionPreToolUse(session)(TOOL_NAME, {
        userEmail: 'target@customer.example',
        reason: 'offboarding',
      });
      vi.restoreAllMocks();

      expect(fired).toBe(true);
      expect(routeStatus).toBe(200);
      const [intentRow] = await withSystemDbAccessContext(() =>
        db.select({ id: actionIntents.id }).from(actionIntents).where(eq(actionIntents.orgId, s.orgId)),
      );
      const intentId = intentRow!.id;

      // The turn's result: a handoff, not an inline release, not an expiry.
      expect(result).toMatchObject({ allowed: false, handoff: expect.anything() });
      expect(JSON.stringify(result)).not.toMatch(/re-issue/i);
      expect(JSON.stringify(result)).not.toMatch(/expired/i);
      // The dying turn took no claim.
      expect((await readIntent(intentId)).status).toBe('approved');
      expect(h.usersUpdate).not.toHaveBeenCalled();

      // The release worker runs it once; a second delivery finds nothing.
      await releaseApprovedIntent(intentId);
      await releaseApprovedIntent(intentId);
      expect(h.usersUpdate).toHaveBeenCalledTimes(1);
      expect((await readIntent(intentId)).status).toBe('completed');
      expect(await outboxEvents(intentId)).not.toContain('intent_expired');
    });
  });

  // Review follow-up: approve and the close-out with the intent row lock
  // CONTENDED. Another transaction holds the intent `FOR UPDATE`; both the
  // real approve route (which locks the intent first) and the close-out queue
  // behind it. Postgres grants the row lock in queue order, so the one queued
  // first wins; the other must see that and agree.
  describe('approve and close-out queued on a held intent row lock', () => {
    /** Holds `action_intents` row `intentId` FOR UPDATE until `release()`. */
    async function holdIntentRowLock(intentId: string): Promise<{ pid: number; release: () => Promise<void> }> {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let ready!: (pid: number) => void;
      const readyP = new Promise<number>((resolve) => { ready = resolve; });
      const done = getTestDb().transaction(async (tx) => {
        const pidRows = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        const pid = Number((pidRows as unknown as Array<{ pid: number }>)[0]!.pid);
        await tx.execute(sql`SELECT id FROM action_intents WHERE id = ${intentId} FOR UPDATE`);
        ready(pid);
        await released;
      });
      const pid = await readyP;
      return { pid, release: async () => { release(); await done; } };
    }

    /** Waits until `n` backends are queued on a lock rooted at `holderPid` (directly or behind each other). */
    async function waitForLockWaiters(holderPid: number, n: number): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const rows = await getTestDb().execute(sql`
          WITH RECURSIVE waiters AS (
            SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
            UNION
            SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
          )
          SELECT count(*)::int AS n FROM waiters
        `);
        const count = Number((rows as unknown as Array<{ n: number }>)[0]!.n);
        if (count >= n) return;
        if (Date.now() >= deadline) throw new Error(`only ${count} of ${n} lock waiters queued`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    async function pastDeadlineIntentWithLiveApprovalRow(s: Scenario) {
      const { intentId, approvalRowId } = await createIntent(s);
      // The intent's deadline (what the close-out reads) has passed; the
      // approval row's own deadline (what the route reads) has not, so the
      // only thing that can refuse the approve is the close-out's expiry.
      await setApprovalDeadline(intentId, -1_000);
      await withSystemDbAccessContext(() =>
        db
          .update(approvalRequests)
          .set({ expiresAt: new Date(Date.now() + 60_000) })
          .where(eq(approvalRequests.intentId, intentId)),
      );
      return { intentId, approvalRowId };
    }

    runDb('approve queued first wins: the close-out reports approved, nothing expires, the worker runs it once', async () => {
      const s = await seedScenario();
      const { intentId, approvalRowId } = await pastDeadlineIntentWithLiveApprovalRow(s);

      const lock = await holdIntentRowLock(intentId);
      let approve!: Promise<Response>;
      let closeOut!: ReturnType<typeof closeOutUndecidedIntent>;
      try {
        approve = decideViaRoute(s, approvalRowId, 'approve');
        await waitForLockWaiters(lock.pid, 1);
        closeOut = closeOutUndecidedIntent(intentId);
        await waitForLockWaiters(lock.pid, 2);
      } finally {
        await lock.release();
      }

      expect((await approve).status).toBe(200);
      expect(await closeOut).toEqual({ kind: 'decided', status: 'approved' });
      expect((await readIntent(intentId)).status).toBe('approved');
      expect(await outboxEvents(intentId)).not.toContain('intent_expired');

      await releaseApprovedIntent(intentId);
      expect(h.usersUpdate).toHaveBeenCalledTimes(1);
      expect((await readIntent(intentId)).status).toBe('completed');
    });

    runDb('close-out queued first wins: expired for good, the approve is refused, nothing runs', async () => {
      const s = await seedScenario();
      const { intentId, approvalRowId } = await pastDeadlineIntentWithLiveApprovalRow(s);

      const lock = await holdIntentRowLock(intentId);
      let approve!: Promise<Response>;
      let closeOut!: ReturnType<typeof closeOutUndecidedIntent>;
      try {
        closeOut = closeOutUndecidedIntent(intentId);
        await waitForLockWaiters(lock.pid, 1);
        approve = decideViaRoute(s, approvalRowId, 'approve');
        await waitForLockWaiters(lock.pid, 2);
      } finally {
        await lock.release();
      }

      expect(await closeOut).toEqual({ kind: 'expired' });
      expect((await approve).status).not.toBe(200);
      expect((await readIntent(intentId)).status).toBe('expired');
      expect(await readApprovalRowStatus(approvalRowId)).toBe('expired');
      expect((await outboxEvents(intentId)).filter((e) => e === 'intent_expired')).toHaveLength(1);

      await releaseApprovedIntent(intentId);
      expect(h.usersUpdate).not.toHaveBeenCalled();
      expect((await readIntent(intentId)).status).toBe('expired');
    });
  });
});
