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
    if (!code || !state) throw new HTTPException(400, { message: 'Missing code/state' });
    if (!(await consumeState(state, auth.partnerId))) {
      throw new HTTPException(400, { message: 'Invalid state' });
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
    return c.json({ connected: true, stripeAccountId });
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
