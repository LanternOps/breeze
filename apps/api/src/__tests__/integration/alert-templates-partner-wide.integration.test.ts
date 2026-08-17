/**
 * Integration test for #1425 — partner-wide alert templates.
 *
 * #1357 gave alert_templates a partner_id axis + dual-axis RLS:
 *   SELECT  USING (breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id) OR is_built_in)
 *   INSERT  WITH CHECK (breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id))
 * A partner-wide template is org_id NULL + partner_id set. This proves the
 * route's new partner-wide create path produces rows the RLS actually accepts,
 * that they stay isolated to the owning partner, and that an org-scope caller
 * cannot forge one — the dual-axis breeze_app checks a mocked-db unit test
 * can't cover (the custom_field_definitions / #633 class of bug).
 *
 * Runs as the unprivileged breeze_app role so RLS is enforced.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { alertTemplates } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';

const baseValues = (name: string) => ({
  name,
  conditions: { metric: 'cpu', operator: '>', threshold: 90 },
  severity: 'high' as const,
  titleTemplate: '{{deviceName}}: ' + name,
  messageTemplate: 'Alert: ' + name,
  isBuiltIn: false,
});

describe('alert_templates partner-wide RLS — #1425', () => {
  it('partner scope can INSERT and read back a partner-wide template (org_id NULL)', async () => {
    const partner = await createPartner();
    const name = `pw-template-${Date.now()}`;

    const rows = await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [partner.id] },
      async () => {
        await db.insert(alertTemplates).values({ orgId: null, partnerId: partner.id, ...baseValues(name) });
        return db.select().from(alertTemplates).where(eq(alertTemplates.name, name));
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBeNull();
    expect(rows[0]!.partnerId).toBe(partner.id);
  });

  it('a different partner cannot see another partner’s partner-wide template', async () => {
    const owner = await createPartner();
    const other = await createPartner();
    const name = `pw-isolated-${Date.now()}`;

    await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [owner.id] },
      async () => { await db.insert(alertTemplates).values({ orgId: null, partnerId: owner.id, ...baseValues(name) }); },
    );

    const seen = await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [other.id] },
      async () => db.select().from(alertTemplates).where(eq(alertTemplates.name, name)),
    );
    expect(seen).toHaveLength(0);

    // Superuser confirms the row really exists — the empty read above is RLS,
    // not a failed insert.
    const truth = await getTestDb().select().from(alertTemplates).where(eq(alertTemplates.name, name));
    expect(truth).toHaveLength(1);
  });

  it('org scope cannot forge a partner-wide template (RLS rejects the INSERT)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const name = `pw-forge-${Date.now()}`;

    let caught: unknown;
    try {
      await withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        async () => {
          await db.insert(alertTemplates).values({ orgId: null, partnerId: partner.id, ...baseValues(name) });
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(/new row violates row-level security policy for table "alert_templates"/);

    const truth = await getTestDb().select().from(alertTemplates).where(eq(alertTemplates.name, name));
    expect(truth).toHaveLength(0);
  });

  // Security review 2026-08-16 §1.5 (CRITICAL). Org-owned templates used to be
  // written with BOTH org_id and partner_id set; the read predicate's
  // `partner_id = <caller partner>` disjunct then spanned every org under the
  // partner. alert_templates_one_owner_chk
  // (2026-08-16-alert-templates-one-owner) makes that shape unrepresentable.
  describe('alert_templates_one_owner_chk', () => {
    it('rejects a row with BOTH org_id and partner_id set (23514)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const name = `xor-both-${Date.now()}`;

      let caught: unknown;
      try {
        await getTestDb()
          .insert(alertTemplates)
          .values({ orgId: org.id, partnerId: partner.id, ...baseValues(name) });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const cause = (caught as { cause?: { code?: string; constraint_name?: string } } | undefined)?.cause;
      expect(cause?.code).toBe('23514');
      expect(cause?.constraint_name).toBe('alert_templates_one_owner_chk');

      const truth = await getTestDb().select().from(alertTemplates).where(eq(alertTemplates.name, name));
      expect(truth).toHaveLength(0);
    });

    // Deliberately NOT a strict XOR: seeded global built-ins and rows a
    // system-scope caller created with no orgId both legitimately have neither
    // axis set, and a strict XOR would have made ADD CONSTRAINT fail on an
    // existing database. "Never both" is the security-relevant invariant.
    it('accepts an ownerless row (neither axis set) — the constraint is "never both", not XOR', async () => {
      const name = `xor-neither-${Date.now()}`;
      await getTestDb()
        .insert(alertTemplates)
        .values({ orgId: null, partnerId: null, ...baseValues(name) });

      const rows = await getTestDb().select().from(alertTemplates).where(eq(alertTemplates.name, name));
      expect(rows).toHaveLength(1);
    });

    it('accepts the two legal customer shapes and the global built-in shape', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const stamp = Date.now();

      // Org-owned: org_id set, partner_id NULL (what the create route now writes).
      await getTestDb()
        .insert(alertTemplates)
        .values({ orgId: org.id, partnerId: null, ...baseValues(`xor-org-${stamp}`) });
      // Partner-wide: partner_id set, org_id NULL.
      await getTestDb()
        .insert(alertTemplates)
        .values({ orgId: null, partnerId: partner.id, ...baseValues(`xor-partner-${stamp}`) });
      // Built-in: global, both axes NULL.
      await getTestDb()
        .insert(alertTemplates)
        .values({ orgId: null, partnerId: null, ...baseValues(`xor-builtin-${stamp}`), isBuiltIn: true });

      const rows = await getTestDb()
        .select()
        .from(alertTemplates)
        .where(inArray(alertTemplates.name, [`xor-org-${stamp}`, `xor-partner-${stamp}`, `xor-builtin-${stamp}`]));
      expect(rows).toHaveLength(3);
    });

    it('no stored row carries both axes (the migration backfill held)', async () => {
      const offenders = await getTestDb()
        .select({ id: alertTemplates.id, name: alertTemplates.name })
        .from(alertTemplates)
        .where(and(isNotNull(alertTemplates.orgId), isNotNull(alertTemplates.partnerId)));
      expect(offenders).toEqual([]);
    });
  });
});
