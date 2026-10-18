import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROW = '77777777-7777-4777-8777-777777777777';
const NEW_ID = '88888888-8888-4888-8888-888888888888';
const DEV = '0d000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  targets: vi.fn(),
  send: vi.fn(),
  requirePermission: vi.fn(),
  requireMfa: vi.fn(),
  reaches: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => h.rows }) }) }) }),
  },
}));
vi.mock('../../db/schema', () => ({ endpointMessages: { id: 'id', orgId: 'orgId' } }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => {
    h.requireMfa();
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
  requirePermission: (resource: string, action: string) => {
    h.requirePermission(resource, action);
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
}));
vi.mock('../../services/endpointMessaging/history', () => ({ resendTargets: h.targets, messageReachesAllowedSites: h.reaches }));
vi.mock('./send', () => ({ executeEndpointMessageSend: h.send }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import { resendRoutes } from './resend';

const gateCalls = h.requirePermission.mock.calls.map((c) => [...c]);
const mfaCalls = h.requireMfa.mock.calls.length;

let perms: unknown;
const auth = {
  user: { id: 'u1', email: 'tech@example.test' },
  orgCondition: () => undefined,
  canAccessOrg: (id: string) => id === ORG_A,
};

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth' as never, auth as never);
    c.set('permissions' as never, perms as never);
    await next();
  });
  a.route('/endpoint-messages', resendRoutes);
  return a;
}

const post = (body: unknown = { messageId: NEW_ID }) => app().request(`/endpoint-messages/${ROW}/resend`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const stored = (over: Record<string, unknown> = {}) => ({
  id: ROW,
  orgId: ORG_A,
  title: 'Reboot tonight',
  body: 'Please save your work.',
  severity: 'warning',
  requiresAck: true,
  createdAt: new Date('2026-12-01T10:00:00Z'),
  expiresAt: new Date('2026-12-01T11:00:00Z'),
  retractedAt: null,
  bodyPurgedAt: null,
  ...over,
});

describe('POST /endpoint-messages/:id/resend (#8742)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.rows = [stored()];
    h.targets.mockResolvedValue([DEV]);
    h.reaches.mockResolvedValue(true);
    h.send.mockResolvedValue({ status: 200, body: { batchId: 'b', deviceCount: 1, results: [] } });
  });

  it('needs the send permission and MFA, like a send', () => {
    expect(gateCalls).toContainEqual(['endpoint_messages', 'send']);
    expect(mfaCalls).toBeGreaterThan(0);
  });

  it('resends the STORED content to failed/expired devices as a new send linked to the original', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.send).toHaveBeenCalledTimes(1);
    const [ctx, input] = h.send.mock.calls[0]!;
    expect(ctx).toMatchObject({ resendOfId: ROW });
    expect(input).toEqual({
      messageId: NEW_ID,
      targets: { deviceIds: [DEV] },
      title: 'Reboot tonight',
      body: 'Please save your work.',
      severity: 'warning',
      requiresAck: true,
      expiresInMinutes: 60,
      confirmedCount: 1,
    });
  });

  it('refuses a retracted message (409) and a purged one (409) without sending', async () => {
    h.rows = [stored({ retractedAt: new Date() })];
    expect((await post()).status).toBe(409);
    h.rows = [stored({ bodyPurgedAt: new Date(), title: null, body: null })];
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'body_purged' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('400 nothing_to_resend when every device was reached', async () => {
    h.targets.mockResolvedValue([]);
    const res = await post();
    expect(res.status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('404s a message in an org the caller cannot access', async () => {
    h.rows = [stored({ orgId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })];
    expect((await post()).status).toBe(404);
    h.rows = [];
    expect((await post()).status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('site scope (#9014): 404s, with no target lookup and no send, when no delivery is in the caller sites', async () => {
    perms = { allowedSiteIds: ['5a000000-0000-4000-8000-00000000000a'] };
    h.reaches.mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(404);
    expect(h.reaches).toHaveBeenCalledWith(ROW, perms);
    expect(h.targets).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    h.reaches.mockResolvedValue(true);
    expect((await post()).status).toBe(200);
    perms = undefined;
  });

  it('rejects a body that tries to supply content', async () => {
    const res = await post({ messageId: NEW_ID, body: 'injected' });
    expect(res.status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });
});
