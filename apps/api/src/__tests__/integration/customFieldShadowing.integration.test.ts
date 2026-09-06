/**
 * Cross-axis `field_key` shadowing — #3257 W03.
 *
 * Migration under test:
 * `2026-10-11-140000-custom-field-no-cross-axis-shadowing.sql`.
 *
 * THE RULE. One EFFECTIVE `field_key` namespace per device. `devices.custom_fields`
 * is a flat jsonb object keyed by a bare string, so if an org-owned `udf7` and a
 * partner-wide `udf7` can both exist for one org, that one datum has two
 * definitions: the partner export emits two records for it (the identity hash
 * includes `f.id` — routes/partnerApi/configuration.ts:436,439), W05's
 * `device_custom_field_values` cannot project back into the jsonb without loss,
 * and W05's backfill cannot attribute an existing blob value to either one.
 *
 * WHY A TRIGGER. Uniqueness here spans two NULLABLE ownership columns over
 * DISJOINT row sets, and the partner half of the pair is not even on the
 * org-owned row — it is reached through `organizations.partner_id`. No index can
 * express that, which is why W02 shipped two PARTIAL unique indexes and left
 * this case open (pinned there as a passing boundary case,
 * `customFieldDefinitionIntegrity.integration.test.ts`).
 *
 * WHY BOTH SCOPES ARE EXERCISED. The tenant-scope tests prove the guard holds
 * for the callers that actually create this collision — POST /custom-fields pins
 * `orgId = auth.orgId` for every org-scoped caller, so an org token creating an
 * org-owned key is by far the most common way to shadow a partner-wide one. They
 * also pin that RLS remains the stricter outer wall (42501 on a forged
 * partner-wide row) and that the trigger's scope elevation does not leak into the
 * caller's transaction.
 *
 * WHAT THE TENANT-SCOPE TESTS DO **NOT** PROVE, and the trap that is worth your
 * time before you "simplify" the migration. The function is SECURITY DEFINER, so
 * its lookups run as its OWNER — the role that applied the migration. On this
 * stack and in CI that role is a SUPERUSER with BYPASSRLS (`breeze_test`:
 * rolsuper=t, rolbypassrls=t), which ignores RLS outright. So every behavioural
 * test in this file passes IDENTICALLY with or without
 * `SET "breeze.scope" = 'system'` on the function header — measured, not assumed:
 * after `ALTER FUNCTION … RESET "breeze.scope"` the four tenant-scope tests below
 * still went 4/4 green.
 *
 * In PRODUCTION the owner is `doadmin` on managed DO Postgres, which is NOT a
 * superuser and IS bound by `FORCE ROW LEVEL SECURITY`. A/B on this same
 * database with an otherwise identical pair of SECURITY DEFINER lookups
 * reassigned to the non-superuser `breeze_app`, called under an org-scoped
 * context, gave: unelevated → row NOT found; elevated → row found. That is the
 * whole bug the `SET` prevents, and it is invisible to every behavioural test
 * here. This is the same CI-superuser blind spot that `migrationRlsScope.test.ts`
 * exists for.
 *
 * Hence `pins the function-level scope elevation on the trigger function` below
 * asserts `pg_proc.proconfig` from the CATALOG rather than through behaviour. It
 * is not belt-and-braces; on this stack it is the ONLY assertion in the file that
 * can fail when the elevation is removed. Do not delete it as redundant.
 *
 * ORDERING NOTE. W02's XOR is a CHECK constraint, so under a tenant context RLS
 * `WITH CHECK` rejects the row with 42501 *before* the constraint is evaluated
 * (asserted in `customFieldDefinitionsPartnerRls.integration.test.ts`). This
 * guard is a BEFORE ROW trigger, which `ExecInsert` runs *ahead* of both
 * `ExecWithCheckOptions` and `ExecConstraints` — so it surfaces as P0001 even
 * under a tenant context. The two behaviours are asserted separately below
 * (`refuses ... under the caller's own org scope` vs. `an org token still cannot
 * forge a partner-wide row`) so neither can be mistaken for the other.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import { pgErrorCode, pgErrorNode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-11-140000-custom-field-no-cross-axis-shadowing.sql',
);

/**
 * Replay the real migration by path (the repo's established shape — see
 * `customFieldDefinitionIntegrity.integration.test.ts`). `autoMigrate.test.ts`
 * asserts every such reference resolves, so a rename of the migration turns into
 * a unit-job failure rather than an ENOENT minutes into Integration Tests.
 *
 * Runs as the privileged test role, mirroring how migrations actually run.
 */
async function replayMigration(): Promise<void> {
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
}

/** Disarm the guard so dirty rows can be forged, as a pre-migration prod's would be. */
async function dropShadowTrigger(): Promise<void> {
  await getTestDb().execute(sql`
    DROP TRIGGER IF EXISTS custom_field_definitions_no_shadow
      ON public.custom_field_definitions`);
}

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const sys = <T>(fn: () => Promise<T>): Promise<T> => withDbAccessContext(SYSTEM_CTX, fn);

/** A partner-scoped session: passes `breeze_has_partner_access` for its own partner. */
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
 * partnerId for org scope too (`buildDbAccessContext`), so it is set here
 * deliberately: leaving it null would let the org-scoped tests pass for the
 * wrong reason once #4944 adds a partner-wide SELECT branch keyed on it.
 * `accessiblePartnerIds` stays empty — an org token never passes
 * `breeze_has_partner_access`.
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

const createdKeys: string[] = [];

/** Insert a definition through the app role (`breeze_app`) under `ctx`. */
function insertDefinition(
  values: { orgId?: string | null; partnerId?: string | null; name: string; fieldKey: string },
  ctx: DbAccessContext = SYSTEM_CTX,
): Promise<unknown> {
  createdKeys.push(values.fieldKey);
  return withDbAccessContext(ctx, () => db.execute(sql`
    INSERT INTO custom_field_definitions (org_id, partner_id, name, field_key, type)
    VALUES (
      ${values.orgId ?? null}::uuid,
      ${values.partnerId ?? null}::uuid,
      ${values.name},
      ${values.fieldKey},
      'text'
    )`));
}

afterEach(async () => {
  if (createdKeys.length === 0) return;
  const keys = [...new Set(createdKeys)];
  createdKeys.length = 0;
  // `inArray`, not a raw `= ANY(${keys}::text[])` — drizzle's `sql` tag expands
  // an interpolated JS array into separate bound parameters, so the cast fails.
  // (Same trap documented at length in customFieldDefinitionIntegrity.)
  await sys(() => db.delete(customFieldDefinitions).where(
    inArray(customFieldDefinitions.fieldKey, keys),
  ));
});

/**
 * Assert a write failed with a specific SQLSTATE.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose `.message` is only
 * "Failed query: …", so a regex on the message matches nothing useful — the real
 * postgres.js error (carrying `.code`) hangs off `.cause`, which `pgErrorCode`
 * walks. Asserting the code is also strictly stronger than a message match here:
 * P0001 (this trigger), 23505 (W02's unique indexes), 23514 (W02's XOR CHECK)
 * and 42501 (RLS denial) are four different guarantees on this one table, and a
 * message regex would happily accept any of them — which is exactly how a test
 * meant to prove the trigger ends up silently proving only that RLS said no.
 */
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

/**
 * The Postgres error MESSAGE for a failed write, unwrapped.
 *
 * `expect(...).rejects.toThrow(/…/)` matches the OUTER `DrizzleQueryError`,
 * whose message is only "Failed query: INSERT INTO … params: …" — the trigger's
 * own text lives on `.cause`. A regex assertion written the obvious way
 * therefore fails against a perfectly good message (observed here on the first
 * green run), and the tempting "fix" of loosening the regex until it passes
 * would leave it matching the interpolated params instead of the copy under
 * test. `pgErrorNode` walks to the node that actually carries the SQLSTATE, so
 * `code` and `message` are read off the SAME node.
 */
async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, 'expected the statement to fail').toBeDefined();
  const node = pgErrorNode(raised);
  expect(node?.code, 'expected a Postgres error carrying a SQLSTATE').toBe('P0001');
  return String(node?.message ?? '');
}

/** Count definitions carrying `fieldKey`, read under system scope. */
async function countByKey(fieldKey: string): Promise<number> {
  const rows = await sys(() => db.execute(sql`
    SELECT id FROM custom_field_definitions WHERE field_key = ${fieldKey}`));
  return (rows as unknown as unknown[]).length;
}

describe('cross-axis field_key shadowing (#3257 W03)', () => {
  describe('under system scope', () => {
    it('refuses an org-owned key that shadows a partner-wide key visible to that org', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ partnerId: partner.id, name: 'UDF 7', fieldKey: 'shadow_udf7' });

      await expectSqlState(
        () => insertDefinition({ orgId: org.id, name: 'Local UDF 7', fieldKey: 'shadow_udf7' }),
        'P0001',
      );
      expect(await countByKey('shadow_udf7')).toBe(1);
    });

    it('refuses a partner-wide key that shadows an existing org-owned key under that partner', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ orgId: org.id, name: 'Asset Tag', fieldKey: 'shadow_asset_tag' });

      await expectSqlState(
        () => insertDefinition({
          partnerId: partner.id, name: 'Asset Tag', fieldKey: 'shadow_asset_tag',
        }),
        'P0001',
      );
      expect(await countByKey('shadow_asset_tag')).toBe(1);
    });

    /**
     * The error text is the whole remediation UI for this refusal — the operator
     * has to learn WHICH key collided and WHICH axis already owns it, because the
     * two fixes are different (rename yours, or ask the partner to drop theirs).
     * A generic "constraint violated" would be useless, and W03's route mapper
     * hands this string straight to the client as the 409 body.
     */
    it('names the key and the colliding axis in each direction', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ partnerId: partner.id, name: 'UDF 8', fieldKey: 'shadow_msg_a' });
      expect(
        await messageOf(() => insertDefinition({ orgId: org.id, name: 'UDF 8', fieldKey: 'shadow_msg_a' })),
      ).toMatch(/"shadow_msg_a" already exists as an all-organizations field for this partner/);

      await insertDefinition({ orgId: org.id, name: 'Rack', fieldKey: 'shadow_msg_b' });
      expect(
        await messageOf(() => insertDefinition({
          partnerId: partner.id, name: 'Rack', fieldKey: 'shadow_msg_b',
        })),
      ).toMatch(/"shadow_msg_b" is already defined by at least one organization under this partner/);
    });

    /**
     * The guard must not leak the other definition's identity. An org-scoped
     * caller cannot otherwise see partner-wide rows on this table (#4944), so a
     * message carrying the partner definition's uuid or name would turn the
     * trigger into an enumeration oracle for partner-wide configuration.
     */
    it('does not disclose the conflicting definition id or name', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const seeded = await sys(() => db.insert(customFieldDefinitions).values({
        partnerId: partner.id,
        name: 'Secret Partner Field Name',
        fieldKey: 'shadow_oracle',
        type: 'text',
      }).returning());
      createdKeys.push('shadow_oracle');
      const hiddenId = (seeded as { id: string }[])[0]!.id;

      const message = await messageOf(
        () => insertDefinition({ orgId: org.id, name: 'Mine', fieldKey: 'shadow_oracle' }),
      );

      // POSITIVE CONTROL FIRST — do not remove. A bare pair of `not.toContain`
      // assertions passes trivially against an empty string, and an earlier
      // draft of this test read the message with `JSON.stringify(raised)`,
      // which yields exactly that: postgres.js sets `.message` through
      // `Error`'s constructor, so it stays NON-ENUMERABLE even after the
      // `Object.assign`, and drizzle's wrapper serializes to
      // `{"query":…,"params":…,"cause":{"code":"P0001","severity":…}}` with no
      // message at all. The test passed while proving nothing — it would have
      // stayed green if the trigger were changed to embed the conflicting
      // definition's id and name directly. Asserting the message is non-empty
      // and DOES name the key is what makes the two negatives meaningful.
      expect(message).toContain('shadow_oracle');

      expect(message).not.toContain(hiddenId);
      expect(message).not.toContain('Secret Partner Field Name');
    });

    /**
     * The rule is per-PARTNER. Two different MSPs must both be able to define
     * `site_code` partner-wide; a guard that keyed on `field_key` alone would
     * break every partner after the first.
     */
    it('allows the same key under two DIFFERENT partners', async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();

      await insertDefinition({ partnerId: partnerA.id, name: 'Site Code', fieldKey: 'shadow_site_code' });
      await insertDefinition({ partnerId: partnerB.id, name: 'Site Code', fieldKey: 'shadow_site_code' });

      expect(await countByKey('shadow_site_code')).toBe(2);
    });

    /**
     * Same-axis co-existence stays legal: two customers of one MSP may both
     * define `rack` locally. Only CROSS-axis collisions create the one-datum /
     * two-definitions problem, because only a partner-wide row is visible to a
     * device that already has an org-owned row for the same key.
     */
    it('allows the same org-owned key in two orgs under one partner', async () => {
      const partner = await createPartner();
      const orgOne = await createOrganization({ partnerId: partner.id });
      const orgTwo = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ orgId: orgOne.id, name: 'Rack', fieldKey: 'shadow_rack' });
      await insertDefinition({ orgId: orgTwo.id, name: 'Rack', fieldKey: 'shadow_rack' });

      expect(await countByKey('shadow_rack')).toBe(2);
    });

    /**
     * The trigger's one early exit: if `NEW.org_id` resolves to no organization,
     * `owner_partner` is NULL and there is no partner namespace to check. The
     * row is doomed anyway — `org_id` carries an FK, and FK checks are AFTER-row
     * triggers, so they run once this BEFORE-row trigger returns.
     *
     * This pins the SQLSTATE rather than just "it failed", because the two
     * outcomes are meaningfully different to whoever reads the error: 23503
     * ("no such organization") is the truth, where a P0001 would tell them their
     * field key collides with a partner-wide field that does not exist. A future
     * "simplification" that raised P0001 whenever the partner could not be
     * resolved would pass a bare `rejects.toThrow()` and fail this.
     */
    it('defers a nonexistent org_id to the foreign key (23503), not a bogus shadowing error', async () => {
      await expectSqlState(
        () => insertDefinition({
          orgId: '99999999-9999-9999-9999-999999999999',
          name: 'Bogus',
          fieldKey: 'shadow_missing_org',
        }),
        '23503',
      );
    });

    /**
     * An org-owned key under partner A must not be blocked by a partner-wide key
     * belonging to partner B. This is the test that fails if the trigger ever
     * drops the `partner_id = owner_partner` predicate and starts checking the
     * whole table.
     */
    it('does not block an org whose partner has no such key', async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const orgUnderA = await createOrganization({ partnerId: partnerA.id });

      await insertDefinition({ partnerId: partnerB.id, name: 'Foreign', fieldKey: 'shadow_foreign' });
      await insertDefinition({ orgId: orgUnderA.id, name: 'Mine', fieldKey: 'shadow_foreign' });

      expect(await countByKey('shadow_foreign')).toBe(2);
    });
  });

  describe('on UPDATE, not just INSERT', () => {
    /**
     * A row that starts legitimately non-colliding and is then RENAMED onto a
     * partner-wide key creates exactly the same one-datum / two-definitions
     * state. INSERT-only enforcement would leave the front door locked and the
     * back door open — and a rename is how an importer's "map this incumbent
     * field onto that Breeze key" step would land.
     */
    it('refuses renaming an org-owned key onto a partner-wide one', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ partnerId: partner.id, name: 'UDF 9', fieldKey: 'shadow_rename_target' });
      await insertDefinition({ orgId: org.id, name: 'Local', fieldKey: 'shadow_rename_source' });

      await expectSqlState(
        () => sys(() => db.execute(sql`
          UPDATE custom_field_definitions
             SET field_key = 'shadow_rename_target'
           WHERE field_key = 'shadow_rename_source'`)),
        'P0001',
      );
      expect(await countByKey('shadow_rename_source')).toBe(1);
    });

    /**
     * Re-pointing an org-owned definition at an org under a DIFFERENT partner
     * moves it into that partner's namespace, so the check must re-run against
     * the NEW owner — not the old one. `org_id` is in the trigger's UPDATE OF
     * column list precisely for this.
     */
    it('re-evaluates against the NEW org when org_id moves between partners', async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const orgUnderA = await createOrganization({ partnerId: partnerA.id });
      const orgUnderB = await createOrganization({ partnerId: partnerB.id });

      await insertDefinition({ partnerId: partnerB.id, name: 'B-wide', fieldKey: 'shadow_move' });
      await insertDefinition({ orgId: orgUnderA.id, name: 'A-local', fieldKey: 'shadow_move' });

      await expectSqlState(
        () => sys(() => db.execute(sql`
          UPDATE custom_field_definitions
             SET org_id = ${orgUnderB.id}::uuid
           WHERE field_key = 'shadow_move' AND org_id = ${orgUnderA.id}::uuid`)),
        'P0001',
      );
    });

    /**
     * The mirror of the rename above, on the OTHER branch. `partner_id` and
     * `field_key` are both in the trigger's `UPDATE OF` list, but until this
     * test the `ELSIF NEW.partner_id IS NOT NULL` arm was only ever reached by
     * INSERT — an UPDATE-shaped regression in that arm (e.g. a future
     * `TG_OP = 'INSERT'` guard added to it) would have gone unnoticed.
     */
    it('refuses renaming a partner-wide key onto one an org already owns', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ orgId: org.id, name: 'Rack', fieldKey: 'shadow_pw_rename_target' });
      await insertDefinition({
        partnerId: partner.id, name: 'Elsewhere', fieldKey: 'shadow_pw_rename_source',
      });

      await expectSqlState(
        () => sys(() => db.execute(sql`
          UPDATE custom_field_definitions
             SET field_key = 'shadow_pw_rename_target'
           WHERE field_key = 'shadow_pw_rename_source'`)),
        'P0001',
      );
      expect(await countByKey('shadow_pw_rename_source')).toBe(1);
      expect(await countByKey('shadow_pw_rename_target')).toBe(1);
    });

    /**
     * Touching a column outside the trigger's UPDATE OF list must not fire it —
     * otherwise every rename of a `name` on a legacy shadowed pair would start
     * failing, and reconciling that pair by editing it would become impossible.
     */
    it('leaves an unrelated column update alone', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      await insertDefinition({ orgId: org.id, name: 'Before', fieldKey: 'shadow_untouched' });

      await sys(() => db.execute(sql`
        UPDATE custom_field_definitions SET name = 'After'
         WHERE field_key = 'shadow_untouched'`));

      const rows = await sys(() => db.execute(sql`
        SELECT name FROM custom_field_definitions WHERE field_key = 'shadow_untouched'`));
      expect((rows as unknown as { name: string }[])[0]?.name).toBe('After');
    });
  });

  /**
   * The guard under the callers that actually create this collision.
   *
   * Everything above runs at system scope. These run as `breeze_app` under a
   * real org- or partner-scoped context, which is what the API does — and the
   * first test's caller is exactly the shape POST /custom-fields produces for
   * every org-scoped tech (`orgId = auth.orgId`).
   *
   * READ THE FILE HEADER before concluding these prove the scope elevation.
   * They do not, on this stack: the function is SECURITY DEFINER owned by the
   * migration role, which is a BYPASSRLS superuser locally and in CI, so these
   * four tests measured 4/4 green with the elevation stripped. The catalog
   * assertion further down is what covers it.
   */
  describe('under a tenant RLS context', () => {
    it("refuses a shadowing insert under the caller's own org scope, even though an org token cannot see the partner-wide row", async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ partnerId: partner.id, name: 'UDF 7', fieldKey: 'shadow_tenant_udf7' });

      // Control: prove the caller really is blind to the row the trigger found,
      // so the refusal below cannot be explained by ordinary visibility.
      const visible = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.execute(sql`
          SELECT id FROM custom_field_definitions WHERE field_key = 'shadow_tenant_udf7'`));
      expect(
        (visible as unknown as unknown[]).length,
        'org token must NOT see partner-wide rows on this table (#4944) — if it can, this test no longer proves the scope elevation',
      ).toBe(0);

      await expectSqlState(
        () => insertDefinition(
          { orgId: org.id, name: 'Local UDF 7', fieldKey: 'shadow_tenant_udf7' },
          orgContext(org.id, partner.id),
        ),
        'P0001',
      );
      expect(await countByKey('shadow_tenant_udf7')).toBe(1);
    });

    /**
     * The partner branch has the mirror-image blind spot: a partner-wide insert
     * must consider org-owned rows in EVERY org under the partner, including orgs
     * the caller's own token does not carry in `accessible_org_ids` (a
     * partner-admin session scoped down to a subset, or simply a stale list).
     */
    it('refuses a partner-wide insert colliding with an org the caller cannot see', async () => {
      const partner = await createPartner();
      const visibleOrg = await createOrganization({ partnerId: partner.id });
      const hiddenOrg = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ orgId: hiddenOrg.id, name: 'Rack', fieldKey: 'shadow_hidden_org' });

      // Deliberately omit hiddenOrg from accessibleOrgIds.
      const ctx = partnerContext(partner.id, [visibleOrg.id]);
      const visible = await withDbAccessContext(ctx, () => db.execute(sql`
        SELECT id FROM custom_field_definitions WHERE field_key = 'shadow_hidden_org'`));
      expect(
        (visible as unknown as unknown[]).length,
        'the caller must not be able to see the hidden org row through its own context',
      ).toBe(0);

      await expectSqlState(
        () => insertDefinition(
          { partnerId: partner.id, name: 'Rack', fieldKey: 'shadow_hidden_org' },
          ctx,
        ),
        'P0001',
      );
      expect(await countByKey('shadow_hidden_org')).toBe(1);
    });

    /**
     * RLS is still the outer wall and is still STRICTER than the trigger. An org
     * token forging a partner-wide row is refused by the dual-axis WITH CHECK
     * with 42501 — `breeze_has_partner_access` is false for org scope — and never
     * reaches a P0001. Asserting the CODE (not just "it threw") is what keeps
     * this from being confused with the trigger's own refusal.
     */
    it('an org token still cannot forge a partner-wide row (42501, not P0001)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await expectSqlState(
        () => insertDefinition(
          { partnerId: partner.id, name: 'Forged', fieldKey: 'shadow_forged' },
          orgContext(org.id, partner.id),
        ),
        '42501',
      );
      expect(await countByKey('shadow_forged')).toBe(0);
    });

    /**
     * The elevation is bounded to the trigger function. PostgreSQL saves a
     * function-level `SET` on entry and restores it on exit — including through
     * an error, because it unwinds with the GUC nest level. If it ever leaked,
     * the caller's remaining statements would run at system scope, which is a
     * far worse hole than the one being fixed. Read the GUC back through the
     * SAME pooled connection right after a successful trigger firing.
     */
    it('does not leak system scope into the calling transaction', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const observed = await withDbAccessContext(orgContext(org.id, partner.id), async () => {
        createdKeys.push('shadow_no_leak');
        await db.execute(sql`
          INSERT INTO custom_field_definitions (org_id, name, field_key, type)
          VALUES (${org.id}::uuid, 'Clean', 'shadow_no_leak', 'text')`);
        const rows = await db.execute(sql`SELECT public.breeze_current_scope() AS scope`);
        return (rows as unknown as { scope: string }[])[0]?.scope;
      });

      expect(observed).toBe('organization');
    });
  });

  /**
   * The migration's own abort path — the guard standing between a dirty prod
   * database and a deploy. Nothing else in this suite exercises it: by the time
   * any other test runs, autoMigrate has already applied the file once, cleanly.
   *
   * It matters because the failure is asymmetric. `RAISE WARNING` alone returns
   * SUCCESS and autoMigrate records the file as applied FOREVER (it wraps each
   * file in `client.begin`; only an exception rolls that back), leaving prod
   * permanently without the trigger while the ledger claims otherwise. So the
   * file WARNs the detail and then RAISEs, and that pairing is what these tests
   * pin — deleting either RAISE fails one of them.
   *
   * Each test restores the shipped state in `finally` by replaying the same
   * migration, which doubles as a live proof that re-application is a true no-op.
   */
  describe('deploy abort on pre-existing shadowed data', () => {
    it('aborts with P0001 and names the offending (partner, field_key) pairs', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      try {
        await dropShadowTrigger();
        await insertDefinition({ partnerId: partner.id, name: 'UDF 7', fieldKey: 'dirty_shadow' });
        await insertDefinition({ orgId: org.id, name: 'Local UDF 7', fieldKey: 'dirty_shadow' });

        let raised: unknown;
        try {
          await replayMigration();
        } catch (err) {
          raised = err;
        }

        expect(raised, 'the migration must ABORT, not warn and continue').toBeDefined();
        expect(pgErrorCode(raised)).toBe('P0001');

        // Read the message off the node carrying the SQLSTATE, NOT off
        // `JSON.stringify(raised)`. This replay passes the whole migration file
        // as the query text, and drizzle puts that text in the serialized
        // error's `query` field — so a `JSON.stringify` match for
        // "cross-axis shadowed key" succeeds against the migration's OWN SOURCE
        // (the string is right there in its RAISE), whether or not the
        // exception was ever raised. That is how the first draft of this test
        // passed while asserting nothing. `.message` is non-enumerable and
        // never appears in the serialized form at all.
        const message = String(pgErrorNode(raised)?.message ?? '');
        expect(message).toMatch(/cross-axis shadowed key/);
        // The operator must be able to act without running a second query.
        expect(message).toMatch(/reconcile them by hand before deploying/);
        // …and the count must be real, not the literal '%' placeholder.
        expect(message).toMatch(/has 1 cross-axis shadowed key/);
      } finally {
        await sys(() => db.delete(customFieldDefinitions).where(
          inArray(customFieldDefinitions.fieldKey, ['dirty_shadow']),
        ));
        await replayMigration();
      }
    });

    it('re-applies cleanly, leaving the trigger and its function in place', async () => {
      await replayMigration();

      const objects = await sys(() => db.execute(sql`
        SELECT tgname AS name FROM pg_trigger
         WHERE tgname = 'custom_field_definitions_no_shadow' AND NOT tgisinternal
        UNION ALL
        SELECT proname FROM pg_proc
         WHERE proname = 'breeze_custom_field_no_cross_axis_shadow'`));
      expect(objects).toHaveLength(2);
    });

    /**
     * THE ONLY ASSERTION IN THIS FILE THAT FAILS WHEN THE SCOPE ELEVATION IS
     * REMOVED. See the file header for the measurement: the function is SECURITY
     * DEFINER, its owner is the migration role, and that role is a BYPASSRLS
     * superuser locally and in CI — so no behavioural test here can see the
     * difference. In production the owner is `doadmin`, which is bound by FORCE
     * RLS, and an unelevated lookup silently finds nothing: the trigger stops
     * refusing anything, with no error and no failing test anywhere.
     *
     * That is why this reads `pg_proc` from the catalog instead. It is a
     * deliberate structural assertion standing in for a behavioural one that this
     * environment cannot express — the same reason `migrationRlsScope.test.ts`
     * greps migration text rather than running it. Deleting it as "redundant"
     * removes the last thing standing between prod and a decorative trigger.
     */
    it('pins the function-level scope elevation on the trigger function', async () => {
      const rows = await sys(() => db.execute(sql`
        SELECT proconfig, prosecdef FROM pg_proc
         WHERE proname = 'breeze_custom_field_no_cross_axis_shadow'`));
      const fn = (rows as unknown as { proconfig: string[] | null; prosecdef: boolean }[])[0];
      expect(fn?.prosecdef, 'the guard must be SECURITY DEFINER').toBe(true);
      expect(fn?.proconfig ?? []).toContain('breeze.scope=system');
      expect((fn?.proconfig ?? []).some((c) => c.startsWith('search_path='))).toBe(true);
    });
  });
});
