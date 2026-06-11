import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { Hono } from 'hono';
import { ssoRoutes } from './sso';

// Mirrors the route's signed binding-cookie derivation
// (HMAC-SHA256 of `sso-login-state:<state>` keyed by the cookie secret).
const SSO_STATE_COOKIE_SECRET = 'test-sso-cookie-secret';
function ssoStateCookieHeader(state: string): string {
  const value = createHmac('sha256', SSO_STATE_COOKIE_SECRET)
    .update(`sso-login-state:${state}`)
    .digest('hex');
  return `breeze_sso_state=${encodeURIComponent(value)}`;
}

const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false }
}));

vi.mock('../services/sso', () => ({
  generateState: vi.fn().mockReturnValue('state'),
  generateNonce: vi.fn().mockReturnValue('nonce'),
  generatePKCEChallenge: vi.fn().mockReturnValue({
    codeVerifier: 'verifier',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256'
  }),
  buildAuthorizationUrl: vi.fn().mockReturnValue('https://idp.example.com/auth'),
  exchangeCodeForTokens: vi.fn(),
  getUserInfo: vi.fn(),
  decodeIdToken: vi.fn(),
  verifyIdTokenClaims: vi.fn(),
  verifyIdTokenSignature: vi.fn(),
  assertEmailVerified: vi.fn(),
  mapUserAttributes: vi.fn(),
  discoverOIDCConfig: vi.fn(),
  PROVIDER_PRESETS: {
    okta: {
      scopes: 'openid profile email',
      attributeMapping: { email: 'email', name: 'name' }
    }
  }
}));

vi.mock('../services', () => ({
  createTokenPair: vi.fn().mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'sso-jti-mock',
    expiresInSeconds: 900
  }),
  createSession: vi.fn(),
  // Task 7 follow-up: SSO callback now mints a refresh-token family for
  // every completed sign-in so reuse-detection covers SSO sessions.
  mintRefreshTokenFamily: vi.fn().mockResolvedValue('sso-family-id-mock'),
  bindRefreshJtiToFamily: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    }))
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

vi.mock('../db/schema', () => ({
  ssoProviders: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    type: 'type',
    status: 'status',
    issuer: 'issuer',
    autoProvision: 'autoProvision',
    enforceSSO: 'enforceSSO',
    createdAt: 'createdAt',
    authorizationUrl: 'authorizationUrl',
    tokenUrl: 'tokenUrl',
    userInfoUrl: 'userInfoUrl',
    jwksUrl: 'jwksUrl'
  },
  ssoSessions: {},
  userSsoIdentities: {
    id: 'id',
    userId: 'userId',
    providerId: 'providerId'
  },
  users: {
    id: 'id',
    email: 'email'
  },
  organizationUsers: {
    orgId: 'orgId',
    roleId: 'roleId',
    userId: 'userId'
  },
  roles: {
    id: 'id',
    name: 'name',
    scope: 'scope'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '00000000-0000-4000-8000-000000000010',
      partnerId: null,
      accessibleOrgIds: ['00000000-0000-4000-8000-000000000010'],
      canAccessOrg: () => true,
      user: { id: '00000000-0000-4000-8000-000000000020', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  })
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
  discoverOIDCConfig,
  exchangeCodeForTokens,
  getUserInfo,
  mapUserAttributes,
  verifyIdTokenSignature,
} from '../services/sso';

const PROVIDER_UUID = '00000000-0000-4000-8000-000000000001';
const ORG_UUID = '00000000-0000-4000-8000-000000000010';
const ORG_UUID_OTHER = '00000000-0000-4000-8000-000000000099';
const USER_UUID = '00000000-0000-4000-8000-000000000020';
const PARTNER_UUID = '00000000-0000-4000-8000-000000000030';

describe('sso routes', () => {
  let app: Hono;

  const setAuthContext = (overrides: Partial<{
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    partnerId: string | null;
    accessibleOrgIds: string[] | null;
    canAccessOrg: (orgId: string) => boolean;
  }> = {}) => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: overrides.scope ?? 'organization',
        orgId: 'orgId' in overrides ? overrides.orgId : ORG_UUID,
        partnerId: 'partnerId' in overrides ? overrides.partnerId : null,
        accessibleOrgIds: 'accessibleOrgIds' in overrides ? overrides.accessibleOrgIds : [ORG_UUID],
        canAccessOrg: overrides.canAccessOrg ?? (() => true),
        user: { id: USER_UUID, email: 'test@example.com' }
      });
      return next();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears call history but NOT the mockReturnValueOnce queue.
    // Reset the db mocks to their default chain so a prior test's unconsumed
    // `*Once` entries can't bleed into the next test (e.g. a leftover
    // delete().returning() that would mask an atomic-consume assertion).
    vi.mocked(db.delete).mockReset().mockReturnValue({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
    } as any);
    vi.mocked(db.select).mockReset().mockReturnValue({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) }))
    } as any);
    vi.mocked(db.insert).mockReset().mockReturnValue({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
    } as any);
    vi.mocked(db.update).mockReset().mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) }))
    } as any);
    delete process.env.SSO_EXCHANGE_RETURN_REFRESH_TOKEN;
    process.env.APP_ENCRYPTION_KEY = SSO_STATE_COOKIE_SECRET;
    permissionGate.deny = false;
    mfaGate.deny = false;
    setAuthContext();
    app = new Hono();
    app.route('/sso', ssoRoutes);
  });

  it('returns providers for the organization', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: PROVIDER_UUID,
            name: 'Okta',
            type: 'oidc',
            status: 'active',
            issuer: 'https://issuer.example.com',
            autoProvision: true,
            enforceSSO: false,
            createdAt: '2024-01-01'
          }
        ])
      })
    } as any);

    const res = await app.request('/sso/providers', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('requires an orgId when listing providers', async () => {
    setAuthContext({ orgId: null, accessibleOrgIds: [] });

    const res = await app.request('/sso/providers', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(400);
  });

  it('denies partner access to providers outside accessible organizations', async () => {
    setAuthContext({
      scope: 'partner',
      orgId: null,
      partnerId: PARTNER_UUID,
      accessibleOrgIds: [ORG_UUID],
      canAccessOrg: (orgId) => orgId === ORG_UUID
    });

    const res = await app.request(`/sso/providers?orgId=${ORG_UUID_OTHER}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(403);
  });

  it('returns provider details without secrets', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: PROVIDER_UUID,
            orgId: ORG_UUID,
            name: 'Okta',
            type: 'oidc',
            issuer: 'https://issuer.example.com',
            clientSecret: 'super-secret'
          }])
        })
      })
    } as any);

    const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.clientSecret).toBeUndefined();
    expect(body.data.hasClientSecret).toBe(true);
  });

  it('denies provider detail access when provider org is outside scope', async () => {
    setAuthContext({
      scope: 'partner',
      orgId: null,
      partnerId: PARTNER_UUID,
      accessibleOrgIds: [ORG_UUID],
      canAccessOrg: (orgId) => orgId === ORG_UUID
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: PROVIDER_UUID,
            orgId: ORG_UUID_OTHER,
            name: 'Other Provider',
            type: 'oidc',
            issuer: 'https://issuer.example.com',
            clientSecret: 'secret'
          }])
        })
      })
    } as any);

    const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(403);
  });

  it('creates an OIDC provider with preset and discovery metadata', async () => {
    vi.mocked(discoverOIDCConfig).mockResolvedValue({
      issuer: 'https://issuer.example.com',
      authorization_endpoint: 'https://issuer.example.com/auth',
      token_endpoint: 'https://issuer.example.com/token',
      userinfo_endpoint: 'https://issuer.example.com/userinfo',
      jwks_uri: 'https://issuer.example.com/jwks'
    } as any);

    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, name: 'Okta' }])
    });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

    const res = await app.request('/sso/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Okta',
        type: 'oidc',
        preset: 'okta',
        issuer: 'https://issuer.example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret'
      })
    });

    expect(res.status).toBe(201);
    expect(discoverOIDCConfig).toHaveBeenCalledWith('https://issuer.example.com');
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_UUID,
      name: 'Okta',
      type: 'oidc',
      scopes: 'openid profile email',
      authorizationUrl: 'https://issuer.example.com/auth',
      tokenUrl: 'https://issuer.example.com/token',
      userInfoUrl: 'https://issuer.example.com/userinfo',
      jwksUrl: 'https://issuer.example.com/jwks',
      createdBy: USER_UUID,
      status: 'inactive'
    }));
  });

  it('creates a SAML provider without discovery', async () => {
    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'provider-2', name: 'OneLogin' }])
    });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

    const res = await app.request('/sso/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'OneLogin',
        type: 'saml',
        issuer: 'https://saml.example.com'
      })
    });

    expect(res.status).toBe(201);
    expect(discoverOIDCConfig).not.toHaveBeenCalled();
  });

  it('updates a provider', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID }])
        })
      })
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, name: 'Okta Updated' }])
        })
      })
    } as any);

    const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Okta Updated' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Okta Updated');
  });

  it('deletes a provider and related records', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID }])
        })
      })
    } as any);

    vi.mocked(db.delete)
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) } as any)
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) } as any)
      .mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID }])
        })
      } as any);

    const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('rejects testing non-OIDC providers', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: PROVIDER_UUID,
            type: 'saml'
          }])
        })
      })
    } as any);

    const res = await app.request(`/sso/providers/${PROVIDER_UUID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(400);
  });

  it('tests OIDC provider discovery', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: PROVIDER_UUID,
            type: 'oidc',
            issuer: 'https://issuer.example.com'
          }])
        })
      })
    } as any);

    vi.mocked(discoverOIDCConfig).mockResolvedValue({
      issuer: 'https://issuer.example.com',
      authorization_endpoint: 'https://issuer.example.com/auth',
      token_endpoint: 'https://issuer.example.com/token',
      userinfo_endpoint: 'https://issuer.example.com/userinfo'
    } as any);

    const res = await app.request(`/sso/providers/${PROVIDER_UUID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('rejects provider mutation when permission check fails', async () => {
    permissionGate.deny = true;

    const res = await app.request('/sso/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Okta',
        type: 'oidc',
        issuer: 'https://issuer.example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret'
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects provider mutation when MFA check fails', async () => {
    mfaGate.deny = true;

    const res = await app.request('/sso/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Okta',
        type: 'oidc',
        issuer: 'https://issuer.example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret'
      })
    });

    expect(res.status).toBe(403);
  });

  it('exchanges SSO callback code for access token and HttpOnly refresh cookie only once', async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({
      access_token: 'idp-access-token',
      refresh_token: 'idp-refresh-token',
      expires_in: 3600
    } as any);
    vi.mocked(getUserInfo).mockResolvedValue({
      sub: 'external-user-1',
      email: 'test@example.com',
      name: 'Test User'
    } as any);
    vi.mocked(mapUserAttributes).mockReturnValue({
      email: 'test@example.com',
      name: 'Test User'
    } as any);

    // Session is now claimed atomically via delete().returning().
    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'sso-session-1',
          providerId: PROVIDER_UUID,
          state: 'state',
          nonce: 'nonce',
          codeVerifier: 'verifier',
          redirectUrl: '/dashboard'
        }])
      })
    } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: PROVIDER_UUID,
              orgId: ORG_UUID,
              type: 'oidc',
              issuer: 'https://issuer.example.com',
              authorizationUrl: 'https://issuer.example.com/auth',
              tokenUrl: 'https://issuer.example.com/token',
              userInfoUrl: 'https://issuer.example.com/userinfo',
              jwksUrl: 'https://issuer.example.com/jwks',
              clientId: 'client-id',
              clientSecret: 'client-secret',
              scopes: 'openid profile email',
              attributeMapping: { email: 'email', name: 'name' },
              autoProvision: false,
              allowedDomains: null,
              defaultRoleId: null
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: USER_UUID,
              email: 'test@example.com',
              name: 'Test User'
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                orgId: ORG_UUID,
                roleId: 'role-1',
                roleName: 'Member',
                roleScope: 'organization'
              }])
            })
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'identity-1' }])
          })
        })
      } as any);

    const callbackRes = await app.request('/sso/callback?code=oidc-code&state=state', {
      method: 'GET',
      headers: { 'user-agent': 'vitest', cookie: ssoStateCookieHeader('state') }
    });

    expect(callbackRes.status).toBe(302);
    const redirectLocation = callbackRes.headers.get('location') ?? '';
    const exchangeCode = redirectLocation.match(/ssoCode=([^&]+)/)?.[1];
    expect(exchangeCode).toBeTruthy();

    const exchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: decodeURIComponent(exchangeCode!) })
    });

    expect(exchangeRes.status).toBe(200);
    const body = await exchangeRes.json();
    // SSO_EXCHANGE_RETURN_REFRESH_TOKEN defaults to false: the refresh token
    // is delivered only via the HttpOnly `breeze_refresh_token` cookie, never
    // in the JSON response. The Deprecation header is only emitted when the
    // legacy JSON behavior is explicitly re-enabled via the env flag.
    expect(body).toEqual({
      accessToken: 'access-token',
      expiresInSeconds: 900
    });
    expect(body.refreshToken).toBeUndefined();
    expect(exchangeRes.headers.get('deprecation')).toBeNull();
    const setCookie = exchangeRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('breeze_refresh_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('breeze_csrf_token=');

    const replayRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: decodeURIComponent(exchangeCode!) })
    });

    expect(replayRes.status).toBe(400);
  });

  it('returns SSO refresh token in JSON only behind explicit compatibility flag', async () => {
    process.env.SSO_EXCHANGE_RETURN_REFRESH_TOKEN = 'true';
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({
      access_token: 'idp-access-token',
      refresh_token: 'idp-refresh-token',
      expires_in: 3600
    } as any);
    vi.mocked(getUserInfo).mockResolvedValue({
      sub: 'external-user-1',
      email: 'test@example.com',
      name: 'Test User'
    } as any);
    vi.mocked(mapUserAttributes).mockReturnValue({
      email: 'test@example.com',
      name: 'Test User'
    } as any);

    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'sso-session-2',
          providerId: PROVIDER_UUID,
          state: 'state',
          nonce: 'nonce',
          codeVerifier: 'verifier',
          redirectUrl: '/'
        }])
      })
    } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: PROVIDER_UUID,
              orgId: ORG_UUID,
              type: 'oidc',
              issuer: 'https://issuer.example.com',
              authorizationUrl: 'https://issuer.example.com/auth',
              tokenUrl: 'https://issuer.example.com/token',
              userInfoUrl: 'https://issuer.example.com/userinfo',
              clientId: 'client-id',
              clientSecret: 'client-secret',
              scopes: 'openid profile email',
              attributeMapping: { email: 'email', name: 'name' },
              autoProvision: false,
              defaultRoleId: null
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: USER_UUID, email: 'test@example.com', name: 'Test User' }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ orgId: ORG_UUID, roleId: 'role-1', roleScope: 'organization' }])
            })
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'identity-2' }])
          })
        })
      } as any);

    const callbackRes = await app.request('/sso/callback?code=oidc-code&state=state', {
      headers: { cookie: ssoStateCookieHeader('state') }
    });
    const exchangeCode = (callbackRes.headers.get('location') ?? '').match(/ssoCode=([^&]+)/)?.[1];
    expect(exchangeCode).toBeTruthy();

    const exchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: decodeURIComponent(exchangeCode!) })
    });

    expect(exchangeRes.status).toBe(200);
    const body = await exchangeRes.json();
    expect(body.refreshToken).toBe('refresh-token');
    // HttpOnly cookie is set in both modes — flag only controls JSON body.
    const setCookie = exchangeRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('breeze_refresh_token=');
    expect(setCookie).toContain('HttpOnly');
    // Deprecation headers are emitted when the legacy JSON behavior is opted into.
    expect(exchangeRes.headers.get('deprecation')).toBe('true');
    expect(exchangeRes.headers.get('sunset')).toBeTruthy();
  });

  describe('SSO login-CSRF browser binding (forced-login defense)', () => {
    // Wire the db mocks for a fully successful callback so the only variable
    // under test is the binding-cookie / state interaction. The session is
    // claimed via delete().returning(); a falsy `deleteReturns` simulates a
    // state that's already been consumed (atomic single-use).
    const wireHappyPathDb = (opts: { deleteReturns?: boolean } = {}) => {
      const { deleteReturns = true } = opts;

      vi.mocked(exchangeCodeForTokens).mockResolvedValue({
        access_token: 'idp-access-token',
        refresh_token: 'idp-refresh-token',
        expires_in: 3600
      } as any);
      vi.mocked(getUserInfo).mockResolvedValue({
        sub: 'external-user-1',
        email: 'test@example.com',
        name: 'Test User'
      } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({
        email: 'test@example.com',
        name: 'Test User'
      } as any);

      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(deleteReturns
            ? [{
                id: 'sso-session-x',
                providerId: PROVIDER_UUID,
                state: 'state',
                nonce: 'nonce',
                codeVerifier: 'verifier',
                redirectUrl: '/dashboard'
              }]
            : [])
        })
      } as any);

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: PROVIDER_UUID,
                orgId: ORG_UUID,
                type: 'oidc',
                issuer: 'https://issuer.example.com',
                authorizationUrl: 'https://issuer.example.com/auth',
                tokenUrl: 'https://issuer.example.com/token',
                userInfoUrl: 'https://issuer.example.com/userinfo',
                jwksUrl: 'https://issuer.example.com/jwks',
                clientId: 'client-id',
                clientSecret: 'client-secret',
                scopes: 'openid profile email',
                attributeMapping: { email: 'email', name: 'name' },
                autoProvision: false,
                allowedDomains: null,
                defaultRoleId: null
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: USER_UUID,
                email: 'test@example.com',
                name: 'Test User'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  orgId: ORG_UUID,
                  roleId: 'role-1',
                  roleName: 'Member',
                  roleScope: 'organization'
                }])
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'identity-x' }])
            })
          })
        } as any);
    };

    it('rejects a callback with NO binding cookie (forced-login blocked)', async () => {
      wireHappyPathDb();

      const res = await app.request('/sso/callback?code=oidc-code&state=state', {
        method: 'GET'
        // no cookie header — simulates the cross-site top-level navigation a
        // SameSite=Lax cookie would not be attached to.
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=invalid_callback');
      // The session must NOT have been consumed when binding fails.
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('rejects a callback whose cookie value does not match the URL state', async () => {
      wireHappyPathDb();

      const res = await app.request('/sso/callback?code=oidc-code&state=state', {
        method: 'GET',
        // Cookie was minted for a DIFFERENT state (the attacker's), so the
        // constant-time HMAC compare against the URL `state` fails.
        headers: { cookie: ssoStateCookieHeader('attacker-state') }
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=invalid_callback');
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('proceeds when the binding cookie matches the URL state', async () => {
      wireHappyPathDb();

      const res = await app.request('/sso/callback?code=oidc-code&state=state', {
        method: 'GET',
        headers: { cookie: ssoStateCookieHeader('state') }
      });

      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toMatch(/ssoCode=/);
      // Session was claimed atomically.
      expect(db.delete).toHaveBeenCalledTimes(1);
      // Binding cookie is cleared after a successful flow.
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('breeze_sso_state=;');
    });

    it('rejects replay of an already-consumed state (atomic single-use)', async () => {
      // The delete().returning() returns no row — the state was already
      // claimed by a prior callback — so the second attempt is rejected.
      wireHappyPathDb({ deleteReturns: false });

      const res = await app.request('/sso/callback?code=oidc-code&state=state', {
        method: 'GET',
        headers: { cookie: ssoStateCookieHeader('state') }
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=session_expired');
      // The atomic claim was attempted (and lost the race).
      expect(db.delete).toHaveBeenCalledTimes(1);
      // No tokens were minted for the replay.
      expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    });

    it('rejects an id_token whose signature fails verification', async () => {
      wireHappyPathDb();
      // Provider has jwksUrl, so the callback verifies the id_token signature.
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({
        access_token: 'idp-access-token',
        refresh_token: 'idp-refresh-token',
        expires_in: 3600,
        id_token: 'header.payload.badsig'
      } as any);
      vi.mocked(verifyIdTokenSignature).mockRejectedValue(
        new Error('ID token signature verification failed: signature verification failed')
      );

      const res = await app.request('/sso/callback?code=oidc-code&state=state', {
        method: 'GET',
        headers: { cookie: ssoStateCookieHeader('state') }
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('/login?error=sso_error');
      expect(verifyIdTokenSignature).toHaveBeenCalled();
    });
  });
});
