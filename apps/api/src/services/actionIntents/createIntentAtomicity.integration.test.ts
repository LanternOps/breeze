/**
 * Real-Postgres proof that the CREATE path is ATOMIC and still tenant-isolated
 * (Task 7).
 *
 * `createActionIntent` historically inserted the intent row org-scoped (TX1),
 * committed, then fanned out `approval_requests` + wrote the `intent_created`
 * `intent_outbox` row system-scoped in a SEPARATE transaction (TX2). A crash or
 * fault between TX1 and TX2 therefore left a committed `pending_approval` intent
 * with NO approvers and NO outbox row — permanently stranded (the release
 * worker never sees an outbox row, no approver can ever decide it). Task 7
 * collapses {insert + fan-out + outbox} into ONE system-scoped transaction so
 * they commit all-or-nothing.
 *
 * Two assertions, both against the real `breeze_app` (NOBYPASSRLS) driver:
 *  1. Atomicity — inject a DB-level fault into the `intent_created` outbox
 *     insert and prove the intent insert rolls back WITH it: no `action_intents`
 *     row survives for the idempotency key (pre-Task-7 the TX1 insert committed
 *     and the catch left a terminal `failed` row), and zero `approval_requests`
 *     / zero `intent_outbox` rows.
 *  2. RLS still holds — the insert moved from org scope to system scope, so this
 *     proves the system-scoped insert did NOT weaken row visibility: an org-B
 *     context reading org A's intent via the raw `breeze_app` handle sees ZERO
 *     rows (RLS filters reads by org_id regardless of who inserted).
 *
 * The mocked unit suite (`intentService.test.ts`) mocks `../../db` wholesale and
 * can never exercise a real transaction rollback or a real RLS policy — this is
 * the belt-and-suspenders CI guard for the scope change.
 *
 * Co-located with the service it exercises (per the repo's test-placement
 * convention), so it is named explicitly in BOTH `vitest.integration.config.ts`
 * (`include`) and `vitest.config.ts` (`exclude`) — the dual hand-list Task 6's
 * `approvalsDecideAtomicity.integration.test.ts` also uses. Miss either edit and
 * it silently never runs in CI, or reds the no-DB unit job on ECONNREFUSED.
 */
import '../../__tests__/integration/setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  approvalRequests,
  intentOutbox,
  organizationUsers,
  partnerUsers,
  rolePermissions,
  roles,
  users,
} from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createActionIntent } from './intentService';
import { PERMISSIONS } from '../permissions';
import { getAppDb, getTestDb } from '../../__tests__/integration/setup';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from '../../__tests__/integration/db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Real AuthContext for a requester acting on `orgId`, same shape
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

interface Scenario {
  partnerId: string;
  orgAId: string;
  orgBId: string;
  requester: { id: string; email: string };
  orgApprover: { id: string; email: string };
  partnerApprover: { id: string; email: string };
  requesterRoleId: string;
  userIds: string[];
  roleIds: string[];
}

/** Seeds one partner with TWO orgs (A = the intent's org, B = the isolation
 * probe) plus a requester and two eligible approvers on org A (one org-member,
 * one partner-member) — the same population intentFanout seeds, which fans an
 * intent out to exactly the two approvers (requester excluded). */
async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id });
  await grantRolePermissions(orgRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const requester = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `requester-${randomUUID()}@createatomic.test` });
  await assignUserToOrganization(requester.id, orgA.id, orgRole.id);

  const orgApprover = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `org-approver-${randomUUID()}@createatomic.test` });
  await assignUserToOrganization(orgApprover.id, orgA.id, orgRole.id);

  const partnerApprover = await createUser({ partnerId: partner.id, orgId: null, email: `partner-approver-${randomUUID()}@createatomic.test` });
  await assignUserToPartner(partnerApprover.id, partner.id, partnerRole.id, 'all');

  return {
    partnerId: partner.id,
    orgAId: orgA.id,
    orgBId: orgB.id,
    requester: { id: requester.id, email: requester.email },
    orgApprover: { id: orgApprover.id, email: orgApprover.email },
    partnerApprover: { id: partnerApprover.id, email: partnerApprover.email },
    requesterRoleId: orgRole.id,
    userIds: [requester.id, orgApprover.id, partnerApprover.id],
    roleIds: [orgRole.id, partnerRole.id],
  };
}

/**
 * Runs `fn` with a temporary BEFORE INSERT trigger on `intent_outbox` that
 * RAISEs whenever an `intent_created` row is inserted — a genuine DB-level
 * fault (installed as the table owner via the superuser test client, so it
 * fires regardless of the inserting role). The insert aborts, forcing its
 * enclosing transaction to roll back. Uses DROP TRIGGER IF EXISTS before CREATE
 * for self-healing (a prior crashed run can't leave a stale trigger), and drops
 * both trigger + function in `finally`. Mirrors Task 6's
 * `withIntentApprovedOutboxFault`.
 */
async function withIntentCreatedOutboxFault<T>(fn: () => Promise<T>): Promise<T> {
  const sdb = getTestDb();
  await sdb.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_block_intent_created_trg ON intent_outbox'));
  await sdb.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION breeze_test_block_intent_created() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'intent_created' THEN
          RAISE EXCEPTION 'injected fault: intent_created outbox insert blocked';
        END IF;
        RETURN NEW;
      END;
      $fn$;
    `),
  );
  await sdb.execute(
    sql.raw(`
      CREATE TRIGGER breeze_test_block_intent_created_trg
        BEFORE INSERT ON intent_outbox
        FOR EACH ROW EXECUTE FUNCTION breeze_test_block_intent_created();
    `),
  );
  try {
    return await fn();
  } finally {
    await sdb.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_block_intent_created_trg ON intent_outbox'));
    await sdb.execute(sql.raw('DROP FUNCTION IF EXISTS breeze_test_block_intent_created()'));
  }
}

let seeded: Scenario | null = null;

beforeEach(async () => {
  seeded = await seedScenario();
});

// Belt-and-suspenders cleanup on top of setup.ts's own per-test TRUNCATE.
// Deletes strictly in FK-child-before-parent order under system scope, and —
// like intentFanout's afterEach — deliberately does NOT delete organizations /
// partners: the RLS test's createActionIntent fire-and-forgets an audit_logs
// row carrying org A's id (audit_logs.org_id has no ON DELETE CASCADE and no
// breeze_app DELETE grant), so a breeze_app DELETE on organizations would 23503.
// The next test's setup.ts beforeEach TRUNCATEs both CASCADE as the superuser
// client regardless.
afterEach(async () => {
  const s = seeded;
  seeded = null;
  if (!s) return;
  await withSystemDbAccessContext(async () => {
    // action_intents FK-cascades approval_requests + intent_outbox (ON DELETE
    // CASCADE — migration 2026-07-18-action-intents.sql).
    await db.delete(actionIntents).where(inArray(actionIntents.orgId, [s.orgAId, s.orgBId]));
    await db.delete(organizationUsers).where(eq(organizationUsers.orgId, s.orgAId));
    await db.delete(partnerUsers).where(eq(partnerUsers.partnerId, s.partnerId));
    await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, s.roleIds));
    await db.delete(roles).where(inArray(roles.id, s.roleIds));
    await db.delete(users).where(inArray(users.id, s.userIds));
  });
});

describe('createActionIntent — atomicity + RLS (real Postgres, breeze_app)', () => {
  runDb('a failing intent_created outbox insert rolls the WHOLE create back — no stranded intent, no partial fan-out', async () => {
    const s = seeded!;
    const auth = requesterAuth(s.requester, s.orgAId, s.partnerId, s.requesterRoleId);
    // Explicit idempotency key so we can assert on action_intents by key even
    // after the row has (correctly) rolled back and left nothing to read.
    const idempotencyKey = `atomicity-${randomUUID()}`;

    await expect(
      withIntentCreatedOutboxFault(() =>
        createActionIntent(auth, {
          toolName: 'execute_command',
          input: { deviceId: randomUUID(), commandType: 'list_processes' },
          source: 'chat',
          idempotencyKey,
        }),
      ),
    ).rejects.toThrow();

    await withSystemDbAccessContext(async () => {
      // THE property this task delivers: the outbox fault rolled the intent
      // insert back too. Pre-Task-7 the org-scoped TX1 had already committed the
      // intent and the catch marked it `failed` — a terminal row would survive
      // here. After the collapse there is no row at all for this key.
      const intents = await db
        .select({ id: actionIntents.id, status: actionIntents.status })
        .from(actionIntents)
        .where(and(eq(actionIntents.orgId, s.orgAId), eq(actionIntents.idempotencyKey, idempotencyKey)));
      expect(intents).toHaveLength(0);

      // No LIVE orphan specifically (the invariant the create path must never
      // violate), and no partial fan-out / outbox — all part of the same
      // rolled-back transaction. Scoped to org A (fresh per-test DB, but this
      // makes the intent explicit rather than relying on a clean table).
      const liveIntents = await db
        .select({ id: actionIntents.id })
        .from(actionIntents)
        .where(
          and(
            eq(actionIntents.orgId, s.orgAId),
            inArray(actionIntents.status, ['pending_approval', 'approved', 'executing']),
          ),
        );
      expect(liveIntents).toHaveLength(0);

      const approvals = await db.select({ id: approvalRequests.id }).from(approvalRequests);
      expect(approvals).toHaveLength(0);

      const outbox = await db.select({ id: intentOutbox.id }).from(intentOutbox);
      expect(outbox).toHaveLength(0);
    });
  });

  runDb('the system-scoped insert still sets org_id correctly — an org-B context cannot read org A\'s intent', async () => {
    const s = seeded!;
    const auth = requesterAuth(s.requester, s.orgAId, s.partnerId, s.requesterRoleId);

    const snapshot = await createActionIntent(auth, {
      toolName: 'execute_command',
      input: { deviceId: randomUUID(), commandType: 'list_processes' },
      source: 'chat',
    });
    expect(snapshot.status).toBe('pending_approval');

    // Sanity: an org-A context (the same tenant) CAN read its own row through
    // the raw breeze_app handle — proves the probe below fails on RLS, not on a
    // mis-set GUC or a non-existent row.
    const asOrgA = await getAppDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('breeze.scope', 'organization', true)`);
      await tx.execute(sql`select set_config('breeze.org_id', ${s.orgAId}, true)`);
      await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${s.orgAId}, true)`);
      return tx
        .select({ id: actionIntents.id })
        .from(actionIntents)
        .where(eq(actionIntents.id, snapshot.id));
    });
    expect(asOrgA).toHaveLength(1);

    // The isolation assertion: under an org-B context, the SAME breeze_app
    // driver sees ZERO rows for org A's intent id. The system-scoped insert set
    // org_id = org A; RLS (breeze_has_org_access(org_id)) filters the read by
    // org_id regardless of which scope inserted the row.
    const asOrgB = await getAppDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('breeze.scope', 'organization', true)`);
      await tx.execute(sql`select set_config('breeze.org_id', ${s.orgBId}, true)`);
      await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${s.orgBId}, true)`);
      return tx
        .select({ id: actionIntents.id })
        .from(actionIntents)
        .where(eq(actionIntents.id, snapshot.id));
    });
    expect(asOrgB).toHaveLength(0);
  });
});
