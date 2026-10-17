/**
 * Endpoint live chat W03 (#8743) against real Postgres: the open / message /
 * close service, the chat command-result handlers, the agent reply ingest and
 * the caller-scoped reads. Command dispatch, settings, branding and the Redis
 * limiters are injected (ChatDeps), so this file proves the SQL and the state
 * machine, not the transport.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { endpointConversationMessages, endpointConversations } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  closeEndpointChat,
  openEndpointChat,
  sendEndpointChatMessage,
  type ChatDeps,
} from '../../services/endpointMessaging/chat';
import { handleChatMessageResult, handleChatOpenResult } from '../../services/endpointMessaging/chatResults';
import { recordChatReply } from '../../services/endpointMessaging/chatReplies';
import { findConversationForCaller, listDeviceConversations, readConversationMessages } from '../../services/endpointMessaging/chatReads';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
}
const asOrg = <T>(orgId: string, partnerId: string, fn: () => Promise<T>) =>
  runOutsideDbContext(() => withDbAccessContext(orgCtx(orgId, partnerId), fn));

function fakeAuth(userId: string, orgId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'tech@example.test', name: 'Sam Tech', isPlatformAdmin: false },
    scope: 'organization',
    orgId,
    partnerId: null,
    accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn): SQL | undefined => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

interface Dispatched { deviceId: string; type: string; payload: Record<string, unknown>; options: Record<string, unknown> }

function fakeDeps(over: Partial<ChatDeps> = {}) {
  const dispatched: Dispatched[] = [];
  const deps: Partial<ChatDeps> = {
    dispatch: async (deviceId, type, payload, options) => {
      dispatched.push({ deviceId, type, payload, options });
      return { command: { id: randomUUID() } as never, delivery: 'delivered' };
    },
    chatSettings: async () => ({ enabled: true, allowUserReply: true }),
    branding: async () => ({ partnerId: 'p', branding: { companyName: 'Acme IT', displayName: 'Acme IT' } }),
    openLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    messageLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    ...over,
  };
  return { deps, dispatched };
}

interface Fixture { partnerId: string; orgA: string; orgB: string; siteA: string; siteA2: string; devA: string; devA2: string; devB: string; devMac: string; userId: string }

async function seed(): Promise<Fixture> {
  const partnerId = (await createPartner()).id;
  const orgA = (await createOrganization({ partnerId })).id;
  const orgB = (await createOrganization({ partnerId })).id;
  const siteA = (await createSite({ orgId: orgA }))!.id;
  const siteA2 = (await createSite({ orgId: orgA }))!.id;
  const siteB = (await createSite({ orgId: orgB }))!.id;
  const devA = (await createDevice({ orgId: orgA, siteId: siteA })).id;
  const devA2 = (await createDevice({ orgId: orgA, siteId: siteA2 })).id;
  const devB = (await createDevice({ orgId: orgB, siteId: siteB })).id;
  const devMac = (await createDevice({ orgId: orgA, siteId: siteA })).id;
  await getTestDb().execute(sql`UPDATE devices SET agent_version = '999.0.0', status = 'online' WHERE id IN (${devA}::uuid, ${devA2}::uuid, ${devB}::uuid, ${devMac}::uuid)`);
  await getTestDb().execute(sql`UPDATE devices SET os_type = 'macos' WHERE id = ${devMac}::uuid`);
  const userId = (await createUser({ partnerId, orgId: orgA, email: `chat-${randomUUID()}@ec.test` })).id;
  return { partnerId, orgA, orgB, siteA, siteA2, devA, devA2, devB, devMac, userId };
}

const opened = (f: Fixture, conversationId = randomUUID(), deviceId = f.devA) => ({ conversationId, deviceId, body: 'Hi, this is IT. Got a minute?' });

async function openAndConfirm(f: Fixture, auth: AuthContext) {
  const { deps, dispatched } = fakeDeps();
  const outcome = await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, opened(f)));
  if (!outcome.ok) throw new Error(`open failed: ${outcome.body.error}`);
  const cmd = dispatched[0]!;
  await asOrg(f.orgA, f.partnerId, () => handleChatOpenResult({
    command: { payload: cmd.payload } as never,
    commandId: randomUUID(),
    resolvedDeviceId: f.devA,
    result: { status: 'completed' },
    stdout: JSON.stringify({ delivered: true, surface: 'assist', username: 'alice', winSessionId: 1 }),
  } as never));
  return outcome.conversation.id;
}

const conv = (id: string) => sys(async () => (await db.select().from(endpointConversations).where(eq(endpointConversations.id, id)))[0]);
const msgs = (id: string) => sys(() => db.select().from(endpointConversationMessages).where(eq(endpointConversationMessages.conversationId, id)));

describe('endpoint chat flow (real Postgres)', () => {
  let f: Fixture;
  let auth: AuthContext;
  beforeEach(async () => {
    f = await seed();
    auth = fakeAuth(f.userId, f.orgA);
  });

  it('open persists an opening conversation + first message BEFORE dispatching a live, top-level-keyed chat_open', async () => {
    let rowsAtDispatch = -1;
    const { deps, dispatched } = fakeDeps({
      dispatch: async (deviceId, type, payload, options) => {
        // The rows must already be committed: a fast agent result reads them.
        rowsAtDispatch = (await msgs(payload.conversationId as string)).length;
        dispatched.push({ deviceId, type, payload, options });
        return { command: { id: randomUUID() } as never, delivery: 'delivered' };
      },
    });
    const input = opened(f);
    const out = await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, input));
    expect(out).toMatchObject({ ok: true, status: 202, conversation: { id: input.conversationId, status: 'opening', allowUserReply: true } });
    expect(rowsAtDispatch).toBe(1);
    expect(dispatched).toHaveLength(1);
    const cmd = dispatched[0]!;
    expect(cmd.type).toBe('chat_open');
    expect(cmd.options).toMatchObject({ expectedOrgId: f.orgA, offlinePolicy: { kind: 'reject' } });
    const [first] = await msgs(input.conversationId);
    expect(cmd.payload).toMatchObject({
      conversationId: input.conversationId,
      chatMessageId: first!.id,
      allowUserReply: true,
      branding: { companyName: 'Acme IT' },
      message: { messageId: first!.id, body: input.body, senderName: 'Sam Tech' },
    });
    expect(first).toMatchObject({ direction: 'to_user', senderUserId: f.userId, clientNonce: input.conversationId });
    expect((await conv(input.conversationId))?.openCommandId).toBeTruthy();
  });

  it('snapshots allowUserReply=false from the device settings at open', async () => {
    const { deps, dispatched } = fakeDeps({ chatSettings: async () => ({ enabled: true, allowUserReply: false }) });
    const out = await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, opened(f)));
    expect(out).toMatchObject({ ok: true, conversation: { allowUserReply: false } });
    expect(dispatched[0]!.payload.allowUserReply).toBe(false);
  });

  it('a retry with the same conversation id replays without a second dispatch', async () => {
    const { deps, dispatched } = fakeDeps();
    const input = opened(f);
    await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, input));
    const again = await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, input));
    expect(again).toMatchObject({ ok: true, status: 200, replay: true });
    expect(dispatched).toHaveLength(1);
    expect(await msgs(input.conversationId)).toHaveLength(1);
  });

  it('refuses a second live chat on the same device with the existing id', async () => {
    const { deps } = fakeDeps();
    const first = opened(f);
    await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, first));
    const second = await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, opened(f)));
    expect(second).toMatchObject({ ok: false, status: 409, body: { error: 'conversation_active', conversationId: first.conversationId } });
  });

  it('another org\'s device, or a site the caller cannot reach, is device_not_found and writes nothing', async () => {
    const { deps, dispatched } = fakeDeps();
    const foreign = opened(f, randomUUID(), f.devB);
    expect(await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, foreign)))
      .toMatchObject({ ok: false, status: 404, body: { error: 'device_not_found' } });
    const siteBlocked = opened(f, randomUUID(), f.devA2);
    expect(await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, permissions: { allowedSiteIds: [f.siteA] }, deps }, siteBlocked)))
      .toMatchObject({ ok: false, status: 404, body: { error: 'device_not_found' } });
    expect(dispatched).toHaveLength(0);
    expect(await conv(foreign.conversationId)).toBeUndefined();
    expect(await conv(siteBlocked.conversationId)).toBeUndefined();
  });

  it('refuses non-Windows, old agents, offline devices and a disabled rollout flag before creating anything', async () => {
    const { deps, dispatched } = fakeDeps();
    const mac = opened(f, randomUUID(), f.devMac);
    expect(await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, mac))).toMatchObject({ body: { error: 'platform_unsupported' } });

    await getTestDb().execute(sql`UPDATE devices SET agent_version = '0.123.0' WHERE id = ${f.devA}::uuid`);
    expect(await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, opened(f)))).toMatchObject({ body: { error: 'agent_unsupported' } });
    await getTestDb().execute(sql`UPDATE devices SET agent_version = '999.0.0', status = 'offline' WHERE id = ${f.devA}::uuid`);
    expect(await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, opened(f)))).toMatchObject({ body: { error: 'device_offline' } });
    await getTestDb().execute(sql`UPDATE devices SET status = 'online' WHERE id = ${f.devA}::uuid`);

    const off = fakeDeps({ chatSettings: async () => ({ enabled: false, allowUserReply: true }) });
    expect(await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps: off.deps }, opened(f))))
      .toMatchObject({ ok: false, status: 403, body: { error: 'feature_disabled' } });
    expect(dispatched).toHaveLength(0);
    expect(off.dispatched).toHaveLength(0);
    expect(await sys(() => db.select().from(endpointConversations).where(eq(endpointConversations.orgId, f.orgA)))).toEqual([]);
  });

  it('a refused dispatch fails the conversation and frees the device for a new chat', async () => {
    const offline = fakeDeps({ dispatch: async () => ({ error: 'Device is offline' }) });
    const input = opened(f);
    const out = await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps: offline.deps }, input));
    expect(out).toMatchObject({ ok: false, status: 409, body: { error: 'device_offline' } });
    expect(await conv(input.conversationId)).toMatchObject({ status: 'failed', errorCode: 'device_offline' });
    const { deps } = fakeDeps();
    expect(await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, opened(f)))).toMatchObject({ ok: true, status: 202 });
  });

  it('a chat_open result opens the conversation with the attested user; a failure records the agent code', async () => {
    const id = await openAndConfirm(f, auth);
    expect(await conv(id)).toMatchObject({ status: 'open', targetUsername: 'alice', winSessionId: 1 });
    expect((await msgs(id))[0]?.deliveredAt).toBeInstanceOf(Date);

    // Another device's result for that conversation changes nothing.
    await sys(() => db.update(endpointConversations).set({ status: 'closed' }).where(eq(endpointConversations.id, id)));
    const { deps, dispatched } = fakeDeps();
    const second = opened(f);
    await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, second));
    await asOrg(f.orgA, f.partnerId, () => handleChatOpenResult({
      command: { payload: dispatched[0]!.payload } as never, commandId: randomUUID(), resolvedDeviceId: f.devA2,
      result: { status: 'completed' }, stdout: '{}',
    } as never));
    expect(await conv(second.conversationId)).toMatchObject({ status: 'opening' });
    await asOrg(f.orgA, f.partnerId, () => handleChatOpenResult({
      command: { payload: dispatched[0]!.payload } as never, commandId: randomUUID(), resolvedDeviceId: f.devA,
      result: { status: 'failed', error: 'chat_requires_assist' },
    } as never));
    expect(await conv(second.conversationId)).toMatchObject({ status: 'failed', errorCode: 'chat_requires_assist' });
  });

  it('a technician who closed the chat while it was opening keeps it closed when the open result arrives', async () => {
    const { deps, dispatched } = fakeDeps();
    const input = opened(f);
    await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, input));
    await asOrg(f.orgA, f.partnerId, () => closeEndpointChat({ auth, deps }, input.conversationId));
    await asOrg(f.orgA, f.partnerId, () => handleChatOpenResult({
      command: { payload: dispatched[0]!.payload } as never, commandId: randomUUID(), resolvedDeviceId: f.devA,
      result: { status: 'completed' }, stdout: '{"username":"alice"}',
    } as never));
    expect(await conv(input.conversationId)).toMatchObject({ status: 'closed', closeReason: 'technician' });
  });

  it('messages: only into an open chat, idempotent per client id, delivered/failed by the chat_message result', async () => {
    const { deps, dispatched } = fakeDeps();
    const input = opened(f);
    await asOrg(f.orgA, f.partnerId, () => openEndpointChat({ auth, deps }, input));
    const early = await asOrg(f.orgA, f.partnerId, () => sendEndpointChatMessage({ auth, deps }, input.conversationId, { messageId: randomUUID(), body: 'too early' }));
    expect(early).toMatchObject({ ok: false, status: 409, body: { error: 'conversation_not_open' } });

    const id = input.conversationId;
    await asOrg(f.orgA, f.partnerId, () => handleChatOpenResult({
      command: { payload: dispatched[0]!.payload } as never, commandId: randomUUID(), resolvedDeviceId: f.devA,
      result: { status: 'completed' }, stdout: '{}',
    } as never));
    const clientId = randomUUID();
    const sent = await asOrg(f.orgA, f.partnerId, () => sendEndpointChatMessage({ auth, deps }, id, { messageId: clientId, body: 'Please restart Outlook.' }));
    expect(sent).toMatchObject({ ok: true, status: 201, message: { direction: 'to_user', body: 'Please restart Outlook.', senderName: 'Sam Tech' } });
    const retry = await asOrg(f.orgA, f.partnerId, () => sendEndpointChatMessage({ auth, deps }, id, { messageId: clientId, body: 'Please restart Outlook.' }));
    expect(retry).toMatchObject({ ok: true, status: 200 });
    const chatMessages = dispatched.filter((d) => d.type === 'chat_message');
    expect(chatMessages).toHaveLength(1);
    expect(chatMessages[0]!.payload).toMatchObject({ conversationId: id, allowUserReply: true, message: { body: 'Please restart Outlook.' } });

    await asOrg(f.orgA, f.partnerId, () => handleChatMessageResult({
      command: { payload: chatMessages[0]!.payload } as never, commandId: randomUUID(), resolvedDeviceId: f.devA,
      result: { status: 'failed', error: 'chat_window_failed' },
    } as never));
    const row = (await msgs(id)).find((m) => m.clientNonce === clientId)!;
    expect(row).toMatchObject({ errorCode: 'chat_window_failed', deliveredAt: null });
    await asOrg(f.orgA, f.partnerId, () => handleChatMessageResult({
      command: { payload: chatMessages[0]!.payload } as never, commandId: randomUUID(), resolvedDeviceId: f.devA,
      result: { status: 'completed' },
    } as never));
    expect((await msgs(id)).find((m) => m.clientNonce === clientId)).toMatchObject({ errorCode: null });
  });

  it('switching the rollout flag off stops a chat mid-flight', async () => {
    const id = await openAndConfirm(f, auth);
    const off = fakeDeps({ chatSettings: async () => ({ enabled: false, allowUserReply: true }) });
    expect(await asOrg(f.orgA, f.partnerId, () => sendEndpointChatMessage({ auth, deps: off.deps }, id, { messageId: randomUUID(), body: 'x' })))
      .toMatchObject({ ok: false, status: 403, body: { error: 'feature_disabled' } });
    expect(off.dispatched).toHaveLength(0);
  });

  it('close is idempotent and tells the agent once', async () => {
    const id = await openAndConfirm(f, auth);
    const { deps, dispatched } = fakeDeps();
    const first = await asOrg(f.orgA, f.partnerId, () => closeEndpointChat({ auth, deps }, id));
    expect(first).toMatchObject({ ok: true, alreadyClosed: false, counts: { toUser: 1, fromUser: 0 }, conversation: { status: 'closed', closeReason: 'technician' } });
    const second = await asOrg(f.orgA, f.partnerId, () => closeEndpointChat({ auth, deps }, id));
    expect(second).toMatchObject({ ok: true, alreadyClosed: true });
    expect(dispatched.map((d) => d.type)).toEqual(['chat_close']);
    expect(dispatched[0]!.payload).toEqual({ conversationId: id, reason: 'technician' });
    expect(await conv(id)).toMatchObject({ closedBy: f.userId });
  });

  it('user replies: attested, deduped by nonce, refused for another device, a closed chat or replies off', async () => {
    const id = await openAndConfirm(f, auth);
    const session = { username: 'alice', sid: 'S-1-5-21-1', winSessionId: 1 };
    const nonce = randomUUID();
    const reply = (over: Partial<Parameters<typeof recordChatReply>[0]> = {}) => asOrg(f.orgA, f.partnerId, () => recordChatReply({
      deviceId: f.devA, conversationId: id, clientNonce: nonce, body: 'Sure, go ahead.', session, ...over,
    }, async () => ({ allowed: true, retryAfterSeconds: 0 })));

    expect(await reply()).toEqual({ kind: 'accepted', duplicate: false });
    expect(await reply()).toEqual({ kind: 'accepted', duplicate: true });
    expect(await reply({ clientNonce: randomUUID() })).toEqual({ kind: 'accepted', duplicate: false });
    const fromUser = (await msgs(id)).filter((m) => m.direction === 'from_user');
    expect(fromUser).toHaveLength(2);
    expect(fromUser[0]).toMatchObject({ senderSession: session, senderUserId: null, body: 'Sure, go ahead.' });

    expect(await reply({ deviceId: f.devA2, clientNonce: randomUUID() })).toEqual({ kind: 'unknown_conversation' });
    expect(await asOrg(f.orgA, f.partnerId, () => recordChatReply(
      { deviceId: f.devA, conversationId: id, clientNonce: randomUUID(), body: 'x', session },
      async () => ({ allowed: false, retryAfterSeconds: 30 }),
    ))).toEqual({ kind: 'rate_limited', retryAfterSeconds: 30 });
    expect((await msgs(id)).filter((m) => m.direction === 'from_user')).toHaveLength(2);

    await sys(() => db.update(endpointConversations).set({ allowUserReply: false }).where(eq(endpointConversations.id, id)));
    expect(await reply({ clientNonce: randomUUID() })).toEqual({ kind: 'replies_disabled' });
    await sys(() => db.update(endpointConversations).set({ status: 'closed' }).where(eq(endpointConversations.id, id)));
    expect(await reply({ clientNonce: randomUUID() })).toEqual({ kind: 'conversation_closed' });
  });

  it('reads are caller-scoped: org B and a site-restricted caller see nothing; since filters the transcript', async () => {
    const id = await openAndConfirm(f, auth);
    const authB = fakeAuth(f.userId, f.orgB);
    expect(await asOrg(f.orgB, f.partnerId, () => findConversationForCaller({ auth: authB, conversationId: id }))).toBeNull();
    expect(await asOrg(f.orgA, f.partnerId, () => findConversationForCaller({ auth, permissions: { allowedSiteIds: [f.siteA2] }, conversationId: id }))).toBeNull();
    expect(await asOrg(f.orgA, f.partnerId, () => listDeviceConversations({ auth, permissions: { allowedSiteIds: [f.siteA2] }, deviceId: f.devA }))).toEqual([]);

    const list = await asOrg(f.orgA, f.partnerId, () => listDeviceConversations({ auth, deviceId: f.devA }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, status: 'open', openedBy: { id: f.userId } });

    const all = await asOrg(f.orgA, f.partnerId, () => readConversationMessages(id));
    expect(all).toHaveLength(1);
    const after = await asOrg(f.orgA, f.partnerId, () => readConversationMessages(id, new Date(all[0]!.createdAt)));
    expect(after).toEqual([]);
  });
});
