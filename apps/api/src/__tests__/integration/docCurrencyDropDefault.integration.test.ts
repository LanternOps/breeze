import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, invoices, quotes, contracts } from '../../db/schema';

const RUN = !!process.env.DATABASE_URL;

interface Fixture {
  partnerId: string;
  orgId: string;
}

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `NoDef ${suffix}`, slug: `nodef-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `NoDef Org ${suffix}`, slug: `nodef-org-${suffix}`, currencyCode: 'USD'
    }).returning({ id: organizations.id });
    return { partnerId, orgId: o!.id };
  });
}

/** postgres.js nests the SQLSTATE differently depending on where the tx aborts. */
function sqlstate(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
}

// Wave 2 (#3774): every document constructor stamps currency explicitly, so the
// DEFAULT 'USD' backstop is gone. A currency-less insert must be a loud 23502
// (NOT NULL violation), never a silent USD document.
describe.runIf(RUN)('document currency columns have no DEFAULT (spec §5 fail-loudly)', () => {
  it('invoices insert without currencyCode fails 23502', async () => {
    const f = await seedFixture();
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        // @ts-expect-error — deliberately omitting the now-required currencyCode
        db.insert(invoices).values({ partnerId: f.partnerId, orgId: f.orgId, status: 'draft' })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect(sqlstate(caught)).toBe('23502');
  });

  it('quotes insert without currencyCode fails 23502', async () => {
    const f = await seedFixture();
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        // @ts-expect-error — deliberately omitting the now-required currencyCode
        db.insert(quotes).values({ partnerId: f.partnerId, orgId: f.orgId })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect(sqlstate(caught)).toBe('23502');
  });

  it('contracts insert without currencyCode fails 23502', async () => {
    const f = await seedFixture();
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        // @ts-expect-error — deliberately omitting the now-required currencyCode
        db.insert(contracts).values({
          partnerId: f.partnerId, orgId: f.orgId, name: 'no-currency',
          intervalMonths: 1, startDate: '2026-07-01'
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect(sqlstate(caught)).toBe('23502');
  });

  it('information_schema shows no column_default on any document currency_code', async () => {
    const rows = await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT table_name, column_default
        FROM information_schema.columns
        WHERE table_name IN ('invoices', 'quotes', 'contracts')
          AND column_name = 'currency_code'
        ORDER BY table_name
      `)
    ) as unknown as { table_name: string; column_default: string | null }[];
    expect(rows.map((r) => r.table_name)).toEqual(['contracts', 'invoices', 'quotes']);
    for (const r of rows) {
      expect(r.column_default).toBeNull();
    }
  });
});
