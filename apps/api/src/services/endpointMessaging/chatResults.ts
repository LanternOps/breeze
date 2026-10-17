/**
 * chat_open / chat_message command results -> endpoint chat rows (#8743).
 *
 * Registered in `commandResultHandlers` (and the HTTP route's
 * REGISTRY_DISPATCHED_COMMAND_TYPES), so both transports run this one leaf
 * inside the transport's result transaction, in the device's org context.
 *
 * Ownership: rows are found on the transport-authenticated device only, by
 * the conversation / message ids the API itself put at the top level of the
 * persisted command payload (`conversationId`, `chatMessageId` — they survive
 * terminal payload erasure, which strips the `message` object). Never from
 * anything the agent reports.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { endpointConversationMessages, endpointConversations } from '../../db/schema';
import type { CommandResultHandler } from '../commandResultHandlers';

type HandlerParams = Parameters<CommandResultHandler>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);

/** Agent failure strings (contract §1) -> stored error codes. Anything else is generic. */
const KNOWN_AGENT_ERRORS = new Set(['chat_requires_assist', 'chat_window_failed', 'chat_invalid_payload']);

export function chatErrorCode(result: { status: string; error?: string }): string {
  const error = (result.error ?? '').trim();
  if (KNOWN_AGENT_ERRORS.has(error)) return error;
  if (error.toLowerCase().startsWith('unknown command type')) return 'agent_unsupported';
  if (result.status === 'timeout') return 'agent_timeout';
  return 'delivery_failed';
}

interface OpenStdout {
  username?: unknown;
  winSessionId?: unknown;
}

function parseStdout(stdout: string | undefined): OpenStdout {
  if (!stdout) return {};
  try {
    const v = JSON.parse(stdout) as unknown;
    return v && typeof v === 'object' ? (v as OpenStdout) : {};
  } catch {
    return {};
  }
}

function ids(command: HandlerParams['command']): { conversationId: string | null; messageId: string | null } {
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  return { conversationId: uuidOrNull(payload.conversationId), messageId: uuidOrNull(payload.chatMessageId) };
}

async function markMessage(conversationId: string, messageId: string, deviceId: string, outcome: { delivered: true } | { errorCode: string }): Promise<number> {
  const where = and(
    eq(endpointConversationMessages.id, messageId),
    eq(endpointConversationMessages.conversationId, conversationId),
    eq(endpointConversationMessages.deviceId, deviceId),
  );
  const rows = 'delivered' in outcome
    ? await db.update(endpointConversationMessages)
      .set({ deliveredAt: sql`COALESCE(${endpointConversationMessages.deliveredAt}, now())`, errorCode: null })
      .where(where)
      .returning({ id: endpointConversationMessages.id })
    : await db.update(endpointConversationMessages)
      .set({ errorCode: outcome.errorCode })
      .where(and(where, isNull(endpointConversationMessages.deliveredAt)))
      .returning({ id: endpointConversationMessages.id });
  return rows.length;
}

export async function handleChatOpenResult({ command, resolvedDeviceId, result, stdout }: HandlerParams): Promise<void> {
  const { conversationId, messageId } = ids(command);
  if (!conversationId || !messageId) {
    console.warn('[endpoint-chat] chat_open result without conversation ids', { deviceId: resolvedDeviceId });
    return;
  }
  const now = new Date();
  const own = and(eq(endpointConversations.id, conversationId), eq(endpointConversations.deviceId, resolvedDeviceId));

  if (result.status === 'completed') {
    const out = parseStdout(stdout);
    const username = typeof out.username === 'string' && out.username.length > 0 ? out.username.slice(0, 256) : null;
    const winSessionId = typeof out.winSessionId === 'number' && Number.isInteger(out.winSessionId) && out.winSessionId >= 0
      ? out.winSessionId
      : null;
    // Only an `opening` conversation becomes `open`: a technician who closed it
    // (or the timeout sweep) while the window was coming up keeps that state.
    const opened = await db.update(endpointConversations)
      .set({ status: 'open', targetUsername: username, winSessionId, lastActivityAt: now, updatedAt: now })
      .where(and(own, eq(endpointConversations.status, 'opening')))
      .returning({ id: endpointConversations.id });
    const marked = await markMessage(conversationId, messageId, resolvedDeviceId, { delivered: true });
    if (opened.length === 0 && marked === 0) {
      console.warn('[endpoint-chat] chat_open result matched no conversation', { conversationId, deviceId: resolvedDeviceId });
    }
    return;
  }

  const errorCode = chatErrorCode(result);
  const failed = await db.update(endpointConversations)
    .set({ status: 'failed', errorCode, updatedAt: now })
    .where(and(own, eq(endpointConversations.status, 'opening')))
    .returning({ id: endpointConversations.id });
  await markMessage(conversationId, messageId, resolvedDeviceId, { errorCode });
  if (failed.length === 0) {
    console.warn('[endpoint-chat] chat_open failure matched no opening conversation', { conversationId, deviceId: resolvedDeviceId, errorCode });
  }
}

export async function handleChatMessageResult({ command, resolvedDeviceId, result }: HandlerParams): Promise<void> {
  const { conversationId, messageId } = ids(command);
  if (!conversationId || !messageId) {
    console.warn('[endpoint-chat] chat_message result without conversation ids', { deviceId: resolvedDeviceId });
    return;
  }
  const outcome = result.status === 'completed' ? { delivered: true as const } : { errorCode: chatErrorCode(result) };
  const marked = await markMessage(conversationId, messageId, resolvedDeviceId, outcome);
  if (marked === 0 && 'delivered' in outcome) {
    console.warn('[endpoint-chat] chat_message result matched no message', { conversationId, messageId, deviceId: resolvedDeviceId });
  }
}
