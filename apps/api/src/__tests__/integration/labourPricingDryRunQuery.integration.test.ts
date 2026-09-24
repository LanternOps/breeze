// apps/api/src/__tests__/integration/labourPricingDryRunQuery.integration.test.ts
/**
 * The SQL half of the W02 labour-pricing dry run.
 *
 * `labour-pricing-dry-run.lib.test.ts` covers the REPORT logic against
 * hand-built rows; nothing covered the QUERY that produces those rows. That
 * query is the part that can be silently wrong in production: the 90-day
 * uncategorised-entry count is a correlated subquery over `time_entries` joined
 * to `tickets` with `category_id IS NULL`, and the org row itself comes from a
 * LEFT JOIN onto `org_ticket_settings` — an org with NO settings row at all
 * must still appear, with NULL defaults, because "never answered the billable
 * question" is precisely the population the conversion moves.
 *
 * The script runs under `withSystemDbAccessContext` for a reason worth a test:
 * `breeze_current_scope()` defaults to 'none' and these tables are FORCE ROW
 * LEVEL SECURITY, so a contextless run returns ZERO ROWS SILENTLY and the
 * report prints a confident "nothing to convert".
 *
 * #4628 W04b dropped the legacy columns; the script still runs against a
 * not-yet-upgraded database (see its header), so this suite restores them for
 * its duration.
 */
import './setup';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { buildDryRunReport, formatReport } from '../../../scripts/labour-pricing-dry-run.lib';
import { dropLegacyLabourPricingColumns, restoreLegacyLabourPricingColumns } from './fixtures/legacyLabourPricingColumns';

const partnerId = randomUUID();

/** Verbatim from labour-pricing-dry-run.ts — if the script's SQL changes, change it here too. */
const ORG_QUERY = sql`
  SELECT o.id AS "orgId", o.name AS "orgName", o.partner_id AS "partnerId",
         o.currency_code AS "currencyCode",
         s.default_billable AS "defaultBillable", s.default_hourly_rate AS "defaultHourlyRate",
         s.rate_currency AS "rateCurrency",
         COALESCE((
           SELECT count(*) FROM time_entries te
           JOIN tickets t ON t.id = te.ticket_id
           WHERE te.org_id = o.id
             AND t.category_id IS NULL
             AND te.started_at > now() - interval '90 days'
         ), 0)::int AS "uncategorisedEntryCount"
    FROM organizations o
    LEFT JOIN org_ticket_settings s ON s.org_id = o.id
   ORDER BY o.partner_id, o.name
`;

type OrgRow = Parameters<typeof buildDryRunReport>[0]['orgs'][number];

async function runOrgQuery(): Promise<OrgRow[]> {
  const rows = (await withSystemDbAccessContext(() => db.execute(ORG_QUERY))) as unknown as OrgRow[];
  return rows.filter((row) => row.partnerId === partnerId);
}

async function seed(): Promise<{ orgId: string; userId: string }> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO partners (id, name, slug, currency_code)
    VALUES (${partnerId}, ${`dryrun-${partnerId.slice(0, 8)}`}, ${`dryrun-${partnerId.slice(0, 8)}`}, 'USD')
    ON CONFLICT (id) DO NOTHING
  `));
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO organizations (id, partner_id, name, slug, currency_code)
    VALUES (${orgId}, ${partnerId}, 'Uncategorised Customer', ${`dryrun-org-${orgId.slice(0, 8)}`}, 'USD')
  `));
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO users (id, partner_id, email, name)
    VALUES (${userId}, ${partnerId}, ${`dryrun-${userId}@example.test`}, 'Dry run user')
  `));
  return { orgId, userId };
}

/** A ticket with no category, plus one time entry at the given age in days. */
async function seedUncategorisedEntry(orgId: string, userId: string, ageDays: number): Promise<void> {
  const ticketId = randomUUID();
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO tickets (id, partner_id, org_id, ticket_number, subject, category_id)
    VALUES (${ticketId}, ${partnerId}, ${orgId}, ${`DR-${ticketId.slice(0, 8)}`}, 'No category', NULL)
  `));
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO time_entries (partner_id, org_id, ticket_id, user_id, started_at, ended_at, duration_minutes, currency_code)
    VALUES (${partnerId}, ${orgId}, ${ticketId}, ${userId},
            now() - (${ageDays} || ' days')::interval,
            now() - (${ageDays} || ' days')::interval + interval '30 minutes', 30, 'USD')
  `));
}

describe('labour-pricing dry run: the org/90-day query against real Postgres', () => {
  // The shared setup truncates core tenant tables before every test, so each
  // case re-seeds from scratch. Only the trailing cleanup is ours, and it has
  // to run children-before-parents: every FK here is NO ACTION.
  beforeAll(restoreLegacyLabourPricingColumns);
  afterAll(async () => {
    for (const statement of [
      sql`DELETE FROM time_entries WHERE partner_id = ${partnerId}`,
      sql`DELETE FROM tickets WHERE partner_id = ${partnerId}`,
      sql`DELETE FROM ticket_categories WHERE partner_id = ${partnerId}`,
      sql`DELETE FROM org_ticket_settings WHERE org_id IN (SELECT id FROM organizations WHERE partner_id = ${partnerId})`,
      sql`DELETE FROM organizations WHERE partner_id = ${partnerId}`,
      sql`DELETE FROM users WHERE partner_id = ${partnerId}`,
      sql`DELETE FROM partners WHERE id = ${partnerId}`,
    ]) {
      await withSystemDbAccessContext(() => db.execute(statement));
    }
    await dropLegacyLabourPricingColumns();
  });

  it('an org with NULL billable and a matching-currency rate lands under WILL START BILLING', async () => {
    const { orgId, userId } = await seed();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO org_ticket_settings (org_id, default_billable, default_hourly_rate, rate_currency)
      VALUES (${orgId}, NULL, '150.00', 'USD')
    `));
    await seedUncategorisedEntry(orgId, userId, 3);
    await seedUncategorisedEntry(orgId, userId, 10);

    const orgs = await runOrgQuery();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({
      orgId, currencyCode: 'USD', defaultBillable: null, rateCurrency: 'USD', uncategorisedEntryCount: 2,
    });

    const partners = [{ id: partnerId, name: 'Dry run partner', currencyCode: 'USD' }];
    const [report] = buildDryRunReport({ partners, categories: [], orgs });
    expect(report!.uncategorisedBecomingBillable).toEqual([
      expect.objectContaining({ orgId, orgRate: '150.00', currency: 'USD', recentEntryCount: 2 }),
    ]);
    // The rendered report is what Todd actually reads on #4628.
    const rendered = formatReport([report!]);
    expect(rendered).toContain('WILL START BILLING');
    expect(rendered).toContain(orgId);
    expect(rendered).toContain('2 entries on uncategorised tickets');
  });

  it('counts only entries INSIDE the 90-day window', async () => {
    const { orgId, userId } = await seed();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO org_ticket_settings (org_id, default_billable, default_hourly_rate, rate_currency)
      VALUES (${orgId}, NULL, '150.00', 'USD')
    `));
    await seedUncategorisedEntry(orgId, userId, 89);
    await seedUncategorisedEntry(orgId, userId, 91);

    const orgs = await runOrgQuery();
    expect(orgs[0]?.uncategorisedEntryCount).toBe(1);
  });

  it('counts only entries on tickets with NO category', async () => {
    const { orgId, userId } = await seed();
    const categoryId = randomUUID();
    const ticketId = randomUUID();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO org_ticket_settings (org_id, default_billable, default_hourly_rate, rate_currency)
      VALUES (${orgId}, NULL, '150.00', 'USD')
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ticket_categories (id, partner_id, name) VALUES (${categoryId}, ${partnerId}, 'Support')
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO tickets (id, partner_id, org_id, ticket_number, subject, category_id)
      VALUES (${ticketId}, ${partnerId}, ${orgId}, ${`DR-${ticketId.slice(0, 8)}`}, 'Categorised', ${categoryId})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO time_entries (partner_id, org_id, ticket_id, user_id, started_at, ended_at, duration_minutes, currency_code)
      VALUES (${partnerId}, ${orgId}, ${ticketId}, ${userId}, now() - interval '30 minutes', now(), 30, 'USD')
    `));
    // CONTROL: one uncategorised entry so a zero below is about the filter.
    await seedUncategorisedEntry(orgId, userId, 1);

    const orgs = await runOrgQuery();
    expect(orgs[0]?.uncategorisedEntryCount).toBe(1);
  });

  it('includes an org with NO org_ticket_settings row at all (LEFT JOIN), with NULL defaults', async () => {
    const { orgId } = await seed();
    const orgs = await runOrgQuery();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({
      orgId, defaultBillable: null, defaultHourlyRate: null, uncategorisedEntryCount: 0,
    });
    // No rate resolves, so nothing starts billing — but the org is still visible.
    const [report] = buildDryRunReport({
      partners: [{ id: partnerId, name: 'Dry run partner', currencyCode: 'USD' }],
      categories: [], orgs,
    });
    expect(report!.uncategorisedBecomingBillable).toEqual([]);
  });

  it('an org that explicitly answered billable=false is NOT flagged', async () => {
    const { orgId, userId } = await seed();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO org_ticket_settings (org_id, default_billable, default_hourly_rate, rate_currency)
      VALUES (${orgId}, false, '150.00', 'USD')
    `));
    await seedUncategorisedEntry(orgId, userId, 1);
    const orgs = await runOrgQuery();
    expect(orgs[0]?.defaultBillable).toBe(false);
    const [report] = buildDryRunReport({
      partners: [{ id: partnerId, name: 'Dry run partner', currencyCode: 'USD' }],
      categories: [], orgs,
    });
    expect(report!.uncategorisedBecomingBillable).toEqual([]);
  });
});
