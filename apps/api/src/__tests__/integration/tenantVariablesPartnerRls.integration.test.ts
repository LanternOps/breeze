/**
 * tenant_variables RLS — dual-axis (org OR partner) enforcement (#3409 PR 1).
 *
 * Migration under test: 2026-08-11-tenant-variables.sql.
 *
 * A tenant_variables row is owned by EITHER an org (org_id set, partner_id
 * NULL) OR a partner (partner_id set, org_id NULL — the "all orgs" shape).
 * Two policies apply:
 *   tenant_variables_isolation (all commands):
 *     system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *            OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *   tenant_variables_partner_wide_select (SELECT only):
 *     org_id IS NULL AND partner_id = breeze_current_partner_id()
 *
 * The rls-coverage contract test's org auto-discovery already asserts the
 * breeze_has_org_access branch (the table has an org_id column), but it does
 * NOT prove the partner branch, the XOR CHECK, the key CHECK, the per-owner
 * unique indexes, or that the widening policy really is SELECT-only. Those
 * need a functional test through the REAL postgres.js driver as breeze_app —
 * this suite. See memory: rls_dual_axis_contract_test_blindspot.
 *
 * NOTE: `value` here is written as a literal, not through
 * services/tenantVariables.ts. That is deliberate — this suite exercises the
 * DB boundary, and the encryption round-trip is covered by
 * services/tenantVariables.test.ts.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { tenantVariables } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

function systemContext(): DbAccessContext {
  return { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId
  };
}

/**
 * An org-scoped session still carries its partner id (buildDbAccessContext
 * sets currentPartnerId from auth.partnerId for every scope) — that is what
 * the SELECT-widening policy keys off. accessiblePartnerIds stays empty, so
 * breeze_has_partner_access() is false, exactly as in production.
 */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId
  };
}

const base = { key: 's1_site_token', value: 'ciphertext-placeholder', isSecret: false };

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(systemContext(), async () => {
    for (const id of created) {
      await db.delete(tenantVariables).where(eq(tenantVariables.id, id));
    }
  });
  created.length = 0;
});

describe('tenant_variables partner RLS', () => {
  it('partner B forging partner A partner_id is rejected (42501)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.insert(tenantVariables).values({ ...base, partnerId: partnerA.id, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org B forging an org A org_id is rejected (42501)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(orgContext(orgB.id, partner.id), () =>
        db.insert(tenantVariables).values({ ...base, orgId: orgA.id, partnerId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org session cannot forge a partner-wide row for its own partner (42501)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // The widening policy is FOR SELECT, so it contributes no WITH CHECK
    // clause: the INSERT is judged solely by tenant_variables_isolation, where
    // breeze_has_partner_access() is false for an org token.
    await expect(
      withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.insert(tenantVariables).values({ ...base, orgId: null, partnerId: partner.id }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('XOR owner check: both or neither owner violates 23514', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(tenantVariables).values({ ...base, partnerId: partner.id, orgId: org.id }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(tenantVariables).values({ ...base, partnerId: null, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('key CHECK rejects keys that would not survive token/env interpolation (23514)', async () => {
    const partner = await createPartner();

    for (const key of ['Bad_Key', 'has space', '9leading', 'trailing-dash', '_leading_underscore']) {
      await expect(
        withDbAccessContext(systemContext(), () =>
          db.insert(tenantVariables).values({ ...base, key, partnerId: partner.id, orgId: null }).returning()
        )
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    }

    // An over-length key is caught by varchar(64) first (22001), not the
    // CHECK — asserted separately so the codes stay honest.
    await expect(
      withDbAccessContext(systemContext(), () =>
        db
          .insert(tenantVariables)
          .values({ ...base, key: 'a'.repeat(65), partnerId: partner.id, orgId: null })
          .returning()
      )
    ).rejects.toMatchObject({ cause: { code: '22001' } });
  });

  it('a key is unique per owner but reusable across owners (23505)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    // Same key on three different owners: two orgs and the partner itself.
    const rows = await withDbAccessContext(systemContext(), () =>
      db
        .insert(tenantVariables)
        .values([
          { ...base, orgId: orgA.id, partnerId: null },
          { ...base, orgId: orgB.id, partnerId: null },
          { ...base, orgId: null, partnerId: partner.id }
        ])
        .returning()
    );
    expect(rows).toHaveLength(3);
    created.push(...rows.map((r) => r.id));

    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(tenantVariables).values({ ...base, orgId: orgA.id, partnerId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(tenantVariables).values({ ...base, orgId: null, partnerId: partner.id }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('org B cannot read org A variables; an org CAN read its own partner-wide rows but never another partner\'s', async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    const rows = await withDbAccessContext(systemContext(), () =>
      db
        .insert(tenantVariables)
        .values([
          { ...base, key: 'org_a_only', orgId: orgA.id, partnerId: null },
          { ...base, key: 'partner_wide', orgId: null, partnerId: partner.id },
          { ...base, key: 'other_partner', orgId: null, partnerId: otherPartner.id }
        ])
        .returning()
    );
    created.push(...rows.map((r) => r.id));
    const [orgRow, partnerRow, otherRow] = rows;
    if (!orgRow || !partnerRow || !otherRow) throw new Error('insert returned no rows');

    const visibleToOrgB = await withDbAccessContext(orgContext(orgB.id, partner.id), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, orgRow.id))
    );
    expect(visibleToOrgB).toEqual([]);

    // The widening policy: an org session sees its OWN partner's partner-wide row.
    const inherited = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, partnerRow.id))
    );
    expect(inherited.map((r) => r.key)).toEqual(['partner_wide']);

    // ...and never another partner's.
    const foreign = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, otherRow.id))
    );
    expect(foreign).toEqual([]);

    // Cross-partner isolation on the partner axis itself.
    const foreignToPartner = await withDbAccessContext(partnerContext(otherPartner.id, []), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, partnerRow.id))
    );
    expect(foreignToPartner).toEqual([]);
  });

  it('the widening policy is SELECT-only: an org session cannot UPDATE or DELETE an inherited partner-wide row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const [row] = await withDbAccessContext(systemContext(), () =>
      db.insert(tenantVariables).values({ ...base, orgId: null, partnerId: partner.id }).returning()
    );
    if (!row) throw new Error('insert returned no row');
    created.push(row.id);

    // RLS filters the row out of the UPDATE/DELETE target set rather than
    // raising, so the assertion is that nothing changed — not that it threw.
    await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.update(tenantVariables).set({ description: 'hijacked' }).where(eq(tenantVariables.id, row.id))
    );
    await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.delete(tenantVariables).where(eq(tenantVariables.id, row.id))
    );

    const after = await withDbAccessContext(systemContext(), () =>
      db.select().from(tenantVariables).where(eq(tenantVariables.id, row.id))
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.description).toBeNull();
  });

  it('the owning partner CAN write its own partner-wide row (allow side of WITH CHECK)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const [row] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.insert(tenantVariables).values({ ...base, orgId: null, partnerId: partner.id }).returning()
    );
    expect(row).toMatchObject({ partnerId: partner.id, orgId: null, key: base.key });
    if (row) created.push(row.id);
  });
});
