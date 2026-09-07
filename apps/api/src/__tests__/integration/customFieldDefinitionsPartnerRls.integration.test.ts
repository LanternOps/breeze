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
 * Since **#4944** the table ALSO carries a SELECT-only partner-wide read branch
 * (`custom_field_definitions_partner_wide_select`,
 * 2026-10-13-110000-custom-field-definitions-partner-wide-select.sql):
 *   org_id IS NULL AND partner_id = public.breeze_current_partner_id()
 * A separate permissive FOR SELECT policy, never an edit to the four above —
 * Postgres does not consult FOR SELECT policies when computing UPDATE/DELETE
 * target rows, so the branch ORs into reads and grants no write. That is what
 * the `read isolation` cases below now pin: an org token READS its own
 * partner's partner-wide definitions, a DIFFERENT partner's stay invisible, and
 * every write path against a partner-wide row is still a zero-row no-op or a
 * 42501.
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
 * deliberately — it is exactly what the #4944 partner-wide SELECT branch keys
 * on. Passing `null` is NOT a user token at all; it is the degenerate
 * "no partner GUC set" caller, kept so the `=` vs `IS NOT DISTINCT FROM` choice
 * in the policy stays pinned (see the NULL-GUC case below).
 * `accessiblePartnerIds` stays empty: an org token never passes
 * breeze_has_partner_access, and that is what keeps the branch read-only.
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

/**
 * The DEVICE-TOKEN session shape, copied field-for-field from
 * `middleware/agentAuth.ts` (`scope: 'organization'`, `accessibleOrgIds:
 * [device.orgId]`, `accessiblePartnerIds: []`, `currentPartnerId:
 * device.partnerId` — agentAuth.ts:959, #4673 W02). It is a distinct helper
 * rather than a call to `orgContext` so a future change to agentAuth's context
 * has ONE place here to be mirrored, and so the agent assertions cannot
 * silently drift into testing a user token instead.
 */
function agentContext(orgId: string, devicePartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: devicePartnerId,
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
     * #4944 INVERTED this case. It used to assert an org token was blind to its
     * own partner's partner-wide definitions (the gap
     * PARTNER_WIDE_SELECT_BRANCH_EXEMPT tracked); the
     * `custom_field_definitions_partner_wide_select` branch now grants exactly
     * that read.
     *
     * The org-owned row is fetched alongside as a POSITIVE CONTROL: without it
     * a policy that accidentally replaced (rather than augmented) the shipped
     * `breeze_dual_axis_select` would still satisfy the partner-wide half and
     * this test would go green on a table the org had otherwise lost.
     */
    it('lets an ORG token read its own partner\u2019s partner-wide rows (#4944)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const partnerKey = uniqueKey('partner_wide_read');
      const orgKey = uniqueKey('own_org_read');
      await seedDefinition({ partnerId: partner.id, fieldKey: partnerKey });
      await seedDefinition({ orgId: org.id, fieldKey: orgKey });

      const rows = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.select({ fieldKey: customFieldDefinitions.fieldKey })
          .from(customFieldDefinitions)
          .where(inArray(customFieldDefinitions.fieldKey, [partnerKey, orgKey])),
      );

      expect(rows.map((r) => r.fieldKey).sort()).toEqual([orgKey, partnerKey].sort());
    });

    /**
     * Cross-partner containment for the new branch. The predicate keys on the
     * caller's OWN partner, so partner B's partner-wide row must stay invisible
     * to an org of partner A even though both rows are `org_id NULL`.
     */
    it('still hides ANOTHER partner\u2019s partner-wide rows from an ORG token (#4944)', async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const orgA = await createOrganization({ partnerId: partnerA.id });
      const foreignKey = uniqueKey('foreign_partner_wide');
      await seedDefinition({ partnerId: partnerB.id, fieldKey: foreignKey });

      const rows = await withDbAccessContext(orgContext(orgA.id, partnerA.id), () =>
        db.select({ id: customFieldDefinitions.id })
          .from(customFieldDefinitions)
          .where(eq(customFieldDefinitions.fieldKey, foreignKey)),
      );

      expect(rows).toHaveLength(0);
    });

    /**
     * The `=` vs `IS NOT DISTINCT FROM` choice in the policy, pinned. A caller
     * that sets NO partner GUC gets a NULL from breeze_current_partner_id(), and
     * `partner_id = NULL` is NULL — never true. Had the predicate used
     * IS NOT DISTINCT FROM, this caller would match every partner-wide row of
     * every partner, which is the cross-tenant version of the same bug.
     * The org-owned row is the positive control.
     */
    it('shows no partner-wide row to a session with NO partner GUC set (#4944)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const partnerKey = uniqueKey('null_guc_partner_wide');
      const orgKey = uniqueKey('null_guc_own_org');
      await seedDefinition({ partnerId: partner.id, fieldKey: partnerKey });
      await seedDefinition({ orgId: org.id, fieldKey: orgKey });

      const rows = await withDbAccessContext(orgContext(org.id, null), () =>
        db.select({ fieldKey: customFieldDefinitions.fieldKey })
          .from(customFieldDefinitions)
          .where(inArray(customFieldDefinitions.fieldKey, [partnerKey, orgKey])),
      );

      expect(rows.map((r) => r.fieldKey)).toEqual([orgKey]);
    });

    /**
     * The DEVICE-TOKEN widening, asserted positively rather than assumed away.
     * `middleware/agentAuth.ts` sets `currentPartnerId: device.partnerId`
     * (#4673 W02), so an agent session DOES satisfy this branch and can now read
     * its own MSP's partner-wide definitions. That is deliberate — the same
     * widening every other Wave-1 branch took — and pinning it here means a
     * future author who narrows the GUC on the agent path (which would silently
     * stop partner-wide definitions from reaching devices, with no error) gets a
     * red here rather than a support ticket. The write half is covered by
     * 'an AGENT token cannot write a partner-wide row' below.
     */
    it('lets an AGENT (device-token) session read its own partner\u2019s partner-wide rows (#4944)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const partnerKey = uniqueKey('agent_partner_wide');
      const orgKey = uniqueKey('agent_own_org');
      await seedDefinition({ partnerId: partner.id, fieldKey: partnerKey });
      await seedDefinition({ orgId: org.id, fieldKey: orgKey });

      const rows = await withDbAccessContext(agentContext(org.id, partner.id), () =>
        db.select({ fieldKey: customFieldDefinitions.fieldKey })
          .from(customFieldDefinitions)
          .where(inArray(customFieldDefinitions.fieldKey, [partnerKey, orgKey])),
      );

      expect(rows.map((r) => r.fieldKey).sort()).toEqual([orgKey, partnerKey].sort());
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

    /**
     * The #4944 read branch must NOT become a write branch. It is FOR SELECT
     * only, and Postgres never consults a FOR SELECT policy when computing
     * UPDATE/DELETE target rows — so the shipped `breeze_dual_axis_update` /
     * `_delete` (which need breeze_has_partner_access, false for an org token)
     * still hide the row from the write command.
     *
     * RLS filters silently here: the statement succeeds affecting ZERO rows
     * rather than raising, so 'it did not throw' would be satisfied by a
     * successful hijack. The row COUNT plus a system-scope re-read of the value
     * is what has teeth. Both the user-token and device-token org shapes are
     * driven, because it is the device path that this branch newly reaches.
     */
    it.each([
      ['ORG token', (orgId: string, partnerId: string) => orgContext(orgId, partnerId)],
      ['AGENT token', (orgId: string, partnerId: string) => agentContext(orgId, partnerId)],
    ])('an %s can read but cannot UPDATE or DELETE its own partner\u2019s partner-wide definition (#4944)',
      async (_label, makeContext) => {
        const partner = await createPartner();
        const org = await createOrganization({ partnerId: partner.id });
        const fieldKey = uniqueKey('read_only_partner_wide');
        await seedDefinition({ partnerId: partner.id, fieldKey });
        const ctx = makeContext(org.id, partner.id);

        // Positive control: the branch really does expose the row to this
        // context, so the zero-row write results below cannot be explained by
        // the row simply being invisible for an unrelated reason.
        const visible = await withDbAccessContext(ctx, () =>
          db.select({ id: customFieldDefinitions.id })
            .from(customFieldDefinitions)
            .where(eq(customFieldDefinitions.fieldKey, fieldKey)),
        );
        expect(visible).toHaveLength(1);

        const updated = await withDbAccessContext(ctx, () =>
          db.update(customFieldDefinitions)
            .set({ name: 'Hijacked' })
            .where(eq(customFieldDefinitions.fieldKey, fieldKey))
            .returning({ id: customFieldDefinitions.id }),
        );
        expect(updated).toHaveLength(0);

        const afterUpdate = await withDbAccessContext(SYSTEM_CTX, () =>
          db.select({ name: customFieldDefinitions.name })
            .from(customFieldDefinitions)
            .where(eq(customFieldDefinitions.fieldKey, fieldKey)),
        );
        expect(afterUpdate[0]?.name).toBe(BASE.name);

        const deleted = await withDbAccessContext(ctx, () =>
          db.delete(customFieldDefinitions)
            .where(eq(customFieldDefinitions.fieldKey, fieldKey))
            .returning({ id: customFieldDefinitions.id }),
        );
        expect(deleted).toHaveLength(0);

        const survivors = await withDbAccessContext(SYSTEM_CTX, () =>
          db.select({ id: customFieldDefinitions.id })
            .from(customFieldDefinitions)
            .where(eq(customFieldDefinitions.fieldKey, fieldKey)),
        );
        expect(survivors).toHaveLength(1);
      });

    /**
     * INSERT is the one write command that DOES raise: WITH CHECK is evaluated
     * on the proposed row, and no FOR SELECT policy contributes a WITH CHECK, so
     * `breeze_dual_axis_insert` alone decides and denies with 42501. Proving the
     * loud half separately from the silent half above keeps a future edit that
     * turned the branch into FOR ALL from going green on either.
     */
    it('an ORG token cannot INSERT a partner-wide definition for its own partner (42501) (#4944)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const fieldKey = uniqueKey('forged_partner_wide');
      createdKeys.push(fieldKey);

      await expectSqlState(
        () => withDbAccessContext(orgContext(org.id, partner.id), () =>
          db.insert(customFieldDefinitions).values({
            ...BASE,
            orgId: null,
            partnerId: partner.id,
            fieldKey,
          }).returning({ id: customFieldDefinitions.id }),
        ),
        '42501',
      );
    });
  });
});
