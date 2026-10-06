import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock shape mirrors batchDecide.test.ts (the same decide core): the DB is a
// bare set of vi.fn()s and the two RLS context helpers are pass-throughs so the
// mocked db.select/db.transaction run inline. The diagnostic-access grant
// helpers are mocked wholesale so each test controls eligibility and the
// in-transaction grant transition directly.
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
    id: 'id',
    userId: 'user_id',
    intentId: 'intent_id',
    status: 'status',
    expiresAt: 'expires_at',
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

vi.mock('../../db/schema/aiAgents', () => ({
  aiAgentRuns: { id: 'id', deviceId: 'device_id' },
}));

vi.mock('../../db/schema/devices', () => ({
  devices: { id: 'id', orgId: 'org_id', siteId: 'site_id', hostname: 'hostname' },
}));

vi.mock('../../db/schema/orgs', () => ({
  organizations: { id: 'id', partnerId: 'partner_id' },
}));

vi.mock('../../db/schema/diagnosticAccess', () => ({
  diagnosticAccessGrants: {
    id: 'id',
    orgId: 'org_id',
    deviceId: 'device_id',
    status: 'status',
    requestedByUserId: 'requested_by_user_id',
  },
}));

vi.mock('../../middleware/auth', () => ({
  isInteractiveUserSession: (auth: any) => auth?.principal?.kind === 'user_session',
}));

vi.mock('../actionIntents/intentService', () => ({
  RELEASE_LEASE_MS: 10 * 60 * 1000,
}));

vi.mock('../actionIntents/metrics', () => ({
  recordActionIntentEvent: vi.fn(),
}));

vi.mock('../actionIntents/intentApprovers', () => ({
  resolveIntentApprovers: vi.fn(async () => []),
  isAgentIntentDecideAuthorized: vi.fn(async () => true),
  isOrgWideGovernanceIntent: vi.fn(() => false),
}));

vi.mock('../actionIntents/actorContext', () => ({
  buildAuthContextForIntent: vi.fn(async () => null),
}));

vi.mock('../aiGuardrails', () => ({
  checkToolPermission: vi.fn(async () => null),
}));

vi.mock('../authenticatorPolicy', () => ({
  loadPartnerPolicy: vi.fn(async () => null),
  isEnforcing: vi.fn(() => false),
}));

vi.mock('../permissions', () => ({
  getUserPermissions: vi.fn(async () => null),
  hasPermission: vi.fn(() => false),
  userCanDecideApprovals: vi.fn(() => false),
  canAccessOrg: vi.fn(() => false),
}));

vi.mock('../authenticatorAssurance', () => ({
  assertDecisionConsistent: vi.fn(() => undefined),
  resolveApprovalAssurance: vi.fn(() => ({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  })),
  assertApprovalAssurance: vi.fn(async () => ({
    requiredLevel: 2,
    decidedAssuranceLevel: 2,
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
      super('reauth required');
      this.name = 'ReauthRequiredError';
    }
  },
}));

vi.mock('../diagnosticAccess/grants', () => ({
  isEligibleApprover: vi.fn(async () => true),
  resolveEligibleApprovers: vi.fn(async () => []),
  decideDiagnosticGrantInTx: vi.fn(async () => null),
  auditDiagnosticDecision: vi.fn(async () => undefined),
}));

import { db } from '../../db';
import { assertApprovalAssurance } from '../authenticatorAssurance';
import {
  auditDiagnosticDecision,
  decideDiagnosticGrantInTx,
  isEligibleApprover,
  resolveEligibleApprovers,
} from '../diagnosticAccess/grants';
import { decideApprovalRequest } from './decideApprovalRequest';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = 'appr-diag-1';

const AUTH = {
  principal: { kind: 'user_session' },
  scope: 'partner',
  partnerId: 'partner-123',
  orgId: null,
  user: { id: USER_ID, email: 't@example.com', name: 'Test User', isPlatformAdmin: false },
  token: { sid: 'sid-1' },
  accessibleOrgIds: [],
  canAccessOrg: () => false,
  orgCondition: () => undefined,
} as any;

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID,
    userId: USER_ID,
    requestingClientLabel: 'Breeze AI',
    requestingMachineLabel: null,
    requestingClientId: null,
    requestingSessionId: null,
    actionLabel: 'Read diagnostic files',
    actionToolName: 'request_diagnostic_access',
    actionArguments: {},
    riskTier: 'high',
    riskSummary: 'Read-only file access',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    decidedAt: null,
    decisionReason: null,
    executionId: null,
    elevationRequestId: null,
    intentId: null,
    diagnosticAccessGrantId: GRANT_ID,
    boundArgumentDigest: null,
    isRecursive: false,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Pre-fetch: db.select().from(approvalRequests).where(...) -> [row]. */
function queueApprovalPrefetch(row: Record<string, unknown> | undefined) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(row ? [row] : []) }),
  } as any);
}

/** Diagnostic target read: select(...).from(grants).innerJoin(devices).innerJoin(orgs).where(...). */
function queueGrantTarget(row: Record<string, unknown> | null) {
  const where = vi.fn().mockResolvedValue(row ? [row] : []);
  const join2 = vi.fn().mockReturnValue({ where });
  const join1 = vi.fn().mockReturnValue({ innerJoin: join2 });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ innerJoin: join1 }),
  } as any);
}

function pendingTarget(overrides: Record<string, unknown> = {}) {
  return {
    orgId: 'org-9',
    status: 'pending_approval',
    deviceOrgId: 'org-9',
    siteId: 'site-1',
    partnerId: 'partner-123',
    ...overrides,
  };
}

/** The decide-write transaction: only the approval CAS runs for a row with no intent/elevation/execution. */
function mockDecideTx(decidedStatus: 'approved' | 'denied') {
  const casReturning = vi.fn().mockResolvedValue([approvalRow({ status: decidedStatus })]);
  const casSet = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: casReturning }) });
  const tx = {
    select: vi.fn(),
    update: vi.fn().mockReturnValue({ set: casSet }),
    insert: vi.fn(),
  };
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
  return { tx, casSet };
}

function grantRow(status: 'active' | 'denied') {
  return {
    id: GRANT_ID,
    orgId: 'org-9',
    deviceId: 'dev-1',
    status,
    scopes: ['C:\\ProgramData\\App\\Logs'],
    operations: ['list', 'read'],
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
  vi.mocked(db.update).mockReset();
  vi.mocked(db.insert).mockReset();
  vi.mocked(db.transaction).mockReset();
  vi.mocked(isEligibleApprover).mockResolvedValue(true);
  vi.mocked(resolveEligibleApprovers).mockResolvedValue([]);
  vi.mocked(decideDiagnosticGrantInTx).mockResolvedValue(null);
  vi.mocked(auditDiagnosticDecision).mockResolvedValue(undefined);
  vi.mocked(assertApprovalAssurance).mockResolvedValue({
    requiredLevel: 2,
    decidedAssuranceLevel: 2,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  } as any);
});

describe('decideApprovalRequest: diagnostic access grant branch', () => {
  it.each(['approved', 'denied'] as const)(
    'refuses an ineligible approver with 403 diagnostic_access_approver_required (%s) and never touches the grant',
    async (status) => {
      queueApprovalPrefetch(approvalRow());
      queueGrantTarget(pendingTarget());
      vi.mocked(isEligibleApprover).mockResolvedValue(false);

      const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status });

      expect(res).toEqual({ httpStatus: 403, body: { error: 'diagnostic_access_approver_required' } });
      expect(isEligibleApprover).toHaveBeenCalledWith(
        USER_ID,
        { orgId: 'org-9', siteId: 'site-1' },
        'partner-123',
      );
      expect(assertApprovalAssurance).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(decideDiagnosticGrantInTx).not.toHaveBeenCalled();
      expect(auditDiagnosticDecision).not.toHaveBeenCalled();
    },
  );

  it('approves a pending grant: activates it inside the decide transaction, then audits after commit', async () => {
    queueApprovalPrefetch(approvalRow());
    queueGrantTarget(pendingTarget());
    const { tx, casSet } = mockDecideTx('approved');
    const order: string[] = [];
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const out = await fn(tx);
      order.push('commit');
      return out;
    });
    const activated = grantRow('active');
    vi.mocked(decideDiagnosticGrantInTx).mockImplementation(async () => {
      order.push('decideInTx');
      return activated;
    });
    vi.mocked(auditDiagnosticDecision).mockImplementation(async () => {
      order.push('audit');
    });

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved', reason: 'ok' });

    expect(res.httpStatus).toBe(200);
    expect((res.body.approval as any).status).toBe('approved');
    expect(casSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
    expect(decideDiagnosticGrantInTx).toHaveBeenCalledTimes(1);
    expect(decideDiagnosticGrantInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        grantId: GRANT_ID,
        approvalRequestId: APPROVAL_ID,
        deciderUserId: USER_ID,
        status: 'approved',
        reason: 'ok',
        decidedAssuranceLevel: 2,
        decidedVia: 'session_tap',
      }),
    );
    expect(auditDiagnosticDecision).toHaveBeenCalledWith(activated, USER_ID, APPROVAL_ID);
    expect(order).toEqual(['decideInTx', 'commit', 'audit']);
  });

  it('deny path records a deny on the grant and audits it', async () => {
    queueApprovalPrefetch(approvalRow());
    queueGrantTarget(pendingTarget());
    const { casSet } = mockDecideTx('denied');
    const denied = grantRow('denied');
    vi.mocked(decideDiagnosticGrantInTx).mockResolvedValue(denied);

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'denied', reason: 'not needed' });

    expect(res.httpStatus).toBe(200);
    expect(casSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'denied', decisionReason: 'not needed' }));
    expect(decideDiagnosticGrantInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grantId: GRANT_ID, status: 'denied', reason: 'not needed', deciderUserId: USER_ID }),
    );
    expect(auditDiagnosticDecision).toHaveBeenCalledWith(denied, USER_ID, APPROVAL_ID);
  });

  it('404s diagnostic_access_grant_not_found when the grant (or its device/org) is gone', async () => {
    queueApprovalPrefetch(approvalRow());
    queueGrantTarget(null);

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 404, body: { error: 'diagnostic_access_grant_not_found' } });
    expect(isEligibleApprover).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each(['active', 'denied', 'expired', 'revoked'])(
    '409s when the grant is already %s (not pending) and writes nothing',
    async (grantStatus) => {
      queueApprovalPrefetch(approvalRow());
      queueGrantTarget(pendingTarget({ status: grantStatus }));

      const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

      expect(res).toEqual({ httpStatus: 409, body: { error: `Already ${grantStatus}`, finalStatus: 'expired' } });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(decideDiagnosticGrantInTx).not.toHaveBeenCalled();
    },
  );

  it('409s diagnostic_access_no_longer_pending and rolls back when the grant lapses between pre-check and write', async () => {
    queueApprovalPrefetch(approvalRow());
    queueGrantTarget(pendingTarget());
    mockDecideTx('approved');
    // decideDiagnosticGrantInTx returns null when the grant is no longer
    // pending or its request TTL has passed.
    vi.mocked(decideDiagnosticGrantInTx).mockResolvedValue(null);
    let txThrew: unknown = null;
    const inner = vi.mocked(db.transaction).getMockImplementation()!;
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      try {
        return await inner(fn);
      } catch (err) {
        txThrew = err;
        throw err;
      }
    });

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({
      httpStatus: 409,
      body: { error: 'diagnostic_access_no_longer_pending', finalStatus: 'expired' },
    });
    // The transaction callback threw, which is what rolls the approval CAS back.
    expect(txThrew).toBeInstanceOf(Error);
    expect(auditDiagnosticDecision).not.toHaveBeenCalled();
  });

  it('410s an approval row whose own request window has expired, before touching the grant', async () => {
    queueApprovalPrefetch(approvalRow({ expiresAt: new Date(Date.now() - 1000) }));

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 410, body: { error: 'Expired', finalStatus: 'expired' } });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(isEligibleApprover).not.toHaveBeenCalled();
  });

  it('409s diagnostic_access_device_moved when the device now belongs to another org', async () => {
    queueApprovalPrefetch(approvalRow());
    queueGrantTarget(pendingTarget({ deviceOrgId: 'org-other' }));

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({
      httpStatus: 409,
      body: { error: 'diagnostic_access_device_moved', finalStatus: 'expired' },
    });
    expect(isEligibleApprover).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('does not fail a committed decision when the post-commit audit throws', async () => {
    queueApprovalPrefetch(approvalRow());
    queueGrantTarget(pendingTarget());
    mockDecideTx('approved');
    vi.mocked(decideDiagnosticGrantInTx).mockResolvedValue(grantRow('active'));
    vi.mocked(auditDiagnosticDecision).mockRejectedValue(new Error('audit down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).toBe(200);
    errSpy.mockRestore();
  });

  it('refuses a requester approving their own grant with 403 self_approval_forbidden when another approver exists', async () => {
    queueApprovalPrefetch(approvalRow());
    queueGrantTarget(pendingTarget({ requestedByUserId: USER_ID }));
    vi.mocked(resolveEligibleApprovers).mockResolvedValue([USER_ID, 'other-approver']);

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).toBe(403);
    expect(res.body.error).toBe('self_approval_forbidden');
    expect(resolveEligibleApprovers).toHaveBeenCalledWith({ orgId: 'org-9', siteId: 'site-1' }, 'partner-123');
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(decideDiagnosticGrantInTx).not.toHaveBeenCalled();
  });

  it('refuses a self-approve when the live approver population is empty (does not include the requester)', async () => {
    queueApprovalPrefetch(approvalRow({ riskTier: 'critical' }));
    queueGrantTarget(pendingTarget({ requestedByUserId: USER_ID }));
    vi.mocked(resolveEligibleApprovers).mockResolvedValue([]);

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).toBe(403);
    expect(res.body.error).toBe('self_approval_forbidden');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('refuses a sole operator self-approve below L3 with step_up_required', async () => {
    queueApprovalPrefetch(approvalRow({ riskTier: 'critical' }));
    queueGrantTarget(pendingTarget({ requestedByUserId: USER_ID }));
    vi.mocked(resolveEligibleApprovers).mockResolvedValue([USER_ID]);

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res).toEqual({ httpStatus: 403, body: { error: 'step_up_required', requiredLevel: 3 } });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('lets a genuine sole operator approve their own grant at L3', async () => {
    queueApprovalPrefetch(approvalRow({ riskTier: 'critical' }));
    queueGrantTarget(pendingTarget({ requestedByUserId: USER_ID }));
    vi.mocked(resolveEligibleApprovers).mockResolvedValue([USER_ID]);
    vi.mocked(assertApprovalAssurance).mockResolvedValue({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: 'auth-1',
    } as any);
    mockDecideTx('approved');
    vi.mocked(decideDiagnosticGrantInTx).mockResolvedValue(grantRow('active'));

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'approved' });

    expect(res.httpStatus).toBe(200);
    expect(decideDiagnosticGrantInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grantId: GRANT_ID, status: 'approved', deciderUserId: USER_ID }),
    );
  });

  it('always lets the requester deny their own request, without resolving other approvers', async () => {
    queueApprovalPrefetch(approvalRow());
    queueGrantTarget(pendingTarget({ requestedByUserId: USER_ID }));
    vi.mocked(resolveEligibleApprovers).mockResolvedValue([USER_ID, 'other-approver']);
    mockDecideTx('denied');
    vi.mocked(decideDiagnosticGrantInTx).mockResolvedValue(grantRow('denied'));

    const res = await decideApprovalRequest({ auth: AUTH, id: APPROVAL_ID, status: 'denied' });

    expect(res.httpStatus).toBe(200);
    expect(resolveEligibleApprovers).not.toHaveBeenCalled();
  });
});
