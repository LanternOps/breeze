import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({ save: vi.fn(), status: 200, capability: vi.fn() }));
vi.mock('../../services/topology/layouts', () => ({ saveTopologyLayout: mocks.save }));
vi.mock('./middleware', () => ({ requireTopologySiteCapability: mocks.capability.mockImplementation(() => async (c: any, next: any) => {
  if (mocks.status !== 200) return c.json({ error: 'Denied' }, mocks.status);
  c.set('topologyContext', { scope: { orgId: '11111111-1111-4111-8111-111111111111', siteId: c.req.param('siteId') } }); return next();
}) }));
vi.mock('../../db', () => ({ db: {}, withDbTransaction: vi.fn(), assertInTransaction: vi.fn() }));
vi.mock('../../services/topology/legacyImport', () => ({ drainTopologyOutbox: vi.fn() }));
import { topologyLayoutRoutes } from './layouts';
import { TopologyWriteError } from '../../services/topology/writes';
import { readTopologyMutationBody } from './mutations';
const siteId = '22222222-2222-4222-8222-222222222222';
const nodeId = '33333333-3333-4333-8333-333333333333';
const body = { expectedRevision: '7', positions: [{ nodeId, x: 1, y: 2, pinned: false }] };
const app = () => new Hono().route('/topology', topologyLayoutRoutes);
const request = (value: unknown = body, view = 'overview') => app().request(`/topology/sites/${siteId}/layouts/${view}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
beforeEach(() => { mocks.status = 200; mocks.save.mockReset().mockResolvedValue({ siteId, view: 'overview', layoutRevision: '8', positions: [] }); });
describe('revisioned topology layout route', () => {
  it('requires write capability and forwards explicit unpin with coordinates', async () => {
    expect((await request()).status).toBe(200);
    expect(mocks.capability).toHaveBeenCalledWith('write');
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ siteId }) }), 'overview', body);
  });
  it.each([401, 403, 404])('does not mutate denied or hidden site (%s)', async status => { mocks.status = status; expect((await request()).status).toBe(status); expect(mocks.save).not.toHaveBeenCalled(); });
  it.each([{ ...body, expectedRevision: '9223372036854775808' }, { ...body, orgId: siteId }, { ...body, positions: [{ nodeId, x: 1000001, y: 2, pinned: true }] }])('rejects invalid inputs before service', async value => { expect((await request(value)).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled(); });
  it('rejects unknown view and malformed JSON', async () => { expect((await request(body, 'cable')).status).toBe(400); expect((await app().request(`/topology/sites/${siteId}/layouts/overview`, { method: 'PATCH', body: '{' })).status).toBe(400); });
  it('reports revision conflict with current revision and affected nodes', async () => { mocks.save.mockRejectedValue(new TopologyWriteError('topology_revision_conflict', 409, 'Refresh', { currentRevision: '8', affectedIds: [nodeId] })); const response = await request(); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ currentRevision: '8', affectedIds: [nodeId] }); });
  it('rejects oversized bytes before JSON.parse without Content-Length', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    await expect(readTopologyMutationBody(new Request('http://localhost', { method: 'PATCH', body: ' '.repeat(262145) }))).rejects.toMatchObject({ status: 413 });
    expect(parse).not.toHaveBeenCalled(); parse.mockRestore();
  });
  it('does not trust a short Content-Length', async () => { await expect(readTopologyMutationBody(new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Length': '1' }, body: ' '.repeat(262145) }))).rejects.toMatchObject({ status: 413 }); });
});
