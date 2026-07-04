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
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { partnerLoginBranding, partners } from '../../db/schema';
import { createPartner } from './db-utils';

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
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
});
