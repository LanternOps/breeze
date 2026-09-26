import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({ createNode: vi.fn(), updateNode: vi.fn(), deleteNode: vi.fn(), createRelationship: vi.fn(), deleteRelationship: vi.fn(), status: 200 }));
vi.mock('../../services/topology/manual', async () => ({ ...await vi.importActual<typeof import('../../services/topology/manual')>('../../services/topology/manual'),
  createTopologyManualNode: mocks.createNode, updateTopologyManualNode: mocks.updateNode, deleteTopologyManualNode: mocks.deleteNode,
  createTopologyManualRelationship: mocks.createRelationship, deleteTopologyManualRelationship: mocks.deleteRelationship }));
vi.mock('./middleware', () => ({ requireTopologySiteCapability: () => async (c: any, next: any) => {
  if (mocks.status !== 200) return c.json({ error: 'Denied' }, mocks.status);
  c.set('topologyContext', { scope: { orgId: '11111111-1111-4111-8111-111111111111', siteId: c.req.param('siteId') } }); return next();
} }));
vi.mock('../../db', () => ({ db: {}, withDbTransaction: vi.fn(), assertInTransaction: vi.fn() }));
vi.mock('../../services/topology/legacyImport', () => ({ drainTopologyOutbox: vi.fn() }));
import { topologyManualRoutes } from './manual';
import { TopologyWriteError } from '../../services/topology/writes';
const site = '22222222-2222-4222-8222-222222222222'; const id = '33333333-3333-4333-8333-333333333333'; const second = '44444444-4444-4444-8444-444444444444';
const app = () => new Hono().route('/topology', topologyManualRoutes);
const request = (method: string, path: string, body: unknown) => app().request(`/topology/sites/${site}/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => { mocks.status = 200; for (const fn of [mocks.createNode, mocks.updateNode, mocks.deleteNode, mocks.createRelationship, mocks.deleteRelationship]) fn.mockReset().mockResolvedValue({ id, legacyId: second, revision: '2', graphRevision: '3' }); });
describe('manual topology routes', () => {
  it.each([
    ['POST', 'manual-nodes', { label: 'Router', role: 'router' }, 201],
    ['PATCH', `manual-nodes/${id}`, { label: 'Renamed', expectedRevision: '1' }, 200],
    ['DELETE', `manual-nodes/${id}`, { expectedRevision: '1' }, 200],
    ['POST', 'manual-relationships', { sourceNodeId: id, targetNodeId: second, kind: 'attachment' }, 201],
    ['DELETE', `manual-relationships/${id}`, { expectedRevision: '1' }, 200],
  ] as const)('%s %s preserves canonical and legacy identities', async (method, path, body, status) => {
    const response = await request(method, path, body); expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ id, legacyId: second });
  });
  it.each([401, 403, 404])('does not execute on auth/site failure %s', async status => { mocks.status = status; expect((await request('POST', 'manual-nodes', { label: 'x', role: 'router' })).status).toBe(status); expect(mocks.createNode).not.toHaveBeenCalled(); });
  it.each([{ label: '', role: 'router' }, { label: 'x', role: 'router', orgId: id }, { label: 'x', role: 'observed' }])('rejects invalid create input', async body => { expect((await request('POST', 'manual-nodes', body)).status).toBe(400); expect(mocks.createNode).not.toHaveBeenCalled(); });
  it('requires exact revision on mutable v2 requests', async () => {
    expect((await request('DELETE', `manual-nodes/${id}`, {})).status).toBe(400);
    expect((await request('PATCH', `manual-nodes/${id}`, { label: 'x', expectedRevision: '9223372036854775808' })).status).toBe(400);
  });
  it('surfaces missing references and CAS errors without success envelopes', async () => {
    mocks.deleteNode.mockRejectedValue(new TopologyWriteError('topology_entity_not_found', 404, 'Not found'));
    expect((await request('DELETE', `manual-nodes/${id}`, { expectedRevision: '1' })).status).toBe(404);
    mocks.updateNode.mockRejectedValue(new TopologyWriteError('topology_revision_conflict', 409, 'Refresh', { currentRevision: '2', affectedIds: [id] }));
    expect((await request('PATCH', `manual-nodes/${id}`, { label: 'x', expectedRevision: '1' })).status).toBe(409);
  });
  it('passes interface bindings to the scoped service and hides a foreign interface as 404', async () => {
    const created = await request('POST', 'manual-relationships', { sourceNodeId: id, targetNodeId: second, kind: 'physical_link', sourceInterfaceId: id, targetInterfaceId: second });
    expect(created.status).toBe(201);
    expect(mocks.createRelationship).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'physical_link', sourceInterfaceId: id, targetInterfaceId: second }));
    mocks.createRelationship.mockRejectedValue(new TopologyWriteError('topology_entity_not_found', 404, 'Topology entity not found'));
    const response = await request('POST', 'manual-relationships', { sourceNodeId: id, targetNodeId: second, kind: 'attachment', sourceInterfaceId: id });
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'topology_entity_not_found' });
    expect((await request('POST', 'manual-relationships', { sourceNodeId: id, targetNodeId: second, kind: 'physical_link', evidenceClass: 'observed' })).status).toBe(400);
  });
});
