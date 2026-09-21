import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  status: 200,
}));
vi.mock('../../services/topology/siteSettings', () => ({
  readTopologySiteSettings: mocks.read,
}));
vi.mock('../../services/topology/siteConfiguration', () => ({
  updateTopologySiteConfiguration: mocks.update,
}));
vi.mock('./middleware', () => ({
  requireTopologySiteCapability: () => async (c: any, next: any) => {
    if (mocks.status !== 200) return c.json({ error: 'Denied' }, mocks.status);
    c.set('topologyContext', { scope: { siteId: c.req.param('siteId') } });
    await next();
  },
}));
import { topologySettingsRoutes } from './settings';
import { TopologyOperationError } from '../../services/topology/operationErrors';
const id = '00000000-0000-4000-8000-000000000001';
function request(method = 'GET', body?: unknown) {
  return new Hono()
    .route('/topology', topologySettingsRoutes)
    .request(`/topology/sites/${id}/settings`, {
      method,
      ...(body && method !== 'GET'
        ? {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }
        : {}),
    });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = 200;
  mocks.read.mockResolvedValue({ siteId: id, settingsRevision: '2' });
  mocks.update.mockResolvedValue({});
});
describe('site settings HTTP boundary', () => {
  it('GET is passive and private', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('PATCH compiles validated overrides and returns current settings', async () => {
    const response = await request('PATCH', {
      expectedRevision: '1',
      overrides: { passive: { enabled: false }, targets: {}, policies: {} },
    });
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      { scope: { siteId: id } },
      { passive: { enabled: false }, targets: {}, policies: {} },
      '1',
    );
    expect(await response.json()).toEqual({
      siteId: id,
      settingsRevision: '2',
    });
  });
  it.each([401, 403, 404])(
    'rejects access status %i for both methods',
    async (status) => {
      mocks.status = status;
      for (const method of ['GET', 'PATCH'])
        expect(
          (await request(method, { expectedRevision: '1', overrides: {} }))
            .status,
        ).toBe(status);
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { expectedRevision: '-1', overrides: {} },
    { expectedRevision: '1', overrides: { credentials: 'secret' } },
  ])('rejects invalid PATCH %j', async (body) => {
    expect((await request('PATCH', body)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409, 503] as const)(
    'surfaces mutation failure %i',
    async (status) => {
      mocks.update.mockRejectedValue(
        new TopologyOperationError('configuration_changed', status),
      );
      const response = await request('PATCH', {
        expectedRevision: '1',
        overrides: {},
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        code: 'configuration_changed',
      });
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );
});
