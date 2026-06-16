import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../services/expoPush', () => ({
  sendExpoPush: vi.fn(async () => [{ status: 'ok', id: 'tk' }]),
  getUserPushTokens: vi.fn(async () => ['ExponentPushToken[abc]']),
  buildApprovalPush: vi.fn(() => ({
    title: 'Approval requested',
    body: 'Dev Seed: x',
    data: { type: 'approval', approvalId: 'a1' },
  })),
}));

vi.mock('../db/schema/approvals', () => ({
  approvalRequests: {},
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
    pinVerified: false,
  })),
  assertApprovalAssurance: vi.fn(async () => ({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
    pinVerified: false,
  })),
  // Real error classes so the route's `instanceof` checks resolve (the route
  // imports StepUpRequiredError for the Phase 4 403 mapping).
  StepUpRequiredError: class StepUpRequiredError extends Error {
    constructor(public requiredLevel: number, public achievedLevel: number) {
      super('step-up required');
      this.name = 'StepUpRequiredError';
    }
  },
  PinVerificationError: class PinVerificationError extends Error {
    constructor(public locked: boolean) {
      super('pin');
      this.name = 'PinVerificationError';
    }
  },
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
import { assertApprovalAssurance, StepUpRequiredError } from '../services/authenticatorAssurance';
import { generateApprovalAssertionOptions } from '../services/approverWebAuthn';
import { issueMobileAssertionNonce } from '../services/mobileHwKey';

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
  // Re-establish the default no-proof (L1 session_tap) assurance after
  // clearAllMocks wipes the implementation, so the unchanged approve tests
  // keep recording session_tap and per-case overrides start from a clean slate.
  vi.mocked(assertApprovalAssurance).mockResolvedValue({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
    pinVerified: false,
  });
  vi.mocked(generateApprovalAssertionOptions).mockResolvedValue({
    challenge: 'chal-xyz',
    rpId: 'breeze.test',
    allowCredentials: [{ id: 'cred-1', transports: ['internal'] }],
    userVerification: 'required',
  } as any);
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
    actionArguments: { userPrincipalName: 'jane@pinnacle.dental' },
    riskTier: 'high',
    riskSummary: 'Reset M365 password for jane@pinnacle.dental on Pinnacle Dental.',
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
          { executionId: 'exec-m365', customerDisplayName: 'Pinnacle Dental' },
        ]) as any,
      );

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.customerTenant).toBe('Pinnacle Dental');
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
        pinVerified: false,
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
      pinVerified: false,
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

  // Phase 3: the approve body now also accepts the mobile_hw_key proof variant
  // and an optional approver PIN, both threaded through to assertApprovalAssurance.
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
      pinVerified: false,
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

  it('threads an optional PIN alongside a proof (L3, pinVerified)', async () => {
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 3,
      decidedAssuranceLevel: 3,
      decidedVia: 'mobile_hw_key',
      authenticatorDeviceId: 'mobile-dev-1',
      pinVerified: true,
    });
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });

    const res = await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof, pin: '1234' }),
    });
    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({ proof: mobileProof, pin: '1234' }),
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ decidedAssuranceLevel: 3, pinVerified: true }),
    );
  });

  it('rejects a malformed PIN at validation (400, before any decision)', async () => {
    const set = mockDecideFlow({
      existing: { ...updatedRow, status: 'pending' },
      updateReturns: [updatedRow],
    });
    const res = await buildApp().request('/approvals/a1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: mobileProof, pin: 'abcd' }),
    });
    expect(res.status).toBe(400);
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
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
      expect(body.push).toEqual({ tokensFound: 1, dispatched: 1, errors: [] });
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
