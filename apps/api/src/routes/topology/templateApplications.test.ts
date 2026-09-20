import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({
  permissions: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  status: vi.fn(),
}));
vi.mock('../../services/permissions', async (original) => ({
  ...(await original<object>()),
  getUserPermissions: mocks.permissions,
}));
vi.mock('../../services/topology/templateApply', () => ({
  previewTopologyTemplateApplication: mocks.preview,
  applyTopologyTemplatePreview: mocks.apply,
  getTopologyTemplateApplication: mocks.status,
}));
import { topologyTemplateApplicationRoutes } from './templateApplications';
import { TopologyOperationError } from '../../services/topology/operationErrors';
const id = '00000000-0000-4000-8000-000000000001';
const cases = [
  {
    method: 'POST',
    path: '/template-applications/preview',
    body: {
      partnerVersionId: null,
      orgVersionId: null,
      sites: [{ siteId: id, expectedBindingRevision: '0' }],
    },
    mock: mocks.preview,
    status: 200,
  },
  {
    method: 'POST',
    path: '/template-applications',
    body: { token: 'opaque' },
    mock: mocks.apply,
    status: 202,
  },
  {
    method: 'GET',
    path: `/template-applications/${id}`,
    body: undefined,
    mock: mocks.status,
    status: 200,
  },
];
function app(auth = true) {
  const app = new Hono();
  if (auth)
    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id, email: 'operator@example.test' },
        scope: 'organization',
      } as never);
      await next();
    });
  app.route('/', topologyTemplateApplicationRoutes);
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissions.mockResolvedValue({ permissions: [] });
  for (const item of cases) item.mock.mockResolvedValue({ id });
});
for (const item of cases)
  describe(`${item.method} ${item.path}`, () => {
    const request = () => ({
      method: item.method,
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'same-intent',
      },
      body: item.body ? JSON.stringify(item.body) : undefined,
    });
    it('requires authentication and resolved permissions', async () => {
      expect((await app(false).request(item.path, request())).status).toBe(401);
      mocks.permissions.mockResolvedValue(null);
      expect((await app().request(item.path, request())).status).toBe(403);
      expect(item.mock).not.toHaveBeenCalled();
    });
    it('returns the real service result privately', async () => {
      const response = await app().request(item.path, request());
      expect(response.status).toBe(item.status);
      expect(await response.json()).toEqual({ id });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    });
    it.each([403, 404, 409, 503] as const)(
      'surfaces stable failure %s without success',
      async (status) => {
        item.mock.mockRejectedValue(
          new TopologyOperationError('permission_changed', status),
        );
        const response = await app().request(item.path, request());
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({
          code: 'permission_changed',
        });
      },
    );
  });
it('rejects malformed/duplicate/oversized site selection before calling service', async () => {
  for (const sites of [
    [],
    [{ siteId: 'bad', expectedBindingRevision: '0' }],
    [
      { siteId: id, expectedBindingRevision: '0' },
      { siteId: id, expectedBindingRevision: '0' },
    ],
    Array.from({ length: 501 }, () => ({
      siteId: id,
      expectedBindingRevision: '0',
    })),
  ]) {
    expect(
      (
        await app().request('/template-applications/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            partnerVersionId: null,
            orgVersionId: null,
            sites,
          }),
        })
      ).status,
    ).toBe(400);
  }
  expect(mocks.preview).not.toHaveBeenCalled();
});
