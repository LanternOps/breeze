/**
 * End-user chat replies arriving on the agent route (#8743).
 *
 * Trust boundary: the device and org come from the authenticated agent
 * context; the conversation must belong to THAT device; the sender session is
 * agent-attested (the broker's authenticated helper session, never the
 * helper's own claim). Runs in the agent route's request context (the
 * device's org). Dedup is the DB unique key (conversation_id, client_nonce).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { ENDPOINT_CHAT_LIMITS } from '@breeze/shared';
import { db, runOutsideDbContext } from '../../db';
import { endpointConversationMessages, endpointConversations } from '../../db/schema';
import type { EndpointChatSenderSession } from '../../db/schema/endpointConversations';
import { checkChatReplyLimit, type LimitDecision } from './rateLimits';
import { buildHelperConfigUpdate } from '../helperSettings';
import { LIVE_CONVERSATION_STATUSES } from './chatStore';

export interface ChatReplyInput {
  deviceId: string;
  conversationId: string;
  clientNonce: string;
  body: string;
  session: EndpointChatSenderSession;
}

export type ChatReplyOutcome =
  | { kind: 'accepted'; duplicate: boolean }
  | { kind: 'unknown_conversation' }
  | { kind: 'conversation_closed' }
  | { kind: 'replies_disabled' }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

/** Whether endpoint messaging is still on for the device (rollout flag, cache skipped). */
async function messagingEnabled(deviceId: string, orgId: string): Promise<boolean> {
  const s = await buildHelperConfigUpdate(deviceId, orgId, { skipCacheRead: true, skipCacheWrite: true });
  return s.endpointMessaging?.enabled === true;
}

export async function recordChatReply(
  input: ChatReplyInput,
  replyLimit: (conversationId: string) => Promise<LimitDecision> = (id) =>
    runOutsideDbContext(() => checkChatReplyLimit(id, ENDPOINT_CHAT_LIMITS.userRepliesPerHourPerConversation)),
  flagEnabled: (deviceId: string, orgId: string) => Promise<boolean> = messagingEnabled,
): Promise<ChatReplyOutcome> {
  const [conv] = await db
    .select({
      id: endpointConversations.id,
      orgId: endpointConversations.orgId,
      status: endpointConversations.status,
      allowUserReply: endpointConversations.allowUserReply,
    })
    .from(endpointConversations)
    .where(and(eq(endpointConversations.id, input.conversationId), eq(endpointConversations.deviceId, input.deviceId)))
    .limit(1);
  if (!conv) return { kind: 'unknown_conversation' };
  // `opening` too: the user can type before the open result is processed.
  if (!(LIVE_CONVERSATION_STATUSES as readonly string[]).includes(conv.status)) return { kind: 'conversation_closed' };
  if (!conv.allowUserReply) return { kind: 'replies_disabled' };

  // A retried reply (same nonce) is already stored: no budget, no second row.
  const [prior] = await db.select({ id: endpointConversationMessages.id })
    .from(endpointConversationMessages)
    .where(and(eq(endpointConversationMessages.conversationId, conv.id), eq(endpointConversationMessages.clientNonce, input.clientNonce)))
    .limit(1);
  if (prior) return { kind: 'accepted', duplicate: true };

  // Switching messaging off stops a chat in both directions.
  let enabled: boolean;
  try {
    enabled = await flagEnabled(input.deviceId, conv.orgId);
  } catch (err) {
    console.error('[endpoint-chat] helper settings resolution failed for a reply', { deviceId: input.deviceId, error: err instanceof Error ? err.message : String(err) });
    enabled = false;
  }
  if (!enabled) return { kind: 'replies_disabled' };

  const limit = await replyLimit(conv.id);
  if (!limit.allowed) return { kind: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };

  // Lock the conversation and re-check it is live in the same transaction, so
  // a close that lands between the read above and this insert wins.
  return db.transaction(async (tx) => {
    const [live] = await tx.select({ id: endpointConversations.id })
      .from(endpointConversations)
      .where(and(
        eq(endpointConversations.id, conv.id),
        inArray(endpointConversations.status, [...LIVE_CONVERSATION_STATUSES]),
      ))
      .for('update')
      .limit(1);
    if (!live) return { kind: 'conversation_closed' as const };
    const inserted = await tx.insert(endpointConversationMessages)
      .values({
        conversationId: conv.id,
        orgId: conv.orgId,
        deviceId: input.deviceId,
        direction: 'from_user',
        body: input.body,
        bodyLength: input.body.length,
        clientNonce: input.clientNonce,
        senderSession: input.session,
        deliveredAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: endpointConversationMessages.id });
    if (inserted.length === 0) return { kind: 'accepted' as const, duplicate: true };
    const now = new Date();
    await tx.update(endpointConversations)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(eq(endpointConversations.id, conv.id));
    return { kind: 'accepted' as const, duplicate: false };
  });
}
