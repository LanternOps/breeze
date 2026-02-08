import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, gt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db';
import {
  ssoProviders,
  ssoSessions,
  userSsoIdentities,
  users,
  organizationUsers,
  roles
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import {
  generateState,
  generateNonce,
  generatePKCEChallenge,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getUserInfo,
  decodeIdToken,
  verifyIdTokenClaims,
  mapUserAttributes,
  discoverOIDCConfig,
  PROVIDER_PRESETS,
  type OIDCConfig
} from '../services/sso';
import { createTokenPair, createSession } from '../services';
import { writeRouteAudit } from '../services/auditEvents';
import { decryptSecret, encryptSecret } from '../services/secretCrypto';

export const ssoRoutes = new Hono();

// ============================================
// Schemas
// ============================================

const createProviderSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['oidc', 'saml']),
  preset: z.string().optional(),
  issuer: z.string().url().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scopes: z.string().optional(),
  attributeMapping: z.object({
    email: z.string(),
    name: z.string(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    groups: z.string().optional()
  }).optional(),
  autoProvision: z.boolean().optional(),
  defaultRoleId: z.string().uuid().optional(),
  allowedDomains: z.string().optional(),
  enforceSSO: z.boolean().optional()
});

const updateProviderSchema = createProviderSchema.partial();
const tokenExchangeSchema = z.object({
  code: z.string().min(1)
});

// ============================================
// Helper Functions
// ============================================

type SsoTokenExchangeGrant = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  createdAtMs: number;
  expiresAtMs: number;
};

const ssoTokenExchangeGrants = new Map<string, SsoTokenExchangeGrant>();
const SSO_TOKEN_GRANT_TTL_MS = 2 * 60 * 1000;
const SSO_TOKEN_GRANT_CAP = 20000;
const SSO_TOKEN_SWEEP_INTERVAL_MS = 60 * 1000;

let lastSsoTokenSweepAtMs = 0;

function capMapByOldest<T>(
  map: Map<string, T>,
  cap: number,
  getAgeMs: (value: T) => number
) {
  if (map.size <= cap) {
    return;
  }

  const overflow = map.size - cap;
  const entries = Array.from(map.entries())
    .sort(([, left], [, right]) => getAgeMs(left) - getAgeMs(right));

  for (let i = 0; i < overflow; i++) {
    const key = entries[i]?.[0];
    if (key) {
      map.delete(key);
    }
  }
}

function sweepSsoTokenExchangeGrants(nowMs: number = Date.now()) {
  if (nowMs - lastSsoTokenSweepAtMs < SSO_TOKEN_SWEEP_INTERVAL_MS) {
    return;
  }

  lastSsoTokenSweepAtMs = nowMs;
  for (const [code, grant] of ssoTokenExchangeGrants.entries()) {
    if (grant.expiresAtMs <= nowMs) {
      ssoTokenExchangeGrants.delete(code);
    }
  }

  capMapByOldest(ssoTokenExchangeGrants, SSO_TOKEN_GRANT_CAP, (grant) => grant.createdAtMs);
}

function createSsoTokenExchangeGrant(
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number
): string {
  const nowMs = Date.now();
  sweepSsoTokenExchangeGrants(nowMs);

  const code = nanoid(48);
  ssoTokenExchangeGrants.set(code, {
    accessToken,
    refreshToken,
    expiresInSeconds,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + SSO_TOKEN_GRANT_TTL_MS
  });

  capMapByOldest(ssoTokenExchangeGrants, SSO_TOKEN_GRANT_CAP, (grant) => grant.createdAtMs);
  return code;
}

function consumeSsoTokenExchangeGrant(code: string): SsoTokenExchangeGrant | null {
  sweepSsoTokenExchangeGrants();

  const grant = ssoTokenExchangeGrants.get(code);
  if (!grant) {
    return null;
  }

  ssoTokenExchangeGrants.delete(code);
  if (grant.expiresAtMs <= Date.now()) {
    return null;
  }

  return grant;
}

function normalizeRedirectPath(redirectParam: string | undefined): string {
  if (!redirectParam) {
    return '/';
  }

  const trimmed = redirectParam.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return '/';
  }

  try {
    const parsed = new URL(trimmed, 'https://local.invalid');
    if (parsed.origin !== 'https://local.invalid') {
      return '/';
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function getOIDCConfig(provider: typeof ssoProviders.$inferSelect): OIDCConfig {
  const decryptedClientSecret = decryptSecret(provider.clientSecret);

  if (!provider.clientId || !decryptedClientSecret || !provider.issuer) {
    throw new Error('Provider is not fully configured');
  }

  return {
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: decryptedClientSecret,
    authorizationUrl: provider.authorizationUrl || `${provider.issuer}/authorize`,
    tokenUrl: provider.tokenUrl || `${provider.issuer}/oauth/token`,
    userInfoUrl: provider.userInfoUrl || `${provider.issuer}/userinfo`,
    jwksUrl: provider.jwksUrl || undefined,
    scopes: provider.scopes || 'openid profile email'
  };
}

function getClientIP(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown';
}

// ============================================
// Provider Management Routes (Admin)
// ============================================

// List provider presets
ssoRoutes.get('/presets', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  return c.json({
    data: Object.entries(PROVIDER_PRESETS).map(([key, preset]) => ({
      id: key,
      ...preset
    }))
  });
});

// List SSO providers for organization
ssoRoutes.get('/providers', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const orgId = c.req.query('orgId') || auth.orgId;

  if (!orgId) {
    return c.json({ error: 'Organization ID required' }, 400);
  }

  const providers = await db
    .select({
      id: ssoProviders.id,
      name: ssoProviders.name,
      type: ssoProviders.type,
      status: ssoProviders.status,
      issuer: ssoProviders.issuer,
      autoProvision: ssoProviders.autoProvision,
      enforceSSO: ssoProviders.enforceSSO,
      createdAt: ssoProviders.createdAt
    })
    .from(ssoProviders)
    .where(eq(ssoProviders.orgId, orgId));

  return c.json({ data: providers });
});

// Get SSO provider details
ssoRoutes.get('/providers/:id', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  const providerId = c.req.param('id');

  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.id, providerId))
    .limit(1);

  if (!provider) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  // Don't return client secret
  const { clientSecret, ...safeProvider } = provider;

  return c.json({ data: { ...safeProvider, hasClientSecret: !!clientSecret } });
});

// Create SSO provider
ssoRoutes.post('/providers', authMiddleware, requireScope('organization', 'partner', 'system'), zValidator('json', createProviderSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');
  const orgId = auth.orgId;

  if (!orgId) {
    return c.json({ error: 'Organization ID required' }, 400);
  }

  // Apply preset if specified
  let config: Partial<typeof ssoProviders.$inferInsert> = {};
  if (body.preset) {
    const preset = PROVIDER_PRESETS[body.preset];
    if (preset) {
      config = {
        scopes: preset.scopes,
        attributeMapping: preset.attributeMapping as any
      };
    }
  }

  // If issuer provided, try to discover endpoints
  if (body.issuer && body.type === 'oidc') {
    try {
      const discovery = await discoverOIDCConfig(body.issuer);
      config.authorizationUrl = discovery.authorization_endpoint;
      config.tokenUrl = discovery.token_endpoint;
      config.userInfoUrl = discovery.userinfo_endpoint;
      config.jwksUrl = discovery.jwks_uri;
    } catch (error) {
      // Discovery failed, user will need to provide URLs manually
      console.warn('OIDC discovery failed:', error);
    }
  }

  const [provider] = await db
    .insert(ssoProviders)
    .values({
      orgId,
      name: body.name,
      type: body.type,
      issuer: body.issuer,
      clientId: body.clientId,
      clientSecret: encryptSecret(body.clientSecret),
      scopes: body.scopes || config.scopes,
      attributeMapping: body.attributeMapping || config.attributeMapping,
      authorizationUrl: config.authorizationUrl,
      tokenUrl: config.tokenUrl,
      userInfoUrl: config.userInfoUrl,
      jwksUrl: config.jwksUrl,
      autoProvision: body.autoProvision ?? true,
      defaultRoleId: body.defaultRoleId,
      allowedDomains: body.allowedDomains,
      enforceSSO: body.enforceSSO ?? false,
      createdBy: auth.user.id,
      status: 'inactive'
    })
    .returning();

  if (!provider) {
    return c.json({ error: 'Failed to create provider' }, 500);
  }

  writeRouteAudit(c, {
    orgId: provider.orgId,
    action: 'sso.provider.create',
    resourceType: 'sso_provider',
    resourceId: provider.id,
    resourceName: provider.name,
    details: { type: provider.type, status: provider.status }
  });

  const { clientSecret, ...safeProvider } = provider;
  return c.json({ data: { ...safeProvider, hasClientSecret: !!clientSecret } }, 201);
});

// Update SSO provider
ssoRoutes.patch('/providers/:id', authMiddleware, requireScope('organization', 'partner', 'system'), zValidator('json', updateProviderSchema), async (c) => {
  const providerId = c.req.param('id');
  const body = c.req.valid('json');
  const updates: Partial<typeof ssoProviders.$inferInsert> = {
    ...body,
    updatedAt: new Date()
  };

  if (body.clientSecret !== undefined) {
    updates.clientSecret = encryptSecret(body.clientSecret);
  }

  const [updated] = await db
    .update(ssoProviders)
    .set(updates)
    .where(eq(ssoProviders.id, providerId))
    .returning();

  if (!updated) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId: updated.orgId,
    action: 'sso.provider.update',
    resourceType: 'sso_provider',
    resourceId: updated.id,
    resourceName: updated.name,
    details: { changedFields: Object.keys(body) }
  });

  const { clientSecret, ...safeProvider } = updated;
  return c.json({ data: { ...safeProvider, hasClientSecret: !!clientSecret } });
});

// Delete SSO provider
ssoRoutes.delete('/providers/:id', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  const providerId = c.req.param('id');

  // Delete related records first
  await db.delete(ssoSessions).where(eq(ssoSessions.providerId, providerId));
  await db.delete(userSsoIdentities).where(eq(userSsoIdentities.providerId, providerId));

  const [deleted] = await db
    .delete(ssoProviders)
    .where(eq(ssoProviders.id, providerId))
    .returning();

  if (!deleted) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId: deleted.orgId,
    action: 'sso.provider.delete',
    resourceType: 'sso_provider',
    resourceId: deleted.id,
    resourceName: deleted.name
  });

  return c.json({ success: true });
});

// Activate/Deactivate provider
ssoRoutes.post('/providers/:id/status', authMiddleware, requireScope('organization', 'partner', 'system'), zValidator('json', z.object({ status: z.enum(['active', 'inactive', 'testing']) })), async (c) => {
  const providerId = c.req.param('id');
  const { status } = c.req.valid('json');

  const [updated] = await db
    .update(ssoProviders)
    .set({ status, updatedAt: new Date() })
    .where(eq(ssoProviders.id, providerId))
    .returning();

  if (!updated) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId: updated.orgId,
    action: 'sso.provider.status.update',
    resourceType: 'sso_provider',
    resourceId: updated.id,
    resourceName: updated.name,
    details: { status }
  });

  return c.json({ data: updated });
});

// Test provider configuration
ssoRoutes.post('/providers/:id/test', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  const providerId = c.req.param('id');

  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.id, providerId))
    .limit(1);

  if (!provider) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  if (provider.type !== 'oidc') {
    return c.json({ error: 'Only OIDC providers can be tested' }, 400);
  }

  try {
    // Test discovery
    if (provider.issuer) {
      const discovery = await discoverOIDCConfig(provider.issuer);
      writeRouteAudit(c, {
        orgId: provider.orgId,
        action: 'sso.provider.test',
        resourceType: 'sso_provider',
        resourceId: provider.id,
        resourceName: provider.name
      });
      return c.json({
        success: true,
        message: 'Provider configuration is valid',
        discovery: {
          issuer: discovery.issuer,
          authorizationEndpoint: discovery.authorization_endpoint,
          tokenEndpoint: discovery.token_endpoint,
          userInfoEndpoint: discovery.userinfo_endpoint
        }
      });
    }

    writeRouteAudit(c, {
      orgId: provider.orgId,
      action: 'sso.provider.test',
      resourceType: 'sso_provider',
      resourceId: provider.id,
      resourceName: provider.name
    });

    return c.json({ success: true, message: 'Provider configuration appears valid' });
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message || 'Configuration test failed'
    }, 400);
  }
});

// ============================================
// SSO Login Flow (Public)
// ============================================

// Initiate SSO login
ssoRoutes.get('/login/:orgId', async (c) => {
  const orgId = c.req.param('orgId');
  const redirectUrl = normalizeRedirectPath(c.req.query('redirect'));

  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(and(
      eq(ssoProviders.orgId, orgId),
      eq(ssoProviders.status, 'active')
    ))
    .limit(1);

  if (!provider) {
    return c.json({ error: 'No active SSO provider for this organization' }, 404);
  }

  if (provider.type !== 'oidc') {
    return c.json({ error: 'Only OIDC login is currently supported' }, 400);
  }

  const config = getOIDCConfig(provider);

  // Generate PKCE challenge
  const pkce = generatePKCEChallenge();
  const state = generateState();
  const nonce = generateNonce();

  // Store session for callback verification
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await db.insert(ssoSessions).values({
    providerId: provider.id,
    state,
    nonce,
    codeVerifier: pkce.codeVerifier,
    redirectUrl,
    expiresAt
  });

  // Build callback URL
  const baseUrl = c.req.header('origin') || process.env.PUBLIC_URL || 'http://localhost:3000';
  const callbackUri = `${baseUrl}/api/v1/sso/callback`;

  // Build authorization URL
  const authUrl = buildAuthorizationUrl({
    config,
    state,
    nonce,
    redirectUri: callbackUri,
    pkce
  });

  return c.redirect(authUrl);
});

// SSO callback
ssoRoutes.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');

  if (error) {
    return c.redirect(`/login?error=sso_error&message=${encodeURIComponent(errorDescription || error)}`);
  }

  if (!code || !state) {
    return c.redirect('/login?error=invalid_callback');
  }

  // Find and validate session
  const [session] = await db
    .select()
    .from(ssoSessions)
    .where(and(
      eq(ssoSessions.state, state),
      gt(ssoSessions.expiresAt, new Date())
    ))
    .limit(1);

  if (!session) {
    return c.redirect('/login?error=session_expired');
  }

  // Get provider
  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.id, session.providerId))
    .limit(1);

  if (!provider) {
    return c.redirect('/login?error=provider_not_found');
  }

  try {
    const config = getOIDCConfig(provider);
    const baseUrl = c.req.header('origin') || process.env.PUBLIC_URL || 'http://localhost:3000';
    const callbackUri = `${baseUrl}/api/v1/sso/callback`;

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens({
      config,
      code,
      redirectUri: callbackUri,
      codeVerifier: session.codeVerifier || undefined
    });

    // Verify ID token if present
    if (tokens.id_token) {
      const claims = decodeIdToken(tokens.id_token);
      verifyIdTokenClaims(claims, config, session.nonce);
    }

    // Get user info
    const userInfo = await getUserInfo(config, tokens.access_token);

    // Map attributes
    const mapping = (provider.attributeMapping as any) || { email: 'email', name: 'name' };
    const attrs = mapUserAttributes(userInfo, mapping);

    // Check allowed domains
    if (provider.allowedDomains) {
      const domains = provider.allowedDomains.split(',').map(d => d.trim().toLowerCase());
      const emailDomain = attrs.email.split('@')[1]?.toLowerCase();
      if (emailDomain && !domains.includes(emailDomain)) {
        return c.redirect('/login?error=domain_not_allowed');
      }
    }

    // Find or create user
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, attrs.email.toLowerCase()))
      .limit(1);

    if (!user) {
      if (!provider.autoProvision) {
        return c.redirect('/login?error=user_not_found');
      }

      // Create new user
      const [newUser] = await db
        .insert(users)
        .values({
          email: attrs.email.toLowerCase(),
          name: attrs.name,
          status: 'active',
          passwordHash: null // SSO users don't have passwords
        })
        .returning();

      if (!newUser) {
        return c.redirect('/login?error=user_creation_failed');
      }

      user = newUser;

      // Assign default role if configured
      if (provider.defaultRoleId) {
        await db.insert(organizationUsers).values({
          orgId: provider.orgId,
          userId: user.id,
          roleId: provider.defaultRoleId
        });
      }
    }

    // Update or create SSO identity link
    const [existingIdentity] = await db
      .select()
      .from(userSsoIdentities)
      .where(and(
        eq(userSsoIdentities.userId, user.id),
        eq(userSsoIdentities.providerId, provider.id)
      ))
      .limit(1);

    if (existingIdentity) {
      await db
        .update(userSsoIdentities)
        .set({
          email: attrs.email,
          profile: userInfo,
          accessToken: encryptSecret(tokens.access_token),
          refreshToken: encryptSecret(tokens.refresh_token),
          tokenExpiresAt: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000)
            : null,
          lastLoginAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(userSsoIdentities.id, existingIdentity.id));
    } else {
      await db.insert(userSsoIdentities).values({
        userId: user.id,
        providerId: provider.id,
        externalId: userInfo.sub,
        email: attrs.email,
        profile: userInfo,
        accessToken: encryptSecret(tokens.access_token),
        refreshToken: encryptSecret(tokens.refresh_token),
        tokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : null,
        lastLoginAt: new Date()
      });
    }

    // Update last login
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    // Clean up SSO session
    await db.delete(ssoSessions).where(eq(ssoSessions.id, session.id));

    // Get user's organization and role for JWT
    const [orgUser] = await db
      .select({
        orgId: organizationUsers.orgId,
        roleId: organizationUsers.roleId,
        roleName: roles.name,
        roleScope: roles.scope
      })
      .from(organizationUsers)
      .innerJoin(roles, eq(roles.id, organizationUsers.roleId))
      .where(eq(organizationUsers.userId, user.id))
      .limit(1);

    // Create session and tokens
    const ip = getClientIP(c);
    const userAgent = c.req.header('user-agent') || 'unknown';

    const tokenPayload = {
      sub: user.id,
      email: user.email,
      roleId: orgUser?.roleId || null,
      orgId: orgUser?.orgId || null,
      partnerId: null,
      scope: (orgUser?.roleScope || 'organization') as 'system' | 'partner' | 'organization'
    };

    const { accessToken, refreshToken, expiresInSeconds } = await createTokenPair(tokenPayload);

    await createSession({
      userId: user.id,
      ipAddress: ip,
      userAgent
    });

    const tokenExchangeCode = createSsoTokenExchangeGrant(accessToken, refreshToken, expiresInSeconds);
    const redirectPath = normalizeRedirectPath(session.redirectUrl ?? '/');
    return c.redirect(`${redirectPath}#ssoCode=${encodeURIComponent(tokenExchangeCode)}`);

  } catch (error: any) {
    console.error('SSO callback error:', error);
    return c.redirect(`/login?error=sso_error&message=${encodeURIComponent(error.message || 'Authentication failed')}`);
  }
});

ssoRoutes.post('/exchange', zValidator('json', tokenExchangeSchema), async (c) => {
  const { code } = c.req.valid('json');
  const grant = consumeSsoTokenExchangeGrant(code);
  if (!grant) {
    return c.json({ error: 'Invalid or expired token exchange code' }, 400);
  }

  return c.json({
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresInSeconds: grant.expiresInSeconds
  });
});

// Get SSO login URL for organization (public endpoint for login page)
ssoRoutes.get('/check/:orgId', async (c) => {
  const orgId = c.req.param('orgId');

  const [provider] = await db
    .select({
      id: ssoProviders.id,
      name: ssoProviders.name,
      type: ssoProviders.type,
      enforceSSO: ssoProviders.enforceSSO
    })
    .from(ssoProviders)
    .where(and(
      eq(ssoProviders.orgId, orgId),
      eq(ssoProviders.status, 'active')
    ))
    .limit(1);

  if (!provider) {
    return c.json({ ssoEnabled: false });
  }

  return c.json({
    ssoEnabled: true,
    provider: {
      id: provider.id,
      name: provider.name,
      type: provider.type
    },
    enforceSSO: provider.enforceSSO,
    loginUrl: `/api/v1/sso/login/${orgId}`
  });
});
