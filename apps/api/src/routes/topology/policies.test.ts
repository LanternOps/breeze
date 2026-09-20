import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  status: 200,
}));
vi.mock('../../services/topology/configurationObjects', async (original) => ({
  ...(await original<object>()),
  listTopologyConfigurationObjects: mocks.list,
  upsertTopologyMonitoringPolicy: mocks.upsert,
  deleteTopologyConfigurationObject: mocks.remove,
}));
vi.mock('./middleware', () => ({
  requireTopologySiteCapability: () => async (c: any, next: any) => {
    if (mocks.status !== 200) return c.json({ error: 'Denied' }, mocks.status);
    c.set('topologyContext', { scope: { siteId: c.req.param('siteId') } });
    await next();
  },
}));
import { topologyPolicyRoutes } from './policies';
import { TopologyOperationError } from '../../services/topology/operationErrors';
const id = '00000000-0000-4000-8000-000000000001';
const definition = {
  kind: 'policy',
  enabled: false,
  recipeId: 'target_connectivity',
  recipeVersion: 1,
  subject: 'configured_target',
  targetKeys: [],
  families: ['ipv4'],
  origin: 'eligible_collector',
  intervalSeconds: 300,
  jitterPercent: 10,
  alertsEnabled: false,
  failureThreshold: 3,
  recoveryThreshold: 2,
};
function request(method: string, body?: unknown, query = '') {
  return new Hono()
    .route('/topology', topologyPolicyRoutes)
    .request(
      `/topology/sites/${id}/policies${method === 'PATCH' || method === 'DELETE' ? '/' + id : ''}${query}`,
      {
        method,
        ...(body && method !== 'GET'
          ? {
              body: JSON.stringify(body),
              headers: { 'Content-Type': 'application/json' },
            }
          : {}),
      },
    );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = 200;
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.upsert.mockResolvedValue({ id, revision: '2' });
  mocks.remove.mockResolvedValue({ success: true });
});
describe('policies routes', () => {
  it.each(['GET', 'POST', 'PATCH', 'DELETE'])(
    '%s enforces unauthenticated/forbidden/hidden site',
    async (method) => {
      for (const status of [401, 403, 404]) {
        mocks.status = status;
        expect(
          (
            await request(method, {
              expectedRevision: '1',
              key: 'app',
              definition,
            })
          ).status,
        ).toBe(status);
      }
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    },
  );
  it('GET pages scoped rows', async () => {
    expect((await request('GET', undefined, '?limit=10')).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(
      { scope: { siteId: id } },
      'policies',
      { limit: 10 },
    );
  });
  it.each(['POST', 'PATCH'])(
    '%s validates and writes an explicit definition',
    async (method) => {
      expect(
        (
          await request(method, {
            expectedRevision: '1',
            key: 'app',
            definition,
          })
        ).status,
      ).toBe(method === 'POST' ? 201 : 200);
      expect(mocks.upsert).toHaveBeenCalled();
    },
  );
  it('DELETE requires a revision and preserves service errors', async () => {
    expect((await request('DELETE', { expectedRevision: '1' })).status).toBe(
      200,
    );
    mocks.remove.mockRejectedValue(
      new TopologyOperationError('target_in_use', 409),
    );
    expect((await request('DELETE', { expectedRevision: '1' })).status).toBe(
      409,
    );
  });
  it.each(['POST', 'PATCH', 'DELETE'])(
    '%s rejects malformed inputs before any write',
    async (method) => {
      expect((await request(method, { unexpected: true })).status).toBe(400);
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    },
  );
  it.each([400, 403, 404, 409, 503] as const)(
    'surfaces service error %i',
    async (status) => {
      mocks.upsert.mockRejectedValue(
        new TopologyOperationError('configuration_failed', status),
      );
      const response = await request('POST', {
        expectedRevision: '1',
        key: 'app',
        definition,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        code: 'configuration_failed',
      });
    },
  );
});
