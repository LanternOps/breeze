import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { restoreBillingFraudRestriction } from '../../services/partnerTrustFraudFlags';

/**
 * One-click restore of a partner restricted by a billing fraud flag
 * (billing#51). Mounted under the platform-admin middleware in ./index.ts;
 * the MFA requirement matches promote/restrict in ./trust.ts. The trust audit
 * row (partner.trust.promoted / partner.trust.probation, reason
 * admin:fraud_flag_restore) is written by setTrustState inside the service.
 */
export const trustFraudFlagAdminRoutes = new Hono();

const paramsSchema = z.object({ id: z.string().uuid() });
const restoreSchema = z.object({
  // Exactly the restriction's ledger rows as the queue showed them, so a flag
  // that arrived since is never cleared unseen.
  flagIds: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().trim().max(500).optional(),
});

trustFraudFlagAdminRoutes.post(
  '/partners/:id/trust/fraud-flag-restore',
  requireMfa(),
  zValidator('param', paramsSchema),
  zValidator('json', restoreSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { flagIds, reason } = c.req.valid('json');
    const result = await restoreBillingFraudRestriction({
      partnerId: id,
      actorUserId: auth.user.id,
      flagIds,
      operatorReason: reason || null,
    });
    if (result.status === 'not_restorable') {
      return c.json({
        error: 'This partner has no billing fraud flag restriction to restore. Use promote with override instead.',
      }, 409);
    }
    if (result.status === 'stale') {
      return c.json({ error: 'The restriction changed since the queue was loaded; refresh and retry.' }, 409);
    }
    return c.json({ success: true, trustState: result.trustState, restoredFlagIds: result.restoredFlagIds });
  },
);
