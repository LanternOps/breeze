/**
 * partner_login_branding RLS — partner-axis (Shape 3) enforcement (#2183).
 *
 * Migration under test: 2026-07-03-sso-partner-axis-login-branding.sql.
 *
 * partner_login_branding is deliberately partner-ONLY (no org axis): one row
 * per partner, PK = partner_id, FK ON DELETE CASCADE to partners. Policy
 * (USING + WITH CHECK):
 *   breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id)
 *
 * Runs through the REAL postgres.js driver (breeze_app role, rolbypassrls=f
 * — see setup.ts), so RLS is genuinely enforced and these assertions are not
 * vacuous. See memory: worktree_env_test_rls_vacuous.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { partnerLoginBranding, partners } from '../../db/schema';
import { createOrganization, createPartner, createRole, createUser, assignUserToPartner } from './db-utils';
import { createAccessToken } from '../../services/jwt';
import { partnerLoginBrandingRoutes } from '../../routes/partnerLoginBranding';

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const systemContext: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

describe('partner_login_branding RLS — partner-axis (2026-07-03 migration)', () => {
  it('partner A can upsert its own login-branding row', async () => {
    const partnerA = await createPartner();

    const inserted = await withDbAccessContext(partnerContext(partnerA.id), () =>
      db
        .insert(partnerLoginBranding)
        .values({ partnerId: partnerA.id, headline: 'Welcome to Acme MSP', accentColor: '#336699' })
        .returning(),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.partnerId).toBe(partnerA.id);

    const upserted = await withDbAccessContext(partnerContext(partnerA.id), () =>
      db
        .insert(partnerLoginBranding)
        .values({ partnerId: partnerA.id, headline: 'Welcome back', accentColor: '#336699' })
        .onConflictDoUpdate({
          target: partnerLoginBranding.partnerId,
          set: { headline: 'Welcome back' },
        })
        .returning(),
    );
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.headline).toBe('Welcome back');
  });

  it('partner B forging partner A\'s partner_id is rejected (42501)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    await expect(
      withDbAccessContext(partnerContext(partnerB.id), () =>
        db
          .insert(partnerLoginBranding)
          .values({ partnerId: partnerA.id, headline: 'Forged branding' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('partner B sees nothing when selecting partner A\'s branding row', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    await withDbAccessContext(partnerContext(partnerA.id), () =>
      db.insert(partnerLoginBranding).values({ partnerId: partnerA.id, headline: 'Acme MSP' }).returning(),
    );

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id), () =>
      db
        .select({ partnerId: partnerLoginBranding.partnerId })
        .from(partnerLoginBranding)
        .where(eq(partnerLoginBranding.partnerId, partnerA.id)),
    );
    expect(visibleToB).toEqual([]);
  });

  it('DELETE FROM partners cascades to remove the branding row (ON DELETE CASCADE)', async () => {
    const partnerA = await createPartner();

    await withDbAccessContext(partnerContext(partnerA.id), () =>
      db.insert(partnerLoginBranding).values({ partnerId: partnerA.id, headline: 'Acme MSP' }).returning(),
    );

    await withDbAccessContext(systemContext, () => db.delete(partners).where(eq(partners.id, partnerA.id)));

    const remaining = await withDbAccessContext(systemContext, () =>
      db
        .select({ partnerId: partnerLoginBranding.partnerId })
        .from(partnerLoginBranding)
        .where(eq(partnerLoginBranding.partnerId, partnerA.id)),
    );
    expect(remaining).toEqual([]);

    // Belt-and-suspenders: confirm the row is genuinely gone at the storage
    // level, not just filtered out by RLS on a system-scope read.
    const count = await withDbAccessContext(systemContext, () =>
      db.execute(sql`SELECT count(*)::int AS n FROM partner_login_branding WHERE partner_id = ${partnerA.id}`),
    );
    expect((count as unknown as { n: number }[])[0]?.n).toBe(0);
  });

  it('an org-scope caller under partner A can neither SELECT nor UPDATE partner A\'s login-branding row (org tokens never pass breeze_has_partner_access)', async () => {
    // Mirrors ssoProvidersPartnerRls.integration.test.ts's "org-scope caller
    // cannot see partner-axis rows" case (~lines 144-161) for this table's
    // own (also partner-ONLY, no org axis) policy.
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });

    await withDbAccessContext(partnerContext(partnerA.id), () =>
      db.insert(partnerLoginBranding).values({ partnerId: partnerA.id, headline: 'Acme MSP' }).returning(),
    );

    const visibleToOrg = await withDbAccessContext(orgContext(orgA.id), () =>
      db
        .select({ partnerId: partnerLoginBranding.partnerId })
        .from(partnerLoginBranding)
        .where(eq(partnerLoginBranding.partnerId, partnerA.id)),
    );
    expect(visibleToOrg).toEqual([]);

    // The USING clause filters the UPDATE's target row set to zero rows —
    // this is a silent no-op, not a thrown error, since the row is simply
    // invisible to the org-scope context (no error path to assert on).
    const updatedByOrg = await withDbAccessContext(orgContext(orgA.id), () =>
      db
        .update(partnerLoginBranding)
        .set({ headline: 'Hijacked by org scope' })
        .where(eq(partnerLoginBranding.partnerId, partnerA.id))
        .returning(),
    );
    expect(updatedByOrg).toEqual([]);

    // Confirm the row is untouched at the storage level (not just filtered
    // out of THIS read — a genuinely unauthorized write would have changed it).
    const [stillIntact] = await withDbAccessContext(systemContext, () =>
      db
        .select({ headline: partnerLoginBranding.headline })
        .from(partnerLoginBranding)
        .where(eq(partnerLoginBranding.partnerId, partnerA.id)),
    );
    expect(stillIntact?.headline).toBe('Acme MSP');
  });

  it('PUT /partners/me/login-branding is full-replace: a partial PUT null-clears fields omitted from the request body (real route + real DB)', async () => {
    const app = new Hono();
    app.route('/partners', partnerLoginBrandingRoutes);

    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, withMembership: false });
    // 'all' org_access is required by canManagePartnerWidePolicies for the
    // PUT to be authorized at all (services/partnerWideAccess.ts).
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const token = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: false,
      amr: ['password'],
    });
    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // (1) Full object.
    const putFullRes = await app.request('/partners/me/login-branding', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ logoUrl: 'https://cdn.example.test/logo.png', accentColor: '#123abc', headline: 'Welcome' }),
    });
    expect(putFullRes.status).toBe(200);
    const putFullBody = await putFullRes.json();
    expect(putFullBody.data).toEqual({
      logoUrl: 'https://cdn.example.test/logo.png',
      accentColor: '#123abc',
      headline: 'Welcome',
    });

    // (2) Partial PUT — only headline. logoUrl/accentColor are OMITTED, not
    // explicitly nulled, so this proves the route's own null-coalescing
    // (`body.logoUrl ?? null`), not just a client sending explicit nulls.
    const putPartialRes = await app.request('/partners/me/login-branding', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ headline: 'Only headline now' }),
    });
    expect(putPartialRes.status).toBe(200);
    const putPartialBody = await putPartialRes.json();
    expect(putPartialBody.data).toEqual({ logoUrl: null, accentColor: null, headline: 'Only headline now' });

    // (3) GET confirms the REAL database reflects the null-clear, not just
    // the PUT handler's echoed response.
    const getRes = await app.request('/partners/me/login-branding', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data).toEqual({ logoUrl: null, accentColor: null, headline: 'Only headline now' });
  });
});
