import { Hono } from 'hono';
import { randomBytes } from 'crypto';
import { eq, and, gt } from 'drizzle-orm';
import { db } from '../../db';
import { c2cConnections, c2cConsentSessions } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import {
  getPlatformConfig,
  buildAdminConsentUrl,
  getCallbackUri,
  getFrontendBaseUrl,
  acquireClientCredentialsToken,
  testGraphAccess,
} from '../../services/c2cM365';
import { resolveScopedOrgId } from './helpers';

// ── Authenticated routes (behind authMiddleware) ───────────────────────────

export const m365AuthRoutes = new Hono();

/** Check whether the platform multi-tenant app is configured. */
m365AuthRoutes.get('/m365/config', async (c) => {
  const config = getPlatformConfig();
  return c.json({ platformAppAvailable: !!config });
});

/** Generate a Microsoft admin consent URL with CSRF state. */
m365AuthRoutes.get('/m365/consent-url', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const config = getPlatformConfig();
  if (!config) {
    return c.json({ error: 'Multi-tenant app is not configured on this instance' }, 400);
  }

  const displayName = c.req.query('displayName') || 'Microsoft 365';
  const scopes = c.req.query('scopes') || '';

  const state = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.insert(c2cConsentSessions).values({
    orgId,
    state,
    provider: 'microsoft_365',
    displayName,
    scopes: scopes || null,
    expiresAt,
  });

  const url = buildAdminConsentUrl({
    clientId: config.clientId,
    state,
    redirectUri: getCallbackUri(),
  });

  return c.json({ url });
});

// ── Public callback (mounted separately, no auth middleware) ───────────────

export const m365CallbackRoute = new Hono();

/** Truncate error messages for safe URL embedding. */
function safeErrorMsg(msg: string, maxLen = 400): string {
  return msg.length > maxLen ? msg.slice(0, maxLen) + '...' : msg;
}

/**
 * Microsoft redirects here after admin consent.
 * Success: ?tenant=GUID&admin_consent=True&state=STATE
 * Error:   ?error=CODE&error_description=DESC&state=STATE
 */
m365CallbackRoute.get('/c2c/m365/callback', async (c) => {
  const frontendBase = getFrontendBaseUrl();
  const state = c.req.query('state');
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');

  if (error) {
    console.warn('[c2c/m365/callback] Microsoft returned OAuth error', { error, errorDescription, state: state ?? 'missing' });
    const msg = encodeURIComponent(safeErrorMsg(errorDescription || error));
    return c.redirect(`${frontendBase}/c2c?c2c_error=${msg}`);
  }

  if (!state) {
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Missing state parameter')}`);
  }

  // Validate and consume session atomically (prevents replay attacks)
  const [session] = await db
    .delete(c2cConsentSessions)
    .where(
      and(
        eq(c2cConsentSessions.state, state),
        gt(c2cConsentSessions.expiresAt, new Date())
      )
    )
    .returning();

  if (!session) {
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Invalid or expired consent session')}`);
  }

  const tenantId = c.req.query('tenant');
  const adminConsent = c.req.query('admin_consent');

  if (!tenantId || adminConsent !== 'True') {
    console.warn('[c2c/m365/callback] Admin consent not granted', { tenantId, adminConsent, orgId: session.orgId });
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Admin consent was not granted')}`);
  }

  try {
    const config = getPlatformConfig();
    if (!config) {
      console.error('[c2c/m365/callback] Platform app env vars missing during callback', { orgId: session.orgId });
      return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Platform app no longer configured')}`);
    }

    // Acquire access token via client_credentials grant
    const tokenResult = await acquireClientCredentialsToken({
      tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    // Validate token works by calling Graph API
    const graphTest = await testGraphAccess(tokenResult.accessToken);
    const displayName =
      session.displayName ||
      (graphTest.ok && graphTest.orgDisplayName
        ? `Microsoft 365 - ${graphTest.orgDisplayName}`
        : 'Microsoft 365');

    const now = new Date();
    const tokenExpiresAt = new Date(Date.now() + tokenResult.expiresIn * 1000);

    // Create the connection
    const [connection] = await db
      .insert(c2cConnections)
      .values({
        orgId: session.orgId,
        provider: 'microsoft_365',
        authMethod: 'platform_app',
        displayName,
        tenantId,
        clientId: null,
        clientSecret: null,
        accessToken: tokenResult.accessToken,
        tokenExpiresAt,
        scopes: session.scopes || null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!connection) {
      console.error('[c2c/m365/callback] Connection insert returned no row', { orgId: session.orgId, tenantId });
      return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Failed to create connection')}`);
    }

    // Audit log the connection creation
    writeAuditEvent(c, {
      orgId: session.orgId,
      actorType: 'system',
      actorId: session.orgId,
      action: 'c2c.connection.create',
      resourceType: 'c2c_connection',
      resourceId: connection.id,
      resourceName: connection.displayName,
      details: { provider: 'microsoft_365', authMethod: 'platform_app', tenantId },
    });

    return c.redirect(
      `${frontendBase}/c2c?c2c_connected=true&connectionId=${connection.id}`
    );
  } catch (err) {
    console.error('[c2c/m365/callback] Consent callback failed', {
      orgId: session.orgId,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err);

    const msg = err instanceof Error ? safeErrorMsg(err.message) : 'Unknown error during consent callback';
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent(msg)}`);
  }
});
