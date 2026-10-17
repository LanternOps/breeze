import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  commandRows: [] as Array<{ id: string; batchId: string | null }>,
  selectWhere: vi.fn(),
  redisKeys: new Set<string>(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  audit: vi.fn(async () => {}),
  redisAvailable: true,
  record: vi.fn(),
  chatReply: vi.fn(),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => {
          h.selectWhere(cond);
          const limit = vi.fn(async () => h.commandRows);
          return { limit, orderBy: vi.fn(() => ({ limit })) };
        }),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  deviceCommands: { id: 'id', deviceId: 'deviceId', type: 'type', payload: 'payload', createdAt: 'createdAt' },
}));

vi.mock('../../services/redis', () => ({
  getRedis: () => (h.redisAvailable ? { set: h.redisSet, del: h.redisDel } : null),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEventAsync: h.audit,
}));

vi.mock('../../services/endpointMessaging/receipts', () => ({
  recordDeliveryEvent: h.record,
}));

vi.mock('../../services/endpointMessaging/chatReplies', () => ({
  recordChatReply: h.chatReply,
}));

vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => '203.0.113.7' }));

import { messageEventsRoutes } from './messageEvents';

type AgentCtx = { deviceId: string; orgId: string; agentId: string; role: string };

function buildApp(agent: AgentCtx): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent' as never, agent as never);
    await next();
  });
  app.route('/agents', messageEventsRoutes);
  return app;
}

const agentA: AgentCtx = { deviceId: DEVICE_A, orgId: ORG_A, agentId: 'agent-a', role: 'agent' };
const agentB: AgentCtx = { deviceId: DEVICE_B, orgId: ORG_B, agentId: 'agent-b', role: 'agent' };

const body = (over: Record<string, unknown> = {}) => ({
  messageId: MESSAGE_ID,
  batchId: BATCH_ID,
  eventType: 'acknowledged',
  session: { username: 'alice', sid: 'S-1-5-21-1' },
  at: '2026-12-27T10:00:00.000Z',
  ...over,
});

async function post(app: Hono, agentId: string, payload: unknown) {
  return app.request(`/agents/${agentId}/message-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('POST /agents/:id/message-events (#8741)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.commandRows = [{ id: 'cmd-1', batchId: BATCH_ID }];
    // Default: a pre-W2 message with no delivery row takes the W1 audit sink.
    h.record.mockResolvedValue({ found: false });
    h.redisKeys.clear();
    h.redisAvailable = true;
    h.redisSet.mockImplementation(async (key: string, _v: string, ..._rest: unknown[]) => {
      if (h.redisKeys.has(key)) return null;
      h.redisKeys.add(key);
      return 'OK';
    });
  });

  it('writes one audit row in the device org and reports duplicate:false', async () => {
    const res = await post(buildApp(agentA), 'agent-a', body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: false });
    expect(h.audit).toHaveBeenCalledTimes(1);
    const evt = (h.audit.mock.calls[0] as unknown as [unknown, Record<string, any>])[1];
    expect(evt).toMatchObject({
      orgId: ORG_A,
      action: 'endpoint_message.acknowledged',
      resourceType: 'endpoint_message',
      resourceId: MESSAGE_ID,
      actorType: 'agent',
      actorId: DEVICE_A,
    });
    expect(evt.details).toMatchObject({ messageId: MESSAGE_ID, batchId: BATCH_ID, deviceId: DEVICE_A, eventType: 'acknowledged' });
  });

  it('a duplicate event (same device/message/session/eventType) returns duplicate:true and writes nothing more', async () => {
    const app = buildApp(agentA);
    await post(app, 'agent-a', body());
    const res = await post(app, 'agent-a', body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('dedup key is endpoint-msg-event:{deviceId}:{messageId}:{sessionKey}:{eventType} with a 7 day NX expiry', async () => {
    await post(buildApp(agentA), 'agent-a', body());
    expect(h.redisSet).toHaveBeenCalledWith(
      `endpoint-msg-event:${DEVICE_A}:${MESSAGE_ID}:S-1-5-21-1:acknowledged`,
      '1', 'EX', 7 * 24 * 3600, 'NX',
    );
  });

  it('session key falls back sid -> winSessionId -> username', async () => {
    const app = buildApp(agentA);
    await post(app, 'agent-a', body({ session: { username: 'bob', winSessionId: 3 } }));
    await post(app, 'agent-a', body({ session: { username: 'carol' } }));
    const keys = h.redisSet.mock.calls.map((c) => c[0]);
    expect(keys).toContain(`endpoint-msg-event:${DEVICE_A}:${MESSAGE_ID}:3:acknowledged`);
    expect(keys).toContain(`endpoint-msg-event:${DEVICE_A}:${MESSAGE_ID}:carol:acknowledged`);
  });

  it('the same event from two different devices writes two rows (device id is part of the key)', async () => {
    await post(buildApp(agentA), 'agent-a', body());
    await post(buildApp(agentB), 'agent-b', body());
    expect(h.audit).toHaveBeenCalledTimes(2);
    const orgs = h.audit.mock.calls.map((c) => (c as unknown as [unknown, Record<string, unknown>])[1].orgId);
    expect(orgs).toEqual([ORG_A, ORG_B]);
  });

  it('404s a messageId that was never sent to this device and consumes no dedup key', async () => {
    h.commandRows = [];
    const res = await post(buildApp(agentA), 'agent-a', body());
    expect(res.status).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.redisSet).not.toHaveBeenCalled();
  });

  it('scopes the command lookup to the authenticated device, not anything in the body', async () => {
    await post(buildApp(agentA), 'agent-a', body({ deviceId: DEVICE_B, orgId: ORG_B }));
    const cond = JSON.stringify(h.selectWhere.mock.calls[0]?.[0] ?? null, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(cond).toContain(DEVICE_A);
    expect(cond).not.toContain(DEVICE_B);
  });

  it('device A cannot name device B org: the audit org is always the authenticated device org', async () => {
    await post(buildApp(agentA), 'agent-a', body({ orgId: ORG_B, deviceId: DEVICE_B }));
    const evt = (h.audit.mock.calls[0] as unknown as [unknown, Record<string, any>])[1];
    expect(evt.orgId).toBe(ORG_A);
    expect(evt.actorId).toBe(DEVICE_A);
    expect(JSON.stringify(evt)).not.toContain(ORG_B);
    expect(JSON.stringify(evt)).not.toContain(DEVICE_B);
  });

  it('records the batchId stored on the sent command, not the one the agent claims', async () => {
    const stored = '55555555-5555-4555-8555-555555555555';
    h.commandRows = [{ id: 'cmd-1', batchId: stored }];
    await post(buildApp(agentA), 'agent-a', body());
    const evt = (h.audit.mock.calls[0] as unknown as [unknown, Record<string, any>])[1];
    expect(evt.details.batchId).toBe(stored);
  });

  it('400s an invalid body (bad eventType, non-uuid messageId)', async () => {
    const app = buildApp(agentA);
    expect((await post(app, 'agent-a', body({ eventType: 'exploded' }))).status).toBe(400);
    expect((await post(app, 'agent-a', body({ messageId: 'nope' }))).status).toBe(400);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses a non-agent (watchdog) credential', async () => {
    const res = await post(buildApp({ ...agentA, role: 'watchdog' }), 'agent-a', body());
    expect(res.status).toBe(403);
  });

  it('503s when Redis is unavailable so the agent retries instead of double-writing', async () => {
    h.redisAvailable = false;
    const res = await post(buildApp(agentA), 'agent-a', body());
    expect(res.status).toBe(503);
    expect(h.audit).not.toHaveBeenCalled();
  });

  describe('W02 receipts sink (#8742)', () => {
    it('a message with a delivery row writes a receipt, not an audit row, and touches no Redis', async () => {
      h.record.mockResolvedValue({ found: true, inserted: true });
      const res = await post(buildApp(agentA), 'agent-a', body());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, duplicate: false });
      expect(h.record).toHaveBeenCalledWith({
        deviceId: DEVICE_A,
        commandId: 'cmd-1',
        batchId: BATCH_ID,
        messageId: MESSAGE_ID,
        sessionKey: 'S-1-5-21-1',
        sessionUsername: 'alice',
        eventType: 'acknowledged',
        occurredAt: new Date('2026-12-27T10:00:00.000Z'),
      });
      expect(h.audit).not.toHaveBeenCalled();
      expect(h.redisSet).not.toHaveBeenCalled();
    });

    it('a duplicate receipt (DB unique key) reports duplicate:true', async () => {
      h.record.mockResolvedValue({ found: true, inserted: false });
      const res = await post(buildApp(agentA), 'agent-a', body());
      expect(await res.json()).toEqual({ ok: true, duplicate: true });
      expect(h.audit).not.toHaveBeenCalled();
    });

    it('the receipt lookup uses the batch stored on the sent command, never the agent claim', async () => {
      const stored = '55555555-5555-4555-8555-555555555555';
      h.commandRows = [{ id: 'cmd-9', batchId: stored }];
      h.record.mockResolvedValue({ found: true, inserted: true });
      await post(buildApp(agentA), 'agent-a', body());
      expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ batchId: stored, commandId: 'cmd-9' }));
    });
  });
});

describe('POST /agents/:id/message-events chat_reply (#8743)', () => {
  const CONV = '55555555-5555-4555-8555-555555555555';
  const NONCE = '66666666-6666-4666-8666-666666666666';
  const reply = (over: Record<string, unknown> = {}) => ({
    eventType: 'chat_reply',
    conversationId: CONV,
    clientNonce: NONCE,
    body: '  Sure, go ahead.  ',
    session: { username: 'alice', sid: 'S-1-5-21-1', winSessionId: 1 },
    at: '2026-12-30T10:00:00.000Z',
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.chatReply.mockResolvedValue({ kind: 'accepted', duplicate: false });
  });

  it('records the reply against the AUTHENTICATED device, never one named in the body', async () => {
    const res = await post(buildApp(agentA), 'agent-a', reply({ deviceId: DEVICE_B }));
    // Unknown keys are refused outright (strict), so a forged deviceId never reaches the service.
    expect(res.status).toBe(400);
    expect(h.chatReply).not.toHaveBeenCalled();

    const ok = await post(buildApp(agentA), 'agent-a', reply());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, duplicate: false });
    expect(h.chatReply).toHaveBeenCalledWith({
      deviceId: DEVICE_A,
      conversationId: CONV,
      clientNonce: NONCE,
      body: 'Sure, go ahead.',
      session: { username: 'alice', sid: 'S-1-5-21-1', winSessionId: 1 },
    });
    // The W1/W2 message-event sinks are untouched by a chat reply.
    expect(h.record).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'accepted', duplicate: true }, 200, { ok: true, duplicate: true }],
    [{ kind: 'unknown_conversation' }, 404, { error: 'unknown_conversation' }],
    [{ kind: 'conversation_closed' }, 409, { error: 'conversation_closed' }],
    [{ kind: 'replies_disabled' }, 403, { error: 'replies_disabled' }],
    [{ kind: 'rate_limited', retryAfterSeconds: 9 }, 429, { error: 'rate_limited', retryAfterSeconds: 9 }],
  ])('maps %o to %s (the agent contract)', async (outcome, status, json) => {
    h.chatReply.mockResolvedValue(outcome);
    const res = await post(buildApp(agentA), 'agent-a', reply());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(json);
  });

  it('rejects an empty, oversize or malformed reply before the service', async () => {
    for (const bad of [
      reply({ body: '   ' }),
      reply({ body: 'x'.repeat(2001) }),
      reply({ clientNonce: 'not-a-uuid' }),
      reply({ conversationId: undefined }),
      reply({ session: { username: '' } }),
    ]) {
      expect((await post(buildApp(agentA), 'agent-a', bad)).status).toBe(400);
    }
    expect(h.chatReply).not.toHaveBeenCalled();
  });

  it('accepts a full-length reply of multi-byte characters', async () => {
    const res = await post(buildApp(agentA), 'agent-a', reply({ body: '\u{1F600}'.repeat(1000) }));
    expect(res.status).toBe(200);
  });
});
