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

export async function recordChatReply(
  input: ChatReplyInput,
  replyLimit: (conversationId: string) => Promise<LimitDecision> = (id) =>
    runOutsideDbContext(() => checkChatReplyLimit(id, ENDPOINT_CHAT_LIMITS.userRepliesPerHourPerConversation)),
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

  const limit = await replyLimit(conv.id);
  if (!limit.allowed) return { kind: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };

  const inserted = await db.insert(endpointConversationMessages)
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
  if (inserted.length === 0) return { kind: 'accepted', duplicate: true };

  const now = new Date();
  await db.update(endpointConversations)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(and(eq(endpointConversations.id, conv.id), inArray(endpointConversations.status, [...LIVE_CONVERSATION_STATUSES])));
  return { kind: 'accepted', duplicate: false };
}
