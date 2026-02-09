import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ssoRoutes } from './sso';

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
    expiresInSeconds: 900
  }),
  createSession: vi.fn()
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
  }
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
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: () => true,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c, next) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  })
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { discoverOIDCConfig } from '../services/sso';

describe('sso routes', () => {
  let app: Hono;

  const setAuthContext = (overrides: Partial<{
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    partnerId: string | null;
    accessibleOrgIds: string[] | null;
    canAccessOrg: (orgId: string) => boolean;
  }> = {}) => {
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: overrides.scope ?? 'organization',
        orgId: 'orgId' in overrides ? overrides.orgId : 'org-123',
        partnerId: 'partnerId' in overrides ? overrides.partnerId : null,
        accessibleOrgIds: 'accessibleOrgIds' in overrides ? overrides.accessibleOrgIds : ['org-123'],
        canAccessOrg: overrides.canAccessOrg ?? (() => true),
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setAuthContext();
    app = new Hono();
    app.route('/sso', ssoRoutes);
  });

  it('returns providers for the organization', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: 'provider-1',
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
      partnerId: 'partner-123',
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId) => orgId === 'org-123'
    });

    const res = await app.request('/sso/providers?orgId=org-999', {
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
            id: 'provider-1',
            orgId: 'org-123',
            name: 'Okta',
            type: 'oidc',
            issuer: 'https://issuer.example.com',
            clientSecret: 'super-secret'
          }])
        })
      })
    } as any);

    const res = await app.request('/sso/providers/provider-1', {
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
      partnerId: 'partner-123',
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId) => orgId === 'org-123'
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'provider-1',
            orgId: 'org-999',
            name: 'Other Provider',
            type: 'oidc',
            issuer: 'https://issuer.example.com',
            clientSecret: 'secret'
          }])
        })
      })
    } as any);

    const res = await app.request('/sso/providers/provider-1', {
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
      returning: vi.fn().mockResolvedValue([{ id: 'provider-1', name: 'Okta' }])
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
      orgId: 'org-123',
      name: 'Okta',
      type: 'oidc',
      scopes: 'openid profile email',
      authorizationUrl: 'https://issuer.example.com/auth',
      tokenUrl: 'https://issuer.example.com/token',
      userInfoUrl: 'https://issuer.example.com/userinfo',
      jwksUrl: 'https://issuer.example.com/jwks',
      createdBy: 'user-123',
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
          limit: vi.fn().mockResolvedValue([{ id: 'provider-1', orgId: 'org-123' }])
        })
      })
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'provider-1', name: 'Okta Updated' }])
        })
      })
    } as any);

    const res = await app.request('/sso/providers/provider-1', {
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
          limit: vi.fn().mockResolvedValue([{ id: 'provider-1', orgId: 'org-123' }])
        })
      })
    } as any);

    vi.mocked(db.delete)
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) } as any)
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) } as any)
      .mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'provider-1' }])
        })
      } as any);

    const res = await app.request('/sso/providers/provider-1', {
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
            id: 'provider-1',
            type: 'saml'
          }])
        })
      })
    } as any);

    const res = await app.request('/sso/providers/provider-1/test', {
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
            id: 'provider-1',
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

    const res = await app.request('/sso/providers/provider-1/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
