import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const queueDeliveryMock = vi.fn();

vi.mock('../workers/webhookDelivery', () => ({
  getWebhookWorker: vi.fn(() => ({
    queueDelivery: queueDeliveryMock
  }))
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  webhooks: {
    id: 'id',
    orgId: 'orgId',
    status: 'status',
    createdAt: 'createdAt',
    successCount: 'successCount',
    failureCount: 'failureCount'
  },
  webhookDeliveries: {
    id: 'id',
    webhookId: 'webhookId',
    status: 'status',
    deliveredAt: 'deliveredAt',
    createdAt: 'createdAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { webhookRoutes } from './webhooks';

function mockSelectLimit(result: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(result))
      }))
    }))
  };
}

function mockSelectWhere(result: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(result))
    }))
  };
}

function mockSelectOrderLimit(result: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(result))
        }))
      }))
    }))
  };
}

function mockSelectList(result: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => ({
            offset: vi.fn(() => Promise.resolve(result))
          }))
        }))
      }))
    }))
  };
}

describe('webhook routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: '11111111-1111-1111-1111-111111111111',
        accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
        canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });

    app = new Hono();
    app.route('/webhooks', webhookRoutes);
  });

  it('creates a webhook with secret metadata', async () => {
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{
          id: 'webhook-1',
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'Device Alerts',
          url: 'https://example.com/webhooks/device',
          secret: 'secret-123',
          events: ['device.created'],
          headers: [{ key: 'X-Test', value: '1' }],
          status: 'active',
          createdBy: 'user-123',
          createdAt: new Date('2026-02-07T13:00:00.000Z'),
          updatedAt: new Date('2026-02-07T13:00:00.000Z'),
          lastDeliveryAt: null
        }]))
      }))
    } as any);

    const res = await app.request('/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Device Alerts',
        url: 'https://example.com/webhooks/device',
        secret: 'secret-123',
        events: ['device.created'],
        headers: [{ key: 'X-Test', value: '1' }]
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('webhook-1');
    expect(body.hasSecret).toBe(true);
    expect(body.secret).toBe('secret-123');
  });

  it('rejects unsafe webhook URLs', async () => {
    const res = await app.request('/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Unsafe Hook',
        url: 'http://127.0.0.1/webhook',
        secret: 'secret-123',
        events: ['device.created']
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid webhook URL');
  });

  it('lists webhooks with pagination', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectWhere([{ count: 2 }]) as any)
      .mockReturnValueOnce(mockSelectList([
        {
          id: 'webhook-1',
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'First',
          url: 'https://example.com/1',
          secret: 'secret-a',
          events: ['device.created'],
          headers: [],
          status: 'active',
          createdBy: 'user-123',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastDeliveryAt: null
        },
        {
          id: 'webhook-2',
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'Second',
          url: 'https://example.com/2',
          secret: null,
          events: ['alert.triggered'],
          headers: [],
          status: 'disabled',
          createdBy: 'user-123',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastDeliveryAt: null
        }
      ]) as any);

    const res = await app.request('/webhooks?page=1&limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
    expect(body.data[0].secret).toBeUndefined();
    expect(body.data[1].status).toBe('paused');
  });

  it('queues a test webhook delivery and persists pending delivery row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(mockSelectLimit([
      {
        id: 'webhook-1',
        orgId: '11111111-1111-1111-1111-111111111111',
        name: 'Device Alerts',
        url: 'https://example.com/webhook',
        secret: 'secret-123',
        events: ['device.created'],
        headers: [{ key: 'X-Test', value: '1' }],
        status: 'active',
        createdBy: 'user-123',
        createdAt: new Date(),
        updatedAt: new Date(),
        lastDeliveryAt: null,
        retryPolicy: null
      }
    ]) as any);

    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{
          id: 'delivery-1',
          webhookId: 'webhook-1',
          eventType: 'webhook.test',
          eventId: 'event-1',
          payload: { test: true },
          status: 'pending',
          attempts: 0,
          responseStatus: null,
          responseBody: null,
          nextRetryAt: null,
          createdAt: new Date(),
          deliveredAt: null,
          errorMessage: null,
          responseTimeMs: null
        }]))
      }))
    } as any);

    queueDeliveryMock.mockResolvedValueOnce('delivery-1');

    const res = await app.request('/webhooks/webhook-1/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ payload: { test: true } })
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.message).toBe('Test delivery queued');
    expect(body.delivery.status).toBe('pending');
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
  });

  it('rejects retry when delivery is not failed', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectLimit([
        {
          id: 'webhook-1',
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'Device Alerts',
          url: 'https://example.com/webhook',
          secret: 'secret-123',
          events: ['device.created'],
          headers: [],
          status: 'active',
          createdBy: 'user-123',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastDeliveryAt: null,
          retryPolicy: null
        }
      ]) as any)
      .mockReturnValueOnce(mockSelectLimit([
        {
          id: 'delivery-1',
          webhookId: 'webhook-1',
          eventType: 'device.created',
          eventId: 'evt-1',
          payload: {},
          status: 'delivered',
          attempts: 1,
          responseStatus: 200,
          responseBody: 'ok',
          nextRetryAt: null,
          createdAt: new Date(),
          deliveredAt: new Date()
        }
      ]) as any);

    const res = await app.request('/webhooks/webhook-1/retry/delivery-1', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Only failed deliveries can be retried');
  });
});
