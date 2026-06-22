import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    agentId: 'agentId',
    hostname: 'hostname',
  },
  elevationRequests: {
    id: 'id',
    status: 'status',
  },
  elevationAudit: {
    id: 'id',
    orgId: 'orgId',
    elevationRequestId: 'elevationRequestId',
  },
  approvalRequests: {
    id: 'id',
    userId: 'userId',
    elevationRequestId: 'elevationRequestId',
    status: 'status',
  },
  pamRules: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    enabled: 'enabled',
    priority: 'priority',
    matchSignerGroupId: 'matchSignerGroupId',
  },
  pamSignerGroups: {
    id: 'id',
    orgId: 'orgId',
    signers: 'signers',
  },
  pamOrgConfig: {
    id: 'id',
    orgId: 'orgId',
    defaultUnmatchedVerdict: 'defaultUnmatchedVerdict',
  },
}));

const bridgeMocks = vi.hoisted(() => ({
  resolveElevationApprovers: vi.fn(),
  getUserPushTokens: vi.fn(),
  sendExpoPush: vi.fn(),
  buildApprovalPush: vi.fn(() => ({ title: 'Approval requested', body: 'x' })),
}));
vi.mock('../../services/pamApprovers', () => ({
  resolveElevationApprovers: bridgeMocks.resolveElevationApprovers,
}));
vi.mock('../../services/expoPush', () => ({
  getUserPushTokens: bridgeMocks.getUserPushTokens,
  sendExpoPush: bridgeMocks.sendExpoPush,
  buildApprovalPush: bridgeMocks.buildApprovalPush,
}));

const pamMocks = vi.hoisted(() => ({
  evaluatePamBridge: vi.fn(),
  publishEvent: vi.fn(),
}));
vi.mock('../../services/pamBridge', async (importOriginal) => {
  // Keep the real matchPathGlob (the rule engine imports it); only stub the
  // DB-touching evaluator.
  const actual = await importOriginal<typeof import('../../services/pamBridge')>();
  return { ...actual, evaluatePamBridge: pamMocks.evaluatePamBridge };
});
vi.mock('../../services/eventBus', () => ({
  publishEvent: pamMocks.publishEvent,
}));

const mocks = vi.hoisted(() => ({
  rateLimiter: vi.fn(),
}));
vi.mock('../../services/rate-limit', () => ({
  rateLimiter: mocks.rateLimiter,
}));

vi.mock('../../services/redis', () => ({
  getRedis: () => ({}),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: () => '203.0.113.7',
}));

import { db } from '../../db';
import { elevationRequestsRoutes } from './elevationRequests';
import { writeAuditEvent } from '../../services/auditEvents';

const goodPayload = {
  subject_username: 'alice',
  target_executable_path: 'C:\\Windows\\System32\\mmc.exe',
  target_executable_hash: 'deadbeef'.repeat(8),
  pid: 4321,
  parent_image: 'C:\\Windows\\explorer.exe',
  command_line: 'mmc.exe compmgmt.msc',
};

function buildApp(opts: { skipAuth?: boolean } = {}): Hono {
  const app = new Hono();
  if (!opts.skipAuth) {
    app.use('/agents/*', async (c, next) => {
      c.set('agent', {
        deviceId: 'device-1',
        orgId: 'org-1',
        agentId: 'agent-123',
        siteId: 'site-1',
        role: 'agent',
      });
      await next();
    });
  }
  app.route('/agents', elevationRequestsRoutes);
  return app;
}

/**
 * db.select chain serving BOTH shapes the route uses:
 *   device lookup:  .from().where().limit()  -> deviceRows
 *   pam_rules load: .from().where()  (awaited) -> ruleRows
 */
function mockSelects(
  deviceRows: Array<{ id: string; orgId: string; siteId: string | null }>,
  ruleRows: unknown[] = [],
) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const thenable: any = Promise.resolve(ruleRows);
            thenable.limit = vi.fn().mockResolvedValue(deviceRows);
            return thenable;
          }),
        })),
      }) as any,
  );
}

/**
 * Rig db.select for the unmatched-default path, which fires three selects in
 * order: (1) device lookup [.limit() -> deviceRows], (2) pam_rules load
 * [.where() awaited -> [] (no rule matches)], (3) pam_org_config lookup
 * [.where().limit() -> configRows]. Distinguishes the device and config selects
 * (same chain shape) by call order.
 */
function mockSelectsWithConfig(
  deviceRows: Array<{ id: string; orgId: string; siteId: string | null }>,
  configRows: Array<{ verdict: string }>,
) {
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    call += 1;
    const isConfig = call >= 3;
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => {
          // pam_rules load awaits .from().where() directly → resolve [] (no match)
          const thenable: any = Promise.resolve([]);
          thenable.limit = vi.fn().mockResolvedValue(isConfig ? configRows : deviceRows);
          return thenable;
        }),
      })),
    } as any;
  });
}

/**
 * Rig db.select for the signer-group resolution path, which fires three selects
 * in order: (1) device lookup [.limit() -> deviceRows], (2) pam_rules load
 * [.where() awaited -> ruleRows], (3) pam_signer_groups load [.where() awaited
 * -> groupRows]. Distinguishes (2) from (3) by call order.
 */
function mockSelectsWithSignerGroups(
  deviceRows: Array<{ id: string; orgId: string; siteId: string | null }>,
  ruleRows: unknown[],
  groupRows: Array<{ id: string; signers: string[] }>,
) {
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    call += 1;
    const isSignerGroupSelect = call >= 3;
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const thenable: any = Promise.resolve(isSignerGroupSelect ? groupRows : ruleRows);
          thenable.limit = vi.fn().mockResolvedValue(deviceRows);
          return thenable;
        }),
      })),
    } as any;
  });
}

function happyPathInsert(returningRows: Array<{ id: string; status: string }>) {
  const returning = vi.fn().mockResolvedValue(returningRows);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return { returning, values };
}

describe('agent elevation-requests ingestion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimiter.mockResolvedValue({
      allowed: true,
      remaining: 599,
      resetAt: new Date(Date.now() + 60_000),
    });
    mockSelects([{ id: 'device-1', orgId: 'org-1', siteId: 'site-1' }]);
    // Default: no software policy binds, no PAM rules -> 'pending'.
    pamMocks.evaluatePamBridge.mockResolvedValue({ match: null, auditMatches: [] });
    pamMocks.publishEvent.mockResolvedValue('evt-1');
    // Default: no eligible approvers -> mobile bridge is a no-op.
    bridgeMocks.resolveElevationApprovers.mockResolvedValue([]);
    bridgeMocks.getUserPushTokens.mockResolvedValue([]);
    bridgeMocks.sendExpoPush.mockResolvedValue([]);
  });

  it('inserts an elevation request and returns id + status', async () => {
    const { values } = happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ id: 'req-uuid', status: 'pending' });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        orgId: 'org-1',
        flowType: 'uac_intercept',
        subjectUsername: 'alice',
        targetExecutablePath: 'C:\\Windows\\System32\\mmc.exe',
        status: 'pending',
        clientIp: '203.0.113.7',
      }),
    );
    expect(vi.mocked(writeAuditEvent)).toHaveBeenCalledOnce();
  });

  it('returns 404 when the agent_id does not match any device', async () => {
    happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);
    mockSelects([]);

    const app = buildApp();
    const response = await app.request('/agents/agent-unknown/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });

    expect(response.status).toBe(404);
  });

  it('returns 429 when the per-device rate limit is exceeded', async () => {
    mocks.rateLimiter.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });

    expect(response.status).toBe(429);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('returns 413 when Content-Length exceeds the 32 KB body cap', async () => {
    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(64 * 1024),
      },
      body: JSON.stringify(goodPayload),
    });

    expect(response.status).toBe(413);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('rejects payloads missing required fields with 400', async () => {
    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No subject_username
      body: JSON.stringify({
        target_executable_path: 'C:\\foo.exe',
      }),
    });

    expect(response.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('rejects target_executable_path that exceeds 4096 chars', async () => {
    const app = buildApp();
    const huge = 'C:\\' + 'a'.repeat(4100);
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...goodPayload, target_executable_path: huge }),
    });
    expect(response.status).toBe(400);
  });

  it('accepts minimal payload (only required fields)', async () => {
    happyPathInsert([{ id: 'req-min', status: 'pending' }]);

    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject_username: 'svc_acct',
        target_executable_path: '/usr/local/bin/foo',
      }),
    });

    expect(response.status).toBe(201);
  });

  it('uses observed_at from the payload when present', async () => {
    const { values } = happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const observedAt = '2026-05-20T12:00:00.000Z';
    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...goodPayload, observed_at: observedAt }),
    });

    expect(response.status).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedAt: new Date(observedAt),
      }),
    );
  });

  it('rate-limit key is scoped per device, not per agentId in URL', async () => {
    happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const app = buildApp();
    await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });

    expect(mocks.rateLimiter).toHaveBeenCalledWith(
      expect.anything(),
      'elevation:rate:device:device-1',
      600,
      60,
    );
  });
});

describe('ingest decisioning (#1163)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimiter.mockResolvedValue({
      allowed: true,
      remaining: 599,
      resetAt: new Date(Date.now() + 60_000),
    });
    mockSelects([{ id: 'device-1', orgId: 'org-1', siteId: 'site-1' }]);
    pamMocks.evaluatePamBridge.mockResolvedValue({ match: null, auditMatches: [] });
    pamMocks.publishEvent.mockResolvedValue('evt-1');
    bridgeMocks.resolveElevationApprovers.mockResolvedValue([]);
    bridgeMocks.getUserPushTokens.mockResolvedValue([]);
    bridgeMocks.sendExpoPush.mockResolvedValue([]);
  });

  async function post(app: Hono) {
    return app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });
  }

  it('blocklist policy match -> denied + elevation.denied event', async () => {
    pamMocks.evaluatePamBridge.mockResolvedValue({
      match: 'blocklist',
      policyId: 'pol-1',
      auditMatches: [],
    });
    const { values } = happyPathInsert([{ id: 'req-1', status: 'denied' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'denied',
        softwarePolicyMatchId: 'pol-1',
        denialReason: 'Blocked by software policy',
      }),
    );
    expect(pamMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.denied',
      'org-1',
      expect.objectContaining({ elevationRequestId: 'req-1' }),
      'pam-ingest',
    );
  });

  it('allowlist policy match -> auto_approved with expiry + event', async () => {
    pamMocks.evaluatePamBridge.mockResolvedValue({
      match: 'allowlist',
      policyId: 'pol-2',
      auditMatches: [],
    });
    const { values } = happyPathInsert([{ id: 'req-2', status: 'auto_approved' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    const call = vi
      .mocked(values)
      .mock.calls.find(
        (args) => (args[0] as { status?: string }).status === 'auto_approved',
      );
    expect(call).toBeTruthy();
    const inserted = call![0] as { expiresAt: Date; approvedAt: Date; softwarePolicyMatchId: string };
    expect(inserted.softwarePolicyMatchId).toBe('pol-2');
    expect(inserted.approvedAt).toBeInstanceOf(Date);
    expect(inserted.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(pamMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.auto_approved',
      'org-1',
      expect.objectContaining({ softwarePolicyId: 'pol-2' }),
      'pam-ingest',
    );
  });

  it('pam rule auto_deny (real engine) -> denied with rule metadata', async () => {
    const rule = {
      id: 'rule-1',
      orgId: 'org-1',
      siteId: null,
      name: 'Block mmc',
      description: null,
      enabled: true,
      priority: 10,
      matchSigner: null,
      matchHash: null,
      matchPathGlob: 'C:\\Windows\\System32\\mmc.exe',
      matchParentImage: null,
      matchUser: null,
      matchAdGroup: null,
      timeWindow: null,
      verdict: 'auto_deny',
      approvalDurationMinutes: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockSelects([{ id: 'device-1', orgId: 'org-1', siteId: 'site-1' }], [rule]);
    const { values } = happyPathInsert([{ id: 'req-3', status: 'denied' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'denied',
        denialReason: 'Blocked by PAM rule "Block mmc"',
        softwarePolicyMatchId: null,
      }),
    );
  });

  it('pam rule matchSignerGroupId resolves the group -> auto_approved', async () => {
    const rule = {
      id: 'rule-sg',
      orgId: 'org-1',
      siteId: null,
      name: 'Trusted vendors',
      description: null,
      enabled: true,
      priority: 10,
      matchSigner: null,
      matchSignerGroupId: 'grp-1',
      matchHash: null,
      matchPathGlob: null,
      matchParentImage: null,
      matchCommandLine: null,
      matchUser: null,
      matchAdGroup: null,
      matchToolName: null,
      matchRiskTier: null,
      matchNegate: null,
      timeWindow: null,
      verdict: 'auto_approve',
      approvalDurationMinutes: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // The group's members include the candidate's signer (matched case-insensitively).
    mockSelectsWithSignerGroups(
      [{ id: 'device-1', orgId: 'org-1', siteId: 'site-1' }],
      [rule],
      [{ id: 'grp-1', signers: ['Other Vendor', 'Acme Corp'] }],
    );
    const { values } = happyPathInsert([{ id: 'req-sg', status: 'auto_approved' }]);

    const res = await buildApp().request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...goodPayload, target_executable_signer: 'acme corp' }),
    });

    expect(res.status).toBe(201);
    const call = vi
      .mocked(values)
      .mock.calls.find((args) => (args[0] as { status?: string }).status === 'auto_approved');
    expect(call).toBeTruthy();
    const inserted = call![0] as {
      approvedAt: Date;
      expiresAt: Date;
      metadata: { pam_rule_id: string };
    };
    // The signer group resolved the candidate signer -> the rule matched.
    expect(inserted.metadata.pam_rule_id).toBe('rule-sg');
    expect(inserted.approvedAt).toBeInstanceOf(Date);
    expect(inserted.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(pamMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.auto_approved',
      'org-1',
      expect.objectContaining({ elevationRequestId: 'req-sg' }),
      'pam-ingest',
    );
  });

  it('pam rule ignore -> no insert, 200 ignored', async () => {
    const rule = {
      id: 'rule-2',
      orgId: 'org-1',
      siteId: null,
      name: 'Ignore mmc noise',
      description: null,
      enabled: true,
      priority: 5,
      matchSigner: null,
      matchHash: null,
      matchPathGlob: 'C:\\Windows\\System32\\*.exe',
      matchParentImage: null,
      matchUser: null,
      matchAdGroup: null,
      timeWindow: null,
      verdict: 'ignore',
      approvalDurationMinutes: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockSelects([{ id: 'device-1', orgId: 'org-1', siteId: 'site-1' }], [rule]);
    happyPathInsert([{ id: 'never', status: 'never' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: null, status: 'ignored' });
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    expect(vi.mocked(writeAuditEvent)).toHaveBeenCalledOnce();
  });

  it('no policy + no rule + org default auto_deny -> denied (source default)', async () => {
    mockSelectsWithConfig(
      [{ id: 'device-1', orgId: 'org-1', siteId: 'site-1' }],
      [{ verdict: 'auto_deny' }],
    );
    const { values } = happyPathInsert([{ id: 'req-def', status: 'denied' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'denied',
        denialReason: 'Blocked by org default (no matching policy or rule)',
        softwarePolicyMatchId: null,
      }),
    );
    expect(pamMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.denied',
      'org-1',
      expect.objectContaining({ elevationRequestId: 'req-def' }),
      'pam-ingest',
    );
  });

  it('no policy + no rule + no config row -> stays pending (historical default)', async () => {
    mockSelectsWithConfig([{ id: 'device-1', orgId: 'org-1', siteId: 'site-1' }], []);
    const { values } = happyPathInsert([{ id: 'req-pend', status: 'pending' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
    expect(pamMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.requested',
      'org-1',
      expect.anything(),
      'pam-ingest',
    );
  });

  it('bridge failure fails SAFE to pending (never auto-approves on error)', async () => {
    pamMocks.evaluatePamBridge.mockRejectedValue(new Error('policy resolver down'));
    const { values } = happyPathInsert([{ id: 'req-4', status: 'pending' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
    expect(pamMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.requested',
      'org-1',
      expect.anything(),
      'pam-ingest',
    );
  });
});

import { elevationVerdictToRiskTier } from './elevationRequests';

describe('elevationVerdictToRiskTier', () => {
  it('maps a blocklist verdict to critical', () => {
    expect(
      elevationVerdictToRiskTier({ match: 'blocklist', auditMatches: [] }, true),
    ).toBe('critical');
  });

  it('maps an allowlist verdict to low', () => {
    expect(
      elevationVerdictToRiskTier({ match: 'allowlist', auditMatches: [] }, false),
    ).toBe('low');
  });

  it('no verdict + signed -> medium', () => {
    expect(elevationVerdictToRiskTier(null, true)).toBe('medium');
    expect(elevationVerdictToRiskTier({ match: null, auditMatches: [] }, true)).toBe('medium');
  });

  it('no verdict + unsigned -> high', () => {
    expect(elevationVerdictToRiskTier(null, false)).toBe('high');
  });
});

describe('#1254 mobile approval bridge (fan-out)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimiter.mockResolvedValue({
      allowed: true,
      remaining: 599,
      resetAt: new Date(Date.now() + 60_000),
    });
    mockSelects([{ id: 'device-1', orgId: 'org-1', siteId: 'site-1', hostname: 'WS-01' } as any]);
    pamMocks.evaluatePamBridge.mockResolvedValue({ match: null, auditMatches: [] });
    pamMocks.publishEvent.mockResolvedValue('evt-1');
    bridgeMocks.getUserPushTokens.mockResolvedValue(['ExponentPushToken[abc]']);
    bridgeMocks.sendExpoPush.mockResolvedValue([{ status: 'ok', id: 'tk' }]);
  });

  async function post(app: Hono) {
    return app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });
  }

  // Capture approval_requests inserts (the bridge) distinctly from the
  // elevation/audit inserts that share the same db.insert mock.
  function approvalValueCalls(values: ReturnType<typeof vi.fn>) {
    return values.mock.calls.filter(
      (args) => (args[0] as { actionToolName?: string }).actionToolName === 'uac_intercept',
    );
  }

  it('pending uac_intercept fans out one approval per approver + pushes', async () => {
    bridgeMocks.resolveElevationApprovers.mockResolvedValue(['user-a', 'user-b']);
    const { values } = happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);

    expect(bridgeMocks.resolveElevationApprovers).toHaveBeenCalledWith('org-1');
    const approvalCalls = approvalValueCalls(values);
    expect(approvalCalls).toHaveLength(2);
    expect(approvalCalls[0]![0]).toEqual(
      expect.objectContaining({
        userId: 'user-a',
        elevationRequestId: 'req-uuid',
        requestingClientLabel: 'Breeze Agent',
        requestingMachineLabel: 'WS-01',
        actionToolName: 'uac_intercept',
        status: 'pending',
      }),
    );
    expect(approvalCalls[1]![0]).toEqual(
      expect.objectContaining({ userId: 'user-b', elevationRequestId: 'req-uuid' }),
    );
    // Push attempted for each approver.
    expect(bridgeMocks.getUserPushTokens).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.sendExpoPush).toHaveBeenCalledTimes(2);
  });

  it('auto_approved elevation does NOT trigger the bridge', async () => {
    pamMocks.evaluatePamBridge.mockResolvedValue({
      match: 'allowlist',
      policyId: 'pol-2',
      auditMatches: [],
    });
    bridgeMocks.resolveElevationApprovers.mockResolvedValue(['user-a']);
    happyPathInsert([{ id: 'req-auto', status: 'auto_approved' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    expect(bridgeMocks.resolveElevationApprovers).not.toHaveBeenCalled();
  });

  it('denied elevation does NOT trigger the bridge', async () => {
    pamMocks.evaluatePamBridge.mockResolvedValue({
      match: 'blocklist',
      policyId: 'pol-1',
      auditMatches: [],
    });
    bridgeMocks.resolveElevationApprovers.mockResolvedValue(['user-a']);
    happyPathInsert([{ id: 'req-deny', status: 'denied' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    expect(bridgeMocks.resolveElevationApprovers).not.toHaveBeenCalled();
  });

  it('approver resolution throwing still returns 201 (best-effort)', async () => {
    bridgeMocks.resolveElevationApprovers.mockRejectedValue(new Error('db down'));
    happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'req-uuid', status: 'pending' });
  });

  it('a failing push does not abort the remaining approvers', async () => {
    bridgeMocks.resolveElevationApprovers.mockResolvedValue(['user-a', 'user-b']);
    bridgeMocks.sendExpoPush.mockRejectedValueOnce(new Error('expo 500'));
    const { values } = happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const res = await post(buildApp());
    expect(res.status).toBe(201);
    // Both approval rows still inserted despite the first push throwing.
    expect(approvalValueCalls(values)).toHaveLength(2);
  });
});
