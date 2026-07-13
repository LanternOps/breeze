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
  // SR2-12: real logic (not a stub) so the callback tests actually exercise the
  // claim reader across id_token / userinfo bodies.
  readEmailVerifiedClaim: (source: Record<string, unknown> | null | undefined) => {
    const ev = source?.email_verified;
    if (ev === true || ev === 'true') return 'true';
    if (ev === false || ev === 'false') return 'false';
    return 'absent';
  },
  // Real logic (not a stub) so the IdP-MFA tests exercise the amr check.
  idpAssertedMfa: (claims: { amr?: unknown }) => Array.isArray(claims?.amr) && claims.amr.includes('mfa'),
  mapUserAttributes: vi.fn(),
  discoverOIDCConfig: vi.fn(),
  // SR2-14: getOIDCConfig (defined in the route file, NOT mocked) now calls this
  // to re-validate persisted endpoints at runtime. Faithful mirror of the real
  // implementation (missing / non-HTTPS / internal-literal → throw) so the
  // runtime-revalidation tests bite while safe https endpoints stay no-ops.
  assertSafeOidcEndpoint: (label: string, urlStr: string | null | undefined, allowPrivateNetwork = false) => {
    if (!urlStr) throw new Error(`OIDC endpoint missing: ${label}`);
    let u: URL;
    try { u = new URL(urlStr); } catch { throw new Error(`OIDC endpoint rejected: ${label}`); }
    const isHttps = u.protocol === 'https:';
    const isHttp = u.protocol === 'http:';
    if (!isHttps && !(allowPrivateNetwork && isHttp)) throw new Error(`OIDC endpoint rejected (must be HTTPS): ${label}`);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost') throw new Error(`OIDC endpoint rejected (internal): ${label}`);
    const literalIp = /^[0-9.]+$/.test(host) || host.includes(':');
    if (literalIp && /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1|::$|fc|fd|fe80)/i.test(host)) {
      throw new Error(`OIDC endpoint rejected (internal): ${label}`);
    }
  },
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
  getUserEpochs: vi.fn().mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 }),
  // SR2-11b: /sso/link/start binds the pending link to the initiating refresh
  // family; the link callback re-checks it is still live (not revoked/expired)
  // as part of validateLinkBinding. Default: a healthy, far-future family.
  getRefreshFamily: vi.fn().mockResolvedValue({
    revokedAt: null,
    absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }),
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
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  // SR2-10 Fix 2: revalidateSsoDefaultRole asserts the ambient context is
  // 'system' before doing anything else. withSystemDbAccessContext above is a
  // dumb passthrough (it does not actually track ambient state the way the
  // real AsyncLocalStorage-backed implementation does), so this mock is what
  // stands in for "the wrap really ran" — default it to 'system' so every
  // existing test (which relies on the wrap being effective) stays green. The
  // dedicated Fix 2 test below overrides this to prove the guard bites.
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' as const }))
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
    jwksUrl: 'jwksUrl',
    // SR2-11 (config generation) + SR2-10 (default-role delegation) columns —
    // kept in the mock so any eq()/set() reference on them resolves to a real
    // key instead of `undefined`.
    configVersion: 'configVersion',
    createdBy: 'createdBy',
    defaultRoleId: 'defaultRoleId',
    defaultRoleConfiguredBy: 'defaultRoleConfiguredBy'
  },
  ssoSessions: {
    id: 'id',
    providerId: 'providerId',
    state: 'state',
    nonce: 'nonce',
    codeVerifier: 'codeVerifier',
    redirectUrl: 'redirectUrl',
    linkUserId: 'linkUserId',
    // SR2-11 binding columns (2026-07-16 migration): kept in the mock so any
    // eq()/insert reference on them resolves to a real key instead of
    // `undefined` (an empty-object mock silently breaks assertions on these).
    providerVersion: 'providerVersion',
    initiatingAuthEpoch: 'initiatingAuthEpoch',
    initiatingMfaEpoch: 'initiatingMfaEpoch',
    initiatingSessionId: 'initiatingSessionId',
    expiresAt: 'expiresAt',
    createdAt: 'createdAt',
  },
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
    partnerId: 'partnerId',
    // SR2-10: the JIT ceiling re-check reads the configurer's live status —
    // a disabled/offboarded configurer must not keep delegating a role.
    status: 'status'
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
  // SR2-10: the callback resolves the provider org's owning partner so the
  // configurer's permissions resolve on the PARTNER axis too (an MSP partner
  // admin has no organization_users row). Previously absent from this mock —
  // the JIT provisioning path was never exercised by a unit test.
  organizations: {
    id: 'id',
    partnerId: 'partnerId'
  },
  roles: {
    id: 'id',
    name: 'name',
    scope: 'scope',
    orgId: 'orgId',
    partnerId: 'partnerId',
    isSystem: 'isSystem',
    description: 'description',
    parentRoleId: 'parentRoleId'
  },
  // Consumed by the REAL services/roleAssignment (deliberately not mocked in
  // this suite — see the SR2-10 describe block).
  permissions: {
    id: 'id',
    resource: 'resource',
    action: 'action'
  },
  rolePermissions: {
    roleId: 'roleId',
    permissionId: 'permissionId'
  }
}));

// SR2-10: keep PERMISSIONS (read at module scope by the route's
// requirePermission guard) REAL; only getUserPermissions is driven per-test.
// It is the resolver for BOTH the config-time caller ceiling and the JIT
// configurer ceiling.
const { permissionsByUser } = vi.hoisted(() => ({
  permissionsByUser: {} as Record<string, { permissions: Array<{ resource: string; action: string }> } | null>,
}));

vi.mock('../services/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/permissions')>()),
  getUserPermissions: vi.fn(async (userId: string) => permissionsByUser[userId] ?? null),
}));

// Spy on the audit sink so SR2-10 denials can be asserted by action/reason.
// Also removes writeRouteAudit's fire-and-forget audit-log db.insert from the
// mock queues, which keeps the callback select/insert ordering deterministic.
vi.mock('../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/auditEvents')>()),
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/ssoDomainVerification', () => ({
  createPendingDomain: vi.fn(),
  verifyDomain: vi.fn(),
  recordNameFor: vi.fn((domain: string) => `_breeze-verify.${domain}`),
  recordValueFor: vi.fn((token: string) => `breeze-domain-verify=${token}`),
  isSsoProvisioningBlocked: vi.fn().mockResolvedValue(false),
  // NEW (SR2-12): the hard absent-claim gate. Default true so existing tests,
  // which assert on isSsoProvisioningBlocked, are unaffected.
  isDomainVerifiedForOrg: vi.fn().mockResolvedValue(true),
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
      user: { id: '00000000-0000-4000-8000-000000000020', email: 'test@example.com' },
      // SR2-11b: /sso/link/start binds the pending session to the initiating
      // refresh family. Without this key every link test throws on auth.token.sid.
      token: { sid: '00000000-0000-4000-8000-0000000000fa' },
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

import { db, runOutsideDbContext, withSystemDbAccessContext, getCurrentDbAccessContext } from '../db';
import { createTokenPair, rateLimiter, getUserEpochs, getRefreshFamily } from '../services';
import { authMiddleware } from '../middleware/auth';
import {
  discoverOIDCConfig,
  exchangeCodeForTokens,
  getUserInfo,
  mapUserAttributes,
  verifyIdTokenSignature,
} from '../services/sso';
import { createPendingDomain, verifyDomain, isSsoProvisioningBlocked, isDomainVerifiedForOrg } from '../services/ssoDomainVerification';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { getUserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
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
    token: Record<string, unknown>;
  }> = {}) => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: overrides.scope ?? 'organization',
        orgId: 'orgId' in overrides ? overrides.orgId : ORG_UUID,
        partnerId: 'partnerId' in overrides ? overrides.partnerId : null,
        accessibleOrgIds: 'accessibleOrgIds' in overrides ? overrides.accessibleOrgIds : [ORG_UUID],
        canAccessOrg: overrides.canAccessOrg ?? (() => true),
        partnerOrgAccess: 'partnerOrgAccess' in overrides ? overrides.partnerOrgAccess : null,
        user: { id: USER_UUID, email: 'test@example.com' },
        // SR2-11b: /sso/link/start binds the pending session to the initiating
        // refresh family — defaults to a populated sid; tests that need to
        // exercise the missing-sid 503 path override `token`.
        token: 'token' in overrides ? overrides.token : { sid: '00000000-0000-4000-8000-0000000000fa' }
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
    // SR2-12: these ssoDomainVerification mocks are set with persistent
    // implementations (mockResolvedValue) by individual tests, and clearAllMocks
    // does NOT reset implementations — so restore their factory defaults here so
    // a prior test's override (e.g. isSsoProvisioningBlocked=true, or the SR2-12
    // absent-claim gate's isDomainVerifiedForOrg=false) cannot bleed forward.
    vi.mocked(isSsoProvisioningBlocked).mockReset().mockResolvedValue(false);
    vi.mocked(isDomainVerifiedForOrg).mockReset().mockResolvedValue(true);
    delete process.env.SSO_EXCHANGE_RETURN_REFRESH_TOKEN;
    process.env.APP_ENCRYPTION_KEY = SSO_STATE_COOKIE_SECRET;
    permissionGate.deny = false;
    mfaGate.deny = false;
    for (const key of Object.keys(permissionsByUser)) delete permissionsByUser[key];
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
    // IS_HOSTED is unset in the test env → strict (no private-network opt-in).
    expect(discoverOIDCConfig).toHaveBeenCalledWith('https://issuer.example.com', {
      allowPrivateNetwork: false
    });
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

  // Bug repro: the web edit form always resubmits every field, so a blank
  // <select>/<input> for an optional-but-nullable column (issuer, url();
  // defaultRoleId, guid()) is posted as `''`. Before the fix `z.string().url()`
  // / `.guid()` rejected `''` outright -> 400, silently failing the save (the
  // form never omits the key). The fix normalizes '' -> explicit NULL at the
  // schema boundary so blank always means "clear this value", distinct from
  // the key being absent entirely ("leave unchanged" — covered below).
  describe('blank vs omitted optional fields on /sso/providers (issuer, defaultRoleId)', () => {
    it('creates a provider when issuer and defaultRoleId are posted as blank strings (does not 400)', async () => {
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
          issuer: '',
          defaultRoleId: ''
        })
      });

      expect(res.status).toBe(201);
      expect(discoverOIDCConfig).not.toHaveBeenCalled();
      // Persisted as NULL, not the literal empty string — an empty string in
      // a `varchar` column is a real (wrong) value, not "no value".
      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
        issuer: null,
        defaultRoleId: null
      }));
    });

    it('clears a previously-set default role on PATCH when defaultRoleId is blanked (persists NULL)', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null }])
          })
        })
      } as any);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, name: 'Okta', defaultRoleId: null }])
        })
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Exactly what the web form sends when the admin resets the "Default
        // role for new users" <select> to its blank "Select a role" option.
        body: JSON.stringify({ defaultRoleId: '' })
      });

      expect(res.status).toBe(200);
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ defaultRoleId: null }));
    });

    it('clears a partner-owned provider default role without re-running the partner-role permission check', async () => {
      // existing.partnerId is truthy — the update route's role-ceiling check
      // only fires `if (existing.partnerId && body.defaultRoleId)`. Clearing
      // must resolve body.defaultRoleId to a falsy `null`, so the check is
      // skipped (nothing to validate — there's no role being granted) and no
      // extra db.select is consumed for it.
      setAuthContext({
        scope: 'partner',
        orgId: null,
        partnerId: PARTNER_UUID,
        accessibleOrgIds: [],
        partnerOrgAccess: 'all'
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: null, partnerId: PARTNER_UUID }])
          })
        })
      } as any);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, name: 'Partner Okta', partnerId: PARTNER_UUID, defaultRoleId: null }])
        })
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultRoleId: '' })
      });

      expect(res.status).toBe(200);
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ defaultRoleId: null }));
    });

    it('leaves defaultRoleId untouched on PATCH when the field is omitted entirely from the body', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null }])
          })
        })
      } as any);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, name: 'Renamed' }])
        })
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' })
      });

      expect(res.status).toBe(200);
      // No `defaultRoleId` key at all in the update — distinct from an
      // explicit `null` (clear). A previously-set role must survive a save
      // that never touched the field.
      const setArg = setMock.mock.calls[0]?.[0];
      expect(setArg).not.toHaveProperty('defaultRoleId');
      expect(setArg).not.toHaveProperty('issuer');
    });
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

  // Regression guard (SR2-11): sso_sessions is now system-scope-only under
  // FORCE RLS, with no ON DELETE CASCADE from sso_providers. Before the
  // cleanup deletes were wrapped in withSystemDbAccessContext, the first
  // delete (sso_sessions) would 0-row from the admin's tenant-scoped
  // context whenever a pending session existed, and the sso_providers
  // delete three lines later would then die with FK violation 23503 — i.e.
  // provider deletion would fail within 10 minutes of any login attempt.
  // This asserts the happy path still returns 200 with all three deletes
  // issued and system context invoked around the cleanup.
  it('deletes a provider with a pending session present (FK-violation regression guard)', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID }])
        })
      })
    } as any);

    // First delete call = ssoSessions — simulate a pending session row
    // existing (matched by the providerId filter) that must be cleared
    // before the FK-checked ssoProviders delete below can succeed.
    vi.mocked(db.delete)
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ id: 'pending-session-id' }]) } as any)
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

    // All three deletes fired (sso_sessions, user_sso_identities, sso_providers)...
    expect(db.delete).toHaveBeenCalledTimes(3);
    // ...and the sso_sessions/user_sso_identities cleanup ran through system
    // context, not the caller's tenant-scoped context.
    expect(runOutsideDbContext).toHaveBeenCalled();
    expect(withSystemDbAccessContext).toHaveBeenCalled();
    // Atomicity: all three deletes must be issued from inside ONE
    // withSystemDbAccessContext invocation, not the cleanup pair in one call
    // and the provider delete in a second (which would put the provider
    // delete back in the request transaction on a different connection).
    //
    // NOTE: withSystemDbAccessContext is called a SECOND time on this happy
    // path too — but that second call is the unrelated writeRouteAudit ->
    // createAuditLogAsync fire-and-forget audit-log write (see
    // services/auditService.ts), not a second provider-cleanup wrap. So a
    // bare `toHaveBeenCalledTimes(1)` assertion would be wrong here; instead
    // assert that all three delete() calls landed inside the FIRST
    // withSystemDbAccessContext invocation, before any subsequent one fired.
    // The mock harness can prove this grouping via invocation order, but it
    // cannot observe connection/transaction boundaries directly — that
    // cross-connection guarantee is left to the Task 8 integration suite
    // against a real Postgres.
    const deleteCallOrders = vi.mocked(db.delete).mock.invocationCallOrder;
    const systemCtxCallOrders = vi.mocked(withSystemDbAccessContext).mock.invocationCallOrder;
    const secondSystemCtxCallOrder = systemCtxCallOrders[1];
    expect(deleteCallOrders).toHaveLength(3);
    if (secondSystemCtxCallOrder !== undefined) {
      expect(deleteCallOrders.every((order) => order < secondSystemCtxCallOrder)).toBe(true);
    }
  });

  // Atomicity regression guard (SR2-11): the provider delete must live in the
  // SAME withSystemDbAccessContext call as the sso_sessions/user_sso_identities
  // cleanup. Before this fix, the provider delete ran separately in the
  // caller's request transaction — so a concurrent-delete 404 here (or a
  // thrown error) would roll back the request transaction while the cleanup
  // deletes, already committed on a different connection, stayed gone
  // forever. This proves the 404 path is reached via the single wrapped call
  // and that no second withSystemDbAccessContext invocation was made to
  // salvage/duplicate the provider delete. Unlike the happy-path test above,
  // `toHaveBeenCalledTimes(1)` IS a valid assertion here: the 404 branch
  // returns before writeRouteAudit (and its own unrelated
  // withSystemDbAccessContext call) is ever reached.
  it('returns 404 without a second system-context call when the provider delete finds no row (concurrent-delete race)', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID }])
        })
      })
    } as any);

    // sso_sessions and user_sso_identities cleanup succeed, but by the time
    // the provider delete runs (still inside the same system-context call),
    // a concurrent request has already removed the row — .returning() comes
    // back empty.
    vi.mocked(db.delete)
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) } as any)
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) } as any)
      .mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([])
        })
      } as any);

    const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Provider not found');

    // All three deletes were still attempted inside the one wrapped call —
    // the handler doesn't short-circuit the cleanup deletes early, and it
    // doesn't retry/fall back into a second system-context invocation.
    expect(db.delete).toHaveBeenCalledTimes(3);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
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
    // IS_HOSTED unset → strict. Guards against a revert that drops the options
    // object from the Test-button call site (the whole point of #2293).
    expect(discoverOIDCConfig).toHaveBeenCalledWith('https://issuer.example.com', {
      allowPrivateNetwork: false
    });
  });

  it('passes allowPrivateNetwork: true to discovery on the Test route when self-hosted', async () => {
    process.env.IS_HOSTED = 'false';
    try {
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
      expect(discoverOIDCConfig).toHaveBeenCalledWith('https://issuer.example.com', {
        allowPrivateNetwork: true
      });
    } finally {
      delete process.env.IS_HOSTED;
    }
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
          redirectUrl: '/dashboard',
          providerVersion: 1
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
              status: 'active',
              configVersion: 1,
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
          redirectUrl: '/',
          providerVersion: 1
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
              status: 'active',
              configVersion: 1,
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
                redirectUrl: '/dashboard',
                providerVersion: 1
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
                status: 'active',
                configVersion: 1,
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
      id: PROVIDER_UUID, orgId: ORG_UUID, type: 'oidc', status: 'active', configVersion: 1,
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
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sso-session-z', providerId: PROVIDER_UUID, state: 'state', nonce: 'nonce', codeVerifier: 'verifier', redirectUrl: '/dashboard', providerVersion: 1 }]) })
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

    // SR2-14: the callback re-reads the provider and builds its OIDC config via
    // getOIDCConfig, which now re-validates the persisted endpoints. A stale/
    // attacker tokenUrl (e.g. left by a PATCH issuer change) must abort the flow
    // via the existing catch-all redirect BEFORE the code is exchanged — the
    // decrypted client_secret never leaves the process.
    it('re-validates persisted endpoints at runtime: an unsafe tokenUrl redirects without a token exchange', async () => {
      primeCallback();
      vi.mocked(db.select).mockReturnValueOnce(
        sel([{ ...PROVIDER_ROW[0], tokenUrl: 'http://evil.example.com/token' }])
      );

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('/login?error=sso_error');
      expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    });

    it('refuses to JIT-link an SSO assertion to an existing PASSWORD account (1B)', async () => {
      primeCallback();
      vi.mocked(db.select)
        .mockReturnValueOnce(sel(PROVIDER_ROW))
        .mockReturnValueOnce(sel([])) // no (provider, sub) link yet
        .mockReturnValueOnce(sel([{ userId: USER_UUID }])) // SR2-12: org-members subquery for emailCondition clamp (constructed before byEmail)
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
        .mockReturnValueOnce(sel([{ userId: USER_UUID }])) // SR2-12: org-members subquery for emailCondition clamp
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
        .mockReturnValueOnce(sel([{ userId: USER_UUID }])) // SR2-12: org-members subquery for emailCondition clamp
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

  describe('SSO verified identity claims (SR2-12)', () => {
    const sel = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) })
    } as any);
    const selJoin = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }) })
    } as any);
    const ORG_PROVIDER = {
      id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, type: 'oidc', status: 'active', configVersion: 1,
      issuer: 'https://issuer.example.com', authorizationUrl: 'https://issuer.example.com/auth',
      tokenUrl: 'https://issuer.example.com/token', userInfoUrl: 'https://issuer.example.com/userinfo',
      jwksUrl: 'https://issuer.example.com/jwks', clientId: 'client-id', clientSecret: 'client-secret',
      scopes: 'openid profile email', attributeMapping: { email: 'email', name: 'name' },
      autoProvision: false, allowedDomains: null, defaultRoleId: null, trustsIdpMfa: false
    };
    const PARTNER_PROVIDER = {
      ...ORG_PROVIDER, orgId: null, partnerId: PARTNER_UUID,
    };
    // Prime the session-claim delete + userinfo/exchange. Callers set
    // verifyIdTokenSignature / getUserInfo / mapUserAttributes for the case.
    const primeSession = () => {
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 'h.p.s' } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sso-session-v', providerId: PROVIDER_UUID, state: 'state', nonce: 'nonce', codeVerifier: 'verifier', redirectUrl: '/dashboard', providerVersion: 1 }]) })
      } as any);
    };
    const doCallback = () => app.request('/sso/callback?code=oidc-code&state=state', { method: 'GET', headers: { cookie: ssoStateCookieHeader('state') } });

    // 1. id_token email_verified:false → reject before identity resolution.
    it('rejects an id_token asserting email_verified:false', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce', email: 'test@corp.example', email_verified: false } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(db.select).mockReturnValueOnce(sel([ORG_PROVIDER]));

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_email_unverified');
      expect(createTokenPair).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    // 2. id_token omits email; userinfo carries email_verified:false → reject.
    //    This is the path that was NEVER read before SR2-12.
    it('rejects when the id_token omits email and userinfo asserts email_verified:false', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 's1', nonce: 'nonce' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 's1', email: 'x@corp.example', email_verified: false, name: 'X' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'x@corp.example', name: 'X' } as any);
      vi.mocked(db.select).mockReturnValueOnce(sel([ORG_PROVIDER]));

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_email_unverified');
      expect(createTokenPair).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    // 3. Absent claim + org axis + domain NOT verified + no existing link → reject.
    it('rejects an absent claim on the org axis when the domain is not verified', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(isDomainVerifiedForOrg).mockResolvedValueOnce(false);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([ORG_PROVIDER]))
        .mockReturnValueOnce(sel([])); // no (provider, sub) link → user null → domain gate

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_email_unverified');
      expect(createTokenPair).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    // 4. Absent claim + org axis + domain VERIFIED → proceeds to the auto-link path.
    it('allows an absent claim on the org axis when Breeze has proven the domain', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'test@corp.example', name: 'T' } as any);
      // isDomainVerifiedForOrg defaults to true (mock factory).
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([ORG_PROVIDER]))
        .mockReturnValueOnce(sel([]))                              // no (provider, sub) link
        .mockReturnValueOnce(sel([{ userId: USER_UUID }]))        // org-members subquery (emailCondition clamp)
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'test@corp.example', name: 'SsoOnly', passwordHash: null }])) // byEmail
        .mockReturnValueOnce(sel([]))                             // no other-provider link → safe to link
        .mockReturnValueOnce(selJoin([{ orgId: ORG_UUID, roleId: 'role-1', roleName: 'Member', roleScope: 'organization' }]))
        .mockReturnValueOnce(sel([]));                            // existingIdentity none → insert

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      expect(createTokenPair).toHaveBeenCalled();
    });

    // 5. Absent claim + PARTNER axis → tolerated (documented gap): reaches the
    //    partner identity resolution and, with no user, invite_required — NOT
    //    sso_email_unverified.
    it('tolerates an absent claim on the partner axis (documented gap)', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'tech@msp.example', name: 'Tech' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'tech@msp.example', name: 'Tech' } as any);
      // Even if the org-domain machinery would say "no", the partner axis must
      // never consult it — prove it by forcing false.
      vi.mocked(isDomainVerifiedForOrg).mockResolvedValue(false);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([PARTNER_PROVIDER]))
        .mockReturnValueOnce(sel([]))                              // no (provider, sub) link
        .mockReturnValueOnce(sel([]));                            // partner-axis byEmail (no members subquery) → none

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=invite_required');
      expect(res.headers.get('location') ?? '').not.toContain('sso_email_unverified');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    // 6. Absent claim + already-linked (provider, sub) identity → allowed. The
    //    email-driven gates never run, so enabling enforcement can't lock out an
    //    existing SSO user (even with the domain unverified).
    it('exempts an already-linked identity from the absent-claim gate', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(isDomainVerifiedForOrg).mockResolvedValue(false); // would reject if consulted
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([ORG_PROVIDER]))
        .mockReturnValueOnce(sel([{ userId: USER_UUID }]))        // (provider, sub) link → user resolved
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'test@corp.example', name: 'Linked' }]))
        .mockReturnValueOnce(selJoin([{ orgId: ORG_UUID, roleId: 'role-1', roleName: 'Member', roleScope: 'organization' }]))
        .mockReturnValueOnce(sel([{ id: 'identity-1' }]));

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      expect(res.headers.get('location') ?? '').not.toContain('sso_email_unverified');
      expect(createTokenPair).toHaveBeenCalled();
    });

    // 7. Org clamp on the auto-link email match. A by-email user who is NOT a
    //    member of the provider's org is blocked one gate deeper (no_org_access)
    //    and never mints — the membership subquery is exactly that population.
    it('does not mint when the by-email user is not a member of the provider org', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'test@corp.example', name: 'T' } as any);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([ORG_PROVIDER]))
        .mockReturnValueOnce(sel([]))                              // no (provider, sub) link
        .mockReturnValueOnce(sel([]))                             // org-members subquery → empty (not a member)
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'test@corp.example', name: 'Outsider', passwordHash: null }])) // byEmail
        .mockReturnValueOnce(sel([]))                             // no other-provider link → user = byEmail
        .mockReturnValueOnce(selJoin([]));                        // NO org membership → no_org_access

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=no_org_access');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    // 8. Mapped-email laundering (I3). attributeMapping.email='preferred_username'
    //    names a DIFFERENT address than userinfo.email, which is what
    //    email_verified:true attests — so the claim must NOT count. With no
    //    verified domain, the absent-claim gate rejects.
    it('does not let a true claim launder a mapped address it does not attest', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'real@corp.example', email_verified: true, preferred_username: 'spoof@corp.example', name: 'X' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'spoof@corp.example', name: 'X' } as any);
      vi.mocked(isDomainVerifiedForOrg).mockResolvedValueOnce(false);
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([{ ...ORG_PROVIDER, attributeMapping: { email: 'preferred_username', name: 'name' } }]))
        .mockReturnValueOnce(sel([])); // no link → user null → domain gate

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('error=sso_email_unverified');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    // 8 (mirror). Same setup, but the org HAS the domain verified → the domain
    //    gate carries the legitimate case forward (proving it is the domain
    //    proof, not the laundered claim, that admits it).
    it('admits the mapped-address case when the org has proven the domain', async () => {
      primeSession();
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'real@corp.example', email_verified: true, preferred_username: 'spoof@corp.example', name: 'X' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'spoof@corp.example', name: 'X' } as any);
      // isDomainVerifiedForOrg defaults to true → domain proof carries it.
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([{ ...ORG_PROVIDER, attributeMapping: { email: 'preferred_username', name: 'name' } }]))
        .mockReturnValueOnce(sel([]))                              // no link
        .mockReturnValueOnce(sel([{ userId: USER_UUID }]))        // org-members subquery
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'spoof@corp.example', name: 'SsoOnly', passwordHash: null }])) // byEmail
        .mockReturnValueOnce(sel([]))                             // no other-provider link
        .mockReturnValueOnce(selJoin([{ orgId: ORG_UUID, roleId: 'role-1', roleName: 'Member', roleScope: 'organization' }]))
        .mockReturnValueOnce(sel([]));                            // existingIdentity none

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toMatch(/ssoCode=/);
      expect(createTokenPair).toHaveBeenCalled();
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
    configVersion: 4,
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
        redirectUrl: '/dashboard',
        // SR2-11: the session snapshots the provider's LIVE generation.
        providerVersion: ACTIVE_OIDC_PROVIDER_ROW.configVersion
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
        redirectUrl: '/dashboard',
        // SR2-11: the session snapshots the provider's LIVE generation.
        providerVersion: ACTIVE_OIDC_PROVIDER_ROW.configVersion
      }));
      expect(res.headers.get('set-cookie') ?? '').toContain('breeze_sso_state=');
    });

    // SR2-14: an endpoint that was persisted (or left stale by a PATCH issuer
    // change) pointing at a non-HTTPS/internal host must yield a clean 400, not
    // an unhandled 500 from getOIDCConfig throwing out of the handler.
    it('returns 400 for a provider with an unsafe persisted endpoint (not 500)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        providerSelectChain([
          { ...ACTIVE_OIDC_PROVIDER_ROW, orgId: ORG_UUID, partnerId: null, tokenUrl: 'http://evil.example.com/token' }
        ]) as any
      );

      const res = await app.request(`/sso/login/${ORG_UUID}`);

      expect(res.status).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
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
      status: 'active',
      configVersion: 1,
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
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sso-session-p', providerId: PROVIDER_UUID, state: 'state', nonce: 'nonce', codeVerifier: 'verifier', redirectUrl: '/dashboard', providerVersion: 1 }]) })
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
      id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, status: 'active', configVersion: 1, type: 'oidc',
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

    // SR2-11b: /link/start snapshots {authEpoch, mfaEpoch, sid} at creation
    // (default auth mock: getUserEpochs → {authEpoch:1, mfaEpoch:1}, token.sid
    // → INITIATING_SID) so the callback can re-check them against live state.
    it('POST /sso/link/start/:providerId returns authUrl, sets state cookie, and stamps linkUserId + SR2-11b binding', async () => {
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
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
        linkUserId: USER_UUID,
        providerVersion: ORG_PROVIDER.configVersion,
        initiatingAuthEpoch: 1,
        initiatingMfaEpoch: 1,
        initiatingSessionId: INITIATING_SID,
      }));
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

    it('POST /sso/link/start returns 503 when epochs are unavailable (no session written)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(sel([ORG_PROVIDER]));
      vi.mocked(getUserEpochs).mockResolvedValueOnce(null);

      const res = await app.request(`/sso/link/start/${PROVIDER_UUID}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(503);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('POST /sso/link/start returns 503 when the token has no sid (no session written)', async () => {
      setAuthContext({ token: {} });
      vi.mocked(db.select).mockReturnValueOnce(sel([ORG_PROVIDER]));

      const res = await app.request(`/sso/link/start/${PROVIDER_UUID}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(503);
      expect(db.insert).not.toHaveBeenCalled();
    });

    // ── Callback link-mode branch ──────────────────────────────────────────
    // SR2-11b: validateLinkBinding re-checks the pending link against LIVE
    // state before it can attach an external identity. It issues, in order:
    // a `users` select (the linking user), then — only if status/epochs/family
    // all still check out — ONE axis-membership select (organization_users on
    // the org axis). That membership select lands BEFORE the route's existing
    // (provider, sub) userSsoIdentities select. Every link test funnels
    // through this one helper so that ordering/shift lives in exactly one
    // place instead of being hand-copied into every test.
    const INITIATING_SID = '00000000-0000-4000-8000-0000000000fa';
    const ACTIVE_LINKING_USER = {
      id: USER_UUID, email: 'tech@example.com', name: 'Tech', status: 'active', orgId: null
    };
    const primeLinkCallback = (opts: {
      linkUserId: string;
      provider?: Record<string, unknown>;
      // undefined = default healthy user; null = simulate "user gone" (no row).
      linkingUser?: Record<string, unknown> | null;
      // undefined = default live membership row; [] = membership lost.
      membership?: unknown[];
      sessionOverrides?: Record<string, unknown>;
    }) => {
      const {
        linkUserId,
        provider = ORG_PROVIDER,
        linkingUser = ACTIVE_LINKING_USER,
        membership = [{ userId: linkUserId }],
        sessionOverrides = {},
      } = opts;

      vi.mocked(exchangeCodeForTokens).mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 'h.p.s' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'tech@example.com', name: 'Tech' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'tech@example.com', name: 'Tech' } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'sso-session-link', providerId: PROVIDER_UUID, state: 'state', nonce: 'nonce',
            codeVerifier: 'verifier', redirectUrl: '/settings/profile', linkUserId, providerVersion: 1,
            initiatingAuthEpoch: 1, initiatingMfaEpoch: 1, initiatingSessionId: INITIATING_SID,
            ...sessionOverrides,
          }])
        })
      } as any);

      vi.mocked(db.select)
        .mockReturnValueOnce(sel([provider]))                                // provider by id
        .mockReturnValueOnce(sel(linkingUser ? [linkingUser] : []))          // validateLinkBinding: users
        .mockReturnValueOnce(sel(membership));                               // validateLinkBinding: axis membership
    };
    const doCallback = () => app.request('/sso/callback?code=oidc-code&state=state', { method: 'GET', headers: { cookie: ssoStateCookieHeader('state') } });

    it('callback link mode creates the identity for the SESSION user after verification', async () => {
      primeLinkCallback({ linkUserId: USER_UUID });
      vi.mocked(db.select).mockReturnValueOnce(sel([])); // (provider, sub) not in use
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
      primeLinkCallback({
        linkUserId: USER_UUID,
        linkingUser: { id: USER_UUID, email: 'someone-else@corp.com', name: 'Other', status: 'active', orgId: null },
      });

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('ssoLinkError=email_mismatch');
      expect(db.insert).not.toHaveBeenCalled();
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('callback link mode rejects a (provider, sub) already linked to another user (no insert)', async () => {
      primeLinkCallback({ linkUserId: USER_UUID });
      vi.mocked(db.select).mockReturnValueOnce(sel([{ id: 'identity-x', userId: '00000000-0000-4000-8000-0000000000aa' }]));

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('ssoLinkError=identity_in_use');
      expect(db.insert).not.toHaveBeenCalled();
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    // ── SR2-11b: live re-check of the /link/start binding ──────────────────
    it('callback rejects a revoked initiating refresh family (session_invalid, no insert)', async () => {
      vi.mocked(getRefreshFamily).mockResolvedValueOnce({
        revokedAt: new Date(), absoluteExpiresAt: new Date(Date.now() + 1e9)
      });
      primeLinkCallback({ linkUserId: USER_UUID });

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/profile?ssoLinkError=session_invalid');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('callback rejects an auth-epoch bump since /link/start (session_invalid, no insert)', async () => {
      vi.mocked(getUserEpochs).mockResolvedValueOnce({ authEpoch: 2, mfaEpoch: 1 });
      primeLinkCallback({ linkUserId: USER_UUID });

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/profile?ssoLinkError=session_invalid');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('callback rejects a suspended linking user (session_invalid, no insert)', async () => {
      primeLinkCallback({
        linkUserId: USER_UUID,
        linkingUser: { ...ACTIVE_LINKING_USER, status: 'suspended' },
      });

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/profile?ssoLinkError=session_invalid');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('callback rejects a NULL binding column — pre-deploy row (session_invalid, no insert)', async () => {
      primeLinkCallback({ linkUserId: USER_UUID, sessionOverrides: { initiatingSessionId: null } });

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/profile?ssoLinkError=session_invalid');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('callback rejects lost org-axis membership since /link/start (session_invalid, no insert)', async () => {
      primeLinkCallback({ linkUserId: USER_UUID, membership: [] });

      const res = await doCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/profile?ssoLinkError=session_invalid');
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SR2-11: provider config generation + status/version gate in the callback.
  //
  // The vulnerability: nothing bumped a generation on config/status writes,
  // nothing snapshotted it at session creation, and the callback never
  // re-checked provider.status or any version — so a provider disabled (or
  // reconfigured) during the <=10-minute state TTL still completed a full
  // login or link.
  // ══════════════════════════════════════════════════════════════════════════
  describe('SSO provider generation gate (SR2-11)', () => {
    const sel = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) })
    } as any);
    const doCallback = () => app.request('/sso/callback?code=oidc-code&state=state', { method: 'GET', headers: { cookie: ssoStateCookieHeader('state') } });
    // Minimal org-axis provider shape: enough to pass the org-XOR-partner
    // guard and reach the generation gate, which runs BEFORE anything that
    // would need type/issuer/clientId (getOIDCConfig, default-role lookup).
    const GEN_PROVIDER = { id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, type: 'oidc', defaultRoleId: null };
    const claimSession = (overrides: Record<string, unknown>) => {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'sso-session-gen', providerId: PROVIDER_UUID, state: 'state', nonce: 'nonce',
            codeVerifier: 'verifier', redirectUrl: '/dashboard', linkUserId: null,
            ...overrides
          }])
        })
      } as any);
    };

    it('rejects a provider disabled mid-flow (login mode)', async () => {
      claimSession({ providerVersion: 3 });
      vi.mocked(db.select).mockReturnValueOnce(sel([{ ...GEN_PROVIDER, status: 'inactive', configVersion: 3 }]));

      const res = await doCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=sso_provider_inactive');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a config change mid-flow (login mode)', async () => {
      claimSession({ providerVersion: 3 });
      vi.mocked(db.select).mockReturnValueOnce(sel([{ ...GEN_PROVIDER, status: 'active', configVersion: 4 }]));

      const res = await doCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=sso_config_changed');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a NULL providerVersion (pre-deploy row) — fail closed, never a pass', async () => {
      claimSession({ providerVersion: null });
      vi.mocked(db.select).mockReturnValueOnce(sel([{ ...GEN_PROVIDER, status: 'active', configVersion: 1 }]));

      const res = await doCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=sso_config_changed');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('rejects an inactive provider in LINK mode', async () => {
      claimSession({ providerVersion: 2, linkUserId: USER_UUID });
      vi.mocked(db.select).mockReturnValueOnce(sel([{ ...GEN_PROVIDER, status: 'inactive', configVersion: 2 }]));

      const res = await doCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/profile?ssoLinkError=provider_inactive');
      expect(db.insert).not.toHaveBeenCalled();
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    // Mirrors link-start's OWN gate (status !== 'inactive'): a `testing`
    // provider must still be linkable, or the link round-trip it started
    // itself would be impossible to complete — hardening, not a new bug.
    it('ACCEPTS a testing provider in LINK mode (mirrors link-start’s own gate)', async () => {
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 'h.p.s' } as any);
      vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-user-1', email: 'tech@example.com', name: 'Tech' } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'tech@example.com', name: 'Tech' } as any);
      // SR2-11b: LINK-mode callback now re-checks the /link/start binding
      // (validateLinkBinding), so the claimed session needs a live binding and
      // the select queue gains the axis-membership select it issues.
      claimSession({
        providerVersion: 2, linkUserId: USER_UUID,
        initiatingAuthEpoch: 1, initiatingMfaEpoch: 1,
        initiatingSessionId: '00000000-0000-4000-8000-0000000000fa',
      });
      vi.mocked(db.select)
        .mockReturnValueOnce(sel([{
          ...GEN_PROVIDER, status: 'testing', configVersion: 2,
          issuer: 'https://issuer.example.com', clientId: 'client-id', clientSecret: 'client-secret',
          jwksUrl: 'https://issuer.example.com/jwks'
        }])) // provider by id
        .mockReturnValueOnce(sel([{ id: USER_UUID, email: 'tech@example.com', name: 'Tech', status: 'active', orgId: null }])) // validateLinkBinding: users
        .mockReturnValueOnce(sel([{ userId: USER_UUID }])) // validateLinkBinding: axis membership
        .mockReturnValueOnce(sel([])); // (provider, sub) not in use
      const insertValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
      vi.mocked(db.insert).mockReturnValueOnce({ values: insertValues } as any);

      const res = await doCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/settings/profile?ssoLinked=1');
      expect(insertValues).toHaveBeenCalled();
    });

    it('PATCH /providers/:id bumps config_version in the same UPDATE as the change', async () => {
      vi.mocked(db.select).mockReturnValueOnce(sel([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null }]));
      const setSpy = vi.fn((_values: Record<string, unknown>) => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, name: 'Okta Updated' }])
        })
      }));
      vi.mocked(db.update).mockReturnValueOnce({ set: setSpy } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Okta Updated' })
      });

      expect(res.status).toBe(200);
      expect(setSpy).toHaveBeenCalledTimes(1);
      const setPayload = setSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(Object.keys(setPayload)).toContain('configVersion');
      // A SQL expression object, not a literal number — the bump happens in
      // Postgres against the live value, never a value computed in-process.
      expect(typeof setPayload.configVersion).not.toBe('number');
    });

    it('POST /providers/:id/status bumps config_version on every status transition', async () => {
      vi.mocked(db.select).mockReturnValueOnce(sel([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null }]));
      const setSpy = vi.fn((_values: Record<string, unknown>) => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, name: 'Okta', status: 'inactive' }])
        })
      }));
      vi.mocked(db.update).mockReturnValueOnce({ set: setSpy } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' })
      });

      expect(res.status).toBe(200);
      expect(setSpy).toHaveBeenCalledTimes(1);
      const setPayload = setSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(Object.keys(setPayload)).toContain('configVersion');
      expect(typeof setPayload.configVersion).not.toBe('number');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SR2-10: SSO default-role delegation ceiling
  //
  // The vulnerability: an SSO provider's defaultRoleId was applied to every
  // JIT-provisioned user with NO permission ceiling — nobody checked that the
  // admin who configured it was entitled to grant that role. The org axis (the
  // ONLY axis that JIT-provisions) validated nothing at all.
  //
  // NOTE: services/roleAssignment is deliberately NOT mocked in this suite.
  // The ceiling is the security control under test; stubbing it would make
  // every assertion below vacuous (we would only be testing our own stub). The
  // real validator runs against the db mock, so the queues here include its
  // selects.
  // ══════════════════════════════════════════════════════════════════════════
  describe('SSO default-role delegation ceiling (SR2-10)', () => {
    const ROLE_UUID = '00000000-0000-4000-8000-000000000040';
    const CONFIGURER_UUID = '00000000-0000-4000-8000-000000000050';
    const CREATOR_UUID = '00000000-0000-4000-8000-000000000051';
    const NEW_USER_UUID = '00000000-0000-4000-8000-000000000052';

    // select().from().where().limit()
    const selLimit = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) })
      })
    }) as any;
    // select().from().innerJoin().where()  — getEffectiveRolePermissions (no limit)
    const selJoin = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) })
      })
    }) as any;
    // select().from().innerJoin().where().limit() — org membership resolution
    const selJoinLimit = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) })
        })
      })
    }) as any;

    const ORG_ROLE_ROW = {
      id: ROLE_UUID,
      scope: 'organization',
      name: 'Support',
      description: null,
      isSystem: false,
      parentRoleId: null,
      partnerId: null,
      orgId: ORG_UUID
    };
    const PARTNER_ROLE_ROW = {
      id: ROLE_UUID,
      scope: 'partner',
      name: 'Partner Tech',
      description: null,
      isSystem: false,
      parentRoleId: null,
      partnerId: PARTNER_UUID,
      orgId: null
    };
    // The trap (binding decision A): a SYSTEM role carrying the `*:*` wildcard.
    // A caller-independent structural check would return null (= "assignable")
    // for exactly this row — so a structural fallback would JIT-provision every
    // SSO user at FULL WILDCARD. Only a real permission ceiling against a real
    // principal stops it. (This same row also matches Fix 1's config-time gap:
    // `isSystem: true` with `orgId: null` is exactly what getProviderAxisRole
    // must refuse that the old getScopedRole call would have accepted.)
    const SYSTEM_WILDCARD_ROLE_ROW = {
      id: ROLE_UUID,
      scope: 'organization',
      name: 'Super Admin',
      description: null,
      isSystem: true,
      parentRoleId: null,
      partnerId: null,
      orgId: null
    };

    const createBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
      name: 'Okta',
      type: 'oidc',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      defaultRoleId: ROLE_UUID,
      ...extra
    });

    // ─── Config time ────────────────────────────────────────────────────────

    it('POST /providers (org axis) rejects a defaultRoleId above the caller ceiling', async () => {
      permissionsByUser[USER_UUID] = { permissions: [{ resource: 'devices', action: 'read' }] };
      vi.mocked(db.select)
        .mockReturnValueOnce(selLimit([ORG_ROLE_ROW]))               // getProviderAxisRole
        .mockReturnValueOnce(selLimit([{ parentRoleId: null }]))     // effective perms: role row
        .mockReturnValueOnce(selJoin([{ resource: 'users', action: 'write' }])); // role's perms

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody({ ownerScope: 'organization' })
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error)
        .toBe('Cannot assign a role with permission not held by caller: users:write');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('POST /providers (org axis) rejects an unknown defaultRoleId', async () => {
      permissionsByUser[USER_UUID] = { permissions: [{ resource: '*', action: '*' }] };
      vi.mocked(db.select).mockReturnValueOnce(selLimit([])); // getProviderAxisRole → null

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody({ ownerScope: 'organization' })
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error)
        .toBe('defaultRoleId must be an organization-scoped role belonging to this organization');
      expect(db.insert).not.toHaveBeenCalled();
    });

    // SR2-10 Fix 1: config time must reject a defaultRoleId the JIT resolver
    // could NEVER resolve — a built-in system role, whose org_id/partner_id are
    // always NULL. The caller holds `*:*` (would sail through the ceiling), so
    // this proves the axis check runs BEFORE/INDEPENDENT of the ceiling, not as
    // a side effect of it. Before Fix 1, `getScopedRole`'s isSystem shortcut
    // would have accepted this row and 201'd — the exact drift the reviewer
    // caught: a provider saved with this defaultRoleId would then die at
    // `invalid_provider_configuration` on every future SSO sign-in, because the
    // JIT resolver applies strict axis equality and a system role never matches.
    it('POST /providers (org axis) rejects a SYSTEM role not scoped to this org (config/JIT drift gap)', async () => {
      permissionsByUser[USER_UUID] = { permissions: [{ resource: '*', action: '*' }] };
      vi.mocked(db.select).mockReturnValueOnce(selLimit([SYSTEM_WILDCARD_ROLE_ROW]));

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody({ ownerScope: 'organization' })
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error)
        .toBe('defaultRoleId must be an organization-scoped role belonging to this organization');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('POST /providers (org axis) accepts an in-ceiling defaultRoleId and stamps defaultRoleConfiguredBy', async () => {
      permissionsByUser[USER_UUID] = { permissions: [{ resource: 'users', action: 'write' }] };
      vi.mocked(db.select)
        .mockReturnValueOnce(selLimit([ORG_ROLE_ROW]))
        .mockReturnValueOnce(selLimit([{ parentRoleId: null }]))
        .mockReturnValueOnce(selJoin([{ resource: 'users', action: 'write' }]));

      const insertValues = vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, name: 'Okta', type: 'oidc', status: 'inactive' }])
      }));
      vi.mocked(db.insert).mockReturnValueOnce({ values: insertValues } as any);

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody({ ownerScope: 'organization' })
      });

      expect(res.status).toBe(201);
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
        defaultRoleId: ROLE_UUID,
        defaultRoleConfiguredBy: USER_UUID
      }));
    });

    it('POST /providers does NOT stamp defaultRoleConfiguredBy when no role is delegated', async () => {
      const insertValues = vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, name: 'Okta', type: 'oidc', status: 'inactive' }])
      }));
      vi.mocked(db.insert).mockReturnValueOnce({ values: insertValues } as any);

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Okta', type: 'oidc', ownerScope: 'organization' })
      });

      expect(res.status).toBe(201);
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ defaultRoleConfiguredBy: null }));
    });

    it('POST /providers (PARTNER axis) rejects a defaultRoleId above the partner admin ceiling', async () => {
      setAuthContext({
        scope: 'partner', orgId: null, partnerId: PARTNER_UUID,
        accessibleOrgIds: [], partnerOrgAccess: 'all'
      });
      // Partner admin holds devices:read only — they may not delegate users:write.
      permissionsByUser[USER_UUID] = { permissions: [{ resource: 'devices', action: 'read' }] };
      vi.mocked(db.select)
        .mockReturnValueOnce(selLimit([PARTNER_ROLE_ROW]))
        .mockReturnValueOnce(selLimit([{ parentRoleId: null }]))
        .mockReturnValueOnce(selJoin([{ resource: 'users', action: 'write' }]));

      const res = await app.request('/sso/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody({ ownerScope: 'partner' })
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error)
        .toBe('Cannot assign a role with permission not held by caller: users:write');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('PATCH /providers/:id rejects an out-of-ceiling defaultRoleId (no update)', async () => {
      permissionsByUser[USER_UUID] = { permissions: [{ resource: 'devices', action: 'read' }] };
      vi.mocked(db.select)
        .mockReturnValueOnce(selLimit([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null }])) // existing
        .mockReturnValueOnce(selLimit([ORG_ROLE_ROW]))
        .mockReturnValueOnce(selLimit([{ parentRoleId: null }]))
        .mockReturnValueOnce(selJoin([{ resource: 'users', action: 'write' }]));

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultRoleId: ROLE_UUID })
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error)
        .toBe('Cannot assign a role with permission not held by caller: users:write');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('PATCH /providers/:id re-stamps defaultRoleConfiguredBy when the default role is set', async () => {
      permissionsByUser[USER_UUID] = { permissions: [{ resource: 'users', action: 'write' }] };
      vi.mocked(db.select)
        .mockReturnValueOnce(selLimit([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null }]))
        .mockReturnValueOnce(selLimit([ORG_ROLE_ROW]))
        .mockReturnValueOnce(selLimit([{ parentRoleId: null }]))
        .mockReturnValueOnce(selJoin([{ resource: 'users', action: 'write' }]));

      const updateSet = vi.fn(() => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, name: 'Okta' }])
        })
      }));
      vi.mocked(db.update).mockReturnValueOnce({ set: updateSet } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultRoleId: ROLE_UUID })
      });

      expect(res.status).toBe(200);
      expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ defaultRoleConfiguredBy: USER_UUID }));
    });

    it('PATCH /providers/:id without defaultRoleId does NOT touch defaultRoleConfiguredBy', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selLimit([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null }]));

      const updateSet = vi.fn((_values: Record<string, unknown>) => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: PROVIDER_UUID, orgId: ORG_UUID, partnerId: null, name: 'Renamed' }])
        })
      }));
      vi.mocked(db.update).mockReturnValueOnce({ set: updateSet } as any);

      const res = await app.request(`/sso/providers/${PROVIDER_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' })
      });

      expect(res.status).toBe(200);
      expect(updateSet).toHaveBeenCalledTimes(1);
      expect(Object.keys(updateSet.mock.calls[0]![0])).not.toContain('defaultRoleConfiguredBy');
    });

    // ─── JIT time ───────────────────────────────────────────────────────────

    const jitProvider = (overrides: Record<string, unknown> = {}) => ({
      id: PROVIDER_UUID,
      orgId: ORG_UUID,
      partnerId: null,
      name: 'Okta',
      type: 'oidc',
      status: 'active',
      configVersion: 1,
      issuer: 'https://issuer.example.com',
      authorizationUrl: 'https://issuer.example.com/auth',
      tokenUrl: 'https://issuer.example.com/token',
      userInfoUrl: 'https://issuer.example.com/userinfo',
      jwksUrl: 'https://issuer.example.com/jwks',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: 'openid profile email',
      attributeMapping: { email: 'email', name: 'name' },
      autoProvision: true,
      allowedDomains: null,
      trustsIdpMfa: false,
      defaultRoleId: ROLE_UUID,
      defaultRoleConfiguredBy: CONFIGURER_UUID,
      createdBy: CREATOR_UUID,
      ...overrides
    });

    // Primes the IdP round-trip + the callback's pre-JIT selects for a BRAND NEW
    // (unlinked, unknown-email) org-axis user. Leaves the db.select queue
    // positioned at the SR2-10 re-validation selects.
    const primeJitCallback = (provider: Record<string, unknown>, ...tail: any[]) => {
      // vi.clearAllMocks() clears CALLS but not implementations, and an earlier
      // suite pins this to `true` — pin it back or every JIT test dies at the
      // domain gate before reaching the ceiling under test.
      vi.mocked(isSsoProvisioningBlocked).mockResolvedValue(false);
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({
        access_token: 'idp-access-token', refresh_token: 'idp-refresh-token',
        expires_in: 3600, id_token: 'header.payload.sig'
      } as any);
      vi.mocked(getUserInfo).mockResolvedValue({
        sub: 'external-user-1', email: 'new@example.com', name: 'New User'
      } as any);
      vi.mocked(mapUserAttributes).mockReturnValue({ email: 'new@example.com', name: 'New User' } as any);
      vi.mocked(verifyIdTokenSignature).mockResolvedValue({ sub: 'external-user-1', nonce: 'nonce' } as any);

      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'sso-session-jit', providerId: PROVIDER_UUID, state: 'state',
            nonce: 'nonce', codeVerifier: 'verifier', redirectUrl: '/', providerVersion: 1
          }])
        })
      } as any);

      vi.mocked(db.select)
        .mockReturnValueOnce(selLimit([provider]))              // 1. provider
        .mockReturnValueOnce(selLimit([ORG_ROLE_ROW]))          // 2. pre-JIT axis check (getProviderAxisRole)
        .mockReturnValueOnce(selLimit([]))                      // 3. (provider, sub) → unlinked
        .mockReturnValueOnce(selLimit([]))                      // 3b. SR2-12: org-members subquery for the emailCondition clamp (constructed just before the by-email select)
        .mockReturnValueOnce(selLimit([]));                     // 4. users by email → none
      for (const t of tail) vi.mocked(db.select).mockReturnValueOnce(t);
    };

    const doJitCallback = () => app.request('/sso/callback?code=oidc-code&state=state', {
      headers: { cookie: ssoStateCookieHeader('state') }
    });

    it('refuses JIT when the configurer has since been stripped of the delegated permission', async () => {
      // Legal at config time; the configurer has since been demoted to devices:read.
      permissionsByUser[CONFIGURER_UUID] = { permissions: [{ resource: 'devices', action: 'read' }] };
      primeJitCallback(
        jitProvider(),
        selLimit([ORG_ROLE_ROW]),                                  // 5. getProviderAxisRole (live)
        selLimit([{ id: CONFIGURER_UUID, status: 'active' }]),     // 6. configurer live status
        selLimit([{ partnerId: PARTNER_UUID }]),                   // 7. org's owning partner
        selLimit([{ parentRoleId: null }]),                        // 8. role's effective perms
        selJoin([{ resource: 'users', action: 'write' }])          // 9. → users:write
      );

      const res = await doJitCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=invalid_provider_configuration');
      expect(db.insert).not.toHaveBeenCalled(); // no users row, no organization_users row
      expect(createTokenPair).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'sso.callback.rejected',
        result: 'denied',
        details: expect.objectContaining({ reason: 'default_role_exceeds_configurer_permissions' })
      }));
    });

    it('refuses JIT when the configurer account has been deactivated', async () => {
      permissionsByUser[CONFIGURER_UUID] = { permissions: [{ resource: '*', action: '*' }] };
      primeJitCallback(
        jitProvider(),
        selLimit([ORG_ROLE_ROW]),
        selLimit([{ id: CONFIGURER_UUID, status: 'disabled' }]) // offboarded
      );

      const res = await doJitCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=invalid_provider_configuration');
      expect(db.insert).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        result: 'denied',
        details: expect.objectContaining({ reason: 'default_role_configurer_inactive' })
      }));
    });

    // Binding decision (A): the unknowable-configurer fallback FAILS CLOSED.
    // A caller-independent structural check would return null (= assignable)
    // for a SYSTEM wildcard role — using it here would JIT every user at full
    // wildcard.
    it('refuses JIT when NO configurer can be resolved (fails closed, never structural)', async () => {
      primeJitCallback(
        jitProvider({ defaultRoleConfiguredBy: null, createdBy: null }),
        selLimit([ORG_ROLE_ROW])
      );

      const res = await doJitCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=invalid_provider_configuration');
      expect(db.insert).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        result: 'denied',
        details: expect.objectContaining({ reason: 'default_role_configurer_unknown' })
      }));
    });

    // THE WILDCARD TRAP (binding decision A), SR2-10 Fix 1 revision. The
    // provider's default role is the built-in SYSTEM super-admin role (`*:*`).
    // A caller-independent structural check would say "assignable" — the real
    // defense is that `getProviderAxisRole` (used here too, not just at config
    // time) has no `isSystem` escape hatch at all, so a role whose `orgId` is
    // NULL (every seeded system role) can never resolve on the provider's org
    // axis. Before Fix 1 this was refused one step later, by the permission
    // ceiling specifically because the configurer didn't hold `*:*` — which
    // meant a configurer who DID hold `*:*` (a genuine platform super-admin)
    // could have slipped a system role through. The axis check now refuses it
    // unconditionally, regardless of the configurer's own permissions.
    it('refuses to JIT-provision at the SYSTEM WILDCARD role — it can never resolve on the provider axis', async () => {
      permissionsByUser[CONFIGURER_UUID] = {
        permissions: [{ resource: '*', action: '*' }] // even a configurer WITH the wildcard is refused
      };
      primeJitCallback(
        jitProvider(),
        selLimit([SYSTEM_WILDCARD_ROLE_ROW])
      );

      const res = await doJitCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=invalid_provider_configuration');
      expect(db.insert).not.toHaveBeenCalled();
      expect(createTokenPair).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        result: 'denied',
        details: expect.objectContaining({ reason: 'default_role_not_on_provider_axis' })
      }));
    });

    // Binding decision (B): an MSP partner admin has NO organization_users row in
    // the customer org. Resolving the configurer on the org axis ALONE would
    // return null permissions → every JIT sign-in on their provider would fail
    // forever. Both axes must be supplied.
    it('JIT-provisions successfully when the configurer is a PARTNER admin with no organization_users row', async () => {
      // Keyed by (userId) in the mock; the route must pass BOTH orgId and the
      // org owning partnerId, or getUserPermissions could never resolve them.
      permissionsByUser[CONFIGURER_UUID] = { permissions: [{ resource: 'users', action: 'write' }] };

      primeJitCallback(
        jitProvider(),
        selLimit([ORG_ROLE_ROW]),                              // 5. getProviderAxisRole
        selLimit([{ id: CONFIGURER_UUID, status: 'active' }]), // 6. configurer status
        selLimit([{ partnerId: PARTNER_UUID }]),               // 7. org's owning partner (partner axis!)
        selLimit([{ parentRoleId: null }]),                    // 8. effective perms: role row
        selJoin([{ resource: 'users', action: 'write' }]),     // 9. in-ceiling
        // SR2-10 Fix 4: no separate "provisioning: org partner" select here —
        // the provisioning block now reuses the org's partnerId that #7 (the
        // ceiling's own resolution above) already fetched, instead of
        // re-querying `organizations` for the identical row.
        selJoinLimit([{ orgId: ORG_UUID, roleId: ROLE_UUID, roleName: 'Support', roleScope: 'organization' }]), // membership
        selLimit([])                                           // existing identity → none
      );

      const usersInsertValues = vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{
          id: NEW_USER_UUID, email: 'new@example.com', name: 'New User', orgId: ORG_UUID, partnerId: PARTNER_UUID
        }])
      }));
      const orgUsersInsertValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
      vi.mocked(db.insert)
        .mockReturnValueOnce({ values: usersInsertValues } as any)
        .mockReturnValueOnce({ values: orgUsersInsertValues } as any);

      const res = await doJitCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('ssoCode=');
      expect(usersInsertValues).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com' }));
      expect(orgUsersInsertValues).toHaveBeenCalledWith(expect.objectContaining({
        orgId: ORG_UUID, userId: NEW_USER_UUID, roleId: ROLE_UUID
      }));
      // The configurer's permissions were resolved on BOTH axes.
      expect(getUserPermissions).toHaveBeenCalledWith(CONFIGURER_UUID, {
        orgId: ORG_UUID, partnerId: PARTNER_UUID
      });
    });

    it('falls back to created_by when default_role_configured_by is NULL (legacy rows)', async () => {
      permissionsByUser[CREATOR_UUID] = { permissions: [{ resource: 'devices', action: 'read' }] };
      primeJitCallback(
        jitProvider({ defaultRoleConfiguredBy: null }),         // createdBy: CREATOR_UUID
        selLimit([ORG_ROLE_ROW]),
        selLimit([{ id: CREATOR_UUID, status: 'active' }]),
        selLimit([{ partnerId: PARTNER_UUID }]),
        selLimit([{ parentRoleId: null }]),
        selJoin([{ resource: 'users', action: 'write' }])       // above the creator's ceiling
      );

      const res = await doJitCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=invalid_provider_configuration');
      expect(getUserPermissions).toHaveBeenCalledWith(CREATOR_UUID, { orgId: ORG_UUID, partnerId: PARTNER_UUID });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('refuses JIT when the delegated role no longer exists on the provider axis', async () => {
      permissionsByUser[CONFIGURER_UUID] = { permissions: [{ resource: '*', action: '*' }] };
      primeJitCallback(
        jitProvider(),
        selLimit([])   // getProviderAxisRole → role deleted / re-scoped
      );

      const res = await doJitCallback();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=invalid_provider_configuration');
      expect(db.insert).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        result: 'denied',
        details: expect.objectContaining({ reason: 'default_role_not_on_provider_axis' })
      }));
    });

    // SR2-10 Fix 2. `revalidateSsoDefaultRole` MUST run inside
    // withSystemDbAccessContext — outside it, `role_permissions` (FORCE RLS)
    // 0-rows and `applyCeiling` treats "no permissions" as "assignable",
    // fail-OPEN for ANY role (not just a system one — `getProviderAxisRole`'s
    // own axis check independently blocks system roles regardless of DB
    // context, so this scenario is built around an ORDINARY org-scoped custom
    // role to isolate the ceiling's own fail-open mode specifically). The mock
    // queues a role that DOES resolve (ORG_ROLE_ROW) but an EMPTY
    // role_permissions join (position 9) — exactly what force-RLS returns with
    // no context — and a configurer who holds none of the role's (real, but
    // invisible-to-this-read) permissions, plus full provisioning mocks. If the
    // invariant is missing, this data is shaped to let JIT actually provision
    // the user (proving fail-open, not just "some other reason it fails
    // closed"); manually inverting the guard and re-running this test (see the
    // fix report) showed exactly that — `db.insert` WAS called.
    //
    // `getCurrentDbAccessContext` stands in for "did withSystemDbAccessContext
    // actually take effect" (the db mock makes the real wrap a pass-through,
    // so it can't detect a dropped wrap itself). Every other test in this file
    // defaults it to 'system'; this test alone overrides it to prove the throw
    // fires before any of the fail-open-shaped data below is ever touched.
    it('throws (fails closed) if revalidateSsoDefaultRole ever runs outside a system DB context', async () => {
      permissionsByUser[CONFIGURER_UUID] = { permissions: [{ resource: 'devices', action: 'read' }] };
      vi.mocked(getCurrentDbAccessContext).mockReturnValueOnce({ scope: 'organization' } as any);
      primeJitCallback(
        jitProvider(),
        selLimit([ORG_ROLE_ROW]),                              // 5. getProviderAxisRole
        selLimit([{ id: CONFIGURER_UUID, status: 'active' }]), // 6. configurer status
        selLimit([{ partnerId: PARTNER_UUID }]),                // 7. org's owning partner
        selLimit([{ parentRoleId: null }]),                     // 8. effective perms: role row
        selJoin([]),                                            // 9. role_permissions — 0-rows w/o system ctx
        selJoinLimit([{ orgId: ORG_UUID, roleId: ROLE_UUID, roleName: 'Support', roleScope: 'organization' }]), // membership
        selLimit([])                                            // existing identity → none
      );
      const usersInsertValues = vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{
          id: NEW_USER_UUID, email: 'new@example.com', name: 'New User', orgId: ORG_UUID, partnerId: PARTNER_UUID
        }])
      }));
      const orgUsersInsertValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
      vi.mocked(db.insert)
        .mockReturnValueOnce({ values: usersInsertValues } as any)
        .mockReturnValueOnce({ values: orgUsersInsertValues } as any);

      const res = await doJitCallback();

      // Caught by the callback's top-level catch (same as any other
      // unexpected error) and redirected — NOT silently provisioned, even
      // though every downstream mock was primed to let provisioning succeed.
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/login?error=sso_error');
      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});
