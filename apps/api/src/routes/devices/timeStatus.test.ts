import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  device: vi.fn(),
  view: vi.fn(),
  denied: Symbol('denied'),
  status: 0,
  permissionDenied: false,
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (m.status === 401) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {});
    return next();
  },
  requireScope: () => async (c: any, next: any) =>
    m.status === 403 ? c.json({ error: 'Forbidden' }, 403) : next(),
  requirePermission: () => async (c: any, next: any) =>
    m.permissionDenied ? c.json({ error: 'Forbidden' }, 403) : next(),
}));
vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: m.device,
  SITE_ACCESS_DENIED: m.denied,
}));
vi.mock('../../services/timeSync/view', () => ({
  getDeviceTimeStatusView: m.view,
}));
import { timeStatusRoutes } from './timeStatus';
const id = '11111111-1111-4111-8111-111111111111';
const request = () => timeStatusRoutes.request(`/${id}/time-status`);
beforeEach(() => {
  m.status = 0;
  m.permissionDenied = false;
  m.device.mockReset().mockResolvedValue({ id });
  m.view.mockReset().mockResolvedValue({ deviceId: id, state: 'not_reported' });
});
it('returns the view including an ordinary not-reported state as 200', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    deviceId: id,
    state: 'not_reported',
  });
});
it.each([401, 403])('rejects unauthorized scope %s', async (status) => {
  m.status = status;
  expect((await request()).status).toBe(status);
  expect(m.view).not.toHaveBeenCalled();
});
it('checks DEVICES_READ before lookup', async () => {
  m.permissionDenied = true;
  expect((await request()).status).toBe(403);
  expect(m.device).not.toHaveBeenCalled();
  expect(m.view).not.toHaveBeenCalled();
});
it.each([
  [null, 404],
  [m.denied, 403],
])('blocks org/site-inaccessible device %s', async (value, status) => {
  m.device.mockResolvedValue(value);
  expect((await request()).status).toBe(status);
  expect(m.view).not.toHaveBeenCalled();
});
it('handles a device disappearing between authorization and read', async () => {
  m.view.mockResolvedValue(null);
  expect((await request()).status).toBe(404);
});
it('surfaces service errors', async () => {
  m.view.mockRejectedValue(new Error('database'));
  expect((await request()).status).toBe(500);
});
