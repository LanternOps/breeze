/**
 * Endpoint live chat (#8743, W03 of #8740; refs #8292): technician-opened
 * ad-hoc chat with the person at one Windows device, delivered to the Assist
 * helper in the console session. Owner-approved scope: technician-initiated
 * only, no ticket binding, no user-initiated chat, no non-Windows chat, no AI
 * chat. A chat NEVER grants remote access: nothing here writes or reads a
 * consent record (pinned by chat.test.ts).
 *
 * Every entry point first proves the caller may reach the device under the
 * request's RLS context (plus the site axis), then writes in its own system
 * transaction (chatStore.ts) and only then dispatches the live command, so a
 * fast agent result always finds its row.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ENDPOINT_CHAT_LIMITS, type EndpointChatMessageInput, type EndpointChatOpenInput } from '@breeze/shared';
import { db, runOutsideDbContext } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';
import { queueCommandForExecution, type QueueCommandForExecutionResult } from '../commandQueue';
import { CommandTypes } from '../commandTypes';
import { agentSupportsChat } from '../commandMinVersion';
import { buildHelperConfigUpdate } from '../helperSettings';
import { resolveMessageBranding, type MessageBranding } from './brandingSnapshot';
import { checkChatMessageLimit, checkChatOpenLimit, type LimitDecision } from './rateLimits';
import {
  attachOpenCommand,
  closeLiveConversation,
  conversationMessageCounts,
  insertOpeningConversation,
  insertTechMessage,
  markOpenFailed,
  setMessageCommand,
  setMessageError,
} from './chatStore';
import {
  chatSiteAllowed,
  conversationView,
  findConversationForCaller,
  messageView,
  readConversationMessages,
  type ChatMessageView,
  type ChatSitePerms,
  type ConversationView,
} from './chatReads';
import type { EndpointConversationCloseReason } from '../../db/schema/endpointConversations';

export type ChatErrorCode =
  | 'device_not_found'
  | 'not_found'
  | 'platform_unsupported'
  | 'agent_unsupported'
  | 'feature_disabled'
  | 'device_offline'
  | 'conversation_active'
  | 'conversation_not_open'
  | 'idempotency_conflict'
  | 'no_permission'
  | 'queue_failed'
  | 'rate_limited'
  | 'unavailable';

export type ChatFailure = {
  ok: false;
  status: 403 | 404 | 409 | 429 | 503;
  body: { error: ChatErrorCode; retryAfterSeconds?: number; conversationId?: string; message?: ChatMessageView; conversation?: ConversationView };
};

export interface ChatDeps {
  dispatch: (
    deviceId: string,
    type: string,
    payload: Record<string, unknown>,
    options: { userId: string; expectedOrgId: string; offlinePolicy: { kind: 'reject' } },
  ) => Promise<QueueCommandForExecutionResult>;
  /** The device's resolved endpointMessaging settings (cache skipped: rollout flags must be live). */
  chatSettings: (deviceId: string, orgId: string) => Promise<{ enabled: boolean; allowUserReply: boolean }>;
  branding: (orgId: string) => Promise<{ partnerId: string; branding: MessageBranding } | null>;
  openLimit: (actorId: string) => Promise<LimitDecision>;
  messageLimit: (conversationId: string) => Promise<LimitDecision>;
  now: () => Date;
}

export const defaultChatDeps: ChatDeps = {
  dispatch: (deviceId, type, payload, options) => queueCommandForExecution(deviceId, type, payload, options),
  chatSettings: async (deviceId, orgId) => {
    const s = await buildHelperConfigUpdate(deviceId, orgId, { skipCacheRead: true, skipCacheWrite: true });
    return {
      enabled: s.endpointMessaging?.enabled === true,
      // Entries without the field predate W03: the owner default is on.
      allowUserReply: s.endpointMessaging?.allowUserReply !== false,
    };
  },
  branding: resolveMessageBranding,
  // Redis round-trips run outside the request's held DB transaction (#1105).
  openLimit: (actorId) => runOutsideDbContext(() => checkChatOpenLimit(actorId, ENDPOINT_CHAT_LIMITS.opensPerHourPerActor)),
  messageLimit: (id) => runOutsideDbContext(() => checkChatMessageLimit(id, ENDPOINT_CHAT_LIMITS.techMessagesPerHourPerConversation)),
  now: () => new Date(),
};

export interface ChatCaller {
  auth: Pick<AuthContext, 'user' | 'orgCondition'>;
  permissions?: ChatSitePerms;
  deps?: Partial<ChatDeps>;
}

const fail = (status: ChatFailure['status'], body: ChatFailure['body']): ChatFailure => ({ ok: false, status, body });

/** Map a queueCommandForExecution refusal onto the public codes (send.ts rule). */
function dispatchErrorCode(res: QueueCommandForExecutionResult): ChatErrorCode {
  if (res.trust) return 'no_permission';
  if (res.error && /offline|not connected|unreachable/i.test(res.error)) return 'device_offline';
  return 'queue_failed';
}

function dispatchFailure(code: ChatErrorCode): ChatFailure['status'] {
  return code === 'no_permission' ? 403 : 409;
}

export const bodySha256 = (body: string) => createHash('sha256').update(body).digest('hex');

/** The chat_open / chat_message payload (contract §1). Ids are top-level too: terminal erasure strips `message`. */
function chatPayload(args: {
  conversationId: string;
  allowUserReply: boolean;
  branding: MessageBranding;
  messageId: string;
  body: string;
  senderName: string;
  sentAt: Date;
}): Record<string, unknown> {
  return {
    conversationId: args.conversationId,
    chatMessageId: args.messageId,
    allowUserReply: args.allowUserReply,
    branding: args.branding,
    message: {
      messageId: args.messageId,
      body: args.body,
      senderName: args.senderName.slice(0, ENDPOINT_CHAT_LIMITS.senderNameMax),
      sentAt: args.sentAt.toISOString(),
    },
  };
}

function senderNameOf(user: Pick<AuthContext['user'], 'name' | 'email'>): string {
  const name = (user.name ?? '').trim();
  return name.length > 0 ? name : 'Technician';
}

export type OpenChatOutcome =
  | { ok: true; status: 200 | 202; replay: boolean; conversation: ConversationView; messages: ChatMessageView[]; deviceOrgId: string; bodySha256: string }
  | ChatFailure;

export async function openEndpointChat(caller: ChatCaller, input: EndpointChatOpenInput): Promise<OpenChatOutcome> {
  const deps = { ...defaultChatDeps, ...caller.deps };
  const { auth } = caller;

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      osType: devices.osType,
      agentVersion: devices.agentVersion,
      status: devices.status,
    })
    .from(devices)
    .where(and(eq(devices.id, input.deviceId), auth.orgCondition(devices.orgId)))
    .limit(1);
  // Same answer whether the device does not exist or the caller cannot reach it.
  if (!device || !chatSiteAllowed(caller.permissions, device.siteId)) {
    return fail(404, { error: 'device_not_found' });
  }

  // Idempotent retry: the same client id on the same device by the same actor.
  const existing = await findConversationForCaller({ auth, permissions: caller.permissions, conversationId: input.conversationId });
  if (existing) {
    if (existing.conversation.deviceId !== device.id || existing.conversation.openedBy !== auth.user.id) {
      return fail(409, { error: 'idempotency_conflict' });
    }
    return {
      ok: true,
      status: 200,
      replay: true,
      conversation: conversationView(existing.conversation, existing.openedByName),
      messages: await readConversationMessages(existing.conversation.id),
      deviceOrgId: device.orgId,
      bodySha256: bodySha256(input.body),
    };
  }

  if (device.osType !== 'windows') return fail(409, { error: 'platform_unsupported' });
  if (!agentSupportsChat(device.agentVersion)) return fail(409, { error: 'agent_unsupported' });
  if (device.status !== 'online') return fail(409, { error: 'device_offline' });

  let settings: { enabled: boolean; allowUserReply: boolean };
  try {
    settings = await deps.chatSettings(device.id, device.orgId);
  } catch (err) {
    console.error('[endpoint-chat] helper settings resolution failed', { deviceId: device.id, error: err instanceof Error ? err.message : String(err) });
    return fail(503, { error: 'unavailable' });
  }
  if (!settings.enabled) return fail(403, { error: 'feature_disabled' });

  const limit = await deps.openLimit(auth.user.id);
  if (!limit.allowed) return fail(429, { error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds });

  const brand = await deps.branding(device.orgId);
  if (!brand) return fail(503, { error: 'unavailable' });

  const inserted = await insertOpeningConversation({
    id: input.conversationId,
    orgId: device.orgId,
    deviceId: device.id,
    openedBy: auth.user.id,
    allowUserReply: settings.allowUserReply,
    body: input.body,
  });
  if (inserted.kind === 'active') {
    return fail(409, { error: 'conversation_active', ...(inserted.conversationId ? { conversationId: inserted.conversationId } : {}) });
  }
  if (inserted.kind === 'id_taken') return fail(409, { error: 'idempotency_conflict' });

  const { conversation, message } = inserted;
  const res = await deps.dispatch(
    device.id,
    CommandTypes.CHAT_OPEN,
    chatPayload({
      conversationId: conversation.id,
      allowUserReply: conversation.allowUserReply,
      branding: brand.branding,
      messageId: message.id,
      body: input.body,
      senderName: senderNameOf(auth.user),
      sentAt: message.createdAt,
    }),
    { userId: auth.user.id, expectedOrgId: device.orgId, offlinePolicy: { kind: 'reject' } },
  );
  if (res.error || !res.command) {
    const code = dispatchErrorCode(res);
    console.warn('[endpoint-chat] chat_open refused', { conversationId: conversation.id, deviceId: device.id, code });
    await markOpenFailed(conversation.id, message.id, code);
    return fail(dispatchFailure(code), {
      error: code,
      conversation: conversationView({ ...conversation, status: 'failed', errorCode: code }, auth.user.name ?? null),
    });
  }
  try {
    await attachOpenCommand(conversation.id, message.id, res.command.id);
  } catch (err) {
    // The command is already on its way. The result handler finds the rows by
    // the conversation/message ids in the payload, so only bookkeeping is lost.
    console.error('[endpoint-chat] open command bookkeeping failed', { conversationId: conversation.id, error: err instanceof Error ? err.message : String(err) });
  }
  return {
    ok: true,
    status: 202,
    replay: false,
    conversation: conversationView(conversation, auth.user.name ?? null),
    messages: [messageView({ ...message, commandId: res.command.id }, auth.user.name ?? null)],
    deviceOrgId: device.orgId,
    bodySha256: bodySha256(input.body),
  };
}

export type SendChatOutcome =
  | { ok: true; status: 200 | 201; message: ChatMessageView }
  | ChatFailure;

export async function sendEndpointChatMessage(
  caller: ChatCaller,
  conversationId: string,
  input: EndpointChatMessageInput,
): Promise<SendChatOutcome> {
  const deps = { ...defaultChatDeps, ...caller.deps };
  const { auth } = caller;
  const found = await findConversationForCaller({ auth, permissions: caller.permissions, conversationId });
  if (!found) return fail(404, { error: 'not_found' });
  const conv = found.conversation;
  if (conv.status !== 'open') return fail(409, { error: 'conversation_not_open', conversation: conversationView(conv, found.openedByName) });

  let settings: { enabled: boolean; allowUserReply: boolean };
  try {
    settings = await deps.chatSettings(conv.deviceId, conv.orgId);
  } catch (err) {
    console.error('[endpoint-chat] helper settings resolution failed', { deviceId: conv.deviceId, error: err instanceof Error ? err.message : String(err) });
    return fail(503, { error: 'unavailable' });
  }
  // The rollout flag is enforced per message: switching messaging off stops a chat mid-flight.
  if (!settings.enabled) return fail(403, { error: 'feature_disabled' });

  const limit = await deps.messageLimit(conv.id);
  if (!limit.allowed) return fail(429, { error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds });

  const brand = await deps.branding(conv.orgId);
  if (!brand) return fail(503, { error: 'unavailable' });

  const inserted = await insertTechMessage({
    conversationId: conv.id,
    orgId: conv.orgId,
    deviceId: conv.deviceId,
    clientNonce: input.messageId,
    senderUserId: auth.user.id,
    body: input.body,
  });
  if (inserted.kind === 'duplicate') {
    // A retry of a message already accepted: never a second line on screen.
    return { ok: true, status: 200, message: messageView(inserted.message, auth.user.name ?? null) };
  }

  const message = inserted.message;
  const res = await deps.dispatch(
    conv.deviceId,
    CommandTypes.CHAT_MESSAGE,
    chatPayload({
      conversationId: conv.id,
      allowUserReply: conv.allowUserReply,
      branding: brand.branding,
      messageId: message.id,
      body: input.body,
      senderName: senderNameOf(auth.user),
      sentAt: message.createdAt,
    }),
    { userId: auth.user.id, expectedOrgId: conv.orgId, offlinePolicy: { kind: 'reject' } },
  );
  if (res.error || !res.command) {
    const code = dispatchErrorCode(res);
    console.warn('[endpoint-chat] chat_message refused', { conversationId: conv.id, deviceId: conv.deviceId, code });
    const failed = await setMessageError(message.id, code);
    return fail(dispatchFailure(code), { error: code, message: messageView(failed ?? { ...message, errorCode: code }, auth.user.name ?? null) });
  }
  try {
    await setMessageCommand(message.id, res.command.id);
  } catch (err) {
    console.error('[endpoint-chat] message command bookkeeping failed', { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
  }
  return { ok: true, status: 201, message: messageView({ ...message, commandId: res.command.id }, auth.user.name ?? null) };
}

export type CloseChatOutcome =
  | {
    ok: true;
    alreadyClosed: boolean;
    conversation: ConversationView;
    counts: { toUser: number; fromUser: number } | null;
    agentNotified: boolean;
  }
  | ChatFailure;

/**
 * Close a chat. Idempotent. The conversation is closed in the DB first; the
 * agent is told best-effort (an offline device learns at its next reply,
 * which gets 409 conversation_closed).
 */
export async function closeEndpointChat(
  caller: ChatCaller,
  conversationId: string,
  reason: EndpointConversationCloseReason = 'technician',
): Promise<CloseChatOutcome> {
  const deps = { ...defaultChatDeps, ...caller.deps };
  const { auth } = caller;
  const found = await findConversationForCaller({ auth, permissions: caller.permissions, conversationId });
  if (!found) return fail(404, { error: 'not_found' });

  const closed = await closeLiveConversation({ conversationId, reason, closedBy: auth.user.id });
  if (!closed) {
    return { ok: true, alreadyClosed: true, conversation: conversationView(found.conversation, found.openedByName), counts: null, agentNotified: false };
  }
  const res = await deps.dispatch(
    closed.deviceId,
    CommandTypes.CHAT_CLOSE,
    { conversationId: closed.id, reason },
    { userId: auth.user.id, expectedOrgId: closed.orgId, offlinePolicy: { kind: 'reject' } },
  );
  const agentNotified = !res.error && !!res.command;
  if (!agentNotified) {
    console.warn('[endpoint-chat] chat_close not delivered; the agent learns at its next reply', {
      conversationId: closed.id, deviceId: closed.deviceId, code: dispatchErrorCode(res),
    });
  }
  return {
    ok: true,
    alreadyClosed: false,
    conversation: conversationView(closed, found.openedByName),
    counts: await conversationMessageCounts(closed.id),
    agentNotified,
  };
}
