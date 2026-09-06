/**
 * custom_field_definitions RLS — dual-axis (org OR partner) enforcement.
 *
 * Epic #2135 playbook step 6 was never done for this table when it was
 * converted to dual-axis in `2026-06-11-i-custom-fields-dual-axis-rls.sql`.
 * #3257 W02 writes the suite the playbook asks for, alongside the new
 * `custom_field_definitions_one_owner_chk` XOR
 * (`2026-10-10-100300-custom-field-definition-integrity.sql`).
 *
 * The shipped write policy (all four commands) is:
 *   breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)
 *
 * There is deliberately NO partner-wide SELECT branch on this table yet: it is
 * listed in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` in
 * `rls-coverage.integration.test.ts` against open follow-up **#4944**. That is
 * a real gap, not a design choice — but it is #4944's gap, not this wave's, so
 * this suite pins the CURRENT behaviour (an org token cannot see its own
 * partner's partner-wide definitions) rather than asserting the behaviour the
 * playbook wants. When #4944 lands, the `org token cannot read` test below is
 * the one that must be inverted, and its comment says so.
 *
 * `rls-coverage.integration.test.ts` proves the policy EXISTS by reading
 * pg_catalog; it cannot prove either branch actually enforces anything. This
 * suite drives the real postgres.js driver as `breeze_app` under FORCE RLS,
 * which is the only thing that does.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdKeys: string[] = [];

afterEach(async () => {
  if (createdKeys.length === 0) return;
  const keys = [...new Set(createdKeys)];
  createdKeys.length = 0;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(customFieldDefinitions).where(inArray(customFieldDefinitions.fieldKey, keys)),
  );
});

/** A partner-scoped session: passes breeze_has_partner_access for its own partner. */
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * An org-scoped session. `currentPartnerId` is populated from the token's
 * partnerId for org scope too (buildDbAccessContext), so it is set here
 * deliberately — it is exactly what a partner-wide SELECT branch would key on,
 * and leaving it null would make the "org token cannot read partner-wide rows"
 * test below pass for the wrong reason. `accessiblePartnerIds` stays empty: an
 * org token never passes breeze_has_partner_access.
 */
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

const BASE = { name: 'Asset Tag', type: 'text' as const };

/** Seed a definition under SYSTEM scope, bypassing the policy under test. */
async function seedDefinition(
  values: { orgId?: string | null; partnerId?: string | null; fieldKey: string },
): Promise<string> {
  createdKeys.push(values.fieldKey);
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(customFieldDefinitions).values({
      ...BASE,
      orgId: values.orgId ?? null,
      partnerId: values.partnerId ?? null,
      fieldKey: values.fieldKey,
    }).returning({ id: customFieldDefinitions.id }),
  );
  return rows[0]!.id;
}

/** See customFieldDefinitionIntegrity.integration.test.ts for why `.cause` matters. */
async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

function uniqueKey(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

describe('custom_field_definitions partner RLS (#2135 step 6)', () => {
  describe('write policy', () => {
    it('partner scope can INSERT a partner-wide definition (org_id NULL, partner_id set)', async () => {
      const partner = await createPartner();
      const fieldKey = uniqueKey('partner_wide');
      createdKeys.push(fieldKey);

      const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
        db.insert(customFieldDefinitions)
          .values({ ...BASE, orgId: null, partnerId: partner.id, fieldKey })
          .returning(),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBeNull();
      expect(rows[0]?.partnerId).toBe(partner.id);
    });

    it('refuses a cross-partner forge with 42501', async () => {
      const attacker = await createPartner();
      const victim = await createPartner();
      const fieldKey = uniqueKey('forged');
      createdKeys.push(fieldKey);

      // 42501 = insufficient_privilege: the RLS WITH CHECK rejected it.
      await expectSqlState(
        () => withDbAccessContext(partnerContext(attacker.id, []), () =>
          db.insert(customFieldDefinitions)
            .values({ ...BASE, orgId: null, partnerId: victim.id, fieldKey })
            .returning(),
        ),
        '42501',
      );
    });

    it('refuses a row claiming BOTH owners with 23514 (the XOR check)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const fieldKey = uniqueKey('both_axes');
      createdKeys.push(fieldKey);

      // Both axes set means the RLS WITH CHECK is satisfied (the org branch
      // passes), so the statement reaches the CHECK constraint — this is the
      // case that proves the XOR is doing work RLS does not.
      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
          db.insert(customFieldDefinitions)
            .values({ ...BASE, orgId: org.id, partnerId: partner.id, fieldKey })
            .returning(),
        ),
        '23514',
      );
    });

    /**
     * An ownerless row trips RLS (42501) BEFORE the CHECK is ever evaluated:
     * with both columns NULL, neither branch of the WITH CHECK can match, and
     * Postgres evaluates the row-security check first. So the SQLSTATE here is
     * 42501, not the 23514 the constraint would give — RLS is strictly
     * stricter than the constraint on this path.
     *
     * The 23514 half is proved in
     * `customFieldDefinitionIntegrity.integration.test.ts`, which inserts under
     * SYSTEM scope (where breeze_has_org_access short-circuits TRUE, so RLS
     * lets the row through and the constraint is the only thing left). Both
     * halves matter: the constraint is what protects migrations, backfills and
     * the importer's own system-context writes, none of which RLS stops.
     * Same ordering as cis_baselines — see that suite's matching test.
     */
    it('refuses an ownerless (NULL, NULL) row — RLS fires first, at 42501', async () => {
      const partner = await createPartner();
      const fieldKey = uniqueKey('orphan');
      createdKeys.push(fieldKey);

      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, []), () =>
          db.insert(customFieldDefinitions)
            .values({ ...BASE, orgId: null, partnerId: null, fieldKey })
            .returning(),
        ),
        '42501',
      );
    });
  });

  describe('read isolation', () => {
    it('hides partner A rows from partner B entirely', async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const fieldKey = uniqueKey('a_only');
      await seedDefinition({ partnerId: partnerA.id, fieldKey });

      const rows = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.select({ id: customFieldDefinitions.id })
          .from(customFieldDefinitions)
          .where(eq(customFieldDefinitions.partnerId, partnerA.id)),
      );

      expect(rows).toHaveLength(0);
    });

    it("hides another org's definitions from an org token under the same partner", async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const fieldKey = uniqueKey('org_a_only');
      await seedDefinition({ orgId: orgA.id, fieldKey });

      const rows = await withDbAccessContext(orgContext(orgB.id, partner.id), () =>
        db.select({ id: customFieldDefinitions.id })
          .from(customFieldDefinitions)
          .where(eq(customFieldDefinitions.fieldKey, fieldKey)),
      );

      expect(rows).toHaveLength(0);
    });

    /**
     * CURRENT behaviour, and a known gap: an org token carries a partnerId but
     * never passes breeze_has_partner_access, and this table has no
     * `org_id IS NULL AND partner_id = breeze_current_partner_id()`
     * SELECT-only branch yet (PARTNER_WIDE_SELECT_BRANCH_EXEMPT, **#4944**).
     * So an org user is blind to their own partner's partner-wide definitions.
     *
     * WHEN #4944 LANDS, THIS TEST MUST BE INVERTED to expect 1 row — it is
     * pinned here so that change is a deliberate, visible edit rather than a
     * silent behavioural drift. RLS is stricter than the app layer here; never
     * claim parity.
     */
    it('hides partner-wide rows from an ORG token under the same partner (gap #4944)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const fieldKey = uniqueKey('partner_wide_read');
      await seedDefinition({ partnerId: partner.id, fieldKey });

      const rows = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.select({ id: customFieldDefinitions.id })
          .from(customFieldDefinitions)
          .where(eq(customFieldDefinitions.fieldKey, fieldKey)),
      );

      expect(rows).toHaveLength(0);
    });

    it('lets a partner token read its own partner-wide and its orgs’ definitions', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const partnerKey = uniqueKey('own_partner_wide');
      const orgKey = uniqueKey('own_org');
      await seedDefinition({ partnerId: partner.id, fieldKey: partnerKey });
      await seedDefinition({ orgId: org.id, fieldKey: orgKey });

      const rows = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
        db.select({ fieldKey: customFieldDefinitions.fieldKey })
          .from(customFieldDefinitions)
          .where(inArray(customFieldDefinitions.fieldKey, [partnerKey, orgKey])),
      );

      expect(rows.map((r) => r.fieldKey).sort()).toEqual([orgKey, partnerKey].sort());
    });
  });

  describe('update/delete targeting', () => {
    it("a partner token cannot UPDATE another partner's partner-wide definition", async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const fieldKey = uniqueKey('a_immutable');
      await seedDefinition({ partnerId: partnerA.id, fieldKey });

      // RLS makes the row unreachable, so the UPDATE matches zero rows rather
      // than raising — the silent shape. Assert the row is UNCHANGED, not just
      // that nothing threw.
      const updated = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.update(customFieldDefinitions)
          .set({ name: 'Hijacked' })
          .where(eq(customFieldDefinitions.fieldKey, fieldKey))
          .returning({ id: customFieldDefinitions.id }),
      );
      expect(updated).toHaveLength(0);

      const after = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ name: customFieldDefinitions.name })
          .from(customFieldDefinitions)
          .where(eq(customFieldDefinitions.fieldKey, fieldKey)),
      );
      expect(after[0]?.name).toBe(BASE.name);
    });

    it("a partner token cannot DELETE another partner's partner-wide definition", async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const fieldKey = uniqueKey('a_undeletable');
      await seedDefinition({ partnerId: partnerA.id, fieldKey });

      const deleted = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.delete(customFieldDefinitions)
          .where(eq(customFieldDefinitions.fieldKey, fieldKey))
          .returning({ id: customFieldDefinitions.id }),
      );
      expect(deleted).toHaveLength(0);

      const survivors = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ id: customFieldDefinitions.id })
          .from(customFieldDefinitions)
          .where(and(
            eq(customFieldDefinitions.fieldKey, fieldKey),
            eq(customFieldDefinitions.partnerId, partnerA.id),
          )),
      );
      expect(survivors).toHaveLength(1);
    });
  });
});
