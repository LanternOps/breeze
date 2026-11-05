import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tool catalog W04 (#5219), plan Task A5 / Decision 6 — deciding a
 * flow-origin intent. Harness copied from
 * decideApprovalRequest.diagnosticAccess.test.ts (bare vi.fn() db, pass-through
 * context helpers).
 *
 *  - supervised flow intent: agent-origin POOL semantics
 *    (`isAgentIntentDecideAuthorized`), never the requester rule — the intent
 *    has no requester, so `not_requester` would refuse everyone;
 *  - four_eyes flow intent: the publication's delegator and a manual run's
 *    triggerer are refused at decide time, read from SERVER data
 *    (`loadFlowIntentPeople`), never from the client.
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
vi.mock('../actionIntents/actorContext', () => ({ buildAuthContextForIntent: vi.fn(async () => null) }));
vi.mock('../aiGuardrails', () => ({ checkToolPermission: vi.fn(async () => null) }));
vi.mock('../authenticatorPolicy', () => ({ loadPartnerPolicy: vi.fn(async () => null), isEnforcing: vi.fn(() => false) }));
vi.mock('../permissions', () => ({
  getUserPermissions: vi.fn(async () => null),
  hasPermission: vi.fn(() => false),
  userCanDecideApprovals: vi.fn(() => false),
  canAccessOrg: vi.fn(() => false),
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
import { isAgentIntentDecideAuthorized } from '../actionIntents/intentApprovers';
import { getUserPermissions, userCanDecideApprovals, canAccessOrg } from '../permissions';
import { loadFlowIntentPeople } from '../flows/intentRun';
import { decideApprovalRequest } from './decideApprovalRequest';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DECIDER = '22222222-2222-4222-8222-222222222222';
const DELEGATOR = '33333333-3333-4333-8333-333333333333';
const TRIGGERER = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const FLOW_ID = '66666666-6666-4666-8666-666666666666';
const INTENT_ID = '77777777-7777-4777-8777-777777777777';
const APPROVAL_ID = 'appr-flow-1';

function authFor(userId: string) {
  return {
    principal: { kind: 'user_session' },
    scope: 'organization',
    partnerId: 'partner-1',
    orgId: ORG_ID,
    user: { id: userId, email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    token: { sid: 'sid-1', mfa: true },
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  } as any;
}

function approvalRow(userId: string) {
  return {
    id: APPROVAL_ID, userId, requestingClientLabel: 'Flow Disk cleanup', requestingMachineLabel: null,
    requestingClientId: null, requestingSessionId: null, actionLabel: 'Step cleanup: run_script',
    actionToolName: 'run_script', actionArguments: {}, riskTier: 'high', riskSummary: 'Runs a script',
    status: 'pending', expiresAt: new Date(Date.now() + 60_000), decidedAt: null, decisionReason: null,
    executionId: null, elevationRequestId: null, intentId: INTENT_ID, diagnosticAccessGrantId: null,
    boundArgumentDigest: 'digest-1', isRecursive: false, createdAt: new Date(),
  };
}

function flowIntent(approvalScope: 'supervised' | 'four_eyes') {
  return {
    id: INTENT_ID, orgId: ORG_ID, partnerId: 'partner-1', status: 'pending_approval', source: 'flow',
    originPrincipalKind: 'flow', originPrincipalId: FLOW_ID, requestedByUserId: null, requestingApiKeyId: null,
    requestingAgentRunId: null, requestingFlowRunId: RUN_ID, actionName: 'run_script',
    arguments: { scriptId: 'script-1', deviceIds: ['dev-1'] }, argumentDigest: 'digest-1', approvalScope,
    riskTier: 3, taskId: null, scopeKind: null, scopeDeviceId: null, scopeTicketId: null,
  };
}

function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as any);
}

/** The write transaction — reaching it proves every authorization gate passed. */
function txReached(): void {
  vi.mocked(db.transaction).mockImplementation(async () => { throw new Error('tx-reached'); });
}

function fourEyesDeciderPerms(): void {
  vi.mocked(getUserPermissions).mockResolvedValue({ orgId: ORG_ID, permissions: [] } as any);
  vi.mocked(canAccessOrg).mockReturnValue(true);
  vi.mocked(userCanDecideApprovals).mockReturnValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
  vi.mocked(db.transaction).mockReset();
  vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(true);
  vi.mocked(loadFlowIntentPeople).mockResolvedValue({ delegatorUserId: DELEGATOR, triggeredByUserId: TRIGGERER });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('decideApprovalRequest: flow-origin intents', () => {
  it('a pool member approves a supervised flow intent (no not_requester)', async () => {
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([flowIntent('supervised')]);
    txReached();

    const res = await decideApprovalRequest({ auth: authFor(DECIDER), id: APPROVAL_ID, status: 'approved' });

    expect(res.body.error).not.toBe('not_requester');
    expect(res.httpStatus).not.toBe(403);
    expect(isAgentIntentDecideAuthorized).toHaveBeenCalledWith(DECIDER, expect.objectContaining({ id: INTENT_ID, requestingFlowRunId: RUN_ID }));
    // No requester ⇒ no supervised self-decide shortcut: the assurance ladder runs.
    expect(assertApprovalAssurance).toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalled();
  });

  it('the delegator MAY approve a supervised step of their own flow (spec §6.5)', async () => {
    queueSelect([approvalRow(DELEGATOR)]);
    queueSelect([flowIntent('supervised')]);
    txReached();
    const res = await decideApprovalRequest({ auth: authFor(DELEGATOR), id: APPROVAL_ID, status: 'approved' });
    expect(res.httpStatus).not.toBe(403);
    expect(db.transaction).toHaveBeenCalled();
  });

  it('a decider outside the pool is refused a supervised flow intent', async () => {
    vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(false);
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([flowIntent('supervised')]);
    const res = await decideApprovalRequest({ auth: authFor(DECIDER), id: APPROVAL_ID, status: 'approved' });
    expect(res).toEqual({ httpStatus: 403, body: { error: 'not_authorized_for_agent_intent' } });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('delegator cannot approve a four-eyes flow intent (another eligible approver present)', async () => {
    fourEyesDeciderPerms();
    queueSelect([approvalRow(DELEGATOR)]);
    queueSelect([flowIntent('four_eyes')]);
    txReached();
    const res = await decideApprovalRequest({ auth: authFor(DELEGATOR), id: APPROVAL_ID, status: 'approved' });
    expect(res.httpStatus).toBe(403);
    expect(res.body.error).toBe('self_approval_forbidden');
    expect(loadFlowIntentPeople).toHaveBeenCalledWith(RUN_ID);
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('delegator cannot approve a four-eyes flow intent even as sole approver', async () => {
    fourEyesDeciderPerms();
    const { resolveIntentApprovers } = await import('../actionIntents/intentApprovers');
    vi.mocked(resolveIntentApprovers).mockResolvedValue([DELEGATOR]);
    queueSelect([approvalRow(DELEGATOR)]);
    queueSelect([flowIntent('four_eyes')]);
    txReached();
    const res = await decideApprovalRequest({ auth: authFor(DELEGATOR), id: APPROVAL_ID, status: 'approved' });
    expect(res.httpStatus).toBe(403);
    expect(res.body.error).toBe('self_approval_forbidden');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('the manual-run triggerer cannot approve a four-eyes flow intent', async () => {
    fourEyesDeciderPerms();
    queueSelect([approvalRow(TRIGGERER)]);
    queueSelect([flowIntent('four_eyes')]);
    txReached();
    const res = await decideApprovalRequest({ auth: authFor(TRIGGERER), id: APPROVAL_ID, status: 'approved' });
    expect(res.httpStatus).toBe(403);
    expect(res.body.error).toBe('self_approval_forbidden');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('an unrelated approvals:decide holder approves a four-eyes flow intent', async () => {
    fourEyesDeciderPerms();
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([flowIntent('four_eyes')]);
    txReached();
    const res = await decideApprovalRequest({ auth: authFor(DECIDER), id: APPROVAL_ID, status: 'approved' });
    expect(res.httpStatus).not.toBe(403);
    expect(db.transaction).toHaveBeenCalled();
  });

  it('an unreadable run fails closed for a four-eyes flow approve', async () => {
    fourEyesDeciderPerms();
    vi.mocked(loadFlowIntentPeople).mockResolvedValue(null);
    queueSelect([approvalRow(DECIDER)]);
    queueSelect([flowIntent('four_eyes')]);
    const res = await decideApprovalRequest({ auth: authFor(DECIDER), id: APPROVAL_ID, status: 'approved' });
    expect(res.httpStatus).toBe(403);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('the delegator may still DENY a four-eyes flow intent (a deny only cancels)', async () => {
    queueSelect([approvalRow(DELEGATOR)]);
    queueSelect([flowIntent('four_eyes')]);
    txReached();
    const res = await decideApprovalRequest({ auth: authFor(DELEGATOR), id: APPROVAL_ID, status: 'denied' });
    expect(res.httpStatus).not.toBe(403);
    expect(db.transaction).toHaveBeenCalled();
  });
});
