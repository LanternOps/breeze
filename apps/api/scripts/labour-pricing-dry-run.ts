/**
 * READ-ONLY dry run of the W02 labour-pricing conversion (spec §3.6).
 *
 * WHY THIS EXISTS: W02 ships a row-writing migration over production BILLING
 * data. Spec §11's focused review made the clean cut conditional on a human
 * reading this report on BOTH regions first. Agents have no production SSH, so
 * TODD runs this and records the output on LanternOps/breeze#4628. That
 * recorded read is the STOP gate at the top of the W02 plan.
 *
 * It writes NOTHING. The transaction is opened READ ONLY so Postgres refuses a
 * write regardless of what the code says, and
 * labour-pricing-dry-run.readonly.test.ts greps this file for write verbs.
 *
 *   pnpm --filter @breeze/api dry-run:labour-pricing
 *
 * Run it on each region in turn and paste BOTH outputs onto #4628.
 *
 * Still shipped after #4628 W04b removed the legacy columns: a self-hoster
 * jumping from a pre-billing-profiles release straight to a release with the
 * removal runs the conversion and the removal in one boot, and this script is
 * how they read the conversion's effect first — against their NOT-yet-upgraded
 * database, where the columns still exist. On an upgraded database it says so
 * and points at legacy_labour_pricing_archive instead of failing.
 */
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../src/db';
import { buildDryRunReport, formatReport } from './labour-pricing-dry-run.lib';

async function main() {
  // System scope is mandatory: this process has no request and therefore no
  // partner context. breeze_current_scope() defaults to 'none', under which a
  // FORCE ROW LEVEL SECURITY table returns ZERO ROWS SILENTLY -- the report
  // would print "nothing to convert" and be believed.
  const result = await withSystemDbAccessContext(async () => {
    await db.execute(sql`SET TRANSACTION READ ONLY`);

    // All six legacy columns -> report; none -> already upgraded; anything
    // else is a half-applied schema this report cannot describe honestly.
    const [legacy] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('ticket_categories', 'org_ticket_settings')
         AND column_name IN ('default_billable', 'default_hourly_rate', 'rate_currency')
    `)) as unknown as Array<{ n: number }>;
    const present = legacy?.n ?? 0;
    if (present === 0) return null;
    if (present !== 6) {
      throw new Error(`found ${present} of the 6 legacy labour-pricing columns; expected all 6 (not yet upgraded) or none (upgraded)`);
    }

    const partners = (await db.execute(sql`
      SELECT id, name, currency_code AS "currencyCode" FROM partners ORDER BY name
    `)) as unknown as Array<{ id: string; name: string; currencyCode: string }>;

    const categories = (await db.execute(sql`
      SELECT id, partner_id AS "partnerId", parent_id AS "parentId", name, is_active AS "isActive",
             default_billable AS "defaultBillable", default_hourly_rate AS "defaultHourlyRate",
             rate_currency AS "rateCurrency"
        FROM ticket_categories
       ORDER BY partner_id, name
    `)) as unknown as Parameters<typeof buildDryRunReport>[0]['categories'];

    // uncategorisedEntryCount is the 90-day count of time entries on tickets
    // with NO category -- the population the money-moving difference moves.
    const orgs = (await db.execute(sql`
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
    `)) as unknown as Parameters<typeof buildDryRunReport>[0]['orgs'];

    return { partners, categories, orgs };
  });

  if (result === null) {
    process.stdout.write(
      'This database has already been upgraded past the labour-pricing conversion: the legacy\n'
      + 'pricing columns are gone (#4628 W04b), so there is nothing left to convert. Their last\n'
      + 'values, and why the conversion skipped any of them, are in legacy_labour_pricing_archive.\n',
    );
    return;
  }
  const { partners, categories, orgs } = result;
  process.stdout.write(formatReport(buildDryRunReport({ partners, categories, orgs })));
  process.stdout.write('\n');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[labour-pricing-dry-run] FAILED — do NOT treat a failed run as "nothing to convert":', err);
  process.exit(1);
});
