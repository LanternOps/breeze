import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  status: 200, history: vi.fn(), link: vi.fn(), etag: vi.fn(),
  command: vi.fn(), poll: vi.fn(), unifi: vi.fn(), scan: vi.fn(), model: vi.fn(), insert: vi.fn(), update: vi.fn(), remove: vi.fn(), execute: vi.fn(),
}));
vi.mock('./middleware', () => ({ requireTopologySiteCapability: () => async (c: any, next: any) => {
  if (mocks.status !== 200) return c.json({ error: 'Denied' }, mocks.status);
  c.set('topologyContext', { scope: { orgId: '10000000-0000-4000-8000-000000000001', siteId: c.req.param('siteId') } });
  return next();
} }));
vi.mock('../../services/topology/interfaceHistory', async (original) => ({ ...await original<object>(), getTopologyInterfaceHistory: mocks.history }));
vi.mock('../../services/topology/graph', async (original) => ({ ...await original<object>(), getTopologyLinkHealth: mocks.link, getTopologyReadEtag: mocks.etag }));
// Real mutation/poll boundaries: an accidental import and dispatch through these modules is observable.
vi.mock('../../services/commandQueue', () => ({ executeCommand: mocks.command, queueCommand: mocks.command, queueCommandForExecution: mocks.command, executeCommandWithSystemPrecheck: mocks.command }));
vi.mock('../../jobs/snmpWorker', () => ({ enqueueSnmpPoll: mocks.poll, buildSnmpPollCommand: mocks.poll }));
vi.mock('../../services/unifi/unifiCollectorService', () => ({ collectUnifiSite: mocks.unifi }));
vi.mock('../../services/discoveryJobCreation', () => ({ createDiscoveryJobIfIdle: mocks.scan }));
vi.mock('../../services/aiTools', () => ({ executeTool: mocks.model }));
vi.mock('../../db', () => ({ db: { insert: mocks.insert, update: mocks.update, delete: mocks.remove, execute: mocks.execute } }));
import { topologyHistoryRoutes } from './history';
import { GraphReadError } from '../../services/topology/graphCursor';
import { metricsRegistry } from '../../services/metricsRegistry';
import { TOPOLOGY_METRIC_NAMES } from '../../services/topology/metrics';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const IF = '30000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const base = `/topology/sites/${SITE}`;
const app = () => new Hono().route('/topology', topologyHistoryRoutes);
const range = 'from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z';
const sideEffects = () => [mocks.command, mocks.poll, mocks.unifi, mocks.scan, mocks.model, mocks.insert, mocks.update, mocks.remove, mocks.execute];

beforeEach(() => {
  vi.clearAllMocks(); mocks.status = 200; mocks.etag.mockReturnValue('W/"link-etag"');
  mocks.history.mockResolvedValue({ interfaceId: IF, series: [] });
  mocks.link.mockResolvedValue({ relationshipId: REL, health: { status: 'unknown' } });
});

describe('interface history route', () => {
  it('publishes the served bucket count by resolution without any id label', async () => {
    metricsRegistry.resetMetrics();
    mocks.history.mockResolvedValueOnce({ interfaceId: IF, resolution: '5m', series: [],
      interval: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z', bucketSeconds: 300 } });
    const res = await app().request(`${base}/interfaces/${IF}/history?series=in_bps&${range}&resolution=5m`);
    expect(res.status).toBe(200);
    const text = await metricsRegistry.metrics();
    expect(text).toContain(`${TOPOLOGY_METRIC_NAMES.historyBuckets}_sum{resolution="5m"} 288`);
    expect(text).not.toContain(IF);
    expect(text).not.toContain(SITE);
  });

  it('serves bounded history as private no-store and never polls or dispatches', async () => {
    const res = await app().request(`${base}/interfaces/${IF}/history?series=in_bps,out_errors_per_second&${range}&resolution=5m&maxBuckets=200`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.has('etag')).toBe(false);
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ scope: { orgId: ORG, siteId: SITE } }), IF,
      { series: ['in_bps', 'out_errors_per_second'], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', resolution: '5m', maxBuckets: 200 });
    for (const boundary of sideEffects()) expect(boundary).not.toHaveBeenCalled();
  });

  it('rejects a ninth series before querying and never polls', async () => {
    const response = await app().request(`${base}/interfaces/${IF}/history?series=${Array(9).fill('in_bps').join(',')}&${range}`);
    expect(response.status).toBe(400);
    expect(mocks.history).not.toHaveBeenCalled();
    for (const boundary of sideEffects()) expect(boundary).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate series', `series=in_bps,in_bps&${range}`],
    ['unknown series', `series=in_pps&${range}`],
    ['raw beyond seven days', 'series=in_bps&resolution=raw&from=2026-09-01T00:00:00Z&to=2026-09-09T00:00:01Z'],
    ['beyond ninety days', 'series=in_bps&from=2026-06-01T00:00:00Z&to=2026-09-01T00:00:00Z'],
    ['invalid start', 'series=in_bps&from=yesterday&to=2026-09-02T00:00:00Z'],
    ['end before start', 'series=in_bps&from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z'],
    ['bucket cap', `series=in_bps&${range}&maxBuckets=1001`],
    ['missing series', range],
    ['unknown parameter', `series=in_bps&${range}&interval=1s`],
    ['foreign org override', `series=in_bps&${range}&orgId=10000000-0000-4000-8000-000000000002`],
  ])('rejects %s with 400 before the service', async (_label, query) => {
    const response = await app().request(`${base}/interfaces/${IF}/history?${query}`);
    expect(response.status).toBe(400);
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('tolerates the ambient orgId of the site itself', async () => {
    expect((await app().request(`${base}/interfaces/${IF}/history?series=in_bps&${range}&orgId=${ORG}`)).status).toBe(200);
  });

  it.each([401, 403, 404])('blocks unauthorized reads with %s', async (status) => {
    mocks.status = status;
    expect((await app().request(`${base}/interfaces/${IF}/history?series=in_bps&${range}`)).status).toBe(status);
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('maps a hidden interface to 404 with a stable code', async () => {
    mocks.history.mockRejectedValue(new GraphReadError('topology_subject_not_found', 404, 'Topology subject not found'));
    const res = await app().request(`${base}/interfaces/${IF}/history?series=in_bps&${range}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'topology_subject_not_found' });
  });
});

describe('link health route', () => {
  it('serves current link health with a permission-scoped ETag and 304 only after authorization', async () => {
    const res = await app().request(`${base}/relationships/${REL}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('W/"link-etag"');
    expect(res.headers.get('cache-control')).toBe('private, no-cache, max-age=0');
    expect((await app().request(`${base}/relationships/${REL}/health`, { headers: { 'If-None-Match': 'W/"link-etag"' } })).status).toBe(304);
    mocks.status = 403;
    expect((await app().request(`${base}/relationships/${REL}/health`, { headers: { 'If-None-Match': 'W/"link-etag"' } })).status).toBe(403);
    for (const boundary of sideEffects()) expect(boundary).not.toHaveBeenCalled();
  });

  it('rejects query parameters on link health', async () => {
    expect((await app().request(`${base}/relationships/${REL}/health?probe=true`)).status).toBe(400);
    expect(mocks.link).not.toHaveBeenCalled();
  });
});
