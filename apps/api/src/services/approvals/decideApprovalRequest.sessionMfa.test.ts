import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Approving a high-or-above action intent needs the same session MFA claim as
 * the action's REST route (`requireMfa()`), whatever the partner's
 * approval-security policy. The assurance ladder and the partner policy are
 * REAL here (only the policy row read is stubbed), so "Not required" really
 * produces the grace downgrade it does in production. Harness shape copied
 * from decideApprovalRequest.partnerAxis.test.ts.
 */
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
  withDbTransactionIfHeld: (fn: any) => fn(),
  getCurrentDbAccessContext: () => undefined,
}));

vi.mock('../../db/schema/approvals', () => ({
  approvalRequests: {
    id: 'id', userId: 'user_id', intentId: 'intent_id', status: 'status', expiresAt: 'expires_at',
    diagnosticAccessGrantId: 'diagnostic_access_grant_id',
  },
}));
vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: { id: 'id', orgId: 'org_id', status: 'status' },
  intentOutbox: { id: 'id', intentId: 'intent_id', eventType: 'event_type', payload: 'payload' },
}));
vi.mock('../../db/schema/elevations', () => ({
  elevationRequests: { id: 'id', orgId: 'org_id', status: 'status' },
  elevationAudit: { id: 'id', orgId: 'org_id', elevationRequestId: 'elevation_request_id' },
}));
vi.mock('../../db/schema/ai', () => ({
  aiToolExecutions: { id: 'id', sessionId: 'session_id', status: 'status' },
  aiSessions: { id: 'id', userId: 'user_id' },
}));
vi.mock('../../db/schema/aiAgents', () => ({ aiAgentRuns: { id: 'id', deviceId: 'device_id' } }));
vi.mock('../../db/schema/devices', () => ({ devices: { id: 'id', orgId: 'org_id', siteId: 'site_id', hostname: 'hostname' } }));
vi.mock('../../db/schema/orgs', () => ({ organizations: { id: 'id', partnerId: 'partner_id' } }));
vi.mock('../../db/schema/diagnosticAccess', () => ({
  diagnosticAccessGrants: { id: 'id', orgId: 'org_id', deviceId: 'device_id', status: 'status', requestedByUserId: 'requested_by_user_id' },
}));
// Same predicate as the real helper with ENABLE_2FA on: the session's `mfa` claim.
vi.mock('../../middleware/auth', () => ({
  isInteractiveUserSession: (auth: any) => auth?.principal?.kind === 'user_session',
  hasSatisfiedMfa: (auth: any) => auth?.token?.mfa === true,
}));
vi.mock('../actionIntents/intentService', () => ({ RELEASE_LEASE_MS: 10 * 60 * 1000 }));
vi.mock('../actionIntents/metrics', () => ({ recordActionIntentEvent: vi.fn() }));
vi.mock('../actionIntents/intentApprovers', () => ({
  resolveIntentApprovers: vi.fn(async () => []),
  isAgentIntentDecideAuthorized: vi.fn(async () => true),
  isOrgWideGovernanceIntent: vi.fn(() => false),
}));
vi.mock('../actionIntents/partnerAxisApprover', () => ({
  intentRequiresPartnerAxisApprover: vi.fn(async () => false),
  isPartnerAxisApprover: vi.fn(async () => true),
}));
vi.mock('../actionIntents/actorContext', () => ({ buildAuthContextForIntent: vi.fn(async () => ({ requester: true })) }));
vi.mock('../aiGuardrails', () => ({ checkToolPermission: vi.fn(async () => null) }));
// Real policy resolution; only the row read is stubbed per test.
vi.mock('../authenticatorPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authenticatorPolicy')>();
  return { ...actual, loadPartnerPolicy: vi.fn(async () => null) };
});
vi.mock('../permissions', () => ({
  getUserPermissions: vi.fn(async () => ({ orgId: 'org', permissions: [] })),
  hasPermission: vi.fn(() => true),
  userCanDecideApprovals: vi.fn(() => true),
  canAccessOrg: vi.fn(() => true),
  canAccessSite: vi.fn(() => true),
}));
// The real ladder, wrapped so a test can read the decision it produced.
vi.mock('../authenticatorAssurance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authenticatorAssurance')>();
  return { ...actual, assertApprovalAssurance: vi.fn(actual.assertApprovalAssurance) };
});
vi.mock('../approverWebAuthn', () => ({ verifyApprovalAssertion: vi.fn() }));
vi.mock('../mobileHwKey', () => ({
  verifyMobileSignature: vi.fn(),
  consumeMobileAssertionNonce: vi.fn(),
  toMobileKeyAlg: vi.fn(),
}));
vi.mock('../anomalyMetrics', () => ({ recordAuthenticatorL4Basis: vi.fn() }));
vi.mock('../diagnosticAccess/grants', () => ({
  isEligibleApprover: vi.fn(async () => true),
  resolveEligibleApprovers: vi.fn(async () => []),
  decideDiagnosticGrantInTx: vi.fn(async () => null),
  auditDiagnosticDecision: vi.fn(async () => undefined),
  auditDiagnosticSelfApproval: vi.fn(async () => undefined),
}));
vi.mock('../flows/intentRun', () => ({ loadFlowIntentPeople: vi.fn() }));

import { db } from '../../db';
import { assertApprovalAssurance } from '../authenticatorAssurance';
import { loadPartnerPolicy } from '../authenticatorPolicy';
import { getUserPermissions } from '../permissions';
import { approveCodeCanCount, decideApprovalRequest } from './decideApprovalRequest';
import { recordDecisionMfaVerification } from './decisionMfaVerification';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DECIDER = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '33333333-3333-4333-8333-333333333333';
const INTENT_ID = '77777777-7777-4777-8777-777777777777';
const APPROVAL_ID = 'appr-session-mfa-1';

/** Explicit "Not required": never enforces, so an L1 approve is a grace downgrade. */
const NOT_REQUIRED = {
  partnerId: 'partner-1',
  requireEnrollment: false,
  enforceFrom: null,
  floorOverrides: {},
} as any;

/** Explicit "Required", already in force. (The test setup moves the platform
 *  default's date into the future, so a missing row does not enforce here.) */
const ENFORCING = {
  partnerId: 'partner-1',
  requireEnrollment: true,
  enforceFrom: new Date('2026-01-01T00:00:00Z'),
  floorOverrides: {},
} as any;

function authFor(userId: string, mfa: boolean) {
  return {
    principal: { kind: 'user_session' },
    scope: 'partner',
    partnerId: 'partner-1',
    partnerOrgAccess: 'all',
    orgId: ORG_ID,
    user: { id: userId, email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    token: { sid: 'sid-1', mfa },
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  } as any;
}

function approvalRow(userId: string, over: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID, userId, requestingClientLabel: 'Breeze AI', requestingMachineLabel: null,
    requestingClientId: null, requestingSessionId: null, actionLabel: 'Tier 3 action',
    actionToolName: 'manage_backup_profiles', actionArguments: { action: 'update' }, riskTier: 'high',
    riskSummary: 'Changes a backup profile.', status: 'pending', expiresAt: new Date(Date.now() + 60_000),
    decidedAt: null, decisionReason: null, executionId: null, elevationRequestId: null, intentId: INTENT_ID,
    diagnosticAccessGrantId: null, boundArgumentDigest: 'digest-1', isRecursive: false, createdAt: new Date(),
    ...over,
  };
}

/** Tier 3 supervised: decided by the requester alone. */
function supervisedIntent() {
  return {
    id: INTENT_ID, orgId: ORG_ID, status: 'pending_approval', source: 'chat',
    originPrincipalKind: 'user_session', originPrincipalId: DECIDER, requestedByUserId: DECIDER,
    requestingApiKeyId: null, requestingAgentRunId: null, requestingFlowRunId: null,
    actionName: 'manage_backup_profiles', arguments: { action: 'update', profileId: 'p-1' },
    argumentDigest: 'digest-1', approvalScope: 'supervised', riskTier: 3, taskId: null,
    scopeKind: null, scopeDeviceId: null, scopeTicketId: null,
  };
}

/** Tier 3 four-eyes: patch rollback, decided by someone other than the requester. */
function rollbackIntent() {
  return {
    ...supervisedIntent(),
    originPrincipalId: REQUESTER, requestedByUserId: REQUESTER,
    actionName: 'manage_patches', arguments: { action: 'rollback', patchId: 'patch-1', deviceIds: ['d-1'] },
    approvalScope: 'four_eyes',
  };
}

function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as any);
}

/**
 * The write transaction, stubbed to capture the approval CAS payload and then
 * report a lost race (409): reaching it proves every gate passed, and the
 * payload is exactly what the row would have recorded.
 */
function captureWrite(): { set?: Record<string, unknown> } {
  const captured: { set?: Record<string, unknown> } = {};
  vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          captured.set = values;
          return { where: () => ({ returning: async () => [] }) };
        },
      }),
    };
    return cb(tx);
  });
  return captured;
}

/**
 * `runsLadder`: the four-eyes row runs the assurance ladder; the supervised
 * row takes the plain-click shortcut, which reads the policy outside it.
 */
const ROWS = [
  { name: 'a Tier 3 supervised row', decider: DECIDER, intent: supervisedIntent, tool: 'manage_backup_profiles', runsLadder: false },
  { name: 'the four-eyes manage_patches:rollback row', decider: DECIDER, intent: rollbackIntent, tool: 'manage_patches', runsLadder: true },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
  // Past the queued reads: the row org's owner lookup. Default owner = the
  // session's partner (the common single-partner case).
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: ORG_ID, partnerId: 'partner-1' }]) }),
  } as any);
  vi.mocked(db.transaction).mockReset();
  vi.mocked(loadPartnerPolicy).mockResolvedValue(NOT_REQUIRED);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each(ROWS)('decideApprovalRequest: session MFA on approve of $name', ({ decider, intent, tool }) => {
  it('refuses an approve from a session without MFA under a "Not required" policy', async () => {
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(decider, false), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'MFA required', code: 'MFA_REQUIRED' } });
    expect(write.set).toBeUndefined();
  });

  it('requires the MFA claim with an approver-device proof too', async () => {
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({
      auth: authFor(decider, false),
      id: APPROVAL_ID,
      status: 'approved',
      proof: { type: 'webauthn_platform', credentialId: 'c', authenticatorData: 'a', clientDataJSON: 'j', signature: 's' } as any,
    });

    expect(res.httpStatus).toBe(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
    // Refused before the ladder, so no single-use challenge is spent.
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(write.set).toBeUndefined();
  });

  it('lets the same session DENY', async () => {
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(decider, false), id: APPROVAL_ID, status: 'denied' });

    expect(res.httpStatus).toBe(409); // the stubbed lost race: the deny reached the write
    expect(write.set).toMatchObject({ status: 'denied' });
  });

  it('approves for a session with MFA, still recorded as a grace downgrade at L1', async () => {
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(decider, true), id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).toBe(409);
    expect(write.set).toMatchObject({ status: 'approved', decidedAssuranceLevel: 1, decidedVia: 'session_tap' });
    if (vi.mocked(assertApprovalAssurance).mock.results.length > 0) {
      // four-eyes runs the ladder: the decision it returned is the grace downgrade
      const decision = await vi.mocked(assertApprovalAssurance).mock.results[0]!.value;
      expect(decision).toMatchObject({ graceDowngrade: true, requiredLevel: 3, decidedAssuranceLevel: 1 });
    }
  });

  it('an enforcing policy is unchanged: an MFA session without a proof still needs L3', async () => {
    vi.mocked(loadPartnerPolicy).mockResolvedValue(ENFORCING);
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(decider, true), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'step_up_required', requiredLevel: 3 } });
    expect(write.set).toBeUndefined();
  });
});

describe('decideApprovalRequest: session MFA scope', () => {
  it('does not gate a medium-risk intent approve', async () => {
    queueSelect([approvalRow(DECIDER, { riskTier: 'medium' })]);
    queueSelect([{ ...supervisedIntent(), riskTier: 2 }]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER, false), id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).toBe(409);
    expect(write.set).toMatchObject({ status: 'approved' });
  });

  it("gates a medium-risk intent whose action's REST route requires MFA (agent Tier 2 lane)", async () => {
    queueSelect([approvalRow(DECIDER, { riskTier: 'medium', actionToolName: 'manage_patches', actionArguments: { action: 'bulk_approve' } })]);
    queueSelect([{
      ...supervisedIntent(),
      requestedByUserId: null,
      requestingAgentRunId: 'run-1',
      actionName: 'manage_patches',
      arguments: { action: 'bulk_approve', patchIds: ['p-1'] },
    }]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER, false), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'MFA required', code: 'MFA_REQUIRED' } });
    expect(write.set).toBeUndefined();
  });

  it('gates on the higher of the approval row tier and the intent tier', async () => {
    queueSelect([approvalRow(DECIDER, { riskTier: 'medium' })]);
    queueSelect([supervisedIntent()]); // intent tier 3 = high
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER, false), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'MFA required', code: 'MFA_REQUIRED' } });
    expect(write.set).toBeUndefined();
  });

  it('gates a critical intent approve', async () => {
    queueSelect([approvalRow(DECIDER, { riskTier: 'critical' })]);
    queueSelect([supervisedIntent()]);
    captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER, false), id: APPROVAL_ID, status: 'approved' });

    expect(res.body.code).toBe('MFA_REQUIRED');
  });
});

/**
 * The approval-security policy that applies is the STRICTER of the session
 * partner's and the partner that owns the row's org. One identity can hold
 * memberships in two partners; a decision in partner-2's org from a partner-1
 * session meets both partners' policies.
 */
describe.each(ROWS)('decideApprovalRequest: row partner policy on approve of $name', ({ decider, intent, tool, runsLadder }) => {
  const SESSION_PARTNER = 'partner-1';
  const ROW_PARTNER = 'partner-2';

  function policies(byPartner: Record<string, unknown>) {
    vi.mocked(loadPartnerPolicy).mockImplementation(async (id) => (byPartner[id ?? ''] ?? null) as any);
  }
  function queueRow(owner = ROW_PARTNER) {
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    // Every later owner read (decide authority and the policy set) resolves
    // the row org to its owning partner.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: ORG_ID, partnerId: owner }]) }),
    } as any);
  }

  it('session partner opted out, row partner enforcing: the row partner floor applies (step-up)', async () => {
    policies({ [SESSION_PARTNER]: NOT_REQUIRED, [ROW_PARTNER]: ENFORCING });
    queueRow();
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(decider, true), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'step_up_required', requiredLevel: 3 } });
    expect(write.set).toBeUndefined();
    expect(loadPartnerPolicy).toHaveBeenCalledWith(ROW_PARTNER);
  });

  it('session partner enforcing, row partner opted out: still the stricter one (step-up)', async () => {
    policies({ [SESSION_PARTNER]: ENFORCING, [ROW_PARTNER]: NOT_REQUIRED });
    queueRow();
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(decider, true), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'step_up_required', requiredLevel: 3 } });
    expect(write.set).toBeUndefined();
  });

  it('both opted out: allowed as a grace downgrade, never refused for the partner mismatch', async () => {
    policies({ [SESSION_PARTNER]: NOT_REQUIRED, [ROW_PARTNER]: NOT_REQUIRED });
    queueRow();
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(decider, true), id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).toBe(409); // reached the (stubbed) write
    expect(write.set).toMatchObject({ status: 'approved', decidedAssuranceLevel: 1 });
  });

  it('a row partner floor override is read and applied', async () => {
    policies({
      [SESSION_PARTNER]: NOT_REQUIRED,
      [ROW_PARTNER]: { ...NOT_REQUIRED, partnerId: ROW_PARTNER, floorOverrides: { high: 4 } },
    });
    queueRow();
    captureWrite();

    await decideApprovalRequest({ auth: authFor(decider, true), id: APPROVAL_ID, status: 'approved' });

    expect(loadPartnerPolicy).toHaveBeenCalledWith(ROW_PARTNER);
    if (vi.mocked(assertApprovalAssurance).mock.results.length > 0) {
      // four-eyes runs the ladder: the decision carries the raised floor
      const decision = await vi.mocked(assertApprovalAssurance).mock.results[0]!.value;
      expect(decision).toMatchObject({ requiredLevel: 4, graceDowngrade: true });
    }
  });

  it('a policy-read fault refuses the approve (never an L1 approve), and a DENY still lands', async () => {
    vi.mocked(loadPartnerPolicy).mockRejectedValue(new Error('pool exhausted'));
    queueRow();
    const write = captureWrite();

    const approve = decideApprovalRequest({ auth: authFor(decider, true), id: APPROVAL_ID, status: 'approved' });
    if (runsLadder) {
      // The ladder answers a fault as a retryable failed verification.
      expect(await approve).toEqual({ httpStatus: 401, body: { error: 'assertion_failed' } });
    } else {
      // The plain-click shortcut rethrows; the route answers it with a 500.
      await expect(approve).rejects.toThrow('pool exhausted');
    }
    expect(write.set).toBeUndefined();

    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const deny = await decideApprovalRequest({ auth: authFor(decider, true), id: APPROVAL_ID, status: 'denied' });
    expect(deny.httpStatus).toBe(409); // reached the (stubbed) write
    expect(write.set).toMatchObject({ status: 'denied' });
  });

  it('a DENY reads no policy at all', async () => {
    policies({ [SESSION_PARTNER]: NOT_REQUIRED, [ROW_PARTNER]: ENFORCING });
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(decider, false), id: APPROVAL_ID, status: 'denied' });

    expect(res.httpStatus).toBe(409);
    expect(write.set).toMatchObject({ status: 'denied' });
    expect(loadPartnerPolicy).not.toHaveBeenCalled();
  });
});

/**
 * A fresh one-time code the server verified for this approve request counts
 * as the second factor, alongside the session's MFA claim. The route mints the
 * verification only after checking the code; the core accepts nothing else.
 */
describe.each(ROWS)('decideApprovalRequest: a code verified at decision time on $name', ({ decider, intent, tool }) => {
  it('approves for a session without the MFA claim when the server verified a code in this request', async () => {
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({
      auth: authFor(decider, false),
      id: APPROVAL_ID,
      status: 'approved',
      decisionMfa: recordDecisionMfaVerification(decider),
    });

    expect(res.httpStatus).toBe(409); // reached the (stubbed) write
    expect(write.set).toMatchObject({ status: 'approved' });
  });

  it('does not accept a look-alike object the server did not mint', async () => {
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({
      auth: authFor(decider, false),
      id: APPROVAL_ID,
      status: 'approved',
      decisionMfa: { userId: decider, method: 'totp' } as any,
    });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'MFA required', code: 'MFA_REQUIRED' } });
    expect(write.set).toBeUndefined();
  });

  it('does not accept a verification minted for another user', async () => {
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({
      auth: authFor(decider, false),
      id: APPROVAL_ID,
      status: 'approved',
      decisionMfa: recordDecisionMfaVerification(REQUESTER),
    });

    expect(res.body.code).toBe('MFA_REQUIRED');
    expect(write.set).toBeUndefined();
  });

  it('authorizes one decide call only', async () => {
    const verification = recordDecisionMfaVerification(decider);
    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    captureWrite();
    const first = await decideApprovalRequest({
      auth: authFor(decider, false), id: APPROVAL_ID, status: 'approved', decisionMfa: verification,
    });
    expect(first.httpStatus).toBe(409);

    queueSelect([approvalRow(decider, { actionToolName: tool })]);
    queueSelect([intent()]);
    const write = captureWrite();
    const second = await decideApprovalRequest({
      auth: authFor(decider, false), id: APPROVAL_ID, status: 'approved', decisionMfa: verification,
    });
    expect(second.body.code).toBe('MFA_REQUIRED');
    expect(write.set).toBeUndefined();
  });
});

/**
 * Decide authority over a row is resolved in the partner that owns the row's
 * org, never in the signed-in session's partner. The decider here belongs to
 * two partners; the session is in partner-1, the row's org is owned by
 * partner-2.
 */
describe('decideApprovalRequest: authority comes from the partner that owns the row org', () => {
  const SESSION_PARTNER = 'partner-1';
  const OWNER_PARTNER = 'partner-2';
  const PERMS = { scope: 'partner', orgAccess: 'all', permissions: [] } as any;

  beforeEach(() => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: ORG_ID, partnerId: OWNER_PARTNER }]) }),
    } as any);
  });

  it('four-eyes approve: resolves permissions in the owning partner', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS);
    queueSelect([approvalRow(DECIDER, { actionToolName: 'manage_patches' })]);
    queueSelect([rollbackIntent()]);
    captureWrite();

    await decideApprovalRequest({ auth: authFor(DECIDER, true), id: APPROVAL_ID, status: 'approved' });

    expect(getUserPermissions).toHaveBeenCalledWith(DECIDER, { orgId: ORG_ID, partnerId: OWNER_PARTNER });
    expect(getUserPermissions).not.toHaveBeenCalledWith(DECIDER, expect.objectContaining({ partnerId: SESSION_PARTNER }));
  });

  it('four-eyes approve: a role held only in the session partner is refused', async () => {
    vi.mocked(getUserPermissions).mockImplementation(async (_u, ctx) => (ctx.partnerId === SESSION_PARTNER ? PERMS : null));
    queueSelect([approvalRow(DECIDER, { actionToolName: 'manage_patches' })]);
    queueSelect([rollbackIntent()]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER, true), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'forbidden' } });
    expect(write.set).toBeUndefined();
  });

  it('PAM approve: a role held only in the session partner is refused', async () => {
    vi.mocked(getUserPermissions).mockImplementation(async (_u, ctx) => (ctx.partnerId === SESSION_PARTNER ? PERMS : null));
    queueSelect([approvalRow(DECIDER, {
      intentId: null, elevationRequestId: 'elev-1', actionToolName: 'ai_tool_action', riskTier: 'medium',
    })]);
    queueSelect([{ orgId: ORG_ID, flowType: 'ai_tool_action', deviceId: 'dev-1' }]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER, true), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'pam_approve_required' } });
    expect(write.set).toBeUndefined();
  });
});

/**
 * A PAM elevation of any flow type decided through the approvals route: an
 * approve needs a second factor, and a code the server verified in this
 * request counts as one, exactly as for an intent row. A deny needs neither.
 */
describe('decideApprovalRequest: second factor on a PAM elevation approve', () => {
  const PAM_ROW = { intentId: null, elevationRequestId: 'elev-1', actionToolName: 'tech_jit_admin', riskTier: 'low' };
  const ELEVATION = { orgId: ORG_ID, siteId: null, flowType: 'tech_jit_admin', deviceId: 'dev-1', subjectUserId: REQUESTER };

  it('refuses a session without the MFA claim', async () => {
    queueSelect([approvalRow(DECIDER, PAM_ROW)]);
    queueSelect([ELEVATION]);
    const write = captureWrite();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER, false), id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'MFA required', code: 'MFA_REQUIRED' } });
    expect(write.set).toBeUndefined();
  });

  it('accepts a code the server verified in this request', async () => {
    queueSelect([approvalRow(DECIDER, PAM_ROW)]);
    queueSelect([ELEVATION]);
    const write = captureWrite();

    await decideApprovalRequest({
      auth: authFor(DECIDER, false),
      id: APPROVAL_ID,
      status: 'approved',
      decisionMfa: recordDecisionMfaVerification(DECIDER),
    });

    // Reached the (stubbed) write transaction, so every gate passed.
    expect(write.set).toBeDefined();
  });

  it('lets a session without the MFA claim deny', async () => {
    queueSelect([approvalRow(DECIDER, PAM_ROW)]);
    queueSelect([ELEVATION]);
    const write = captureWrite();

    await decideApprovalRequest({ auth: authFor(DECIDER, false), id: APPROVAL_ID, status: 'denied' });

    // Reached the (stubbed) write transaction, so every gate passed.
    expect(write.set).toBeDefined();
  });
});

describe('approveCodeCanCount: whether a code sent with an approve can change the outcome', () => {
  const cases: Array<[string, { riskTier: string; intentId: string | null; elevationRequestId: string | null }, boolean]> = [
    ['a PAM elevation at low risk', { riskTier: 'low', intentId: null, elevationRequestId: 'e1' }, true],
    ['an action intent at low risk', { riskTier: 'low', intentId: 'i1', elevationRequestId: null }, true],
    ['an action intent at medium risk', { riskTier: 'medium', intentId: 'i1', elevationRequestId: null }, true],
    ['an unlinked high-risk row', { riskTier: 'high', intentId: null, elevationRequestId: null }, true],
    ['an unlinked critical row (re-authentication)', { riskTier: 'critical', intentId: null, elevationRequestId: null }, true],
    ['an unlinked low-risk row', { riskTier: 'low', intentId: null, elevationRequestId: null }, false],
    ['an unlinked medium-risk row', { riskTier: 'medium', intentId: null, elevationRequestId: null }, false],
  ];
  for (const [name, row, expected] of cases) {
    it(`${name}: ${expected}`, () => {
      expect(approveCodeCanCount(row as never)).toBe(expected);
    });
  }
});
