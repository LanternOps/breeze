import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext } from '../../db';
import { deviceCommands } from '../../db/schema';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { getRedis } from '../../services/redis';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

// Endpoint messaging (#8741 W1): the main agent reports what the signed-in
// user did with a technician message (card displayed, acknowledged, dismissed,
// expired). The acting user is agent-attested, so this is deliberately the
// agent bearer route and NOT the helper token route.
//
// W1 sink = one audit_logs row in the device's org. W2 replaces the sink with
// receipt rows + a DB unique constraint; the wire contract stays.
//
// Trust boundary: org, device and batch are NEVER taken from the body. The org
// and device come from the authenticated agent context; the batch comes from
// the notify_user command row the API itself queued for this device.

const MESSAGE_EVENT_DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 8 * 1024;

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
  zValidator('json', messageEventSchema),
  async (c) => {
    const event = c.req.valid('json');
    const agent = c.get('agent') as { deviceId?: string; orgId?: string } | undefined;
    if (!agent?.deviceId || !agent.orgId) {
      return c.json({ error: 'Agent context missing device or organization' }, 401);
    }
    const { deviceId, orgId } = agent;

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
      .limit(1);
    if (!sent) return c.json({ error: 'Unknown message' }, 404);

    const sessionKey = event.session.sid
      ?? (event.session.winSessionId !== undefined ? String(event.session.winSessionId) : event.session.username);
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
