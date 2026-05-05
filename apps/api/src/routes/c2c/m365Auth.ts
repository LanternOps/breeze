import { Hono } from 'hono';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { eq, and, gt } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { c2cConnections, c2cConsentSessions } from '../../db/schema';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { writeAuditEvent } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { encryptSecret } from '../../services/secretCrypto';
import {
  getPlatformConfig,
  buildAdminConsentUrl,
  getCallbackUri,
  getFrontendBaseUrl,
  acquireClientCredentialsToken,
  testGraphAccess,
} from '../../services/c2cM365';
import { resolveScopedOrgId } from './helpers';
import { getCookieValue } from '../auth/helpers';
import { PERMISSIONS } from '../../services/permissions';

const M365_CONSENT_COOKIE_NAME = 'breeze_c2c_m365_consent';
const M365_CONSENT_COOKIE_PATH = '/api/v1/c2c/m365/callback';
const M365_CONSENT_COOKIE_MAX_AGE_SECONDS = 10 * 60;

function isSecureCookieEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

function buildCookieSecuritySuffix(): string {
  return `; SameSite=Lax${isSecureCookieEnvironment() ? '; Secure' : ''}`;
}

function buildConsentCookieValue(state: string): string | null {
  // Use only secrets intended for server-side cryptographic operations.
  // JWT_SECRET and AGENT_ENROLLMENT_SECRET are excluded to maintain key
  // separation — using enrollment secrets for cookie signing would let a
  // compromise of either system compromise both.
  const secret =
    getPlatformConfig()?.clientSecret?.trim()
    || process.env.APP_ENCRYPTION_KEY?.trim()
    || process.env.SECRET_ENCRYPTION_KEY?.trim();

  if (!secret) {
    return null;
  }

  return createHmac('sha256', secret).update(`c2c-m365-consent:${state}`).digest('hex');
}

function buildConsentCookie(state: string): string | null {
  const value = buildConsentCookieValue(state);
  if (!value) return null;
  return `${M365_CONSENT_COOKIE_NAME}=${encodeURIComponent(value)}; Path=${M365_CONSENT_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix()}; Max-Age=${M365_CONSENT_COOKIE_MAX_AGE_SECONDS}`;
}

function buildClearConsentCookie(): string {
  return `${M365_CONSENT_COOKIE_NAME}=; Path=${M365_CONSENT_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix()}; Max-Age=0`;
}

function isValidConsentCookie(state: string, cookieHeader: string | undefined): boolean {
  const cookieValue = getCookieValue(cookieHeader, M365_CONSENT_COOKIE_NAME);
  const expected = buildConsentCookieValue(state);
  if (!cookieValue || !expected) {
    return false;
  }

  const left = Buffer.from(cookieValue, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function buildStoredScopeMetadata(requestedScopes: string | null | undefined): string {
  const requested = requestedScopes?.trim();
  return [
    'token_scope=https://graph.microsoft.com/.default',
    `requested_display_scopes=${requested && requested.length > 0 ? requested : 'none'}`,
    'actual_grants=Entra admin-consented application permissions'
  ].join('; ');
}

// ── Authenticated routes (behind authMiddleware) ───────────────────────────

export const m365AuthRoutes = new Hono();
const requireC2cRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireC2cWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

/** Check whether the platform multi-tenant app is configured. */
m365AuthRoutes.get('/m365/config', requireC2cRead, async (c) => {
  const config = getPlatformConfig();
  return c.json({ platformAppAvailable: !!config });
});

/** Generate a Microsoft admin consent URL with CSRF state. */
m365AuthRoutes.get('/m365/consent-url', requireC2cWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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
    userId: auth.user?.id ?? null,
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

  const consentCookie = buildConsentCookie(state);
  if (!consentCookie) {
    return c.json({ error: 'Consent flow cookie secret is not configured on this instance' }, 500);
  }
  c.header('Set-Cookie', consentCookie, { append: true });

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
  // Public callback — no authMiddleware runs, so no db scope is set.
  // The handler writes to c2c_consent_sessions and c2c_connections, both
  // under RLS. Run the whole body in system scope so RLS policies pass;
  // the OAuth state cookie + signed state value provide authentication.
  return withSystemDbAccessContext(async () => {
  const frontendBase = getFrontendBaseUrl();
  const state = c.req.query('state');
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');

  const clearCookie = () => {
    c.header('Set-Cookie', buildClearConsentCookie(), { append: true });
  };

  if (error) {
    console.warn('[c2c/m365/callback] Microsoft returned OAuth error', { error, errorDescription, state: state ?? 'missing' });
    clearCookie();
    if (state) {
      await db
        .delete(c2cConsentSessions)
        .where(eq(c2cConsentSessions.state, state));
    }
    const msg = encodeURIComponent(safeErrorMsg(errorDescription || error));
    return c.redirect(`${frontendBase}/c2c?c2c_error=${msg}`);
  }

  if (!state) {
    clearCookie();
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Missing state parameter')}`);
  }

  if (!isValidConsentCookie(state, c.req.header('cookie'))) {
    console.warn('[c2c/m365/callback] Missing or invalid consent binding cookie', { state });
    clearCookie();
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Invalid or expired consent session')}`);
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
    clearCookie();
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Invalid or expired consent session')}`);
  }

  if (session.userId) {
    console.warn('[c2c/m365/callback] Consent session user binding is advisory only on public callback', {
      orgId: session.orgId,
      userId: session.userId,
      provider: session.provider,
      reason: 'jwt_unavailable_on_public_callback',
    });
  }

  const tenantId = c.req.query('tenant');
  const adminConsent = c.req.query('admin_consent');

  if (!tenantId || adminConsent !== 'True') {
    console.warn('[c2c/m365/callback] Admin consent not granted', { tenantId, adminConsent, orgId: session.orgId });
    clearCookie();
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent('Admin consent was not granted')}`);
  }

  try {
    const config = getPlatformConfig();
    if (!config) {
      console.error('[c2c/m365/callback] Platform app env vars missing during callback', { orgId: session.orgId });
      clearCookie();
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
    const storedScopeMetadata = buildStoredScopeMetadata(session.scopes);

    const [existing] = await db
      .select()
      .from(c2cConnections)
      .where(and(
        eq(c2cConnections.orgId, session.orgId),
        eq(c2cConnections.provider, 'microsoft_365'),
        eq(c2cConnections.authMethod, 'platform_app'),
        eq(c2cConnections.tenantId, tenantId),
      ))
      .limit(1);

    if (existing && existing.status !== 'revoked') {
      await db
        .update(c2cConnections)
        .set({
          displayName,
          accessToken: encryptSecret(tokenResult.accessToken),
          tokenExpiresAt,
          scopes: storedScopeMetadata,
          status: 'active',
          updatedAt: now,
        })
        .where(eq(c2cConnections.id, existing.id));

      clearCookie();
      return c.redirect(
        `${frontendBase}/c2c?c2c_connected=true&connectionId=${existing.id}`
      );
    }

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
        accessToken: encryptSecret(tokenResult.accessToken),
        tokenExpiresAt,
        scopes: storedScopeMetadata,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!connection) {
      console.error('[c2c/m365/callback] Connection insert returned no row', { orgId: session.orgId, tenantId });
      clearCookie();
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
      details: {
        provider: 'microsoft_365',
        authMethod: 'platform_app',
        tenantId,
        userId: session.userId ?? null,
      },
    });

    clearCookie();
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
    clearCookie();
    return c.redirect(`${frontendBase}/c2c?c2c_error=${encodeURIComponent(msg)}`);
  }
  });
});
