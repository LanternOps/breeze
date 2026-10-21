import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  rateLimiter: vi.fn(),
  writeAuditEvent: vi.fn(),
  publishEvent: vi.fn(),
  expireMobile: vi.fn(),
  afterExit: [] as Array<{ label: string; work: () => unknown }>,
  afterCommit: [] as Array<{ label: string; work: () => unknown }>,
}));

vi.mock('../../services/pamDeviceUnable', async () => ({
  ...(await vi.importActual<typeof import('../../services/pamDeviceUnable')>('../../services/pamDeviceUnable')),
  recordElevationDeviceUnable: mocks.record,
}));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock('../../services/eventBus', () => ({ publishEvent: mocks.publishEvent }));
vi.mock('../../services/pamMobileApprovals', () => ({ expireSupersededMobileApprovals: mocks.expireMobile }));
vi.mock('../../db', () => ({
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runAfterDbContextExit: vi.fn((label: string, work: () => unknown) => {
    mocks.afterExit.push({ label, work });
  }),
  runAfterDbContextCommit: vi.fn((label: string, work: () => unknown) => {
    mocks.afterCommit.push({ label, work });
  }),
}));

import { withDbAccessContext } from '../../db';
import { pamElevationUnableRoutes } from './pamElevationUnable';

const DEVICE = '30000000-0000-4000-8000-000000000001';
const ORG = '40000000-0000-4000-8000-000000000001';
const PARTNER = '70000000-0000-4000-8000-000000000001';
const REQUEST = '10000000-0000-4000-8000-000000000009';

function buildApp(role: 'agent' | 'watchdog' = 'agent', claimTypeAllowlist?: string[]): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      claimTypeAllowlist,
      deviceId: DEVICE,
      orgId: ORG,
      partnerId: PARTNER,
      agentId: 'agent-primary',
      siteId: '50000000-0000-4000-8000-000000000001',
      role,
    });
    await next();
  });
  app.route('/agents', pamElevationUnableRoutes);
  return app;
}

function post(app: Hono, body: unknown, pathAgentId = 'agent-primary', headers: Record<string, string> = {}) {
  return app.request(`/agents/${pathAgentId}/pam/elevation-unable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = { elevationRequestId: REQUEST, reason: 'session_unavailable', detail: 'session 7 is not active' };

const recordedClosed = {
  kind: 'recorded',
  id: REQUEST,
  orgId: ORG,
  deviceId: DEVICE,
  flowType: 'uac_intercept',
  priorStatus: 'pending',
  status: 'expired',
  closed: true,
};

describe('POST /agents/:id/pam/elevation-unable (#9517)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.afterExit.length = 0;
    mocks.afterCommit.length = 0;
    vi.mocked(withDbAccessContext).mockImplementation(async (_ctx: any, fn: any) => fn());
    mocks.rateLimiter.mockResolvedValue({ allowed: true, remaining: 119, resetAt: new Date('2027-01-02T12:01:00Z') });
    mocks.record.mockResolvedValue(recordedClosed);
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.expireMobile.mockResolvedValue(2);
  });

  it('records the report for the authenticated device, closes the request, and expires its phone approvals', async () => {
    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'recorded', elevationStatus: 'expired' });
    // Identity comes from the agent credential, never the body.
    expect(mocks.record).toHaveBeenCalledWith({
      deviceId: DEVICE,
      elevationRequestId: REQUEST,
      reason: 'session_unavailable',
      detail: 'session 7 is not active',
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG,
      actorType: 'agent',
      actorId: 'agent-primary',
      action: 'agent.elevation_request.device_unable',
      resourceId: REQUEST,
      details: { flow_type: 'uac_intercept', reason: 'session_unavailable', prior_status: 'pending', closed: true },
    }));

    // Sibling phone approvals expire after the context exits (#7526 order).
    expect(mocks.expireMobile).not.toHaveBeenCalled();
    expect(mocks.afterExit).toHaveLength(1);
    await mocks.afterExit[0]!.work();
    expect(mocks.expireMobile).toHaveBeenCalledWith(REQUEST);

    // The close is announced only after commit.
    expect(mocks.publishEvent).not.toHaveBeenCalled();
    expect(mocks.afterCommit).toHaveLength(1);
    await mocks.afterCommit[0]!.work();
    expect(mocks.publishEvent).toHaveBeenCalledWith('elevation.expired', ORG, {
      elevationRequestId: REQUEST,
      deviceId: DEVICE,
      flowType: 'uac_intercept',
      status: 'expired',
      cause: 'device_unable',
      reason: 'session_unavailable',
    }, 'pam-device-unable');
  });

  it('opens its own org-scoped context after the rate limiter decides', async () => {
    const order: string[] = [];
    mocks.rateLimiter.mockImplementation(async () => {
      order.push('rateLimit');
      return { allowed: true, remaining: 1, resetAt: new Date() };
    });
    vi.mocked(withDbAccessContext).mockImplementation(async (_ctx: any, fn: any) => {
      order.push('context');
      return fn();
    });

    await post(buildApp(), validBody);

    expect(order).toEqual(['rateLimit', 'context']);
    expect(mocks.rateLimiter).toHaveBeenCalledWith(expect.anything(), `pam:elevation-unable:rate:device:${DEVICE}`, 120, 60);
    expect(vi.mocked(withDbAccessContext)).toHaveBeenCalledWith(
      {
        scope: 'organization',
        orgId: ORG,
        accessibleOrgIds: [ORG],
        accessiblePartnerIds: [],
        currentPartnerId: PARTNER,
      },
      expect.any(Function),
    );
  });

  it('does not expire phone approvals or publish when the request was not pending', async () => {
    mocks.record.mockResolvedValue({ ...recordedClosed, priorStatus: 'auto_approved', status: 'auto_approved', closed: false });

    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'recorded', elevationStatus: 'auto_approved' });
    expect(mocks.afterExit).toHaveLength(0);
    expect(mocks.afterCommit).toHaveLength(0);
    expect(mocks.writeAuditEvent).toHaveBeenCalledOnce();
  });

  it('only uac_intercept requests fan out to phones', async () => {
    mocks.record.mockResolvedValue({ ...recordedClosed, flowType: 'tech_jit_admin' });

    await post(buildApp(), validBody);

    expect(mocks.afterExit).toHaveLength(0);
    expect(mocks.afterCommit).toHaveLength(1);
  });

  it('a repeated report is a 200 that changes nothing', async () => {
    mocks.record.mockResolvedValue({ kind: 'already_reported', status: 'expired' });

    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'already_reported', elevationStatus: 'expired' });
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(mocks.afterExit).toHaveLength(0);
    expect(mocks.afterCommit).toHaveLength(0);
  });

  it('404s a request the device does not own or cannot see', async () => {
    mocks.record.mockResolvedValue({ kind: 'not_found' });

    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(404);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects a path naming a different agent', async () => {
    const res = await post(buildApp(), validBody, 'agent-other');
    expect(res.status).toBe(403);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('rejects a drain-restricted credential', async () => {
    const res = await post(buildApp('agent', ['heartbeat']), validBody);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'drain_restricted' });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('rejects a watchdog token', async () => {
    const res = await post(buildApp('watchdog'), validBody);
    expect(res.status).toBe(403);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('429s when the per-device rate limit is exhausted, before touching the DB', async () => {
    mocks.rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date('2027-01-02T12:01:00Z') });

    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(429);
    expect(vi.mocked(withDbAccessContext)).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown reason', { ...validBody, reason: 'gremlins' }],
    ['a non-uuid request id', { ...validBody, elevationRequestId: 'req-1' }],
    ['an extra field', { ...validBody, status: 'denied' }],
    ['a missing reason', { elevationRequestId: REQUEST }],
    ['an oversized detail', { ...validBody, detail: 'x'.repeat(4001) }],
  ])('400s %s', async (_name, body) => {
    const res = await post(buildApp(), body);
    expect(res.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('413s a body over 8 KiB by its declared length', async () => {
    const res = await post(buildApp(), validBody, 'agent-primary', { 'content-length': String(9 * 1024) });
    expect(res.status).toBe(413);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('a failed event publish does not throw out of the commit hook', async () => {
    mocks.publishEvent.mockRejectedValue(new Error('redis down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(buildApp(), validBody);
    expect(res.status).toBe(200);
    await expect(mocks.afterCommit[0]!.work()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
