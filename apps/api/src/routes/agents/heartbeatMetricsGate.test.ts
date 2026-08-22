import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * `agent_heartbeat_total` is produced by a middleware registered INSIDE
 * `heartbeatRoutes`, which is in turn mounted below the agent-token gate in
 * ./index.ts (`agentRoutes.use('/:id/*', ...)`).
 *
 * heartbeat.test.ts mounts `heartbeatRoutes` on a bare `new Hono()`, so it can
 * only prove the counter fires — never that the gate sits above it. This suite
 * composes the REAL `agentRoutes` so the ordering itself is under test. Two
 * distinct regressions would otherwise ship silently:
 *
 *   1. Moving `agentRoutes.route('/', heartbeatRoutes)` above the `use('/:id/*')`
 *      gate, or adding 'heartbeat' to AGENT_AUTH_SKIP_ID_SEGMENTS, makes the
 *      counter writable by anyone who can reach POST /agents/<anything>/heartbeat.
 *      `NoAgentHeartbeats` would then be suppressible — and inflatable — from the
 *      open internet.
 *   2. Removing the gate's `next()` passthrough would stop authenticated beats
 *      from ever reaching the counter, restoring the flat zero this fixes.
 */

const recordAgentHeartbeatMock = vi.hoisted(() => vi.fn());
vi.mock('../metrics', () => ({
  recordAgentHeartbeat: recordAgentHeartbeatMock,
  resolveResponseStatus: (c: any) => (c?.finalized ? (c.res?.status ?? 500) : 500),
  // Pulled in by routes/agents/helpers.ts, which the heartbeat route imports.
  recordSensitiveDataFinding: vi.fn(),
  recordSensitiveDataRemediationDecision: vi.fn(),
  recordSoftwareRemediationDecision: vi.fn(),
}));

vi.mock('../../middleware/agentAuth', () => ({
  agentAuthMiddleware: vi.fn(async (c: any, next: any) => {
    if (c.req.header('x-agent-token') !== 'valid') {
      return c.json({ error: 'Invalid agent token' }, 401);
    }
    c.set('agent', {
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      role: 'agent',
    });
    return next();
  }),
  isAgentTokenRotationDue: vi.fn(() => false),
}));

// The heartbeat handler itself is not the subject here — only whether control
// reaches the counter — so every DB call resolves empty and the handler is
// allowed to fail past the gate.
vi.mock('../../db', () => {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([]),
    orderBy: () => chain,
    set: () => chain,
    values: () => Promise.resolve(undefined),
    returning: () => Promise.resolve([]),
    then: (resolve: any) => resolve([]),
  };
  return {
    db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain },
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn((fn: any) => fn()),
  };
});

const { agentRoutes } = await import('./index');

function buildApp(): Hono {
  const app = new Hono();
  app.route('/agents', agentRoutes);
  return app;
}

const body = JSON.stringify({
  agentVersion: '0.65.10',
  metrics: { cpuPercent: 5, ramPercent: 10, ramUsedMb: 1024, diskPercent: 15, diskUsedGb: 30 },
});

describe('agent_heartbeat_total auth gate', () => {
  beforeEach(() => {
    recordAgentHeartbeatMock.mockClear();
  });

  it('does not count a heartbeat rejected by agent-token auth', async () => {
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(resp.status).toBe(401);
    // The counter must be unreachable without a valid agent token — otherwise it
    // is a publicly writable metric.
    expect(recordAgentHeartbeatMock).not.toHaveBeenCalled();
  });

  it('reaches the counter once the agent token is valid', async () => {
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': 'valid' },
      body,
    });

    expect(resp.status).not.toBe(401);
    expect(recordAgentHeartbeatMock).toHaveBeenCalledTimes(1);
  });
});
