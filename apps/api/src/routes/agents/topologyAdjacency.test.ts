import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { admit, flags, ctx } = vi.hoisted(() => ({
  admit: vi.fn(),
  flags: { materialization: true },
  ctx: { depth: 0, sawDepthAtAdmit: -1 },
}));
vi.mock('../../db', () => ({
  db: { transaction: async (fn: () => unknown) => fn() },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  withDbAccessContext: async (_c: unknown, fn: () => unknown) => { ctx.depth++; try { return await fn(); } finally { ctx.depth--; } },
}));
vi.mock('../../services/topology/flags', () => ({
  loadTopologyFlags: vi.fn(async () => ({ ...flags })),
  withResolvedTopologyFlags: (_r: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../services/topology/discoveryDispatch', () => ({ ensureDiscoveryTopologyAuthority: vi.fn() }));
vi.mock('../../services/topology/discoveryTransport', () => ({ admitDiscoveryAdjacencyReport: admit }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import vector from '../../../../../packages/shared/src/testing/topology-adjacency-v2.json';
import { createGlobalBodyLimitMiddleware } from '../../middleware/bodyLimitGate';
import { topologyAdjacencyRoutes } from './topologyAdjacency';

const DEVICE = '33333333-3333-4333-8333-333333333333';
const report = () => structuredClone(vector.vectors[0]!.report) as Record<string, any>;
function app(role = 'agent') {
  const a = new Hono();
  a.use('*', createGlobalBodyLimitMiddleware({ warn: () => undefined, capture: () => undefined }));
  a.use('*', async (c, next) => { c.set('agent' as never, { deviceId: DEVICE, orgId: 'org-1', siteId: 'site-1', role } as never); await next(); });
  a.route('/api/v1/agents', topologyAdjacencyRoutes);
  return a;
}
const post = (body: unknown, a = app()) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return a.request(`/api/v1/agents/${DEVICE}/topology/adjacency`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: text });
};

describe('POST /agents/:id/topology/adjacency', () => {
  beforeEach(() => {
    admit.mockReset(); flags.materialization = true; ctx.depth = 0;
    admit.mockImplementation(async () => { ctx.sawDepthAtAdmit = ctx.depth; return { status: 200, body: { accepted: true, receipts: [] } }; });
  });

  it('admits inside one org-scoped transaction with authority from the token context, not the payload', async () => {
    const r = report();
    const res = await post({ parentJobId: r.parentJobId, report: r });
    expect(res.status).toBe(200);
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ deviceId: DEVICE, orgId: 'org-1' }));
    expect(ctx.sawDepthAtAdmit).toBe(1);
  });

  // Drizzle wraps the driver error: the SQLSTATE lives on `.cause`, so a
  // direct `.code` read never saw a NOWAIT lock loss and answered 500.
  it('answers producer_busy for a lock_not_available wrapped by Drizzle', async () => {
    admit.mockRejectedValue(Object.assign(new Error('Failed query'), { cause: { code: '55P03' } }));
    const r = report();
    const res = await post({ parentJobId: r.parentJobId, report: r });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 503, body: { error: 'producer_busy' } });
  });

  it('rejects the watchdog credential', async () => {
    const r = report();
    expect((await post({ parentJobId: r.parentJobId, report: r }, app('watchdog'))).status).toBe(403);
    expect(admit).not.toHaveBeenCalled();
  });

  it('types malformed bodies before any DB work', async () => {
    const r = report();
    const cases: [unknown, string][] = [
      ['{not json', 'invalid_json'],
      [{ report: r }, 'invalid_report'],
      [{ parentJobId: r.parentJobId, report: r, extra: 1 }, 'invalid_report'],
      [{ parentJobId: r.parentJobId, report: { ...r, version: 3 } }, 'unsupported_major_version'],
      [{ parentJobId: r.parentJobId, report: { ...r, deviceId: DEVICE } }, 'invalid_report'],
      [{ parentJobId: '20000000-0000-4000-8000-00000000000f', report: r }, 'parent_mismatch'],
    ];
    for (const [body, error] of cases) {
      const res = await post(body);
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 400, body: { error } });
    }
    expect(admit).not.toHaveBeenCalled();
  });

  it('refuses when materialization is off', async () => {
    flags.materialization = false;
    const r = report();
    const res = await post({ parentJobId: r.parentJobId, report: r });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 409, body: { error: 'materialization_disabled' } });
    expect(admit).not.toHaveBeenCalled();
  });

  it('returns the service rejection status and body', async () => {
    admit.mockResolvedValueOnce({ status: 410, body: { error: 'parent_expired' } });
    const r = report();
    const res = await post({ parentJobId: r.parentJobId, report: r });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 410, body: { error: 'parent_expired' } });
  });

  it('answers 413 above 4 MiB plus envelope and admits a large body under it', async () => {
    const r = report();
    const pad = (bytes: number) => JSON.stringify({ parentJobId: r.parentJobId, report: { ...r, padding: 'x'.repeat(bytes) } });
    const over = await post(pad(4 * 1024 * 1024 + 64 * 1024));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: 'Adjacency report too large (max 4 MiB)' });
    expect(admit).not.toHaveBeenCalled();
    // 2 MiB passes the gate (unknown keys are stripped by the report schema).
    const under = await post(pad(2 * 1024 * 1024));
    expect(under.status).toBe(200);
    expect(admit).toHaveBeenCalledTimes(1);
  });
});
