/**
 * Real-Postgres proof that the decide-path intent fan-in is ATOMIC (Task 6).
 *
 * The decide handler mirrors an approver's decision onto the linked
 * `action_intents` row and, on approve, fans in: (a) the intent CAS
 * pending_approval -> approved, (b) sibling `approval_requests` expiry, and
 * (c) the `intent_approved` `intent_outbox` row that the release worker
 * (`jobs/intentReleaseWorker.ts`) consumes to actually run the action.
 *
 * Before Task 6 those three writes spanned THREE separate transactions (the
 * intent CAS committed on its own; sibling-expiry + outbox ran in a second,
 * error-SWALLOWED transaction). A fault in the outbox insert therefore left
 * the intent `approved` with NO outbox row — the worker never releases it and
 * the action silently never runs. Task 6 collapses {CAS + sibling-expiry +
 * outbox} into ONE system-scoped transaction so they commit all-or-nothing.
 *
 * The mocked unit suite (`approvals.test.ts`) mocks `../db` wholesale and can
 * never exercise a real transaction rollback — a mock `db.transaction` does not
 * roll back the CAS when a later statement throws. This suite drives the REAL
 * decide route (real JWT + `authMiddleware` + `breeze_app` RLS) against the
 * test Postgres, and injects a genuine DB-level fault into the outbox insert to
 * prove the CAS rolls back with it.
 *
 * Co-located with the route it exercises (per the repo's test-placement
 * convention) rather than under `src/__tests__/integration/`, so it is named
 * explicitly in BOTH `vitest.integration.config.ts` (`include`) and
 * `vitest.config.ts` (`exclude`) — the dual hand-list the intent reaper test
 * (`intentExpiryReaper.integration.test.ts`) also uses. Miss either edit and it
 * silently never runs in CI, or reds the no-DB unit job on ECONNREFUSED.
 */
import '../__tests__/integration/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../db';
import { actionIntents, intentOutbox } from '../db/schema/actionIntents';
import { approvalRequests } from '../db/schema/approvals';
import { createActionIntent } from '../services/actionIntents/intentService';
import { PERMISSIONS } from '../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../middleware/auth';
import { createAccessToken, type TokenPayload } from '../services/jwt';
import { getTestDb } from '../__tests__/integration/setup';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from '../__tests__/integration/db-utils';
import { approvalRoutes } from './approvals';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Real AuthContext for the requester acting on `orgId`, same shape
 * authMiddleware produces (reuses buildOrgAccessClosures so org-access
 * semantics can't drift from the live path). Mirrors intentFanout's helper. */
function requesterAuth(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
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

/** A real access token for an org-scoped approver, minted the same way
 * db-utils.setupTestEnvironment does (aep/mep = 1 matches the seeded row's
 * default epochs; sid must be non-empty for authMiddleware). */
async function approverAccessToken(
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
  orgApprover: { id: string; email: string };
  partnerApprover: { id: string; email: string };
  requesterRoleId: string;
  orgRoleId: string;
}

/** Seeds one org under one partner + a requester and TWO eligible approvers
 * (one org-member, one partner-member) — the same population intentFanout
 * seeds, which fans an intent out to exactly the two approvers (requester
 * excluded). */
async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(orgRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const requester = await createUser({ partnerId: partner.id, orgId: org.id, email: `requester-${randomUUID()}@decideatomic.test` });
  await assignUserToOrganization(requester.id, org.id, orgRole.id);

  const orgApprover = await createUser({ partnerId: partner.id, orgId: org.id, email: `org-approver-${randomUUID()}@decideatomic.test` });
  await assignUserToOrganization(orgApprover.id, org.id, orgRole.id);

  const partnerApprover = await createUser({ partnerId: partner.id, orgId: null, email: `partner-approver-${randomUUID()}@decideatomic.test` });
  await assignUserToPartner(partnerApprover.id, partner.id, partnerRole.id, 'all');

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    orgApprover: { id: orgApprover.id, email: orgApprover.email },
    partnerApprover: { id: partnerApprover.id, email: partnerApprover.email },
    requesterRoleId: orgRole.id,
    orgRoleId: orgRole.id,
  };
}

/** Seeds the scenario and fans out an intent-backed approval to the two
 * approvers, returning the intent id and the orgApprover's approval_request
 * row id (the row we'll decide through the real route). */
async function seedIntentWithTwoApprovers(s: Scenario): Promise<{ intentId: string; approverARowId: string }> {
  const auth = requesterAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId);
  // restore_snapshot is a base Tier-3 tool classified whole-tool `four_eyes`
  // (TIER3_FOUR_EYES_TOOLS, aiGuardrails.ts) — required for this fixture's
  // two-approver fan-out. execute_command was used here pre-Task-6, but the
  // tier3-supervised-four-eyes split (Task 1) classifies it `supervised`,
  // which fans out to exactly ONE (requester-owned) row and silently broke
  // this fixture's `toHaveLength(2)` assertion below. createActionIntent
  // never verifies the snapshot/device exist (that happens at release time),
  // so bare random UUIDs are fine (mirrors intentFanout).
  const snapshot = await createActionIntent(auth, {
    toolName: 'restore_snapshot',
    input: { snapshotId: randomUUID(), deviceId: randomUUID() },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  expect(snapshot.approvalRequestIds).toHaveLength(2);

  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, snapshot.id), eq(approvalRequests.userId, s.orgApprover.id))),
  );
  if (!row) throw new Error('seed: orgApprover approval_request row not found');
  return { intentId: snapshot.id, approverARowId: row.id };
}

async function approveViaRoute(s: Scenario, approvalRowId: string): Promise<Response> {
  const token = await approverAccessToken(s.orgApprover, s.orgId, s.partnerId, s.orgRoleId);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/**
 * Runs `fn` with a temporary BEFORE INSERT trigger on `intent_outbox` that
 * RAISEs whenever an `intent_approved` row is inserted — a genuine DB-level
 * fault (installed as the table owner via the superuser test client, so it
 * fires regardless of the inserting role). Any statement inserting that row
 * aborts, forcing its enclosing transaction to roll back. Dropped in `finally`.
 */
async function withIntentApprovedOutboxFault<T>(fn: () => Promise<T>): Promise<T> {
  const sdb = getTestDb();
  await sdb.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION breeze_test_block_intent_approved() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'intent_approved' THEN
          RAISE EXCEPTION 'injected fault: intent_approved outbox insert blocked';
        END IF;
        RETURN NEW;
      END;
      $fn$;
    `),
  );
  await sdb.execute(
    sql.raw(`
      CREATE TRIGGER breeze_test_block_intent_approved_trg
        BEFORE INSERT ON intent_outbox
        FOR EACH ROW EXECUTE FUNCTION breeze_test_block_intent_approved();
    `),
  );
  try {
    return await fn();
  } finally {
    await sdb.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_block_intent_approved_trg ON intent_outbox'));
    await sdb.execute(sql.raw('DROP FUNCTION IF EXISTS breeze_test_block_intent_approved()'));
  }
}

let seeded: Scenario | null = null;

beforeEach(async () => {
  seeded = await seedScenario();
});

describe('decide-path intent fan-in atomicity (real Postgres, breeze_app)', () => {
  runDb('happy path: approving commits intent status, the intent_approved outbox row, and sibling expiry together', async () => {
    const s = seeded!;
    const { intentId } = await seedIntentWithTwoApprovers(s);
    const [approverARow] = await withSystemDbAccessContext(() =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, s.orgApprover.id))),
    );

    const res = await approveViaRoute(s, approverARow!.id);
    expect(res.status).toBe(200);

    await withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
      expect(intent?.status).toBe('approved');

      const outbox = await db
        .select()
        .from(intentOutbox)
        .where(and(eq(intentOutbox.intentId, intentId), eq(intentOutbox.eventType, 'intent_approved')));
      expect(outbox).toHaveLength(1);

      const pendingSiblings = await db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.status, 'pending')));
      expect(pendingSiblings).toHaveLength(0); // partnerApprover's row expired in the same commit
    });
  });

  runDb('fault injection: a failing intent_approved outbox insert rolls back the ENTIRE decide write (approval CAS included) and returns a retryable 500', async () => {
    const s = seeded!;
    const { intentId, approverARowId } = await seedIntentWithTwoApprovers(s);

    // Task 6: the approval-row CAS, the intent CAS, the sibling expiry, and
    // the intent_approved outbox insert are now ONE transaction — a fault
    // anywhere inside it rolls back EVERYTHING, including the approver's own
    // approval_requests row, and the caller gets a retryable 500. (Pre-Task-6,
    // the approval CAS committed independently in its own transaction before
    // the intent fan-in ever opened, so this same fault left the approval row
    // decided while the intent silently never got its outbox row — a 200
    // response masking a half-applied decision. That is the exact bug this
    // task closes: assert 500 here, not 200.)
    const res = await withIntentApprovedOutboxFault(() => approveViaRoute(s, approverARowId));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.retryable).toBe(true);

    await withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
      // THE property this task delivers: with the outbox insert faulted, the
      // intent CAS rolled back too — the intent is NOT left `approved` (the
      // release worker would never see an outbox row for it).
      expect(intent?.status).toBe('pending_approval');

      const outbox = await db
        .select()
        .from(intentOutbox)
        .where(and(eq(intentOutbox.intentId, intentId), eq(intentOutbox.eventType, 'intent_approved')));
      expect(outbox).toHaveLength(0);

      // The approver's OWN approval_requests row rolled back with everything
      // else — it must NOT be left `approved` with no corresponding intent
      // transition (the half-applied state this task eliminates).
      const [ownRow] = await db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approverARowId));
      expect(ownRow?.status).toBe('pending');

      // Sibling expiry is part of the same rolled-back transaction, so
      // partnerApprover's row is still pending too.
      const pendingSiblings = await db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.status, 'pending')));
      expect(pendingSiblings.length).toBeGreaterThan(0);
    });

    // A retry (fault no longer installed — withIntentApprovedOutboxFault
    // dropped the trigger in its `finally`) succeeds cleanly: same approval
    // row, same intent, now genuinely committed together.
    const retryRes = await approveViaRoute(s, approverARowId);
    expect(retryRes.status).toBe(200);

    await withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
      expect(intent?.status).toBe('approved');

      const outbox = await db
        .select()
        .from(intentOutbox)
        .where(and(eq(intentOutbox.intentId, intentId), eq(intentOutbox.eventType, 'intent_approved')));
      expect(outbox).toHaveLength(1);

      const [ownRow] = await db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approverARowId));
      expect(ownRow?.status).toBe('approved');
    });
  });
});
