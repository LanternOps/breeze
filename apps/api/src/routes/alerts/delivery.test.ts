import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ authenticated: true, read: true, preview: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    if (!state.authenticated) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', { scope: 'organization' });
    await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    if (!state.read) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
}));
vi.mock('../../services/delivery/describeDelivery', () => ({ previewDelivery: state.preview }));
import { deliveryRoutes } from './delivery';
import { DeliveryWriteError } from '../../services/delivery/routingRuleWrites';
const ORG = '11111111-1111-4111-8111-111111111111';
const app = new Hono().route('/alerts', deliveryRoutes);
const path = `/alerts/delivery/resolve?orgId=${ORG}&severity=critical&kind=cpu`;
beforeEach(() => {
  vi.clearAllMocks(); state.authenticated = true; state.read = true;
  state.preview.mockResolvedValue({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null,
    source: 'none', display: 'Critical → Inbox only (no delivery row)',
    description: { channels: [], escalationPolicy: null, owner: null } });
});
describe('GET /alerts/delivery/resolve', () => {
  it('returns the resolver result and display without an envelope or mutation', async () => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: 'none', channelIds: [], display: expect.stringContaining('Inbox only') });
    expect(state.preview).toHaveBeenCalledWith({ orgId: ORG, severity: 'critical', kind: 'cpu' }, { scope: 'organization' });
  });
  it.each(['', '?severity=high', `?orgId=${ORG}`, `?orgId=${ORG}&severity=urgent`,
    `?orgId=${ORG}&severity=high&kind=unknown`, `?orgId=${ORG}&severity=high&siteId=bad`, `?orgId=${ORG}&severity=high&monitorId=bad`,
    `?orgId=${ORG}&severity=high&legacyOverride=override`])('rejects invalid query %s', async (query) => {
    expect((await app.request('/alerts/delivery/resolve' + query)).status).toBe(400);
    expect(state.preview).not.toHaveBeenCalled();
  });
  it('requires authentication and read permission', async () => {
    state.authenticated = false;
    expect((await app.request(path)).status).toBe(401);
    state.authenticated = true; state.read = false;
    expect((await app.request(path)).status).toBe(403);
    expect(state.preview).not.toHaveBeenCalled();
  });
  it.each([403, 404] as const)('preserves access errors (%s)', async (status) => {
    state.preview.mockRejectedValue(new DeliveryWriteError(status, 'Not available'));
    expect((await app.request(path)).status).toBe(status);
  });
  it('returns a safe 500 when resolution fails', async () => {
    state.preview.mockRejectedValue(new Error('database detail'));
    const res = await app.request(path);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('database detail');
  });
});
