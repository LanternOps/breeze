/**
 * Real-Postgres proof that the durable release worker executes a Google
 * Workspace Tier-3 tool HEADLESSLY (Phase 2) instead of false-failing it
 * `session_required` — the linchpin correctness test for the headless-dispatch
 * feature (spec docs/superpowers/specs/
 * 2026-07-19-action-intents-phase2-google-headless-design.md).
 *
 * Tasks 1-3 taught `releaseApprovedIntent` (jobs/intentReleaseWorker.ts) that a
 * `google_suspend_user` intent is headless-executable: it resolves the org's
 * single Google connection by the immutable `intent.orgId`, decrypts the
 * service-account key, and runs `executeGoogleToolHeadless` — NO live SSE
 * session. The mocked unit suite (intentReleaseWorker.test.ts) mocks `../db`
 * and the whole Google stack wholesale, so it can never prove the real
 * connection load + secret DECRYPT + org-scoped RLS read + intent lifecycle
 * line up against a real Postgres. This suite does, mocking ONLY the Google SDK
 * client at the network boundary.
 *
 * The worker runs `revalidateApprovedIntentForRelease` BEFORE execution and
 * fails closed (to a DIFFERENT error_code) on any of: digest mismatch, tier
 * escalation, invalid/deactivated actor, inactive org, or the requester having
 * lost the tool's RBAC. To exercise the REAL Google path (not a revalidation
 * stop that would pass "green" for the wrong reason) the intent is built with
 * `createActionIntent` (correct canonical digest + a real winning
 * approval_requests row), the requester's org role is granted the tool's
 * `google.execute` permission, and the org is active — so revalidation returns
 * ok and control reaches the Google dispatch.
 *
 * Co-located with the worker it exercises (repo test-placement convention), so
 * it is named explicitly in BOTH vitest.integration.config.ts (`include`) and
 * vitest.config.ts (`exclude`) — the dual hand-list intentExpiryReaper /
 * approvalsDecideAtomicity also use. Miss either edit and it silently never
 * runs in CI, or reds the no-DB unit job on ECONNREFUSED.
 */
import '../__tests__/integration/setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';

// Mock the Google SDK client at construction ONLY. getDirectoryClient is what
// every Directory Action calls; googleSuspendUserAction issues exactly one
// `users.update({ suspended: true })`. The real connection load + secret
// decrypt + org RLS read still run against Postgres — only the outbound Google
// API call is faked. Hoisted so the (hoisted) vi.mock factory can close over
// the same spy the assertions read.
const h = vi.hoisted(() => {
  const usersUpdate = vi.fn(async () => ({ data: {} }));
  return { usersUpdate };
});

vi.mock('../services/googleClient', () => ({
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

import { db, withSystemDbAccessContext } from '../db';
import { getTestDb } from '../__tests__/integration/setup';
import { actionIntents } from '../db/schema/actionIntents';
import { approvalRequests } from '../db/schema/approvals';
import { googleWorkspaceConnections } from '../db/schema/google';
import { encryptSecret } from '../services/secretCrypto';
import { createActionIntent, transitionIntent } from '../services/actionIntents/intentService';
import { buildOrgAccessClosures, type AuthContext } from '../middleware/auth';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
  assignUserToOrganization,
  grantRolePermissions,
} from '../__tests__/integration/db-utils';
import { releaseApprovedIntent } from './intentReleaseWorker';

const TOOL_NAME = 'google_suspend_user';
// google_suspend_user → { resource: 'google', action: 'execute' } in
// aiGuardrails.TOOL_PERMISSIONS. revalidation step (e) re-checks the REQUESTER
// still holds this against their freshly-rebuilt role, so the requester's org
// role must carry it or release fails `rbac_denied` (not the Google path).
const GOOGLE_EXECUTE = { resource: 'google', action: 'execute' } as const;
const APPROVALS_DECIDE = { resource: 'approvals', action: 'decide' } as const;

/** Real org-scope AuthContext for the requester, same shape authMiddleware
 * produces (reuses buildOrgAccessClosures so org-access semantics can't drift
 * from the live path). Mirrors the decide-atomicity sibling's helper. */
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
  orgId: string;
  intentId: string;
}

/**
 * Seeds partner + active org + a requester (holding google.execute) + a second
 * eligible approver (holding approvals.decide), creates a real
 * `google_suspend_user` intent via createActionIntent, then drives it to a
 * GENUINE `approved` state that PASSES release-time revalidation: flips the
 * winning approval_requests row to `approved` (its boundArgumentDigest already
 * matches the intent's canonical digest) and CASes the intent
 * pending_approval -> approved. Does NOT seed the Google connection — each case
 * seeds/omits that itself.
 */
async function seedApprovedGoogleIntent(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  // Requester's role: the tool's RBAC permission (revalidation gate e).
  const requesterRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(requesterRole.id, [GOOGLE_EXECUTE]);

  // Approver's role: approvals.decide so resolveIntentApprovers picks them and
  // createActionIntent produces a pending_approval intent (not an
  // auto-cancelled "no eligible approvers" one).
  const approverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(approverRole.id, [APPROVALS_DECIDE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@ghl.test`,
  });
  await assignUserToOrganization(requester.id, org.id, requesterRole.id);

  const approver = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `approver-${randomUUID()}@ghl.test`,
  });
  await assignUserToOrganization(approver.id, org.id, approverRole.id);

  const auth = requesterAuth(
    { id: requester.id, email: requester.email },
    org.id,
    partner.id,
    requesterRole.id,
  );

  const snapshot = await createActionIntent(auth, {
    toolName: TOOL_NAME,
    input: { userEmail: 'target@customer.example', reason: 'offboarding' },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  expect(snapshot.approvalRequestIds.length).toBeGreaterThan(0);

  // Drive to a real `approved`: the winning approval row + the intent CAS,
  // exactly the two facts revalidation reads (winningApproval.status='approved'
  // with boundArgumentDigest === intent.argumentDigest).
  await withSystemDbAccessContext(async () => {
    await db
      .update(approvalRequests)
      .set({ status: 'approved' })
      .where(eq(approvalRequests.intentId, snapshot.id));
  });
  const promoted = await transitionIntent(snapshot.id, 'pending_approval', 'approved', {
    decidedAt: new Date(),
    decidedByUserId: approver.id,
  });
  expect(promoted).toBe(true);

  return { orgId: org.id, intentId: snapshot.id };
}

/** Seed the org's single Google connection (encrypted SA key). Returns nothing;
 * the key content is irrelevant because getDirectoryClient is mocked — but the
 * decrypt must SUCCEED for the connection to be considered available. */
async function seedGoogleConnection(orgId: string, status: 'active' | 'inactive'): Promise<void> {
  const encryptedKey = encryptSecret('{"fake":"key"}');
  await getTestDb()
    .insert(googleWorkspaceConnections)
    .values({
      orgId,
      customerDomain: 'customer.example',
      adminEmail: 'admin@customer.example',
      serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com',
      serviceAccountKey: encryptedKey!,
      status,
    });
}

async function readIntent(intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(actionIntents)
      .where(eq(actionIntents.id, intentId))
      .limit(1);
    return row!;
  });
}

beforeEach(() => {
  h.usersUpdate.mockClear();
  h.usersUpdate.mockResolvedValue({ data: {} });
});

describe('releaseApprovedIntent headless Google dispatch (real Postgres, breeze_app)', () => {
  it('happy path: an approved Google Tier-3 intent runs headlessly to completed — NOT session_required', async () => {
    const { orgId, intentId } = await seedApprovedGoogleIntent();
    await seedGoogleConnection(orgId, 'active');

    await releaseApprovedIntent(intentId);

    // Core proof #1: the real Google mutation actually fired (headless
    // execution happened, not a skip/fail before execution).
    expect(h.usersUpdate).toHaveBeenCalledTimes(1);
    expect(h.usersUpdate).toHaveBeenCalledWith({
      userKey: 'target@customer.example',
      requestBody: { suspended: true },
    });

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('completed');
    expect(intent.errorCode).toBeNull();
    expect(intent.executedAt).not.toBeNull();

    // Core proof #2 (race-fix essence, folded in): the terminal state is a
    // genuine completion, NOT the pre-Phase-2 false-fail. Asserted explicitly
    // and discriminatingly — errorCode is null (so it can't be session_required
    // OR connection_unavailable OR any revalidation stop). Folded into the
    // happy-path case rather than duplicated as a near-identical test, because
    // in the integration context the worker never holds a live session, so
    // "worker wins CAS over a live session" isn't separately reproducible — the
    // meaningful proof is "approved Google intent with no session → completed,
    // not session_required", which these assertions already make.
    expect(intent.errorCode).not.toBe('session_required');
  });

  it('revoked after approval: an inactive connection fails connection_unavailable with NO Google call', async () => {
    const { orgId, intentId } = await seedApprovedGoogleIntent();
    // Connection exists but was deactivated during the approval wait —
    // authorizeGoogleConnection rejects a non-'active' status, so
    // resolveContextByOrg returns an error and the worker fails closed BEFORE
    // any outbound Google call.
    await seedGoogleConnection(orgId, 'inactive');

    await releaseApprovedIntent(intentId);

    // No stale execution: the API must never have been touched.
    expect(h.usersUpdate).not.toHaveBeenCalled();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('connection_unavailable');
  });
});
