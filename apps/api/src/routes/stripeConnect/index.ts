import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  buildOAuthUrl,
  getConnection,
  consumeState,
  completeOAuth,
  disconnect,
} from '../../services/stripeConnectService';

export const stripeConnectRoutes = new Hono();

// Web app base URL (mirrors routes/portal/invoices.ts). The OAuth callback is a
// browser redirect from Stripe, so it must land the user back on a real page —
// the partner billing-settings page — rather than returning raw JSON.
function billingSettingsUrl(params: Record<string, string>): string {
  const base = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || 'http://localhost:4321').replace(/\/$/, '');
  const qs = new URLSearchParams(params).toString();
  return `${base}/settings/billing${qs ? `?${qs}` : ''}`;
}

stripeConnectRoutes.use('*', authMiddleware);

stripeConnectRoutes.post(
  '/oauth/start',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    const { url } = await buildOAuthUrl({ partnerId: auth.partnerId, userId: auth.user.id });
    return c.json({ url });
  }
);

// Callback is hit by Stripe's browser redirect carrying the user's session.
stripeConnectRoutes.get(
  '/oauth/callback',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    const code = c.req.query('code');
    const state = c.req.query('state');
    // Invalid/expired/forged callbacks redirect back to billing settings with an
    // error flag — a raw 400 JSON body would strand the user on an API URL.
    if (!code || !state) {
      return c.redirect(billingSettingsUrl({ stripe_error: 'missing_params' }));
    }
    if (!(await consumeState(state, auth.partnerId))) {
      return c.redirect(billingSettingsUrl({ stripe_error: 'invalid_state' }));
    }
    const { stripeAccountId } = await completeOAuth({
      code,
      partnerId: auth.partnerId,
      userId: auth.user.id,
    });
    writeRouteAudit(c, {
      orgId: null,
      action: 'stripe_connect.connected',
      resourceType: 'partner',
      resourceId: auth.partnerId,
      details: { stripeAccountId },
    });
    return c.redirect(billingSettingsUrl({ stripe_connected: '1' }));
  }
);

stripeConnectRoutes.get(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    const row = await getConnection(auth.partnerId);
    if (!row || row.status !== 'connected') return c.json({ status: 'disconnected' });
    return c.json({ status: 'connected', stripeAccountId: row.stripeAccountId, livemode: row.livemode });
  }
);

stripeConnectRoutes.delete(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    await disconnect(auth.partnerId);
    writeRouteAudit(c, {
      orgId: null,
      action: 'stripe_connect.disconnected',
      resourceType: 'partner',
      resourceId: auth.partnerId,
    });
    return c.json({ status: 'disconnected' });
  }
);
