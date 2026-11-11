import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Deciding a four-eyes intent whose effect is partner-wide. The approver axis is
 * re-checked here, not only at fan-out: a queued row is a durable capability. Harness
 * copied from decideApprovalRequest.flow.test.ts (bare vi.fn() db, pass-through context
 * helpers); the predicate and membership reads have their own suite
 * (actionIntents/partnerAxisApprover.test.ts) and a real-rows one
 * (aiToolsAiDesignWrites.integration.test.ts).
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
vi.mock('../../middleware/auth', () => ({
  isInteractiveUserSession: (auth: any) => auth?.principal?.kind === 'user_session',
  hasSatisfiedMfa: () => true,
}));
vi.mock('../actionIntents/intentService', () => ({ RELEASE_LEASE_MS: 10 * 60 * 1000 }));
vi.mock('../actionIntents/metrics', () => ({ recordActionIntentEvent: vi.fn() }));
vi.mock('../actionIntents/intentApprovers', () => ({
  resolveIntentApprovers: vi.fn(async () => []),
  isAgentIntentDecideAuthorized: vi.fn(async () => true),
  isOrgWideGovernanceIntent: vi.fn(() => false),
}));
vi.mock('../actionIntents/partnerAxisApprover', () => ({
  intentRequiresPartnerAxisApprover: vi.fn(async () => true),
  isPartnerAxisApprover: vi.fn(async () => true),
}));
vi.mock('../actionIntents/actorContext', () => ({ buildAuthContextForIntent: vi.fn(async () => null) }));
vi.mock('../aiGuardrails', () => ({ checkToolPermission: vi.fn(async () => null) }));
vi.mock('../authenticatorPolicy', () => ({ loadPartnerPolicy: vi.fn(async () => null), isEnforcing: vi.fn(() => false) }));
vi.mock('../permissions', () => ({
  getUserPermissions: vi.fn(async () => ({ orgId: 'org', permissions: [] })),
  hasPermission: vi.fn(() => true),
  userCanDecideApprovals: vi.fn(() => true),
  canAccessOrg: vi.fn(() => true),
  canAccessSite: vi.fn(() => true),
}));
vi.mock('../authenticatorAssurance', () => ({
  assertDecisionConsistent: vi.fn(() => undefined),
  resolveApprovalAssurance: vi.fn(() => ({ requiredLevel: 1, decidedAssuranceLevel: 1, decidedVia: 'session_tap', authenticatorDeviceId: null })),
  assertApprovalAssurance: vi.fn(async () => ({ requiredLevel: 2, decidedAssuranceLevel: 2, decidedVia: 'session_tap', authenticatorDeviceId: null })),
  StepUpRequiredError: class StepUpRequiredError extends Error {},
  ReauthRequiredError: class ReauthRequiredError extends Error {},
}));
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
import { resolveIntentApprovers } from '../actionIntents/intentApprovers';
import { recordActionIntentEvent } from '../actionIntents/metrics';
import { intentRequiresPartnerAxisApprover, isPartnerAxisApprover } from '../actionIntents/partnerAxisApprover';
import { decideApprovalRequest } from './decideApprovalRequest';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DECIDER = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '33333333-3333-4333-8333-333333333333';
const SCHEDULE_ID = '55555555-5555-4555-8555-555555555555';
const INTENT_ID = '77777777-7777-4777-8777-777777777777';
const APPROVAL_ID = 'appr-partner-axis-1';

function authFor(userId: string, over: Record<string, unknown> = {}) {
  return {
    principal: { kind: 'user_session' },
    scope: 'partner',
    partnerId: 'partner-1',
    partnerOrgAccess: 'all',
    orgId: ORG_ID,
    user: { id: userId, email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    token: { sid: 'sid-1', mfa: true },
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
    ...over,
  } as any;
}

function approvalRow(userId: string) {
  return {
    id: APPROVAL_ID, userId, requestingClientLabel: 'Breeze AI', requestingMachineLabel: null,
    requestingClientId: null, requestingSessionId: null, actionLabel: 'Delete schedule',
    actionToolName: 'manage_ai_agent_schedules', actionArguments: {}, riskTier: 'high', riskSummary: 'Schedule AI agent runs.',
    status: 'pending', expiresAt: new Date(Date.now() + 60_000), decidedAt: null, decisionReason: null,
    executionId: null, elevationRequestId: null, intentId: INTENT_ID, diagnosticAccessGrantId: null,
    boundArgumentDigest: 'digest-1', isRecursive: false, createdAt: new Date(),
  };
}

function intent(over: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID, orgId: ORG_ID, partnerId: 'partner-1', status: 'pending_approval', source: 'chat',
    originPrincipalKind: 'user_session', originPrincipalId: REQUESTER, requestedByUserId: REQUESTER, requestingApiKeyId: null,
    requestingAgentRunId: null, requestingFlowRunId: null, actionName: 'manage_ai_agent_schedules',
    arguments: { action: 'delete', scheduleId: SCHEDULE_ID }, argumentDigest: 'digest-1', approvalScope: 'four_eyes',
    riskTier: 3, taskId: null, scopeKind: null, scopeDeviceId: null, scopeTicketId: null,
    ...over,
  };
}

function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as any);
}

/** The write transaction: reaching it proves every authorization gate passed. */
function txReached(): void {
  vi.mocked(db.transaction).mockImplementation(async () => { throw new Error('tx-reached'); });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
  vi.mocked(db.transaction).mockReset();
  vi.mocked(intentRequiresPartnerAxisApprover).mockResolvedValue(true);
  vi.mocked(isPartnerAxisApprover).mockResolvedValue(true);
  vi.mocked(resolveIntentApprovers).mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('decideApprovalRequest: partner-axis approver', () => {
  it('refuses an org-axis approver, before any assurance proof is spent', async () => {
    vi.mocked(isPartnerAxisApprover).mockResolvedValue(false);
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([intent()]);
    txReached();
    const auth = authFor(DECIDER, { scope: 'organization', partnerOrgAccess: null });

    const res = await decideApprovalRequest({ auth, id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).toBe(403);
    expect(res.body.error).toBe('approver_scope_required');
    expect(res.body.message).toContain('partner-level approver');
    expect(isPartnerAxisApprover).toHaveBeenCalledWith(DECIDER, ORG_ID, auth);
    expect(recordActionIntentEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'approver_unauthorized',
      details: expect.objectContaining({ errorCode: 'approver_scope_required' }),
    }));
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('admits a partner-axis approver', async () => {
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([intent()]);
    txReached();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER), id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).not.toBe(403);
    expect(db.transaction).toHaveBeenCalled();
  });

  it('an org-axis approver may still DENY: a deny only cancels', async () => {
    vi.mocked(isPartnerAxisApprover).mockResolvedValue(false);
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([intent()]);
    txReached();

    const res = await decideApprovalRequest({
      auth: authFor(DECIDER, { scope: 'organization', partnerOrgAccess: null }),
      id: APPROVAL_ID,
      status: 'denied',
    });

    expect(res.httpStatus).not.toBe(403);
    expect(isPartnerAxisApprover).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalled();
  });

  it("an org-level override delete keeps today's rule", async () => {
    vi.mocked(intentRequiresPartnerAxisApprover).mockResolvedValue(false);
    vi.mocked(isPartnerAxisApprover).mockResolvedValue(false);
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([intent()]);
    txReached();

    const res = await decideApprovalRequest({
      auth: authFor(DECIDER, { scope: 'organization', partnerOrgAccess: null }),
      id: APPROVAL_ID,
      status: 'approved',
    });

    expect(res.httpStatus).not.toBe(403);
    expect(isPartnerAxisApprover).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalled();
  });

  it('never consults the predicate for an action outside the registry', async () => {
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([intent({ actionName: 'manage_org_portal_settings', arguments: { action: 'set_sensitive_access' } })]);
    txReached();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER), id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).not.toBe(403);
    expect(intentRequiresPartnerAxisApprover).not.toHaveBeenCalled();
  });

  it('the sole-operator re-derivation asks for the same partner axis as the fan-out', async () => {
    vi.mocked(resolveIntentApprovers).mockResolvedValue([REQUESTER]);
    queueSelect([approvalRow(REQUESTER)]);
    queueSelect([intent()]);
    txReached();

    await decideApprovalRequest({ auth: authFor(REQUESTER), id: APPROVAL_ID, status: 'approved' });

    expect(resolveIntentApprovers).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({ requirePartnerAxis: true }));
  });

  it('a sole-operator re-derivation on an override does not ask for it', async () => {
    vi.mocked(intentRequiresPartnerAxisApprover).mockResolvedValue(false);
    vi.mocked(resolveIntentApprovers).mockResolvedValue([REQUESTER]);
    queueSelect([approvalRow(REQUESTER)]);
    queueSelect([intent()]);
    txReached();

    await decideApprovalRequest({ auth: authFor(REQUESTER), id: APPROVAL_ID, status: 'approved' });

    expect(vi.mocked(resolveIntentApprovers).mock.lastCall?.[1]).not.toHaveProperty('requirePartnerAxis');
  });
});
