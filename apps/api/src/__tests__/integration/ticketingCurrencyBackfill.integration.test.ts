/**
 * Backfill anomaly-count test for the wave-4 ticketing currency migration
 * (multi-currency #3776, spec §14).
 *
 * The live test database already has `2026-08-30-ticketing-currency.sql`
 * applied, so the migration's backfill UPDATEs are no-ops there. To prove the
 * backfill itself — which rows it picks, which currency it copies from, and
 * that it REPORTS each count via RAISE WARNING (repo convention for cleanup
 * statements) — this test replays the migration file inside ONE transaction
 * that is deliberately rolled back:
 *
 *   1. drop the NOT NULL / CHECK guards the migration installs (DDL is
 *      transactional, so the live schema is untouched after ROLLBACK);
 *   2. insert pre-migration-shaped rows with NULL currency;
 *   3. `client.unsafe(<migration file>)` on a dedicated postgres.js client
 *      whose `onnotice` collects every NOTICE/WARNING message;
 *   4. assert the warning counts + the stamped currencies;
 *   5. ROLLBACK.
 *
 * Partner bills in CAD and the org in EUR on purpose: org-owned rows must take
 * the ORG currency, while the standalone rated entry and the category must
 * take the PARTNER currency — a single-currency fixture could not tell the two
 * sources apart. `autoMigrate.test.ts` keeps the migration path reference honest.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, partners, tickets, users } from '../../db/schema';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

const MIGRATION_FILE = path.join(__dirname, '../../../migrations/2026-08-30-ticketing-currency.sql');

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  ticketId: string;
}

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({
      name: `Backfill ${suffix}`,
      slug: `backfill-${suffix}`,
      type: 'msp',
      plan: 'pro',
      status: 'active',
      currencyCode: 'CAD',
    }).returning({ id: partners.id });
    const partnerId = partner!.id;

    const [organization] = await db.insert(organizations).values({
      partnerId,
      name: `Backfill Org ${suffix}`,
      slug: `backfill-org-${suffix}`,
      currencyCode: 'EUR',
    }).returning({ id: organizations.id });
    const orgId = organization!.id;

    const [user] = await db.insert(users).values({
      partnerId,
      orgId,
      email: `backfill-${suffix}@example.test`,
      name: `Backfill Tech ${suffix}`,
      status: 'active',
    }).returning({ id: users.id });

    const [ticket] = await db.insert(tickets).values({
      partnerId,
      orgId,
      ticketNumber: `BF-${suffix}`,
      subject: `Backfill ${suffix}`,
      source: 'manual',
    }).returning({ id: tickets.id });

    return { partnerId, orgId, userId: user!.id, ticketId: ticket!.id };
  });
}

class RollbackSignal extends Error {
  constructor() {
    super('intentional rollback');
  }
}

describe.runIf(RUN)('ticketing currency migration backfill (wave 4 #3776)', () => {
  it('backfills NULL currencies from the owning org / partner and reports every count', async () => {
    const f = await seedFixture();
    const migrationSql = readFileSync(MIGRATION_FILE, 'utf8');
    const notices: string[] = [];
    const client = postgres(DATABASE_URL, { max: 1, onnotice: (n) => { notices.push(n.message ?? ''); } });

    let stamped: {
      entries: Array<{ org_id: string | null; hourly_rate: string | null; currency_code: string | null }>;
      parts: Array<{ currency_code: string | null }>;
      settings: Array<{ rate_currency: string | null }>;
      categories: Array<{ rate_currency: string | null }>;
    } | undefined;

    try {
      await client.begin(async (tx) => {
        // 1) Relax the guards the migration installs so NULL-currency rows
        //    can exist again (pre-migration shape).
        await tx.unsafe(`
          ALTER TABLE ticket_parts ALTER COLUMN currency_code DROP NOT NULL;
          ALTER TABLE org_ticket_settings ALTER COLUMN rate_currency DROP NOT NULL;
          ALTER TABLE time_entries DROP CONSTRAINT time_entries_currency_required_when_org_chk;
          ALTER TABLE time_entries DROP CONSTRAINT time_entries_currency_required_when_rate_chk;
          ALTER TABLE ticket_categories DROP CONSTRAINT ticket_categories_rate_currency_chk;
        `);

        // 2) Pre-migration rows: 2 org-linked entries, 1 standalone RATED
        //    entry, 1 standalone money-less entry (must stay NULL), 1 part,
        //    1 org settings row, 1 rated category, 1 rate-less category
        //    (must stay NULL).
        await tx`
          INSERT INTO time_entries (partner_id, org_id, ticket_id, user_id, started_at, ended_at, duration_minutes, is_billable, hourly_rate)
          VALUES
            (${f.partnerId}, ${f.orgId}, ${f.ticketId}, ${f.userId}, now() - interval '2 hours', now() - interval '1 hour', 60, true, '100.00'),
            (${f.partnerId}, ${f.orgId}, ${f.ticketId}, ${f.userId}, now() - interval '1 hour', now(), 60, false, NULL),
            (${f.partnerId}, NULL, NULL, ${f.userId}, now() - interval '1 hour', now(), 60, false, '50.00'),
            (${f.partnerId}, NULL, NULL, ${f.userId}, now() - interval '1 hour', now(), 60, false, NULL)
        `;
        await tx`
          INSERT INTO ticket_parts (ticket_id, org_id, description, quantity, unit_price, added_by)
          VALUES (${f.ticketId}, ${f.orgId}, 'Pre-migration part', '1.00', '25.00', ${f.userId})
        `;
        await tx`
          INSERT INTO org_ticket_settings (org_id, default_hourly_rate, default_billable)
          VALUES (${f.orgId}, '80.00', true)
        `;
        await tx`
          INSERT INTO ticket_categories (partner_id, name, default_hourly_rate)
          VALUES (${f.partnerId}, 'Rated category', '120.00'),
                 (${f.partnerId}, 'Rate-less category', NULL)
        `;

        // 3) Replay the migration file exactly as autoMigrate would.
        await tx.unsafe(migrationSql);

        // 4) Read back inside the transaction (the rows die with the ROLLBACK).
        stamped = {
          entries: await tx`
            SELECT org_id, hourly_rate, currency_code FROM time_entries
            WHERE partner_id = ${f.partnerId}
            ORDER BY org_id NULLS LAST, hourly_rate NULLS LAST
          `,
          parts: await tx`SELECT currency_code FROM ticket_parts WHERE org_id = ${f.orgId}`,
          settings: await tx`SELECT rate_currency FROM org_ticket_settings WHERE org_id = ${f.orgId}`,
          categories: await tx`
            SELECT rate_currency FROM ticket_categories
            WHERE partner_id = ${f.partnerId} ORDER BY default_hourly_rate NULLS LAST
          `,
        };

        // 5) Never commit: the DDL relaxations must not outlive this test.
        throw new RollbackSignal();
      });
    } catch (error) {
      if (!(error instanceof RollbackSignal)) throw error;
    } finally {
      await client.end({ timeout: 1 });
    }

    // Anomaly counts were REPORTED (repo convention: RAISE WARNING with ROW_COUNT).
    const warnings = notices.filter((message) => message.includes('multi-currency: backfilled'));
    expect(warnings).toHaveLength(5);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('backfilled currency_code on 2 time_entries from owning org'),
      expect.stringContaining('backfilled currency_code on 1 standalone rated time_entries from partner'),
      expect.stringContaining('backfilled currency_code on 1 ticket_parts from owning org'),
      expect.stringContaining('backfilled rate_currency on 1 org_ticket_settings from owning org'),
      expect.stringContaining('backfilled rate_currency on 1 ticket_categories from owning partner'),
    ]));
    // Every currency landed on the supported list — no NOT VALID fallback warning.
    expect(notices.some((message) => message.includes('off-list currency rows'))).toBe(false);

    expect(stamped).toBeDefined();
    // Org-linked entries take the ORG currency; the standalone rated entry
    // takes the PARTNER currency; the money-less standalone entry stays NULL.
    expect(stamped!.entries).toEqual([
      { org_id: f.orgId, hourly_rate: '100.00', currency_code: 'EUR' },
      { org_id: f.orgId, hourly_rate: null, currency_code: 'EUR' },
      { org_id: null, hourly_rate: '50.00', currency_code: 'CAD' },
      { org_id: null, hourly_rate: null, currency_code: null },
    ]);
    expect(stamped!.parts).toEqual([{ currency_code: 'EUR' }]);
    expect(stamped!.settings).toEqual([{ rate_currency: 'EUR' }]);
    expect(stamped!.categories).toEqual([{ rate_currency: 'CAD' }, { rate_currency: null }]);

    // ROLLBACK restored the live schema: every guard the test relaxed is back.
    const liveGuards = await withSystemDbAccessContext(() => db.execute(
      sql`
        SELECT
          (SELECT is_nullable FROM information_schema.columns
             WHERE table_name = 'ticket_parts' AND column_name = 'currency_code') AS parts_nullable,
          (SELECT is_nullable FROM information_schema.columns
             WHERE table_name = 'org_ticket_settings' AND column_name = 'rate_currency') AS settings_nullable,
          (SELECT count(*)::int FROM pg_constraint WHERE conname IN (
             'time_entries_currency_required_when_org_chk',
             'time_entries_currency_required_when_rate_chk',
             'ticket_categories_rate_currency_chk')) AS checks
      `,
    )) as unknown as Array<{ parts_nullable: string; settings_nullable: string; checks: number }>;
    expect(liveGuards[0]).toEqual({ parts_nullable: 'NO', settings_nullable: 'NO', checks: 3 });

    // And none of the pre-migration rows survived.
    const survivors = await withSystemDbAccessContext(() => db.execute(
      sql`SELECT count(*)::int AS n FROM time_entries WHERE partner_id = ${f.partnerId}`,
    )) as unknown as Array<{ n: number }>;
    expect(survivors[0]?.n).toBe(0);
  });
});
