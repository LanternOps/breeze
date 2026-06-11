/**
 * Integration test for PR #696 Critical #1 + #2.
 *
 * Both the approval-expiry reaper and the account-deletion admin queue run
 * under SYSTEM DB scope, but the Shape-6 policies on `approval_requests` and
 * `account_deletion_requests` were `user_id = breeze_current_user_id()` with
 * NO system-scope OR branch. Under system scope `breeze_current_user_id()` is
 * NULL, so FORCE RLS hid every row from `breeze_app`:
 *
 *   - #2: `reapExpiredApprovals()` transitioned 0 rows — expiry never ran.
 *   - #1: the account-deletion admin endpoints (which use
 *     `runWithSystemDbAccess`) saw an empty queue. #1 also had a second
 *     defect: `accountDeletion.ts`'s `runWithSystemDbAccess` lacked the
 *     `runOutsideDbContext` wrap, so inside an authenticated request it was
 *     a no-op that inherited the caller's (admin's) request scope.
 *
 * These tests assert the composed production behavior against a real DB as
 * the unprivileged `breeze_app` role. They fail (RED) until the fix-forward
 * migration adds `OR breeze_current_scope() = 'system'` to both policies AND
 * `runWithSystemDbAccess` is corrected to escape the ambient request context.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { accountDeletionRequests, partners, users } from '../../db/schema';
import { reapExpiredApprovals } from '../../jobs/approvalExpiryReaper';
import { runWithSystemDbAccess } from '../../routes/auth/accountDeletion';

function userContext(userId: string) {
  return {
    scope: 'organization' as const,
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [],
    userId,
  };
}

let partnerId: string;
let adminId: string;
let requesterId: string;

beforeEach(async () => {
  // Seed as the superuser test connection (bypasses RLS) — setup.ts's
  // cleanupDatabase() TRUNCATEs users CASCADE on beforeEach, so the
  // approval/deletion rows are cleared transitively each test.
  const tdb = getTestDb();
  const [p] = await tdb
    .insert(partners)
    .values({ name: 'PR696 System Scope', slug: `pr696-sysscope-${Date.now()}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  partnerId = p!.id;
  const [admin, requester] = await tdb
    .insert(users)
    .values([
      { partnerId, email: `admin-${Date.now()}@pr696.test`, name: 'PR696 Admin', status: 'active' },
      { partnerId, email: `req-${Date.now()}@pr696.test`, name: 'PR696 Requester', status: 'active' },
    ])
    .returning({ id: users.id });
  adminId = admin!.id;
  requesterId = requester!.id;
});

describe('PR#696 #2 — approvalExpiryReaper transitions overdue rows under system scope', () => {
  it('expires a pending, overdue approval and reports the count', async () => {
    const tdb = getTestDb();
    const [row] = await tdb
      .insert(approvalRequests)
      .values({
        userId: requesterId,
        requestingClientLabel: 'pr696-reaper-client',
        actionLabel: 'pr696.reaper.overdue',
        actionToolName: 'pr696.reaper',
        riskTier: 'low',
        riskSummary: 'overdue approval should be reaped',
        expiresAt: new Date(Date.now() - 60_000), // already expired
      })
      .returning({ id: approvalRequests.id });

    // Mirror the production BullMQ worker: it wraps reapExpiredApprovals in
    // withSystemDbAccessContext (no ambient request context, so this genuinely
    // enters system scope). Calling it bare would run at scope='none'.
    const reaped = await withSystemDbAccessContext(() => reapExpiredApprovals());

    expect(reaped).toBe(1);

    const [after] = await tdb
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, row!.id));
    expect(after!.status).toBe('expired');
  });

  it('does not touch an approval that has not yet expired', async () => {
    const tdb = getTestDb();
    const [row] = await tdb
      .insert(approvalRequests)
      .values({
        userId: requesterId,
        requestingClientLabel: 'pr696-reaper-client',
        actionLabel: 'pr696.reaper.fresh',
        actionToolName: 'pr696.reaper',
        riskTier: 'low',
        riskSummary: 'fresh approval must survive the reaper',
        expiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .returning({ id: approvalRequests.id });

    const reaped = await withSystemDbAccessContext(() => reapExpiredApprovals());

    expect(reaped).toBe(0);
    const [after] = await tdb
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, row!.id));
    expect(after!.status).toBe('pending');
  });
});

describe('PR#696 #1 — account-deletion admin reads the queue under true system scope', () => {
  it('runWithSystemDbAccess reaches another user\'s row even from within an ambient request scope', async () => {
    const tdb = getTestDb();
    await tdb.insert(accountDeletionRequests).values({
      userId: requesterId,
      processBy: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      reason: 'pr696 admin-queue visibility',
    });

    // Simulate the authenticated admin request: authMiddleware establishes a
    // request-scoped DB context for the admin BEFORE the handler runs. The
    // handler then calls runWithSystemDbAccess(...) — which must escape this
    // ambient context to reach system scope.
    const rows = await withDbAccessContext(userContext(adminId), async () =>
      runWithSystemDbAccess(async () =>
        getSystemScopedDeletionRequests(),
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(requesterId);
  });
});

// Helper kept outside the assertion so the query runs through the app `db`
// proxy (breeze_app, RLS enforced) under whatever scope is active.
async function getSystemScopedDeletionRequests() {
  const { db } = await import('../../db');
  return db
    .select({ id: accountDeletionRequests.id, userId: accountDeletionRequests.userId })
    .from(accountDeletionRequests);
}
