import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  withdraw: vi.fn(),
  writeAuditEvent: vi.fn(),
  publishEvent: vi.fn(),
  expireMobile: vi.fn(),
  afterExit: [] as Array<{ label: string; kind: 'exit' | 'commit'; work: () => unknown }>,
}));

vi.mock('../../services/pamWithdraw', () => ({ withdrawElevationRequest: mocks.withdraw }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock('../../services/eventBus', () => ({ publishEvent: mocks.publishEvent }));
vi.mock('../../services/pamMobileApprovals', () => ({ expireSupersededMobileApprovals: mocks.expireMobile }));
vi.mock('../../db', () => ({
  runAfterDbContextExit: vi.fn((label: string, work: () => unknown) => { mocks.afterExit.push({ label, kind: 'exit', work }); }),
  runAfterDbContextCommit: vi.fn((label: string, work: () => unknown) => { mocks.afterExit.push({ label, kind: 'commit', work }); }),
}));

import { elevationWithdrawRoutes } from './elevationWithdraw';

const DEVICE = '30000000-0000-4000-8000-000000000001';
const ORG = '40000000-0000-4000-8000-000000000001';
const REQUEST = '10000000-0000-4000-8000-000000000009';
const WITHDRAWN_AT = new Date('2027-01-10T10:00:01.000Z');

function buildApp(role: 'agent' | 'watchdog' = 'agent', claimTypeAllowlist?: string[]): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      claimTypeAllowlist,
      deviceId: DEVICE,
      orgId: ORG,
      partnerId: '70000000-0000-4000-8000-000000000001',
      agentId: 'agent-primary',
      siteId: '50000000-0000-4000-8000-000000000001',
      installIncarnation: 1,
      role,
    });
    await next();
  });
  app.route('/agents', elevationWithdrawRoutes);
  return app;
}

function post(app: Hono, body: unknown, opts: { pathAgentId?: string; requestId?: string; raw?: string } = {}) {
  return app.request(`/agents/${opts.pathAgentId ?? 'agent-primary'}/elevation-requests/${opts.requestId ?? REQUEST}/withdraw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.raw ?? JSON.stringify(body),
  });
}

async function runDeferred(): Promise<void> {
  for (const task of mocks.afterExit.splice(0)) await task.work();
}

const validBody = { reason: 'user_denied', declinedAt: '2027-01-10T10:00:00.000Z' };

describe('POST /agents/:id/elevation-requests/:requestId/withdraw (#8971)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.afterExit.length = 0;
    mocks.withdraw.mockResolvedValue({ kind: 'withdrawn', withdrawnAt: WITHDRAWN_AT, replay: false });
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.expireMobile.mockResolvedValue(2);
  });

  it('withdraws for the authenticated device, audits, and defers phone expiry + the event', async () => {
    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: REQUEST, status: 'withdrawn', withdrawnAt: WITHDRAWN_AT.toISOString() });
    // Identity comes from the agent credential, never the body.
    expect(mocks.withdraw).toHaveBeenCalledWith({
      orgId: ORG,
      deviceId: DEVICE,
      requestId: REQUEST,
      reason: 'user_denied',
      agentDeclinedAt: new Date('2027-01-10T10:00:00.000Z'),
      renderer: null,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG,
      actorType: 'agent',
      actorId: 'agent-primary',
      action: 'pam.elevation_request.withdrawn',
      resourceType: 'elevation_request',
      resourceId: REQUEST,
      details: { reason: 'user_denied', agent_declined_at: '2027-01-10T10:00:00.000Z', renderer: null },
    }));

    // Nothing runs while the request transaction (and the row lock) is open.
    expect(mocks.expireMobile).not.toHaveBeenCalled();
    expect(mocks.publishEvent).not.toHaveBeenCalled();
    // The event only after commit; the phone expiry after exit (#7526 order:
    // elevation first, then approval rows).
    expect(mocks.afterExit.map((t) => t.kind).sort()).toEqual(['commit', 'exit']);
    await runDeferred();
    expect(mocks.expireMobile).toHaveBeenCalledWith(REQUEST);
    expect(mocks.publishEvent).toHaveBeenCalledWith('elevation.withdrawn', ORG, {
      elevationRequestId: REQUEST,
      deviceId: DEVICE,
      flowType: 'uac_intercept',
      status: 'withdrawn',
      reason: 'user_denied',
    }, 'pam-withdraw');
  });

  it('withdraw accepts user_cancelled (#10190 W07: Cancel request on the waiting card)', async () => {
    const res = await post(buildApp(), { reason: 'user_cancelled', renderer: 'assist' });

    expect(res.status).toBe(200);
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_cancelled', renderer: 'assist' }));
    await runDeferred();
    expect(mocks.publishEvent).toHaveBeenCalledWith('elevation.withdrawn', ORG, expect.objectContaining({ reason: 'user_cancelled' }), 'pam-withdraw');
  });

  it.each(['assist', 'native', 'headless'] as const)('renderer %s is recorded in the audit details', async (renderer) => {
    const res = await post(buildApp(), { ...validBody, renderer });

    expect(res.status).toBe(200);
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.objectContaining({ renderer }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: { reason: 'user_denied', agent_declined_at: '2027-01-10T10:00:00.000Z', renderer },
    }));
  });

  it('an unknown renderer is dropped, never a 400 (a 400 is final for the agent)', async () => {
    const res = await post(buildApp(), { ...validBody, renderer: 'hologram' });

    expect(res.status).toBe(200);
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.objectContaining({ renderer: null }));
  });

  it('declinedAt is optional', async () => {
    const res = await post(buildApp(), { reason: 'user_timeout' });

    expect(res.status).toBe(200);
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_timeout', agentDeclinedAt: null }));
  });

  it('a replay answers 200 with the stored withdrawnAt, writes and publishes nothing, and re-runs the idempotent phone expiry', async () => {
    mocks.withdraw.mockResolvedValue({ kind: 'withdrawn', withdrawnAt: WITHDRAWN_AT, replay: true });

    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: REQUEST, status: 'withdrawn', withdrawnAt: WITHDRAWN_AT.toISOString() });
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    // Heals a first-call expiry that failed; no second event.
    expect(mocks.afterExit.map((t) => t.kind)).toEqual(['exit']);
    await runDeferred();
    expect(mocks.expireMobile).toHaveBeenCalledWith(REQUEST);
    expect(mocks.publishEvent).not.toHaveBeenCalled();
  });

  it('a non-pending request answers 409 with its status', async () => {
    mocks.withdraw.mockResolvedValue({ kind: 'not_pending', status: 'approved' });

    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'not_pending', status: 'approved' });
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(mocks.afterExit).toHaveLength(0);
  });

  it('an unknown request answers a generic 404', async () => {
    mocks.withdraw.mockResolvedValue({ kind: 'not_found' });

    const res = await post(buildApp(), validBody);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    expect(mocks.afterExit).toHaveLength(0);
  });

  it('403 when the path names another agent', async () => {
    const res = await post(buildApp(), validBody, { pathAgentId: 'agent-other' });

    expect(res.status).toBe(403);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it('403 drain_restricted for a drain-narrowed credential', async () => {
    const res = await post(buildApp('agent', ['self_uninstall']), validBody);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'drain_restricted' });
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it('rejects a watchdog token', async () => {
    const res = await post(buildApp('watchdog'), validBody);

    expect(res.status).toBe(403);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown reason', { reason: 'other' }],
    ['a missing reason', {}],
    ['a non-ISO declinedAt', { reason: 'user_denied', declinedAt: 'yesterday' }],
  ])('400 on %s', async (_label, body) => {
    const res = await post(buildApp(), body);

    expect(res.status).toBe(400);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it('400 on a non-uuid requestId', async () => {
    const res = await post(buildApp(), validBody, { requestId: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it('ignores unknown body fields, so a newer agent is not rejected', async () => {
    const res = await post(buildApp(), { ...validBody, dialogVersion: 2 });

    expect(res.status).toBe(200);
  });

  it('413 on a body over 4 KiB', async () => {
    const res = await post(buildApp(), undefined, { raw: JSON.stringify({ ...validBody, pad: 'x'.repeat(5 * 1024) }) });

    expect(res.status).toBe(413);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });
});
