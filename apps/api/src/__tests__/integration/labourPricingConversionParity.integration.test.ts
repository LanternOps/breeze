/**
 * W02 Tasks 6–9: real-Postgres conversion gate. Run with the integration config.
 *
 * The exhaustive matrix tests conversion + pure resolution; the shape-13
 * regression also calls the real createTimeEntry service as breeze_app. Omitted
 * workTypeId must preserve retired-category prices through server defaults,
 * while explicitly choosing an inactive work type remains forbidden.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { replayMigration } from './replayMigration';
import { resolveBillingRule, type ResolvedCard } from '../../services/billingRuleResolver';
import { buildDryRunReport, type PartnerReport } from '../../../scripts/labour-pricing-dry-run.lib';
import { legacyResolve } from './fixtures/legacyLabourPricingResolver';
import { LEGACY_SHAPES, PRODUCTION_SHAPE, seedShape, type SeededFixture } from './fixtures/labourPricingConversionSeeds';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { createTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';

// Keep the queue boundary out of the service-path proof; no DB/resolver mocks.
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

const MIGRATION = '2026-10-24-200200-labour-pricing-conversion.sql';
const STAMP_MIGRATION = '2026-10-24-200100-time-entries-billing-stamp.sql';

type Card = ResolvedCard & { partnerId: string; name: string; isDefault: boolean };
async function loadCards(partnerId: string): Promise<Card[]> {
  const db = getTestDb();
  const cards = await db.execute(sql`SELECT id, partner_id AS "partnerId", name,
      currency_code AS "currencyCode", is_default AS "isDefault",
      rounding_increment_minutes AS "roundingIncrementMinutes", base_coverage AS "baseCoverage",
      base_hourly_rate AS "baseHourlyRate", base_minimum_minutes AS "baseMinimumMinutes"
    FROM billing_profiles WHERE partner_id = ${partnerId} AND is_active ORDER BY id`);
  return Promise.all(cards.map(async (row) => {
    const rules = await db.execute(sql`SELECT work_type_id AS "workTypeId", coverage,
      hourly_rate AS "hourlyRate", minimum_minutes AS "minimumMinutes"
      FROM billing_profile_rules WHERE billing_profile_id = ${row.id as string} ORDER BY work_type_id`);
    return { ...row, rules: [...rules] } as unknown as Card;
  }));
}

async function resolveConvertedEntry(input: { ticketId: string }) {
  // No client-supplied id (including no explicit null). W01's server-side
  // category default is the compatibility path for clients without a picker.
  expect(Object.hasOwn(input, 'workTypeId')).toBe(false);
  const db = getTestDb();
  const [link] = await db.execute(sql`SELECT COALESCE(t.partner_id, o.partner_id) AS partner_id,
      o.currency_code, c.default_work_type_id
    FROM tickets t JOIN organizations o ON o.id = t.org_id
    LEFT JOIN ticket_categories c ON c.id = t.category_id
    WHERE t.id = ${input.ticketId}`);
  expect(link).toBeDefined();
  const cards = await loadCards(link!.partner_id as string);
  const [assignment] = await db.execute(sql`SELECT a.billing_profile_id
    FROM org_billing_profile_assignments a JOIN tickets t ON t.org_id = a.org_id
    WHERE t.id = ${input.ticketId}`);
  const partnerDefaultCard = cards.find(card => card.isDefault && card.currencyCode === link!.currency_code) ?? null;
  expect(partnerDefaultCard, 'every org currency has a converted default').not.toBeNull();
  return resolveBillingRule({
    orgCurrency: link!.currency_code as string,
    workTypeId: link!.default_work_type_id as string | null,
    assignedCard: cards.find(card => card.id === assignment?.billing_profile_id) ?? null,
    partnerDefaultCard,
  });
}

function reportFor(fixture: SeededFixture): PartnerReport {
  return buildDryRunReport({
    partners: [fixture.partner], categories: fixture.categories,
    orgs: fixture.orgs.map(org => ({
      orgId: org.id, orgName: org.name, partnerId: fixture.partner.id, currencyCode: org.currencyCode,
      defaultBillable: org.settings?.defaultBillable ?? null,
      defaultHourlyRate: org.settings?.defaultHourlyRate ?? null,
      rateCurrency: org.settings?.rateCurrency ?? null,
      uncategorisedEntryCount: fixture.pairs.filter(pair => pair.orgId === org.id && pair.categoryId === null).length,
    })),
  })[0]!;
}

const sorted = <T>(rows: T[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function assertDryRunAgreement(fixture: SeededFixture): Promise<void> {
  const expected = reportFor(fixture);
  const db = getTestDb();
  const cards = (await loadCards(fixture.partner.id)).filter(card => card.isDefault);
  expect(cards.map(card => card.currencyCode).sort(), fixture.shape.name).toEqual(expected.cardCurrencies);
  for (const card of cards) {
    expect(card).toMatchObject({ baseCoverage: 'billable', baseHourlyRate: null,
      baseMinimumMinutes: null, roundingIncrementMinutes: null });
  }
  const workTypes = await db.execute(sql`SELECT id, name, is_active FROM work_types
    WHERE partner_id = ${fixture.partner.id} ORDER BY id`);
  expect(sorted(workTypes.map(row => ({ name: row.name, inactive: !row.is_active }))))
    .toEqual(sorted(expected.workTypesToCreate.map(row => ({ name: row.name, inactive: row.inactive }))));
  for (const converted of expected.workTypesToCreate) {
    const workType = workTypes.find(row => row.name === converted.name)!;
    for (const categoryId of converted.fromCategoryIds) {
      const [category] = await db.execute(sql`SELECT default_work_type_id FROM ticket_categories WHERE id = ${categoryId}`);
      expect(category!.default_work_type_id).toBe(workType.id);
    }
  }
  const actualRows = cards.flatMap(card => card.rules.map(rule => ({
    currency: card.currencyCode, workTypeName: workTypes.find(row => row.id === rule.workTypeId)!.name,
    coverage: rule.coverage, rate: rule.hourlyRate,
  })));
  expect(sorted(actualRows), fixture.shape.name).toEqual(sorted(expected.rows));
  const assignments = await db.execute(sql`SELECT a.org_id, p.name, p.currency_code,
      p.base_coverage, p.base_hourly_rate FROM org_billing_profile_assignments a
    JOIN billing_profiles p ON p.id = a.billing_profile_id WHERE a.partner_id = ${fixture.partner.id}`);
  expect(assignments).toHaveLength(expected.orgOverrides.length);
  for (const override of expected.orgOverrides) {
    const assignment = assignments.find(row => row.org_id === override.orgId);
    expect(assignment).toMatchObject({ name: override.cardName, currency_code: override.currency,
      base_coverage: override.billable === false ? 'non_billable' : 'billable', base_hourly_rate: override.rate });
  }
  // Compression must keep whole-row semantics: a redundant row is removed,
  // but a non-billable/null-rate row cannot collapse to billable/no-rate.
  const [redundant] = await db.execute(sql`SELECT count(*)::integer AS n
    FROM billing_profile_rules r JOIN billing_profiles p ON p.id = r.billing_profile_id
    JOIN org_billing_profile_assignments a ON a.billing_profile_id = p.id
    WHERE a.partner_id = ${fixture.partner.id} AND r.coverage = p.base_coverage
      AND r.hourly_rate IS NOT DISTINCT FROM p.base_hourly_rate
      AND r.minimum_minutes IS NOT DISTINCT FROM p.base_minimum_minutes`);
  expect(redundant!.n).toBe(0);
}

async function snapshot(partnerIds: string[]) {
  const db = getTestDb();
  const ids = sql.join(partnerIds.map(id => sql`${id}::uuid`), sql`, `);
  const tables = ['billing_profiles', 'billing_profile_rules', 'org_billing_profile_assignments',
    'work_types', 'ticket_categories', 'time_entries'] as const;
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const [row] = await db.execute(sql`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) AS rows
      FROM ${sql.identifier(table)} t WHERE partner_id IN (${ids})`);
    result[table] = row!.rows;
  }
  const [partners] = await db.execute(sql`SELECT jsonb_agg(to_jsonb(p) ORDER BY id) AS rows FROM partners p WHERE id IN (${ids})`);
  result.partners = partners!.rows;
  return result;
}

async function assertParity(fixture: SeededFixture) {
  const counts = { parity: 0, uncategorised: 0, nonBillableRate: 0 };
  for (const pair of fixture.pairs) {
    const org = fixture.orgs.find(row => row.id === pair.orgId)!;
    const category = fixture.categories.find(row => row.id === pair.categoryId) ?? null;
    const before = legacyResolve({ orgSettings: org.settings, category, orgCurrency: org.currencyCode });
    const after = await resolveConvertedEntry({ ticketId: pair.ticketId });
    const label = `${fixture.shape.name} / ${org.name} / ${category?.name ?? '(none)'}`;
    expect(after.fellBackToNoCard, label).toBe(false);
    if (category === null && org.settings?.defaultBillable == null) {
      // DECLARED difference 1 includes billable-at-no-rate, not only the
      // money-moving subset. Do not silently skip uncategorized/no-rate pairs.
      expect(before, label).toEqual({ isBillable: false, hourlyRate: org.settings?.rateCurrency === org.currencyCode
        ? org.settings.defaultHourlyRate : null });
      expect(after, label).toMatchObject({ isBillable: true, hourlyRate: before.hourlyRate });
      counts.uncategorised++;
    } else if (!before.isBillable && before.hourlyRate !== null) {
      // DECLARED difference 2: only the rate changes, never coverage.
      expect(after, label).toMatchObject({ isBillable: false, hourlyRate: null, coverage: 'non_billable' });
      counts.nonBillableRate++;
    } else {
      expect({ isBillable: after.isBillable, hourlyRate: after.hourlyRate }, label).toEqual(before);
      counts.parity++;
    }
  }
  return counts;
}

describe('labour pricing conversion — legacy parity gate', () => {
  it('stamp DDL replays safely, defaults new fields, and keeps its composite FK NO ACTION', async () => {
    const fixture = await seedShape(LEGACY_SHAPES[0]!);
    const before = await snapshot([fixture.partner.id]);
    await replayMigration(STAMP_MIGRATION);
    await replayMigration(STAMP_MIGRATION);
    expect(await snapshot([fixture.partner.id])).toEqual(before);
    const db = getTestDb();
    const columns = await db.execute(sql`SELECT column_name, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'time_entries'
        AND column_name IN ('billing_profile_id', 'coverage', 'billing_overridden', 'minimum_minutes', 'rounding_increment_minutes')`);
    expect(columns).toHaveLength(5);
    for (const column of columns) {
      expect(column.is_nullable).toBe(column.column_name === 'billing_overridden' ? 'NO' : 'YES');
      expect(column.column_default).toBe(column.column_name === 'billing_overridden' ? 'false' : null);
    }
    const [marker] = await db.execute(sql`SELECT is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'partners' AND column_name = 'labour_pricing_converted_at'`);
    expect(marker).toEqual({ is_nullable: 'YES', data_type: 'timestamp with time zone' });
    const [fk] = await db.execute(sql`SELECT confdeltype, confupdtype,
        pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'time_entries'::regclass AND conname = 'time_entries_billing_profile_partner_fk'`);
    expect(fk).toMatchObject({ confdeltype: 'a', confupdtype: 'a' });
    expect(fk!.definition).toContain('FOREIGN KEY (billing_profile_id, partner_id) REFERENCES billing_profiles(id, partner_id)');
    const entries = await db.execute(sql`SELECT billing_profile_id, coverage, billing_overridden,
      minimum_minutes, rounding_increment_minutes FROM time_entries WHERE partner_id = ${fixture.partner.id}`);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry).toEqual({ billing_profile_id: null, coverage: null,
      billing_overridden: false, minimum_minutes: null, rounding_increment_minutes: null });
  });

  it('new partners default to converted while explicitly NULL legacy partners remain eligible', async () => {
    const legacy = await seedShape(LEGACY_SHAPES[0]!);
    const db = getTestDb();
    const id = randomUUID();
    const [created] = await db.execute(sql`INSERT INTO partners (id, name, slug)
      VALUES (${id}, 'Post-cutover partner', ${`post-cutover-${id}`})
      RETURNING labour_pricing_converted_at`);
    expect(created!.labour_pricing_converted_at).not.toBeNull();
    const [existing] = await db.execute(sql`SELECT labour_pricing_converted_at FROM partners WHERE id = ${legacy.partner.id}`);
    expect(existing!.labour_pricing_converted_at).toBeNull();
    await replayMigration(MIGRATION);
    expect(await loadCards(legacy.partner.id)).toHaveLength(1);
    expect(await loadCards(id)).toHaveLength(0);
  });

  it('skips an off-list org currency and logs it while converting supported pricing', async () => {
    const notices: string[] = [];
    const client = postgres(process.env.DATABASE_URL || 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test', {
      max: 1, onnotice: notice => { notices.push(notice.message ?? ''); },
    });
    const migration = await readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
    const partnerId = randomUUID();
    const badOrgId = randomUUID();
    const goodOrgId = randomUUID();
    const rollback = new Error('rollback off-list fixture and DDL');
    try {
      await expect(client.begin(async tx => {
        await tx`SELECT set_config('breeze.scope', 'system', true)`;
        // Model historical rows admitted before the currency FKs existed.
        // Restore NOT VALID guards before running conversion; rollback restores
        // the original schema regardless of the assertion outcome.
        await tx.unsafe('ALTER TABLE organizations DROP CONSTRAINT organizations_currency_code_fkey');
        await tx`INSERT INTO partners (id, name, slug, currency_code, labour_pricing_converted_at)
          VALUES (${partnerId}, 'Off-list partner', ${partnerId}, 'USD', NULL)`;
        await tx`INSERT INTO organizations (id, partner_id, name, slug, currency_code) VALUES
          (${badOrgId}, ${partnerId}, 'Off-list organization', ${badOrgId}, 'ZZZ'),
          (${goodOrgId}, ${partnerId}, 'Supported organization', ${goodOrgId}, 'USD')`;
        await tx`INSERT INTO org_ticket_settings (org_id, default_billable, default_hourly_rate, rate_currency) VALUES
          (${badOrgId}, false, '99.00', 'USD'), (${goodOrgId}, true, '150.00', 'USD')`;
        await tx`INSERT INTO ticket_categories (partner_id, name, default_billable, default_hourly_rate, rate_currency) VALUES
          (${partnerId}, 'Supported category', true, '125.00', 'USD')`;
        await tx.unsafe(`ALTER TABLE organizations ADD CONSTRAINT organizations_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES supported_currencies(code) NOT VALID;`);
        const [legacyBefore] = await tx`SELECT to_jsonb(s) AS row FROM org_ticket_settings s WHERE org_id = ${badOrgId}`;
        await tx.unsafe(migration);
        const cards = await tx`SELECT currency_code, is_default, base_hourly_rate FROM billing_profiles WHERE partner_id = ${partnerId}`;
        expect(cards).toHaveLength(2);
        expect(cards.every(card => card.currency_code === 'USD')).toBe(true);
        expect(cards).toContainEqual({ currency_code: 'USD', is_default: false, base_hourly_rate: '150.00' });
        const assignments = await tx`SELECT org_id FROM org_billing_profile_assignments WHERE partner_id = ${partnerId}`;
        expect(assignments).toEqual([{ org_id: goodOrgId }]);
        const rules = await tx`SELECT hourly_rate FROM billing_profile_rules WHERE partner_id = ${partnerId}`;
        expect(rules).toEqual([{ hourly_rate: '125.00' }]);
        const [legacyAfter] = await tx`SELECT to_jsonb(s) AS row FROM org_ticket_settings s WHERE org_id = ${badOrgId}`;
        expect(legacyAfter).toEqual(legacyBefore);
        const [badOrg] = await tx`SELECT currency_code FROM organizations WHERE id = ${badOrgId}`;
        expect(badOrg!.currency_code).toBe('ZZZ');
        expect(resolveBillingRule({ orgCurrency: 'ZZZ', workTypeId: null, assignedCard: null, partnerDefaultCard: null }))
          .toMatchObject({ fellBackToNoCard: true });
        const [marker] = await tx`SELECT labour_pricing_converted_at FROM partners WHERE id = ${partnerId}`;
        expect(marker!.labour_pricing_converted_at).not.toBeNull();
        expect(notices).toContainEqual(expect.stringMatching(new RegExp(`org ${badOrgId}.*ZZZ.*skipp`, 'i')));
        throw rollback;
      })).rejects.toBe(rollback);
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it('PARITY: all 17 legacy shapes, every org × category-or-none, with NO client workTypeId', async () => {
    expect(LEGACY_SHAPES).toHaveLength(17);
    const fixtures: SeededFixture[] = [];
    for (const shape of LEGACY_SHAPES) fixtures.push(await seedShape(shape));
    const before = await snapshot(fixtures.map(row => row.partner.id));
    await replayMigration(MIGRATION);
    const totals = { parity: 0, uncategorised: 0, nonBillableRate: 0 };
    for (const fixture of fixtures) {
      const counts = await assertParity(fixture);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += counts[key];
      await assertDryRunAgreement(fixture);
    }
    expect(totals.parity).toBeGreaterThan(0);
    expect(totals.uncategorised).toBeGreaterThan(0);
    expect(totals.nonBillableRate).toBeGreaterThan(0);
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(fixtures.reduce((n, f) => n + f.pairs.length, 0));
    const after = await snapshot(fixtures.map(row => row.partner.id));
    expect(after.time_entries, 'every historical column is immutable, including updated_at').toEqual(before.time_entries);
    const nullPartner = fixtures[16]!;
    const tickets = await getTestDb().execute(sql`SELECT partner_id FROM tickets WHERE org_id = ${nullPartner.orgs[0]!.id}`);
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every(ticket => ticket.partner_id === null)).toBe(true);
  });

  it('shape 13: real createTimeEntry preserves inactive category defaults but rejects explicitly picked inactive work types', async () => {
    const fixture = await seedShape(LEGACY_SHAPES[12]!);
    await replayMigration(MIGRATION);
    const org = fixture.orgs[0]!;
    const [user] = await getTestDb().execute(sql`SELECT id FROM users WHERE org_id = ${org.id} LIMIT 1`);
    expect(user).toBeDefined();
    const actor: TimeEntryActor = {
      userId: user!.id as string, partnerId: fixture.partner.id,
      manageAll: false, manageBilling: false, accessibleOrgIds: [org.id],
    };
    const context: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [org.id],
      accessiblePartnerIds: [fixture.partner.id], currentPartnerId: fixture.partner.id, userId: actor.userId,
    };
    let inactiveDefaults = 0;
    for (const category of fixture.categories.filter(row => !row.isActive)) {
      const pair = fixture.pairs.find(row => row.categoryId === category.id)!;
      const [workType] = await getTestDb().execute(sql`SELECT w.id, w.is_active FROM work_types w
        JOIN ticket_categories c ON c.default_work_type_id = w.id WHERE c.id = ${category.id}`);
      expect(workType).toBeDefined();
      const input = { ticketId: pair.ticketId, startedAt: new Date('2026-09-19T10:00:00Z'),
        endedAt: new Date('2026-09-19T11:00:00Z') };
      expect(Object.hasOwn(input, 'workTypeId')).toBe(false);
      const expected = legacyResolve({ orgSettings: org.settings, category, orgCurrency: org.currencyCode });
      const entry = await withDbAccessContext(context, () => createTimeEntry(input, actor));
      expect(entry, category.name).toMatchObject({
        ...expected, workTypeId: workType!.id, currencyCode: org.currencyCode, billingOverridden: false,
        coverage: expected.isBillable ? 'billable' : 'non_billable', billingStatus: 'not_billed',
      });
      expect(entry.billingProfileId).not.toBeNull();
      const [stored] = await getTestDb().execute(sql`SELECT work_type_id, hourly_rate, is_billable,
        billing_profile_id FROM time_entries WHERE id = ${entry.id}`);
      expect(stored, category.name).toEqual({ work_type_id: workType!.id, hourly_rate: expected.hourlyRate,
        is_billable: expected.isBillable, billing_profile_id: entry.billingProfileId });
      // Case-colliding inactive/active categories intentionally share an active
      // type. Only genuinely inactive converted types reject explicit selection.
      if (workType!.is_active === false) {
        inactiveDefaults++;
        await expect(withDbAccessContext(context, () => createTimeEntry({
          ...input, workTypeId: workType!.id as string,
        }, actor))).rejects.toMatchObject({ status: 400, code: 'WORK_TYPE_NOT_FOUND' });
      }
    }
    expect(inactiveDefaults).toBe(2);
  });

  it('DECLARED difference 1: NULL org billable + matching rate makes uncategorized work billable', async () => {
    const fixture = await seedShape(LEGACY_SHAPES[5]!);
    const org = fixture.orgs[0]!;
    expect(legacyResolve({ orgSettings: org.settings, category: null, orgCurrency: 'USD' }))
      .toEqual({ isBillable: false, hourlyRate: '150.00' });
    expect(reportFor(fixture).uncategorisedBecomingBillable).toEqual([
      { orgId: org.id, orgName: org.name, orgRate: '150.00', currency: 'USD', recentEntryCount: 1 },
    ]);
    await replayMigration(MIGRATION);
    const pair = fixture.pairs.find(row => row.categoryId === null)!;
    expect(await resolveConvertedEntry({ ticketId: pair.ticketId }))
      .toMatchObject({ isBillable: true, hourlyRate: '150.00', coverage: 'billable' });
  });

  it('DECLARED difference 2: non-billable work loses its rate, while historical entries keep it', async () => {
    const fixture = await seedShape(LEGACY_SHAPES[2]!);
    const pair = fixture.pairs.find(row => row.categoryId !== null)!;
    expect(legacyResolve({ orgSettings: null, category: fixture.categories[0]!, orgCurrency: 'USD' }))
      .toEqual({ isBillable: false, hourlyRate: '200.00' });
    const before = await snapshot([fixture.partner.id]);
    await replayMigration(MIGRATION);
    expect(await resolveConvertedEntry({ ticketId: pair.ticketId }))
      .toMatchObject({ isBillable: false, hourlyRate: null, coverage: 'non_billable' });
    expect((await snapshot([fixture.partner.id])).time_entries).toEqual(before.time_entries);
    // Currency guards count unbilled entries WITH a rate; the new default
    // carries none, but the migration must not rewrite historical guard inputs.
  });

  it('re-running the conversion is a NO-OP including IDs, timestamps, mappings and history', async () => {
    const fixture = await seedShape(PRODUCTION_SHAPE);
    await replayMigration(MIGRATION);
    const before = await snapshot([fixture.partner.id]);
    const [marker] = await getTestDb().execute(sql`SELECT labour_pricing_converted_at FROM partners WHERE id = ${fixture.partner.id}`);
    expect(marker!.labour_pricing_converted_at).not.toBeNull();
    await replayMigration(MIGRATION);
    expect(await snapshot([fixture.partner.id])).toEqual(before);
  });

  it.each([false, true])('a HAND-MADE card (default=%s) does not bypass conversion when the marker is NULL', async (isDefault) => {
    const fixture = await seedShape(LEGACY_SHAPES[0]!);
    const handmadeId = randomUUID();
    const db = getTestDb();
    await db.execute(sql`INSERT INTO billing_profiles (id, partner_id, name, currency_code,
        is_default, base_coverage, base_hourly_rate)
      VALUES (${handmadeId}, ${fixture.partner.id}, 'Hand-made card', 'USD', ${isDefault}, 'billable', '999.00')`);
    const [before] = await db.execute(sql`SELECT to_jsonb(p) AS row FROM billing_profiles p WHERE id = ${handmadeId}`);
    await replayMigration(MIGRATION);
    const [after] = await db.execute(sql`SELECT to_jsonb(p) AS row FROM billing_profiles p WHERE id = ${handmadeId}`);
    if (isDefault) {
      // A configured pre-conversion default survives as a custom card; keeping
      // it default would leak its 999 rate into previously unpriced work.
      const { is_default: _oldDefault, updated_at: _oldUpdated, ...oldValues } = before!.row as Record<string, unknown>;
      const { is_default: newDefault, updated_at: _newUpdated, ...newValues } = after!.row as Record<string, unknown>;
      expect(newDefault).toBe(false);
      expect(newValues).toEqual(oldValues);
    } else {
      expect(after!.row).toEqual(before!.row);
    }
    const [marker] = await db.execute(sql`SELECT labour_pricing_converted_at FROM partners WHERE id = ${fixture.partner.id}`);
    expect(marker!.labour_pricing_converted_at).not.toBeNull();
    expect(await resolveConvertedEntry({ ticketId: fixture.pairs[0]!.ticketId }))
      .toMatchObject({ isBillable: true, hourlyRate: '125.00' });
  });

  it('a W01 work-type name collision cannot price unpriced categories already using that type', async () => {
    const fixture = await seedShape({ name: 'Existing W01 type', categories: [
      { name: 'Remote', defaultBillable: true, defaultHourlyRate: '125.00', rateCurrency: 'USD' },
      { name: 'Unpriced', defaultBillable: true, defaultHourlyRate: null, rateCurrency: null },
    ] });
    const db = getTestDb();
    const oldTypeId = randomUUID();
    await db.execute(sql`INSERT INTO work_types (id, partner_id, name)
      VALUES (${oldTypeId}, ${fixture.partner.id}, 'remote')`);
    await db.execute(sql`UPDATE ticket_categories SET default_work_type_id = ${oldTypeId}
      WHERE partner_id = ${fixture.partner.id}`);
    const [before] = await db.execute(sql`SELECT to_jsonb(w) AS row FROM work_types w WHERE id = ${oldTypeId}`);
    await replayMigration(MIGRATION);
    const [after] = await db.execute(sql`SELECT to_jsonb(w) AS row FROM work_types w WHERE id = ${oldTypeId}`);
    expect(after!.row).toEqual(before!.row);
    const categories = await db.execute(sql`SELECT name, default_work_type_id FROM ticket_categories
      WHERE partner_id = ${fixture.partner.id}`);
    expect(categories.find(row => row.name === 'Unpriced')!.default_work_type_id).toBe(oldTypeId);
    const convertedTypeId = categories.find(row => row.name === 'Remote')!.default_work_type_id;
    expect(convertedTypeId).not.toBe(oldTypeId);
    expect(convertedTypeId).not.toBeNull();
    const [newType] = await db.execute(sql`SELECT name FROM work_types WHERE id = ${convertedTypeId as string}`);
    // Existing work types are outside buildDryRunReport's input contract;
    // reserve their names and suffix the converted type, preserving both IDs.
    expect(newType!.name).toBe(`Remote [${fixture.categories[0]!.id}]`);
    const cards = await loadCards(fixture.partner.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.rules).toEqual([{ workTypeId: convertedTypeId,
      coverage: 'billable', hourlyRate: '125.00', minimumMinutes: null }]);
    await assertParity(fixture);
  });

  it.each([false, true])('replaces a preexisting assignment (legacy override=%s) while preserving the custom card', async (hasOverride) => {
    const fixture = await seedShape(LEGACY_SHAPES[hasOverride ? 3 : 0]!);
    const db = getTestDb();
    const customId = randomUUID();
    const customTypeId = randomUUID();
    const assignmentId = randomUUID();
    const orgId = fixture.orgs[0]!.id;
    await db.execute(sql`INSERT INTO billing_profiles (id, partner_id, name, notes, currency_code,
      base_coverage, base_hourly_rate, base_minimum_minutes, rounding_increment_minutes)
      VALUES (${customId}, ${fixture.partner.id}, 'Custom assigned profile', 'Keep custom data',
        'USD', 'billable', '999.00', 30, 15)`);
    await db.execute(sql`INSERT INTO work_types (id, partner_id, name)
      VALUES (${customTypeId}, ${fixture.partner.id}, 'Custom included work')`);
    await db.execute(sql`INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage)
      VALUES (${fixture.partner.id}, ${customId}, ${customTypeId}, 'included')`);
    await db.execute(sql`INSERT INTO org_billing_profile_assignments (id, org_id, partner_id, billing_profile_id)
      VALUES (${assignmentId}, ${orgId}, ${fixture.partner.id}, ${customId})`);
    const [beforeCard] = await db.execute(sql`SELECT to_jsonb(p) AS row FROM billing_profiles p WHERE id = ${customId}`);
    const beforeRules = await db.execute(sql`SELECT * FROM billing_profile_rules WHERE billing_profile_id = ${customId}`);
    await replayMigration(MIGRATION);
    const [afterCard] = await db.execute(sql`SELECT to_jsonb(p) AS row FROM billing_profiles p WHERE id = ${customId}`);
    expect(afterCard!.row).toEqual(beforeCard!.row);
    expect(await db.execute(sql`SELECT * FROM billing_profile_rules WHERE billing_profile_id = ${customId}`)).toEqual(beforeRules);
    const assignments = await db.execute(sql`SELECT a.billing_profile_id, p.is_default,
      p.base_hourly_rate FROM org_billing_profile_assignments a JOIN billing_profiles p ON p.id = a.billing_profile_id
      WHERE a.org_id = ${orgId}`);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.billing_profile_id).not.toBe(customId);
    expect(assignments[0]).toMatchObject({ is_default: !hasOverride,
      base_hourly_rate: hasOverride ? '150.00' : null });
    await assertParity(fixture);
    const converted = await snapshot([fixture.partner.id]);
    await replayMigration(MIGRATION);
    expect(await snapshot([fixture.partner.id])).toEqual(converted);
  });

  it('a partner with no organizations or categories still gets its currency default', async () => {
    const fixture = await seedShape({ name: 'Empty partner', partnerCurrency: 'CAD', categories: [], orgs: [] });
    expect(fixture.orgs).toHaveLength(0);
    expect(fixture.categories).toHaveLength(0);
    await replayMigration(MIGRATION);
    await assertDryRunAgreement(fixture);
    const cards = await loadCards(fixture.partner.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ isDefault: true, currencyCode: 'CAD',
      baseCoverage: 'billable', baseHourlyRate: null, rules: [] });
    const [marker] = await getTestDb().execute(sql`SELECT labour_pricing_converted_at FROM partners WHERE id = ${fixture.partner.id}`);
    expect(marker!.labour_pricing_converted_at).not.toBeNull();
  });

  it('matches the reviewed production dry-run: 8 work types, 6 dropped rates, 7 unpriced categories omitted', async () => {
    const fixture = await seedShape(PRODUCTION_SHAPE);
    const unpriced = await seedShape(LEGACY_SHAPES[6]!);
    const report = reportFor(fixture);
    expect(report.workTypesToCreate).toHaveLength(8);
    expect(report.rows).toHaveLength(8);
    expect(report.droppedNonBillableRates).toHaveLength(6);
    expect(report.orgOverrides.map(row => ({ billable: row.billable, rate: row.rate })))
      .toEqual([{ billable: true, rate: '125.00' }, { billable: null, rate: '135.00' }]);
    expect(report.uncategorisedBecomingBillable).toHaveLength(1);
    await replayMigration(MIGRATION);
    await assertDryRunAgreement(fixture);
    await assertDryRunAgreement(unpriced);
    await assertParity(fixture);
    await assertParity(unpriced);
    const [counts] = await getTestDb().execute(sql`SELECT
      (SELECT count(*)::integer FROM work_types WHERE partner_id = ${unpriced.partner.id}) AS work_types,
      (SELECT count(*)::integer FROM billing_profile_rules WHERE partner_id = ${unpriced.partner.id}) AS rules,
      (SELECT count(*)::integer FROM ticket_categories WHERE partner_id = ${unpriced.partner.id}
        AND default_work_type_id IS NOT NULL) AS defaults`);
    expect(counts).toEqual({ work_types: 0, rules: 0, defaults: 0 });
    const inheritOrg = fixture.orgs[1]!;
    for (const pair of fixture.pairs.filter(row => row.orgId === inheritOrg.id)) {
      const category = fixture.categories.find(row => row.id === pair.categoryId);
      expect(await resolveConvertedEntry({ ticketId: pair.ticketId })).toMatchObject(category?.defaultBillable === false
        ? { coverage: 'non_billable', hourlyRate: null }
        : { coverage: 'billable', hourlyRate: '135.00' });
    }
  });
});
