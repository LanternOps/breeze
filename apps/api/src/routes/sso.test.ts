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

const { permissionGate, mfaGate, recordedPermissionGuards } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
  recordedPermissionGuards: [] as Array<[string, string]>
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
  // Real logic (not a stub) so the IdP-MFA tests exercise the amr check.
  idpAssertedMfa: (claims: { amr?: unknown }) => Array.isArray(claims?.amr) && claims.amr.includes('mfa'),
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
  bindRefreshJtiToFamily: vi.fn().mockResolvedValue(undefined),
  // Partner-axis login rate limiting (#2183 spec §5) — default allowed so
  // existing tests exercising the route body are unaffected; the dedicated
  // 429 test overrides this per-call.
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date(Date.now() + 60_000) }),
  getRedis: vi.fn().mockReturnValue({})
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
    partnerId: 'partnerId',
    name: 'name',
    type: 'type',
    status: 'status',
    issuer: 'issuer',
    autoProvision: 'autoProvision',
    enforceSSO: 'enforceSSO',
    trustsIdpMfa: 'trustsIdpMfa',
    createdAt: 'createdAt',
    authorizationUrl: 'authorizationUrl',
    tokenUrl: 'tokenUrl',
    userInfoUrl: 'userInfoUrl',
    jwksUrl: 'jwksUrl'
  },
  ssoSessions: {},
  ssoVerifiedDomains: {
    id: 'id',
    orgId: 'orgId',
    domain: 'domain',
    verificationToken: 'verificationToken',
    verifiedAt: 'verifiedAt',
    lastCheckedAt: 'lastCheckedAt',
    createdAt: 'createdAt',
  },
  userSsoIdentities: {
    id: 'id',
    userId: 'userId',
    providerId: 'providerId'
  },
  users: {
    id: 'id',
    email: 'email',
    orgId: 'orgId',
    partnerId: 'partnerId'
  },
  organizationUsers: {
    orgId: 'orgId',
    roleId: 'roleId',
    userId: 'userId'
  },
  partnerUsers: {
    userId: 'userId',
    partnerId: 'partnerId',
    roleId: 'roleId'
  },
  roles: {
    id: 'id',
    name: 'name',
    scope: 'scope',
    orgId: 'orgId',
    partnerId: 'partnerId'
  }
}));

vi.mock('../services/ssoDomainVerification', () => ({
  createPendingDomain: vi.fn(),
  verifyDomain: vi.fn(),
  recordNameFor: vi.fn((domain: string) => `_breeze-verify.${domain}`),
  recordValueFor: vi.fn((token: string) => `breeze-domain-verify=${token}`),
  isSsoProvisioningBlocked: vi.fn().mockResolvedValue(false),
}));

// Partial-mock auth/helpers: keep the real cookie helpers the callback uses,
// but stub auditLogin so partner-axis login tests can assert the audit call
// (method: 'sso-partner') without invoking the real async audit-log writer.
vi.mock('./auth/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth/helpers')>();
  return { ...actual, auditLogin: vi.fn() };
});

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
  requirePermission: vi.fn((resource: string, action: string) => {
    recordedPermissionGuards.push([resource, action]);
    return async (c: any, next: any) => {
      if (permissionGate.deny) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      return next();
    };
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  })
}));

import { db } from '../db';
import { createTokenPair, rateLimiter } from '../services';
import { authMiddleware } from '../middleware/auth';
import {
  discoverOIDCConfig,
  exchangeCodeForTokens,
  getUserInfo,
  mapUserAttributes,
  verifyIdTokenSignature,
} from '../services/sso';
import { createPendingDomain, verifyDomain, isSsoProvisioningBlocked } from '../services/ssoDomainVerification';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { auditLogin } from './auth/helpers';

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
    partnerOrgAccess: 'all' | 'selected' | 'none' | null;
  }> = {}) => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: overrides.scope ?? 'organization',
        orgId: 'orgId' in overrides ? overrides.orgId : ORG_UUID,
        partnerId: 'partnerId' in overrides ? overrides.partnerId : null,
        accessibleOrgIds: 'accessibleOrgIds' in overrides ? overrides.accessibleOrgIds : [ORG_UUID],
        canAccessOrg: overrides.canAccessOrg ?? (() => true),
        partnerOrgAccess: 'partnerOrgAccess' in overrides ? overrides.partnerOrgAccess : null,
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
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
          // Public entry routes order the provider pick deterministically
          // (#2195): where().orderBy().limit().
          orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) }))
        }))
      }))
    } as any);
    vi.mocked(db.insert).mockReset().mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([])),
        // Callback identity insert (#2195): values().onConflictDoNothing().returning().
        // Defaults to a NON-empty result (= the insert landed, no conflict) so
        // the conflict re-select branch doesn't consume per-test select queues.
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: 'new-identity-id' }]))
        }))
      }))
    } as any);
    vi.mocked(db.update).mockReset().mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) }))
    } as any);
    vi.mocked(rateLimiter).mockReset().mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000)
    } as any);
    delete process.env.SSO_EXCHANGE_RETURN_REFRESH_TOKEN;
    process.env.APP_ENCRYPTION_KEY = SSO_STATE_COOKIE_SECRET;
    permissionGate.deny = false;
    mfaGate.deny = false;
    // security review #2: the callback now requires a signature-verified id_token
    // (jwksUrl + id_token mandatory; the unsigned decode path was removed).
    // Default the verifier to "passes" with minimal claims so flows that don't
    // assert subject/email binding keep linking via userinfo as before; tests
    // that exercise binding/rejection override this.
    // sub matches getUserInfo's sub so the verified-subject binding (security
    // review #2) and the identity-first lookup resolve cleanly by default.
    vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);
    setAuthContext();
    app = new Hono();
    app.route('/sso', ssoRoutes);
  });

  it('gates provider mutations on sso:admin, not organizations:write', () => {
    // recordedPermissionGuards is populated at module load when sso.ts registers
    // its routes — before any beforeEach/clearAllMocks runs, so it survives resets.
    expect(recordedPermissionGuards).toContainEqual(['sso', 'admin']);
    expect(recordedPermissionGuards).not.toContainEqual(['organizations', 'write']);
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
            orgId: ORG_UUID,
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
            orgId: ORG_UUID,
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
      expires_in: 3600,
      id_token: 'header.payload.sig'
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
      // security review #2: identity-first — (provider, sub) link → user by id.
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ userId: USER_UUID }])
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
      expires_in: 3600,
      id_token: 'header.payload.sig'
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
              jwksUrl: 'https://issuer.example.com/jwks',
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
      // security review #2: identity-first — (provider, sub) link → user by id.
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ userId: USER_UUID }])
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
        expires_in: 3600,
        id_token: 'header.payload.sig'
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
        // security review #2: identity-first — a returning user is resolved by
        // the (provider, external sub) link, then loaded by id.
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ userId: USER_UUID }])
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

    // security review #2 (C-2): a token response with no id_token must be
    // rejected — the callback no longer accepts an unsigned/absent id_token.
    it('rejects a callback whose token response has no id_token', async () => {
      wireHappyPathDb();
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({
        access_token: 'idp-access-token',
        refresh_token: 'idp-refresh-token',
        expires_in: 3600
        // no id_token
      } as any);

      const res = await app.request('/sso/callback?code=oidc-code&state=state', {
        method: 'GET',
        headers: { cookie: ssoStateCookieHeader('state') }
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_no_id_token');
      // No userinfo lookup / account linking happened.
      expect(getUserInfo).not.toHaveBeenCalled();
    });

    // security review #2 (C-1): userinfo identity must be bound to the
    // signature-verified id_token. A userinfo `sub` that differs from the
    // verified id_token `sub` is the substitution the old userinfo-only linking
    // allowed — reject it.
    it('rejects when the userinfo subject does not match the verified id_token subject', async () => {
      wireHappyPathDb(); // getUserInfo sub = 'external-user-1'
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({
        sub: 'attacker-controlled-sub',
        nonce: 'nonce'
      } as any);

      const res = await app.request('/sso/callback?code=oidc-code&state=state', {
        method: 'GET',
        headers: { cookie: ssoStateCookieHeader('state') }
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_subject_mismatch');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    // ── security review #2: identity-first lookup (1A) + safe JIT linking (1B)
    const sel = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) })
    } as any);
    const selJoin = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }) })
    } as any);
    const PROVIDER_ROW = [{
      id: PROVIDER_UUID, orgId: ORG_UUID, type: 'oidc',
      issuer: 'https://issuer.example.com', authorizationUrl: 'https://issuer.example.com/auth',
      tokenUrl: 'https://issuer.example.com/token', userInfoUrl: 'https://issuer.example.com/userinfo',
      jwksUrl: 'https://issuer.example.com/jwks', clientId: 'client-id', clientSecret: 'client-secret',
      scopes: 'openid profile email', attributeMapping: { email: 'email', name: 'name' },
      autoProvision: false, allowedDomains: null, defaultRoleId: null
    }];
    const primeCallback = () => {
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 'h.p.s' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'test@example.com', name: 'Test User' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'test@example.com', name: 'Test User' } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sso-session-z', providerId: PROVIDER_UUID, state: 'state', nonce: 'nonce', codeVerifier: 'verifier', redirectUrl: '/dashboard' }]) })
      } as any);
    };
    const doCallback = () => app.request('/sso/callback?code=oidc-code&state=state', { method: 'GET', headers: { cookie: ssoStateCookieHeader('state') } });

    it('resolves the user by the (provider, sub) link regardless of the asserted email (1A)', async () => {
      primeCallback();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel(PROVIDER_ROW))
        .mockReturnValueOnce(sel([{ userId: USER_UUID }])) // identity link by (provider, sub)
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'someone-else@corp.com', name: 'Linked' }])) // user by id — email DIFFERS from asserted
        .mockReturnValueOnce(selJoin([{ orgId: ORG_UUID, roleId: 'role-1', roleName: 'Member', roleScope: 'organization' }]))
        .mockReturnValueOnce(sel([{ id: 'identity-1' }]));

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      // The session is the LINKED user — proving the email was not the lookup key.
      expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({ sub: USER_UUID }), expect.any(Object));
    });

    it('refuses to JIT-link an SSO assertion to an existing PASSWORD account (1B)', async () => {
      primeCallback();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel(PROVIDER_ROW))
        .mockReturnValueOnce(sel([])) // no (provider, sub) link yet
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'test@example.com', name: 'Pw', passwordHash: '$argon2id$hash' }]))
        .mockReturnValueOnce(sel([])); // no other-provider link (still denied — has a password)

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_link_required');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('refuses to JIT-link when the account is linked to a DIFFERENT provider (1B)', async () => {
      primeCallback();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel(PROVIDER_ROW))
        .mockReturnValueOnce(sel([])) // no link for THIS provider
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'test@example.com', name: 'SsoOnly', passwordHash: null }]))
        .mockReturnValueOnce(sel([{ id: 'other-provider-link' }])); // linked to another provider

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_link_required');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('auto-links an existing SSO-only account with no conflicting credential (1B safe path)', async () => {
      primeCallback();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel(PROVIDER_ROW))
        .mockReturnValueOnce(sel([])) // no link yet
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'test@example.com', name: 'SsoOnly', passwordHash: null }]))
        .mockReturnValueOnce(sel([])) // no other-provider link → safe to link
        .mockReturnValueOnce(selJoin([{ orgId: ORG_UUID, roleId: 'role-1', roleName: 'Member', roleScope: 'organization' }]))
        .mockReturnValueOnce(sel([])); // existingIdentity none → insert the new link

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      expect(createTokenPair).toHaveBeenCalled();
    });

    // ── security review #2 (H-1): IdP-asserted MFA signal
    // Wire a returning linked user (identity-first happy path) for a provider
    // whose trustsIdpMfa is set as given, with the verified id_token amr set.
    const wireLinkedLogin = (opts: { trustsIdpMfa: boolean; amr?: string[] }) => {
      primeCallback();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce', amr: opts.amr } as any);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([{ ...PROVIDER_ROW[0], trustsIdpMfa: opts.trustsIdpMfa }]))
        .mockReturnValueOnce(sel([{ userId: USER_UUID }])) // identity link
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'test@example.com', name: 'Linked' }]))
        .mockReturnValueOnce(selJoin([{ orgId: ORG_UUID, roleId: 'role-1', roleName: 'Member', roleScope: 'organization' }]))
        .mockReturnValueOnce(sel([{ id: 'identity-1' }]));
    };

    it('mints mfa:true when the provider trusts IdP MFA and amr attests it', async () => {
      wireLinkedLogin({ trustsIdpMfa: true, amr: ['pwd', 'mfa'] });
      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({ mfa: true }), expect.any(Object));
    });

    it('mints mfa:false when the provider trusts IdP MFA but amr does NOT attest it', async () => {
      wireLinkedLogin({ trustsIdpMfa: true, amr: ['pwd'] });
      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({ mfa: false }), expect.any(Object));
    });

    it('mints mfa:false when the provider does NOT trust IdP MFA even if amr attests it', async () => {
      wireLinkedLogin({ trustsIdpMfa: false, amr: ['mfa'] });
      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({ mfa: false }), expect.any(Object));
    });

    // ── security review #2 (H-2): SSO domain-verification gate wiring
    // These tests verify that the gate (isSsoProvisioningBlocked) is correctly
    // wired into the callback handler. The decision logic is unit-tested
    // exhaustively in ssoDomainVerification.test.ts; here we only test the
    // wiring: that a blocked domain redirects correctly and doesn't provision,
    // and that an already-linked identity bypasses the gate entirely.
    it('redirects to sso_domain_unverified when isSsoProvisioningBlocked returns true for an unmatched identity', async () => {
      primeCallback();
      vi.mocked(isSsoProvisioningBlocked).mockResolvedValue(true);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel(PROVIDER_ROW))
        .mockReturnValueOnce(sel([])) // no (provider, sub) link → user is null → gate is evaluated
        .mockReturnValueOnce(sel([])); // user-by-id lookup for the identity-first block (the second withSystemDbAccessContext call for users)

      const res = await doCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_domain_unverified');
      expect(createTokenPair).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('does NOT invoke the gate (and succeeds) when the identity is already linked by provider+sub', async () => {
      // Already-linked users resolve in the identity-first lookup, so user is non-null
      // before the gate. The gate is inside `if (!user)` and must not fire.
      vi.mocked(isSsoProvisioningBlocked).mockResolvedValue(true); // would block if called
      primeCallback();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel(PROVIDER_ROW))
        .mockReturnValueOnce(sel([{ userId: USER_UUID }])) // identity link found → user resolved
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'test@example.com', name: 'Linked' }]))
        .mockReturnValueOnce(selJoin([{ orgId: ORG_UUID, roleId: 'role-1', roleName: 'Member', roleScope: 'organization' }]))
        .mockReturnValueOnce(sel([{ id: 'identity-1' }]));

      const res = await doCallback();

      expect(res.status).toBe(302);
      // Succeeds — gate was not reached
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      expect(createTokenPair).toHaveBeenCalled();
      // isSsoProvisioningBlocked is still called in the mock infrastructure
      // but the gate block is inside `if (!user)` which is false here — so
      // the callback must NOT have redirected to sso_domain_unverified.
      expect(res.headers.get('location') ?? '').not.toContain('sso_domain_unverified');
    });
  });

  describe('SSO Domain Verification Routes', () => {
    const DOMAIN_UUID = '00000000-0000-4000-8000-000000000050';
    const DOMAIN_TOKEN = 'abc123def456';

    it('POST /domains returns 201 with recordName and recordValue for an authorized sso:admin caller', async () => {
      vi.mocked(createPendingDomain).mockResolvedValue({
        id: DOMAIN_UUID,
        orgId: ORG_UUID,
        domain: 'example.com',
        verificationToken: DOMAIN_TOKEN,
        recordName: `_breeze-verify.example.com`,
        recordValue: `breeze-domain-verify=${DOMAIN_TOKEN}`,
        verifiedAt: null,
      });

      const res = await app.request('/sso/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'example.com' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe(DOMAIN_UUID);
      expect(body.data.domain).toBe('example.com');
      expect(body.data.recordName).toBe('_breeze-verify.example.com');
      expect(body.data.recordValue).toBe(`breeze-domain-verify=${DOMAIN_TOKEN}`);
      expect(body.data.verified).toBe(false);
      expect(createPendingDomain).toHaveBeenCalledWith({
        orgId: ORG_UUID,
        domain: 'example.com',
        createdBy: USER_UUID,
      });
    });

    it('POST /domains returns 403 for a caller without sso:admin permission', async () => {
      permissionGate.deny = true;

      const res = await app.request('/sso/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'example.com' }),
      });

      expect(res.status).toBe(403);
      expect(createPendingDomain).not.toHaveBeenCalled();
    });

    it('POST /domains returns 400 when the service throws (invalid domain)', async () => {
      vi.mocked(createPendingDomain).mockRejectedValue(new Error('Invalid domain: not-a-real-domain'));

      const res = await app.request('/sso/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'not-a-real-domain' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid domain');
    });

    it('POST /domains/:id/verify returns {data:{verified:true}} when the domain exists and DNS check passes', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: DOMAIN_UUID,
              orgId: ORG_UUID,
              domain: 'example.com',
            }]),
          }),
        }),
      } as any);

      vi.mocked(verifyDomain).mockResolvedValue({ verified: true });

      const res = await app.request(`/sso/domains/${DOMAIN_UUID}/verify`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.verified).toBe(true);
      expect(verifyDomain).toHaveBeenCalledWith({ orgId: ORG_UUID, domain: 'example.com' });
    });

    it('POST /domains/:id/verify returns 404 when the domain row does not exist', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/sso/domains/${DOMAIN_UUID}/verify`, {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      expect(verifyDomain).not.toHaveBeenCalled();
    });

    it('POST /domains/:id/verify returns 403 when canAccessOrg is false', async () => {
      setAuthContext({ canAccessOrg: () => false });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: DOMAIN_UUID,
              orgId: ORG_UUID_OTHER,
              domain: 'example.com',
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/sso/domains/${DOMAIN_UUID}/verify`, {
        method: 'POST',
      });

      expect(res.status).toBe(403);
      expect(verifyDomain).not.toHaveBeenCalled();
    });

    it('DELETE /domains/:id returns 403 when canAccessOrg is false', async () => {
      setAuthContext({ canAccessOrg: () => false });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: DOMAIN_UUID,
              orgId: ORG_UUID_OTHER,
              domain: 'example.com',
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/sso/domains/${DOMAIN_UUID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('DELETE /domains/:id returns {data:{deleted:true}} on success', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: DOMAIN_UUID,
              orgId: ORG_UUID,
              domain: 'example.com',
            }]),
          }),
        }),
      } as any);

      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: DOMAIN_UUID }]),
        }),
      } as any);

      const res = await app.request(`/sso/domains/${DOMAIN_UUID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deleted).toBe(true);
    });

    it('DELETE /domains/:id returns 404 when the domain row does not exist', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/sso/domains/${DOMAIN_UUID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });

    it('GET /domains lists domains with recordName and recordValue for the org', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: DOMAIN_UUID,
            domain: 'example.com',
            verificationToken: DOMAIN_TOKEN,
            verifiedAt: null,
            lastCheckedAt: null,
            createdAt: '2024-01-01T00:00:00.000Z',
          }]),
        }),
      } as any);

      const res = await app.request('/sso/domains', {
        method: 'GET',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].domain).toBe('example.com');
      expect(body.data[0].verified).toBe(false);
      expect(body.data[0].recordName).toBeDefined();
      expect(body.data[0].recordValue).toBeDefined();
    });
  });

  describe('partner-axis provider CRUD (#2183)', () => {
    it('creates a partner-axis provider for ownerScope=partner with orgAccess=all', async () => {
      setAuthContext({
        scope: 'partner',
        orgId: null,
        partnerId: PARTNER_UUID,
        accessibleOrgIds: [],
        partnerOrgAccess: 'all'
      });

      const valuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: PROVIDER_UUID,
          name: 'Partner Okta',
          orgId: null,
          partnerId: PARTNER_UUID
        }])
      });
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerScope: 'partner',
          name: 'Partner Okta',
          type: 'oidc'
        })
      });

      expect(res.status).toBe(201);
      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: null,
        partnerId: PARTNER_UUID
      }));
    });

    it('403s ownerScope=partner when partnerOrgAccess is not all', async () => {
      setAuthContext({
        scope: 'partner',
        orgId: null,
        partnerId: PARTNER_UUID,
        accessibleOrgIds: [ORG_UUID],
        partnerOrgAccess: 'selected'
      });

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerScope: 'partner',
          name: 'Partner Okta',
          type: 'oidc'
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('400s a partner-axis defaultRoleId that is not a partner-scoped role of the caller partner', async () => {
      setAuthContext({
        scope: 'partner',
        orgId: null,
        partnerId: PARTNER_UUID,
        accessibleOrgIds: [],
        partnerOrgAccess: 'all'
      });

      // No matching partner-scoped role for this partner.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerScope: 'partner',
          name: 'Partner Okta',
          type: 'oidc',
          defaultRoleId: '00000000-0000-4000-8000-000000000099'
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/partner-scoped role/);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects ownerScope on update (schema omits it)', async () => {
      // Existing provider is org-axis; a PATCH body carrying `ownerScope` must
      // be stripped by the schema (createProviderSchema.omit({ownerScope:true}))
      // so the axis is never touched by an update.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null }])
          })
        })
      } as any);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: PROVIDER_UUID,
            orgId: ORG_UUID,
            partnerId: null,
            name: 'Okta Renamed'
          }])
        })
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerScope: 'partner', name: 'Okta Renamed' })
      });

      expect(res.status).toBe(200);
      const setArg = setMock.mock.calls[0]?.[0];
      expect(setArg).not.toHaveProperty('ownerScope');
      expect(setArg).not.toHaveProperty('orgId');
    });

    it('does not accept partnerId from the request body', async () => {
      setAuthContext({
        scope: 'partner',
        orgId: null,
        partnerId: PARTNER_UUID,
        accessibleOrgIds: [],
        partnerOrgAccess: 'all'
      });

      const valuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: PROVIDER_UUID,
          name: 'Partner Okta',
          orgId: null,
          partnerId: PARTNER_UUID
        }])
      });
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerScope: 'partner',
          partnerId: 'p-EVIL',
          name: 'Partner Okta',
          type: 'oidc'
        })
      });

      expect(res.status).toBe(201);
      // partnerId always comes from the caller's token, never the body — even
      // though createProviderSchema doesn't define a `partnerId` input field,
      // this locks in the invariant so it can't regress if one is ever added.
      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: null,
        partnerId: PARTNER_UUID
      }));
    });

    it('allows a system-scope caller scoped to the same partner to read a partner-axis provider by id', async () => {
      // canAccessProviderRow requires `auth.partnerId === row.partnerId` even
      // for system scope (partner-axis rows are never globally world-readable
      // by an unscoped system token) — this simulates a system caller acting
      // with that partner context (e.g. support tooling), not the generic
      // background-worker system scope (which carries partnerId: null).
      setAuthContext({ scope: 'system', orgId: null, partnerId: PARTNER_UUID, accessibleOrgIds: null });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: PROVIDER_UUID,
              orgId: null,
              partnerId: PARTNER_UUID,
              name: 'Partner Okta',
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

      expect(res.status).toBe(200);
    });

    it('denies an org-scope caller from reading a partner-axis provider', async () => {
      setAuthContext({ scope: 'organization', orgId: ORG_UUID, partnerId: null, accessibleOrgIds: [ORG_UUID] });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: PROVIDER_UUID,
              orgId: null,
              partnerId: PARTNER_UUID,
              name: 'Partner Okta',
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

    it('403s deleting a partner-axis provider when the caller lacks full partner org access', async () => {
      setAuthContext({
        scope: 'partner',
        orgId: null,
        partnerId: PARTNER_UUID,
        accessibleOrgIds: [ORG_UUID],
        partnerOrgAccess: 'selected'
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: null, partnerId: PARTNER_UUID }])
          })
        })
      } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  // Public entry routes pick the provider with where().orderBy().limit()
  // (#2195 deterministic pick), so provider-select mocks need the orderBy hop.
  const providerSelectChain = (rows: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    })
  });

  const ACTIVE_OIDC_PROVIDER_ROW = {
    id: PROVIDER_UUID,
    orgId: null as string | null,
    partnerId: PARTNER_UUID as string | null,
    type: 'oidc',
    status: 'active',
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
  };

  describe('GET /sso/login/partner/:partnerId (#2183)', () => {
    it('404s when the partner has no active partner-axis provider', async () => {
      vi.mocked(db.select).mockReturnValue(providerSelectChain([]) as any);

      const res = await app.request(`/sso/login/partner/${PARTNER_UUID}`);

      expect(res.status).toBe(404);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('redirects to the IdP authorization URL and sets the state cookie for an active provider', async () => {
      vi.mocked(db.select).mockReturnValueOnce(providerSelectChain([ACTIVE_OIDC_PROVIDER_ROW]) as any);

      const valuesMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

      const res = await app.request(`/sso/login/partner/${PARTNER_UUID}?redirect=/dashboard`);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://idp.example.com/auth');
      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
        providerId: PROVIDER_UUID,
        redirectUrl: '/dashboard'
      }));
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('breeze_sso_state=');
    });

    it('429s when the shared pure-IP rate limit is exceeded, without touching the DB (#2195)', async () => {
      // First bucket checked is the pure-IP one shared with /login/:orgId.
      vi.mocked(rateLimiter).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 45_000)
      } as any);

      const res = await app.request(`/sso/login/partner/${PARTNER_UUID}`);

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe('Too many login attempts. Please try again later.');
      expect(body.retryAfter).toBeGreaterThan(0);
      expect(vi.mocked(rateLimiter).mock.calls[0]?.[1]).toMatch(/^sso:login:ip:/);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('429s when the per-IP+partner rate limit is exceeded, without touching the DB', async () => {
      const resetAt = new Date(Date.now() + 45_000);
      vi.mocked(rateLimiter)
        .mockResolvedValueOnce({ allowed: true, remaining: 20, resetAt } as any) // pure-IP bucket
        .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt } as any); // per-(ip,partner)

      const res = await app.request(`/sso/login/partner/${PARTNER_UUID}`);

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe('Too many login attempts. Please try again later.');
      expect(body.retryAfter).toBeGreaterThan(0);
      expect(vi.mocked(rateLimiter).mock.calls[1]?.[1]).toMatch(/^sso:login:partner:/);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('GET /sso/login/:orgId (#2195)', () => {
    it('404s when the org has no active provider', async () => {
      vi.mocked(db.select).mockReturnValue(providerSelectChain([]) as any);

      const res = await app.request(`/sso/login/${ORG_UUID}`);

      expect(res.status).toBe(404);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('redirects to the IdP authorization URL and sets the state cookie for an active org provider', async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        providerSelectChain([{ ...ACTIVE_OIDC_PROVIDER_ROW, orgId: ORG_UUID, partnerId: null }]) as any
      );

      const valuesMock = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as any);

      const res = await app.request(`/sso/login/${ORG_UUID}?redirect=/dashboard`);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://idp.example.com/auth');
      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
        providerId: PROVIDER_UUID,
        redirectUrl: '/dashboard'
      }));
      expect(res.headers.get('set-cookie') ?? '').toContain('breeze_sso_state=');
    });

    it('429s on the per-(IP, org) bucket without touching the DB', async () => {
      const resetAt = new Date(Date.now() + 45_000);
      vi.mocked(rateLimiter)
        .mockResolvedValueOnce({ allowed: true, remaining: 20, resetAt } as any)
        .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt } as any);

      const res = await app.request(`/sso/login/${ORG_UUID}`);

      expect(res.status).toBe(429);
      expect(vi.mocked(rateLimiter).mock.calls[1]?.[1]).toMatch(/^sso:login:org:/);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('GET /sso/check/:orgId (#2195)', () => {
    it('returns ssoEnabled false when the org has no active provider', async () => {
      vi.mocked(db.select).mockReturnValue(providerSelectChain([]) as any);

      const res = await app.request(`/sso/check/${ORG_UUID}`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ssoEnabled: false });
    });

    it('returns the provider summary and login URL when an active provider exists', async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        providerSelectChain([{ id: PROVIDER_UUID, name: 'Okta', type: 'oidc', enforceSSO: true }]) as any
      );

      const res = await app.request(`/sso/check/${ORG_UUID}`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ssoEnabled: true,
        provider: { id: PROVIDER_UUID, name: 'Okta', type: 'oidc' },
        enforceSSO: true,
        loginUrl: `/api/v1/sso/login/${ORG_UUID}`
      });
    });
  });

  describe('SSO callback — partner axis (#2183)', () => {
    // A partner-axis provider: partnerId set, orgId null (DB CHECK: org XOR partner).
    const PARTNER_PROVIDER = {
      id: PROVIDER_UUID,
      orgId: null,
      partnerId: PARTNER_UUID,
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
      defaultRoleId: null,
      trustsIdpMfa: false
    };
    const STAFF = {
      id: USER_UUID,
      email: 'tech@msp.example',
      name: 'Tech',
      orgId: null,
      partnerId: PARTNER_UUID,
      passwordHash: null
    };
    const sel = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) })
    } as any);
    const selJoin = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }) })
    } as any);
    const prime = () => {
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 'h.p.s' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'tech@msp.example', name: 'Tech' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'tech@msp.example', name: 'Tech' } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sso-session-p', providerId: PROVIDER_UUID, state: 'state', nonce: 'nonce', codeVerifier: 'verifier', redirectUrl: '/dashboard' }]) })
      } as any);
    };
    const doCallback = () => app.request('/sso/callback?code=oidc-code&state=state', { method: 'GET', headers: { cookie: ssoStateCookieHeader('state') } });

    it('logs in linked partner staff with scope partner and null orgId', async () => {
      prime();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))                 // provider by id
        .mockReturnValueOnce(sel([{ userId: USER_UUID }]))           // (provider, sub) identity link
        .mockReturnValueOnce(sel([STAFF]))                           // linked user by id
        .mockReturnValueOnce(selJoin([{ roleId: 'prole-1', roleScope: 'partner' }])) // partner_users membership
        .mockReturnValueOnce(sel([{ id: 'identity-1' }]));           // existingIdentity → update

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_UUID, roleId: 'prole-1', orgId: null, partnerId: PARTNER_UUID, scope: 'partner' }),
        expect.any(Object)
      );
      expect(auditLogin).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ scope: 'partner', method: 'sso-partner', orgId: null, userId: USER_UUID })
      );
    });

    it('auto-links by email ONLY for passwordless unlinked partner staff', async () => {
      prime();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([]))                                // no (provider, sub) link
        .mockReturnValueOnce(sel([STAFF]))                           // byEmail (partnerId match, orgId IS NULL)
        .mockReturnValueOnce(sel([]))                                // no other-provider link → safe to link
        .mockReturnValueOnce(selJoin([{ roleId: 'prole-1', roleScope: 'partner' }]))
        .mockReturnValueOnce(sel([]));                               // existingIdentity none → insert

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'partner', partnerId: PARTNER_UUID, orgId: null }),
        expect.any(Object)
      );
    });

    it('redirects identity_in_use when the identity INSERT loses the unique-index race to a DIFFERENT user (#2195)', async () => {
      prime();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([]))                                // no (provider, sub) link yet
        .mockReturnValueOnce(sel([STAFF]))                           // byEmail (safe JIT link)
        .mockReturnValueOnce(sel([]))                                // no other-provider link
        .mockReturnValueOnce(selJoin([{ roleId: 'prole-1', roleScope: 'partner' }]))
        .mockReturnValueOnce(sel([]))                                // existingIdentity none → insert path
        .mockReturnValueOnce(sel([{ userId: '00000000-0000-4000-8000-0000000000aa' }])); // conflict row → someone else
      // ON CONFLICT DO NOTHING returns no rows → a concurrent callback linked
      // this (provider, sub) first.
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
        }))
      } as any);

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=identity_in_use');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('proceeds when the identity INSERT loses the race to the SAME user (parallel logins)', async () => {
      prime();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([]))                                // no link yet
        .mockReturnValueOnce(sel([STAFF]))                           // byEmail (safe JIT link)
        .mockReturnValueOnce(sel([]))                                // no other-provider link
        .mockReturnValueOnce(selJoin([{ roleId: 'prole-1', roleScope: 'partner' }]))
        .mockReturnValueOnce(sel([]))                                // existingIdentity none → insert path
        .mockReturnValueOnce(sel([{ userId: USER_UUID }]));          // conflict row → same user
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
        }))
      } as any);

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'partner', partnerId: PARTNER_UUID, orgId: null }),
        expect.any(Object)
      );
    });

    it('redirects sso_link_required for a password-holding email match', async () => {
      prime();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([]))                                // no link
        .mockReturnValueOnce(sel([{ ...STAFF, passwordHash: '$argon2id$hash' }])) // byEmail w/ password
        .mockReturnValueOnce(sel([]));                               // otherProviderLink — still denied (has password)

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_link_required');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('never resolves an org-bound user through a partner provider', async () => {
      prime();
      // The email-match lookup is axis-restricted to `partnerId = provider.partnerId
      // AND orgId IS NULL`, so an org-bound user sharing the email is filtered out
      // at the DB layer → the mock returns [] → falls through to invite_required.
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([]))                                // no link
        .mockReturnValueOnce(sel([]));                               // byEmail excludes org-bound user

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=invite_required');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('redirects invite_required for unknown identities (no JIT)', async () => {
      prime();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([]))                                // no link
        .mockReturnValueOnce(sel([]));                               // no email match

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=invite_required');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a linked user whose row is org-bound even with a partner membership (mint-gate re-assert)', async () => {
      prime();
      // Pre-existing (provider, sub) link resolves an ORG-BOUND user (orgId set).
      // The mint-gate orgId IS NULL re-assert must reject before minting, even
      // though a partner membership could exist.
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([{ userId: USER_UUID }]))           // link exists
        .mockReturnValueOnce(sel([{ ...STAFF, orgId: ORG_UUID }]));  // resolved user is org-bound

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=no_partner_access');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('redirects no_partner_access when the user has no partner_users membership', async () => {
      prime();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([{ userId: USER_UUID }]))           // linked
        .mockReturnValueOnce(sel([STAFF]))
        .mockReturnValueOnce(selJoin([]));                           // NO partner_users membership

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=no_partner_access');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a partner provider whose defaultRoleId is not partner-scoped', async () => {
      prime();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([{ ...PARTNER_PROVIDER, defaultRoleId: 'bad-role' }]))
        .mockReturnValueOnce(sel([]));                               // role not partner-scoped in this partner → not found

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=invalid_provider_configuration');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    const wireMfa = (opts: { trustsIdpMfa: boolean; amr?: string[] }) => {
      prime();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce', amr: opts.amr } as any);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([{ ...PARTNER_PROVIDER, trustsIdpMfa: opts.trustsIdpMfa }]))
        .mockReturnValueOnce(sel([{ userId: USER_UUID }]))
        .mockReturnValueOnce(sel([STAFF]))
        .mockReturnValueOnce(selJoin([{ roleId: 'prole-1', roleScope: 'partner' }]))
        .mockReturnValueOnce(sel([{ id: 'identity-1' }]));
    };

    it('sets mfa true only with trustsIdpMfa AND amr mfa', async () => {
      wireMfa({ trustsIdpMfa: true, amr: ['pwd', 'mfa'] });
      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'partner', mfa: true }),
        expect.any(Object)
      );
    });

    it('sets mfa false when trustsIdpMfa is set but amr does not attest mfa', async () => {
      wireMfa({ trustsIdpMfa: true, amr: ['pwd'] });
      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'partner', mfa: false }),
        expect.any(Object)
      );
    });
  });

  describe('POST /sso/providers/:id/test — partner axis (#2183)', () => {
    const OTHER_PARTNER = '00000000-0000-4000-8000-0000000000ff';
    // Partner-axis provider WITHOUT an issuer → skips discovery, returns the
    // "appears valid" success path once access is granted.
    const partnerProviderRow = {
      id: PROVIDER_UUID, orgId: null, partnerId: PARTNER_UUID, type: 'oidc', name: 'MSP IdP', issuer: null
    };

    it('allows a partner-scope caller to test their own partner-axis provider', async () => {
      setAuthContext({ scope: 'partner', orgId: null, partnerId: PARTNER_UUID, accessibleOrgIds: [], partnerOrgAccess: 'all' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([partnerProviderRow]) }) })
      } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}/test`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('denies a cross-partner caller (no canAccessOrg fall-through on the partner axis)', async () => {
      // canAccessOrg defaults to () => true — the deny MUST come from the
      // axis-aware provider check, not an org fall-through.
      setAuthContext({ scope: 'partner', orgId: null, partnerId: OTHER_PARTNER, accessibleOrgIds: [], partnerOrgAccess: 'all' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([partnerProviderRow]) }) })
      } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}/test`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // Self-service "Connect SSO" identity linking (#2183, Task 6)
  // ============================================================
  describe('Connect SSO link flow (#2183)', () => {
    const OTHER_PARTNER = '00000000-0000-4000-8000-0000000000ff';
    const sel = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) })
    } as any);
    // /link/options uses a leftJoin then a where that resolves directly (no limit).
    const selLeftJoin = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ leftJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) })
    } as any);

    const ORG_PROVIDER = {
      id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, status: 'active', type: 'oidc',
      name: 'Okta', issuer: 'https://issuer.example.com',
      authorizationUrl: 'https://issuer.example.com/auth', tokenUrl: 'https://issuer.example.com/token',
      userInfoUrl: 'https://issuer.example.com/userinfo', jwksUrl: 'https://issuer.example.com/jwks',
      clientId: 'client-id', clientSecret: 'client-secret', scopes: 'openid profile email',
      attributeMapping: { email: 'email', name: 'name' }, defaultRoleId: null
    };
    const PARTNER_PROVIDER = { ...ORG_PROVIDER, orgId: null, partnerId: PARTNER_UUID, name: 'MSP IdP' };

    it('GET /sso/link/options lists org-axis providers with linked flags', async () => {
      // org user (scope organization, orgId set) → org-axis providers.
      vi.mocked(db.select).mockReturnValueOnce(selLeftJoin([
        { id: 'p-1', name: 'Okta', type: 'oidc', linkedId: 'link-1' },
        { id: 'p-2', name: 'Entra', type: 'oidc', linkedId: null }
      ]));

      const res = await app.request('/sso/link/options', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([
        { id: 'p-1', name: 'Okta', type: 'oidc', linked: true },
        { id: 'p-2', name: 'Entra', type: 'oidc', linked: false }
      ]);
    });

    it('GET /sso/link/options lists partner-axis providers for partner staff', async () => {
      setAuthContext({ scope: 'partner', orgId: null, partnerId: PARTNER_UUID, accessibleOrgIds: [] });
      vi.mocked(db.select).mockReturnValueOnce(selLeftJoin([
        { id: 'pp-1', name: 'MSP IdP', type: 'oidc', linkedId: null }
      ]));

      const res = await app.request('/sso/link/options', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([{ id: 'pp-1', name: 'MSP IdP', type: 'oidc', linked: false }]);
    });

    it('POST /sso/link/start/:providerId returns authUrl, sets state cookie, and stamps linkUserId', async () => {
      vi.mocked(db.select).mockReturnValueOnce(sel([ORG_PROVIDER]));
      const insertValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
      vi.mocked(db.insert).mockReturnValueOnce({ values: insertValues } as any);

      const res = await app.request(`/sso/link/start/${PROVIDER_UUID}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authUrl).toMatch(/^https:\/\/idp\.example\.com\/auth/);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('breeze_sso_state');
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ linkUserId: USER_UUID }));
    });

    it('POST /sso/link/start 401s an unauthenticated caller', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any) => c.json({ error: 'Unauthorized' }, 401));

      const res = await app.request(`/sso/link/start/${PROVIDER_UUID}`, { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('POST /sso/link/start is blocked without MFA (requireMfa)', async () => {
      mfaGate.deny = true;
      const res = await app.request(`/sso/link/start/${PROVIDER_UUID}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(403);
    });

    it('POST /sso/link/start 403s a provider outside the user axis pool', async () => {
      // org user attempting to link a PARTNER-axis provider → 403.
      vi.mocked(db.select).mockReturnValueOnce(sel([PARTNER_PROVIDER]));
      const orgRes = await app.request(`/sso/link/start/${PROVIDER_UUID}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });
      expect(orgRes.status).toBe(403);

      // partner staff attempting to link ANOTHER partner's provider → 403.
      setAuthContext({ scope: 'partner', orgId: null, partnerId: OTHER_PARTNER, accessibleOrgIds: [] });
      vi.mocked(db.select).mockReturnValueOnce(sel([PARTNER_PROVIDER]));
      const partnerRes = await app.request(`/sso/link/start/${PROVIDER_UUID}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });
      expect(partnerRes.status).toBe(403);
    });

    // ── Callback link-mode branch ──────────────────────────────────────────
    const primeLinkCallback = (linkUserId: string) => {
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 'h.p.s' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'tech@example.com', name: 'Tech' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'tech@example.com', name: 'Tech' } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sso-session-link', providerId: PROVIDER_UUID, state: 'state', nonce: 'nonce', codeVerifier: 'verifier', redirectUrl: '/settings/profile', linkUserId }]) })
      } as any);
    };
    const doCallback = () => app.request('/sso/callback?code=oidc-code&state=state', { method: 'GET', headers: { cookie: ssoStateCookieHeader('state') } });

    it('callback link mode creates the identity for the SESSION user after verification', async () => {
      primeLinkCallback(USER_UUID);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([ORG_PROVIDER]))                                        // provider by id
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'tech@example.com', name: 'Tech' }])) // linking user
        .mockReturnValueOnce(sel([]));                                                    // (provider, sub) not in use
      const insertValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
      vi.mocked(db.insert).mockReturnValueOnce({ values: insertValues } as any);

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/profile?ssoLinked=1');
      expect(createTokenPair).not.toHaveBeenCalled();
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
        userId: USER_UUID, providerId: PROVIDER_UUID, externalId: 'external-user-1'
      }));
    });

    it('callback link mode rejects an email mismatch (no insert)', async () => {
      primeLinkCallback(USER_UUID);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([ORG_PROVIDER]))
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'someone-else@corp.com', name: 'Other' }]));

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('ssoLinkError=email_mismatch');
      expect(db.insert).not.toHaveBeenCalled();
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('callback link mode rejects a (provider, sub) already linked to another user (no insert)', async () => {
      primeLinkCallback(USER_UUID);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([ORG_PROVIDER]))
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'tech@example.com', name: 'Tech' }]))
        .mockReturnValueOnce(sel([{ id: 'identity-x', userId: '00000000-0000-4000-8000-0000000000aa' }]));

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('ssoLinkError=identity_in_use');
      expect(db.insert).not.toHaveBeenCalled();
      expect(createTokenPair).not.toHaveBeenCalled();
    });
  });
});
