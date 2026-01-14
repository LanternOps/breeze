import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: 'id',
    partnerId: 'partnerId'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123',
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c, next) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  })
}));

import { authMiddleware } from '../middleware/auth';

describe('webhook routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: 'org-123',
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    const { webhookRoutes } = await import('./webhooks');
    app = new Hono();
    app.route('/webhooks', webhookRoutes);
  });

  const baseWebhook = {
    name: 'Device Alerts',
    url: 'https://example.com/webhooks/device',
    secret: 'secret-123',
    events: ['device.created'],
    headers: [{ key: 'X-Test', value: '1' }]
  };

  async function createWebhook(overrides: Partial<typeof baseWebhook> = {}) {
    const res = await app.request('/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseWebhook, ...overrides })
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it('should create a webhook', async () => {
    const res = await app.request('/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseWebhook)
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.orgId).toBe('org-123');
    expect(body.secret).toBe('secret-123');
    expect(body.hasSecret).toBe(true);
  });

  it('should list webhooks with pagination', async () => {
    await createWebhook({ name: 'First Hook', url: 'https://example.com/1' });
    await createWebhook({ name: 'Second Hook', url: 'https://example.com/2' });

    const res = await app.request('/webhooks?page=1&limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
    expect(body.data[0].secret).toBeUndefined();
    expect(body.data[0].hasSecret).toBe(true);
  });

  it('should return webhook details with delivery stats', async () => {
    const webhook = await createWebhook();
    const deliveryRes = await app.request(`/webhooks/${webhook.id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(deliveryRes.status).toBe(202);

    const res = await app.request(`/webhooks/${webhook.id}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveryStats.total).toBe(1);
    expect(body.deliveryStats.delivered).toBe(1);
    expect(body.deliveryStats.lastDeliveredAt).toBeTruthy();
    expect(body.secret).toBeUndefined();
  });

  it('should update a webhook', async () => {
    const webhook = await createWebhook();
    const res = await app.request(`/webhooks/${webhook.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Hook', secret: 'new-secret' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated Hook');
    expect(body.secret).toBe('new-secret');
  });

  it('should delete a webhook and its deliveries', async () => {
    const webhook = await createWebhook();
    const deliveryRes = await app.request(`/webhooks/${webhook.id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const deliveryBody = await deliveryRes.json();

    const res = await app.request(`/webhooks/${webhook.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const getRes = await app.request(`/webhooks/${webhook.id}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(getRes.status).toBe(404);

    const deliveriesRes = await app.request(`/webhooks/${webhook.id}/deliveries`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(deliveriesRes.status).toBe(404);

    const retryRes = await app.request(`/webhooks/${webhook.id}/retry/${deliveryBody.delivery.id}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(retryRes.status).toBe(404);
  });

  it('should list deliveries and enforce delivery status rules', async () => {
    const webhook = await createWebhook();
    const deliveryRes = await app.request(`/webhooks/${webhook.id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const deliveryBody = await deliveryRes.json();

    const res = await app.request(`/webhooks/${webhook.id}/deliveries?status=delivered`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].status).toBe('delivered');

    const retryRes = await app.request(`/webhooks/${webhook.id}/retry/${deliveryBody.delivery.id}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(retryRes.status).toBe(400);
  });
});
