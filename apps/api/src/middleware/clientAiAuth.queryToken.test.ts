import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { redisMock, getRedisMock, dbSelectMock } = vi.hoisted(() => {
  const redis = {
    get: vi.fn(),
    del: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  return { redisMock: redis, getRedisMock: vi.fn(() => redis), dbSelectMock: vi.fn() };
});

vi.mock('../db', () => ({
  db: { select: dbSelectMock },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../services/redis', () => ({ getRedis: getRedisMock }));
vi.mock('../services/clientAiPolicy', () => ({
  getOrgPolicy: vi.fn(),
  isClientUserPermitted: vi.fn(() => true),
}));

import { clientAiAuthMiddleware } from './clientAiAuth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PORTAL_USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK';

const USER_ROW = {
  id: PORTAL_USER_ID, orgId: ORG_ID, email: 'finance.user@contoso.com',
  name: 'Finance User', status: 'active', partnerAiForOfficeEnabled: true,
};

function buildApp() {
  const app = new Hono();
  app.use('*', clientAiAuthMiddleware);
  app.get('/events', (c) => c.json({ clientUserId: c.get('clientAiAuth').clientUserId }));
  app.post('/messages', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock);
  redisMock.get.mockResolvedValue(
    JSON.stringify({ portalUserId: PORTAL_USER_ID, orgId: ORG_ID, createdAt: new Date().toISOString() }),
  );
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([USER_ROW])) })),
        })),
      })),
    })),
  }));
});

describe('clientAiAuthMiddleware — ?token= query fallback (SSE/EventSource)', () => {
  it('authenticates a GET via ?token= when no Authorization header is present', async () => {
    const res = await buildApp().request(`/events?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientUserId: PORTAL_USER_ID });
    expect(redisMock.get).toHaveBeenCalledWith(`clientai:session:${TOKEN}`);
  });

  it('the Authorization header wins over a conflicting ?token=', async () => {
    await buildApp().request(`/events?token=query-token`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(redisMock.get).toHaveBeenCalledWith(`clientai:session:${TOKEN}`);
  });

  it('does NOT accept ?token= on non-GET requests', async () => {
    const res = await buildApp().request(`/messages?token=${TOKEN}`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('still 401s a GET with neither header nor query token', async () => {
    const res = await buildApp().request('/events');
    expect(res.status).toBe(401);
  });
});
