import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONV = '11111111-1111-4111-8111-111111111111';
const DEV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const h = vi.hoisted(() => ({
  open: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  audit: vi.fn(),
  gates: [] as Array<{ route: string; resource: string; action: string }>,
  mfa: 0,
  principal: { kind: 'user_session' } as { kind: string },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => {
    h.mfa += 1;
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
  requirePermission: (resource: string, action: string) => {
    h.gates.push({ route: '', resource, action });
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
}));
vi.mock('../../services/endpointMessaging/chat', () => ({
  openEndpointChat: h.open,
  sendEndpointChatMessage: h.send,
  closeEndpointChat: h.close,
}));
vi.mock('../../services/endpointMessaging/chatReads', () => ({
  findConversationForCaller: h.find,
  listDeviceConversations: h.list,
  readConversationMessages: h.read,
  conversationView: (row: Record<string, unknown>) => ({ id: row.id, status: row.status }),
}));
vi.mock('../../services/auditEvents', () => ({ writeAuditEventAsync: h.audit }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import { conversationRoutes } from './conversations';

const gatesAtImport = [...h.gates];
const mfaAtImport = h.mfa;

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth' as never, { principal: h.principal, user: { id: 'u1', email: 'tech@example.test', name: 'Sam' } } as never);
    await next();
  });
  a.route('/endpoint-messages/conversations', conversationRoutes);
  return a;
}

const post = (path: string, body?: unknown) => app().request(`/endpoint-messages/conversations${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const get = (path: string) => app().request(`/endpoint-messages/conversations${path}`);

const conversation = { id: CONV, orgId: ORG, deviceId: DEV, status: 'opening', allowUserReply: true };

describe('endpoint chat routes (#8743)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.principal = { kind: 'user_session' };
  });

  it('gates writes on endpoint_messages:send + MFA and reads on endpoint_messages:read', () => {
    const writes = gatesAtImport.filter((g) => g.action === 'send');
    const reads = gatesAtImport.filter((g) => g.action === 'read');
    expect(writes).toHaveLength(3);
    expect(reads).toHaveLength(2);
    expect(gatesAtImport.every((g) => g.resource === 'endpoint_messages')).toBe(true);
    expect(mfaAtImport).toBe(3);
  });

  it('open: 202 with the conversation, one audit row with a hash and length but never the body', async () => {
    h.open.mockResolvedValue({ ok: true, status: 202, replay: false, conversation, messages: [], deviceOrgId: ORG, bodySha256: 'f'.repeat(64) });
    const res = await post('', { conversationId: CONV, deviceId: DEV, body: 'Secret plan for Friday' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ conversation, messages: [] });
    expect(h.audit).toHaveBeenCalledTimes(1);
    const event = h.audit.mock.calls[0]![1];
    expect(event).toMatchObject({ orgId: ORG, action: 'endpoint_chat.open', resourceId: CONV, details: { bodySha256: 'f'.repeat(64), bodyLength: 22 } });
    expect(JSON.stringify(event)).not.toContain('Secret plan');
  });

  it('open replay (same client id) is 200 and not re-audited', async () => {
    h.open.mockResolvedValue({ ok: true, status: 200, replay: true, conversation, messages: [], deviceOrgId: ORG, bodySha256: 'x' });
    const res = await post('', { conversationId: CONV, deviceId: DEV, body: 'hi' });
    expect(res.status).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'device_not_found'],
    [409, 'platform_unsupported'],
    [409, 'agent_unsupported'],
    [409, 'device_offline'],
    [409, 'conversation_active'],
    [403, 'feature_disabled'],
    [429, 'rate_limited'],
  ])('open maps a %s %s refusal through unchanged', async (status, error) => {
    h.open.mockResolvedValue({ ok: false, status, body: { error } });
    const res = await post('', { conversationId: CONV, deviceId: DEV, body: 'hi' });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('a live chat is a person typing: API keys, OAuth grants and agents are refused before the service runs', async () => {
    for (const kind of ['api_key', 'oauth_grant', 'agent', 'client_user']) {
      h.principal = { kind };
      expect((await post('', { conversationId: CONV, deviceId: DEV, body: 'hi' })).status).toBe(403);
      expect((await post(`/${CONV}/messages`, { messageId: MSG, body: 'hi' })).status).toBe(403);
    }
    expect(h.open).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('rejects a ticket binding, an unsafe body or an unknown key at validation', async () => {
    expect((await post('', { conversationId: CONV, deviceId: DEV, body: 'hi', ticketId: CONV })).status).toBe(400);
    expect((await post('', { conversationId: CONV, deviceId: DEV, body: '<script>x</script>' })).status).toBe(400);
    expect((await post(`/${CONV}/messages`, { messageId: MSG, body: '[x](http://evil.example)' })).status).toBe(400);
    expect((await post(`/${CONV}/messages`, { messageId: MSG, body: 'hi', senderName: 'CEO' })).status).toBe(400);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('message: 201 on create, 200 on an idempotent retry, refusals pass through, and messages are not audited', async () => {
    const message = { id: 'm', direction: 'to_user', body: 'hi' };
    h.send.mockResolvedValueOnce({ ok: true, status: 201, message });
    expect((await post(`/${CONV}/messages`, { messageId: MSG, body: 'hi' })).status).toBe(201);
    h.send.mockResolvedValueOnce({ ok: true, status: 200, message });
    expect((await post(`/${CONV}/messages`, { messageId: MSG, body: 'hi' })).status).toBe(200);
    h.send.mockResolvedValueOnce({ ok: false, status: 409, body: { error: 'conversation_not_open' } });
    expect((await post(`/${CONV}/messages`, { messageId: MSG, body: 'hi' })).status).toBe(409);
    expect(h.send.mock.calls[0]![1]).toBe(CONV);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('close: audited once with counts only; an already-closed chat is 200 and not re-audited', async () => {
    h.close.mockResolvedValueOnce({ ok: true, alreadyClosed: false, conversation: { ...conversation, status: 'closed' }, counts: { toUser: 3, fromUser: 2 }, agentNotified: true });
    const res = await post(`/${CONV}/close`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyClosed: false, agentNotified: true });
    expect(h.audit.mock.calls[0]![1]).toMatchObject({
      action: 'endpoint_chat.close',
      details: { messagesToUser: 3, messagesFromUser: 2, reason: 'technician', agentNotified: true },
    });
    h.close.mockResolvedValueOnce({ ok: true, alreadyClosed: true, conversation, counts: null, agentNotified: false });
    expect((await post(`/${CONV}/close`)).status).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('close is allowed for any principal that holds the permission (no operator content)', async () => {
    h.principal = { kind: 'api_key' };
    h.close.mockResolvedValue({ ok: true, alreadyClosed: true, conversation, counts: null, agentNotified: false });
    expect((await post(`/${CONV}/close`)).status).toBe(200);
  });

  it('GET /:id is 404 when the caller cannot see it, and passes a valid since cursor through', async () => {
    h.find.mockResolvedValueOnce(null);
    expect((await get(`/${CONV}`)).status).toBe(404);
    expect(h.read).not.toHaveBeenCalled();
    h.find.mockResolvedValueOnce({ conversation: { id: CONV, status: 'open' }, openedByName: null });
    h.read.mockResolvedValueOnce([]);
    const res = await get(`/${CONV}?since=2026-12-30T10:00:00.000Z`);
    expect(res.status).toBe(200);
    expect(h.read.mock.calls[0]![1]).toEqual(new Date('2026-12-30T10:00:00.000Z'));
    expect((await get(`/${CONV}?since=yesterday`)).status).toBe(400);
  });

  it('GET / requires a device id', async () => {
    expect((await get('')).status).toBe(400);
    h.list.mockResolvedValueOnce([]);
    expect((await get(`?deviceId=${DEV}`)).status).toBe(200);
  });
});

describe('a chat never grants remote access (#8743 plan Task 3.3)', () => {
  it('no chat module imports or writes consent', () => {
    const files = [
      'routes/endpointMessages/conversations.ts',
      'services/endpointMessaging/chat.ts',
      'services/endpointMessaging/chatStore.ts',
      'services/endpointMessaging/chatReads.ts',
      'services/endpointMessaging/chatReplies.ts',
      'services/endpointMessaging/chatResults.ts',
    ];
    for (const f of files) {
      const src = readFileSync(join(__dirname, '..', '..', f), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/consent/i);
    }
  });
});
