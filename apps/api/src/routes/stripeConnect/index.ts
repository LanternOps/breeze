import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  savePartnerStripeKey,
  getPartnerStripeAccountSnapshot,
  refreshPartnerStripeAccount,
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
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
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
        defaultCurrency: result.defaultCurrency,
        accountCountry: result.accountCountry,
        accountRefreshedAt: result.accountRefreshedAt.toISOString(),
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
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: 'Viewing the partner Stripe configuration requires full partner org access (orgAccess must be "all")' });
    // ONE snapshot: status, display fields and cached account facts come from
    // the same row read (or the same RETURNING'd refresh) — never a status read
    // combined with a separate cache read (review F9). The cache state is part
    // of the contract: `stale` = Stripe unreachable, cached value shown;
    // `reconnect_required` = the stored key no longer works and the partner
    // must paste a new one — reported as such, never as "connected" (review F4).
    const snap = await getPartnerStripeAccountSnapshot(auth.partnerId);
    if (!snap.connected) return c.json({ status: 'disconnected', last4: snap.last4 });
    return c.json({
      status: snap.cacheState === 'reconnect_required' ? 'reconnect_required' : 'connected',
      stripeAccountId: snap.stripeAccountId,
      livemode: snap.livemode,
      last4: snap.last4,
      defaultCurrency: snap.defaultCurrency,
      accountCountry: snap.accountCountry,
      accountRefreshedAt: snap.accountRefreshedAt?.toISOString() ?? null,
      cacheState: snap.cacheState,
      stale: snap.cacheState !== 'fresh',
      error: snap.error,
    });
  }
);

stripeConnectRoutes.post(
  '/refresh',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    try {
      const result = await refreshPartnerStripeAccount(auth.partnerId);
      writeRouteAudit(c, {
        orgId: null,
        action: 'stripe_connect.account_refreshed',
        resourceType: 'partner',
        resourceId: auth.partnerId,
        details: {
          defaultCurrency: result.defaultCurrency,
          accountCountry: result.accountCountry,
        },
      });
      return c.json({
        status: 'connected',
        stripeAccountId: result.stripeAccountId,
        livemode: result.livemode,
        last4: result.last4,
        defaultCurrency: result.defaultCurrency,
        accountCountry: result.accountCountry,
        accountRefreshedAt: result.accountRefreshedAt.toISOString(),
        cacheState: 'fresh',
        stale: false,
        error: null,
      });
    } catch (err) {
      if (err instanceof PartnerStripeError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  }
);

stripeConnectRoutes.delete(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
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
