/**
 * Real-Postgres proof of the Batch-1 approver fan-out fix (commit
 * d01882b24 "fix(intents): resolve approvers across org+partner axes under
 * system context").
 *
 * Before that fix, `createActionIntent`'s cross-user `approval_requests`
 * insert ran under the REQUESTER's org-scoped DB context. `approval_requests`
 * is Shape-6 user-scoped RLS (`WITH CHECK user_id = breeze_current_user_id()
 * OR scope = 'system'` — migration 2026-05-16-approval-shape6-system-bypass.sql),
 * so inserting a row for an approver OTHER than the requester denied with
 * Postgres 42501 and aborted the whole creation. The fully-mocked unit tests
 * (`intentService.test.ts`) mock `../../db` wholesale and therefore can never
 * exercise a real RLS policy — this is the belt-and-suspenders CI guard
 * `intentService.ts`'s own header comment promises (see the TX2 block
 * there), run against the real `breeze_app` (NOBYPASSRLS) driver.
 *
 * This file lives under `src/__tests__/integration/` (not co-located with
 * the service) specifically so it's picked up automatically by the glob
 * include in `vitest.integration.config.ts` and the glob exclude in
 * `vitest.config.ts`, both of which target that directory wholesale — a
 * `src/services` placement would instead need both configs hand-edited with
 * an explicit filename, and silently never runs in CI (or reds the unit job
 * on ECONNREFUSED) if either edit is missed.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  approvalRequests,
  organizationUsers,
  partnerUsers,
  rolePermissions,
  roles,
  users,
} from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import { PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

/** Builds a real AuthContext for a requester acting on `orgId`, the same
 * shape `authMiddleware` produces for a live org-scoped session — reuses the
 * SAME closure factory (`buildOrgAccessClosures`) so org-access semantics
 * can never drift between the live request path and this test. */
function requesterAuth(user: { id: string; email: string }, orgId: string, partnerId: string, roleId: string): AuthContext {
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
  orgId: string;
  requester: { id: string; email: string };
  orgApprover: { id: string; email: string };
  partnerApprover: { id: string; email: string };
  requesterRoleId: string;
  userIds: string[];
  roleIds: string[];
}

/** The sole-operator tenant: one partner, one org, one user (the requester)
 * who is also the only eligible approver. */
interface SoloScenario {
  partnerId: string;
  orgId: string;
  requester: { id: string; email: string };
  requesterRoleId: string;
  userIds: string[];
  roleIds: string[];
}

/** Seeds one org under one partner, plus three users:
 *  - requester: org member, ALSO holds approvals:decide (proves the id-based
 *    self-exclusion filter, not just incidental ineligibility).
 *  - orgApprover: org member (organization_users row) holding approvals:decide.
 *  - partnerApprover: partner member (partner_users row, org_access='all',
 *    NO organization_users row at all) holding approvals:decide — exactly
 *    the population CRITICAL-2 exists to surface.
 * Seeded fresh inside beforeEach (not beforeAll): setup.ts TRUNCATEs the
 * core tenant tables on every test's beforeEach, so a beforeAll fixture
 * would be silently wiped before the first `it()` runs. */
async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(orgRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const requester = await createUser({ partnerId: partner.id, orgId: org.id, email: `requester-${randomUUID()}@intentfanout.test` });
  await assignUserToOrganization(requester.id, org.id, orgRole.id);

  const orgApprover = await createUser({ partnerId: partner.id, orgId: org.id, email: `org-approver-${randomUUID()}@intentfanout.test` });
  await assignUserToOrganization(orgApprover.id, org.id, orgRole.id);

  const partnerApprover = await createUser({ partnerId: partner.id, orgId: null, email: `partner-approver-${randomUUID()}@intentfanout.test` });
  await assignUserToPartner(partnerApprover.id, partner.id, partnerRole.id, 'all');

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    orgApprover: { id: orgApprover.id, email: orgApprover.email },
    partnerApprover: { id: partnerApprover.id, email: partnerApprover.email },
    requesterRoleId: orgRole.id,
    userIds: [requester.id, orgApprover.id, partnerApprover.id],
    roleIds: [orgRole.id, partnerRole.id],
  };
}

/** Seeds a SEPARATE partner+org whose ONLY member is the requester, who holds
 * approvals:decide. `resolveIntentApprovers` therefore returns exactly the
 * requester, the cross-user eligible set is empty after self-exclusion, and
 * `createActionIntent` takes the sole-operator branch — the population the
 * inline self-approve (Touch ID) flow exists for. Kept in its own tenant so
 * the multi-approver scenario above stays a true multi-approver org. */
async function seedSoloScenario(): Promise<SoloScenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(orgRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const requester = await createUser({ partnerId: partner.id, orgId: org.id, email: `solo-${randomUUID()}@intentfanout.test` });
  await assignUserToOrganization(requester.id, org.id, orgRole.id);

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: orgRole.id,
    userIds: [requester.id],
    roleIds: [orgRole.id],
  };
}

let seeded: Scenario | null = null;
let seededSolo: SoloScenario | null = null;

beforeEach(async () => {
  seeded = await seedScenario();
  seededSolo = await seedSoloScenario();
});

// Belt-and-suspenders cleanup on top of setup.ts's own per-test TRUNCATE —
// deletes strictly in FK-child-before-parent order under system scope (the
// same axis every table here is RLS-gated on; breeze_has_org_access /
// breeze_has_partner_access special-case scope='system' to true).
//
// Deliberately does NOT delete `organizations` / `partners` themselves:
// `createActionIntent`'s post-commit `recordActionIntentEvent` fire-and-forgets
// an `audit_logs` row carrying this org's id, and `audit_logs.org_id` has no
// `ON DELETE CASCADE` — a breeze_app-scoped DELETE on `organizations` would
// 23503 against it (audit_logs is also append-only: no DELETE grant for
// breeze_app at all, only the superuser test client's TRUNCATE ... CASCADE
// can clear it). The next test's global `beforeEach` (setup.ts) TRUNCATEs
// both tables CASCADE as the superuser client regardless, so leaving these
// two rows for that sweep is correct, not merely convenient.
async function cleanupScenario(s: Scenario | SoloScenario) {
  await withSystemDbAccessContext(async () => {
    // action_intents FK-cascades approval_requests + intent_outbox
    // (ON DELETE CASCADE — migration 2026-07-18-action-intents.sql), so
    // deleting the org's intents is enough to clear both.
    await db.delete(actionIntents).where(eq(actionIntents.orgId, s.orgId));
    await db.delete(organizationUsers).where(eq(organizationUsers.orgId, s.orgId));
    await db.delete(partnerUsers).where(eq(partnerUsers.partnerId, s.partnerId));
    await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, s.roleIds));
    await db.delete(roles).where(inArray(roles.id, s.roleIds));
    await db.delete(users).where(inArray(users.id, s.userIds));
  });
}

afterEach(async () => {
  const s = seeded;
  const solo = seededSolo;
  seeded = null;
  seededSolo = null;
  if (s) await cleanupScenario(s);
  if (solo) await cleanupScenario(solo);
});

describe('createActionIntent — approver fan-out across org+partner axes (real Postgres, breeze_app)', () => {
  it('fans out approval_requests to the org-member AND partner-member approvers, excludes the requester, persists partner_id, and lands pending_approval', async () => {
    const s = seeded!;
    const auth = requesterAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId);

    // execute_command is a base Tier-3 tool (registerScriptTools,
    // aiToolsScripts.ts) — no `action` field needed to hit TIER3_ACTIONS,
    // and createActionIntent never verifies the device exists (that happens
    // later, at release/execution time), so a bare random UUID is fine here.
    const snapshot = await createActionIntent(auth, {
      toolName: 'execute_command',
      input: { deviceId: randomUUID(), commandType: 'list_processes' },
      source: 'chat',
    });

    // This is the exact assertion that 42501'd before d01882b24: the
    // cross-user approval_requests insert for the OTHER two approvers, run
    // under the requester's org-scoped context, was denied by Shape-6 RLS
    // and aborted the whole creation before this line could ever be reached.
    expect(snapshot.status).toBe('pending_approval');
    expect(snapshot.approvalRequestIds).toHaveLength(2);

    const fanOutRows = await withSystemDbAccessContext(() =>
      db
        .select({ userId: approvalRequests.userId, boundDigest: approvalRequests.boundArgumentDigest })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, snapshot.id)),
    );
    const fannedOutUserIds = fanOutRows.map((r) => r.userId).sort();
    expect(fannedOutUserIds).toEqual([s.orgApprover.id, s.partnerApprover.id].sort());
    expect(fannedOutUserIds).not.toContain(s.requester.id);
    // Every fanned-out row is bound to the same argument digest as the intent
    // (spec §3.2's tamper-detection bind — asserted here, not just relied on).
    for (const row of fanOutRows) {
      expect(row.boundDigest).toBe(snapshot.argumentDigest);
    }

    const [intentRow] = await withSystemDbAccessContext(() =>
      db.select().from(actionIntents).where(eq(actionIntents.id, snapshot.id)),
    );
    expect(intentRow?.partnerId).toBe(s.partnerId);
    expect(intentRow?.status).toBe('pending_approval');
    expect(intentRow?.requestedByUserId).toBe(s.requester.id);

    // Four-eyes property at the persistence layer: in a multi-approver org
    // the requester gets NO row of their own, so there is nothing for the web
    // client to self-approve with. `requesterApprovalRequestId` is what
    // aiAgentSdk forwards as `selfApprovalRequestId` on the
    // `approval_required` stream event — null here means no Touch ID
    // self-approve button is ever offered to the requester.
    expect(snapshot.requesterApprovalRequestId).toBeNull();
  });

  it('sole-operator org: the single fanned-out row belongs to the requester and is returned as requesterApprovalRequestId', async () => {
    const s = seededSolo!;
    const auth = requesterAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId);

    const snapshot = await createActionIntent(auth, {
      toolName: 'execute_command',
      input: { deviceId: randomUUID(), commandType: 'list_processes' },
      source: 'chat',
    });

    expect(snapshot.status).toBe('pending_approval');
    expect(snapshot.approvalRequestIds).toHaveLength(1);

    const soloRows = await withSystemDbAccessContext(() =>
      db
        .select({ id: approvalRequests.id, userId: approvalRequests.userId, boundDigest: approvalRequests.boundArgumentDigest })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, snapshot.id)),
    );
    expect(soloRows).toHaveLength(1);
    expect(soloRows[0]?.userId).toBe(s.requester.id);
    // The exact id the web client needs for the inline self-approve tap —
    // proven against the real persisted row, not a mock projection.
    expect(snapshot.requesterApprovalRequestId).toBe(soloRows[0]?.id);
    expect(snapshot.approvalRequestIds).toEqual([soloRows[0]?.id]);
    // Still bound to the intent's argument digest (the L3 decide gate
    // re-checks this bind before releasing).
    expect(soloRows[0]?.boundDigest).toBe(snapshot.argumentDigest);
  });

  it('creates a NEW intent for an identical duplicate request once the prior intent has terminalized (partial idempotency index)', async () => {
    const s = seeded!;
    const auth = requesterAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId);
    const input = {
      toolName: 'execute_command',
      input: { deviceId: randomUUID(), commandType: 'list_processes' },
      source: 'chat' as const,
    };

    const first = await createActionIntent(auth, input);
    expect(first.status).toBe('pending_approval');

    // Terminalize it — action_intents_org_idem_uniq only covers LIVE
    // statuses (pending_approval/approved/executing), so once this row is
    // terminal it must stop blocking a legitimate future identical request.
    const terminalized = await transitionIntent(first.id, 'pending_approval', 'cancelled');
    expect(terminalized).toBe(true);

    // Same requester, same tool, same (canonicalized) args → same derived
    // idempotency key. Before IMPORTANT-4 this would have 23505'd against
    // the now-terminal row instead of creating a fresh one.
    const second = await createActionIntent(auth, input);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending_approval');
    expect(second.approvalRequestIds).toHaveLength(2);

    const secondFanOut = await withSystemDbAccessContext(() =>
      db
        .select({ userId: approvalRequests.userId })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, second.id)),
    );
    expect(secondFanOut.map((r) => r.userId).sort()).toEqual([s.orgApprover.id, s.partnerApprover.id].sort());

    // The terminalized first intent's own fan-out rows must be untouched by
    // the second creation (still exactly its original 2 rows, still bound to
    // the FIRST intent's id).
    const firstFanOut = await withSystemDbAccessContext(() =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, first.id)),
    );
    expect(firstFanOut).toHaveLength(2);
  });
});
