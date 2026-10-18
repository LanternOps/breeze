import { Hono } from 'hono';
import { z } from 'zod';
import {
  ENDPOINT_MESSAGE_LIMITS,
  endpointMessageResendSchema,
  type EndpointMessageResendInput,
  type EndpointMessageSendInput,
} from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { endpointMessages } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { messageReachesAllowedSites, resendTargets } from '../../services/endpointMessaging/history';
import { executeEndpointMessageSend } from './send';

// Resend an endpoint message (#8742 W02) to the devices it never reached
// (deliveries `failed` or `expired`). A resend is a NEW send with a fresh
// client message id, through the same pipeline as POST /endpoint-messages:
// same permission + MFA, caps, limits, version gate, persistence and audit.
// The content is the stored message's, never the request's.
export const resendRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().uuid() });
const MINUTE_MS = 60_000;

resendRoutes.post(
  '/:id/resend',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_SEND.resource, PERMISSIONS.ENDPOINT_MESSAGES_SEND.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', endpointMessageResendSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json') as EndpointMessageResendInput;

    const [m] = await db
      .select()
      .from(endpointMessages)
      .where(and(eq(endpointMessages.id, id), auth.orgCondition(endpointMessages.orgId)))
      .limit(1)
      // Serializes concurrent resends of one message: the request transaction
      // holds this lock until it ends, and the first resend's deliveries are
      // committed (persistSend) before that, so a second resend computes its
      // targets after them and finds nothing left to resend.
      .for('update');
    if (!m || !auth.canAccessOrg(m.orgId)) return c.json({ error: 'not_found' }, 404);
    // Site-clamped caller: a message with no delivery in their sites is not theirs to see.
    if (!(await messageReachesAllowedSites(m.id, c.get('permissions') as UserPermissions | undefined))) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (m.retractedAt) return c.json({ error: 'retracted' }, 409);
    if (m.bodyPurgedAt || m.title === null || m.body === null) return c.json({ error: 'body_purged' }, 409);

    const deviceIds = await resendTargets(m.id);
    if (deviceIds.length === 0) return c.json({ error: 'nothing_to_resend' }, 400);

    const originalMinutes = Math.round((m.expiresAt.getTime() - m.createdAt.getTime()) / MINUTE_MS);
    const input: EndpointMessageSendInput = {
      messageId: body.messageId,
      targets: { deviceIds },
      title: m.title,
      body: m.body,
      severity: m.severity,
      requiresAck: m.requiresAck,
      expiresInMinutes: Math.min(Math.max(originalMinutes, 1), ENDPOINT_MESSAGE_LIMITS.maxExpiresInMinutes),
      // The operator chose these devices by pressing resend on this batch.
      confirmedCount: deviceIds.length,
    };
    const outcome = await executeEndpointMessageSend({
      req: c,
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      ipAddress: getTrustedClientIpOrUndefined(c),
      resendOfId: m.id,
    }, input);
    return c.json(outcome.body, outcome.status);
  },
);
