/**
 * Real-DB coverage for the PR 3 SSO hardening layers (SR2-10 … SR2-12), driven
 * through the REAL ssoRoutes against the genuine breeze_app RLS-enforced pool.
 * Only the IdP network calls are stubbed (exchangeCodeForTokens / getUserInfo /
 * verifyIdTokenSignature); every gate (provider-generation, link-binding, the
 * domain-ownership gate, and the JIT default-role permission ceiling) runs
 * against real rows. These prove properties the wholesale-mocked unit suites
 * structurally cannot: the JIT ceiling reads real role_permissions under RLS,
 * and the MSP-topology partner-admin configurer (no organization_users row) is
 * resolved on BOTH axes.
 *
 * Mock shape (mandatory): spread importOriginal so readEmailVerifiedClaim /
 * assertSafeOidcEndpoint / generateState survive — a full factory would strip
 * them and break the runtime gates.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac, randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import {
  ssoProviders,
  ssoSessions,
  ssoVerifiedDomains,
  userSsoIdentities,
  users,
  refreshTokenFamilies,
} from '../../db/schema';
import {
  createPartner,
  createOrganization,
  createRole,
  assignUserToOrganization,
  assignUserToPartner,
  grantRolePermissions,
} from './db-utils';
import { encryptSecret } from '../../services/secretCrypto';
import { createAccessToken } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';

process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY || 'integration-test-app-encryption-key-32-bytes!';

vi.mock('../../services/sso', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sso')>();
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn(),
    getUserInfo: vi.fn(),
    verifyIdTokenSignature: vi.fn(),
  };
});

import { exchangeCodeForTokens, getUserInfo, verifyIdTokenSignature } from '../../services/sso';
import { ssoRoutes } from '../../routes/sso';

const ISSUER = 'https://idp.example.test';
const EMAIL_DOMAIN = 'corp.example';

// ── seed helpers ─────────────────────────────────────────────────────────────

async function seedOrgProvider(
  orgId: string,
  opts: {
    status?: 'active' | 'inactive' | 'testing';
    autoProvision?: boolean;
    defaultRoleId?: string | null;
    defaultRoleConfiguredBy?: string | null;
    createdBy?: string | null;
  } = {},
) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoProviders)
    .values({
      orgId,
      partnerId: null,
      name: `Org IdP ${randomUUID()}`,
      type: 'oidc',
      status: opts.status ?? 'active',
      issuer: ISSUER,
      clientId: 'test-client-id',
      clientSecret: encryptSecret('test-client-secret'),
      authorizationUrl: `${ISSUER}/authorize`,
      tokenUrl: `${ISSUER}/token`,
      userInfoUrl: `${ISSUER}/userinfo`,
      jwksUrl: `${ISSUER}/jwks`,
      autoProvision: opts.autoProvision ?? false,
      defaultRoleId: opts.defaultRoleId ?? null,
      defaultRoleConfiguredBy: opts.defaultRoleConfiguredBy ?? null,
      createdBy: opts.createdBy ?? null,
    })
    .returning();
  if (!row) throw new Error('failed to seed org provider');
  return row;
}

async function seedPartnerProvider(partnerId: string) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoProviders)
    .values({
      orgId: null,
      partnerId,
      name: `Partner IdP ${randomUUID()}`,
      type: 'oidc',
      status: 'active',
      issuer: ISSUER,
      clientId: 'test-client-id',
      clientSecret: encryptSecret('test-client-secret'),
      authorizationUrl: `${ISSUER}/authorize`,
      tokenUrl: `${ISSUER}/token`,
      userInfoUrl: `${ISSUER}/userinfo`,
      jwksUrl: `${ISSUER}/jwks`,
      autoProvision: false,
    })
    .returning();
  if (!row) throw new Error('failed to seed partner provider');
  return row;
}

async function seedPasswordlessUser(opts: { partnerId: string; orgId?: string | null; email: string; status?: 'active' | 'disabled' }) {
  const db = getTestDb();
  const [row] = await db
    .insert(users)
    .values({
      partnerId: opts.partnerId,
      orgId: opts.orgId ?? null,
      email: opts.email.toLowerCase(),
      name: 'Test User',
      passwordHash: null,
      status: opts.status ?? 'active',
    })
    .returning();
  if (!row) throw new Error('failed to seed user');
  return row;
}

async function seedVerifiedDomain(orgId: string, domain: string) {
  const db = getTestDb();
  await db.insert(ssoVerifiedDomains).values({
    orgId,
    domain: domain.toLowerCase(),
    verificationToken: `tok-${randomUUID()}`,
    verifiedAt: new Date(),
  });
}

function buildTestSsoStateCookie(state: string): string {
  const secret = process.env.APP_ENCRYPTION_KEY!;
  const value = createHmac('sha256', secret).update(`sso-login-state:${state}`).digest('hex');
  return `breeze_sso_state=${encodeURIComponent(value)}`;
}

/** Seed a login-mode session directly and return its state + matching cookie. */
async function seedLoginSession(providerId: string, providerVersion: number) {
  const db = getTestDb();
  const state = `login-${randomUUID()}`;
  const nonce = `nonce-${randomUUID()}`;
  await db.insert(ssoSessions).values({
    providerId,
    state,
    nonce,
    providerVersion,
    redirectUrl: '/',
    linkUserId: null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return { state, nonce, cookie: buildTestSsoStateCookie(state) };
}

async function seedLinkSession(
  providerId: string,
  providerVersion: number,
  binding: { linkUserId: string; authEpoch: number; mfaEpoch: number; sessionId: string },
) {
  const db = getTestDb();
  const state = `link-${randomUUID()}`;
  const nonce = `nonce-${randomUUID()}`;
  await db.insert(ssoSessions).values({
    providerId,
    state,
    nonce,
    providerVersion,
    redirectUrl: '/settings/profile',
    linkUserId: binding.linkUserId,
    initiatingAuthEpoch: binding.authEpoch,
    initiatingMfaEpoch: binding.mfaEpoch,
    initiatingSessionId: binding.sessionId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return { state, nonce, cookie: buildTestSsoStateCookie(state) };
}

function idClaims(sub: string, email: string, nonce: string, emailVerified?: boolean) {
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    sub,
    aud: 'test-client-id',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    email,
  };
  if (emailVerified !== undefined) claims.email_verified = emailVerified;
  return claims as any;
}

function setCallbackMocks(sub: string, email: string, nonce: string, emailVerified?: boolean) {
  vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaims(sub, email, nonce, emailVerified));
  vi.mocked(getUserInfo).mockResolvedValue({ sub, email, name: 'Test User' } as any);
}

async function callback(app: Hono, state: string, cookie: string) {
  return app.request(`/sso/callback?code=idp-auth-code&state=${state}`, { headers: { cookie } });
}

async function familyCountFor(userId: string): Promise<number> {
  const rows = await getTestDb().select({ id: refreshTokenFamilies.familyId }).from(refreshTokenFamilies).where(eq(refreshTokenFamilies.userId, userId));
  return rows.length;
}

async function identityCountFor(providerId: string): Promise<number> {
  const rows = await getTestDb().select({ id: userSsoIdentities.id }).from(userSsoIdentities).where(eq(userSsoIdentities.providerId, providerId));
  return rows.length;
}

async function userExistsByEmail(email: string): Promise<boolean> {
  const rows = await getTestDb().select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return rows.length > 0;
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('SSO hardening — real-DB (SR2-10 … SR2-12)', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/sso', ssoRoutes);
    vi.mocked(exchangeCodeForTokens).mockReset().mockResolvedValue({
      access_token: 'idp-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'idp-refresh-token',
      id_token: 'header.payload.signature',
    } as any);
    clearPermissionCache();
  });

  afterEach(() => {
    vi.mocked(getUserInfo).mockReset();
    vi.mocked(verifyIdTokenSignature).mockReset();
  });

  it('#1 provider disabled mid-flow → callback rejects (sso_provider_inactive), no refresh family minted', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', orgId: org.id });
    const user = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `u1-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToOrganization(user.id, org.id, role.id);
    const provider = await seedOrgProvider(org.id, { status: 'active' });
    // Link the user by (provider, sub) so a proceeding callback WOULD mint.
    const sub = `sub-${randomUUID()}`;
    await getTestDb().insert(userSsoIdentities).values({ userId: user.id, providerId: provider.id, externalId: sub, email: user.email });

    const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);

    // Disable + bump generation.
    await getTestDb().update(ssoProviders).set({ status: 'inactive', configVersion: provider.configVersion + 1 }).where(eq(ssoProviders.id, provider.id));

    setCallbackMocks(sub, user.email, nonce, true);
    const res = await callback(app, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?error=sso_provider_inactive');
    expect(await familyCountFor(user.id)).toBe(0);
  });

  it('#2 config change → version bump rejects the pending session (sso_config_changed) and burns it', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', orgId: org.id });
    const user = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `u2-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToOrganization(user.id, org.id, role.id);
    const provider = await seedOrgProvider(org.id, { status: 'active' });
    const sub = `sub-${randomUUID()}`;
    await getTestDb().insert(userSsoIdentities).values({ userId: user.id, providerId: provider.id, externalId: sub, email: user.email });

    const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);

    // Config change, still active: version drifts.
    await getTestDb().update(ssoProviders).set({ configVersion: provider.configVersion + 1 }).where(eq(ssoProviders.id, provider.id));

    setCallbackMocks(sub, user.email, nonce, true);
    const res = await callback(app, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?error=sso_config_changed');

    // The session was atomically claimed (deleted) up-front — not retryable.
    const rows = await getTestDb().select({ id: ssoSessions.id }).from(ssoSessions).where(eq(ssoSessions.state, state));
    expect(rows).toEqual([]);
  });

  it('#3 logout (revoked initiating family) invalidates a pending link → session_invalid, no identity', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', orgId: org.id });
    const user = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `u3-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToOrganization(user.id, org.id, role.id);
    const provider = await seedOrgProvider(org.id, { status: 'active' });

    const familyId = randomUUID();
    await getTestDb().insert(refreshTokenFamilies).values({
      familyId,
      userId: user.id,
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const { state, nonce, cookie } = await seedLinkSession(provider.id, provider.configVersion, {
      linkUserId: user.id,
      authEpoch: 1,
      mfaEpoch: 1,
      sessionId: familyId,
    });

    // Logout revokes the initiating family durably.
    await getTestDb().update(refreshTokenFamilies).set({ revokedAt: new Date() }).where(eq(refreshTokenFamilies.familyId, familyId));

    setCallbackMocks(`sub-${randomUUID()}`, user.email, nonce, true);
    const res = await callback(app, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/settings/profile?ssoLinkError=session_invalid');
    expect(await identityCountFor(provider.id)).toBe(0);
  });

  it('#3b auth_epoch bump (password reset / suspension / global revocation) invalidates a pending link', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', orgId: org.id });
    const user = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `u3b-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToOrganization(user.id, org.id, role.id);
    const provider = await seedOrgProvider(org.id, { status: 'active' });

    const familyId = randomUUID();
    await getTestDb().insert(refreshTokenFamilies).values({
      familyId,
      userId: user.id,
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const { state, nonce, cookie } = await seedLinkSession(provider.id, provider.configVersion, {
      linkUserId: user.id,
      authEpoch: 1,
      mfaEpoch: 1,
      sessionId: familyId,
    });

    // Any auth_epoch bump strands the snapshotted epoch.
    await getTestDb().update(users).set({ authEpoch: 2 }).where(eq(users.id, user.id));

    setCallbackMocks(`sub-${randomUUID()}`, user.email, nonce, true);
    const res = await callback(app, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/settings/profile?ssoLinkError=session_invalid');
    expect(await identityCountFor(provider.id)).toBe(0);
  });

  it('#4 domain-ownership gate on auto-link: absent email_verified rejects until the org proves the domain', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', orgId: org.id });
    const alice = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `alice-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToOrganization(alice.id, org.id, role.id);
    const provider = await seedOrgProvider(org.id, { status: 'active' });
    const sub = `sub-${randomUUID()}`;

    // Phase 1: no verified domain, id_token OMITS email_verified → absent → reject.
    {
      const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);
      setCallbackMocks(sub, alice.email, nonce, undefined);
      const res = await callback(app, state, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/login?error=sso_email_unverified');
      expect(await identityCountFor(provider.id)).toBe(0);
    }

    // Phase 2: prove the domain → the same absent-claim auto-link now succeeds.
    await seedVerifiedDomain(org.id, EMAIL_DOMAIN);
    {
      const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);
      setCallbackMocks(sub, alice.email, nonce, undefined);
      const res = await callback(app, state, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('#ssoCode=');
      expect(await identityCountFor(provider.id)).toBe(1);
    }
  });

  it('#5 JIT default-role ceiling fires against real role_permissions and clears once the configurer is granted the permission', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // Configurer admin: holds devices:read, LACKS devices:write.
    const adminRole = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(adminRole.id, [{ resource: 'devices', action: 'read' }]);
    const admin = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `admin5-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToOrganization(admin.id, org.id, adminRole.id);

    // Delegated default role holds devices:write (a real assignable permission
    // the configurer does NOT hold).
    const elevatedRole = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(elevatedRole.id, [{ resource: 'devices', action: 'write' }]);

    await seedVerifiedDomain(org.id, EMAIL_DOMAIN);
    const provider = await seedOrgProvider(org.id, {
      status: 'active',
      autoProvision: true,
      defaultRoleId: elevatedRole.id,
      defaultRoleConfiguredBy: admin.id,
    });

    const newEmail = `newhire5-${randomUUID()}@${EMAIL_DOMAIN}`;

    // Phase 1: ceiling exceeded → refuse, no user minted.
    {
      const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);
      setCallbackMocks(`sub-${randomUUID()}`, newEmail, nonce, true);
      const res = await callback(app, state, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/login?error=invalid_provider_configuration');
      expect(await userExistsByEmail(newEmail)).toBe(false);
    }

    // Phase 2: grant the configurer the permission → now within ceiling.
    await grantRolePermissions(adminRole.id, [{ resource: 'devices', action: 'write' }]);
    clearPermissionCache();
    {
      const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);
      setCallbackMocks(`sub-${randomUUID()}`, newEmail, nonce, true);
      const res = await callback(app, state, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('#ssoCode=');
      expect(await userExistsByEmail(newEmail)).toBe(true);
    }
  });

  it('#6 (C2) a PARTNER ADMIN with NO org membership can configure a working org-axis JIT provider (both-axis resolution)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // Partner admin: partner_users row + orgAccess=all, NO organization_users row.
    const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(partnerRole.id, [{ resource: 'devices', action: 'write' }]);
    const partnerAdmin = await seedPasswordlessUser({ partnerId: partner.id, orgId: null, email: `padmin6-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToPartner(partnerAdmin.id, partner.id, partnerRole.id, 'all');

    // Org default role holds a permission WITHIN the partner admin's ceiling.
    const orgDefaultRole = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(orgDefaultRole.id, [{ resource: 'devices', action: 'write' }]);

    await seedVerifiedDomain(org.id, EMAIL_DOMAIN);
    const provider = await seedOrgProvider(org.id, {
      status: 'active',
      autoProvision: true,
      defaultRoleId: orgDefaultRole.id,
      defaultRoleConfiguredBy: partnerAdmin.id,
    });

    const newEmail = `newhire6-${randomUUID()}@${EMAIL_DOMAIN}`;
    const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);
    setCallbackMocks(`sub-${randomUUID()}`, newEmail, nonce, true);
    const res = await callback(app, state, cookie);
    expect(res.status).toBe(302);
    // If getUserPermissions had been called with only { orgId }, the partner
    // admin would resolve to null and this would be invalid_provider_configuration.
    expect(res.headers.get('location')).toContain('#ssoCode=');
    expect(await userExistsByEmail(newEmail)).toBe(true);
  });

  it('#7 repair path: an offboarded configurer bricks JIT; re-saving the default role as a current admin restores it', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const orgDefaultRole = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(orgDefaultRole.id, [{ resource: 'devices', action: 'write' }]);

    // Configurer since suspended (status='disabled').
    const suspendedRole = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(suspendedRole.id, [{ resource: 'devices', action: 'write' }]);
    const suspended = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `susp7-${randomUUID()}@${EMAIL_DOMAIN}`, status: 'disabled' });
    await assignUserToOrganization(suspended.id, org.id, suspendedRole.id);

    await seedVerifiedDomain(org.id, EMAIL_DOMAIN);
    const provider = await seedOrgProvider(org.id, {
      status: 'active',
      autoProvision: true,
      defaultRoleId: orgDefaultRole.id,
      defaultRoleConfiguredBy: suspended.id,
    });

    const newEmail = `newhire7-${randomUUID()}@${EMAIL_DOMAIN}`;

    // Phase 1: suspended configurer → refuse.
    {
      const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);
      setCallbackMocks(`sub-${randomUUID()}`, newEmail, nonce, true);
      const res = await callback(app, state, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/login?error=invalid_provider_configuration');
      expect(await userExistsByEmail(newEmail)).toBe(false);
    }

    // Phase 2: a current, adequately-permissioned admin re-saves the default role
    // through the real PATCH route → re-stamps default_role_configured_by.
    const freshRole = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(freshRole.id, [
      { resource: 'devices', action: 'write' },
      { resource: 'sso', action: 'admin' },
    ]);
    const freshAdmin = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `fresh7-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToOrganization(freshAdmin.id, org.id, freshRole.id);
    const freshToken = await createAccessToken({
      sub: freshAdmin.id,
      email: freshAdmin.email,
      roleId: freshRole.id,
      orgId: org.id,
      partnerId: null,
      scope: 'organization',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });
    clearPermissionCache();

    const patchRes = await app.request(`/sso/providers/${provider.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRoleId: orgDefaultRole.id }),
    });
    expect(patchRes.status).toBe(200);

    const [restamped] = await getTestDb().select({ configuredBy: ssoProviders.defaultRoleConfiguredBy, v: ssoProviders.configVersion }).from(ssoProviders).where(eq(ssoProviders.id, provider.id));
    expect(restamped?.configuredBy).toBe(freshAdmin.id);

    // Phase 3: re-drive with the CURRENT config version → provisioned.
    clearPermissionCache();
    {
      const { state, nonce, cookie } = await seedLoginSession(provider.id, restamped!.v);
      setCallbackMocks(`sub-${randomUUID()}`, newEmail, nonce, true);
      const res = await callback(app, state, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('#ssoCode=');
      expect(await userExistsByEmail(newEmail)).toBe(true);
    }
  });

  it('#8 unknown configurer (default_role_configured_by AND created_by both NULL) FAILS CLOSED — no user provisioned', async () => {
    // Corrected behavior (Task 3 removed the wildcard back door): the legacy shape
    // does NOT proceed with a "ceiling-skipped" audit. With no resolvable
    // principal there is no ceiling, so JIT is REFUSED. Repair = re-save the
    // default role as a current adequately-permissioned admin.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // Structurally valid org-scoped default role (so we exercise the JIT
    // fail-closed gate, not the earlier pre-check).
    const orgDefaultRole = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(orgDefaultRole.id, [{ resource: 'devices', action: 'read' }]);

    await seedVerifiedDomain(org.id, EMAIL_DOMAIN);
    const provider = await seedOrgProvider(org.id, {
      status: 'active',
      autoProvision: true,
      defaultRoleId: orgDefaultRole.id,
      defaultRoleConfiguredBy: null,
      createdBy: null,
    });

    const newEmail = `newhire8-${randomUUID()}@${EMAIL_DOMAIN}`;
    const { state, nonce, cookie } = await seedLoginSession(provider.id, provider.configVersion);
    setCallbackMocks(`sub-${randomUUID()}`, newEmail, nonce, true);
    const res = await callback(app, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?error=invalid_provider_configuration');
    expect(await userExistsByEmail(newEmail)).toBe(false);
  });

  it('C: partner-axis link binds a partner-staff user (orgId NULL) and rejects one that has gained an orgId', async () => {
    const partner = await createPartner();
    const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });

    // Staff user: partner_users row, users.orgId NULL → binds successfully.
    const staff = await seedPasswordlessUser({ partnerId: partner.id, orgId: null, email: `staff-c-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToPartner(staff.id, partner.id, partnerRole.id, 'all');
    const provider = await seedPartnerProvider(partner.id);

    const familyId = randomUUID();
    await getTestDb().insert(refreshTokenFamilies).values({ familyId, userId: staff.id, absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    {
      const { state, nonce, cookie } = await seedLinkSession(provider.id, provider.configVersion, { linkUserId: staff.id, authEpoch: 1, mfaEpoch: 1, sessionId: familyId });
      setCallbackMocks(`sub-c-${randomUUID()}`, staff.email, nonce, true);
      const res = await callback(app, state, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/settings/profile?ssoLinked=1');
      expect(await identityCountFor(provider.id)).toBe(1);
    }

    // Staff user violates the partner-staff invariant by gaining an orgId →
    // link_axis_membership_lost → session_invalid, no new identity.
    const org = await createOrganization({ partnerId: partner.id });
    const violator = await seedPasswordlessUser({ partnerId: partner.id, orgId: org.id, email: `violator-c-${randomUUID()}@${EMAIL_DOMAIN}` });
    await assignUserToPartner(violator.id, partner.id, partnerRole.id, 'all');
    const violatorFamily = randomUUID();
    await getTestDb().insert(refreshTokenFamilies).values({ familyId: violatorFamily, userId: violator.id, absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    {
      const { state, nonce, cookie } = await seedLinkSession(provider.id, provider.configVersion, { linkUserId: violator.id, authEpoch: 1, mfaEpoch: 1, sessionId: violatorFamily });
      setCallbackMocks(`sub-c2-${randomUUID()}`, violator.email, nonce, true);
      const res = await callback(app, state, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/settings/profile?ssoLinkError=session_invalid');
      // still only the one identity from the successful staff link
      expect(await identityCountFor(provider.id)).toBe(1);
    }
  });
});
