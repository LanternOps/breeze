import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * #5601 step-up-grant WIRING pin, isolated from the main `approvals.test.ts`
 * suite (117 tests) so this file can freely mock
 * `../services/approvals/approvalDecideGrant` and `../services/authEpochs`
 * without perturbing that file's defaults.
 *
 * Mock harness copied verbatim from `approvals.test.ts` (the module needs the
 * SAME collaborators mocked regardless of which route is under test, since
 * `../services/approvals/decideApprovalRequest` pulls in the whole graph at
 * import time) plus two additions load-bearing for this feature:
 *   - `../services/approvals/approvalDecideGrant` — the mint/redeem
 *     eligibility + low-level functions the decide core calls directly.
 *   - `../services/authEpochs` — `getUserEpochs`, needed by the core's local
 *     `resolveGrantSession` helper before it will attempt anything.
 */

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
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

vi.mock('../services/actionIntents/intentService', () => ({
  RELEASE_LEASE_MS: 10 * 60 * 1000,
}));

vi.mock('../services/actionIntents/metrics', () => ({
  recordActionIntentEvent: vi.fn(),
}));

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

vi.mock('../services/authenticatorPolicy', () => ({
  loadPartnerPolicy: vi.fn(async () => null),
  isEnforcing: vi.fn(() => false),
}));

vi.mock('../services/actionIntents/intentApprovers', () => ({
  resolveIntentApprovers: vi.fn(async () => ['00000000-0000-0000-0000-000000000001']),
  isAgentIntentDecideAuthorized: vi.fn(async () => true),
}));

vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(async () => ({
    scope: 'organization',
    orgId: 'org-1',
    permissions: [
      { resource: 'approvals', action: 'decide' },
      { resource: 'pam', action: 'approve' },
    ],
  })),
  userCanDecideApprovals: vi.fn(() => true),
  canAccessOrg: vi.fn(() => true),
  hasPermission: vi.fn(
    (userPerms: { permissions: Array<{ resource: string; action: string }> } | null | undefined, resource: string, action: string) =>
      !!userPerms?.permissions?.some(
        (p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
      ),
  ),
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

vi.mock('./auth/helpers', () => ({
  requireCurrentPasswordStepUp: vi.fn(async () => null),
  requireFreshMfaStepUp: vi.fn(async () => null),
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

// #5601: the approvals-domain grant helpers, mocked wholesale so mint/redeem
// outcomes are deterministic per test rather than exercising the real
// Redis-backed transport (services/mfaStepUpGrant.ts). Defaults are the SAFE
// ones: eligible-by-default (so scope resolution isn't a second variable to
// wire per test) but redeem/mint both refuse by default (fail closed) —
// individual tests override per case.
vi.mock('../services/approvals/approvalDecideGrant', () => ({
  isApprovalDecideGrantEligible: vi.fn(() => true),
  mintApprovalDecideGrant: vi.fn(async () => null),
  redeemApprovalDecideGrant: vi.fn(async () => null),
}));

// #5601: `resolveGrantSession` (local to decideApprovalRequest.ts) calls this
// before attempting anything — mocked so it never reaches the real
// `users` table read.
vi.mock('../services/authEpochs', () => ({
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
}));

const TEST_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 't@example.com',
  name: 'Test User',
  isPlatformAdmin: false,
};

// `resolveGrantSession` requires `auth.token?.sid` — the default `approvals.test.ts`
// auth mock omits `token` entirely (irrelevant there). Every test in THIS file
// exercises the grant path, so the default here carries a session id.
function baseAuth() {
  return {
    principal: { kind: 'user_session' },
    scope: 'partner',
    partnerId: 'partner-123',
    orgId: null,
    user: TEST_USER,
    token: { sid: 'sid-1' },
    accessibleOrgIds: [],
    canAccessOrg: () => false,
    orgCondition: () => undefined,
  };
}

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', baseAuth());
    return next();
  }),
  isInteractiveUserSession: (auth: any) => auth?.principal?.kind === 'user_session',
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { approvalRoutes } from './approvals';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { assertApprovalAssurance } from '../services/authenticatorAssurance';
import { recordActionIntentEvent } from '../services/actionIntents/metrics';
import { resolveIntentApprovers, isAgentIntentDecideAuthorized } from '../services/actionIntents/intentApprovers';
import { checkToolPermission } from '../services/aiGuardrails';
import { buildAuthContextForIntent } from '../services/actionIntents/actorContext';
import { loadPartnerPolicy, isEnforcing } from '../services/authenticatorPolicy';
import { userCanDecideApprovals, canAccessOrg } from '../services/permissions';
import {
  isApprovalDecideGrantEligible,
  mintApprovalDecideGrant,
  redeemApprovalDecideGrant,
} from '../services/approvals/approvalDecideGrant';
import { getUserEpochs } from '../services/authEpochs';

function buildApp() {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app;
}

function postJson(path: string, body: unknown) {
  return buildApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Fix round 1, finding 2 (lock-order): an intent-linked decide-write tx opens
// with `SELECT ... FOR UPDATE` on the intent row. Copied verbatim from
// `approvals.test.ts`.
function txSelectForUpdateStub(rows: unknown[] = [{ id: 'intent-1', status: 'pending_approval' }]) {
  return vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ for: vi.fn().mockResolvedValue(rows) })) })),
  }));
}

// #5601: `resolveGrantScope` (local to decideApprovalRequest.ts, NOT mocked —
// it is the function under test's own collaborator logic) always attempts a
// real `db.select(...).from(aiToolExecutions).where(...).limit(1)` lookup for
// the conversation's `aiSessionId`, wrapped in a try/catch that degrades to
// `aiSessionId: null` on any failure. It runs whenever EITHER the redeem path
// or the post-commit mint path is reached, so any test reaching either must
// queue exactly one of these atop the base pre-fetch + intent-load selects.
function queueGrantScopeSelect(rows: unknown[] = []) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
}

let lastApprovalRow: Record<string, unknown> | undefined;

/** Wires the pre-fetch + intent-load selects for a FOUR_EYES sole-operator
 *  self-approve (requestedByUserId === TEST_USER.id by default). */
function mockFourEyesSelfApprove(opts: {
  riskTier?: string;
  requestedByUserId?: string;
} = {}) {
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
    boundArgumentDigest: 'digest-abc',
    isRecursive: false,
    createdAt: new Date(),
  };
  const intentRow = {
    id: 'intent-1',
    orgId: 'org-9',
    actionName: 'y',
    argumentDigest: 'digest-abc',
    source: 'mcp_api',
    status: 'pending_approval',
    requestedByUserId: opts.requestedByUserId ?? TEST_USER.id,
    approvalScope: 'four_eyes',
  };

  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([approvalRow]) }),
  } as any);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([intentRow]) }),
  } as any);

  lastApprovalRow = approvalRow;
  return { approvalRow, intentRow };
}

/** Wires the pre-fetch + intent-load selects for a SUPERVISED self-decide
 *  (requestedByUserId === TEST_USER.id, the only legal shape for supervised). */
function mockSupervisedSelfDecide(opts: { riskTier?: string } = {}) {
  const approvalRow = {
    id: 'appr-1',
    userId: TEST_USER.id,
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
    requestedByUserId: TEST_USER.id,
  };

  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([approvalRow]) }),
  } as any);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([intentRow]) }),
  } as any);

  lastApprovalRow = approvalRow;
  return { approvalRow, intentRow };
}

/** Wires the Task-6-style atomic decide-write tx (approval CAS, intent CAS,
 *  sibling expiry, outbox insert) for an intent id, returning the CAS `.set`
 *  spies so tests can assert on the persisted columns. */
function mockFanInTx(intentId: string) {
  const approvalCasReturning = vi.fn().mockResolvedValue([{ ...(lastApprovalRow ?? {}), status: 'approved' }]);
  const approvalCasSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: approvalCasReturning }),
  });
  const intentCasReturning = vi.fn().mockResolvedValue([{ id: intentId }]);
  const intentCasSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: intentCasReturning }),
  });
  const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const outboxValues = vi.fn().mockResolvedValue(undefined);
  const tx = {
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
  vi.mocked(db.update).mockReset();
  vi.mocked(db.insert).mockReset();
  vi.mocked(db.delete).mockReset();
  vi.mocked(db.transaction).mockReset();

  vi.mocked(assertApprovalAssurance).mockResolvedValue({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  });
  vi.mocked(resolveIntentApprovers).mockResolvedValue([TEST_USER.id]);
  vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(true);
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
  vi.mocked(loadPartnerPolicy).mockResolvedValue(null);
  vi.mocked(isEnforcing).mockReturnValue(false);
  vi.mocked(userCanDecideApprovals).mockReturnValue(true);
  vi.mocked(canAccessOrg).mockReturnValue(true);

  // #5601 grant collaborators: eligible-by-default, refuse-by-default.
  vi.mocked(isApprovalDecideGrantEligible).mockReturnValue(true);
  vi.mocked(mintApprovalDecideGrant).mockResolvedValue(null);
  vi.mocked(redeemApprovalDecideGrant).mockResolvedValue(null);
  vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });

  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', baseAuth());
    return next();
  });
});

describe('#5601 approval_decide step-up grant wiring', () => {
  it('reuses a valid step-up grant for a four_eyes self-approve: 200, CAS carries decidedAssuranceLevel 3 / webauthn_platform / decidedViaStepUpGrant true', async () => {
    mockFourEyesSelfApprove();
    queueGrantScopeSelect();
    const { approvalCasSet } = mockFanInTx('intent-1');
    vi.mocked(redeemApprovalDecideGrant).mockResolvedValueOnce({
      context: {
        decidedAssuranceLevel: 3,
        decidedVia: 'webauthn_platform',
        authenticatorDeviceId: 'dev-1',
        ceremonyAt: Date.now(),
      },
    });

    const res = await postJson('/approvals/appr-1/approve', { stepUpGrantId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(200);
    expect(approvalCasSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'approved',
        decidedAssuranceLevel: 3,
        decidedVia: 'webauthn_platform',
        decidedViaStepUpGrant: true,
      }),
    );
  });

  it('records assuranceSource: step_up_grant in the audit event details when the decision reused a grant', async () => {
    mockFourEyesSelfApprove();
    queueGrantScopeSelect();
    mockFanInTx('intent-1');
    vi.mocked(redeemApprovalDecideGrant).mockResolvedValueOnce({
      context: {
        decidedAssuranceLevel: 3,
        decidedVia: 'webauthn_platform',
        authenticatorDeviceId: 'dev-1',
        ceremonyAt: Date.now(),
      },
    });

    const res = await postJson('/approvals/appr-1/approve', { stepUpGrantId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(200);
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'self_approved_sole_operator',
        details: expect.objectContaining({ assuranceSource: 'step_up_grant' }),
      }),
    );
  });

  it('never records assuranceSource on a fresh-ceremony decision (proof, no grant)', async () => {
    mockFourEyesSelfApprove();
    queueGrantScopeSelect(); // post-commit mint attempt (fresh ceremony, not reused)
    mockFanInTx('intent-1');
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: 'dev-1',
    });

    const res = await postJson('/approvals/appr-1/approve', {
      proof: { credentialId: 'cred-1', authenticatorData: 'AA', clientDataJSON: 'BB', signature: 'CC', userHandle: null },
    });
    expect(res.status).toBe(200);
    const call = vi
      .mocked(recordActionIntentEvent)
      .mock.calls.find((c) => c[0]?.outcome === 'self_approved_sole_operator');
    expect(call).toBeDefined();
    expect(call?.[0]?.details as Record<string, unknown>).not.toHaveProperty('assuranceSource');
  });

  it('fails CLOSED (403 step_up_required) when the presented grant fails to redeem — never falls through to L1, and the row is never touched', async () => {
    // Deliberately a CROSS-USER four_eyes approve (requestedByUserId is
    // someone else), not a self-approve: a self-approve is ALSO caught by the
    // separate sole-operator >=L3 gate below, which would still 403 even if
    // the redeem-fail-closed check itself regressed to fall through to L1 —
    // masking exactly the regression this test exists to catch. Cross-user
    // never reaches that gate, so a 403 here can only come from the
    // fail-closed redeem branch itself.
    mockFourEyesSelfApprove({ requestedByUserId: 'requester-1' });
    queueGrantScopeSelect();
    vi.mocked(redeemApprovalDecideGrant).mockResolvedValueOnce(null);

    const res = await postJson('/approvals/appr-1/approve', { stepUpGrantId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('step_up_required');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a BAD presented grant on a supervised non-enforcing self-decide suppresses the plain-click skip: 403 step_up_required, never a silent L1 success', async () => {
    mockSupervisedSelfDecide();
    queueGrantScopeSelect();
    vi.mocked(redeemApprovalDecideGrant).mockResolvedValueOnce(null);

    const res = await postJson('/approvals/appr-1/approve', { stepUpGrantId: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('step_up_required');
    expect(db.transaction).not.toHaveBeenCalled();
    // Never resolved via the plain-click default.
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
  });

  it('control: the SAME supervised non-enforcing self-decide with NO grant and NO proof still succeeds at L1/session_tap', async () => {
    mockSupervisedSelfDecide();
    queueGrantScopeSelect(); // post-commit mint attempt on the plain-click success
    const { approvalCasSet } = mockFanInTx('intent-sv-1');

    const res = await postJson('/approvals/appr-1/approve', {});
    expect(res.status).toBe(200);
    expect(approvalCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ decidedAssuranceLevel: 1, decidedVia: 'session_tap' }),
    );
  });

  it('four_eyes self-approve is still refused below L3 even via a redeemed grant (shared gate is not routed around)', async () => {
    mockFourEyesSelfApprove();
    queueGrantScopeSelect();
    vi.mocked(redeemApprovalDecideGrant).mockResolvedValueOnce({
      context: {
        decidedAssuranceLevel: 2,
        decidedVia: 'webauthn_platform',
        authenticatorDeviceId: 'dev-1',
        ceremonyAt: Date.now(),
      },
    });

    const res = await postJson('/approvals/appr-1/approve', { stepUpGrantId: '33333333-3333-4333-8333-333333333333' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('step_up_required');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a presented proof beats a presented grant: the real ladder runs and the grant is never redeemed', async () => {
    mockFourEyesSelfApprove();
    queueGrantScopeSelect(); // post-commit mint attempt (fresh ceremony)
    mockFanInTx('intent-1');
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: 'dev-1',
    });

    const res = await postJson('/approvals/appr-1/approve', {
      proof: { credentialId: 'cred-1', authenticatorData: 'AA', clientDataJSON: 'BB', signature: 'CC', userHandle: null },
      stepUpGrantId: '44444444-4444-4444-8444-444444444444',
    });
    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).toHaveBeenCalled();
    expect(redeemApprovalDecideGrant).not.toHaveBeenCalled();
  });

  it('a grant-redeemed decision mints NOTHING and the response carries no stepUpGrantId', async () => {
    mockFourEyesSelfApprove();
    queueGrantScopeSelect();
    mockFanInTx('intent-1');
    vi.mocked(redeemApprovalDecideGrant).mockResolvedValueOnce({
      context: {
        decidedAssuranceLevel: 3,
        decidedVia: 'webauthn_platform',
        authenticatorDeviceId: 'dev-1',
        ceremonyAt: Date.now(),
      },
    });

    const res = await postJson('/approvals/appr-1/approve', { stepUpGrantId: '55555555-5555-4555-8555-555555555555' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mintApprovalDecideGrant).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty('stepUpGrantId');
  });

  it('a fresh-ceremony decision mints a reusable grant and returns it in the response body', async () => {
    mockFourEyesSelfApprove();
    queueGrantScopeSelect();
    mockFanInTx('intent-1');
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: 'dev-1',
    });
    vi.mocked(mintApprovalDecideGrant).mockResolvedValueOnce('grant-xyz');

    const res = await postJson('/approvals/appr-1/approve', {
      proof: { credentialId: 'cred-1', authenticatorData: 'AA', clientDataJSON: 'BB', signature: 'CC', userHandle: null },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stepUpGrantId).toBe('grant-xyz');
  });

  it('POST /:id/approve 400s on a malformed stepUpGrantId (route-level validation, before the decide core runs)', async () => {
    const res = await postJson('/approvals/appr-1/approve', { stepUpGrantId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });
});
