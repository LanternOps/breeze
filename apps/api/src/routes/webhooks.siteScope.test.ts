import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, queueDeliveryMock, validateWebhookUrlSafetyWithDnsMock } = vi.hoisted(() => ({
  authRef: { current: {} as any },
  queueDeliveryMock: vi.fn(),
  validateWebhookUrlSafetyWithDnsMock: vi.fn(),
}));

vi.mock('../workers/webhookDelivery', () => ({
  getWebhookWorker: vi.fn(() => ({ queueDelivery: queueDeliveryMock })),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../services/notificationSenders/webhookSender', () => ({
  validateWebhookUrlSafetyWithDns: validateWebhookUrlSafetyWithDnsMock,
  redactUrlForLogs: (rawUrl: string) => rawUrl,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  webhooks: {
    id: 'id', orgId: 'orgId', status: 'status', createdAt: 'createdAt',
    successCount: 'successCount', failureCount: 'failureCount',
  },
  webhookDeliveries: {
    id: 'id', webhookId: 'webhookId', status: 'status', deliveredAt: 'deliveredAt', createdAt: 'createdAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';
import { webhookRoutes } from './webhooks';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const WEBHOOK_ID = '22222222-2222-2222-2222-222222222222';
const DELIVERY_ID = '44444444-4444-4444-4444-444444444444';

function baseAuth(allowedSiteIds: string[] | undefined) {
  return {
    scope: 'organization',
    partnerId: null,
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    user: { id: 'user-123', email: 'test@example.com' },
  };
}

function app() {
  const instance = new Hono();
  instance.route('/webhooks', webhookRoutes);
  return instance;
}

describe('webhook routes site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateWebhookUrlSafetyWithDnsMock.mockResolvedValue([]);
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST /webhooks is denied with 403 and never inserts', async (_label, allowedSiteIds) => {
    authRef.current = baseAuth(allowedSiteIds);
    const res = await app().request('/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wh', url: 'https://example.com/hook', secret: 'shh12345', events: ['device.offline'] }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('restricted caller: PATCH /webhooks/:id is denied with 403 before any read', async () => {
    authRef.current = baseAuth(['s1']);
    const res = await app().request(`/webhooks/${WEBHOOK_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('restricted caller: DELETE /webhooks/:id is denied with 403 before any read', async () => {
    authRef.current = baseAuth(['s1']);
    const res = await app().request(`/webhooks/${WEBHOOK_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /webhooks/:id/test is denied with 403 before any read', async () => {
    authRef.current = baseAuth(['s1']);
    const res = await app().request(`/webhooks/${WEBHOOK_ID}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(queueDeliveryMock).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /webhooks/:id/retry/:deliveryId is denied with 403 before any read', async () => {
    authRef.current = baseAuth(['s1']);
    const res = await app().request(`/webhooks/${WEBHOOK_ID}/retry/${DELIVERY_ID}`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(queueDeliveryMock).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: POST /webhooks still validates URL and proceeds to insert', async () => {
    authRef.current = baseAuth(undefined);
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: WEBHOOK_ID, orgId: ORG_ID, name: 'wh', events: [] }])),
      })),
    });
    const res = await app().request('/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wh', url: 'https://example.com/hook', secret: 'shh12345', events: ['device.offline'] }),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('partner-scope caller with allowedSiteIds set is NOT affected by this gate (orthogonal to partner-wide breadth)', async () => {
    authRef.current = {
      scope: 'partner',
      partnerId: 'partner-1',
      orgId: null,
      accessibleOrgIds: [ORG_ID],
      allowedSiteIds: ['s1'],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      user: { id: 'user-123', email: 'test@example.com' },
    };
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: WEBHOOK_ID, orgId: ORG_ID, name: 'wh', events: [] }])),
      })),
    });
    const res = await app().request('/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, name: 'wh', url: 'https://example.com/hook', secret: 'shh12345', events: ['device.offline'] }),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
