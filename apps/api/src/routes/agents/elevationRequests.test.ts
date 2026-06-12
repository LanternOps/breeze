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
  pamRules: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    enabled: 'enabled',
    priority: 'priority',
  },
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
