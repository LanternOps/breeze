import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  // Pass-throughs: the post-commit sibling-expiry wraps its db.update in
  // runOutsideDbContext(() => withSystemDbAccessContext(...)). Unwrapping both
  // lets the mocked db.update run inline so tests can assert on it (same shape
  // as the other route tests that mock these helpers).
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
}));

vi.mock('../services/expoPush', () => ({
  dispatchApprovalPush: vi.fn(async () => ({ tokensFound: 1, dispatched: 1, errors: 0 })),
  sendExpoPush: vi.fn(async () => [{ status: 'ok', id: 'tk' }]),
  getUserPushTokens: vi.fn(async () => []),
  buildApprovalPush: vi.fn(() => ({
    title: 'Approval requested',
    body: 'Dev Seed: x',
    data: { type: 'approval', approvalId: 'a1' },
  })),
}));

vi.mock('../db/schema/approvals', () => ({
  approvalRequests: {
    id: 'id',
    elevationRequestId: 'elevation_request_id',
    intentId: 'intent_id',
    status: 'status',
  },
}));

vi.mock('../db/schema/actionIntents', () => ({
  actionIntents: {
    id: 'id',
    orgId: 'org_id',
    status: 'status',
  },
  intentOutbox: {
    id: 'id',
    intentId: 'intent_id',
    eventType: 'event_type',
    payload: 'payload',
  },
}));

// The decide handler performs the intent CAS INLINE inside the single
// system-scoped fan-in transaction (not a separate transitionIntent call), so
// the CAS itself is asserted directly on the mocked tx.update below. Task 5
// adds one lightweight import from intentService.ts — the RELEASE_LEASE_MS
// constant, stamped into release_by on an approval win — so this mocks the
// module wholesale rather than letting the real one load: the real
// intentService.ts pulls in ../aiTools (and its whole dependency graph),
// which this file's narrow ../services/permissions mock below (missing the
// PERMISSIONS export routes/monitors.ts needs at import time) can't support.
vi.mock('../services/actionIntents/intentService', () => ({
  RELEASE_LEASE_MS: 10 * 60 * 1000,
}));

vi.mock('../services/actionIntents/metrics', () => ({
  recordActionIntentEvent: vi.fn(),
}));

// Task 6: the supervised branch re-checks live RBAC for the underlying tool
// action via checkToolPermission (aiGuardrails) + buildAuthContextForIntent
// (actorContext) — mocked wholesale for the SAME reason intentService is
// above: the real aiGuardrails.ts pulls in ../aiTools's whole dependency
// graph, which this file's narrow ../services/permissions mock can't support.
// Defaults are the PERMISSIVE case (a still-authorized requester); the
// RBAC-revoked test overrides checkToolPermission to return a denial string.
vi.mock('../services/aiGuardrails', () => ({
  checkToolPermission: vi.fn(async () => null),
}));

vi.mock('../services/actionIntents/actorContext', () => ({
  buildAuthContextForIntent: vi.fn(async () => ({
    principal: { kind: 'user_session' },
    user: { id: '00000000-0000-0000-0000-000000000001', email: 'req@example.com', name: 'Requester', isPlatformAdmin: false },
    token: { sub: '00000000-0000-0000-0000-000000000001', email: 'req@example.com', roleId: 'role-1', orgId: 'org-9', partnerId: null, scope: 'organization', type: 'access', mfa: true },
    partnerId: null,
    orgId: 'org-9',
    scope: 'organization',
    accessibleOrgIds: ['org-9'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: null,
    canAccessSite: () => true,
  })),
}));

// Fix round 1, finding 5: a supervised approve now checks whether the
// partner's authenticator policy is actively ENFORCING before skipping the
// assurance ladder. Mocked wholesale (loadPartnerPolicy does a real DB read
// this file's mocked `db` can't usefully back) with a permissive default
// (non-enforcing, i.e. every existing "plain click" supervised test keeps its
// behavior) — the two Task 6 enforcing/non-enforcing tests override
// `isEnforcing` directly.
vi.mock('../services/authenticatorPolicy', () => ({
  loadPartnerPolicy: vi.fn(async () => null),
  isEnforcing: vi.fn(() => false),
}));

// #2685: the decide handler RE-DERIVES the eligible approver set before
// permitting a self-approve, instead of inferring sole-operator status from
// "a requester-owned row exists". Default: the deciding user is the only
// eligible approver (the genuine sole-operator org), so the pre-existing
// sole-operator tests keep their behaviour; the refusal test overrides it.
vi.mock('../services/actionIntents/intentApprovers', () => ({
  // Literal id, not TEST_USER — vi.mock factories are hoisted above the const.
  resolveIntentApprovers: vi.fn(async () => ['00000000-0000-0000-0000-000000000001']),
  // Wave 3b Task 6: agent-originated supervised intents are decided via
  // action-and-target authority (not approvals:decide, not requester
  // identity). Permissive default (an eligible decider); the ineligible-
  // decider tests override it per-case.
  isAgentIntentDecideAuthorized: vi.fn(async () => true),
}));

// The decide handler re-resolves the DECIDER's live authorization before an
// intent-backed approve (approvals:decide + org access). Mocked as a
// collaborator with permissive defaults (a still-authorized approver); the
// unauthorized-approver test overrides these to drive the 403.
vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(async () => ({
    scope: 'organization',
    orgId: 'org-1',
    permissions: [{ resource: 'approvals', action: 'decide' }],
  })),
  userCanDecideApprovals: vi.fn(() => true),
  canAccessOrg: vi.fn(() => true),
}));

vi.mock('../db/schema/elevations', () => ({
  elevationRequests: {
    id: 'id', orgId: 'org_id', deviceId: 'device_id', status: 'status',
    revision: 'revision', targetExecutablePath: 'target_executable_path',
    targetExecutableHash: 'target_executable_hash', subjectUsername: 'subject_username',
  },
  elevationAudit: { id: 'id', orgId: 'org_id', elevationRequestId: 'elevation_request_id' },
}));

vi.mock('../db/schema/authenticatorDevices', () => ({
  authenticatorDevices: {
    id: 'id',
    userId: 'user_id',
    credentialId: 'credential_id',
    kind: 'kind',
    transports: 'transports',
    disabledAt: 'disabled_at',
  },
}));

vi.mock('../db/schema/ai', () => ({
  aiToolExecutions: { id: 'id', sessionId: 'session_id' },
  aiSessions: { id: 'id', delegantM365ConnectionId: 'delegant_m365_connection_id' },
}));

vi.mock('../db/schema/delegant', () => ({
  delegantM365Connections: { id: 'id', customerDisplayName: 'customer_display_name' },
}));

vi.mock('../db/schema/audit', () => ({
  auditLogs: {},
}));

vi.mock('./lifecycle', () => ({
  revokeUserOauthClient: vi.fn(async () => ({ grantsRevoked: 1, refreshTokensRevoked: 1 })),
  // Not used by approvals.ts but exported from lifecycle.ts; mocked to avoid
  // pulling in the full lifecycle module-init chain in this test surface.
  isOauthClientBlockedForOrg: vi.fn(async () => false),
}));

const pamLifecycleMocks = vi.hoisted(() => ({ createPamDecisionIntent: vi.fn() }));
vi.mock('../services/pamActuationLifecycle', () => pamLifecycleMocks);
pamLifecycleMocks.createPamDecisionIntent.mockImplementation(async (_tx, input) => ({
  actuationId: 'actuation-1',
  elevationRequestId: input.request.id,
  requestRevision: input.requestRevision,
  generation: 1,
  desiredState: input.decision === 'denied' ? 'cleanup' : 'active',
}));

// Phase 2: the decide path now resolves assurance through assertApprovalAssurance
// (verifies an optional browser proof). Default the no-proof L1 result; tests
// override per-case. resolveApprovalAssurance is still re-exported for any callers.
vi.mock('../services/authenticatorAssurance', () => ({
  resolveApprovalAssurance: vi.fn((riskTier: string) => ({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  })),
  assertApprovalAssurance: vi.fn(async () => ({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  })),
  // Real error classes so the route's `instanceof` checks resolve (the route
  // imports StepUpRequiredError for the Phase 4 403 mapping and
  // ReauthRequiredError for the critical-tier 401 'reauth_required' mapping).
  StepUpRequiredError: class StepUpRequiredError extends Error {
    constructor(public requiredLevel: number, public achievedLevel: number) {
      super('step-up required');
      this.name = 'StepUpRequiredError';
    }
  },
  ReauthRequiredError: class ReauthRequiredError extends Error {
    constructor() {
      super('fresh account re-authentication required for this approval');
      this.name = 'ReauthRequiredError';
    }
  },
}));

// The approve route imports requireCurrentPasswordStepUp from ./auth/helpers
// (L4 re-auth). Stub it so the heavy services barrel that helpers pulls in does
// not load into this suite. Default: password verification passes (returns
// null). Only invoked when a reauthPassword is present in the body.
vi.mock('./auth/helpers', () => ({
  requireCurrentPasswordStepUp: vi.fn(async () => null),
}));

vi.mock('../services/approverWebAuthn', () => ({
  generateApprovalAssertionOptions: vi.fn(async () => ({
    challenge: 'chal-xyz',
    rpId: 'breeze.test',
    allowCredentials: [{ id: 'cred-1', transports: ['internal'] }],
    userVerification: 'required',
  })),
}));

vi.mock('../services/mobileHwKey', () => ({
  issueMobileAssertionNonce: vi.fn(async () => 'mobile-nonce-xyz'),
}));

const TEST_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 't@example.com',
  name: 'Test User',
  isPlatformAdmin: false,
};

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      // Wave 3b Task 6: the decide handler now asserts a human principal
      // (`human_decision_required`), so the default mocked auth context must
      // carry the interactive-session discriminator the real middleware sets.
      principal: { kind: 'user_session' },
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      user: TEST_USER,
      accessibleOrgIds: [],
      canAccessOrg: () => false,
      orgCondition: () => undefined,
    });
    return next();
  }),
  // Same rule as the real helper (middleware/auth.ts): an allowlist of ONE.
  isInteractiveUserSession: (auth: any) => auth?.principal?.kind === 'user_session',
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { and, eq } from 'drizzle-orm';
import { approvalRoutes } from './approvals';
import { approvalRequests } from '../db/schema/approvals';
import { actionIntents } from '../db/schema/actionIntents';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { assertApprovalAssurance, StepUpRequiredError, ReauthRequiredError } from '../services/authenticatorAssurance';
import { generateApprovalAssertionOptions } from '../services/approverWebAuthn';
import { issueMobileAssertionNonce } from '../services/mobileHwKey';
import { requireCurrentPasswordStepUp } from './auth/helpers';
import { recordActionIntentEvent } from '../services/actionIntents/metrics';
import { getUserPermissions, userCanDecideApprovals, canAccessOrg } from '../services/permissions';
import { resolveIntentApprovers, isAgentIntentDecideAuthorized } from '../services/actionIntents/intentApprovers';
import { checkToolPermission } from '../services/aiGuardrails';
import { buildAuthContextForIntent } from '../services/actionIntents/actorContext';
import { loadPartnerPolicy, isEnforcing } from '../services/authenticatorPolicy';

function buildApp() {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app;
}

function mockUpdateReturning(rows: unknown[]) {
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
  });
  vi.mocked(db.update).mockReturnValue({ set } as any);
  return set;
}

// Wires the decideHandler flow: a pre-fetch select followed by the Task 6
// atomic decide-write transaction (ONE `db.transaction` call, whose `tx` does
// a SINGLE `.update(approvalRequests)` for the approval-row CAS — the plain,
// non-intent/non-execution/non-elevation-linked case). Returns the captured
// `.set(...)` argument so callers can assert the factor columns persisted
// alongside status/decidedAt.
//
// Uses persistent `mockReturnValue`/`mockImplementation` (NOT the `Once`
// variants) on purpose: `vi.clearAllMocks()` in beforeEach clears call history
// but does NOT drain a queued `mockReturnValueOnce`, so an early-return decide
// case (404/409/410 never opens the transaction at all) would otherwise leave
// an unconsumed once-mock in the queue and poison a later test.
function mockDecideFlow(opts: {
  existing: unknown | null;
  updateReturns: unknown[];
}) {
  // 1) pre-fetch select (existing row, or [] for 404)
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(opts.existing ? [opts.existing] : []),
    }),
  } as any);

  // 2) the atomic decide-write transaction — capture the tx.update `.set(...)` arg
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(opts.updateReturns),
    }),
  });
  const tx = { update: vi.fn(() => ({ set })) };
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
  return set;
}

// Fix round 1, finding 3: the ai_tool_executions mirror's WHERE clause now
// embeds an `exists(tx.select(...).from(aiSessions).where(...))` tenant/
// linkage guard, built synchronously while the WHERE expression is
// constructed. Real Drizzle's `exists()` just wraps whatever it's given into
// a `sql` template fragment (drizzle-orm/sql/expressions/conditions.js) — it
// never calls anything on it — so `tx.select(...)` only needs to be a
// callable chain here, never actually awaited by this stub.
function txSelectExistsStub() {
  return vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({})) })) }));
}

// Fix round 1, finding 2: an intent-linked decide-write tx now takes a
// `SELECT ... FOR UPDATE` lock on the intent row as its FIRST statement
// (lock-order fix — see the route's own comment). This IS awaited directly,
// so the stub's `.for(...)` must resolve.
// Fix round 2, finding 2: report-suspicious now READS the locked intent row's
// status from this same statement, so it must resolve a row (the decide
// handler only selects `{id}` from it and ignores the result). Override the
// resolved value per-test to simulate a concurrent decide having already
// carried the intent to a terminal state.
function txSelectForUpdateStub(rows: unknown[] = [{ id: 'intent-1', status: 'pending_approval' }]) {
  return vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ for: vi.fn().mockResolvedValue(rows) })) })),
  }));
}

// Wires the Task 6 atomic decide-write tx with TWO sequential `tx.update`
// calls: (1) the approval-row CAS, (2) the ai_tool_executions mirror. Used by
// both the approve and deny ai_tool_executions-mirror tests. These rows carry
// executionId (never intentId — mutually exclusive), so the tx never takes
// the finding-2 intent lock, but it DOES reach the finding-3 exists() guard.
function mockDecideTxWithExecutionMirror(opts: {
  linkedRow: unknown;
  aiReturning: unknown[];
}) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ ...(opts.linkedRow as object), status: 'pending' }]),
    }),
  } as any);
  const approvalReturning = vi.fn().mockResolvedValue([opts.linkedRow]);
  const approvalSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: approvalReturning }),
  });
  const aiReturning = vi.fn().mockResolvedValue(opts.aiReturning);
  const aiSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: aiReturning }),
  });
  const tx = {
    select: txSelectExistsStub(),
    update: vi
      .fn()
      .mockReturnValueOnce({ set: approvalSet } as any) // 1) approval_requests CAS
      .mockReturnValueOnce({ set: aiSet } as any), // 2) ai_tool_executions mirror
  };
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
  return { approvalSet, aiSet, aiReturning };
}

function mockSelectResolves(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

// Mocks the customer-tenant join chain used by lookupCustomerTenants:
//   db.select({...}).from(...).innerJoin(...).innerJoin(...).where(...)
function mockTenantJoinResolves(rows: unknown[]) {
  const innerJoin2 = { where: vi.fn().mockResolvedValue(rows) };
  const innerJoin1 = { innerJoin: vi.fn().mockReturnValue(innerJoin2) };
  return {
    from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue(innerJoin1) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks only clears call history; it does NOT drain a queued
  // mockReturnValueOnce or reset a persistent mockReturnValue. Reset the db
  // method mocks explicitly so neither bleeds across tests (the decide path now
  // pre-fetches via select before the CAS update, so stray queued/persistent
  // returns would otherwise poison later tests like report-suspicious).
  vi.mocked(db.select).mockReset();
  vi.mocked(db.update).mockReset();
  vi.mocked(db.insert).mockReset();
  vi.mocked(db.delete).mockReset();
  vi.mocked(db.transaction).mockReset();
  // Re-establish the default no-proof (L1 session_tap) assurance after
  // clearAllMocks wipes the implementation, so the unchanged approve tests
  // keep recording session_tap and per-case overrides start from a clean slate.
  vi.mocked(assertApprovalAssurance).mockResolvedValue({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  });
  vi.mocked(generateApprovalAssertionOptions).mockResolvedValue({
    challenge: 'chal-xyz',
    rpId: 'breeze.test',
    allowCredentials: [{ id: 'cred-1', transports: ['internal'] }],
    userVerification: 'required',
  } as any);
  // Re-establish the default "password ok" (null = no error) after clearAllMocks
  // wipes the factory implementation; per-case overrides set their own.
  vi.mocked(requireCurrentPasswordStepUp).mockResolvedValue(null);
  // #2685: re-establish the "decider is still the only eligible approver"
  // default after clearAllMocks wipes the factory implementation.
  vi.mocked(resolveIntentApprovers).mockResolvedValue([TEST_USER.id]);
  // Wave 3b Task 6: re-establish the permissive agent-decide default after
  // clearAllMocks wipes the factory implementation.
  vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(true);
  // Task 6: re-establish the supervised-branch live-RBAC defaults (permissive)
  // after clearAllMocks wipes the factory implementation.
  vi.mocked(checkToolPermission).mockResolvedValue(null);
  vi.mocked(buildAuthContextForIntent).mockResolvedValue({
    principal: { kind: 'user_session' },
    user: { id: TEST_USER.id, email: TEST_USER.email, name: TEST_USER.name, isPlatformAdmin: false },
    token: { sub: TEST_USER.id, email: TEST_USER.email, roleId: 'role-1', orgId: 'org-9', partnerId: null, scope: 'organization', type: 'access', mfa: true },
    partnerId: null,
    orgId: 'org-9',
    scope: 'organization',
    accessibleOrgIds: ['org-9'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: null,
    canAccessSite: () => true,
  } as any);
  // Fix round 1, finding 5: re-establish the non-enforcing default after
  // clearAllMocks wipes the factory implementation — every existing
  // supervised "plain click" test relies on this.
  vi.mocked(loadPartnerPolicy).mockResolvedValue(null);
  vi.mocked(isEnforcing).mockReturnValue(false);
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      user: TEST_USER,
      accessibleOrgIds: [],
      canAccessOrg: () => false,
      orgCondition: () => undefined,
    });
    return next();
  });
});

// GET /pending now joins action_intents (Task 8) — db.select() for this
// route returns `{approval, intent}` pairs via a `.from().leftJoin().where()
// .orderBy()` chain, rather than raw approval_requests rows directly.
function mockPendingJoinResolves(rows: Array<{ approval: unknown; intent: unknown | null }>) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as any);
}

function buildPendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    userId: TEST_USER.id,
    requestingClientLabel: 'Claude Desktop',
    requestingMachineLabel: "Todd's MacBook Pro",
    requestingClientId: null,
    requestingSessionId: null,
    actionLabel: 'Delete 4 devices in Acme Corp',
    actionToolName: 'breeze.devices.delete',
    actionArguments: { ids: ['x'] },
    riskTier: 'high',
    riskSummary: 'High impact: deletes data.',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    decidedAt: null,
    decisionReason: null,
    executionId: null,
    intentId: null,
    isRecursive: false,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('GET /approvals/pending', () => {
  it('returns only pending non-expired approvals for the authed user', async () => {
    mockPendingJoinResolves([{ approval: buildPendingApproval(), intent: null }]);

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].id).toBe('a1');
    expect(body.nextCursor).toBeNull();
  });

  it('excludes a four_eyes intent-linked row once the approver no longer holds approvals:decide (demoted approver)', async () => {
    const approval = buildPendingApproval({ id: 'a2', intentId: 'intent-1' });
    const intent = {
      id: 'intent-1',
      orgId: 'org-9',
      status: 'pending_approval',
      approvalScope: 'four_eyes',
      requestedByUserId: 'requester-9',
    };
    mockPendingJoinResolves([{ approval, intent }]);
    // Demoted: still org-accessible but no longer holds approvals:decide.
    vi.mocked(userCanDecideApprovals).mockReturnValueOnce(false);

    const pendingRes = await buildApp().request('/approvals/pending');
    expect(pendingRes.status).toBe(200);
    const pendingBody = await pendingRes.json();
    expect(pendingBody.approvals).toEqual([]);
    expect(pendingBody.nextCursor).toBeNull();

    vi.mocked(userCanDecideApprovals).mockReturnValueOnce(false);
    const countRes = await buildApp().request('/approvals/pending/count');
    expect(countRes.status).toBe(200);
    expect(await countRes.json()).toEqual({ count: 0 });
  });

  it('returns a row for a supervised intent when the caller is still the requester', async () => {
    const approval = buildPendingApproval({ id: 'a3', intentId: 'intent-2' });
    const intent = {
      id: 'intent-2',
      orgId: 'org-9',
      status: 'pending_approval',
      approvalScope: 'supervised',
      requestedByUserId: TEST_USER.id,
    };
    mockPendingJoinResolves([{ approval, intent }]);

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].id).toBe('a3');
  });

  // Task 8 review finding: the projection read intent.approvalScope for its
  // authorization decision and then threw it away, so a client could not tell
  // a supervised row (plain click) from a four_eyes one (may need a step-up).
  it('projects approvalScope onto each serialized row (supervised / four_eyes / null)', async () => {
    mockPendingJoinResolves([
      {
        approval: buildPendingApproval({ id: 'sv', intentId: 'intent-sv', createdAt: new Date(Date.now()) }),
        intent: {
          id: 'intent-sv',
          orgId: 'org-9',
          status: 'pending_approval',
          approvalScope: 'supervised',
          requestedByUserId: TEST_USER.id,
        },
      },
      {
        approval: buildPendingApproval({ id: 'fe', intentId: 'intent-fe', createdAt: new Date(Date.now() - 1000) }),
        intent: {
          id: 'intent-fe',
          orgId: 'org-9',
          status: 'pending_approval',
          approvalScope: 'four_eyes',
          requestedByUserId: 'requester-9',
        },
      },
      { approval: buildPendingApproval({ id: 'plain', createdAt: new Date(Date.now() - 2000) }), intent: null },
    ]);

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals.map((a: any) => [a.id, a.approvalScope])).toEqual([
      ['sv', 'supervised'],
      ['fe', 'four_eyes'],
      ['plain', null],
    ]);
  });

  it('excludes a supervised intent-linked row when the intent is no longer pending_approval', async () => {
    const approval = buildPendingApproval({ id: 'a4', intentId: 'intent-3' });
    const intent = {
      id: 'intent-3',
      orgId: 'org-9',
      status: 'approved',
      approvalScope: 'supervised',
      requestedByUserId: TEST_USER.id,
    };
    mockPendingJoinResolves([{ approval, intent }]);

    const res = await buildApp().request('/approvals/pending');
    const body = await res.json();
    expect(body.approvals).toEqual([]);
  });

  it('paginates a 3-row seed with limit=2, walking the cursor to the last row', async () => {
    const rows = [
      { approval: buildPendingApproval({ id: 'r1', createdAt: new Date('2026-08-05T12:00:03.000Z') }), intent: null },
      { approval: buildPendingApproval({ id: 'r2', createdAt: new Date('2026-08-05T12:00:02.000Z') }), intent: null },
      { approval: buildPendingApproval({ id: 'r3', createdAt: new Date('2026-08-05T12:00:01.000Z') }), intent: null },
    ];
    mockPendingJoinResolves(rows);

    const page1 = await buildApp().request('/approvals/pending?limit=2');
    const body1 = await page1.json();
    expect(body1.approvals.map((a: any) => a.id)).toEqual(['r1', 'r2']);
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await buildApp().request(
      `/approvals/pending?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
    );
    const body2 = await page2.json();
    expect(body2.approvals.map((a: any) => a.id)).toEqual(['r3']);
    expect(body2.nextCursor).toBeNull();
  });

  it('caps limit at 50 even when a larger limit is requested', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      approval: buildPendingApproval({ id: `cap-${i}`, createdAt: new Date(Date.now() - i * 1000) }),
      intent: null,
    }));
    mockPendingJoinResolves(rows);

    const res = await buildApp().request('/approvals/pending?limit=9999');
    const body = await res.json();
    expect(body.approvals).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
  });
});

describe('GET /approvals/pending/count', () => {
  it('returns a bare integer count matching the same filters as /pending', async () => {
    mockPendingJoinResolves([
      { approval: buildPendingApproval({ id: 'c1' }), intent: null },
      { approval: buildPendingApproval({ id: 'c2' }), intent: null },
    ]);

    const res = await buildApp().request('/approvals/pending/count');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
  });
});

describe('GET /approvals/:id', () => {
  it('returns 404 when approval not found', async () => {
    mockSelectResolves([]);

    const res = await buildApp().request('/approvals/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns the approval when found', async () => {
    const approval = {
      id: 'a1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Claude Desktop',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'Reboot devices',
      actionToolName: 'breeze.devices.reboot',
      actionArguments: {},
      riskTier: 'low',
      riskSummary: 'Low risk operation.',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decisionReason: null,
      createdAt: new Date(),
    };
    mockSelectResolves([approval]);

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.id).toBe('a1');
    // Task 9: intentId defaults to null when the row has no intent link.
    expect(body.approval.intentId).toBeNull();
  });

  const intentLinkedApproval = {
    id: 'a1',
    userId: TEST_USER.id,
    requestingClientLabel: 'MCP API client',
    requestingMachineLabel: null,
    requestingClientId: null,
    requestingSessionId: null,
    actionLabel: 'Reboot devices',
    actionToolName: 'breeze.devices.reboot',
    actionArguments: { deviceIds: ['dev-secret-1'] },
    riskTier: 'low',
    riskSummary: 'Low risk operation.',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    decidedAt: null,
    decisionReason: null,
    intentId: 'intent-42',
    createdAt: new Date(),
  };

  // GET /:id now runs the SAME live-authorization filter /pending does, so an
  // intent-linked row needs BOTH selects wired: 1) the approval row, 2) the
  // linked intent (system context, by id).
  function mockDetailWithIntent(intent: unknown | null) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([intentLinkedApproval]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(intent ? [intent] : []),
        }),
      } as any);
  }

  it('serializes intentId so a consumer can correlate an approval row to its intent', async () => {
    mockDetailWithIntent({
      id: 'intent-42',
      orgId: 'org-9',
      status: 'pending_approval',
      approvalScope: 'four_eyes',
      requestedByUserId: 'requester-9',
    });

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.intentId).toBe('intent-42');
  });

  // Task 8 review finding: /pending re-derives each row's authorization live so
  // a demoted four_eyes approver stops seeing its arguments — but the DETAIL
  // endpoint filtered on id+userId only, and a demoted approver still OWNS
  // their pending row. The list hid it while this endpoint handed over
  // actionArguments / actionLabel / riskSummary in full.
  it('404s for a demoted four_eyes approver and never returns the action arguments (live-authz filter)', async () => {
    mockDetailWithIntent({
      id: 'intent-42',
      orgId: 'org-9',
      status: 'pending_approval',
      approvalScope: 'four_eyes',
      requestedByUserId: 'requester-9',
    });
    vi.mocked(userCanDecideApprovals).mockReturnValueOnce(false);

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(raw).not.toContain('dev-secret-1');
    expect(raw).not.toContain('Reboot devices');
  });

  it('404s when a supervised row is fetched by someone who is not the intent requester', async () => {
    mockDetailWithIntent({
      id: 'intent-42',
      orgId: 'org-9',
      status: 'pending_approval',
      approvalScope: 'supervised',
      requestedByUserId: 'someone-else',
    });

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(404);
  });

  it('404s once the linked intent is no longer pending_approval (same rule as /pending)', async () => {
    mockDetailWithIntent({
      id: 'intent-42',
      orgId: 'org-9',
      status: 'approved',
      approvalScope: 'supervised',
      requestedByUserId: TEST_USER.id,
    });

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(404);
  });

  it('serializes approvalScope from the linked intent (supervised)', async () => {
    mockDetailWithIntent({
      id: 'intent-42',
      orgId: 'org-9',
      status: 'pending_approval',
      approvalScope: 'supervised',
      requestedByUserId: TEST_USER.id,
    });

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.approvalScope).toBe('supervised');
  });

  it('serializes approvalScope: null for a row with no linked intent', async () => {
    mockSelectResolves([
      { ...intentLinkedApproval, intentId: null, actionArguments: {} },
    ]);

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.approvalScope).toBeNull();
    // No intent link → no second (intent) select at all.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});

describe('GET /approvals/:id customer tenant (M365)', () => {
  const m365Approval = {
    id: 'a1',
    userId: TEST_USER.id,
    requestingClientLabel: 'Breeze AI',
    requestingMachineLabel: null,
    requestingClientId: null,
    requestingSessionId: null,
    actionLabel: 'Reset M365 password',
    actionToolName: 'm365_reset_password',
    actionArguments: { userPrincipalName: 'jane@example-dental.test' },
    riskTier: 'high',
    riskSummary: 'Reset M365 password for jane@example-dental.test on Example Dental.',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    decidedAt: null,
    decisionReason: null,
    executionId: 'exec-m365',
    isRecursive: false,
    createdAt: new Date(),
  };

  it('serializes customerTenant from the connection for an m365 mutation approval', async () => {
    // 1) approval row select; 2) customer-tenant join chain.
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([m365Approval]),
        }),
      } as any)
      .mockReturnValueOnce(
        mockTenantJoinResolves([
          { executionId: 'exec-m365', customerDisplayName: 'Example Dental' },
        ]) as any,
      );

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.customerTenant).toBe('Example Dental');
  });

  it('serializes customerTenant: null for a non-m365 approval (no tenant lookup)', async () => {
    const nonM365 = {
      ...m365Approval,
      actionToolName: 'breeze.devices.reboot',
      riskSummary: 'Reboot devices.',
    };
    // Only the approval-row select runs; lookupCustomerTenants short-circuits
    // (no m365 tool) and never queries the DB.
    mockSelectResolves([nonM365]);

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.customerTenant).toBeNull();
    // The join select must not have been invoked beyond the single row read.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});

describe('POST /approvals/:id/approve', () => {
  const updatedRow = {
    id: 'a1',
    userId: TEST_USER.id,
    requestingClientLabel: 'Claude Desktop',
    requestingMachineLabel: null,
    requestingClientId: null,
    requestingSessionId: null,
    actionLabel: 'x',
    actionToolName: 'y',
    actionArguments: {},
    riskTier: 'low',
    riskSummary: 'z',
    status: 'approved',
    expiresAt: new Date(Date.now() + 60_000),
    decidedAt: new Date(),
    decisionReason: null,
    createdAt: new Date(),
  };

  it('approves a pending non-expired request', async () => {
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalled();
    const body = await res.json();
    expect(body.approval.id).toBe('a1');
    expect(body.approval.status).toBe('approved');
  });

  it('records session_tap factor columns on approve', async () => {
    const set = mockDecideFlow({
      // No proof + default (non-enforcing) policy → recorded as L1 session_tap
      // even though 'high' would require L3.
      existing: { ...updatedRow, status: 'pending', riskTier: 'high' },
      updateReturns: [{ ...updatedRow, riskTier: 'high' }],
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'approved',
        decidedVia: 'session_tap',
        decidedAssuranceLevel: 1,
        authenticatorDeviceId: null,
      }),
    );
  });

  it('returns 409 with finalStatus when already decided', async () => {
    mockDecideFlow({
      existing: {
        id: 'a1',
        userId: TEST_USER.id,
        status: 'denied',
        riskTier: 'low',
        expiresAt: new Date(Date.now() + 60_000),
      },
      updateReturns: [],
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.finalStatus).toBe('denied');
  });

  it('returns 410 with finalStatus expired when row exists but is expired', async () => {
    mockDecideFlow({
      existing: {
        id: 'a1',
        userId: TEST_USER.id,
        status: 'pending',
        riskTier: 'low',
        expiresAt: new Date(Date.now() - 1000),
      },
      updateReturns: [],
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.finalStatus).toBe('expired');
  });

  it('returns 404 when the approval does not exist for this user', async () => {
    mockDecideFlow({ existing: null, updateReturns: [] });

    const res = await buildApp().request('/approvals/missing/approve', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('mirrors approval to ai_tool_executions when executionId is linked', async () => {
    const linkedRow = { ...updatedRow, executionId: 'exec-42' };
    const { approvalSet, aiSet } = mockDecideTxWithExecutionMirror({
      linkedRow,
      aiReturning: [{ id: 'exec-42' }],
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(approvalSet).toHaveBeenCalled();
    expect(aiSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedBy: TEST_USER.id }),
    );
  });

  it('logs a lost-race warning (not an error) when the ai_tool_executions mirror CAS matches zero rows, and still returns 200 (#3089 review finding)', async () => {
    // The execution row was already closed out (settled/timed out) between
    // the approval_requests CAS and this mirror — status='pending' guard
    // correctly refuses to resurrect it. approval_requests is still the
    // source of truth and correctly recorded THIS decision, so the decide
    // call must still succeed; only the mirror silently lost the race.
    const linkedRow = { ...updatedRow, executionId: 'exec-42' };
    const { aiReturning } = mockDecideTxWithExecutionMirror({ linkedRow, aiReturning: [] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(aiReturning).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ai_tool_executions mirror lost the race'),
      'exec-42',
    );
    warnSpy.mockRestore();
  });
});

describe('POST /approvals/:id/assertion-challenge', () => {
  const pendingRow = {
    id: 'a1',
    userId: TEST_USER.id,
    riskTier: 'high',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
  };

  it('returns assertion options for the caller active approver devices', async () => {
    // 1) pending approval lookup; 2) active webauthn_platform device list;
    // 3) active mobile_hw_key device list (none here → no mobileNonce).
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([pendingRow]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'dev-1', credentialId: 'cred-1', transports: ['internal'] },
          ]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

    const res = await buildApp().request('/approvals/a1/assertion-challenge', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.options.challenge).toBe('chal-xyz');
    expect(generateApprovalAssertionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'a1',
        userId: TEST_USER.id,
        devices: [{ credentialId: 'cred-1', transports: ['internal'] }],
      }),
    );
    // No active mobile_hw_key device → no nonce issued, no mobileNonce field.
    expect(issueMobileAssertionNonce).not.toHaveBeenCalled();
    expect(body.mobileNonce).toBeUndefined();
  });

  it('issues a mobileNonce when the caller has an active mobile_hw_key device', async () => {
    // 1) pending approval lookup; 2) webauthn device list (none);
    // 3) mobile_hw_key device list (one active device).
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([pendingRow]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'mob-1' }]),
        }),
      } as any);

    const res = await buildApp().request('/approvals/a1/assertion-challenge', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(issueMobileAssertionNonce).toHaveBeenCalledWith('a1', TEST_USER.id);
    expect(body.mobileNonce).toBe('mobile-nonce-xyz');
  });

  it('returns 404 when the approval is not pending for this user', async () => {
    mockSelectResolves([]);
    const res = await buildApp().request('/approvals/missing/assertion-challenge', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(generateApprovalAssertionOptions).not.toHaveBeenCalled();
    expect(issueMobileAssertionNonce).not.toHaveBeenCalled();
  });

  // Task 8 review finding: a demoted four_eyes approver still owns their
  // pending row, so without the live-authz filter they could keep burning
  // WebAuthn challenges / mobile nonces against an approval they can no
  // longer act on. Refused BEFORE any challenge is minted.
  it('404s for a demoted four_eyes approver and never mints a challenge or nonce', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ ...pendingRow, intentId: 'intent-42' }]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'intent-42',
              orgId: 'org-9',
              status: 'pending_approval',
              approvalScope: 'four_eyes',
              requestedByUserId: 'requester-9',
            },
          ]),
        }),
      } as any);
    vi.mocked(userCanDecideApprovals).mockReturnValueOnce(false);

    const res = await buildApp().request('/approvals/a1/assertion-challenge', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(generateApprovalAssertionOptions).not.toHaveBeenCalled();
    expect(issueMobileAssertionNonce).not.toHaveBeenCalled();
  });

  it('still mints a challenge for a four_eyes approver who is STILL authorized', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ ...pendingRow, intentId: 'intent-42' }]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'intent-42',
              orgId: 'org-9',
              status: 'pending_approval',
              approvalScope: 'four_eyes',
              requestedByUserId: 'requester-9',
            },
          ]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as any);

    const res = await buildApp().request('/approvals/a1/assertion-challenge', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(generateApprovalAssertionOptions).toHaveBeenCalled();
  });
});

describe('POST /approvals/:id/approve with assertion proof', () => {
  const updatedRow = {
    id: 'a1',
    userId: TEST_USER.id,
    requestingClientLabel: 'Console',
    requestingMachineLabel: null,
    requestingClientId: null,
    requestingSessionId: null,
    actionLabel: 'x',
    actionToolName: 'y',
    actionArguments: {},
    riskTier: 'high',
    riskSummary: 'z',
    status: 'approved',
    expiresAt: new Date(Date.now() + 60_000),
    decidedAt: new Date(),
    decisionReason: null,
    createdAt: new Date(),
  };

  const proof = {
    credentialId: 'cred-1',
    authenticatorData: 'AA',
    clientDataJSON: 'BB',
    signature: 'CC',
    userHandle: null,
  };

  it('records webauthn_platform / L2 when a valid proof is presented', async () => {
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 2,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: 'dev-1',
    });
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof }),
    });
    expect(res.status).toBe(200);
    // Phase 3: the webauthn proof now carries the `type` discriminator (defaulted
    // for back-compat by assertionProofSchema) when threaded to the assurance svc.
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'a1',
        userId: TEST_USER.id,
        proof: { ...proof, type: 'webauthn_platform' },
      }),
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'approved',
        decidedVia: 'webauthn_platform',
        decidedAssuranceLevel: 2,
        authenticatorDeviceId: 'dev-1',
      }),
    );
  });

  it('still records session_tap / L1 when no proof is presented (unchanged)', async () => {
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'a1', userId: TEST_USER.id, proof: undefined }),
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        decidedVia: 'session_tap',
        decidedAssuranceLevel: 1,
        authenticatorDeviceId: null,
      }),
    );
  });

  it('returns 401 assertion_failed when a presented proof fails verification', async () => {
    vi.mocked(assertApprovalAssurance).mockRejectedValueOnce(
      new Error('assertion verification failed'),
    );
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('assertion_failed');
    // A failed assertion is NOT a silent downgrade — the CAS update never runs.
    expect(set).not.toHaveBeenCalled();
  });

  it('returns 403 step_up_required when an enforcing policy rejects the approve (Phase 4)', async () => {
    vi.mocked(assertApprovalAssurance).mockRejectedValueOnce(new StepUpRequiredError(2, 1));
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('step_up_required');
    expect(body.requiredLevel).toBe(2);
    // Enforcement blocks BEFORE the decision is written.
    expect(set).not.toHaveBeenCalled();
  });

  // Phase 3: the approve body accepts the mobile_hw_key proof variant, threaded
  // through to assertApprovalAssurance.
  const mobileProof = {
    type: 'mobile_hw_key',
    credentialId: 'mobile-dev-1',
    nonce: 'server-nonce-xyz',
    signature: 'cmVhbC1zaWc=',
  };

  it('threads a mobile_hw_key proof through to the assurance service (L2)', async () => {
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 2,
      decidedVia: 'mobile_hw_key',
      authenticatorDeviceId: 'mobile-dev-1',
    });
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof }),
    });
    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'a1', userId: TEST_USER.id, proof: mobileProof }),
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        decidedVia: 'mobile_hw_key',
        decidedAssuranceLevel: 2,
        authenticatorDeviceId: 'mobile-dev-1',
      }),
    );
  });

  // L4 re-auth wiring (the gap the assurance redesign fixes): the route must
  // VERIFY a fresh password and thread reauthVerified into the guard — and must
  // NOT thread a challengeIssuedAt (recency is server-derived from the consumed
  // challenge, not route-supplied). Without this wiring a critical approval with
  // a valid signature would 401 forever.
  it('verifies reauthPassword and threads reauthVerified:true (no challengeIssuedAt) into the guard', async () => {
    vi.mocked(requireCurrentPasswordStepUp).mockResolvedValueOnce(null); // password ok
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 4,
      decidedAssuranceLevel: 4,
      decidedVia: 'mobile_hw_key',
      authenticatorDeviceId: 'mobile-dev-1',
    });
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof, reauthPassword: 'hunter2' }),
    });
    expect(res.status).toBe(200);
    expect(requireCurrentPasswordStepUp).toHaveBeenCalledWith(
      expect.anything(),
      TEST_USER.id,
      'hunter2',
      'approval:reauth',
    );
    const call = vi.mocked(assertApprovalAssurance).mock.calls[0]![0];
    expect(call.reauthVerified).toBe(true);
    // recency is server-derived, NEVER route-supplied
    expect('challengeIssuedAt' in call).toBe(false);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ decidedAssuranceLevel: 4 }),
    );
  });

  it('defaults reauthVerified:false when no reauthPassword is supplied', async () => {
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });
    await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof }),
    });
    expect(requireCurrentPasswordStepUp).not.toHaveBeenCalled();
    expect(vi.mocked(assertApprovalAssurance).mock.calls[0]![0].reauthVerified).toBe(false);
    expect(set).toHaveBeenCalled();
  });

  it('returns 401 reauth_required when the guard throws ReauthRequiredError (critical w/o re-auth)', async () => {
    vi.mocked(assertApprovalAssurance).mockRejectedValueOnce(new ReauthRequiredError());
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('reauth_required');
    // re-auth required is NOT a silent downgrade — no decision is written.
    expect(set).not.toHaveBeenCalled();
  });

  it('short-circuits with the helper response when reauthPassword is rejected', async () => {
    // helper returns its own 401 Response for a bad password
    vi.mocked(requireCurrentPasswordStepUp).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof, reauthPassword: 'wrong' }),
    });
    expect(res.status).toBe(401);
    // the assurance guard is never reached, no decision is written
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  // PIN step-up cases removed: the static approver PIN was dropped in favor of
  // the L3-recency / L4-reauth ladder (authenticator registration redesign).
});

describe('POST /approvals/:id/deny', () => {
  it('denies a pending non-expired request', async () => {
    const deniedRow = {
      id: 'a1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Claude Desktop',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'x',
      actionToolName: 'y',
      actionArguments: {},
      riskTier: 'low',
      riskSummary: 'z',
      status: 'denied',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: new Date(),
      decisionReason: 'no thanks',
      createdAt: new Date(),
    };
    mockDecideFlow({
      existing: { ...deniedRow, status: 'pending' },
      updateReturns: [deniedRow],
    });

    const res = await buildApp().request('/approvals/a1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'no thanks' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.status).toBe('denied');
    expect(body.approval.decisionReason).toBe('no thanks');
  });

  it('returns 409 with finalStatus when already decided', async () => {
    mockDecideFlow({
      existing: {
        id: 'a1',
        userId: TEST_USER.id,
        status: 'approved',
        riskTier: 'low',
        expiresAt: new Date(Date.now() + 60_000),
      },
      updateReturns: [],
    });

    const res = await buildApp().request('/approvals/a1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.finalStatus).toBe('approved');
  });

  it('mirrors deny to ai_tool_executions as rejected when executionId is linked', async () => {
    const deniedRow = {
      id: 'a1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Breeze AI',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'x',
      actionToolName: 'execute_command',
      actionArguments: {},
      riskTier: 'high',
      riskSummary: 'z',
      status: 'denied',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: new Date(),
      decisionReason: null,
      executionId: 'exec-77',
      createdAt: new Date(),
    };
    const { aiSet } = mockDecideTxWithExecutionMirror({
      linkedRow: deniedRow,
      aiReturning: [{ id: 'exec-77' }],
    });

    const res = await buildApp().request('/approvals/a1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(aiSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', approvedBy: TEST_USER.id }),
    );
  });
});

describe('#1254 PAM mobile bridge: mirror decision back to elevation', () => {
  let elevationSet = vi.fn();
  let auditValues = vi.fn();

  function mockElevationTx(elevationUpdateRows: unknown[]) {
    elevationSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(elevationUpdateRows) }),
    });
    auditValues = vi.fn().mockResolvedValue(undefined);
    return { elevationSet, auditValues };
  }

  // The decideHandler pre-fetch select + the Task 6 atomic decide-write
  // transaction (the FIRST db.transaction call — approval_requests CAS only,
  // since an elevation-linked row never carries executionId/intentId), then
  // the post-commit system-scoped sibling-expiry (a plain db.update, outside
  // any tx). The updated row carries elevationRequestId so the elevation
  // mirror block runs next (wired separately by mockElevationTx, the SECOND
  // db.transaction call).
  function mockDecideWithElevation(opts: { status: 'pending'; riskTier: string; elevationRequestId: string | null }) {
    const updatedRow = {
      id: 'appr-1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Breeze Agent',
      requestingMachineLabel: 'WS-01',
      actionLabel: 'Elevate setup.exe',
      actionToolName: 'uac_intercept',
      actionArguments: {},
      riskTier: opts.riskTier,
      riskSummary: 'admin requested',
      status: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: new Date(),
      decisionReason: null,
      executionId: null,
      elevationRequestId: opts.elevationRequestId,
      isRecursive: false,
      createdAt: new Date(),
    };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...updatedRow, status: 'pending' }]),
      }),
    } as any);
    // One transaction owns approval CAS, elevation CAS, PAM lifecycle/outbox,
    // audit, and sibling expiry.
    const casReturning = vi.fn().mockResolvedValue([updatedRow]);
    const casSet = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: casReturning }) });
    const siblingExpireSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    let updateCall = 0;
    const mainTx = {
      update: vi.fn(() => {
        updateCall += 1;
        if (updateCall === 1) return { set: casSet } as any;
        if (updateCall === 2) return { set: elevationSet } as any;
        return { set: siblingExpireSet } as any;
      }),
      insert: vi.fn(() => ({ values: auditValues } as any)),
    };
    vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn(mainTx));
    return { updatedRow, casSet, siblingExpireSet };
  }

  it('approve mirrors elevation to approved + expires siblings', async () => {
    const { siblingExpireSet } = mockDecideWithElevation({ status: 'pending', riskTier: 'medium', elevationRequestId: 'elev-1' });
    const tx = mockElevationTx([{ id: 'elev-1', orgId: 'org-9' }]);

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.elevationSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedByUserId: TEST_USER.id }),
    );
    // #1254: the approve grant is bounded (parity with pam.ts's 15-min default),
    // not left open-ended.
    const elevationSetArg = tx.elevationSet.mock.calls[0]![0] as { expiresAt: Date };
    expect(elevationSetArg.expiresAt).toBeInstanceOf(Date);
    expect(elevationSetArg.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(tx.auditValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'approved', actor: 'technician', orgId: 'org-9' }),
    );
    // The sibling-expiry now runs POST-COMMIT in system scope (a second
    // db.update), not as a second tx.update — proving the RLS-fix structure:
    // the Shape-6 sibling rows belong to OTHER approvers, invisible to this
    // user's request context, so the write must be system-scoped.
    expect(siblingExpireSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(pamLifecycleMocks.createPamDecisionIntent).toHaveBeenCalledOnce();
  });

  it('deny mirrors elevation to denied', async () => {
    mockDecideWithElevation({ status: 'pending', riskTier: 'medium', elevationRequestId: 'elev-1' });
    const tx = mockElevationTx([{ id: 'elev-1', orgId: 'org-9' }]);

    const res = await buildApp().request('/approvals/appr-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'not allowed' }),
    });
    expect(res.status).toBe(200);
    expect(tx.elevationSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'denied', deniedByUserId: TEST_USER.id, denialReason: 'not allowed' }),
    );
    expect(tx.auditValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'denied', actor: 'technician' }),
    );
  });

  it('elevation already non-pending (CAS 0 rows) -> decide still 200, no audit/sibling write', async () => {
    const { siblingExpireSet } = mockDecideWithElevation({ status: 'pending', riskTier: 'medium', elevationRequestId: 'elev-1' });
    const tx = mockElevationTx([]); // lost the race

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(tx.elevationSet).toHaveBeenCalled();
    expect(tx.auditValues).not.toHaveBeenCalled();
    // wonElevation stays false on a lost race, so the post-commit sibling-expiry
    // db.update is never invoked.
    expect(siblingExpireSet).not.toHaveBeenCalled();
  });

  it('approval without elevationRequestId never opens the mirror transaction', async () => {
    mockDecideWithElevation({ status: 'pending', riskTier: 'low', elevationRequestId: null });

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    // Only the Task 6 atomic decide-write tx opens (the approval CAS) — the
    // elevation-specific mirror transaction never does, since there is no
    // elevationRequestId to mirror.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('mirror failure rolls the whole decision back and returns retryable 500', async () => {
    mockDecideWithElevation({ status: 'pending', riskTier: 'medium', elevationRequestId: 'elev-1' });
    vi.mocked(db.transaction).mockReset();
    vi.mocked(db.transaction).mockRejectedValueOnce(new Error('tx blew up'));

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'decide_failed', retryable: true });
  });
});

describe('Task 5: decide-handler bound to action_intents', () => {
  // Shared between mockDecideWithIntent and mockIntentFanInTx (below) so the
  // fan-in tx's approval-row CAS return value matches the row the pre-fetch
  // select produced, without threading it through every call site.
  let lastApprovalRow: Record<string, unknown> | undefined;

  // Wires the decideHandler flow for an intent-linked approval row:
  //   1) pre-fetch select (approval_requests, carries intentId + boundArgumentDigest)
  //   2) intent load select (action_intents, by id, system context)
  // The approval_requests CAS itself now runs inline as the FIRST tx.update
  // call inside the Task 6 atomic decide-write transaction — wired by
  // mockIntentFanInTx below, not here. requestedByUserId defaults to someone
  // OTHER than TEST_USER so the sole-operator gate doesn't fire unless a
  // test opts in.
  function mockDecideWithIntent(opts: {
    riskTier?: string;
    requestedByUserId?: string;
    boundArgumentDigest?: string | null;
    intentDigest?: string;
    approvalScope?: 'supervised' | 'four_eyes';
  }) {
    const approvalRow = {
      id: 'appr-1',
      userId: TEST_USER.id,
      requestingClientLabel: 'MCP API client',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'x',
      actionToolName: 'y',
      actionArguments: {},
      riskTier: opts.riskTier ?? 'high',
      riskSummary: 'z',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decisionReason: null,
      executionId: null,
      elevationRequestId: null,
      intentId: 'intent-1',
      boundArgumentDigest:
        opts.boundArgumentDigest === undefined ? 'digest-abc' : opts.boundArgumentDigest,
      isRecursive: false,
      createdAt: new Date(),
    };

    const intentRow = {
      id: 'intent-1',
      orgId: 'org-9',
      actionName: 'y',
      argumentDigest: opts.intentDigest ?? 'digest-abc',
      source: 'mcp_api',
      status: 'pending_approval',
      requestedByUserId: opts.requestedByUserId ?? 'requester-1',
      // Defaults to four_eyes: every pre-existing test in this describe
      // block (including the sole-operator self-approval ones) predates the
      // tier3-supervised-four-eyes split and asserts four_eyes behavior.
      approvalScope: opts.approvalScope ?? 'four_eyes',
    };

    // 1) pre-fetch select
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([approvalRow]),
      }),
    } as any);
    // 2) intent load select (system context, by id)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([intentRow]),
      }),
    } as any);

    lastApprovalRow = approvalRow;
    return { approvalRow, intentRow };
  }

  // Task 6: the WHOLE decision write for an intent-linked row — the
  // approval_requests CAS, the intent CAS (inline, was transitionIntent),
  // sibling expiry, and the intent_approved outbox insert — runs inside ONE
  // `db.transaction` under system context. The tx does up to THREE updates in
  // order (1: approval_requests CAS for the deciding user's own row, 2:
  // action_intents CAS with `.returning({ id })`, 3: approval_requests
  // sibling expiry) plus, on approve, one intent_outbox insert. `casWins`
  // controls whether the intent CAS RETURNING is non-empty; when it loses the
  // race the handler returns early inside the tx (no sibling expiry, no
  // outbox, no metrics) — the approval_requests CAS itself still always wins
  // (this row is exclusively owned by the deciding user).
  function mockIntentFanInTx(opts: { casWins?: boolean } = {}) {
    const casWins = opts.casWins ?? true;

    // 1) approval_requests CAS (the deciding user's own row)
    const approvalCasReturning = vi
      .fn()
      .mockResolvedValue([{ ...(lastApprovalRow ?? {}), status: 'approved' }]);
    const approvalCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: approvalCasReturning }),
    });

    // 2) intent CAS
    const casReturning = vi.fn().mockResolvedValue(casWins ? [{ id: 'intent-1' }] : []);
    const intentCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: casReturning }),
    });

    // 3) sibling expiry
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const outboxValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      // Fix round 1, finding 2: the FIRST statement in an intent-linked
      // decide-write tx is now `SELECT ... FOR UPDATE` on the intent row
      // (lock-order fix), ahead of the three `update` calls below.
      select: txSelectForUpdateStub(),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: approvalCasSet } as any) // 1) approval_requests CAS
        .mockReturnValueOnce({ set: intentCasSet } as any) // 2) intent CAS
        .mockReturnValueOnce({ set: siblingSet } as any), // 3) sibling expiry
      insert: vi.fn(() => ({ values: outboxValues }) as any),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return { approvalCasSet, intentCasSet, siblingSet, outboxValues, tx };
  }

  it('approving an intent-linked row transitions the intent, writes an intent_approved outbox row, and expires siblings', async () => {
    mockDecideWithIntent({ requestedByUserId: 'requester-1' });
    const { intentCasSet, siblingSet, outboxValues, tx } = mockIntentFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);

    // Task 6: the intent CAS is now an inline `tx.update(action_intents)` with
    // the pending_approval -> approved transition, inside the same transaction
    // as the sibling expiry + outbox insert.
    expect(intentCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', decidedByUserId: TEST_USER.id }),
    );
    // Task 5: an approval win stamps the fixed release lease (release_by) in
    // the same CAS, so the reaper/worker have a deadline that starts at the
    // approval moment rather than inheriting the (possibly near-expired)
    // approval_expires_at window — the "59:59 trap".
    const stampedCas = intentCasSet.mock.calls[0]![0] as { releaseBy?: Date };
    expect(stampedCas.releaseBy).toBeInstanceOf(Date);
    expect(stampedCas.releaseBy!.getTime()).toBeGreaterThan(Date.now());
    expect(siblingSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );
    expect(outboxValues).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'intent-1',
        eventType: 'intent_approved',
        payload: { intentId: 'intent-1', orgId: 'org-9' },
      }),
    );
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-9', intentId: 'intent-1', outcome: 'approved' }),
    );
  });

  it('refuses an intent-linked APPROVE (403) when the decider no longer holds approvals:decide', async () => {
    // A demoted approver: their fanned-out row is still visible (they keep org
    // membership) but they lost approvals:decide. The decide-time re-check must
    // fail closed before the CAS, so the intent is never transitioned.
    mockDecideWithIntent({ requestedByUserId: 'requester-1' });
    vi.mocked(userCanDecideApprovals).mockReturnValueOnce(false);

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(403);
    // Fails closed BEFORE the CAS — the fan-in transaction never opens.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'intent-1', outcome: 'approver_unauthorized' }),
    );
  });

  it('refuses an intent-linked APPROVE (403) when the decider lost access to the intent org', async () => {
    mockDecideWithIntent({ requestedByUserId: 'requester-1' });
    vi.mocked(canAccessOrg).mockReturnValueOnce(false);

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('still allows an intent-linked DENY from a decider who lost approvals:decide (deny is harmless)', async () => {
    // Deny cancels the action — it never drives a release — so a demoted
    // approver denying must stay available (the re-check is approve-only).
    mockDecideWithIntent({ requestedByUserId: 'requester-1' });
    const { intentCasSet } = mockIntentFanInTx();
    vi.mocked(userCanDecideApprovals).mockReturnValue(false);

    const res = await buildApp().request('/approvals/appr-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'no' }),
    });
    expect(res.status).toBe(200);
    expect(intentCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
    );
    vi.mocked(userCanDecideApprovals).mockReturnValue(true);
  });

  it('denying an intent-linked row transitions the intent to rejected, expires siblings, and records intent_rejected', async () => {
    mockDecideWithIntent({ requestedByUserId: 'requester-1' });
    const { intentCasSet, siblingSet, tx } = mockIntentFanInTx();

    const res = await buildApp().request('/approvals/appr-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'not needed' }),
    });
    expect(res.status).toBe(200);

    expect(intentCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
    );
    // A rejected intent never executes, so it gets no release lease.
    const stampedCas = intentCasSet.mock.calls[0]![0] as { releaseBy?: Date };
    expect(stampedCas.releaseBy).toBeUndefined();
    expect(siblingSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );
    // Wave 2 (#3823) INVERTED this assertion. It previously read
    // `expect(tx.insert).not.toHaveBeenCalled()` — a denied intent wrote no
    // outbox row at all, which is precisely why a requester whose chat turn had
    // ended could never learn the outcome. The row is written in the same
    // transaction as the status change so the record cannot disagree with the
    // decision, and it carries ids only, never argument content.
    expect(tx.insert).toHaveBeenCalledTimes(1);
    const outboxValues = (tx.insert as ReturnType<typeof vi.fn>).mock.results[0]!.value.values as
      ReturnType<typeof vi.fn>;
    expect(outboxValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'intent_rejected' }),
    );
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'rejected' }),
    );
  });

  it('sole-operator self-approval below L3 assurance is refused with step_up_required and never touches the intent', async () => {
    // Default assurance mock resolves decidedAssuranceLevel: 1 (session_tap).
    mockDecideWithIntent({ requestedByUserId: TEST_USER.id });

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('step_up_required');
    expect(body.requiredLevel).toBe(3);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('sole-operator self-approval at L3+ assurance succeeds and audits self_approved_sole_operator', async () => {
    mockDecideWithIntent({ requestedByUserId: TEST_USER.id });
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: 'dev-1',
    });
    const { intentCasSet } = mockIntentFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(intentCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', decidedAssuranceLevel: 3 }),
    );
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'self_approved_sole_operator' }),
    );
    // #2685: the happy path must have actually re-derived the approver set,
    // not skipped the check.
    expect(resolveIntentApprovers).toHaveBeenCalledWith('org-9');
    // Scope gate the other direction: a four_eyes sole-operator self-approval
    // must NOT carry the supervised-only `approvalMethod` tag — that would
    // blur the two signals this gate exists to keep apart.
    const call = vi
      .mocked(recordActionIntentEvent)
      .mock.calls.find((c) => c[0]?.outcome === 'self_approved_sole_operator');
    expect((call?.[0]?.details as Record<string, unknown> | undefined)?.approvalMethod).toBeUndefined();
  });

  // #2685: sole-operator status is RE-DERIVED at decide time, not inferred
  // from row ownership.
  it('refuses a self-approve (403 not_sole_approver) when the org now has another eligible approver, even at L3', async () => {
    mockDecideWithIntent({ requestedByUserId: TEST_USER.id });
    // Fully-assured self-approve — proves the refusal is the approver-set
    // re-derivation, not the L3 step-up gate.
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: 'dev-1',
    });
    vi.mocked(resolveIntentApprovers).mockResolvedValueOnce([TEST_USER.id, 'other-approver']);

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('not_sole_approver');
    // Fails closed BEFORE the CAS — the intent is never transitioned.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-9',
        intentId: 'intent-1',
        outcome: 'approver_unauthorized',
        actorId: TEST_USER.id,
        details: expect.objectContaining({ errorCode: 'not_sole_approver' }),
      }),
    );
  });

  it('refuses a self-approve BEFORE consuming an assurance proof (no WebAuthn challenge burned)', async () => {
    mockDecideWithIntent({ requestedByUserId: TEST_USER.id });
    vi.mocked(resolveIntentApprovers).mockResolvedValueOnce([TEST_USER.id, 'other-approver']);

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
  });

  it('never re-derives approvers for a cross-user approve (the check is self-approve only)', async () => {
    mockDecideWithIntent({ requestedByUserId: 'requester-1' });
    mockIntentFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(resolveIntentApprovers).not.toHaveBeenCalled();
  });

  it('still allows a self-DENY when the org gained another eligible approver (deny is never blocked)', async () => {
    mockDecideWithIntent({ requestedByUserId: TEST_USER.id });
    const { intentCasSet } = mockIntentFanInTx();
    vi.mocked(resolveIntentApprovers).mockResolvedValueOnce([TEST_USER.id, 'other-approver']);

    const res = await buildApp().request('/approvals/appr-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'changed my mind' }),
    });
    expect(res.status).toBe(200);
    expect(intentCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
    );
  });

  it('refuses the decision when bound_argument_digest no longer matches the intent (digest_mismatch) and audits it', async () => {
    mockDecideWithIntent({ boundArgumentDigest: 'stale-digest', intentDigest: 'digest-abc' });

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('digest_mismatch');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-9',
        intentId: 'intent-1',
        actionName: 'y',
        argumentDigest: 'digest-abc',
        source: 'mcp_api',
        outcome: 'digest_mismatch',
        actorId: TEST_USER.id,
        details: expect.objectContaining({
          approvalId: 'appr-1',
          boundArgumentDigest: 'stale-digest',
        }),
      }),
    );
  });

  it('first-wins: a decide arriving after the intent already moved is a no-op but still 200s for this row', async () => {
    mockDecideWithIntent({ requestedByUserId: 'requester-1' });
    // Task 6: the CAS is now inline in the fan-in transaction, so the tx DOES
    // open — but the CAS matches zero rows (another decider/reaper already
    // moved the intent), so it returns early: no sibling expiry, no outbox, no
    // metrics event. The user's own approval row still committed → 200.
    const { siblingSet, outboxValues } = mockIntentFanInTx({ casWins: false });

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(db.transaction).toHaveBeenCalled();
    expect(siblingSet).not.toHaveBeenCalled();
    expect(outboxValues).not.toHaveBeenCalled();
    expect(recordActionIntentEvent).not.toHaveBeenCalled();
  });

  it('a non-intent-linked decide never touches the intent transition path (regression)', async () => {
    const plainRow = {
      id: 'a1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Claude Desktop',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'x',
      actionToolName: 'y',
      actionArguments: {},
      riskTier: 'low',
      riskSummary: 'z',
      status: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: new Date(),
      decisionReason: null,
      executionId: null,
      elevationRequestId: null,
      intentId: null,
      createdAt: new Date(),
    };
    const set = mockDecideFlow({
      existing: { ...plainRow, status: 'pending' },
      updateReturns: [plainRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalled();
    // The Task 6 atomic decide-write tx always opens (even for a plain row —
    // it's what performs the approval-row CAS), but with only ONE tx.update
    // call: no intent CAS, no sibling expiry, no outbox insert.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(recordActionIntentEvent).not.toHaveBeenCalled();
    // Only the pre-fetch select ran — no intent load select.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});

describe('Task 6: supervised intent plain-decide branch', () => {
  // Shared with mockIntentFanInTx-style wiring below: the approval_requests
  // CAS return value must match the row the pre-fetch select produced.
  let lastApprovalRow: Record<string, unknown> | undefined;

  // Wires the decideHandler flow for a SUPERVISED intent-linked approval row
  // (exactly one approval row, owned by the requester — Task 4). Defaults
  // requestedByUserId to TEST_USER.id (the common case: the requester IS the
  // decider); the non-requester test overrides it.
  function mockDecideWithSupervisedIntent(opts: {
    riskTier?: string;
    requestedByUserId?: string;
    decidingUserId?: string;
  }) {
    const decidingUserId = opts.decidingUserId ?? TEST_USER.id;
    const approvalRow = {
      id: 'appr-1',
      userId: decidingUserId,
      requestingClientLabel: 'Breeze AI',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'x',
      actionToolName: 'execute_command',
      actionArguments: { deviceId: 'dev-1', commandType: 'kill_process' },
      riskTier: opts.riskTier ?? 'high',
      riskSummary: 'z',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decisionReason: null,
      executionId: null,
      elevationRequestId: null,
      intentId: 'intent-sv-1',
      boundArgumentDigest: 'digest-abc',
      isRecursive: false,
      createdAt: new Date(),
    };

    const intentRow = {
      id: 'intent-sv-1',
      orgId: 'org-9',
      actionName: 'execute_command',
      arguments: { deviceId: 'dev-1', commandType: 'kill_process' },
      argumentDigest: 'digest-abc',
      source: 'chat',
      status: 'pending_approval',
      approvalScope: 'supervised',
      requestedByUserId: opts.requestedByUserId ?? decidingUserId,
    };

    // 1) pre-fetch select (filtered to the DECIDING user's own row)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([approvalRow]),
      }),
    } as any);
    // 2) intent load select (system context, by id)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([intentRow]),
      }),
    } as any);

    lastApprovalRow = approvalRow;
    return { approvalRow, intentRow };
  }

  // Wires the Task 6 atomic decide-write tx for the supervised happy path:
  // approval_requests CAS, intent CAS (+ release_by on approve), sibling
  // expiry (a no-op here — supervised has no siblings), and the
  // intent_approved outbox insert on approve.
  function mockSupervisedFanInTx() {
    const approvalCasReturning = vi
      .fn()
      .mockResolvedValue([{ ...(lastApprovalRow ?? {}), status: 'approved' }]);
    const approvalCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: approvalCasReturning }),
    });
    const intentCasReturning = vi.fn().mockResolvedValue([{ id: 'intent-sv-1' }]);
    const intentCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: intentCasReturning }),
    });
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const outboxValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      // Fix round 1, finding 2: intent-first lock ahead of the three updates.
      select: txSelectForUpdateStub(),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: approvalCasSet } as any)
        .mockReturnValueOnce({ set: intentCasSet } as any)
        .mockReturnValueOnce({ set: siblingSet } as any),
      insert: vi.fn(() => ({ values: outboxValues }) as any),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return { approvalCasSet, intentCasSet, siblingSet, outboxValues };
  }

  it('supervised requester approves with no assertion (non-enforcing partner policy — fix round 1, finding 5)', async () => {
    mockDecideWithSupervisedIntent({});
    mockSupervisedFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    // The whole assertion/assurance ladder is skipped for a supervised
    // self-decide UNDER A NON-ENFORCING partner policy — no WebAuthn
    // challenge is ever verified. The enforcing branch is covered by the
    // dedicated 'enforcing partner policy' test below.
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(loadPartnerPolicy).toHaveBeenCalledWith('partner-123');
    expect(isEnforcing).toHaveBeenCalled();
    // The live-RBAC re-check DOES run (approve only), against the underlying
    // tool action — not approvals:decide.
    expect(buildAuthContextForIntent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'intent-sv-1', actionName: 'execute_command' }),
    );
    expect(checkToolPermission).toHaveBeenCalledWith(
      'execute_command',
      { deviceId: 'dev-1', commandType: 'kill_process' },
      expect.anything(),
    );
  });

  // Sole-operator audit-signal scope gate (finding: soleOperatorApproval must
  // stay four_eyes-only): a supervised approve's sole approval row is ALWAYS
  // requester === decider (Task 4's single-row fan-out), so it must NOT audit
  // as `self_approved_sole_operator` — that outcome exists to flag the
  // four_eyes "only eligible approver happened to be the requester" case.
  // Supervised approves audit as ordinary `approved`, tagged with
  // `details.approvalMethod: 'supervised_self'` so the signal is still
  // distinguishable without polluting the four_eyes one.
  it('audits a supervised self-approve as outcome=approved with details.approvalMethod=supervised_self, never self_approved_sole_operator', async () => {
    mockDecideWithSupervisedIntent({});
    mockSupervisedFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-9',
        intentId: 'intent-sv-1',
        outcome: 'approved',
        details: expect.objectContaining({ approvalMethod: 'supervised_self' }),
      }),
    );
    expect(recordActionIntentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'self_approved_sole_operator' }),
    );
  });

  it('an ENFORCING partner policy blocks a plain-click supervised approve with step_up_required (fix round 1, finding 5)', async () => {
    mockDecideWithSupervisedIntent({});
    vi.mocked(isEnforcing).mockReturnValue(true);

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('step_up_required');
    // The RBAC re-check still ran (it is unconditional for supervised,
    // regardless of enforcement) — only the assurance ladder's outcome
    // changed. The write transaction never opened.
    expect(checkToolPermission).toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('an ENFORCING partner policy is satisfied by a WebAuthn L3 proof on a supervised approve', async () => {
    mockDecideWithSupervisedIntent({});
    vi.mocked(isEnforcing).mockReturnValue(true);
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: 'dev-1',
    });
    const { approvalCasSet } = mockSupervisedFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'appr-1', userId: TEST_USER.id }),
    );
    expect(approvalCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ decidedVia: 'webauthn_platform', decidedAssuranceLevel: 3 }),
    );
  });

  it('an ENFORCING partner policy never blocks a supervised DENY (deny is harmless, no partner-policy read)', async () => {
    mockDecideWithSupervisedIntent({});
    mockSupervisedFanInTx();
    vi.mocked(isEnforcing).mockReturnValue(true);

    const res = await buildApp().request('/approvals/appr-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'no' }),
    });

    expect(res.status).toBe(200);
    // Gated to approve-only — a deny never spends a partner-policy read.
    expect(loadPartnerPolicy).not.toHaveBeenCalled();
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
  });

  it('records session_tap/L1 (no proof consumed) on a supervised approve', async () => {
    mockDecideWithSupervisedIntent({});
    const { approvalCasSet } = mockSupervisedFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(approvalCasSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'approved',
        decidedVia: 'session_tap',
        decidedAssuranceLevel: 1,
        authenticatorDeviceId: null,
      }),
    );
  });

  // ------------------------------------------------------------------
  // Fix round 2, finding 1: an OPTIONAL proof presented on a supervised
  // decide used to be silently DISCARDED — `skipAssuranceLadder` never
  // considered `proof`, so a Secure-Enclave signature was never verified, the
  // anti-clone counter never bumped, the challenge left unconsumed, and the
  // audit row recorded L1/session_tap/device NULL. A forged or replayed proof
  // was ignored rather than 401'd.
  // ------------------------------------------------------------------
  const mobileProof = {
    type: 'mobile_hw_key' as const,
    credentialId: '00000000-0000-0000-0000-0000000000aa',
    nonce: 'mobile-nonce-xyz',
    signature: 'c2ln',
  };

  it('supervised approve WITH a valid proof verifies it and records the real assurance level (not session_tap)', async () => {
    mockDecideWithSupervisedIntent({});
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'mobile_hw_key',
      authenticatorDeviceId: 'authdev-1',
    });
    const { approvalCasSet, intentCasSet } = mockSupervisedFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof }),
    });

    expect(res.status).toBe(200);
    // The ladder RAN (proof presented) even though the partner policy is
    // non-enforcing — the signature is verified, not thrown away.
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'appr-1',
        userId: TEST_USER.id,
        proof: expect.objectContaining({ type: 'mobile_hw_key', nonce: 'mobile-nonce-xyz' }),
      }),
    );
    expect(approvalCasSet).toHaveBeenCalledWith(
      expect.objectContaining({
        decidedVia: 'mobile_hw_key',
        decidedAssuranceLevel: 3,
        authenticatorDeviceId: 'authdev-1',
      }),
    );
    expect(intentCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ decidedVia: 'mobile_hw_key', decidedAssuranceLevel: 3 }),
    );
  });

  it('supervised approve with an INVALID/replayed proof is 401, never a silent L1 success', async () => {
    mockDecideWithSupervisedIntent({});
    mockSupervisedFanInTx();
    vi.mocked(assertApprovalAssurance).mockRejectedValueOnce(new Error('signature verification failed'));

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'assertion_failed' });
    // Nothing was written — the decide transaction never opened.
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // Fix round 2, finding 1 PART 2 regression guard: the sole-operator L3 gate
  // fires on `requestedByUserId === userId`, which is UNCONDITIONALLY true for
  // a supervised decide. Routing an optional proof through the ladder must not
  // let a proof that only reaches L2 turn into a 403 on a decide that a plain
  // click passes — an optional proof can only ever RAISE the recorded
  // assurance under a non-enforcing policy.
  it('supervised approve with an L2-only proof still succeeds (the sole-operator L3 gate must not fire)', async () => {
    mockDecideWithSupervisedIntent({});
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 2,
      decidedVia: 'mobile_hw_key',
      authenticatorDeviceId: 'authdev-1',
    });
    const { approvalCasSet } = mockSupervisedFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof }),
    });

    expect(res.status).toBe(200);
    expect(approvalCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ decidedVia: 'mobile_hw_key', decidedAssuranceLevel: 2 }),
    );
  });

  // The other half of the same regression guard: no proof + non-enforcing
  // partner must remain a plain click that skips the ladder entirely.
  it('supervised approve with NO proof under a non-enforcing partner is still a plain click (ladder skipped)', async () => {
    mockDecideWithSupervisedIntent({});
    const { approvalCasSet } = mockSupervisedFanInTx();

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(approvalCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ decidedVia: 'session_tap', decidedAssuranceLevel: 1 }),
    );
  });

  // An ENFORCING partner policy is unchanged by finding 1: the L3 gate still
  // applies there, so an L2-only proof is still refused.
  it('an ENFORCING partner policy still refuses an L2-only proof on a supervised approve', async () => {
    mockDecideWithSupervisedIntent({});
    vi.mocked(isEnforcing).mockReturnValue(true);
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 2,
      decidedVia: 'mobile_hw_key',
      authenticatorDeviceId: 'authdev-1',
    });

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', requiredLevel: 3 });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('supervised row rejects a NON-requester decide even with approvals:decide', async () => {
    // The row's userId happens to be the deciding user (Shape-6 self-visibility
    // in production would otherwise 404 this for anyone else — see the not_requester
    // gate's own comment), but the intent's requestedByUserId is a DIFFERENT
    // user, simulating a non-requester somehow reaching this row.
    mockDecideWithSupervisedIntent({ requestedByUserId: 'someone-else' });
    // Holding approvals:decide must NOT substitute for the identity check.
    vi.mocked(userCanDecideApprovals).mockReturnValue(true);
    vi.mocked(canAccessOrg).mockReturnValue(true);

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('not_requester');
    // Fails closed before ever touching the assurance ladder or the write tx.
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a non-requester supervised DENY is also refused (identity gate is unconditional)', async () => {
    mockDecideWithSupervisedIntent({ requestedByUserId: 'someone-else' });

    const res = await buildApp().request('/approvals/appr-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'no' }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('not_requester');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('supervised approve re-checks live RBAC for the underlying tool action and refuses when it was revoked', async () => {
    mockDecideWithSupervisedIntent({});
    // Simulate devices:execute having been revoked from the requester between
    // intent creation and decide.
    vi.mocked(checkToolPermission).mockResolvedValueOnce(
      'Insufficient permissions: requires devices.execute',
    );

    const res = await buildApp().request('/approvals/appr-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    // Refused BEFORE the write transaction and before the (skipped) assurance
    // ladder would have run.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'intent-sv-1',
        outcome: 'approver_unauthorized',
        details: expect.objectContaining({ errorCode: 'rbac_denied' }),
      }),
    );
  });

  it('a supervised DENY is never blocked by a revoked tool permission (deny is harmless)', async () => {
    mockDecideWithSupervisedIntent({});
    mockSupervisedFanInTx();
    // NOTE: deliberately NOT queuing a checkToolPermission denial here — the
    // assertion below is that checkToolPermission is never even CALLED on a
    // deny, so a queued `mockResolvedValueOnce` would go unconsumed and poison
    // a later test's call to the same mock (the exact trap this file's other
    // helpers document).

    const res = await buildApp().request('/approvals/appr-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'changed my mind' }),
    });

    expect(res.status).toBe(200);
    // checkToolPermission is gated to approve-only, so it's never even called
    // on a deny.
    expect(checkToolPermission).not.toHaveBeenCalled();
  });

  it('supervised approve never requires approvals:decide (the four_eyes RBAC re-check never runs)', async () => {
    mockDecideWithSupervisedIntent({});
    mockSupervisedFanInTx();
    // A requester with NO approvals:decide permission whatsoever — the
    // four_eyes decider-RBAC re-check would refuse this, but supervised must
    // never call it at all. NOTE: deliberately not queuing a
    // getUserPermissions override here — it's asserted below to never be
    // called, so a queued `mockResolvedValueOnce` would go unconsumed and
    // poison a later test (the same trap `checkToolPermission` had above).
    vi.mocked(userCanDecideApprovals).mockReturnValue(false);

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(userCanDecideApprovals).not.toHaveBeenCalled();
    expect(resolveIntentApprovers).not.toHaveBeenCalled();
    // Restore the permissive default — this mock is set with a persistent
    // (not "Once") override above, and a later test's four_eyes branch DOES
    // call userCanDecideApprovals.
    vi.mocked(userCanDecideApprovals).mockReturnValue(true);
  });

  it('four_eyes rows keep the assurance gate (unaffected by the supervised branch)', async () => {
    // An explicit four_eyes intent (approvalScope set, not merely absent) —
    // confirms the else-branch is still reached and still runs the full
    // assertion/assurance ladder.
    const approvalRow = {
      id: 'appr-fe-1',
      userId: TEST_USER.id,
      requestingClientLabel: 'MCP API client',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'x',
      actionToolName: 'y',
      actionArguments: {},
      riskTier: 'high',
      riskSummary: 'z',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decisionReason: null,
      executionId: null,
      elevationRequestId: null,
      intentId: 'intent-fe-1',
      boundArgumentDigest: 'digest-abc',
      isRecursive: false,
      createdAt: new Date(),
    };
    const intentRow = {
      id: 'intent-fe-1',
      orgId: 'org-9',
      actionName: 'y',
      arguments: {},
      argumentDigest: 'digest-abc',
      source: 'mcp_api',
      status: 'pending_approval',
      approvalScope: 'four_eyes',
      requestedByUserId: 'requester-1',
    };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([approvalRow]) }),
    } as any);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([intentRow]) }),
    } as any);
    const approvalCasReturning = vi.fn().mockResolvedValue([{ ...approvalRow, status: 'approved' }]);
    const approvalCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: approvalCasReturning }),
    });
    const intentCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'intent-fe-1' }]) }),
    });
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const tx = {
      // Fix round 1, finding 2: intent-first lock ahead of the three updates.
      select: txSelectForUpdateStub(),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: approvalCasSet } as any)
        .mockReturnValueOnce({ set: intentCasSet } as any)
        .mockReturnValueOnce({ set: siblingSet } as any),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) }) as any),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const res = await buildApp().request('/approvals/appr-fe-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'appr-fe-1', userId: TEST_USER.id }),
    );
    expect(buildAuthContextForIntent).not.toHaveBeenCalled();
    expect(checkToolPermission).not.toHaveBeenCalled();
  });
});

describe('POST /approvals/:id/report-suspicious', () => {
  const baseRow = {
    id: 'a1',
    userId: TEST_USER.id,
    requestingClientLabel: 'Claude Desktop',
    requestingMachineLabel: null,
    requestingClientId: 'client-xyz',
    requestingSessionId: null,
    actionLabel: 'Delete prod devices',
    actionToolName: 'breeze.devices.delete',
    actionArguments: {},
    riskTier: 'high' as const,
    riskSummary: 'Reported as suspicious test',
    status: 'pending' as const,
    expiresAt: new Date(Date.now() + 60_000),
    decidedAt: null,
    decisionReason: null,
    executionId: null,
    createdAt: new Date(),
  };

  function wireRevocationStubs(opts: { existing: typeof baseRow | null }) {
    // 1) initial select to find approval
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(opts.existing ? [opts.existing] : []),
      }),
    } as any);

    // 2) update approval_requests (status=reported) — the only remaining
    //    direct db.update in this handler now that grant/refresh-token
    //    revocation is delegated to lifecycle.revokeUserOauthClient.
    const approvalUpdateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: approvalUpdateSet } as any);

    // insert audit log
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as any);

    return { approvalUpdateSet };
  }

  it('happy path: 204, denies row, delegates OAuth client revocation to lifecycle helper, writes audit', async () => {
    const { approvalUpdateSet } = wireRevocationStubs({ existing: baseRow });

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(204);
    expect(approvalUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reported' }),
    );
    // Revocation is the canonical lifecycle.ts soft-revoke path: stamps
    // oauth_grants.revoked_at + revokes refresh-token JTIs + writes the
    // grant-revocation cache marker so any in-flight access JWT is
    // rejected before its natural expiry.
    const { revokeUserOauthClient } = await import('./lifecycle');
    expect(revokeUserOauthClient).toHaveBeenCalledWith(
      TEST_USER.id,
      baseRow.requestingClientId,
      TEST_USER.id,
      'self-reported suspicious approval',
    );
    expect(db.insert).toHaveBeenCalled();
  });

  it('returns 404 when the approval does not exist for this user', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const res = await buildApp().request('/approvals/missing/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('rejects the linked action intent and expires sibling approvals for an intent-backed row', async () => {
    // Intent-backed rows carry intentId (not executionId). A suspicious report
    // must reject the whole intent and expire siblings so another approver's
    // still-pending row cannot approve the flagged action.
    const intentRow = { ...baseRow, executionId: null, intentId: 'intent-77', requestingClientId: null };

    // 1) find existing approval
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([intentRow]),
      }),
    } as any);
    // Fix round 1, finding 1: the reject fan-in is now ONE db.transaction
    // that ALSO folds in the approval-row 'reported' flip (previously a
    // separate, unconditional db.update BEFORE this transaction even
    // opened) — the tx does the intent-first lock (finding 2), the flip,
    // the intent CAS (`.returning(...)` the metadata for the metrics
    // event), and the sibling-expiry update, all on `tx`.
    const casReturning = vi
      .fn()
      .mockResolvedValue([{ orgId: 'org-9', actionName: 'y', argumentDigest: 'd', source: 'mcp_api' }]);
    const flipSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const intentCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: casReturning }),
    });
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const tx = {
      select: txSelectForUpdateStub(),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: flipSet } as any) // 1) approval_requests -> reported
        .mockReturnValueOnce({ set: intentCasSet } as any) // 2) intent CAS
        .mockReturnValueOnce({ set: siblingSet } as any), // 3) sibling expiry
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(204);
    expect(flipSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reported' }),
    );
    expect(intentCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', decidedByUserId: TEST_USER.id }),
    );
    expect(siblingSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'intent-77', outcome: 'rejected' }),
    );
    // Fix round 2, finding 2: the flip is a CAS on status = 'pending'. Without
    // that predicate a decide that committed between this handler's unlocked
    // pre-fetch and this statement had its just-written 'approved' (plus
    // decided_by / assurance columns) silently overwritten by 'reported'.
    expect(flipSet.mock.results[0]!.value.where).toHaveBeenCalledWith(
      and(
        eq(approvalRequests.id, 'a1'),
        eq(approvalRequests.userId, TEST_USER.id),
        eq(approvalRequests.status, 'pending'),
      ),
    );
  });

  // Fix round 2, finding 2: a losing race used to fall through to the SAME 204
  // a successful report returns, while the intent was already 'approved', the
  // outbox event queued, and the durable release worker about to run the very
  // action the user flagged as malicious.
  it('returns 409 already_decided (never 204) when a concurrent decide already approved the intent', async () => {
    const intentRow = { ...baseRow, executionId: null, intentId: 'intent-77' };

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([intentRow]),
      }),
    } as any);

    const flipSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    // Intent CAS matches ZERO rows — the intent already left 'pending_approval'.
    const intentCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    });
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const tx = {
      // The FOR UPDATE lock read reports the terminal state the CAS lost to.
      select: txSelectForUpdateStub([{ id: 'intent-77', status: 'approved' }]),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: flipSet } as any)
        .mockReturnValueOnce({ set: intentCasSet } as any)
        .mockReturnValueOnce({ set: siblingSet } as any),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_decided', finalStatus: 'approved' });

    // No sibling expiry on a lost CAS, and no 'rejected' metric event.
    expect(siblingSet).not.toHaveBeenCalled();
    expect(recordActionIntentEvent).not.toHaveBeenCalled();

    // The security response still happens — revoking the requesting OAuth
    // client and writing the audit row is exactly what a user reporting a
    // compromised client needs most when the action already slipped through.
    const { revokeUserOauthClient } = await import('./lifecycle');
    expect(revokeUserOauthClient).toHaveBeenCalledWith(
      TEST_USER.id,
      baseRow.requestingClientId,
      TEST_USER.id,
      'self-reported suspicious approval',
    );
    expect(db.insert).toHaveBeenCalled();
  });

  it('still 409s (finalStatus null) when the intent row vanished from under the lock', async () => {
    const intentRow = { ...baseRow, executionId: null, intentId: 'intent-77' };

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([intentRow]),
      }),
    } as any);

    const tx = {
      select: txSelectForUpdateStub([]),
      update: vi
        .fn()
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        } as any)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
          }),
        } as any),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_decided', finalStatus: null });
  });

  // The legacy execution-linked branch is deliberately untouched by the CAS /
  // 409 work above — it has no intent to lose a race to.
  it('legacy execution-linked branch is unchanged: 204 plus the ai_tool_executions mirror', async () => {
    const execRow = { ...baseRow, executionId: 'exec-9', intentId: null };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([execRow]),
      }),
    } as any);
    const flipSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const mirrorSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update)
      .mockReturnValueOnce({ set: flipSet } as any)
      .mockReturnValueOnce({ set: mirrorSet } as any);
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(204);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(flipSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'reported' }));
    expect(mirrorSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', approvedBy: TEST_USER.id }),
    );
  });

  it('returns 401 when auth middleware rejects (permission denied)', async () => {
    vi.mocked(authMiddleware).mockImplementationOnce((c: any) => {
      return c.json({ error: 'unauthorized' }, 401);
    });

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('POST /approvals/dev/seed', () => {
  it('returns 404 when NODE_ENV=production', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await buildApp().request('/approvals/dev/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionLabel: 'x',
          actionToolName: 'y',
          riskTier: 'low',
          riskSummary: 'z',
        }),
      });
      expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('returns 404 when NODE_ENV is unset (e.g. staging)', async () => {
    const orig = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const res = await buildApp().request('/approvals/dev/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionLabel: 'x',
          actionToolName: 'y',
          riskTier: 'low',
          riskSummary: 'z',
        }),
      });
      expect(res.status).toBe(404);
    } finally {
      if (orig === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = orig;
    }
  });

  it('creates a seed approval and returns 201 with push diagnostics', async () => {
    const now = new Date();
    const seededRow = {
      id: 'seed-1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Dev Seed',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'Test action',
      actionToolName: 'breeze.test',
      actionArguments: {},
      riskTier: 'low',
      riskSummary: 'Just a test',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decisionReason: null,
      createdAt: now,
    };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([seededRow]),
      }),
    } as any);

    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const res = await buildApp().request('/approvals/dev/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionLabel: 'Test action',
          actionToolName: 'breeze.test',
          riskTier: 'low',
          riskSummary: 'Just a test',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.approval.id).toBe('seed-1');
      expect(body.push).toEqual({ tokensFound: 1, dispatched: 1, errors: 0 });
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});

describe('wave 3b Task 6: agent-originated intents — see it, decide it', () => {
  const AGENT_RUN_ID = 'run-ag-1';
  const AGENT_NAME = 'Patch Hygiene Agent';

  function buildAgentIntent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'intent-ag-1',
      orgId: 'org-9',
      actionName: 'execute_command',
      arguments: { deviceId: 'dev-1', commandType: 'kill_process' },
      argumentDigest: 'digest-abc',
      source: 'ai_agent',
      status: 'pending_approval',
      approvalScope: 'supervised',
      requestedByUserId: null,
      requestingAgentRunId: AGENT_RUN_ID,
      requestingClientLabel: AGENT_NAME,
      ...overrides,
    };
  }

  /**
   * P2-2 (#4189): `serialize` now also emits the intent's resolved TARGET
   * device, which `resolveTargetDevices` batches into at most two extra
   * selects per page — `ai_agent_runs` (only for agent intents with NO
   * explicit scope, whose target is still the run's device), then `devices`.
   * Both go through `db.select().from(...).where(...)` with no `leftJoin`, so
   * the from-stub gains a sibling `where` branch whose results are queued in
   * that order. Defaults to `[[], []]` — no run, no device, `targetDevice:
   * null` — which is what every pre-P2-2 assertion in this block expects.
   */
  function mockPendingJoinResolvesAgent(
    rows: Array<{ approval: unknown; intent: unknown | null }>,
    targetLookups: unknown[][] = [],
  ) {
    const queued = [...targetLookups];
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
        where: vi.fn(async () => queued.shift() ?? []),
      }),
    } as any);
  }

  /** Queues the two `resolveTargetDevices` selects (runs, then devices) onto a
   *  `mockReturnValueOnce` chain — the shape GET /:id and decide use. */
  function queueTargetDeviceSelects(runs: unknown[] = [], deviceRows: unknown[] = []) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(runs) }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(deviceRows) }),
      } as any);
  }

  function buildAgentApproval(overrides: Record<string, unknown> = {}) {
    return {
      id: 'appr-ag-1',
      userId: TEST_USER.id,
      requestingClientLabel: AGENT_NAME,
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'Kill process on dev-1',
      actionToolName: 'execute_command',
      actionArguments: { deviceId: 'dev-1', commandType: 'kill_process' },
      riskTier: 'high',
      riskSummary: 'Terminates a process on a managed device.',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decisionReason: null,
      executionId: null,
      elevationRequestId: null,
      intentId: 'intent-ag-1',
      boundArgumentDigest: 'digest-abc',
      isRecursive: false,
      createdAt: new Date(),
      ...overrides,
    };
  }

  // -------------------------------------------------------------- /pending --

  it('lists a supervised agent intent for its fanned-out eligible user', async () => {
    mockPendingJoinResolvesAgent([
      { approval: buildAgentApproval(), intent: buildAgentIntent() },
    ]);

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals.map((a: any) => a.id)).toEqual(['appr-ag-1']);
    // Authority is the per-user action-and-target predicate, never requester
    // identity (requestedByUserId is NULL) and never approvals:decide.
    expect(vi.mocked(isAgentIntentDecideAuthorized)).toHaveBeenCalledWith(
      TEST_USER.id,
      expect.objectContaining({ id: 'intent-ag-1', requestingAgentRunId: AGENT_RUN_ID }),
    );
  });

  it('hides it from a user who lost the action permission since fan-out', async () => {
    mockPendingJoinResolvesAgent([
      { approval: buildAgentApproval(), intent: buildAgentIntent() },
    ]);
    vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(false);

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toEqual([]);

    const countRes = await buildApp().request('/approvals/pending/count');
    expect(await countRes.json()).toEqual({ count: 0 });
  });

  it('serializes origin ai_agent and the agent name (human rows stay origin human)', async () => {
    mockPendingJoinResolvesAgent([
      {
        approval: buildAgentApproval({ createdAt: new Date(Date.now()) }),
        intent: buildAgentIntent(),
      },
      {
        approval: buildPendingApproval({
          id: 'appr-hu-1',
          intentId: 'intent-hu-1',
          createdAt: new Date(Date.now() - 1000),
        }),
        intent: {
          id: 'intent-hu-1',
          orgId: 'org-9',
          status: 'pending_approval',
          approvalScope: 'supervised',
          requestedByUserId: TEST_USER.id,
          requestingAgentRunId: null,
          requestingClientLabel: 'Breeze AI',
        },
      },
      {
        approval: buildPendingApproval({ id: 'appr-plain', createdAt: new Date(Date.now() - 2000) }),
        intent: null,
      },
    ]);

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals.map((a: any) => [a.id, a.origin, a.agentName])).toEqual([
      ['appr-ag-1', 'ai_agent', AGENT_NAME],
      ['appr-hu-1', 'human', null],
      ['appr-plain', 'human', null],
    ]);
  });

  it('a four_eyes agent intent keeps the org approvals:decide visibility rule', async () => {
    mockPendingJoinResolvesAgent([
      {
        approval: buildAgentApproval(),
        intent: buildAgentIntent({ approvalScope: 'four_eyes' }),
      },
    ]);
    // Demoted from approvals:decide → the four_eyes rule hides the row, and
    // the per-user action-authority predicate is never consulted for it.
    // (`Once` on purpose: clearAllMocks never resets a persistent override.)
    vi.mocked(userCanDecideApprovals).mockReturnValueOnce(false);

    const res = await buildApp().request('/approvals/pending');
    const body = await res.json();
    expect(body.approvals).toEqual([]);
    expect(vi.mocked(isAgentIntentDecideAuthorized)).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------ GET /:id ---

  function mockDetailWithAgentIntent(
    intent: unknown | null,
    targetLookups?: { runs?: unknown[]; devices?: unknown[] },
  ) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([buildAgentApproval()]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(intent ? [intent] : []),
        }),
      } as any);
    queueTargetDeviceSelects(targetLookups?.runs, targetLookups?.devices);
  }

  it('GET /:id serializes origin ai_agent / agentName under the same live rule', async () => {
    mockDetailWithAgentIntent(buildAgentIntent());

    const res = await buildApp().request('/approvals/appr-ag-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.origin).toBe('ai_agent');
    expect(body.approval.agentName).toBe(AGENT_NAME);
    expect(body.approval.approvalScope).toBe('supervised');
  });

  it('GET /:id 404s for a user who is no longer action-and-target authorized', async () => {
    mockDetailWithAgentIntent(buildAgentIntent());
    vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(false);

    const res = await buildApp().request('/approvals/appr-ag-1');
    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(raw).not.toContain('kill_process');
  });

  // -------------------------------------------------------------- decide ---

  let lastAgentApprovalRow: Record<string, unknown> | undefined;

  function mockDecideWithAgentIntent(opts: {
    intentOverrides?: Record<string, unknown>;
    targetLookups?: { runs?: unknown[]; devices?: unknown[] };
  } = {}) {
    const approvalRow = buildAgentApproval();
    const intentRow = buildAgentIntent(opts.intentOverrides);

    // 1) pre-fetch select (the deciding user's own approval row)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([approvalRow]),
      }),
    } as any);
    // 2) intent load select (system context, by id)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([intentRow]),
      }),
    } as any);

    // 3+4) P2-2 target-device resolution for the decide RESPONSE's
    // `targetDevice` — runs, then devices. Queued here (not in
    // mockAgentFanInTx) because the 403 tests never reach the transaction
    // but the `Once` chain must stay aligned for the ones that do.
    queueTargetDeviceSelects(opts.targetLookups?.runs, opts.targetLookups?.devices);

    lastAgentApprovalRow = approvalRow;
    return { approvalRow, intentRow };
  }

  function mockAgentFanInTx() {
    const approvalCasReturning = vi
      .fn()
      .mockResolvedValue([{ ...(lastAgentApprovalRow ?? {}), status: 'approved' }]);
    const approvalCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: approvalCasReturning }),
    });
    const intentCasReturning = vi.fn().mockResolvedValue([{ id: 'intent-ag-1' }]);
    const intentCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: intentCasReturning }),
    });
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const outboxValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: txSelectForUpdateStub([{ id: 'intent-ag-1', status: 'pending_approval' }]),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: approvalCasSet } as any)
        .mockReturnValueOnce({ set: intentCasSet } as any)
        .mockReturnValueOnce({ set: siblingSet } as any),
      insert: vi.fn(() => ({ values: outboxValues }) as any),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return { approvalCasSet, intentCasSet, siblingSet, outboxValues, tx };
  }

  it('decides a supervised agent intent via action-and-target authority', async () => {
    mockDecideWithAgentIntent();
    const { intentCasSet, outboxValues } = mockAgentFanInTx();

    const res = await buildApp().request('/approvals/appr-ag-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(isAgentIntentDecideAuthorized)).toHaveBeenCalledWith(
      TEST_USER.id,
      expect.objectContaining({ id: 'intent-ag-1', requestingAgentRunId: AGENT_RUN_ID }),
    );
    // Review blocker 2: the requester-RBAC re-check is SKIPPED for agent
    // intents — a reconstructed ai_agent principal would be denied by
    // checkToolPermission's first statement, 403ing every agent approval.
    expect(vi.mocked(buildAuthContextForIntent)).not.toHaveBeenCalled();
    expect(vi.mocked(checkToolPermission)).not.toHaveBeenCalled();
    // The intent still transitions and the outbox row is written.
    expect(intentCasSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
    expect(outboxValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'intent_approved' }),
    );
  });

  it('403s not_authorized_for_agent_intent for an ineligible decider', async () => {
    mockDecideWithAgentIntent();
    vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(false);

    const res = await buildApp().request('/approvals/appr-ag-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_authorized_for_agent_intent' });
    // Refused BEFORE the decide-write transaction — the intent is untouched.
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('an agent-intent DENY is also gated on action-and-target authority (fail closed)', async () => {
    mockDecideWithAgentIntent();
    vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(false);

    const res = await buildApp().request('/approvals/appr-ag-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_authorized_for_agent_intent' });
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('never skips the assurance ladder for an agent intent', async () => {
    mockDecideWithAgentIntent();
    mockAgentFanInTx();

    const res = await buildApp().request('/approvals/appr-ag-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    // isSupervisedSelfDecide stays FALSE for an agent intent: even a plain
    // no-proof click goes through assertApprovalAssurance — the same ceremony
    // a four_eyes decision gets — never the supervised plain-click skip.
    expect(vi.mocked(assertApprovalAssurance)).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'appr-ag-1', decision: 'approved' }),
    );
  });

  it('403s human_decision_required for a non-user_session principal', async () => {
    vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
      c.set('auth', {
        principal: { kind: 'api_key', apiKeyId: 'key-1' },
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        user: TEST_USER,
        accessibleOrgIds: [],
        canAccessOrg: () => false,
        orgCondition: () => undefined,
      });
      return next();
    });

    const res = await buildApp().request('/approvals/appr-ag-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'human_decision_required' });
    // Refused before the pre-fetch — no row is ever read.
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('the decide response serializes origin ai_agent and the agent name', async () => {
    mockDecideWithAgentIntent();
    mockAgentFanInTx();

    const res = await buildApp().request('/approvals/appr-ag-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.origin).toBe('ai_agent');
    expect(body.approval.agentName).toBe(AGENT_NAME);
  });

  // ---------------------------------------------------------------- P2-2 ---
  // Task A3 (#4189): the DTO's additive `orgId` / `action` / `targetDevice`.

  describe('P2-2 target-device projection', () => {
    const scopedApproval = () =>
      buildAgentApproval({
        actionToolName: 'manage_services',
        actionArguments: { deviceId: 'dev-scope', action: 'restart', serviceName: 'spooler' },
      });

    it('resolves targetDevice from the intent SCOPE (the run is device-less)', async () => {
      mockPendingJoinResolvesAgent(
        [
          {
            approval: scopedApproval(),
            intent: buildAgentIntent({ scopeKind: 'device', scopeDeviceId: 'dev-scope' }),
          },
        ],
        // A scoped intent never needs the run read, so `devices` is the only
        // queued lookup.
        [[{ id: 'dev-scope', orgId: 'org-9', hostname: 'WS-SCOPE' }]],
      );

      const res = await buildApp().request('/approvals/pending');
      expect(res.status).toBe(200);
      const [approval] = (await res.json()).approvals;
      expect(approval.targetDevice).toEqual({ id: 'dev-scope', hostname: 'WS-SCOPE' });
      expect(approval.orgId).toBe('org-9');
      expect(approval.action).toBe('restart');
    });

    it('falls back to the RUN device for an intent with no scope', async () => {
      mockPendingJoinResolvesAgent(
        [{ approval: buildAgentApproval(), intent: buildAgentIntent() }],
        [
          [{ id: AGENT_RUN_ID, deviceId: 'dev-run' }],
          [{ id: 'dev-run', orgId: 'org-9', hostname: 'WS-RUN' }],
        ],
      );

      const res = await buildApp().request('/approvals/pending');
      const [approval] = (await res.json()).approvals;
      expect(approval.targetDevice).toEqual({ id: 'dev-run', hostname: 'WS-RUN' });
      // execute_command's arguments carry no `action` discriminator.
      expect(approval.action).toBeNull();
    });

    it('drops a target device that now belongs to another org (never renders its hostname)', async () => {
      mockPendingJoinResolvesAgent(
        [
          {
            approval: scopedApproval(),
            intent: buildAgentIntent({ scopeKind: 'device', scopeDeviceId: 'dev-scope' }),
          },
        ],
        [[{ id: 'dev-scope', orgId: 'org-OTHER', hostname: 'FOREIGN-HOST' }]],
      );

      const res = await buildApp().request('/approvals/pending');
      const raw = await res.text();
      expect(raw).not.toContain('FOREIGN-HOST');
      expect(JSON.parse(raw).approvals[0].targetDevice).toBeNull();
    });

    it('emits targetDevice null for a tombstoned scope, with no device read at all', async () => {
      mockPendingJoinResolvesAgent(
        [
          {
            approval: scopedApproval(),
            intent: buildAgentIntent({ scopeKind: 'device', scopeDeviceId: null }),
          },
        ],
        // Nothing queued: a tombstone resolves to no device id, so neither
        // the run nor the device lookup is reachable.
        [],
      );

      const res = await buildApp().request('/approvals/pending');
      const [approval] = (await res.json()).approvals;
      expect(approval.targetDevice).toBeNull();
    });

    it('emits orgId/action/targetDevice null for a row with no linked intent', async () => {
      mockPendingJoinResolvesAgent([
        { approval: buildPendingApproval({ id: 'appr-plain' }), intent: null },
      ]);

      const res = await buildApp().request('/approvals/pending');
      const [approval] = (await res.json()).approvals;
      expect(approval.orgId).toBeNull();
      expect(approval.targetDevice).toBeNull();
      expect(approval.action).toBeNull();
    });
  });
});

// ---------------------------------------------------------------- P2-2 ----
// Task B1 (#4189): batch challenge + batch decide. These live at the ROUTE
// level (the rule logic itself is covered in
// services/approvals/batchDecide.test.ts) because the thing that can only
// break here is registration order: `/batch/assertion-challenge` has the same
// shape as `/:id/assertion-challenge`, and Hono matches in registration order,
// so a batch route declared after the param route would silently be handled
// as `id === 'batch'`.
describe('P2-2 batch decide routes', () => {
  const BATCH_USER = TEST_USER.id;

  function batchIntent(n: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `intent-b${n}`,
      orgId: 'org-9',
      actionName: 'manage_services',
      arguments: { deviceId: `dev-${n}`, action: 'restart' },
      argumentDigest: `digest-b${n}`,
      source: 'ai_agent',
      status: 'pending_approval',
      approvalScope: 'supervised',
      requestedByUserId: null,
      requestingAgentRunId: 'run-sweep-1',
      requestingClientLabel: 'Patch Hygiene Agent',
      scopeKind: 'device',
      scopeDeviceId: `dev-${n}`,
      ...overrides,
    };
  }

  function batchApproval(n: number, overrides: Record<string, unknown> = {}) {
    return buildPendingApproval({
      id: `appr-b${n}`,
      userId: BATCH_USER,
      actionToolName: 'manage_services',
      actionArguments: { deviceId: `dev-${n}`, action: 'restart' },
      riskTier: 'medium',
      intentId: `intent-b${n}`,
      boundArgumentDigest: `digest-b${n}`,
      elevationRequestId: null,
      ...overrides,
    });
  }

  /** Table-dispatched select stub — same idea as the service suite's, so the
   *  per-row reads don't depend on a global call-order queue. */
  function mockBatchDb(rows: Array<{ approval: any; intent: any }>, devicesRows: unknown[] = []) {
    const byId = new Map(rows.map((r) => [r.approval.id, r]));
    const order = rows.map((r) => r.approval.id);
    let cursor = 0;
    // The intent load is a per-row FOLLOW-UP to that row's own pre-fetch, and
    // a row can return early before ever reaching it, so the intent branch
    // tracks the row the pre-fetch last handed out rather than keeping an
    // independent cursor that would drift out of lockstep.
    let currentId: string | undefined;
    vi.mocked(db.select).mockImplementation(
      (proj?: any) =>
        ({
          from: (table: any) => {
            if (table === approvalRequests) {
              return {
                leftJoin: () => ({ where: async () => rows }),
                where: async () => {
                  currentId = order[cursor++]!;
                  return [byId.get(currentId)!.approval];
                },
              };
            }
            // Table IDENTITY, not a column-shape heuristic: the mocked
            // approvals/intents schemas share column names, so shape-matching
            // would silently answer the wrong read if either mock gains a key.
            if (table === actionIntents) {
              return { where: async () => [byId.get(currentId!)!.intent] };
            }
            if (proj && 'customerDisplayName' in proj) {
              return { innerJoin: () => ({ innerJoin: () => ({ where: async () => [] }) }) };
            }
            // authenticator-device reads (webauthn_platform, then mobile_hw_key)
            return { where: async () => devicesRows };
          },
        }) as any,
    );
  }

  function mockBatchTx() {
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const set = () => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn(async () => [{ ...batchApproval(1), status: 'approved' }]),
        }),
      });
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ for: vi.fn(async () => [{ id: 'intent-b1' }]) })),
          })),
        })),
        update: vi.fn(() => ({ set: vi.fn(set) })),
        insert: vi.fn(() => ({ values: vi.fn(async () => undefined) }) as any),
      };
      return fn(tx);
    });
  }

  it('POST /batch/assertion-challenge mints ONE challenge under the batch key', async () => {
    mockBatchDb([
      { approval: batchApproval(1), intent: batchIntent(1) },
      { approval: batchApproval(2), intent: batchIntent(2) },
    ]);

    const res = await buildApp().request('/approvals/batch/assertion-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalRequestIds: ['appr-b1', 'appr-b2'],
        decision: 'approved',
      }),
    });

    expect(res.status).toBe(200);
    // Registration order held: the param route would have 404'd on id 'batch'.
    expect(vi.mocked(generateApprovalAssertionOptions)).toHaveBeenCalledTimes(1);
    const key = vi.mocked(generateApprovalAssertionOptions).mock.calls[0]![0].approvalId;
    expect(key).toMatch(/^batch-approved-[0-9a-f]{64}$/);
  });

  it('POST /batch/assertion-challenge 422s a heterogeneous set without minting', async () => {
    mockBatchDb([
      { approval: batchApproval(1), intent: batchIntent(1) },
      {
        approval: batchApproval(2, { actionToolName: 'execute_command' }),
        intent: batchIntent(2, { actionName: 'execute_command' }),
      },
    ]);

    const res = await buildApp().request('/approvals/batch/assertion-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalRequestIds: ['appr-b1', 'appr-b2'],
        decision: 'approved',
      }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'batch_not_homogeneous',
      offending: ['appr-b2'],
    });
    expect(vi.mocked(generateApprovalAssertionOptions)).not.toHaveBeenCalled();
  });

  it('POST /batch/assertion-challenge mints NOTHING for a demoted approver', async () => {
    // Review fix round 1, minor: live authorization runs inside the loader, so
    // a caller who lost action-and-target authority over even one row cannot
    // mint (and burn) a batch challenge covering it.
    mockBatchDb([
      { approval: batchApproval(1), intent: batchIntent(1) },
      { approval: batchApproval(2), intent: batchIntent(2) },
    ]);
    vi.mocked(isAgentIntentDecideAuthorized).mockImplementation(
      async (_userId: string, intent: any) => intent.id !== 'intent-b2',
    );

    const res = await buildApp().request('/approvals/batch/assertion-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalRequestIds: ['appr-b1', 'appr-b2'],
        decision: 'approved',
      }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'batch_not_homogeneous',
      offending: ['appr-b2'],
    });
    expect(vi.mocked(generateApprovalAssertionOptions)).not.toHaveBeenCalled();
    expect(vi.mocked(issueMobileAssertionNonce)).not.toHaveBeenCalled();
  });

  it('POST /batch/decide returns per-row results and verifies assurance ONCE', async () => {
    mockBatchDb([
      { approval: batchApproval(1), intent: batchIntent(1) },
      { approval: batchApproval(2), intent: batchIntent(2) },
    ]);
    mockBatchTx();

    const res = await buildApp().request('/approvals/batch/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalRequestIds: ['appr-b1', 'appr-b2'],
        decision: 'approved',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: any) => [r.id, r.httpStatus])).toEqual([
      ['appr-b1', 200],
      ['appr-b2', 200],
    ]);
    expect(vi.mocked(assertApprovalAssurance)).toHaveBeenCalledTimes(1);
  });

  it('POST /batch/decide 403s step_up_required for the whole batch', async () => {
    mockBatchDb([{ approval: batchApproval(1), intent: batchIntent(1) }]);
    mockBatchTx();
    vi.mocked(assertApprovalAssurance).mockRejectedValue(new StepUpRequiredError(3, 1));

    const res = await buildApp().request('/approvals/batch/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalRequestIds: ['appr-b1'], decision: 'approved' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', requiredLevel: 3 });
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('POST /:id/assertion-challenge still reaches the single-card route', async () => {
    // Regression guard for the inverse of the ordering bug above: adding the
    // batch routes must not shadow the param route for a real approval id.
    // An unlinked row, so the shared live-authorization filter short-circuits
    // and the only thing under test is which handler the path reached.
    mockSelectResolves([buildPendingApproval({ id: 'appr-b1' })]);
    const res = await buildApp().request('/approvals/appr-b1/assertion-challenge', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(generateApprovalAssertionOptions).mock.calls[0]![0].approvalId).toBe(
      'appr-b1',
    );
  });
});
