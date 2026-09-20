import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { buildTopologyGraphResponse } from '../../__tests__/helpers/topology';

const mocks = vi.hoisted(() => ({
  status: 200, graph: vi.fn(), list: vi.fn(), node: vi.fn(), relationship: vi.fn(), evidence: vi.fn(), group: vi.fn(), expansion: vi.fn(), health: vi.fn(), etag: vi.fn(),
  command: vi.fn(), scan: vi.fn(), model: vi.fn(), insert: vi.fn(), update: vi.fn(), remove: vi.fn(), execute: vi.fn(),
}));
vi.mock('./middleware', () => ({ requireTopologySiteCapability: () => async (c: any, next: any) => {
  if (mocks.status !== 200) return c.json({ error: 'Denied' }, mocks.status);
  c.set('topologyContext', { scope: { orgId: '10000000-0000-4000-8000-000000000001', siteId: c.req.param('siteId') } });
  return next();
} }));
vi.mock('../../services/topology/graph', async (original) => ({ ...await original<object>(),
  getTopologyGraph: mocks.graph, listTopologyNodes: mocks.list, getTopologyNode: mocks.node, getTopologyRelationship: mocks.relationship,
  getTopologyRelationshipEvidence: mocks.evidence, getTopologyGroupMembers: mocks.group, expandTopologyGraph: mocks.expansion,
  getTopologyHealth: mocks.health, getTopologyReadEtag: mocks.etag,
}));
// Real mutation boundaries: an accidental import and dispatch through these modules is observable.
vi.mock('../../services/commandQueue', () => ({ executeCommand: mocks.command, queueCommand: mocks.command, queueCommandForExecution: mocks.command, executeCommandWithSystemPrecheck: mocks.command }));
vi.mock('../../services/discoveryJobCreation', () => ({ createDiscoveryJobIfIdle: mocks.scan }));
vi.mock('../../services/aiTools', () => ({ executeTool: mocks.model }));
vi.mock('../../db', () => ({ db: { insert: mocks.insert, update: mocks.update, delete: mocks.remove, execute: mocks.execute } }));
import { topologyGraphRoutes } from './graphs';
import { GraphReadError } from '../../services/topology/graphCursor';
const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const base = `/topology/sites/${SITE}`;
const app = () => new Hono().route('/topology', topologyGraphRoutes);
beforeEach(() => {
  vi.clearAllMocks(); mocks.status = 200; mocks.etag.mockReturnValue('W/"private-test"');
  for (const reader of [mocks.graph, mocks.list, mocks.node, mocks.relationship, mocks.evidence, mocks.group, mocks.expansion, mocks.health]) reader.mockReset().mockResolvedValue(buildTopologyGraphResponse());
});
describe('passive topology routes', () => {
  it.each([
    '/graph', '/nodes?q=host', `/nodes/${NODE}`, `/relationships/${REL}`, `/relationships/${REL}/evidence`,
    `/groups/${NODE}/members`, '/expansions/signed-token', `/health?nodeIds=${NODE}`,
  ])('serves %s without any write or dispatch', async (path) => {
    const res = await app().request(base + path);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(1); expect(body.counts.visibleNodes).toBe(body.nodes.length);
    expect(res.headers.get('cache-control')).toContain('private'); expect(res.headers.get('vary')).toContain('Authorization');
    for (const boundary of [mocks.command, mocks.scan, mocks.model, mocks.insert, mocks.update, mocks.remove, mocks.execute]) expect(boundary).not.toHaveBeenCalled();
  });
  it('keeps evidence no-store and never produces 304 for details', async () => {
    const res = await app().request(`${base}/relationships/${REL}/evidence`, { headers: { 'If-None-Match': 'W/"private-test"' } });
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('private, no-store'); expect(res.headers.has('etag')).toBe(false);
  });
  it('honors a private ETag only after current authorization and service lookup', async () => {
    const res = await app().request(`${base}/graph`, { headers: { 'If-None-Match': 'W/"private-test"' } });
    expect(res.status).toBe(304); expect(mocks.graph).toHaveBeenCalledOnce();
    mocks.status = 404;
    expect((await app().request(`${base}/graph`, { headers: { 'If-None-Match': 'W/"private-test"' } })).status).toBe(404);
  });
  it.each(['/graph?limit=1001', '/graph?orgId=other', '/nodes?limit=201', '/nodes?health=green', '/graph?hops=3', `/health?nodeIds=not-a-uuid`, `/relationships/${REL}/evidence?limit=201`])('rejects invalid input %s', async (path) => {
    expect((await app().request(base + path)).status).toBe(400);
    expect(mocks.graph).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.health).not.toHaveBeenCalled(); expect(mocks.evidence).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])('blocks unauthorized reads with %s', async (status) => {
    mocks.status = status; expect((await app().request(`${base}/graph`)).status).toBe(status); expect(mocks.graph).not.toHaveBeenCalled();
  });
  it('preserves stable revision conflict and hidden subject error codes', async () => {
    mocks.expansion.mockRejectedValue(new GraphReadError('graph_revision_changed', 409, 'Graph changed'));
    const result = await app().request(`${base}/expansions/stale`);
    expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ code: 'graph_revision_changed' });
    mocks.evidence.mockRejectedValue(new GraphReadError('topology_subject_not_found', 404, 'Not found'));
    expect((await app().request(`${base}/relationships/${REL}/evidence`)).status).toBe(404);
  });
});
