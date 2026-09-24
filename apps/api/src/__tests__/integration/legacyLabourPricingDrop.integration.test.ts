/**
 * #4628 W04b (wave #6335, gates from #6472): the migration that drops the six
 * legacy labour-pricing columns.
 *
 * Every case runs inside ONE postgres.js transaction that is rolled back: the
 * columns are restored (fixtures/legacyLabourPricingColumns.ts), legacy rows
 * are seeded, the migration file is executed exactly as autoMigrate would, and
 * the ROLLBACK leaves the live test schema as a fresh migrate produced it.
 *
 * What is proven:
 *  - archive-before-drop: every row still carrying legacy pricing lands in
 *    legacy_labour_pricing_archive with the right skip_reason, including the
 *    two populations the conversion skipped (#6472: off-list org currency;
 *    org rate in a currency other than the org's) — the legacy columns were
 *    their only copy;
 *  - the six columns are gone and a re-apply is a no-op;
 *  - the interlock refuses while any partner is unconverted;
 *  - the interlock's scope election is load-bearing: run as breeze_app (FORCE
 *    RLS applies; breeze_test is a superuser and bypasses RLS, so it cannot
 *    prove this), the block sees the unconverted partner — and with the
 *    election removed it does not (the fail-open the election closes);
 *  - a partial legacy column set (manual DDL) is refused, never half-archived;
 *  - the archive table is partner-axis: a partner sees only its own rows, an
 *    org token sees none, and a cross-partner forge is rejected (42501).
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { RESTORE_LEGACY_LABOUR_PRICING_COLUMNS_SQL } from './fixtures/legacyLabourPricingColumns';

const MIGRATION = '2026-10-29-100300-drop-legacy-labour-pricing-columns.sql';
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

type Tx = postgres.TransactionSql<Record<string, unknown>>;

class Rollback extends Error {
  constructor() { super('intentional rollback'); }
}

async function loadMigration(): Promise<string> {
  return readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
}

/** Runs `body` in a transaction that is always rolled back; collects NOTICE/WARNINGs. */
async function inRolledBackTx(body: (tx: Tx, notices: string[]) => Promise<void>): Promise<void> {
  const notices: string[] = [];
  const client = postgres(DATABASE_URL, { max: 1, onnotice: (n) => { notices.push(n.message ?? ''); } });
  try {
    await client.begin(async (tx) => {
      await body(tx as unknown as Tx, notices);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function legacyColumnCount(tx: Tx): Promise<number> {
  const [row] = await tx`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('ticket_categories', 'org_ticket_settings')
      AND column_name IN ('default_billable', 'default_hourly_rate', 'rate_currency')`;
  return row!.n as number;
}

async function insertPartner(tx: Tx, converted: boolean): Promise<string> {
  const id = randomUUID();
  await tx`INSERT INTO partners (id, name, slug, currency_code, labour_pricing_converted_at)
    VALUES (${id}, ${`W04b partner ${id}`}, ${`w04b-${id}`}, 'USD', ${converted ? new Date() : null})`;
  return id;
}

describe('drop legacy labour-pricing columns (#4628 W04b)', () => {
  it('archives every legacy pricing row with its skip reason, then drops the six columns', async () => {
    const migration = await loadMigration();
    await inRolledBackTx(async (tx, notices) => {
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      await tx.unsafe(RESTORE_LEGACY_LABOUR_PRICING_COLUMNS_SQL);
      expect(await legacyColumnCount(tx)).toBe(6);
      // Historical off-list org currencies predate the currency FK.
      await tx.unsafe('ALTER TABLE organizations DROP CONSTRAINT organizations_currency_code_fkey');

      const partnerId = await insertPartner(tx, true);
      const cat = {
        converted: randomUUID(), nonBillableRate: randomUUID(), unsupportedCurrency: randomUUID(),
        unpriced: randomUUID(), nonBillableNoRate: randomUUID(),
      };
      await tx`INSERT INTO ticket_categories (id, partner_id, name, default_billable, default_hourly_rate, rate_currency) VALUES
        (${cat.converted}, ${partnerId}, 'Remote', true, '100.00', 'USD'),
        (${cat.nonBillableRate}, ${partnerId}, 'Warranty', false, '90.00', 'USD'),
        (${cat.unsupportedCurrency}, ${partnerId}, 'Legacy import', true, '80.00', 'ZZZ'),
        (${cat.unpriced}, ${partnerId}, 'Unpriced', true, NULL, NULL),
        (${cat.nonBillableNoRate}, ${partnerId}, 'Internal', false, NULL, NULL)`;

      const org = {
        converted: randomUUID(), mismatch: randomUUID(), nonBillable: randomUUID(), offList: randomUUID(), slaOnly: randomUUID(),
      };
      await tx`INSERT INTO organizations (id, partner_id, name, slug, currency_code) VALUES
        (${org.converted}, ${partnerId}, 'Converted org', ${`w04b-${org.converted}`}, 'USD'),
        (${org.mismatch}, ${partnerId}, 'Mismatched rate org', ${`w04b-${org.mismatch}`}, 'USD'),
        (${org.nonBillable}, ${partnerId}, 'Non-billable org', ${`w04b-${org.nonBillable}`}, 'USD'),
        (${org.offList}, ${partnerId}, 'Off-list org', ${`w04b-${org.offList}`}, 'ZZZ'),
        (${org.slaOnly}, ${partnerId}, 'SLA-only org', ${`w04b-${org.slaOnly}`}, 'USD')`;
      await tx`INSERT INTO org_ticket_settings (org_id, default_billable, default_hourly_rate, rate_currency) VALUES
        (${org.converted}, NULL, '120.00', 'USD'),
        (${org.mismatch}, true, '130.00', 'EUR'),
        (${org.nonBillable}, false, '75.00', 'USD'),
        (${org.offList}, false, '99.00', 'USD'),
        (${org.slaOnly}, NULL, NULL, 'USD')`;

      await tx.unsafe(migration);

      expect(await legacyColumnCount(tx)).toBe(0);
      const archived = await tx`SELECT source_table, source_id, org_id, source_name, default_billable,
          default_hourly_rate, rate_currency, owner_currency_code, skip_reason
        FROM legacy_labour_pricing_archive WHERE partner_id = ${partnerId}
        ORDER BY source_table, source_name`;
      const settingsId = async (orgId: string) =>
        ((await tx`SELECT id FROM org_ticket_settings WHERE org_id = ${orgId}`)[0]!.id as string);
      expect(archived).toEqual([
        { source_table: 'org_ticket_settings', source_id: await settingsId(org.converted), org_id: org.converted,
          source_name: 'Converted org', default_billable: null, default_hourly_rate: '120.00', rate_currency: 'USD',
          owner_currency_code: 'USD', skip_reason: null },
        { source_table: 'org_ticket_settings', source_id: await settingsId(org.mismatch), org_id: org.mismatch,
          source_name: 'Mismatched rate org', default_billable: true, default_hourly_rate: '130.00', rate_currency: 'EUR',
          owner_currency_code: 'USD', skip_reason: 'org_rate_currency_mismatch' },
        { source_table: 'org_ticket_settings', source_id: await settingsId(org.nonBillable), org_id: org.nonBillable,
          source_name: 'Non-billable org', default_billable: false, default_hourly_rate: '75.00', rate_currency: 'USD',
          owner_currency_code: 'USD', skip_reason: 'non_billable_org_rate' },
        { source_table: 'org_ticket_settings', source_id: await settingsId(org.offList), org_id: org.offList,
          source_name: 'Off-list org', default_billable: false, default_hourly_rate: '99.00', rate_currency: 'USD',
          owner_currency_code: 'ZZZ', skip_reason: 'org_currency_off_list' },
        { source_table: 'ticket_categories', source_id: cat.nonBillableNoRate, org_id: null,
          source_name: 'Internal', default_billable: false, default_hourly_rate: null, rate_currency: null,
          owner_currency_code: 'USD', skip_reason: null },
        { source_table: 'ticket_categories', source_id: cat.unsupportedCurrency, org_id: null,
          source_name: 'Legacy import', default_billable: true, default_hourly_rate: '80.00', rate_currency: 'ZZZ',
          owner_currency_code: 'USD', skip_reason: 'category_rate_currency_unsupported' },
        { source_table: 'ticket_categories', source_id: cat.converted, org_id: null,
          source_name: 'Remote', default_billable: true, default_hourly_rate: '100.00', rate_currency: 'USD',
          owner_currency_code: 'USD', skip_reason: null },
        { source_table: 'ticket_categories', source_id: cat.nonBillableRate, org_id: null,
          source_name: 'Warranty', default_billable: false, default_hourly_rate: '90.00', rate_currency: 'USD',
          owner_currency_code: 'USD', skip_reason: 'non_billable_category_rate' },
      ]);
      // Counts are reported (repo convention for row-writing migrations).
      expect(notices).toContainEqual(expect.stringContaining('archived 4 ticket_categories legacy pricing row(s)'));
      expect(notices).toContainEqual(expect.stringContaining('archived 4 org_ticket_settings legacy pricing row(s)'));
      expect(notices).toContainEqual(expect.stringContaining('all six legacy labour-pricing columns dropped'));

      // Re-apply: a no-op that neither fails nor duplicates the archive.
      notices.length = 0;
      await tx.unsafe(migration);
      const [again] = await tx`SELECT count(*)::int AS n FROM legacy_labour_pricing_archive WHERE partner_id = ${partnerId}`;
      expect(again!.n).toBe(8);
      expect(notices).toContainEqual(expect.stringContaining('ticket_categories legacy pricing columns already dropped'));
      expect(notices).toContainEqual(expect.stringContaining('org_ticket_settings legacy pricing columns already dropped'));
    });
  });

  it.each(['ticket_categories', 'org_ticket_settings'])(
    'refuses a partial legacy column set on %s instead of dropping unarchived values',
    async (table) => {
      const migration = await loadMigration();
      await inRolledBackTx(async (tx) => {
        await tx.unsafe(RESTORE_LEGACY_LABOUR_PRICING_COLUMNS_SQL);
        // Manual DDL left two of the three columns behind.
        await tx.unsafe(`ALTER TABLE ${table} DROP COLUMN default_hourly_rate`);
        await expect(tx.unsafe(migration)).rejects.toThrow(
          new RegExp(`${table} has 2 of the 3 legacy labour-pricing columns`),
        );
      });
    },
  );

  it('refuses to drop anything while a partner is unconverted', async () => {
    const migration = await loadMigration();
    await inRolledBackTx(async (tx) => {
      await tx.unsafe(RESTORE_LEGACY_LABOUR_PRICING_COLUMNS_SQL);
      const partnerId = await insertPartner(tx, false);
      await tx`INSERT INTO ticket_categories (partner_id, name, default_billable, default_hourly_rate, rate_currency)
        VALUES (${partnerId}, 'Never converted', true, '110.00', 'USD')`;
      await expect(tx.unsafe(migration)).rejects.toThrow(/refusing to drop legacy labour-pricing columns: 1 partner/);
    });
  });

  it('the interlock sees partners under FORCE RLS only because it elects system scope', async () => {
    const migration = await loadMigration();
    const interlock = migration.match(/-- 1\) Interlock[\s\S]*?END \$\$;/)?.[0];
    expect(interlock, 'interlock block not found in the migration').toBeDefined();
    const election = "PERFORM set_config('breeze.scope', 'system', true);";
    expect(interlock).toContain(election);
    const mutated = interlock!.replace(election, '');
    expect(mutated).not.toContain(election);

    // Control: without the election, breeze_app sees no partners and passes (fail-open).
    await inRolledBackTx(async (tx) => {
      await insertPartner(tx, false);
      await tx.unsafe('SET LOCAL ROLE breeze_app');
      await tx`SELECT set_config('breeze.scope', 'none', true)`;
      await expect(tx.unsafe(mutated)).resolves.toBeDefined();
    });
    // Real block: the election makes the unconverted partner visible, so it refuses.
    await inRolledBackTx(async (tx) => {
      await insertPartner(tx, false);
      await tx.unsafe('SET LOCAL ROLE breeze_app');
      await tx`SELECT set_config('breeze.scope', 'none', true)`;
      await expect(tx.unsafe(interlock!)).rejects.toThrow(/refusing to drop legacy labour-pricing columns/);
    });
  });
});

describe('legacy_labour_pricing_archive — partner-axis RLS', () => {
  const partnerA = randomUUID();
  const partnerB = randomUUID();
  const orgA = randomUUID();
  const partnerContext = (partnerId: string): DbAccessContext => ({
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA], accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId, userId: null,
  });
  // An org token of partner A: partner prices are not its data, even for its own org.
  const orgContext: DbAccessContext = {
    scope: 'organization', orgId: orgA, accessibleOrgIds: [orgA], accessiblePartnerIds: [],
    currentPartnerId: partnerA, userId: null,
  };

  // Shared setup truncates partners before each test, so every case reseeds.
  beforeEach(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code) VALUES
        (${partnerA}, 'Archive A', ${`lla-a-${partnerA}`}, 'USD'),
        (${partnerB}, 'Archive B', ${`lla-b-${partnerB}`}, 'USD')`);
      await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
        VALUES (${orgA}, ${partnerA}, 'Archive org', ${`lla-org-${orgA}`}, 'USD')`);
      await db.execute(sql`INSERT INTO legacy_labour_pricing_archive
        (partner_id, org_id, source_table, source_id, source_name, default_hourly_rate, rate_currency, owner_currency_code)
        VALUES (${partnerA}, NULL, 'ticket_categories', ${randomUUID()}, 'Remote', '100.00', 'USD', 'USD'),
               (${partnerA}, ${orgA}, 'org_ticket_settings', ${randomUUID()}, 'Archive org', '120.00', 'USD', 'USD')`);
    });
  });

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM legacy_labour_pricing_archive WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM organizations WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`);
    });
  });

  const visible = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM legacy_labour_pricing_archive
      WHERE partner_id IN (${partnerA}, ${partnerB})`)) as unknown as Array<{ n: number }>)[0]!.n);

  it('partner A sees its archive rows; partner B and an org token see none', async () => {
    expect(await visible(partnerContext(partnerA))).toBe(2);
    expect(await visible(partnerContext(partnerB))).toBe(0);
    expect(await visible(orgContext)).toBe(0);
  });

  it("partner B cannot forge a row into partner A's archive (42501) or change A's rows", async () => {
    await expect(withDbAccessContext(partnerContext(partnerB), () => db.execute(sql`
      INSERT INTO legacy_labour_pricing_archive (partner_id, source_table, source_id, source_name)
      VALUES (${partnerA}, 'ticket_categories', ${randomUUID()}, 'Forged')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await withDbAccessContext(partnerContext(partnerB), () => db.execute(sql`
      UPDATE legacy_labour_pricing_archive SET default_hourly_rate = '1.00' WHERE partner_id = ${partnerA}`));
    await withDbAccessContext(partnerContext(partnerB), () => db.execute(sql`
      DELETE FROM legacy_labour_pricing_archive WHERE partner_id = ${partnerA}`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT default_hourly_rate FROM legacy_labour_pricing_archive WHERE partner_id = ${partnerA} ORDER BY 1`));
    expect(rows).toEqual([{ default_hourly_rate: '100.00' }, { default_hourly_rate: '120.00' }]);
  });
});
