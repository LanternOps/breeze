import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { cascadeDeletePartner } from '../../services/tenantCascade';

const partnerA = randomUUID();
const partnerB = randomUUID();
const orgA = randomUUID();
const orgASuspended = randomUUID();
const profileA = randomUUID();
const profileB = randomUUID();
const workTypeA = randomUUID();
const workTypeB = randomUUID();

function partnerContext(partnerId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [orgA], accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null };
}

const orgContext: DbAccessContext = {
  scope: 'organization', orgId: orgA, accessibleOrgIds: [orgA],
  accessiblePartnerIds: [], currentPartnerId: partnerA, userId: null,
};

describe('billing profile tables — partner-axis RLS', () => {
  // Shared setup truncates partners before each test, so every case reseeds.
  beforeEach(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code) VALUES
        (${partnerA}, 'Billing A', ${`bp-a-${partnerA}`}, 'USD'),
        (${partnerB}, 'Billing B', ${`bp-b-${partnerB}`}, 'USD')`);
      await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, status, currency_code) VALUES
        (${orgA}, ${partnerA}, 'Active', ${`bp-active-${orgA}`}, 'active', 'USD'),
        (${orgASuspended}, ${partnerA}, 'Suspended', ${`bp-suspended-${orgASuspended}`}, 'suspended', 'USD')`);
      await db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES
        (${workTypeA}, ${partnerA}, 'Remote'), (${workTypeB}, ${partnerB}, 'Remote')`);
      await db.execute(sql`INSERT INTO billing_profiles (id, partner_id, name, currency_code, base_coverage, is_default) VALUES
        (${profileA}, ${partnerA}, 'Standard', 'USD', 'billable', true),
        (${profileB}, ${partnerB}, 'Standard', 'USD', 'billable', true)`);
      await db.execute(sql`INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage)
        VALUES (${partnerA}, ${profileA}, ${workTypeA}, 'billable')`);
      await db.execute(sql`INSERT INTO org_billing_profile_assignments (org_id, partner_id, billing_profile_id) VALUES
        (${orgA}, ${partnerA}, ${profileA}), (${orgASuspended}, ${partnerA}, ${profileA})`);
    });
  });

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM org_billing_profile_assignments WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM billing_profile_rules WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM billing_profiles WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM work_types WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM organizations WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`);
    });
  });

  it('all three tables ENABLE and FORCE RLS', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('billing_profiles', 'billing_profile_rules', 'org_billing_profile_assignments')`));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it.each(['profile', 'rule', 'assignment'])('partner B cannot forge partner A %s (42501)', async (kind) => {
    const statement = kind === 'profile'
      ? sql`INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage) VALUES (${partnerA}, 'Forged', 'USD', 'billable')`
      : kind === 'rule'
        ? sql`INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage) VALUES (${partnerA}, ${profileA}, ${workTypeA}, 'billable')`
        : sql`INSERT INTO org_billing_profile_assignments (org_id, partner_id, billing_profile_id) VALUES (${orgA}, ${partnerA}, ${profileA})`;
    await expect(withDbAccessContext(partnerContext(partnerB), () => db.execute(statement)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each([
    ['billing_profile_rules_work_type_partner_fk', () => sql`INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage) VALUES (${partnerA}, ${profileA}, ${workTypeB}, 'billable')`],
    ['billing_profile_rules_profile_partner_fk', () => sql`INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage) VALUES (${partnerA}, ${profileB}, ${workTypeA}, 'billable')`],
    ['org_billing_profile_assignments_profile_partner_fk', () => sql`UPDATE org_billing_profile_assignments SET billing_profile_id = ${profileB} WHERE org_id = ${orgA}`],
    ['org_billing_profile_assignments_org_partner_fk', () => sql`UPDATE org_billing_profile_assignments SET partner_id = ${partnerB}, billing_profile_id = ${profileB} WHERE org_id = ${orgA}`],
  ] as const)('enforces same-partner references through %s', async (constraint, statement) => {
    await expect(withSystemDbAccessContext(() => db.execute(statement())))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: constraint } });
  });

  it.each(['included', 'non_billable'])('%s rows cannot carry rates or minimums', async (coverage) => {
    for (const statement of [
      sql`UPDATE billing_profile_rules SET coverage = ${coverage}, hourly_rate = 100 WHERE billing_profile_id = ${profileA}`,
      sql`UPDATE billing_profile_rules SET coverage = ${coverage}, minimum_minutes = 30 WHERE billing_profile_id = ${profileA}`,
      sql`UPDATE billing_profiles SET base_coverage = ${coverage}, base_hourly_rate = 100 WHERE id = ${profileA}`,
      sql`UPDATE billing_profiles SET base_coverage = ${coverage}, base_minimum_minutes = 30 WHERE id = ${profileA}`,
    ]) {
      await expect(withSystemDbAccessContext(() => db.execute(statement)))
        .rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });

  it('allows only one active default per partner and currency', async () => {
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage, is_default)
      VALUES (${partnerA}, 'Second default', 'USD', 'billable', true)`)))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'billing_profiles_default_per_currency_uniq' } });
  });

  it('org-scoped tokens can neither read nor write assignments', async () => {
    const rows = await withDbAccessContext(orgContext, () => db.execute(sql`SELECT id FROM org_billing_profile_assignments WHERE org_id = ${orgA}`));
    expect(rows).toHaveLength(0);
    await expect(withDbAccessContext(orgContext, () => db.execute(sql`
      INSERT INTO org_billing_profile_assignments (org_id, partner_id, billing_profile_id) VALUES (${orgA}, ${partnerA}, ${profileA})`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('keeps suspended org assignments visible to their partner, but not other partners', async () => {
    const statement = sql`SELECT id FROM org_billing_profile_assignments WHERE org_id = ${orgASuspended}`;
    expect(await withSystemDbAccessContext(() => db.execute(statement))).toHaveLength(1);
    expect(await withDbAccessContext(partnerContext(partnerA), () => db.execute(statement))).toHaveLength(1);
    expect(await withDbAccessContext(partnerContext(partnerB), () => db.execute(statement))).toHaveLength(0);
  });

  it('org/partner FK is DEFERRABLE INITIALLY IMMEDIATE for org merge', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT condeferrable, condeferred FROM pg_constraint
      WHERE conname = 'org_billing_profile_assignments_org_partner_fk'`));
    expect(rows[0]).toEqual({ condeferrable: true, condeferred: false });
  });

  // PARTNER ERASURE (plan Task 15 Step 2). The three tables are reached by
  // cascadeDeletePartner's information_schema `partner_id` sweep, ordered by
  // topologicalCascadeOrder's pg_constraint read -- no static list registers
  // them. time_entries.billing_profile_id is a NO ACTION composite FK, so if
  // billing_profiles were swept before time_entries the purge would abort with
  // 23503 and the partner would be left half-erased. Only a live run proves it.
  it('cascadeDeletePartner erases a partner with a stamped time entry, rules and an org assignment', async () => {
    const user = randomUUID();
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO users (id, partner_id, email, name)
        VALUES (${user}, ${partnerA}, ${`bp-erasure-${user}@example.test`}, 'Erasure user')`);
      await db.execute(sql`INSERT INTO time_entries (partner_id, org_id, user_id, started_at, work_type_id, billing_profile_id, coverage, is_billable, currency_code)
        VALUES (${partnerA}, ${orgA}, ${user}, now(), ${workTypeA}, ${profileA}, 'billable', true, 'USD')`);
    });

    // CONTROL: the referencing rows exist, so a clean purge is evidence about
    // these FK edges and not about an empty partner.
    const before = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT
        (SELECT count(*) FROM time_entries WHERE billing_profile_id = ${profileA}) AS entries,
        (SELECT count(*) FROM billing_profile_rules WHERE partner_id = ${partnerA}) AS rules,
        (SELECT count(*) FROM org_billing_profile_assignments WHERE partner_id = ${partnerA}) AS assignments
    `))) as unknown as Array<{ entries: string; rules: string; assignments: string }>;
    expect(before[0]).toEqual({ entries: '1', rules: '1', assignments: '2' });

    await expect(cascadeDeletePartner(partnerA, randomUUID())).resolves.toBeDefined();

    const after = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT
        (SELECT count(*) FROM billing_profiles WHERE partner_id = ${partnerA}) AS profiles,
        (SELECT count(*) FROM billing_profile_rules WHERE partner_id = ${partnerA}) AS rules,
        (SELECT count(*) FROM org_billing_profile_assignments WHERE partner_id = ${partnerA}) AS assignments,
        (SELECT count(*) FROM time_entries WHERE partner_id = ${partnerA}) AS entries
    `))) as unknown as Array<{ profiles: string; rules: string; assignments: string; entries: string }>;
    expect(after[0]).toEqual({ profiles: '0', rules: '0', assignments: '0', entries: '0' });
  });
});
