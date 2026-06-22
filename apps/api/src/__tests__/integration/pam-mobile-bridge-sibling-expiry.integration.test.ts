/**
 * Integration test for #1254 (Todd's RLS review fix): the PAM mobile-bridge
 * sibling-expiry MUST run in system scope.
 *
 * `approval_requests` is Shape-6 (user-id-scoped):
 *   USING (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
 *
 * One pending `uac_intercept` elevation fans out to N mobile approval_requests
 * rows, one per approver — each row owned by a DIFFERENT user_id. When approver
 * A decides, the route expires the SIBLING rows (approver B's etc.) so the
 * request vanishes from the other approvers' phones. Those sibling rows belong
 * to OTHER user_ids, so under `breeze_app` FORCE RLS they are INVISIBLE inside
 * approver A's request context — a bare context-scoped UPDATE matches ZERO rows.
 * The fix moves the sibling-expiry to system scope (post-commit, best-effort).
 *
 * These assertions run against a REAL Postgres as the unprivileged `breeze_app`
 * role (the same pool the route uses), so RLS is genuinely enforced:
 *
 *   (1) cross-approver expiry — the OLD user-context UPDATE expires 0 sibling
 *       rows (RLS-blind), while the NEW system-scoped UPDATE expires the
 *       sibling (1 row). This is the exact behavior the production fix encodes.
 *   (2) the cross-tenant elevation mirror-back is a clean no-op — an approver
 *       deciding cannot flip an elevation in another org (RLS-contained).
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import { db, withDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationRequests } from '../../db/schema/elevations';
import {
  partners,
  organizations,
  sites,
  devices,
  users,
} from '../../db/schema';
import { getTestDb } from './setup';

// Request-scoped context for a given approver user (org scope, no org access —
// approval_requests is keyed purely on user_id, so the org axis is irrelevant
// to its policy). Mirrors approval-system-scope.integration.test.ts.
function userContext(userId: string) {
  return {
    scope: 'organization' as const,
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [],
    userId,
  };
}

let orgId: string;
let siteId: string;
let deviceId: string;
let approverAId: string;
let approverBId: string;
let elevationId: string;
let approvalAId: string;
let approvalBId: string;

beforeEach(async () => {
  // Seed as the superuser test connection (bypasses RLS). setup.ts TRUNCATEs
  // the core tenant tables CASCADE on beforeEach, so these rows are cleared
  // transitively each test.
  const tdb = getTestDb();

  const [p] = await tdb
    .insert(partners)
    .values({ name: 'PR1254 Mobile Bridge', slug: `pr1254-${Date.now()}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const partnerId = p!.id;

  const [org] = await tdb
    .insert(organizations)
    .values({ partnerId, name: 'PR1254 Org', slug: `pr1254-org-${Date.now()}`, type: 'customer', status: 'active' })
    .returning({ id: organizations.id });
  orgId = org!.id;

  const [site] = await tdb
    .insert(sites)
    .values({ orgId, name: 'PR1254 Site', timezone: 'UTC' })
    .returning({ id: sites.id });
  siteId = site!.id;

  const [device] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-pr1254-${Date.now()}`,
      hostname: `ws-pr1254-${Date.now()}`,
      osType: 'windows',
      osVersion: '10.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning({ id: devices.id });
  deviceId = device!.id;

  const [a, b] = await tdb
    .insert(users)
    .values([
      { partnerId, email: `approverA-${Date.now()}@pr1254.test`, name: 'Approver A', status: 'active' },
      { partnerId, email: `approverB-${Date.now()}@pr1254.test`, name: 'Approver B', status: 'active' },
    ])
    .returning({ id: users.id });
  approverAId = a!.id;
  approverBId = b!.id;

  // A pending uac_intercept elevation (target_executable_path NOT NULL is
  // required by elevation_requests_flow_shape_chk for uac_intercept).
  const [elev] = await tdb
    .insert(elevationRequests)
    .values({
      orgId,
      siteId,
      partnerId,
      deviceId,
      flowType: 'uac_intercept',
      subjectUsername: 'PR1254\\enduser',
      reason: 'install setup.exe',
      targetExecutablePath: 'C:\\Temp\\setup.exe',
      status: 'pending',
    })
    .returning({ id: elevationRequests.id });
  elevationId = elev!.id;

  // Two pending mobile approval_requests for the SAME elevation, owned by two
  // DIFFERENT approvers (the fan-out).
  const [appA, appB] = await tdb
    .insert(approvalRequests)
    .values([
      {
        userId: approverAId,
        requestingClientLabel: 'Breeze Mobile',
        actionLabel: 'Elevate setup.exe',
        actionToolName: 'uac_intercept',
        riskTier: 'medium',
        riskSummary: 'admin requested',
        status: 'pending',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        elevationRequestId: elevationId,
      },
      {
        userId: approverBId,
        requestingClientLabel: 'Breeze Mobile',
        actionLabel: 'Elevate setup.exe',
        actionToolName: 'uac_intercept',
        riskTier: 'medium',
        riskSummary: 'admin requested',
        status: 'pending',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        elevationRequestId: elevationId,
      },
    ])
    .returning({ id: approvalRequests.id, userId: approvalRequests.userId });
  approvalAId = appA!.id;
  approvalBId = appB!.id;
});

describe('#1254 cross-approver sibling-expiry must run in system scope', () => {
  it('the OLD user-context UPDATE matches ZERO sibling rows (RLS-blind)', async () => {
    // Reproduce the bug: run the sibling-expiry inside approver A's request
    // context (as the original code did). Under breeze_app RLS, approver B's
    // row is invisible to A, so the UPDATE silently matches nothing.
    await withDbAccessContext(userContext(approverAId), async () => {
      await db
        .update(approvalRequests)
        .set({ status: 'expired' })
        .where(
          and(
            eq(approvalRequests.elevationRequestId, elevationId),
            ne(approvalRequests.id, approvalAId),
            eq(approvalRequests.status, 'pending'),
          ),
        );
    });

    // Read both rows back as the superuser (bypasses RLS) to see ground truth.
    const tdb = getTestDb();
    const [siblingB] = await tdb
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalBId));
    // The bug: approver B's sibling was NOT expired — it would still be on B's
    // phone. This is what Todd flagged.
    expect(siblingB!.status).toBe('pending');
  });

  it('the NEW system-scoped UPDATE expires the sibling (1 row)', async () => {
    // The production fix: wrap the sibling-expiry in
    // runOutsideDbContext(() => withSystemDbAccessContext(...)) so it runs in
    // system scope, where the Shape-6 OR-branch (breeze_current_scope() =
    // 'system') makes every approver's row visible. Run it from WITHIN approver
    // A's ambient request context to prove runOutsideDbContext escapes it.
    await withDbAccessContext(userContext(approverAId), async () => {
      await runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          await db
            .update(approvalRequests)
            .set({ status: 'expired' })
            .where(
              and(
                eq(approvalRequests.elevationRequestId, elevationId),
                ne(approvalRequests.id, approvalAId),
                eq(approvalRequests.status, 'pending'),
              ),
            );
        }),
      );
    });

    const tdb = getTestDb();
    const [siblingB] = await tdb
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalBId));
    // The fix: approver B's sibling is now expired — it vanishes from B's phone.
    expect(siblingB!.status).toBe('expired');

    // The decider's own row (approver A) is untouched by the sibling-expiry
    // (the `ne(id, approvalAId)` guard) — it carries A's actual decision.
    const [self] = await tdb
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalAId));
    expect(self!.status).toBe('pending');
  });
});

describe('#1254 cross-tenant elevation mirror-back is RLS-contained (clean no-op)', () => {
  it('an approver cannot flip an elevation in another org — the CAS matches 0 rows', async () => {
    // Seed a SECOND tenant with its own pending uac_intercept elevation.
    const tdb = getTestDb();
    const [p2] = await tdb
      .insert(partners)
      .values({ name: 'PR1254 Other MSP', slug: `pr1254-other-${Date.now()}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [org2] = await tdb
      .insert(organizations)
      .values({ partnerId: p2!.id, name: 'PR1254 Other Org', slug: `pr1254-other-org-${Date.now()}`, type: 'customer', status: 'active' })
      .returning({ id: organizations.id });
    const [site2] = await tdb
      .insert(sites)
      .values({ orgId: org2!.id, name: 'PR1254 Other Site', timezone: 'UTC' })
      .returning({ id: sites.id });
    const [device2] = await tdb
      .insert(devices)
      .values({
        orgId: org2!.id,
        siteId: site2!.id,
        agentId: `agent-pr1254-other-${Date.now()}`,
        hostname: `ws-pr1254-other-${Date.now()}`,
        osType: 'windows',
        osVersion: '10.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning({ id: devices.id });
    const [otherElev] = await tdb
      .insert(elevationRequests)
      .values({
        orgId: org2!.id,
        siteId: site2!.id,
        partnerId: p2!.id,
        deviceId: device2!.id,
        flowType: 'uac_intercept',
        subjectUsername: 'OTHER\\enduser',
        reason: 'install other.exe',
        targetExecutablePath: 'C:\\Temp\\other.exe',
        status: 'pending',
      })
      .returning({ id: elevationRequests.id });

    // Approver A (org1) tries to mirror an approve onto org2's elevation, using
    // the exact CAS shape the mirror block uses (status='pending' guard). A has
    // no access to org2, so elevation_requests' org-axis RLS hides the row and
    // the CAS returns 0 rows — a clean no-op, no cross-tenant write.
    const flipped = await withDbAccessContext(userContext(approverAId), async () =>
      db
        .update(elevationRequests)
        .set({ status: 'approved', approvedByUserId: approverAId, approvedAt: new Date() })
        .where(and(eq(elevationRequests.id, otherElev!.id), eq(elevationRequests.status, 'pending')))
        .returning({ id: elevationRequests.id }),
    );
    expect(flipped).toHaveLength(0);

    // Ground truth (superuser read): the other tenant's elevation is untouched.
    const [after] = await tdb
      .select({ status: elevationRequests.status })
      .from(elevationRequests)
      .where(eq(elevationRequests.id, otherElev!.id));
    expect(after!.status).toBe('pending');
  });
});
