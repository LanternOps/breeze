import { Hono } from 'hono';
import { z } from 'zod';
import { endpointChatMessageSchema, endpointChatOpenSchema, type EndpointChatMessageInput, type EndpointChatOpenInput } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { closeEndpointChat, openEndpointChat, sendEndpointChatMessage } from '../../services/endpointMessaging/chat';
import {
  conversationView,
  findConversationForCaller,
  listDeviceConversations,
  readConversationMessages,
} from '../../services/endpointMessaging/chatReads';

// Endpoint live chat (#8743, W03 of #8740; refs #8292). Technician-opened
// ad-hoc chat with the person at one Windows device (Assist helper, console
// session). Mounted at /endpoint-messages/conversations.
//
// - Writes need `endpoint_messages:send` (plan N6: no separate chat
//   permission) and MFA, like a send. Opening and messaging also need a
//   human interactive session: a live chat is a person typing, never an API
//   key, OAuth grant or AI surface.
// - Reads need `endpoint_messages:read`.
// - Audit: open and close rows with counts and a body hash; message bodies are
//   never audited.
// - A chat never grants remote access; nothing here touches consent.
export const conversationRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({ deviceId: z.string().uuid() });
const readQuerySchema = z.object({ since: z.string().datetime({ offset: true }).optional() });

function requireHumanSession(auth: AuthContext): boolean {
  return auth.principal?.kind === 'user_session';
}

const callerOf = (c: { get: (k: string) => unknown }) => ({
  auth: c.get('auth') as AuthContext,
  permissions: c.get('permissions') as UserPermissions | undefined,
});

conversationRoutes.post(
  '/',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_SEND.resource, PERMISSIONS.ENDPOINT_MESSAGES_SEND.action),
  requireMfa(),
  zValidator('json', endpointChatOpenSchema),
  async (c) => {
    const caller = callerOf(c);
    if (!requireHumanSession(caller.auth)) return c.json({ error: 'human_session_required' }, 403);
    const input = c.req.valid('json') as EndpointChatOpenInput;
    const outcome = await openEndpointChat(caller, input);
    if (!outcome.ok) return c.json(outcome.body, outcome.status);
    if (!outcome.replay) {
      await writeAuditEventAsync(c, {
        orgId: outcome.deviceOrgId,
        action: 'endpoint_chat.open',
        resourceType: 'endpoint_conversation',
        resourceId: outcome.conversation.id,
        actorType: 'user',
        actorId: caller.auth.user.id,
        actorEmail: caller.auth.user.email,
        details: {
          conversationId: outcome.conversation.id,
          deviceId: outcome.conversation.deviceId,
          allowUserReply: outcome.conversation.allowUserReply,
          bodySha256: outcome.bodySha256,
          bodyLength: input.body.length,
        },
        ipAddress: getTrustedClientIpOrUndefined(c),
      });
    }
    return c.json({ conversation: outcome.conversation, messages: outcome.messages }, outcome.status);
  },
);

conversationRoutes.get(
  '/',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_READ.resource, PERMISSIONS.ENDPOINT_MESSAGES_READ.action),
  zValidator('query', listQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('query');
    const conversations = await listDeviceConversations({ ...callerOf(c), deviceId });
    return c.json({ conversations });
  },
);

conversationRoutes.get(
  '/:id',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_READ.resource, PERMISSIONS.ENDPOINT_MESSAGES_READ.action),
  zValidator('param', idParamSchema),
  zValidator('query', readQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { since } = c.req.valid('query');
    const found = await findConversationForCaller({ ...callerOf(c), conversationId: id });
    if (!found) return c.json({ error: 'not_found' }, 404);
    const messages = await readConversationMessages(id, since ? new Date(since) : undefined);
    return c.json({ conversation: conversationView(found.conversation, found.openedByName), messages });
  },
);

conversationRoutes.post(
  '/:id/messages',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_SEND.resource, PERMISSIONS.ENDPOINT_MESSAGES_SEND.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', endpointChatMessageSchema),
  async (c) => {
    const caller = callerOf(c);
    if (!requireHumanSession(caller.auth)) return c.json({ error: 'human_session_required' }, 403);
    const { id } = c.req.valid('param');
    const outcome = await sendEndpointChatMessage(caller, id, c.req.valid('json') as EndpointChatMessageInput);
    if (!outcome.ok) return c.json(outcome.body, outcome.status);
    return c.json({ message: outcome.message }, outcome.status);
  },
);

conversationRoutes.post(
  '/:id/close',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_SEND.resource, PERMISSIONS.ENDPOINT_MESSAGES_SEND.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const caller = callerOf(c);
    const { id } = c.req.valid('param');
    const outcome = await closeEndpointChat(caller, id, 'technician');
    if (!outcome.ok) return c.json(outcome.body, outcome.status);
    if (!outcome.alreadyClosed) {
      await writeAuditEventAsync(c, {
        orgId: outcome.conversation.orgId,
        action: 'endpoint_chat.close',
        resourceType: 'endpoint_conversation',
        resourceId: outcome.conversation.id,
        actorType: 'user',
        actorId: caller.auth.user.id,
        actorEmail: caller.auth.user.email,
        details: {
          conversationId: outcome.conversation.id,
          deviceId: outcome.conversation.deviceId,
          reason: 'technician',
          messagesToUser: outcome.counts?.toUser ?? 0,
          messagesFromUser: outcome.counts?.fromUser ?? 0,
          agentNotified: outcome.agentNotified,
        },
        ipAddress: getTrustedClientIpOrUndefined(c),
      });
    }
    return c.json({ conversation: outcome.conversation, alreadyClosed: outcome.alreadyClosed });
  },
);
