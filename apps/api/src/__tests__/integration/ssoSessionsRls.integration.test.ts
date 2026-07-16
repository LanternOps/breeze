/**
 * sso_sessions RLS — system-scope-only enforcement (SR2-11, Task 1).
 *
 * Migration under test: 2026-07-16-sso-session-binding-and-provider-version.sql.
 *
 * sso_sessions is a pre-auth CSRF/PKCE transaction store with NO tenant column.
 * Task 1 gave it ENABLE + FORCE ROW LEVEL SECURITY plus ONE ALL-command policy
 * keyed on `breeze.scope = 'system'` (`sso_sessions_system_only`). This suite
 * proves the policy is real against the genuine `breeze_app` RLS-enforced pool
 * (the rls-coverage contract test only asserts the policy EXISTS; it does not
 * exercise it), and — critically — that enabling it did NOT brick provider
 * deletion (C1), which depends on the two authenticated bare-`db` writers moving
 * into system context.
 *
 * SQLSTATE discipline (memory: rls-forge-test-memoized-fixture-vacuous): every
 * negative control asserts the SPECIFIC Postgres error code (42501 for an INSERT
 * WITH CHECK deny) or a concrete 0-row / row-survives property — never a bare
 * `.rejects.toThrow()`.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { ssoProviders, ssoSessions, userSsoIdentities, users } from '../../db/schema';
import {
  createOrganization,
  createPartner,
  createRole,
  assignUserToOrganization,
  grantRolePermissions,
} from './db-utils';
import { encryptSecret } from '../../services/secretCrypto';
import { createAccessToken } from '../../services/jwt';
import { Hono } from 'hono';
import { ssoRoutes } from '../../routes/sso';

// The link-start route needs this to sign the state cookie; harmless here but
// keeps parity with the other SSO integration suites.
process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY || 'integration-test-app-encryption-key-32-bytes!';

const ISSUER = 'https://idp.example.test';

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

/** Seed an org-axis provider directly (superuser bypasses RLS for seeding). */
async function seedOrgProvider(orgId: string) {
  const testDb = getTestDb();
  const [row] = await testDb
    .insert(ssoProviders)
    .values({
      orgId,
      partnerId: null,
      name: `RLS IdP ${randomUUID()}`,
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
  if (!row) throw new Error('failed to seed provider');
  return row;
}

const trackedProviders: string[] = [];
afterEach(async () => {
  if (trackedProviders.length === 0) return;
  const testDb = getTestDb();
  for (const id of trackedProviders) {
    await testDb.delete(ssoSessions).where(eq(ssoSessions.providerId, id));
    await testDb.delete(userSsoIdentities).where(eq(userSsoIdentities.providerId, id));
    await testDb.delete(ssoProviders).where(eq(ssoProviders.id, id));
  }
  trackedProviders.length = 0;
});

describe('sso_sessions RLS — system-scope-only (2026-07-16 migration)', () => {
  it('a row inserted under system scope is INVISIBLE to an org-scoped SELECT (0 rows, not an error)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const provider = await seedOrgProvider(org.id);
    trackedProviders.push(provider.id);

    const state = `rls-select-${randomUUID()}`;
    await withSystemDbAccessContext(async () =>
      db.insert(ssoSessions).values({
        providerId: provider.id,
        state,
        nonce: `nonce-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );

    // Under an org-scoped context breeze_app cannot satisfy USING(scope='system'):
    // the row is filtered out, so the SELECT returns 0 rows (no error).
    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: ssoSessions.id }).from(ssoSessions).where(eq(ssoSessions.state, state)),
    );
    expect(visibleToOrg).toEqual([]);

    // The row genuinely exists (superuser bypasses RLS).
    const [systemView] = await getTestDb()
      .select({ id: ssoSessions.id })
      .from(ssoSessions)
      .where(eq(ssoSessions.state, state))
      .limit(1);
    expect(systemView).toBeDefined();
  });

  it('an org-scoped INSERT is denied with SQLSTATE 42501 (WITH CHECK)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const provider = await seedOrgProvider(org.id);
    trackedProviders.push(provider.id);

    await expect(
      withDbAccessContext(orgContext(org.id), () =>
        db.insert(ssoSessions).values({
          providerId: provider.id,
          state: `rls-forge-${randomUUID()}`,
          nonce: `nonce-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scoped DELETE is a no-op: 0 rows affected and the row survives (cannot burn another scope\'s pending state)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const provider = await seedOrgProvider(org.id);
    trackedProviders.push(provider.id);

    const state = `rls-delete-${randomUUID()}`;
    await withSystemDbAccessContext(async () =>
      db.insert(ssoSessions).values({
        providerId: provider.id,
        state,
        nonce: `nonce-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );

    const deleted = await withDbAccessContext(orgContext(org.id), () =>
      db.delete(ssoSessions).where(eq(ssoSessions.state, state)).returning({ id: ssoSessions.id }),
    );
    expect(deleted).toEqual([]);

    // Still present under system scope — the delete never touched it.
    const survivor = await withSystemDbAccessContext(async () =>
      db.select({ id: ssoSessions.id }).from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1),
    );
    expect(survivor).toHaveLength(1);
  });

  it('system scope can INSERT, SELECT and DELETE the row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const provider = await seedOrgProvider(org.id);
    trackedProviders.push(provider.id);

    const state = `rls-system-${randomUUID()}`;
    await withSystemDbAccessContext(async () =>
      db.insert(ssoSessions).values({
        providerId: provider.id,
        state,
        nonce: `nonce-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );

    const selected = await withSystemDbAccessContext(async () =>
      db.select({ id: ssoSessions.id }).from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1),
    );
    expect(selected).toHaveLength(1);

    const deleted = await withSystemDbAccessContext(async () =>
      db.delete(ssoSessions).where(eq(ssoSessions.state, state)).returning({ id: ssoSessions.id }),
    );
    expect(deleted).toHaveLength(1);
  });

  // ── C1: DELETE /providers/:id survives BOTH RLS blockers ──────────────────
  // sso_sessions (system-only) + user_sso_identities (USER_ID_SCOPED) would each
  // silently 0-row from an admin's tenant context, and neither FK cascades — so
  // before Task 1's system-context wrap the provider delete would die with FK
  // 23503. These prove the wrap works, and — carry-list proof A — that the three
  // deletes share ONE transaction.

  async function orgAdminToken(orgId: string, partnerId: string) {
    // An org admin holding sso:admin, MFA-satisfied (requireMfa gates the route).
    const role = await createRole({ scope: 'organization', orgId });
    await grantRolePermissions(role.id, [{ resource: 'sso', action: 'admin' }]);
    const testDb = getTestDb();
    const [admin] = await testDb
      .insert(users)
      .values({
        partnerId,
        orgId,
        email: `sso-admin-${randomUUID()}@corp.example`,
        name: 'SSO Admin',
        passwordHash: null,
        status: 'active',
      })
      .returning();
    if (!admin) throw new Error('failed to seed admin');
    await assignUserToOrganization(admin.id, orgId, role.id);
    const token = await createAccessToken({
      sub: admin.id,
      email: admin.email,
      roleId: role.id,
      orgId,
      partnerId: null,
      scope: 'organization',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });
    return { admin, token };
  }

  it('C1: DELETE /providers/:id returns 200 and removes the provider, its pending session, AND another user\'s identity link', async () => {
    const app = new Hono();
    app.route('/sso', ssoRoutes);

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const provider = await seedOrgProvider(org.id);
    trackedProviders.push(provider.id);
    const { token } = await orgAdminToken(org.id, partner.id);

    const testDb = getTestDb();
    // (a) a pending session for the provider
    await testDb.insert(ssoSessions).values({
      providerId: provider.id,
      state: `c1-${randomUUID()}`,
      nonce: `nonce-${randomUUID()}`,
      providerVersion: provider.configVersion,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    // (b) an identity link belonging to a DIFFERENT user than the deleting admin
    const [otherUser] = await testDb
      .insert(users)
      .values({
        partnerId: partner.id,
        orgId: org.id,
        email: `other-${randomUUID()}@corp.example`,
        name: 'Other User',
        passwordHash: null,
        status: 'active',
      })
      .returning();
    await testDb.insert(userSsoIdentities).values({
      userId: otherUser!.id,
      providerId: provider.id,
      externalId: `ext-${randomUUID()}`,
      email: otherUser!.email,
    });

    const res = await app.request(`/sso/providers/${provider.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const providerRows = await testDb.select({ id: ssoProviders.id }).from(ssoProviders).where(eq(ssoProviders.id, provider.id));
    const sessionRows = await testDb.select({ id: ssoSessions.id }).from(ssoSessions).where(eq(ssoSessions.providerId, provider.id));
    const identityRows = await testDb.select({ id: userSsoIdentities.id }).from(userSsoIdentities).where(eq(userSsoIdentities.providerId, provider.id));
    expect(providerRows).toEqual([]);
    expect(sessionRows).toEqual([]);
    expect(identityRows).toEqual([]);
  });

  it('C1/404: DELETE on a non-existent provider id performs ZERO deletes (guard-before-delete ordering)', async () => {
    const app = new Hono();
    app.route('/sso', ssoRoutes);

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const provider = await seedOrgProvider(org.id);
    trackedProviders.push(provider.id);
    const { token } = await orgAdminToken(org.id, partner.id);

    const testDb = getTestDb();
    await testDb.insert(ssoSessions).values({
      providerId: provider.id,
      state: `c1-404-${randomUUID()}`,
      nonce: `nonce-${randomUUID()}`,
      providerVersion: provider.configVersion,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const res = await app.request(`/sso/providers/${randomUUID()}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);

    // The real provider's session is untouched — the 404 returns before the
    // system-context cleanup block runs.
    const sessionRows = await testDb.select({ id: ssoSessions.id }).from(ssoSessions).where(eq(ssoSessions.providerId, provider.id));
    expect(sessionRows).toHaveLength(1);
  });

  it('A: atomicity — if the provider DELETE fails mid-transaction, the identity/session deletes roll back', async () => {
    // Carry-list proof A. The only FK children of sso_providers are the two the
    // route itself deletes (sso_sessions, user_sso_identities), so there is no
    // natural un-cleaned child to block the provider delete. We CONSTRUCT one: a
    // throwaway table with an ON DELETE NO ACTION FK to sso_providers. With a row
    // in it, the provider delete throws FK 23503 INSIDE the single
    // withSystemDbAccessContext transaction, which rolls back the already-issued
    // session + identity deletes. We assert the other user's identity SURVIVES.
    const app = new Hono();
    app.route('/sso', ssoRoutes);

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const provider = await seedOrgProvider(org.id);
    trackedProviders.push(provider.id);
    const { token } = await orgAdminToken(org.id, partner.id);

    const testDb = getTestDb();
    const blockerTable = `_t8_fk_blocker_${randomUUID().replace(/-/g, '')}`;
    try {
      // NO ACTION (default) → the parent delete fails while a child exists.
      await testDb.execute(
        sql.raw(
          `CREATE TABLE ${blockerTable} (id uuid primary key default gen_random_uuid(), provider_id uuid REFERENCES sso_providers(id))`,
        ),
      );

      const [otherUser] = await testDb
        .insert(users)
        .values({
          partnerId: partner.id,
          orgId: org.id,
          email: `atomic-${randomUUID()}@corp.example`,
          name: 'Atomic User',
          passwordHash: null,
          status: 'active',
        })
        .returning();
      await testDb.insert(userSsoIdentities).values({
        userId: otherUser!.id,
        providerId: provider.id,
        externalId: `ext-atomic-${randomUUID()}`,
        email: otherUser!.email,
      });
      await testDb.insert(ssoSessions).values({
        providerId: provider.id,
        state: `atomic-${randomUUID()}`,
        nonce: `nonce-${randomUUID()}`,
        providerVersion: provider.configVersion,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      // The blocker row makes the provider delete fail 23503.
      await testDb.execute(sql.raw(`INSERT INTO ${blockerTable} (provider_id) VALUES ('${provider.id}')`));

      const res = await app.request(`/sso/providers/${provider.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      // The uncaught FK error surfaces as a 500 from the route.
      expect(res.status).toBe(500);

      // ROLLBACK PROPERTY: the identity + session deletes that ran earlier in the
      // same transaction were rolled back — the rows survive.
      const identityRows = await testDb.select({ id: userSsoIdentities.id }).from(userSsoIdentities).where(eq(userSsoIdentities.providerId, provider.id));
      const sessionRows = await testDb.select({ id: ssoSessions.id }).from(ssoSessions).where(eq(ssoSessions.providerId, provider.id));
      const providerRows = await testDb.select({ id: ssoProviders.id }).from(ssoProviders).where(eq(ssoProviders.id, provider.id));
      expect(identityRows).toHaveLength(1);
      expect(sessionRows).toHaveLength(1);
      expect(providerRows).toHaveLength(1);
    } finally {
      await testDb.execute(sql.raw(`DROP TABLE IF EXISTS ${blockerTable}`));
    }
  });
});
