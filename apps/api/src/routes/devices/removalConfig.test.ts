import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'] });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../../services/deviceUninstallDrain', () => ({
  DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS: 72,
}));

import { removalConfigRoutes } from './removalConfig';

describe('GET /devices/removal-config', () => {
  it('returns the configured uninstall drain window in hours', async () => {
    const app = new Hono().route('/devices', removalConfigRoutes);
    const res = await app.request('/devices/removal-config', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uninstallDrainWindowHours: 72 });
  });
});
