/**
 * PAM admin route tests (#1163) — CAS guards on respond/revoke, the
 * no-criteria rule refine, and runAction-compatible bodies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const authMocks = vi.hoisted(() => ({
  authMiddlewareMock: vi.fn(),
  requireScopeMock: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfaMock: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: authMocks.authMiddlewareMock,
  requireScope: authMocks.requireScopeMock,
  requirePermission: authMocks.requirePermissionMock,
  requireMfa: authMocks.requireMfaMock,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', hostname: 'hostname' },
  sites: { id: 'id', name: 'name' },
  users: { id: 'id', name: 'name' },
  elevationRequests: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    deviceId: 'deviceId',
    flowType: 'flowType',
    status: 'status',
    requestedAt: 'requestedAt',
    approvedAt: 'approvedAt',
    expiresAt: 'expiresAt',
    executionId: 'executionId',
    subjectUserId: 'subjectUserId',
    approvedByUserId: 'approvedByUserId',
    deniedByUserId: 'deniedByUserId',
    revokedByUserId: 'revokedByUserId',
    softwarePolicyMatchId: 'softwarePolicyMatchId',
    metadata: 'metadata',
    subjectUsername: 'subjectUsername',
    targetExecutablePath: 'targetExecutablePath',
    targetExecutableHash: 'targetExecutableHash',
    targetExecutableSigner: 'targetExecutableSigner',
    toolName: 'toolName',
    riskTier: 'riskTier',
    denialReason: 'denialReason',
  },
  elevationAudit: { id: 'id' },
  approvalRequests: { id: 'id', elevationRequestId: 'elevationRequestId', status: 'status' },
  pamRules: {
    id: 'id',
    orgId: 'orgId',
    priority: 'priority',
    createdAt: 'createdAt',
    matchSignerGroupId: 'matchSignerGroupId',
  },
  pamSignerGroups: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    description: 'description',
    signers: 'signers',
    createdByUserId: 'createdByUserId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  pamOrgConfig: {
    id: 'id',
    orgId: 'orgId',
    defaultUnmatchedVerdict: 'defaultUnmatchedVerdict',
  },
  PAM_RULE_NEGATE_KEYS: [
    'signer',
    'hash',
    'pathGlob',
    'parentImage',
    'commandLine',
    'user',
    'adGroup',
    'toolName',
    'riskTier',
  ],
  aiToolExecutions: { id: 'id', status: 'status' },
  softwarePolicies: { id: 'id', name: 'name' },
  authenticatorDevices: {
    id: 'id',
    userId: 'user_id',
    credentialId: 'credential_id',
    kind: 'kind',
    transports: 'transports',
    disabledAt: 'disabled_at',
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

// Phase 2: the respond path now resolves assurance through assertApprovalAssurance
// (verifies an optional browser proof). Default the no-proof L1 result; tests
// override per-case. resolveElevationAssurance stays exported for any callers.
vi.mock('../services/authenticatorAssurance', () => ({
  resolveElevationAssurance: vi.fn(() => ({
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
  // Real error classes so the route's `instanceof` checks (Phase 4 403 step-up
  // mapping + critical-tier 401 'reauth_required' mapping) resolve instead of
  // throwing on `instanceof undefined`.
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

// The respond route imports requireCurrentPasswordStepUp from ./auth/helpers
// (L4 re-auth). Stub it so the heavy services barrel that helpers pulls in does
// not load (it would drag the full ../db/schema graph into this suite's mock).
// Default: password verification passes (returns null). Only invoked when a
// reauthPassword is present in the body.
vi.mock('./auth/helpers', () => ({
  requireCurrentPasswordStepUp: vi.fn(async () => null),
}));

vi.mock('../services/approverWebAuthn', () => ({
  generateApprovalAssertionOptions: vi.fn(async () => ({
    challenge: 'chal-pam',
    rpId: 'breeze.test',
    allowCredentials: [{ id: 'cred-1', transports: ['internal'] }],
    userVerification: 'required',
  })),
}));

const busMocks = vi.hoisted(() => ({ publishEvent: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: busMocks.publishEvent }));

vi.mock('./softwarePolicies', () => ({
  resolveOrgIdForWrite: vi.fn((auth: { orgId?: string }, orgId?: string) =>
    orgId ? { orgId } : { orgId: auth?.orgId ?? undefined },
  ),
}));

import { db } from '../db';
import { pamRoutes } from './pam';
import { assertApprovalAssurance, StepUpRequiredError, ReauthRequiredError } from '../services/authenticatorAssurance';
import { requireCurrentPasswordStepUp } from './auth/helpers';
import { generateApprovalAssertionOptions } from '../services/approverWebAuthn';

const ORG_ID = '7b41c9a2-0000-4000-8000-000000000001';
const REQ_ID = '7b41c9a2-0000-4000-8000-000000000002';
const USER_ID = '7b41c9a2-0000-4000-8000-000000000003';

function setAuth() {
  authMocks.authMiddlewareMock.mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: USER_ID, email: 't@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => undefined,
    });
    c.set('permissions', undefined); // no site restriction
    return next();
  });
}

interface TxRigOptions {
  row?: Record<string, unknown> | null;
  casWins?: boolean;
  /** Whether the ai_tool_action execution mirror CAS flips a row (default true). */
  mirrorWins?: boolean;
}

function rigTransaction(opts: TxRigOptions) {
  const updateSetCalls: unknown[] = [];
  const auditInserts: unknown[] = [];
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
    let updateCallCount = 0;
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(opts.row ? [opts.row] : []),
          })),
        })),
      })),
      update: vi.fn(() => {
        updateCallCount += 1;
        const isMirror = updateCallCount > 1;
        const wins = isMirror ? (opts.mirrorWins ?? true) : opts.casWins;
        return {
          set: vi.fn((setArg: unknown) => {
            updateSetCalls.push(setArg);
            return {
              where: vi.fn(() => ({
                returning: vi
                  .fn()
                  .mockResolvedValue(wins ? [{ id: REQ_ID, status: 'approved' }] : []),
              })),
            };
          }),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn((v: unknown) => {
          auditInserts.push(v);
          return Promise.resolve();
        }),
      })),
    };
    return fn(tx);
  });
  return { updateSetCalls, auditInserts };
}

function app(): Hono {
  const a = new Hono();
  a.route('/pam', pamRoutes);
  return a;
}

/** Rig db.select for the list/active read paths (count selects keyed on `total`). */
function mockListSelect(rows: unknown[] = [], total = 0) {
  vi.mocked(db.select).mockImplementation(((sel: Record<string, unknown> | undefined) => {
    const isCount = Boolean(sel && 'total' in sel);
    const chain: any = Promise.resolve(isCount ? [{ total }] : rows);
    chain.from = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.offset = vi.fn(() => chain);
    return chain;
  }) as any);
}

const activeRow = {
  id: REQ_ID,
  orgId: ORG_ID,
  siteId: null,
  deviceId: 'dev-1',
  flowType: 'uac_intercept',
  status: 'pending',
};

describe('GET /pam/elevation-requests and /pam/active — decider display names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
  });

  const listRow = {
    request: {
      id: REQ_ID,
      orgId: ORG_ID,
      deviceId: 'dev-1',
      flowType: 'uac_intercept',
      status: 'approved',
      approvedByUserId: USER_ID,
    },
    deviceHostname: 'WS-ALPHA',
    siteName: 'HQ',
    approvedByName: 'Jane Admin',
    deniedByName: null,
    revokedByName: null,
  };

  it('list rows carry approvedByName/deniedByName/revokedByName from the user joins', async () => {
    mockListSelect([listRow], 1);

    const res = await app().request('/pam/elevation-requests');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.requests[0].approvedByName).toBe('Jane Admin');
    expect(body.requests[0].deniedByName).toBeNull();
    expect(body.requests[0].revokedByName).toBeNull();
    // Existing joins are untouched.
    expect(body.requests[0].deviceHostname).toBe('WS-ALPHA');
    expect(body.requests[0].siteName).toBe('HQ');
    expect(body.pagination).toEqual({ page: 1, limit: 50, total: 1 });

    // The select projection asks for all three aliased user names.
    const projection = vi.mocked(db.select).mock.calls[0]![0] as Record<string, unknown>;
    expect(projection).toHaveProperty('approvedByName');
    expect(projection).toHaveProperty('deniedByName');
    expect(projection).toHaveProperty('revokedByName');
  });

  it('active rows carry the decider name fields', async () => {
    mockListSelect([listRow]);

    const res = await app().request('/pam/active');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.active[0].approvedByName).toBe('Jane Admin');
    expect(body.active[0].revokedByName).toBeNull();
    expect(body.active[0].deviceHostname).toBe('WS-ALPHA');

    const projection = vi.mocked(db.select).mock.calls[0]![0] as Record<string, unknown>;
    expect(projection).toHaveProperty('approvedByName');
    expect(projection).toHaveProperty('deniedByName');
    expect(projection).toHaveProperty('revokedByName');
  });

  it('surfaces software-policy provenance as first-class fields', async () => {
    const policyRow = {
      request: {
        id: REQ_ID,
        orgId: ORG_ID,
        deviceId: 'dev-1',
        flowType: 'uac_intercept',
        status: 'denied',
        approvedByUserId: null,
        deniedByUserId: null,
        revokedByUserId: null,
        softwarePolicyMatchId: 'policy-1',
        metadata: {},
      },
      deviceHostname: 'WS-ALPHA',
      siteName: 'HQ',
      approvedByName: null,
      deniedByName: null,
      revokedByName: null,
      matchedPolicyName: 'Engineering Blocklist',
    };
    mockListSelect([policyRow], 1);

    const res = await app().request('/pam/elevation-requests');
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.requests[0];
    expect(row.matchedPolicyName).toBe('Engineering Blocklist');
    expect(row.decisionSource).toBe('software_policy');
  });

  it('surfaces pam-rule provenance from metadata and computes decisionSource', async () => {
    const ruleRow = {
      request: {
        id: REQ_ID,
        orgId: ORG_ID,
        deviceId: 'dev-1',
        flowType: 'uac_intercept',
        status: 'auto_approved',
        approvedByUserId: null,
        deniedByUserId: null,
        revokedByUserId: null,
        softwarePolicyMatchId: null,
        metadata: { pam_rule_id: 'rule-1', pam_rule_name: 'Allow signed installers' },
      },
      deviceHostname: 'WS-BETA',
      siteName: 'Branch',
      approvedByName: null,
      deniedByName: null,
      revokedByName: null,
      matchedPolicyName: null,
    };
    mockListSelect([ruleRow], 1);

    const res = await app().request('/pam/elevation-requests');
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.requests[0];
    expect(row.pamRuleId).toBe('rule-1');
    expect(row.pamRuleName).toBe('Allow signed installers');
    expect(row.decisionSource).toBe('pam_rule');
  });

  it('computes decisionSource=human for human-decided rows and null for pending', async () => {
    const humanRow = {
      request: {
        id: REQ_ID,
        orgId: ORG_ID,
        deviceId: 'dev-1',
        flowType: 'uac_intercept',
        status: 'approved',
        approvedByUserId: USER_ID,
        deniedByUserId: null,
        revokedByUserId: null,
        softwarePolicyMatchId: null,
        metadata: {},
      },
      deviceHostname: 'WS-ALPHA',
      siteName: 'HQ',
      approvedByName: 'Jane Admin',
      deniedByName: null,
      revokedByName: null,
      matchedPolicyName: null,
    };
    const pendingRow = {
      request: {
        id: '7b41c9a2-0000-4000-8000-000000000099',
        orgId: ORG_ID,
        deviceId: 'dev-2',
        flowType: 'uac_intercept',
        status: 'pending',
        approvedByUserId: null,
        deniedByUserId: null,
        revokedByUserId: null,
        softwarePolicyMatchId: null,
        metadata: {},
      },
      deviceHostname: 'WS-GAMMA',
      siteName: 'HQ',
      approvedByName: null,
      deniedByName: null,
      revokedByName: null,
      matchedPolicyName: null,
    };
    mockListSelect([humanRow, pendingRow], 2);

    const res = await app().request('/pam/elevation-requests');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests[0].decisionSource).toBe('human');
    expect(body.requests[1].decisionSource).toBeNull();
  });
});

// clearAllMocks wipes the mocked-service implementations; re-establish the
// no-proof (L1 session_tap) assurance default so the unchanged approve/deny
// tests keep recording session_tap and per-case overrides start clean.
function resetAssuranceDefaults() {
  vi.mocked(assertApprovalAssurance).mockResolvedValue({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  });
  vi.mocked(generateApprovalAssertionOptions).mockResolvedValue({
    challenge: 'chal-pam',
    rpId: 'breeze.test',
    allowCredentials: [{ id: 'cred-1', transports: ['internal'] }],
    userVerification: 'required',
  } as any);
  // default "password ok" (null = no error) after clearAllMocks wipes the factory
  vi.mocked(requireCurrentPasswordStepUp).mockResolvedValue(null);
}

describe('POST /pam/elevation-requests/:id/respond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    busMocks.publishEvent.mockResolvedValue('evt');
    resetAssuranceDefaults();
  });

  it('approves a pending request (CAS wins) and emits elevation.approved', async () => {
    const { updateSetCalls, auditInserts } = rigTransaction({ row: activeRow, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', durationMinutes: 30 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const set = updateSetCalls[0] as { status: string; approvedByUserId: string; expiresAt: Date };
    expect(set.status).toBe('approved');
    expect(set.approvedByUserId).toBe(USER_ID);
    expect(set.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(auditInserts.length).toBe(1);
    expect(busMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.approved',
      ORG_ID,
      expect.objectContaining({ elevationRequestId: REQ_ID }),
      'pam-admin',
    );
  });

  it('denies with reason', async () => {
    const { updateSetCalls } = rigTransaction({ row: activeRow, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny', reason: 'nope' }),
    });

    expect(res.status).toBe(200);
    const set = updateSetCalls[0] as { status: string; denialReason: string };
    expect(set.status).toBe('denied');
    expect(set.denialReason).toBe('nope');
  });

  it('returns 403 step_up_required when an enforcing policy rejects the approve (Phase 4)', async () => {
    const { updateSetCalls } = rigTransaction({ row: activeRow, casWins: true });
    vi.mocked(assertApprovalAssurance).mockRejectedValueOnce(new StepUpRequiredError(3, 1));

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', durationMinutes: 30 }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('step_up_required');
    expect(body.requiredLevel).toBe(3);
    // Enforcement rejects BEFORE the elevation row is mutated.
    expect(updateSetCalls.length).toBe(0);
  });

  it('409s when the CAS loses (request no longer pending)', async () => {
    rigTransaction({ row: { ...activeRow, status: 'denied' }, casWins: false });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(busMocks.publishEvent).not.toHaveBeenCalled();
  });

  it('404s for a row outside the caller org (canAccessOrg false)', async () => {
    rigTransaction({ row: { ...activeRow, orgId: 'other-org' }, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(404);
  });

  it('records session_tap factor columns + audit assurance on elevation approve', async () => {
    const { updateSetCalls, auditInserts } = rigTransaction({
      row: { ...activeRow, riskTier: 3 },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(200);
    expect(updateSetCalls[0]).toMatchObject({
      status: 'approved',
      decidedVia: 'session_tap',
      decidedAssuranceLevel: 1,
      authenticatorDeviceId: null,
    });
    expect(auditInserts[0]).toMatchObject({
      details: { assurance_level: 1, factor: 'session_tap' },
    });
  });

  it('records session_tap factor columns + audit assurance on elevation deny', async () => {
    const { updateSetCalls, auditInserts } = rigTransaction({
      row: { ...activeRow, riskTier: 4 },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny', reason: 'nope' }),
    });

    expect(res.status).toBe(200);
    expect(updateSetCalls[0]).toMatchObject({
      status: 'denied',
      decidedVia: 'session_tap',
      decidedAssuranceLevel: 1,
      authenticatorDeviceId: null,
    });
    expect(auditInserts[0]).toMatchObject({
      details: { assurance_level: 1, factor: 'session_tap' },
    });
  });

  // Separation-of-duties (maker/checker): the subject who requested a
  // tech_jit_admin elevation cannot approve their own request. Mirrors the
  // auditBaselines apply-approval and cisHardening remediation guards (self
  // APPROVE blocked, self DENY allowed since a denial grants nothing).
  it('403s when the requester (subject) approves their own elevation', async () => {
    const { updateSetCalls, auditInserts } = rigTransaction({
      row: { ...activeRow, flowType: 'tech_jit_admin', subjectUserId: USER_ID },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', durationMinutes: 30 }),
    });

    expect(res.status).toBe(403);
    // No status flip / approval occurred.
    expect(updateSetCalls.length).toBe(0);
    expect(busMocks.publishEvent).not.toHaveBeenCalled();
    // Guard must run BEFORE any audit write — a regression that moved the
    // self-approval check below the audit insert would write a spurious
    // `approved`-typed row yet still satisfy the assertions above.
    expect(auditInserts.length).toBe(0);
  });

  it('lets a DIFFERENT user approve the request (no regression)', async () => {
    const { updateSetCalls } = rigTransaction({
      row: { ...activeRow, flowType: 'tech_jit_admin', subjectUserId: 'some-other-user' },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', durationMinutes: 30 }),
    });

    expect(res.status).toBe(200);
    expect((updateSetCalls[0] as { status: string }).status).toBe('approved');
  });

  it('lets the requester (subject) DENY their own elevation (deny grants nothing)', async () => {
    const { updateSetCalls } = rigTransaction({
      row: { ...activeRow, flowType: 'tech_jit_admin', subjectUserId: USER_ID },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny', reason: 'changed my mind' }),
    });

    expect(res.status).toBe(200);
    expect((updateSetCalls[0] as { status: string }).status).toBe('denied');
  });
});

describe('POST /pam/elevation-requests/:id/assertion-challenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    resetAssuranceDefaults();
  });

  // clearAllMocks does NOT drain a queued mockReturnValueOnce; reset the db
  // method mocks after each case so a queued-but-unconsumed once can't leak
  // into a later describe block.
  afterEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
  });

  const elevRow = {
    id: REQ_ID,
    orgId: ORG_ID,
    siteId: null,
    status: 'pending',
  };

  it('returns assertion options for the caller active approver devices', async () => {
    // 1) pending elevation lookup (scoped by canAccessOrg); 2) device list.
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([elevRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'dev-1', credentialId: 'cred-1', transports: ['internal'] },
          ]),
        }),
      } as any);

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/assertion-challenge`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.options.challenge).toBe('chal-pam');
    expect(generateApprovalAssertionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: REQ_ID,
        userId: USER_ID,
        devices: [{ credentialId: 'cred-1', transports: ['internal'] }],
      }),
    );
  });

  it('404s when the elevation is not pending / not in the caller org', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/assertion-challenge`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(generateApprovalAssertionOptions).not.toHaveBeenCalled();
  });

  it('404s when the elevation belongs to another org (canAccessOrg false)', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ ...elevRow, orgId: 'other-org' }]),
        }),
      }),
    } as any);

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/assertion-challenge`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(generateApprovalAssertionOptions).not.toHaveBeenCalled();
  });
});

describe('POST /pam/elevation-requests/:id/respond with assertion proof', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    busMocks.publishEvent.mockResolvedValue('evt');
    resetAssuranceDefaults();
  });

  afterEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
  });

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
    const { updateSetCalls, auditInserts } = rigTransaction({
      row: { ...activeRow, riskTier: 3 },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', proof }),
    });

    expect(res.status).toBe(200);
    // Phase 3: the webauthn proof now carries the `type` discriminator (defaulted
    // for back-compat by assertionProofSchema) when threaded to the assurance svc.
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: REQ_ID,
        userId: USER_ID,
        proof: { ...proof, type: 'webauthn_platform' },
      }),
    );
    expect(updateSetCalls[0]).toMatchObject({
      status: 'approved',
      decidedVia: 'webauthn_platform',
      decidedAssuranceLevel: 2,
      authenticatorDeviceId: 'dev-1',
    });
    expect(auditInserts[0]).toMatchObject({
      details: { assurance_level: 2, factor: 'webauthn_platform' },
    });
  });

  it('still records session_tap / L1 when no proof is presented (unchanged)', async () => {
    const { updateSetCalls } = rigTransaction({
      row: { ...activeRow, riskTier: 3 },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: REQ_ID, userId: USER_ID, proof: undefined }),
    );
    expect(updateSetCalls[0]).toMatchObject({
      decidedVia: 'session_tap',
      decidedAssuranceLevel: 1,
      authenticatorDeviceId: null,
    });
  });

  it('401s assertion_failed when a presented proof fails verification (no silent downgrade)', async () => {
    vi.mocked(assertApprovalAssurance).mockRejectedValueOnce(
      new Error('assertion verification failed'),
    );
    const { updateSetCalls } = rigTransaction({
      row: { ...activeRow, riskTier: 3 },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', proof }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('assertion_failed');
    // A failed assertion must NOT silently downgrade — the CAS update never runs.
    expect(updateSetCalls.length).toBe(0);
    expect(busMocks.publishEvent).not.toHaveBeenCalled();
  });

  // Phase 3: the respond body accepts the mobile_hw_key proof variant, threaded
  // to assertApprovalAssurance.
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
    const { updateSetCalls } = rigTransaction({
      row: { ...activeRow, riskTier: 3 },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', proof: mobileProof }),
    });

    expect(res.status).toBe(200);
    expect(assertApprovalAssurance).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: REQ_ID, userId: USER_ID, proof: mobileProof }),
    );
    expect(updateSetCalls[0]).toMatchObject({
      decidedVia: 'mobile_hw_key',
      decidedAssuranceLevel: 2,
      authenticatorDeviceId: 'mobile-dev-1',
    });
  });

  // L4 re-auth wiring (the gap the assurance redesign fixes): the respond route
  // must VERIFY a fresh password and thread reauthVerified into the guard — and
  // must NOT thread a challengeIssuedAt (recency is server-derived). Without this
  // a critical elevation approve with a valid signature would 401 forever.
  it('verifies reauthPassword and threads reauthVerified:true (no challengeIssuedAt) into the guard', async () => {
    vi.mocked(requireCurrentPasswordStepUp).mockResolvedValueOnce(null); // password ok
    vi.mocked(assertApprovalAssurance).mockResolvedValueOnce({
      requiredLevel: 4,
      decidedAssuranceLevel: 4,
      decidedVia: 'mobile_hw_key',
      authenticatorDeviceId: 'mobile-dev-1',
    });
    rigTransaction({ row: { ...activeRow, riskTier: 4 }, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', proof: mobileProof, reauthPassword: 'hunter2' }),
    });

    expect(res.status).toBe(200);
    expect(requireCurrentPasswordStepUp).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      'hunter2',
      'pam:reauth',
    );
    const call = vi.mocked(assertApprovalAssurance).mock.calls[0]![0];
    expect(call.reauthVerified).toBe(true);
    expect('challengeIssuedAt' in call).toBe(false);
  });

  it('defaults reauthVerified:false when no reauthPassword is supplied', async () => {
    rigTransaction({ row: { ...activeRow, riskTier: 3 }, casWins: true });
    await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', proof: mobileProof }),
    });
    expect(requireCurrentPasswordStepUp).not.toHaveBeenCalled();
    expect(vi.mocked(assertApprovalAssurance).mock.calls[0]![0].reauthVerified).toBe(false);
  });

  it('401s reauth_required when the guard throws ReauthRequiredError (critical w/o re-auth)', async () => {
    vi.mocked(assertApprovalAssurance).mockRejectedValueOnce(new ReauthRequiredError());
    const { updateSetCalls } = rigTransaction({ row: { ...activeRow, riskTier: 4 }, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', proof: mobileProof }),
    });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('reauth_required');
    // re-auth required is NOT a silent downgrade — no decision is written.
    expect(updateSetCalls.length).toBe(0);
    expect(busMocks.publishEvent).not.toHaveBeenCalled();
  });

  it('short-circuits with the helper response when reauthPassword is rejected', async () => {
    vi.mocked(requireCurrentPasswordStepUp).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { updateSetCalls } = rigTransaction({ row: { ...activeRow, riskTier: 4 }, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', proof: mobileProof, reauthPassword: 'wrong' }),
    });

    expect(res.status).toBe(401);
    // the assurance guard + the transaction are never reached
    expect(assertApprovalAssurance).not.toHaveBeenCalled();
    expect(updateSetCalls.length).toBe(0);
  });

  // PIN step-up cases removed: the static approver PIN was dropped in favor of
  // the L3-recency / L4-reauth ladder (authenticator registration redesign).
});

describe('POST /pam/elevation-requests/:id/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    busMocks.publishEvent.mockResolvedValue('evt');
  });

  it('revokes an active elevation and emits elevation.revoked', async () => {
    const { updateSetCalls } = rigTransaction({
      row: { ...activeRow, status: 'approved' },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'compromised' }),
    });

    expect(res.status).toBe(200);
    const set = updateSetCalls[0] as { status: string; revokedReason: string };
    expect(set.status).toBe('revoked');
    expect(set.revokedReason).toBe('compromised');
    expect(busMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.revoked',
      ORG_ID,
      expect.objectContaining({ elevationRequestId: REQ_ID }),
      'pam-admin',
    );
  });

  it('409s when the request is not in an active status', async () => {
    rigTransaction({ row: { ...activeRow, status: 'pending' }, casWins: false });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'nope' }),
    });

    expect(res.status).toBe(409);
  });

  it('requires a reason', async () => {
    rigTransaction({ row: { ...activeRow, status: 'approved' }, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /pam/rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
  });

  it('rejects a rule with no executable criterion (400)', async () => {
    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'naked rule',
        verdict: 'auto_approve',
        timeWindow: { start: '00:00', end: '23:59' },
      }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('creates a tool-action rule (matchToolName only)', async () => {
    const returning = vi.fn().mockResolvedValue([
      { id: 'rule-2', name: 'govern services', verdict: 'require_approval', priority: 100 },
    ]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning })),
    } as any);

    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'govern services',
        verdict: 'require_approval',
        matchToolName: 'manage_services',
        matchRiskTier: 2,
      }),
    });

    expect(res.status).toBe(201);
    const valuesArg = (vi.mocked(db.insert).mock.results[0]!.value.values as any).mock
      .calls[0][0] as { matchToolName: string; matchRiskTier: number };
    expect(valuesArg.matchToolName).toBe('manage_services');
    expect(valuesArg.matchRiskTier).toBe(2);
  });

  it('passes matchCommandLine and matchNegate through to the insert', async () => {
    const returning = vi.fn().mockResolvedValue([
      { id: 'rule-cl', name: 'printui only', verdict: 'auto_approve', priority: 100 },
    ]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning })),
    } as any);

    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'printui only',
        verdict: 'auto_approve',
        matchPathGlob: 'C:\\Windows\\System32\\rundll32.exe',
        matchCommandLine: 'printui.dll,PrintUIEntry',
        matchNegate: ['pathGlob'],
      }),
    });

    expect(res.status).toBe(201);
    const valuesArg = (vi.mocked(db.insert).mock.results[0]!.value.values as any).mock
      .calls[0][0] as { matchCommandLine: string; matchNegate: string[] };
    expect(valuesArg.matchCommandLine).toBe('printui.dll,PrintUIEntry');
    expect(valuesArg.matchNegate).toEqual(['pathGlob']);
  });

  it('rejects a matchNegate key outside PAM_RULE_NEGATE_KEYS (400)', async () => {
    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bad negate',
        verdict: 'auto_approve',
        matchSigner: 'Acme Corp',
        matchNegate: ['nonsense'],
      }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('rejects a rule mixing executable and tool-action criteria (400)', async () => {
    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'mixed rule',
        verdict: 'auto_approve',
        matchHash: 'a'.repeat(64),
        matchToolName: 'manage_services',
      }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it("rejects verdict 'ignore' on a tool-action rule (400)", async () => {
    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ignore tool rule',
        verdict: 'ignore',
        matchToolName: 'manage_services',
      }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('creates a rule with a criterion and lowercases the hash', async () => {
    const returning = vi.fn().mockResolvedValue([
      { id: 'rule-1', name: 'allow tool', verdict: 'auto_approve', priority: 100 },
    ]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning })),
    } as any);

    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'allow tool',
        verdict: 'auto_approve',
        matchHash: 'A'.repeat(64),
      }),
    });

    expect(res.status).toBe(201);
    const valuesArg = (vi.mocked(db.insert).mock.results[0]!.value.values as any).mock
      .calls[0][0] as { matchHash: string; orgId: string };
    expect(valuesArg.matchHash).toBe('a'.repeat(64));
    expect(valuesArg.orgId).toBe(ORG_ID);
  });
});

describe('ai_tool_action elevation requests (Phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    busMocks.publishEvent.mockResolvedValue('evt');
  });

  const toolActionRow = {
    id: REQ_ID,
    orgId: ORG_ID,
    siteId: null,
    deviceId: 'dev-1',
    flowType: 'ai_tool_action',
    status: 'pending',
    executionId: 'exec-1',
  };

  it('accepts flowType=ai_tool_action on the list filter', async () => {
    mockListSelect([], 0);
    const res = await app().request('/pam/elevation-requests?flowType=ai_tool_action');
    expect(res.status).toBe(200);
  });

  it('still rejects unknown flowType values', async () => {
    mockListSelect([], 0);
    const res = await app().request('/pam/elevation-requests?flowType=bogus');
    expect(res.status).toBe(400);
  });

  it('approve mirrors the linked execution to approved in the same transaction', async () => {
    const { updateSetCalls } = rigTransaction({ row: toolActionRow, casWins: true, mirrorWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(200);
    expect(updateSetCalls.length).toBe(2);
    const mirrorSet = updateSetCalls[1] as { status: string; approvedBy: string };
    expect(mirrorSet.status).toBe('approved');
    expect(mirrorSet.approvedBy).toBe(USER_ID);
  });

  it('deny mirrors the linked execution to rejected', async () => {
    const { updateSetCalls } = rigTransaction({ row: toolActionRow, casWins: true, mirrorWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny', reason: 'not on my watch' }),
    });

    expect(res.status).toBe(200);
    const mirrorSet = updateSetCalls[1] as { status: string };
    expect(mirrorSet.status).toBe('rejected');
  });

  it('409s (and rolls back) when the linked execution is no longer pending', async () => {
    rigTransaction({ row: toolActionRow, casWins: true, mirrorWins: false });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(busMocks.publishEvent).not.toHaveBeenCalled();
  });

  it('uac_intercept respond never touches the execution mirror', async () => {
    const { updateSetCalls } = rigTransaction({ row: activeRow, casWins: true });
    // #1254: the mobile-approval expiry moved OUT of the respond tx to a
    // post-commit system-scoped db.update — approval_requests is Shape-6
    // (user-id-scoped), so the fanned-out approver rows belong to OTHER users
    // and are invisible to this web caller's request context; a bare in-tx
    // update would silently match zero rows. Wire that post-commit db.update
    // and capture its .set arg.
    const expireSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: expireSet } as any);

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(200);
    // In the tx, only the elevation-status CAS runs — no execution mirror (that
    // only happens for ai_tool_action) and no in-tx approval expiry anymore.
    expect(updateSetCalls.length).toBe(1);
    // The #1254 mobile-approval expiry now runs post-commit via the system-scoped
    // db.update (clears any fanned-out approval_requests rows so a web decision
    // also removes the request from approvers' phones).
    expect(expireSet).toHaveBeenCalledWith({ status: 'expired' });
  });
});

describe('PATCH /pam/rules/:id shape validation (Phase 1)', () => {
  const RULE_ID = '7b41c9a2-0000-4000-8000-000000000009';

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
  });

  function mockExistingRule(rule: Record<string, unknown>) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([rule]),
        })),
      })),
    } as any);
  }

  const toolRule = {
    id: RULE_ID,
    orgId: ORG_ID,
    name: 'tool rule',
    matchSigner: null,
    matchHash: null,
    matchPathGlob: null,
    matchParentImage: null,
    matchUser: null,
    matchAdGroup: null,
    matchToolName: 'manage_services',
    matchRiskTier: null,
    verdict: 'require_approval',
  };

  it('rejects an update that strips the last criterion (400)', async () => {
    mockExistingRule(toolRule);
    const res = await app().request(`/pam/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchToolName: null }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('rejects an update that mixes executable criteria onto a tool-action rule (400)', async () => {
    mockExistingRule(toolRule);
    const res = await app().request(`/pam/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchHash: 'a'.repeat(64) }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it("rejects flipping a tool-action rule's verdict to ignore (400)", async () => {
    mockExistingRule(toolRule);
    const res = await app().request(`/pam/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'ignore' }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });
});

describe('POST /pam/rules/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
  });

  // Helper: builds a minimal elevation_requests row for the preview SELECT.
  const previewRow = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
    id: 'er-1',
    requestedAt: new Date('2026-06-10T18:00:00Z'),
    flowType: 'uac_intercept',
    status: 'pending',
    subjectUsername: 'ACME\\jdoe',
    targetExecutablePath: 'C:\\Tools\\installer.exe',
    targetExecutableHash: null,
    targetExecutableSigner: 'Acme Corp',
    toolName: null,
    riskTier: null,
    metadata: {},
    ...over,
  });

  /** Rig db.select so it resolves to `rows` (no count branch needed for preview). */
  function mockPreviewSelect(rows: unknown[]) {
    vi.mocked(db.select).mockImplementation((() => {
      const chain: any = Promise.resolve(rows);
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      return chain;
    }) as any);
  }

  it('counts signer matches case-insensitively', async () => {
    const rows = [
      previewRow({ id: 'er-1', targetExecutableSigner: 'Acme Corp' }),
      previewRow({ id: 'er-2', targetExecutableSigner: 'ACME CORP' }),
      previewRow({ id: 'er-3', targetExecutableSigner: 'acme corp' }),
      previewRow({ id: 'er-4', targetExecutableSigner: 'Other Inc' }),
      previewRow({ id: 'er-5', targetExecutableSigner: 'Other Inc' }),
    ];
    mockPreviewSelect(rows);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'acme corp', windowDays: 30 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalMatched).toBe(3);
    expect(body.totalScanned).toBe(5);
    expect(body.sample).toHaveLength(3);
  });

  it('does not match tool-action rows against executable criteria', async () => {
    const rows = [
      previewRow({ id: 'er-1', flowType: 'uac_intercept', targetExecutableSigner: 'Acme Corp', toolName: null }),
      previewRow({ id: 'er-2', flowType: 'ai_tool_action', targetExecutableSigner: null, toolName: 'manage_services' }),
    ];
    mockPreviewSelect(rows);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'Acme Corp' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalMatched).toBe(1);
  });

  it('evaluates timeWindow against each row requestedAt', async () => {
    // 23:00 row is inside the overnight window (22:00–06:00); 12:00 row is not
    const rows = [
      previewRow({ id: 'er-1', requestedAt: new Date('2026-06-10T23:00:00Z') }),
      previewRow({ id: 'er-2', requestedAt: new Date('2026-06-10T12:00:00Z') }),
    ];
    mockPreviewSelect(rows);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchUser: 'ACME\\jdoe',
        timeWindow: { start: '22:00', end: '06:00', timezone: 'UTC' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalMatched).toBe(1);
  });

  it('returns zeroed shape on empty scan', async () => {
    mockPreviewSelect([]);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'Acme Corp' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalMatched).toBe(0);
    expect(body.totalScanned).toBe(0);
    expect(body.truncated).toBe(false);
    expect(body.sample).toEqual([]);
  });

  it('rejects criterion-less, mixed, and out-of-range bodies', async () => {
    // No criteria
    const r1 = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r1.status).toBe(400);

    // Mixed executable + tool-action
    const r2 = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'x', matchToolName: 'y' }),
    });
    expect(r2.status).toBe(400);

    // windowDays = 0 (below min 1)
    const r3 = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'x', windowDays: 0 }),
    });
    expect(r3.status).toBe(400);

    // windowDays = 91 (above max 90)
    const r4 = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'x', windowDays: 91 }),
    });
    expect(r4.status).toBe(400);
  });

  it('caps sample at 10 and tallies statusBreakdown', async () => {
    // 14 matching rows: 9 pending, 5 auto_approved
    const rows = [
      ...Array.from({ length: 9 }, (_, i) =>
        previewRow({ id: `er-p${i}`, status: 'pending', targetExecutableSigner: 'Acme Corp' }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        previewRow({ id: `er-a${i}`, status: 'auto_approved', targetExecutableSigner: 'Acme Corp' }),
      ),
    ];
    mockPreviewSelect(rows);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'Acme Corp' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalMatched).toBe(14);
    expect(body.sample.length).toBe(10);
    expect(body.statusBreakdown.pending).toBe(9);
    expect(body.statusBreakdown.auto_approved).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // Gap 3: preview site-scope authorization
  // ---------------------------------------------------------------------------

  it('Gap 3a: site-scoped technician posting siteId outside their allowedSiteIds → 403 Site access denied', async () => {
    const ALLOWED_SITE = '7b41c9a2-0000-4000-8000-000000000010';
    const OTHER_SITE = '7b41c9a2-0000-4000-8000-000000000011';

    // Auth sets permissions with allowedSiteIds that does NOT include OTHER_SITE.
    authMocks.authMiddlewareMock.mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: USER_ID, email: 't@example.com' },
        scope: 'organization',
        orgId: ORG_ID,
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: () => undefined,
      });
      c.set('permissions', { allowedSiteIds: [ALLOWED_SITE] });
      return next();
    });

    mockPreviewSelect([]);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'Acme Corp', siteId: OTHER_SITE }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Site access denied');
  });

  it('Gap 3b: site-scoped technician WITHOUT body.siteId — siteScopeCondition narrows rows to allowed sites', async () => {
    // NOTE: The WHERE predicate from siteScopeCondition is injected into the Drizzle query,
    // which our mocked db ignores (mock returns all rows regardless of WHERE). We therefore
    // assert the observable outcome: only rows whose siteId is in allowedSiteIds are
    // actually matched — the route's JS-layer matching does NOT filter siteId, but
    // the DB layer would. Since we cannot assert SQL WHERE through a mock, we test what IS
    // assertable: the request succeeds (200) and the full scan is returned. The actual
    // site-narrowing is an integration-test concern.
    //
    // We DO assert the 403 path via Gap 3a above (which exercises the route's explicit
    // siteId+canAccessSite check). This test ensures the no-siteId path reaches the DB
    // without error when the tech is site-scoped.
    const ALLOWED_SITE = '7b41c9a2-0000-4000-8000-000000000010';

    authMocks.authMiddlewareMock.mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: USER_ID, email: 't@example.com' },
        scope: 'organization',
        orgId: ORG_ID,
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: () => undefined,
      });
      c.set('permissions', { allowedSiteIds: [ALLOWED_SITE] });
      return next();
    });

    mockPreviewSelect([previewRow({ id: 'er-1' })]);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchSigner: 'Acme Corp' }),
    });

    // Request should succeed; site narrowing is applied at DB layer (not testable via mock).
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Gap 4: non-UTC timeWindow wiring
  //
  // Timestamp analysis:
  //   Window: 00:00–05:00 in America/Chicago (UTC-5 in standard time, UTC-6 in DST).
  //   requestedAt: 2026-06-10T06:00:00Z
  //   In UTC: 06:00 — outside the window 00:00–05:00 UTC.
  //   In America/Chicago (CDT = UTC-5 in June 2026):
  //     06:00Z - 5h = 01:00 CDT → inside window 00:00–05:00.
  //
  //   Test A (Chicago): window 00:00–05:00, timezone: 'America/Chicago'
  //     → 06:00Z = 01:00 Chicago → INSIDE → totalMatched = 1
  //   Test B (UTC):     window 00:00–05:00, timezone: 'UTC'
  //     → 06:00Z = 06:00 UTC → OUTSIDE → totalMatched = 0
  //
  //   This discriminates: different values from the same row + same window + different TZ.
  // ---------------------------------------------------------------------------

  it('Gap 4a: timezone America/Chicago — 06:00Z falls inside 00:00–05:00 Chicago window (match)', async () => {
    const rows = [
      previewRow({ id: 'er-1', requestedAt: new Date('2026-06-10T06:00:00Z'), subjectUsername: 'ACME\\jdoe' }),
    ];
    mockPreviewSelect(rows);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchUser: 'ACME\\jdoe',
        timeWindow: { start: '00:00', end: '05:00', timezone: 'America/Chicago' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // 06:00Z = 01:00 America/Chicago (CDT, UTC-5) → inside 00:00–05:00
    expect(body.totalMatched).toBe(1);
    expect(body.totalScanned).toBe(1);
  });

  it('Gap 4b: same window 00:00–05:00 in UTC — 06:00Z falls OUTSIDE (no match)', async () => {
    const rows = [
      previewRow({ id: 'er-1', requestedAt: new Date('2026-06-10T06:00:00Z'), subjectUsername: 'ACME\\jdoe' }),
    ];
    mockPreviewSelect(rows);

    const res = await app().request('/pam/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchUser: 'ACME\\jdoe',
        timeWindow: { start: '00:00', end: '05:00', timezone: 'UTC' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // 06:00Z = 06:00 UTC → outside 00:00–05:00
    expect(body.totalMatched).toBe(0);
    expect(body.totalScanned).toBe(1);
  });
});

describe('PAM org config — default unmatched verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
  });

  // clearAllMocks doesn't drain queued onces; reset the db method mocks so a
  // queued-but-unconsumed select can't leak across cases.
  afterEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
  });

  it('GET /config returns require_approval default when no row exists', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as any);

    const res = await app().request('/pam/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.config.orgId).toBe(ORG_ID);
    expect(body.config.defaultUnmatchedVerdict).toBe('require_approval');
  });

  it('GET /config returns the stored verdict when a row exists', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ defaultUnmatchedVerdict: 'auto_deny' }]),
        })),
      })),
    } as any);

    const res = await app().request('/pam/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.defaultUnmatchedVerdict).toBe('auto_deny');
  });

  it('PUT /config upserts the verdict and returns the saved row', async () => {
    const returning = vi
      .fn()
      .mockResolvedValue([{ id: 'cfg-1', orgId: ORG_ID, defaultUnmatchedVerdict: 'auto_deny' }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    vi.mocked(db.insert).mockReturnValue({ values } as any);

    const res = await app().request('/pam/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultUnmatchedVerdict: 'auto_deny' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.config.defaultUnmatchedVerdict).toBe('auto_deny');
    const valuesArg = (values as any).mock.calls[0][0] as {
      orgId: string;
      defaultUnmatchedVerdict: string;
      updatedByUserId: string;
    };
    expect(valuesArg.orgId).toBe(ORG_ID);
    expect(valuesArg.defaultUnmatchedVerdict).toBe('auto_deny');
    expect(valuesArg.updatedByUserId).toBe(USER_ID);
  });

  it('PUT /config rejects a verdict outside the enum (400)', async () => {
    const res = await app().request('/pam/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultUnmatchedVerdict: 'auto_approve' }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });
});

describe('Signer groups', () => {
  const GROUP_ID = '7b41c9a2-0000-4000-8000-00000000000a';

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
  });

  it('GET /signer-groups lists the org groups', async () => {
    const rows = [
      { id: GROUP_ID, orgId: ORG_ID, name: 'Trusted vendors', description: null, signers: ['Acme Corp'] },
    ];
    // .select().from().where().orderBy() is awaited directly.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(rows),
        })),
      })),
    } as any);

    const res = await app().request('/pam/signer-groups');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.signerGroups).toHaveLength(1);
    expect(body.signerGroups[0].name).toBe('Trusted vendors');
  });

  it('POST /signer-groups trims and de-dupes signers before insert', async () => {
    const returning = vi.fn().mockResolvedValue([
      { id: GROUP_ID, name: 'Trusted vendors', signers: ['Acme Corp', 'Beta Inc'] },
    ]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning })),
    } as any);

    const res = await app().request('/pam/signer-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Trusted vendors',
        // Whitespace + case-insensitive duplicate must be cleaned by the schema.
        signers: ['  Acme Corp  ', 'ACME CORP', 'Beta Inc'],
      }),
    });

    expect(res.status).toBe(201);
    const valuesArg = (vi.mocked(db.insert).mock.results[0]!.value.values as any).mock
      .calls[0][0] as { signers: string[]; orgId: string };
    expect(valuesArg.signers).toEqual(['Acme Corp', 'Beta Inc']);
    expect(valuesArg.orgId).toBe(ORG_ID);
  });

  it('PATCH /signer-groups/:id updates name and signers', async () => {
    // (1) existing-row lookup .from().where().limit(), (2) update .returning().
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: GROUP_ID, orgId: ORG_ID, name: 'old' }]),
        })),
      })),
    } as any);
    const returning = vi.fn().mockResolvedValue([
      { id: GROUP_ID, name: 'new name', signers: ['Gamma LLC'] },
    ]);
    const set = vi.fn(() => ({ where: vi.fn(() => ({ returning })) }));
    vi.mocked(db.update).mockReturnValue({ set } as any);

    const res = await app().request(`/pam/signer-groups/${GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new name', signers: ['Gamma LLC', 'gamma llc'] }),
    });

    expect(res.status).toBe(200);
    const setArg = (set as any).mock.calls[0][0] as { name: string; signers: string[] };
    expect(setArg.name).toBe('new name');
    expect(setArg.signers).toEqual(['Gamma LLC']);
  });

  it('DELETE /signer-groups/:id returns 200 when no rule references it', async () => {
    // (1) existing-row lookup .limit(), (2) refs count .from().where() awaited -> 0.
    let call = 0;
    vi.mocked(db.select).mockImplementation((() => {
      call += 1;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const thenable: any = Promise.resolve([{ refs: 0 }]);
            thenable.limit = vi
              .fn()
              .mockResolvedValue([{ id: GROUP_ID, orgId: ORG_ID, name: 'Trusted vendors' }]);
            return thenable;
          }),
        })),
      };
    }) as any);
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: deleteWhere } as any);

    const res = await app().request(`/pam/signer-groups/${GROUP_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(deleteWhere).toHaveBeenCalledOnce();
    void call;
  });

  it('DELETE /signer-groups/:id returns 409 when a rule references it', async () => {
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const thenable: any = Promise.resolve([{ refs: 2 }]);
          thenable.limit = vi
            .fn()
            .mockResolvedValue([{ id: GROUP_ID, orgId: ORG_ID, name: 'Trusted vendors' }]);
          return thenable;
        }),
      })),
    })) as any);
    vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as any);

    const res = await app().request(`/pam/signer-groups/${GROUP_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('2 rule(s)');
    expect(vi.mocked(db.delete)).not.toHaveBeenCalled();
  });

  it('POST /rules accepts matchSignerGroupId and passes it to the insert', async () => {
    const returning = vi.fn().mockResolvedValue([
      { id: 'rule-sg', name: 'allow vendor group', verdict: 'auto_approve', priority: 100 },
    ]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning })),
    } as any);

    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'allow vendor group',
        verdict: 'auto_approve',
        matchSignerGroupId: GROUP_ID,
      }),
    });

    expect(res.status).toBe(201);
    const valuesArg = (vi.mocked(db.insert).mock.results[0]!.value.values as any).mock
      .calls[0][0] as { matchSignerGroupId: string };
    expect(valuesArg.matchSignerGroupId).toBe(GROUP_ID);
  });

  it('POST /rules rejects setting both matchSigner and matchSignerGroupId (400)', async () => {
    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'conflicting signer rule',
        verdict: 'auto_approve',
        matchSigner: 'Acme Corp',
        matchSignerGroupId: GROUP_ID,
      }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });
});
