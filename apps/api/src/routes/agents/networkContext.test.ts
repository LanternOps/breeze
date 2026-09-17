import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * M1 Task 6 — heartbeat route tolerance for topology passive reports.
 *
 * services/topology/heartbeat.test.ts already unit-tests `topologyHeartbeat`
 * itself (receipt shaping, sequence echoing). What is NOT covered anywhere
 * is the ROUTE's wiring: routes/agents/heartbeat.ts calls
 * `db.transaction(() => topologyHeartbeat(device, data))` wrapped in a
 * try/catch (heartbeat.ts ~line 1817-1826) specifically so a malformed or
 * unsupported topology report, or an outright throw from collection, can
 * never fail the enclosing heartbeat — and an old agent that never sends
 * `networkContextV1` gets no receipt at all rather than a synthesized one.
 * This suite proves that wiring, mocking `services/topology/heartbeat`
 * directly rather than its collectionAuthority/collectionIngest internals
 * (those are the existing unit test's job).
 *
 * Mock pattern follows heartbeatMetricsGate.test.ts: the real handler is
 * enormous (2000+ lines touching many tables), so every DB call resolves to
 * an empty/no-op chain and only the topology + auth seams are controlled.
 */

const recordAgentHeartbeatMock = vi.hoisted(() => vi.fn());
vi.mock('../metrics', () => ({
  recordAgentHeartbeat: recordAgentHeartbeatMock,
  resolveResponseStatus: (c: any) => (c?.finalized ? (c.res?.status ?? 500) : 500),
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

const selectCallState = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../db', () => {
  // The route's very first `db.select()...limit()` looks up the device row
  // (`Device not found` -> 404 otherwise); every later select in the handler
  // resolves to an empty array, same as heartbeatMetricsGate.test.ts's chain.
  const deviceRow = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    status: 'online',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date().toISOString(),
    watchdogStatus: null,
    watchdogLastSeen: null,
  };
  // A generic infinitely-chainable query-builder stand-in: any method call
  // (from/where/orderBy/leftJoin/for/groupBy/...) returns the same proxy, and
  // awaiting it (or calling .limit()/.returning()) resolves to [] — except the
  // SECOND `.limit()` call anywhere, which is the route's device lookup and
  // must resolve to a row or every request 404s before topology code ever
  // runs. (The FIRST `.limit()` call is getOrgAgentUpdateConfig's org/partner
  // settings join, which runs just before it — heartbeat.ts ~line 471-495.)
  // The real route/service surface calls dozens of differently shaped chains
  // (leftJoin, .for('update'), orderBy, ...); enumerating them by hand (as a
  // naive object literal) breaks on the first unlisted method, so a Proxy is
  // used instead of chasing each one down.
  function makeChainProxy(resolved: unknown[] = []): any {
    const target: Record<string, unknown> = {
      then: (resolve: any) => resolve(resolved),
      catch: () => makeChainProxy(resolved),
      // .limit()/.returning() both terminate the builder AND, on some call
      // sites, get chained further (e.g. `.limit(1).for('update')`) — so they
      // must return something that is itself awaitable to `resolved` but also
      // still a fully chainable proxy, not a bare Promise.
      limit: () => makeChainProxy(selectCallState.count++ === 1 ? [deviceRow] : []),
      returning: () => makeChainProxy(resolved),
      values: () => Promise.resolve(undefined),
    };
    return new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return (obj as any)[prop];
        return () => makeChainProxy(resolved);
      },
    });
  }
  const chain = makeChainProxy();
  const dbLike: any = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
  };
  // Several call sites (claimPendingCommandsForDevice, topologyHeartbeat)
  // pass db.transaction a callback expecting a tx handle with select/update/
  // insert/delete — hand back the same mocked surface.
  dbLike.transaction = (fn: (tx: unknown) => unknown) => fn(dbLike);
  return {
    db: dbLike,
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn((fn: any) => fn()),
    assertInTransaction: vi.fn(),
  };
});

const topologyHeartbeatMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/topology/heartbeat', () => ({
  topologyHeartbeat: topologyHeartbeatMock,
}));

const { agentRoutes } = await import('./index');

function buildApp(): Hono {
  const app = new Hono();
  app.route('/agents', agentRoutes);
  return app;
}

function post(body: Record<string, unknown>) {
  return buildApp().request('/agents/device-1/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': 'valid' },
    body: JSON.stringify(body),
  });
}

const baseBody = {
  agentVersion: '0.65.10',
  status: 'ok',
  metrics: { cpuPercent: 5, ramPercent: 10, ramUsedMb: 1024, diskPercent: 15, diskUsedGb: 30 },
};

describe('heartbeat route — topology report tolerance (M1 Task 6)', () => {
  beforeEach(() => {
    topologyHeartbeatMock.mockReset();
    selectCallState.count = 0;
  });

  it('does not fail the heartbeat when topology collection throws an unexpected error', async () => {
    topologyHeartbeatMock.mockRejectedValue(new Error('boom — unsupported/malformed report'));

    const resp = await post({ ...baseBody, networkContextV1: { version: 999, sequence: '7' } });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    // The route's own catch synthesizes a named-rejection receipt rather than
    // propagating the throw — the heartbeat itself must still succeed.
    expect(json.networkContextReceipt).toMatchObject({ accepted: false, reason: 'collection_unavailable' });
  });

  it('returns no receipt for an old agent that never sends networkContextV1', async () => {
    topologyHeartbeatMock.mockResolvedValue({ config: { producerEpoch: undefined }, receipt: undefined });

    const resp = await post({ ...baseBody });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.networkContextReceipt).toBeUndefined();
    // The service is still invoked (it negotiates capability on every beat);
    // it is the absent networkContextV1 that keeps its OWN receipt undefined.
    expect(topologyHeartbeatMock).toHaveBeenCalledTimes(1);
  });

  it('returns the accepted receipt, echoing the report sequence, for a supported report', async () => {
    topologyHeartbeatMock.mockResolvedValue({
      config: { producerEpoch: 'epoch-1', configurationRevision: '1' },
      receipt: { producerEpoch: 'epoch-1', accepted: true, acceptedSequence: '42', reportSequence: '42', sourceReceipts: [] },
    });

    const resp = await post({ ...baseBody, networkContextV1: { version: 1, sequence: '42' } });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.networkContextReceipt).toMatchObject({
      accepted: true,
      acceptedSequence: '42',
      reportSequence: '42',
    });
  });

  it('returns a named rejection receipt (not a throw) for a malformed report the service rejects', async () => {
    topologyHeartbeatMock.mockResolvedValue({
      config: { producerEpoch: 'epoch-1' },
      receipt: { accepted: false, reason: 'invalid_report', reportSequence: '3', sourceReceipts: [] },
    });

    const resp = await post({ ...baseBody, networkContextV1: { version: 1, sequence: '3', junk: true } });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.networkContextReceipt).toMatchObject({ accepted: false, reason: 'invalid_report', reportSequence: '3' });
  });
});
