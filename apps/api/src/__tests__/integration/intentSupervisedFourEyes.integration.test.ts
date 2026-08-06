/**
 * Real-Postgres end-to-end coverage for the tier3-supervised-four-eyes split
 * (spec docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md)
 * that the earlier per-task suites do NOT already exercise:
 *
 *   (a) a `four_eyes` intent fans out approval rows to BOTH other eligible
 *       admins and creates NONE for the requester (the multi-approver branch,
 *       `services/actionIntents/intentService.ts` lines ~541-547) — distinct
 *       from `approvalsDecideAtomicity.integration.test.ts`'s two-approver
 *       fixture, which asserts row COUNT but never asserts WHICH users own
 *       the rows or that the requester is excluded.
 *   (b) a `four_eyes` approval decided at t+30min — past the OLD 5-minute
 *       supervised-style window, but inside the NEW 60-minute four_eyes
 *       window (`FOUR_EYES_CHAT_EXPIRY_MS`, intentService.ts) — still
 *       succeeds and the durable release worker (`intentReleaseWorker.ts`)
 *       actually executes it. Timestamps are moved by direct DB UPDATE
 *       (real elapsed-time simulation), not a mocked clock, so the decide
 *       route's genuine `expiresAt <= new Date()` comparison and the
 *       worker's genuine `release_by`-gated claim CAS are both exercised
 *       against real Postgres `now()`.
 *   (c) when the only OTHER eligible approver is a disabled admin,
 *       `resolveIntentApprovers`' `status = 'active'` join filters them out
 *       and the sole-operator fallback engages for the requester — who still
 *       gets a `four_eyes`-scoped row (not reclassified `supervised`).
 *
 * `approvalsDecideSupervised.integration.test.ts` already covers the
 * supervised happy-path + revoked-permission; `approvalsDecideAtomicity.
 * integration.test.ts` already covers the fan-in fault-injection rollback.
 * Neither touches the elapsed-time release path or the disabled-admin
 * fallback, which is what this file adds.
 *
 * Lives under `src/__tests__/integration/`, which both `src/**\/*.test.ts`
 * wildcards (`vitest.integration.config.ts`'s `include` glob and
 * `vitest.config.ts`'s wholesale `src/__tests__/integration/**` exclude)
 * already cover automatically — unlike the co-located route/job suites this
 * file's header cites, it needs no explicit per-file dual-hand-list entry.
 * Named explicitly in `vitest.integration.config.ts`'s `include` anyway,
 * purely for discoverability (the same pattern `staleBackupReaper.
 * integration.test.ts` uses).
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

// Mock the Google SDK client at construction ONLY, exactly like
// intentReleaseWorkerGoogleHeadless.integration.test.ts — the real connection
// load + secret decrypt + org RLS read still run against Postgres; only the
// outbound Google API call is faked. Hoisted so the (hoisted) vi.mock factory
// can close over the same spy the assertions read.
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
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { googleWorkspaceConnections } from '../../db/schema/google';
import { encryptSecret } from '../../services/secretCrypto';
import { createActionIntent } from '../../services/actionIntents/intentService';
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

// google_suspend_user is TIER3_FOUR_EYES_TOOLS-classified (aiGuardrails.ts)
// and headless-executable (Phase 2), giving this suite a real end-to-end
// worker path to prove execution without faking anything but the outbound
// Google network call.
const TOOL_NAME = 'google_suspend_user';
const GOOGLE_EXECUTE = { resource: 'google', action: 'execute' } as const;

const THIRTY_MIN_MS = 30 * 60 * 1000;

/** Real org-scope AuthContext, same shape authMiddleware produces (reuses
 * buildOrgAccessClosures so org-access semantics can't drift from the live
 * path). Mirrors the sibling decide-path integration suites' helper. */
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

/** A real access token, minted the same way the sibling decide-path suites'
 * approverAccessToken/requesterAccessToken helpers are. */
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

interface TwoAdminScenario {
  partnerId: string;
  orgId: string;
  requester: { id: string; email: string };
  requesterRoleId: string;
  admin1: { id: string; email: string };
  admin2: { id: string; email: string };
  adminRoleId: string;
}

/**
 * Seeds one org under one partner + a requester (holding google:execute,
 * the RBAC entry TOOL_PERMISSIONS maps google_suspend_user to — needed for
 * both the create-path and the release worker's requester-RBAC revalidation)
 * plus TWO active admins sharing one org role that holds approvals:decide —
 * the population that fans a four_eyes intent out to exactly two rows,
 * neither of them the requester.
 */
async function seedTwoAdminScenario(): Promise<TwoAdminScenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const requesterRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(requesterRole.id, [GOOGLE_EXECUTE]);

  const adminRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(adminRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@fourEyes.test`,
  });
  await assignUserToOrganization(requester.id, org.id, requesterRole.id);

  const admin1 = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `admin1-${randomUUID()}@fourEyes.test`,
  });
  await assignUserToOrganization(admin1.id, org.id, adminRole.id);

  const admin2 = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `admin2-${randomUUID()}@fourEyes.test`,
  });
  await assignUserToOrganization(admin2.id, org.id, adminRole.id);

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: requesterRole.id,
    admin1: { id: admin1.id, email: admin1.email },
    admin2: { id: admin2.id, email: admin2.email },
    adminRoleId: adminRole.id,
  };
}

async function createFourEyesIntent(s: TwoAdminScenario): Promise<{
  intentId: string;
  approvalRequestIds: string[];
}> {
  const auth = orgAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId);
  const snapshot = await createActionIntent(auth, {
    toolName: TOOL_NAME,
    input: { userEmail: 'target@customer.example', reason: 'offboarding' },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  return { intentId: snapshot.id, approvalRequestIds: snapshot.approvalRequestIds };
}

/** Seed the org's single Google connection (encrypted SA key). The key
 * content is irrelevant because getDirectoryClient is mocked — but the
 * decrypt must SUCCEED for the connection to be considered available. */
async function seedGoogleConnection(orgId: string): Promise<void> {
  const encryptedKey = encryptSecret('{"fake":"key"}');
  await getTestDb()
    .insert(googleWorkspaceConnections)
    .values({
      orgId,
      customerDomain: 'customer.example',
      adminEmail: 'admin@customer.example',
      serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com',
      serviceAccountKey: encryptedKey!,
      status: 'active',
    });
}

/**
 * Backdates a pending four_eyes intent's approval window by 30 minutes:
 * `approval_requests.created_at` moves 30 minutes into the past and
 * `approval_requests.expires_at` moves 30 minutes EARLIER than it was (from
 * now+60min to now+30min) — simulating that decide is happening at t+30min
 * of the 60-minute four_eyes window, not t+0. Direct DB timestamp
 * manipulation (not a mocked clock), matching the pattern the task brief
 * calls for: the whole point is to prove the REAL `expiresAt <= new Date()`
 * comparison in the decide route (`approvalRequests.expiresAt`, the column it
 * actually reads) still passes 30 minutes in.
 *
 * `action_intents.approval_expires_at` is mirrored the same way for
 * narrative consistency (nothing on the decide/release path reads it), but
 * `action_intents.created_at`/`expires_at` are deliberately left untouched:
 * a DB-level immutability trigger (`action_intents_block_content_update`,
 * migration 2026-08-14-intent-approval-scope-and-deadlines.sql) blocks any
 * UPDATE touching those two columns with `action_intents content is
 * immutable` — `approval_expires_at` is not in that trigger's guarded column
 * list, so it alone is safely mutable here.
 */
async function backdateThirtyMinutes(intentId: string): Promise<void> {
  const now = Date.now();
  await withSystemDbAccessContext(async () => {
    await db
      .update(actionIntents)
      .set({
        approvalExpiresAt: new Date(now + THIRTY_MIN_MS),
      })
      .where(eq(actionIntents.id, intentId));
    await db
      .update(approvalRequests)
      .set({
        createdAt: new Date(now - THIRTY_MIN_MS),
        expiresAt: new Date(now + THIRTY_MIN_MS),
      })
      .where(eq(approvalRequests.intentId, intentId));
  });
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

async function readIntent(intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row!;
  });
}

beforeEach(() => {
  h.usersUpdate.mockClear();
  h.usersUpdate.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tier3-supervised-four-eyes split: end-to-end coverage (real Postgres, breeze_app)', () => {
  runDb(
    'four_eyes fan-out: rows land for BOTH admins, none for the requester',
    async () => {
      const s = await seedTwoAdminScenario();
      const { intentId, approvalRequestIds } = await createFourEyesIntent(s);

      expect(approvalRequestIds).toHaveLength(2);

      const [intent] = await withSystemDbAccessContext(() =>
        db.select({ approvalScope: actionIntents.approvalScope }).from(actionIntents).where(eq(actionIntents.id, intentId)),
      );
      expect(intent?.approvalScope).toBe('four_eyes');

      const rows = await withSystemDbAccessContext(() =>
        db
          .select({ userId: approvalRequests.userId })
          .from(approvalRequests)
          .where(eq(approvalRequests.intentId, intentId)),
      );
      const ownerIds = rows.map((r) => r.userId).sort();
      expect(ownerIds).toEqual([s.admin1.id, s.admin2.id].sort());
      expect(ownerIds).not.toContain(s.requester.id);

      const requesterRows = await withSystemDbAccessContext(() =>
        db
          .select({ id: approvalRequests.id })
          .from(approvalRequests)
          .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, s.requester.id))),
      );
      expect(requesterRows).toHaveLength(0);
    },
  );

  runDb(
    'four_eyes approve at t+30min (past the old 5-min window, inside the 60-min four_eyes window) — release worker executes it',
    async () => {
      const s = await seedTwoAdminScenario();
      await seedGoogleConnection(s.orgId);
      const { intentId, approvalRequestIds } = await createFourEyesIntent(s);
      expect(approvalRequestIds).toHaveLength(2);

      await backdateThirtyMinutes(intentId);

      const [admin1Row] = await withSystemDbAccessContext(() =>
        db
          .select({ id: approvalRequests.id })
          .from(approvalRequests)
          .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, s.admin1.id))),
      );
      expect(admin1Row).toBeTruthy();

      // Decide happens at REAL wall-clock "now" — 30 minutes after the
      // (backdated) creation time, still inside the 60-minute four_eyes
      // window (expires_at was moved to now+30min, not into the past).
      const res = await approveViaRoute(s.admin1, s.orgId, s.partnerId, s.adminRoleId, admin1Row!.id);
      expect(res.status).toBe(200);

      const approvedIntent = await readIntent(intentId);
      expect(approvedIntent.status).toBe('approved');
      expect(approvedIntent.releaseBy).toBeInstanceOf(Date);
      // The release lease is stamped fresh off approval time (the "59:59
      // trap" fix, RELEASE_LEASE_MS) — NOT derived from the backdated
      // approval_expires_at — so it must be comfortably in the future.
      expect(approvedIntent.releaseBy!.getTime()).toBeGreaterThan(Date.now());

      // Sibling expiry: admin2's row is expired in the same commit.
      const [admin2Row] = await withSystemDbAccessContext(() =>
        db
          .select({ status: approvalRequests.status })
          .from(approvalRequests)
          .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, s.admin2.id))),
      );
      expect(admin2Row?.status).toBe('expired');

      // The durable release worker (no BullMQ needed — releaseApprovedIntent
      // is the exact function the real worker's job processor calls) claims
      // the still-fresh release_by lease and runs the tool for real.
      await releaseApprovedIntent(intentId);

      expect(h.usersUpdate).toHaveBeenCalledTimes(1);
      expect(h.usersUpdate).toHaveBeenCalledWith({
        userKey: 'target@customer.example',
        requestBody: { suspended: true },
      });

      const executedIntent = await readIntent(intentId);
      expect(executedIntent.status).toBe('completed');
      expect(executedIntent.errorCode).toBeNull();
      expect(executedIntent.executedAt).not.toBeNull();
    },
  );

  runDb(
    'disabled second admin: sole-operator fallback engages for the requester, still four_eyes-scoped',
    async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      // ONE role holding approvals:decide, shared by the requester (making
      // them eligible) and a second admin who is DISABLED.
      // resolveIntentApprovers' `users.status = 'active'` join (intentApprovers.ts)
      // filters the disabled admin out of the eligible set entirely — not just
      // out of the fan-out, but out of "is anyone else eligible" too, which is
      // exactly what lets the sole-operator branch engage instead of the
      // no-eligible-approvers cancel path.
      const adminRole = await createRole({ scope: 'organization', orgId: org.id });
      await grantRolePermissions(adminRole.id, [PERMISSIONS.APPROVALS_DECIDE, GOOGLE_EXECUTE]);

      const requester = await createUser({
        partnerId: partner.id,
        orgId: org.id,
        email: `requester-${randomUUID()}@soleop.test`,
      });
      await assignUserToOrganization(requester.id, org.id, adminRole.id);

      const disabledAdmin = await createUser({
        partnerId: partner.id,
        orgId: org.id,
        email: `disabled-admin-${randomUUID()}@soleop.test`,
        status: 'disabled',
      });
      await assignUserToOrganization(disabledAdmin.id, org.id, adminRole.id);

      const auth = orgAuth(
        { id: requester.id, email: requester.email },
        org.id,
        partner.id,
        adminRole.id,
      );
      const snapshot = await createActionIntent(auth, {
        toolName: TOOL_NAME,
        input: { userEmail: 'target@customer.example', reason: 'offboarding' },
        source: 'chat',
      });

      // Sole-operator fallback: exactly one row, owned by the requester —
      // NOT the no-eligible-approvers auto-cancel (which would land here if
      // the disabled admin were still counted as "someone else exists").
      expect(snapshot.status).toBe('pending_approval');
      expect(snapshot.approvalRequestIds).toHaveLength(1);
      expect(snapshot.requesterApprovalRequestId).toBe(snapshot.approvalRequestIds[0]);

      const [intent] = await withSystemDbAccessContext(() =>
        db
          .select({ approvalScope: actionIntents.approvalScope })
          .from(actionIntents)
          .where(eq(actionIntents.id, snapshot.id)),
      );
      // Still four_eyes — the sole-operator branch is a fan-out shortcut
      // inside the four_eyes classification, never a reclassification to
      // supervised (that would silently drop the assurance/step-up ladder
      // the decide route's sole-operator branch enforces).
      expect(intent?.approvalScope).toBe('four_eyes');

      const rows = await withSystemDbAccessContext(() =>
        db
          .select({ userId: approvalRequests.userId })
          .from(approvalRequests)
          .where(eq(approvalRequests.intentId, snapshot.id)),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(requester.id);
    },
  );
});
