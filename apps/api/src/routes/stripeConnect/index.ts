import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  savePartnerStripeKey,
  getPartnerStripeStatus,
  disconnectPartnerStripe,
  PartnerStripeError,
} from '../../services/partnerStripe';

export const stripeConnectRoutes = new Hono();

// The partner pastes their OWN Stripe secret/restricted key. Stripe keys are
// `sk_*` / `rk_*` (live or test). We don't hard-validate the exact format here —
// savePartnerStripeKey proves the key by retrieving the account it belongs to —
// but a min length blocks empty/obviously-truncated pastes before a Stripe round-trip.
const saveKeySchema = z.object({
  apiKey: z.string().trim().min(12, 'Enter a valid Stripe secret key (sk_… or rk_…).'),
});

stripeConnectRoutes.use('*', authMiddleware);

// POST /key — paste/replace the partner's Stripe API key (replaces Connect OAuth).
// MFA-gated: storing a live payment credential is a sensitive billing action.
stripeConnectRoutes.post(
  '/key',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  zValidator('json', saveKeySchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    const { apiKey } = c.req.valid('json');
    try {
      const result = await savePartnerStripeKey({
        partnerId: auth.partnerId,
        apiKey,
        userId: auth.user.id,
      });
      writeRouteAudit(c, {
        orgId: null,
        action: 'stripe_connect.connected',
        resourceType: 'partner',
        resourceId: auth.partnerId,
        details: { stripeAccountId: result.stripeAccountId, livemode: result.livemode },
      });
      return c.json({
        status: 'connected',
        stripeAccountId: result.stripeAccountId,
        livemode: result.livemode,
        last4: result.last4,
      });
    } catch (err) {
      // A rejected/unreadable key is a user-actionable 400/409/500 with a clear
      // message — never a generic 500 that hides why the paste failed.
      if (err instanceof PartnerStripeError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  }
);

stripeConnectRoutes.get(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    const status = await getPartnerStripeStatus(auth.partnerId);
    if (!status.connected) return c.json({ status: 'disconnected', last4: status.last4 });
    return c.json({
      status: 'connected',
      stripeAccountId: status.stripeAccountId,
      livemode: status.livemode,
      last4: status.last4,
    });
  }
);

stripeConnectRoutes.delete(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    await disconnectPartnerStripe(auth.partnerId);
    writeRouteAudit(c, {
      orgId: null,
      action: 'stripe_connect.disconnected',
      resourceType: 'partner',
      resourceId: auth.partnerId,
    });
    return c.json({ status: 'disconnected' });
  }
);
