import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({
  getPermissions: vi.fn(),
  site: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  versions: vi.fn(),
  draft: vi.fn(),
  publish: vi.fn(),
  options: vi.fn(),
}));
vi.mock('../../services/permissions', async (original) => ({
  ...(await original<object>()),
  getUserPermissions: mocks.getPermissions,
}));
vi.mock('../../services/topology/templateLibrary', async (original) => ({
  ...(await original<object>()),
  listTopologyTemplates: mocks.list,
  createTopologyTemplate: mocks.create,
  updateTopologyTemplate: mocks.update,
  listTopologyTemplateVersions: mocks.versions,
  createTopologyTemplateVersion: mocks.draft,
  publishTopologyTemplateVersion: mocks.publish,
  listEligibleTopologyVersions: mocks.options,
}));
vi.mock('./middleware', () => ({
  requireTopologySiteCapability: () => mocks.site,
}));
import { topologyTemplateRoutes } from './templates';
import { TopologyOperationError } from '../../services/topology/operationErrors';
const id = '00000000-0000-4000-8000-000000000001';
const routes = [
  {
    method: 'GET',
    path: '/templates?ownerScope=organization',
    mock: () => mocks.list,
  },
  {
    method: 'POST',
    path: '/templates',
    body: { ownerScope: 'organization', key: 'office', name: 'Office' },
    mock: () => mocks.create,
  },
  {
    method: 'PATCH',
    path: `/templates/${id}`,
    body: { expectedRevision: '1', name: 'Updated' },
    mock: () => mocks.update,
  },
  {
    method: 'GET',
    path: `/templates/${id}/versions`,
    mock: () => mocks.versions,
  },
  {
    method: 'POST',
    path: `/templates/${id}/versions`,
    body: {
      expectedRevision: '1',
      schemaVersion: 1,
      defaultsVersion: 1,
      resolverVersion: 1,
      payload: { targets: {}, policies: {} },
    },
    mock: () => mocks.draft,
  },
  {
    method: 'POST',
    path: `/templates/${id}/versions/${id}/publish`,
    body: { expectedTemplateRevision: '2', expectedVersionRevision: '1' },
    mock: () => mocks.publish,
  },
];
function app(auth = true) {
  const a = new Hono();
  if (auth)
    a.use('*', async (c, next) => {
      c.set('auth', {
        user: { id, email: 'user@example.test' },
        scope: 'organization',
      } as never);
      await next();
    });
  return a.route('/topology', topologyTemplateRoutes);
}
function request(r: (typeof routes)[number], body = r.body, authorized = true) {
  return app(authorized).request(`/topology${r.path}`, {
    method: r.method,
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }
      : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPermissions.mockResolvedValue({ permissions: [] });
  for (const r of routes)
    r.mock().mockResolvedValue({ items: [], nextCursor: null });
  mocks.site.mockImplementation(async (c, next) => {
    c.set('topologyContext', { scope: { siteId: id } });
    await next();
  });
  mocks.options.mockResolvedValue({ items: [], nextCursor: null });
});
describe('template library HTTP boundary', () => {
  it.each(routes)('$method $path rejects missing auth', async (r) => {
    expect((await request(r, r.body, false)).status).toBe(401);
    expect(r.mock()).not.toHaveBeenCalled();
  });
  it.each(routes)(
    '$method $path rejects absent permission context',
    async (r) => {
      mocks.getPermissions.mockResolvedValue(null);
      expect((await request(r)).status).toBe(403);
      expect(r.mock()).not.toHaveBeenCalled();
    },
  );
  it.each(routes)('$method $path returns successful result', async (r) =>
    expect((await request(r)).status).toBe(
      r.method === 'POST' && !r.path.endsWith('/publish') ? 201 : 200,
    ),
  );
  it.each(routes)(
    '$method $path maps forbidden/not found/revision conflicts',
    async (r) => {
      for (const status of [403, 404, 409] as const) {
        r.mock().mockRejectedValue(
          new TopologyOperationError('scope_or_revision_changed', status),
        );
        const response = await request(r);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({
          code: 'scope_or_revision_changed',
        });
      }
    },
  );
  it.each(routes.filter((r) => r.body))(
    '$method $path rejects invalid mutation bodies',
    async (r) => {
      expect((await request(r, { unexpected: true } as never)).status).toBe(
        400,
      );
      expect(r.mock()).not.toHaveBeenCalled();
    },
  );
  it('rejects cursor and pagination bounds before service reads', async () => {
    expect(
      (
        await app().request(
          '/topology/templates?ownerScope=organization&limit=201',
        )
      ).status,
    ).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('allows site selection without library permission middleware and forwards paging', async () => {
    const response = await app().request(
      `/topology/sites/${id}/template-options?limit=1&cursor=${id}`,
    );
    expect(response.status).toBe(200);
    expect(mocks.getPermissions).not.toHaveBeenCalled();
    expect(mocks.options).toHaveBeenCalledWith(
      { scope: { siteId: id } },
      { limit: 1, cursor: id },
    );
  });
  it('does not hide unexpected service failures behind success envelopes', async () => {
    mocks.list.mockRejectedValue(new Error('database offline'));
    expect((await request(routes[0]!)).status).toBe(500);
  });
});
