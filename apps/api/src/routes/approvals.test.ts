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

// Task 6: the decide handler now performs the intent CAS INLINE inside the
// single system-scoped fan-in transaction (was a separate transitionIntent
// call), so approvals.ts no longer imports intentService and there is nothing
// to mock here — the CAS is asserted directly on the mocked tx.update below.

vi.mock('../services/actionIntents/metrics', () => ({
  recordActionIntentEvent: vi.fn(),
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
  elevationRequests: { id: 'id', orgId: 'org_id', status: 'status' },
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
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { approvalRoutes } from './approvals';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { assertApprovalAssurance, StepUpRequiredError, ReauthRequiredError } from '../services/authenticatorAssurance';
import { generateApprovalAssertionOptions } from '../services/approverWebAuthn';
import { issueMobileAssertionNonce } from '../services/mobileHwKey';
import { requireCurrentPasswordStepUp } from './auth/helpers';
import { recordActionIntentEvent } from '../services/actionIntents/metrics';
import { getUserPermissions, userCanDecideApprovals, canAccessOrg } from '../services/permissions';

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

// Wires the decideHandler flow: a pre-fetch select followed by the CAS update.
// Returns the captured `.set(...)` argument so callers can assert the factor
// columns persisted alongside status/decidedAt.
//
// Uses persistent `mockReturnValue` (NOT `mockReturnValueOnce`) on purpose:
// `vi.clearAllMocks()` in beforeEach clears call history but does NOT drain a
// queued `mockReturnValueOnce`, so an early-return decide case (404/409/410
// never reaches the update) would otherwise leave an unconsumed update-once in
// the queue and poison a later test's `db.update`.
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

  // 2) CAS update — capture the set arg
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(opts.updateReturns),
    }),
  });
  vi.mocked(db.update).mockReturnValue({ set } as any);
  return set;
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
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
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

describe('GET /approvals/pending', () => {
  it('returns only pending non-expired approvals for the authed user', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([
            {
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
              createdAt: new Date(),
            },
          ]),
        }),
      }),
    } as any);

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].id).toBe('a1');
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

  it('serializes intentId so a consumer can correlate an approval row to its intent', async () => {
    const approval = {
      id: 'a1',
      userId: TEST_USER.id,
      requestingClientLabel: 'MCP API client',
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
      intentId: 'intent-42',
      createdAt: new Date(),
    };
    mockSelectResolves([approval]);

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.intentId).toBe('intent-42');
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
    // Pre-fetch select returns the pending row; first update (approval_requests)
    // returns the row; second update (ai_tool_executions) just resolves.
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...linkedRow, status: 'pending' }]),
      }),
    } as any);
    const aiSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const approvalReturning = vi.fn().mockResolvedValue([linkedRow]);
    const approvalSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: approvalReturning }),
    });
    vi.mocked(db.update)
      .mockReturnValueOnce({ set: approvalSet } as any)
      .mockReturnValueOnce({ set: aiSet } as any);

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(approvalSet).toHaveBeenCalled();
    expect(aiSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedBy: TEST_USER.id }),
    );
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
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...deniedRow, status: 'pending' }]),
      }),
    } as any);
    const aiSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const approvalReturning = vi.fn().mockResolvedValue([deniedRow]);
    const approvalSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: approvalReturning }),
    });
    vi.mocked(db.update)
      .mockReturnValueOnce({ set: approvalSet } as any)
      .mockReturnValueOnce({ set: aiSet } as any);

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
  // Builds a tx stub for db.transaction(fn). `elevationUpdateRows` is what the
  // elevation CAS returns ([] = lost the race). The tx now does ONLY the
  // elevation CAS (.update) + the audit insert (.values) — the sibling-expiry
  // moved OUT of the tx to a post-commit system-scoped db.update (see
  // mockSiblingExpireUpdate). Captures the elevation .set arg and the
  // elevationAudit .values arg.
  function mockElevationTx(elevationUpdateRows: unknown[]) {
    const elevationSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(elevationUpdateRows) }),
    });
    const auditValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      update: vi.fn(() => ({ set: elevationSet } as any)),
      insert: vi.fn(() => ({ values: auditValues } as any)),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return { elevationSet, auditValues };
  }

  // The decideHandler pre-fetch select + the approval_requests CAS update. The
  // updated row carries elevationRequestId so the mirror block runs.
  //
  // On the win path the route now calls db.update TWICE: first the
  // approval_requests CAS (inside decideHandler), then the post-commit
  // system-scoped sibling-expiry. Wire both via mockReturnValueOnce so the
  // sibling set arg is captured separately; return that captured set.
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
    // 1) approval_requests CAS update
    const casReturning = vi.fn().mockResolvedValue([updatedRow]);
    const casSet = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: casReturning }) });
    // 2) post-commit sibling-expiry (system scope) — a terminal .set().where()
    const siblingExpireSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update)
      .mockReturnValueOnce({ set: casSet } as any)
      .mockReturnValueOnce({ set: siblingExpireSet } as any);
    return { updatedRow, casSet, siblingExpireSet };
  }

  it('approve mirrors elevation to approved + expires siblings', async () => {
    const { siblingExpireSet } = mockDecideWithElevation({ status: 'pending', riskTier: 'medium', elevationRequestId: 'elev-1' });
    const tx = mockElevationTx([{ id: 'elev-1', orgId: 'org-9' }]);

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledOnce();
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
    expect(siblingExpireSet).toHaveBeenCalledWith({ status: 'expired' });
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
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('mirror failure is non-fatal: decide still returns 200', async () => {
    mockDecideWithElevation({ status: 'pending', riskTier: 'medium', elevationRequestId: 'elev-1' });
    vi.mocked(db.transaction).mockRejectedValue(new Error('tx blew up'));

    const res = await buildApp().request('/approvals/appr-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('Task 5: decide-handler bound to action_intents', () => {
  // Wires the decideHandler flow for an intent-linked approval row:
  //   1) pre-fetch select (approval_requests, carries intentId + boundArgumentDigest)
  //   2) intent load select (action_intents, by id, system context)
  //   3) approval_requests CAS update (the deciding user's OWN approval — the
  //      Task 6 intent CAS is separate, done inline in the fan-in transaction
  //      wired by mockIntentFanInTx). requestedByUserId defaults to someone
  //      OTHER than TEST_USER so the sole-operator gate doesn't fire unless a
  //      test opts in.
  function mockDecideWithIntent(opts: {
    riskTier?: string;
    requestedByUserId?: string;
    boundArgumentDigest?: string | null;
    intentDigest?: string;
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

    // 3) approval_requests CAS update
    const casReturning = vi.fn().mockResolvedValue([{ ...approvalRow, status: 'approved' }]);
    const casSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: casReturning }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: casSet } as any);

    return { approvalRow, intentRow, casSet };
  }

  // Task 6: the whole intent fan-in — the intent CAS (inline, was
  // transitionIntent), sibling expiry, and the intent_approved outbox insert —
  // runs inside ONE `db.transaction` under system context. The tx does TWO
  // updates in order (1: action_intents CAS with `.returning({ id })`, 2:
  // approval_requests sibling expiry) plus, on approve, one intent_outbox
  // insert. `casWins` controls whether the CAS RETURNING is non-empty; when it
  // loses the race the handler returns early inside the tx (no sibling expiry,
  // no outbox, no metrics).
  function mockIntentFanInTx(opts: { casWins?: boolean } = {}) {
    const casWins = opts.casWins ?? true;
    const casReturning = vi.fn().mockResolvedValue(casWins ? [{ id: 'intent-1' }] : []);
    const intentCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: casReturning }),
    });
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const outboxValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      update: vi
        .fn()
        .mockReturnValueOnce({ set: intentCasSet } as any) // 1) intent CAS
        .mockReturnValueOnce({ set: siblingSet } as any), // 2) sibling expiry
      insert: vi.fn(() => ({ values: outboxValues }) as any),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return { intentCasSet, siblingSet, outboxValues, tx };
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

  it('denying an intent-linked row transitions the intent to rejected, expires siblings, and writes NO outbox row', async () => {
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
    expect(siblingSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );
    expect(tx.insert).not.toHaveBeenCalled();
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
    expect(db.transaction).not.toHaveBeenCalled();
    expect(recordActionIntentEvent).not.toHaveBeenCalled();
    // Only the pre-fetch + CAS selects/updates ran — no intent load select.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
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
    // 2) update approval_requests -> reported
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    // 3) Task 6: the reject fan-in is now ONE db.transaction — the intent CAS
    //    (inline, `.returning(...)` the metadata for the metrics event) plus
    //    the sibling-expiry update, both on `tx`.
    const casReturning = vi
      .fn()
      .mockResolvedValue([{ orgId: 'org-9', actionName: 'y', argumentDigest: 'd', source: 'mcp_api' }]);
    const intentCasSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: casReturning }),
    });
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const tx = {
      update: vi
        .fn()
        .mockReturnValueOnce({ set: intentCasSet } as any) // 1) intent CAS
        .mockReturnValueOnce({ set: siblingSet } as any), // 2) sibling expiry
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(204);
    expect(intentCasSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', decidedByUserId: TEST_USER.id }),
    );
    expect(siblingSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'intent-77', outcome: 'rejected' }),
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
