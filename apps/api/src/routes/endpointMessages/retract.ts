import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { retractEndpointMessage } from '../../services/endpointMessaging/retract';

// Retract an endpoint message (#8742 W02). Needs the send permission (the
// same people who can put a card on screen can take it down) but, unlike
// send, no fresh MFA: retracting carries no content and must stay fast when a
// message went out by mistake.
export const retractRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().uuid() });

retractRoutes.post(
  '/:id/retract',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_SEND.resource, PERMISSIONS.ENDPOINT_MESSAGES_SEND.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const outcome = await retractEndpointMessage({
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      messageRowId: id,
    });
    if (outcome.kind === 'not_found') return c.json({ error: 'not_found' }, 404);

    const failedByCode: Record<string, number> = {};
    for (const r of outcome.results) if (r.status === 'failed') failedByCode[r.errorCode] = (failedByCode[r.errorCode] ?? 0) + 1;
    await writeAuditEventAsync(c, {
      orgId: outcome.orgId,
      action: 'endpoint_message.retract',
      resourceType: 'endpoint_message',
      resourceId: outcome.id,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      details: {
        alreadyRetracted: outcome.alreadyRetracted,
        retracted: outcome.results.filter((r) => r.status === 'retracted').length,
        failed: outcome.results.filter((r) => r.status === 'failed').length,
        failedByCode,
        ...(auth.aiOrigin ? { aiOrigin: true } : {}),
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
    });

    return c.json({
      id: outcome.id,
      retractedAt: outcome.retractedAt,
      alreadyRetracted: outcome.alreadyRetracted,
      results: outcome.results,
    });
  },
);
