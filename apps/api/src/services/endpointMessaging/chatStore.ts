/**
 * Endpoint live chat persistence (#8743, W03 of #8740).
 *
 * Writes that must be visible to a fast agent result run in their OWN system
 * transaction, outside the request's held one, and commit before the caller
 * dispatches any command (same rule as endpointMessaging/persistence.ts).
 * Authorization is the caller's job: every id here was first read under the
 * request's RLS context (chat.ts), never taken from the body unchecked.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { endpointConversationMessages, endpointConversations } from '../../db/schema';
import type { EndpointConversationCloseReason, EndpointConversationRow, EndpointConversationMessageRow } from '../../db/schema/endpointConversations';

const inSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

export const LIVE_CONVERSATION_STATUSES = ['opening', 'open'] as const;

function pgErr(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint_name?: string; constraint?: string; cause?: { code?: string; constraint_name?: string; constraint?: string } };
  return {
    code: e.code ?? e.cause?.code,
    constraint: e.constraint_name ?? e.constraint ?? e.cause?.constraint_name ?? e.cause?.constraint,
  };
}

export type InsertOpeningOutcome =
  | { kind: 'created'; conversation: EndpointConversationRow; message: EndpointConversationMessageRow }
  | { kind: 'active'; conversationId: string | null }
  | { kind: 'id_taken' };

/** The conversation (status `opening`) and its first technician message, in one transaction. */
export async function insertOpeningConversation(input: {
  id: string;
  orgId: string;
  deviceId: string;
  openedBy: string;
  allowUserReply: boolean;
  body: string;
}): Promise<InsertOpeningOutcome> {
  try {
    return await inSystem(() => db.transaction(async (tx) => {
      const [conversation] = await tx.insert(endpointConversations).values({
        id: input.id,
        orgId: input.orgId,
        deviceId: input.deviceId,
        status: 'opening',
        allowUserReply: input.allowUserReply,
        openedBy: input.openedBy,
      }).returning();
      const [message] = await tx.insert(endpointConversationMessages).values({
        conversationId: input.id,
        orgId: input.orgId,
        deviceId: input.deviceId,
        direction: 'to_user',
        body: input.body,
        bodyLength: input.body.length,
        // The first message's idempotency key is the conversation id itself.
        clientNonce: input.id,
        senderUserId: input.openedBy,
      }).returning();
      return { kind: 'created' as const, conversation: conversation!, message: message! };
    }));
  } catch (err) {
    const { code, constraint } = pgErr(err);
    if (code !== '23505') throw err;
    if (constraint === 'endpoint_conversations_device_active_uq') {
      const [active] = await inSystem(() => db.select({ id: endpointConversations.id })
        .from(endpointConversations)
        .where(and(
          eq(endpointConversations.deviceId, input.deviceId),
          inArray(endpointConversations.status, [...LIVE_CONVERSATION_STATUSES]),
        ))
        .limit(1));
      return { kind: 'active', conversationId: active?.id ?? null };
    }
    // Primary key: the client id is taken (by another device, actor or org).
    return { kind: 'id_taken' };
  }
}

export async function attachOpenCommand(conversationId: string, messageId: string, commandId: string): Promise<void> {
  await inSystem(() => db.transaction(async (tx) => {
    await tx.update(endpointConversations)
      .set({ openCommandId: sql`COALESCE(${endpointConversations.openCommandId}, ${commandId}::uuid)`, updatedAt: new Date() })
      .where(eq(endpointConversations.id, conversationId));
    await tx.update(endpointConversationMessages)
      .set({ commandId: sql`COALESCE(${endpointConversationMessages.commandId}, ${commandId}::uuid)` })
      .where(eq(endpointConversationMessages.id, messageId));
  }));
}

/** The open was refused before the agent saw it. Only an `opening` row moves. */
export async function markOpenFailed(conversationId: string, messageId: string, errorCode: string): Promise<void> {
  await inSystem(() => db.transaction(async (tx) => {
    await tx.update(endpointConversations)
      .set({ status: 'failed', errorCode, updatedAt: new Date() })
      .where(and(eq(endpointConversations.id, conversationId), eq(endpointConversations.status, 'opening')));
    await tx.update(endpointConversationMessages)
      .set({ errorCode })
      .where(eq(endpointConversationMessages.id, messageId));
  }));
}

export type InsertTechMessageOutcome =
  | { kind: 'created'; message: EndpointConversationMessageRow }
  | { kind: 'duplicate'; message: EndpointConversationMessageRow };

export async function insertTechMessage(input: {
  conversationId: string;
  orgId: string;
  deviceId: string;
  clientNonce: string;
  senderUserId: string;
  body: string;
}): Promise<InsertTechMessageOutcome> {
  return inSystem(() => db.transaction(async (tx) => {
    const [created] = await tx.insert(endpointConversationMessages).values({
      conversationId: input.conversationId,
      orgId: input.orgId,
      deviceId: input.deviceId,
      direction: 'to_user',
      body: input.body,
      bodyLength: input.body.length,
      clientNonce: input.clientNonce,
      senderUserId: input.senderUserId,
    }).onConflictDoNothing().returning();
    if (created) {
      await tx.update(endpointConversations)
        .set({ lastActivityAt: new Date(), updatedAt: new Date() })
        .where(eq(endpointConversations.id, input.conversationId));
      return { kind: 'created' as const, message: created };
    }
    const [existing] = await tx.select().from(endpointConversationMessages)
      .where(and(
        eq(endpointConversationMessages.conversationId, input.conversationId),
        eq(endpointConversationMessages.clientNonce, input.clientNonce),
      ))
      .limit(1);
    return { kind: 'duplicate' as const, message: existing! };
  }));
}

export async function setMessageCommand(messageId: string, commandId: string): Promise<void> {
  await inSystem(() => db.update(endpointConversationMessages)
    .set({ commandId: sql`COALESCE(${endpointConversationMessages.commandId}, ${commandId}::uuid)` })
    .where(eq(endpointConversationMessages.id, messageId)));
}

export async function setMessageError(messageId: string, errorCode: string): Promise<EndpointConversationMessageRow | undefined> {
  const [row] = await inSystem(() => db.update(endpointConversationMessages)
    .set({ errorCode })
    .where(eq(endpointConversationMessages.id, messageId))
    .returning());
  return row;
}

/**
 * Close a live conversation. Returns the updated row, or null when it was not
 * live any more (already closed/expired/failed): closing is idempotent.
 */
export async function closeLiveConversation(input: {
  conversationId: string;
  reason: EndpointConversationCloseReason;
  closedBy: string | null;
  status?: 'closed' | 'expired';
}): Promise<EndpointConversationRow | null> {
  const now = new Date();
  const [row] = await inSystem(() => db.update(endpointConversations)
    .set({
      status: input.status ?? 'closed',
      closeReason: input.reason,
      closedBy: input.closedBy,
      closedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(endpointConversations.id, input.conversationId),
      inArray(endpointConversations.status, [...LIVE_CONVERSATION_STATUSES]),
    ))
    .returning());
  return row ?? null;
}

/** Messages in each direction, for the close audit row (counts only, never text). */
export async function conversationMessageCounts(conversationId: string): Promise<{ toUser: number; fromUser: number }> {
  const rows = await inSystem(() => db.select({
    direction: endpointConversationMessages.direction,
    n: sql<number>`count(*)::int`,
  })
    .from(endpointConversationMessages)
    .where(eq(endpointConversationMessages.conversationId, conversationId))
    .groupBy(endpointConversationMessages.direction));
  const by = new Map(rows.map((r) => [r.direction, Number(r.n)]));
  return { toUser: by.get('to_user') ?? 0, fromUser: by.get('from_user') ?? 0 };
}
