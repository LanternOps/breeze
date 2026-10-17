/**
 * Endpoint live chat reads (#8743). Every read runs in the request's RLS
 * context; the app-layer org condition is the same filter stated, never a
 * widening. A site-restricted caller sees only conversations on devices in
 * their allowed sites.
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ENDPOINT_CHAT_LIMITS } from '@breeze/shared';
import { db } from '../../db';
import { devices, endpointConversationMessages, endpointConversations, users } from '../../db/schema';
import type {
  EndpointChatSenderSession,
  EndpointConversationRow,
  EndpointConversationMessageRow,
} from '../../db/schema/endpointConversations';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';

type Auth = Pick<AuthContext, 'orgCondition'>;
export type ChatSitePerms = Pick<UserPermissions, 'allowedSiteIds'> | undefined;

export function chatSiteAllowed(permissions: ChatSitePerms, siteId: string): boolean {
  const allowed = permissions?.allowedSiteIds;
  if (allowed === undefined) return true;
  return Array.isArray(allowed) && allowed.includes(siteId);
}

function siteFilter(permissions: ChatSitePerms): SQL | undefined {
  const allowed = permissions?.allowedSiteIds;
  if (allowed === undefined) return undefined;
  if (!Array.isArray(allowed) || allowed.length === 0) return sql`false`;
  return inArray(devices.siteId, allowed);
}

export interface ConversationView {
  id: string;
  orgId: string;
  deviceId: string;
  status: EndpointConversationRow['status'];
  allowUserReply: boolean;
  targetUsername: string | null;
  errorCode: string | null;
  closeReason: string | null;
  openedBy: { id: string; name: string | null } | null;
  createdAt: string;
  lastActivityAt: string;
  closedAt: string | null;
}

export interface ChatMessageView {
  id: string;
  conversationId: string;
  direction: 'to_user' | 'from_user';
  body: string | null;
  senderName: string | null;
  senderUsername: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  errorCode: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function conversationView(row: EndpointConversationRow, openedByName: string | null = null): ConversationView {
  return {
    id: row.id,
    orgId: row.orgId,
    deviceId: row.deviceId,
    status: row.status,
    allowUserReply: row.allowUserReply,
    targetUsername: row.targetUsername,
    errorCode: row.errorCode,
    closeReason: row.closeReason,
    openedBy: row.openedBy ? { id: row.openedBy, name: openedByName } : null,
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    closedAt: iso(row.closedAt),
  };
}

export function messageView(row: EndpointConversationMessageRow, senderName: string | null = null): ChatMessageView {
  const session = row.senderSession as EndpointChatSenderSession | null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction,
    body: row.body,
    senderName: row.direction === 'to_user' ? senderName : null,
    senderUsername: row.direction === 'from_user' ? (session?.username ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deliveredAt: iso(row.deliveredAt),
    errorCode: row.errorCode,
  };
}

export interface CallerConversation {
  conversation: EndpointConversationRow;
  siteId: string;
  openedByName: string | null;
}

/** One conversation the caller may see (RLS + org condition + site), or null. */
export async function findConversationForCaller(args: {
  auth: Auth;
  permissions?: ChatSitePerms;
  conversationId: string;
}): Promise<CallerConversation | null> {
  const opener = alias(users, 'opener');
  const [row] = await db
    .select({ conversation: endpointConversations, siteId: devices.siteId, openedByName: opener.name })
    .from(endpointConversations)
    .innerJoin(devices, eq(devices.id, endpointConversations.deviceId))
    .leftJoin(opener, eq(opener.id, endpointConversations.openedBy))
    .where(and(
      eq(endpointConversations.id, args.conversationId),
      args.auth.orgCondition(endpointConversations.orgId),
    ))
    .limit(1);
  if (!row || !chatSiteAllowed(args.permissions, row.siteId)) return null;
  return { conversation: row.conversation, siteId: row.siteId, openedByName: row.openedByName ?? null };
}

/** Messages of a conversation the caller already proved access to, oldest first. */
export async function readConversationMessages(conversationId: string, since?: Date): Promise<ChatMessageView[]> {
  const sender = alias(users, 'sender');
  const rows = await db
    .select({ message: endpointConversationMessages, senderName: sender.name })
    .from(endpointConversationMessages)
    .leftJoin(sender, eq(sender.id, endpointConversationMessages.senderUserId))
    .where(and(
      eq(endpointConversationMessages.conversationId, conversationId),
      // The cursor is the newest updatedAt the console holds. Changed rows come
      // back (a delivery failure after send), and a fixed lookback covers a row
      // whose transaction committed after a newer one was already polled
      // (now() is transaction start). The overlap is deduped by id client-side.
      since
        ? sql`${endpointConversationMessages.updatedAt} > ${since.toISOString()}::timestamptz - make_interval(secs => ${CHAT_POLL_LOOKBACK_SECONDS})`
        : undefined,
    ))
    .orderBy(asc(endpointConversationMessages.createdAt), asc(endpointConversationMessages.id))
    .limit(ENDPOINT_CHAT_LIMITS.maxMessagesPerRead);
  return rows.map((r) => messageView(r.message, r.senderName ?? null));
}

export const DEVICE_CONVERSATION_LIST_LIMIT = 20;
/** Poll overlap for late-committing rows (see readConversationMessages). */
export const CHAT_POLL_LOOKBACK_SECONDS = 5;

/** The newest conversations on one device, for the device chat panel. */
export async function listDeviceConversations(args: {
  auth: Auth;
  permissions?: ChatSitePerms;
  deviceId: string;
}): Promise<ConversationView[]> {
  const opener = alias(users, 'opener');
  const rows = await db
    .select({ conversation: endpointConversations, openedByName: opener.name })
    .from(endpointConversations)
    .innerJoin(devices, eq(devices.id, endpointConversations.deviceId))
    .leftJoin(opener, eq(opener.id, endpointConversations.openedBy))
    .where(and(
      eq(endpointConversations.deviceId, args.deviceId),
      args.auth.orgCondition(endpointConversations.orgId),
      siteFilter(args.permissions),
    ))
    .orderBy(desc(endpointConversations.createdAt), desc(endpointConversations.id))
    .limit(DEVICE_CONVERSATION_LIST_LIMIT);
  return rows.map((r) => conversationView(r.conversation, r.openedByName ?? null));
}
