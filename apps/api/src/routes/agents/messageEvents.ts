import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext } from '../../db';
import { deviceCommands } from '../../db/schema';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { getRedis } from '../../services/redis';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { recordDeliveryEvent } from '../../services/endpointMessaging/receipts';
import { recordChatReply } from '../../services/endpointMessaging/chatReplies';
import { ENDPOINT_CHAT_LIMITS } from '@breeze/shared';

// Endpoint messaging (#8741 W1): the main agent reports what the signed-in
// user did with a technician message (card displayed, acknowledged, dismissed,
// expired). The acting user is agent-attested, so this is deliberately the
// agent bearer route and NOT the helper token route.
//
// W2 sink (#8742) = an endpoint_message_receipts row + the delivery aggregate;
// pre-W2 messages (no delivery row) keep the W1 audit_logs sink for a release.
//
// Trust boundary: org, device and batch are NEVER taken from the body. The org
// and device come from the authenticated agent context; the batch comes from
// the notify_user command row the API itself queued for this device.

const MESSAGE_EVENT_DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;
// A chat reply carries up to 2000 characters, i.e. up to 8 000 UTF-8 bytes.
const MAX_BODY_BYTES = 16 * 1024;

const attestedSessionSchema = z.object({
  username: z.string().min(1).max(256),
  sid: z.string().min(1).max(256).optional(),
  winSessionId: z.number().int().min(0).max(1_000_000).optional(),
});

export const messageEventSchema = z.object({
  messageId: z.string().uuid(),
  batchId: z.string().uuid(),
  eventType: z.enum(['displayed', 'acknowledged', 'dismissed', 'expired']),
  session: z.object({
    username: z.string().min(1).max(256),
    sid: z.string().min(1).max(256).optional(),
    winSessionId: z.number().int().min(0).max(1_000_000).optional(),
  }),
  at: z.string().datetime({ offset: true }),
});

/**
 * Endpoint live chat (#8743 W03): an end-user reply relayed by the agent. The
 * conversation must belong to the authenticated device; the session is the
 * broker's attested helper session. The body is plain text (rendered as
 * text, never markup, in the console).
 */
export const chatReplyEventSchema = z.object({
  eventType: z.literal('chat_reply'),
  conversationId: z.string().uuid(),
  clientNonce: z.string().uuid(),
  // Characters (code points), the unit the agent (runes) and helper (Unicode
  // scalars) enforce — not UTF-16 units, which would 400 an emoji-heavy reply
  // both of them accepted.
  body: z.string().trim().min(1).refine((b) => [...b].length <= ENDPOINT_CHAT_LIMITS.bodyMax, {
    message: `body must be at most ${ENDPOINT_CHAT_LIMITS.bodyMax} characters`,
  }),
  session: attestedSessionSchema,
  at: z.string().datetime({ offset: true }),
}).strict();

const agentEventSchema = z.union([chatReplyEventSchema, messageEventSchema]);

export const messageEventsRoutes = new Hono();
// Attested user events are the main agent's job; reject watchdog tokens.
messageEventsRoutes.use('*', requireAgentRole);

messageEventsRoutes.post(
  '/:id/message-events',
  async (c, next) => {
    const len = Number.parseInt(c.req.header('content-length') ?? '', 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) return c.json({ error: 'Body too large' }, 413);
    return next();
  },
  zValidator('json', agentEventSchema),
  async (c) => {
    const parsed = c.req.valid('json');
    const agent = c.get('agent') as { deviceId?: string; orgId?: string } | undefined;
    if (!agent?.deviceId || !agent.orgId) {
      return c.json({ error: 'Agent context missing device or organization' }, 401);
    }
    const { deviceId, orgId } = agent;

    if (parsed.eventType === 'chat_reply') {
      const outcome = await recordChatReply({
        deviceId,
        conversationId: parsed.conversationId,
        clientNonce: parsed.clientNonce,
        body: parsed.body,
        session: parsed.session,
      });
      switch (outcome.kind) {
        case 'accepted':
          return c.json({ ok: true, duplicate: outcome.duplicate });
        case 'unknown_conversation':
          return c.json({ error: 'unknown_conversation' }, 404);
        case 'conversation_closed':
          return c.json({ error: 'conversation_closed' }, 409);
        case 'replies_disabled':
          return c.json({ error: 'replies_disabled' }, 403);
        case 'rate_limited':
          return c.json({ error: 'rate_limited', retryAfterSeconds: outcome.retryAfterSeconds }, 429);
      }
    }
    const event = parsed;

    // Proof the message was sent to THIS device. device_commands has no RLS,
    // so the device filter is the whole boundary. The row survives terminal
    // erasure (only title/body are stripped).
    const [sent] = await db
      .select({
        id: deviceCommands.id,
        batchId: sql<string | null>`${deviceCommands.payload}->>'batchId'`,
      })
      .from(deviceCommands)
      .where(and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, 'notify_user'),
        sql`${deviceCommands.payload}->>'messageId' = ${event.messageId}`,
      ))
      // A client message id is reused when an all-failed send is retried; the
      // newest command on this device is the one the card came from.
      .orderBy(desc(deviceCommands.createdAt))
      .limit(1);
    if (!sent) return c.json({ error: 'Unknown message' }, 404);

    const sessionKey = event.session.sid
      ?? (event.session.winSessionId !== undefined ? String(event.session.winSessionId) : event.session.username);

    // W2 sink: a receipt row on the delivery, deduped by the DB unique key.
    const receipt = await recordDeliveryEvent({
      deviceId,
      commandId: sent.id,
      batchId: sent.batchId,
      messageId: event.messageId,
      sessionKey,
      sessionUsername: event.session.username,
      eventType: event.eventType,
      occurredAt: new Date(event.at),
    });
    if (receipt.found) return c.json({ ok: true, duplicate: !receipt.inserted });

    // One-release fallback: a message sent before W2 has no delivery row, so
    // its events still land as Redis-deduped audit rows (the W1 sink).
    const dedupKey = `endpoint-msg-event:${deviceId}:${event.messageId}:${sessionKey}:${event.eventType}`;

    // Redis round-trip outside the request's held DB transaction (#1105).
    const redis = getRedis();
    if (!redis) return c.json({ error: 'Event store unavailable' }, 503);
    const claimed = await runOutsideDbContext(() =>
      redis.set(dedupKey, '1', 'EX', MESSAGE_EVENT_DEDUP_TTL_SECONDS, 'NX'),
    );
    if (claimed !== 'OK') return c.json({ ok: true, duplicate: true });

    await writeAuditEventAsync(c, {
      orgId,
      action: `endpoint_message.${event.eventType}`,
      resourceType: 'endpoint_message',
      resourceId: event.messageId,
      actorType: 'agent',
      actorId: deviceId,
      details: {
        messageId: event.messageId,
        // The batch we queued, not the agent's claim.
        batchId: sent.batchId ?? event.batchId,
        deviceId,
        eventType: event.eventType,
        session: event.session,
        at: event.at,
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
    });

    return c.json({ ok: true, duplicate: false });
  },
);
