import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, invoices, quotes } from '../../db/schema';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

const RUN = !!process.env.DATABASE_URL;

interface Fixture {
  partnerId: string;
  orgId: string;
}

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `DocLoc ${suffix}`, slug: `docloc-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `DocLoc Org ${suffix}`, slug: `docloc-org-${suffix}`, currencyCode: 'USD'
    }).returning({ id: organizations.id });
    return { partnerId, orgId: o!.id };
  });
}

/**
 * Multi-currency wave 5 (#3777): `document_locale` render-locale snapshot on
 * invoices + quotes. Nullable varchar(16), no default, no backfill.
 */
describe.runIf(RUN)('document_locale snapshot columns', () => {
  it('round-trips documentLocale on an invoice', async () => {
    const f = await seedFixture();
    const id = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(invoices).values({
        partnerId: f.partnerId, orgId: f.orgId, status: 'draft', currencyCode: 'USD',
        invoiceNumber: `INV-LOC-${Math.random().toString(36).slice(2, 8)}`,
        issueDate: new Date().toISOString().slice(0, 10), dueDate: new Date().toISOString().slice(0, 10),
        documentLocale: 'fr-CA'
      }).returning({ id: invoices.id });
      return row!.id;
    });
    const [read] = await withSystemDbAccessContext(() =>
      db.select({ documentLocale: invoices.documentLocale }).from(invoices).where(eq(invoices.id, id))
    );
    expect(read?.documentLocale).toBe('fr-CA');
  });

  it('round-trips documentLocale on a quote', async () => {
    const f = await seedFixture();
    const id = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(quotes).values({
        partnerId: f.partnerId, orgId: f.orgId, currencyCode: 'USD',
        documentLocale: 'fr-CA'
      }).returning({ id: quotes.id });
      return row!.id;
    });
    const [read] = await withSystemDbAccessContext(() =>
      db.select({ documentLocale: quotes.documentLocale }).from(quotes).where(eq(quotes.id, id))
    );
    expect(read?.documentLocale).toBe('fr-CA');
  });

  it('defaults to NULL (no default, no backfill) when not stamped', async () => {
    const f = await seedFixture();
    const [inv, q] = await withSystemDbAccessContext(async () => {
      const [i] = await db.insert(invoices).values({
        partnerId: f.partnerId, orgId: f.orgId, status: 'draft', currencyCode: 'USD',
        invoiceNumber: `INV-LOC-${Math.random().toString(36).slice(2, 8)}`,
        issueDate: new Date().toISOString().slice(0, 10), dueDate: new Date().toISOString().slice(0, 10)
      }).returning({ documentLocale: invoices.documentLocale });
      const [qq] = await db.insert(quotes).values({
        partnerId: f.partnerId, orgId: f.orgId, currencyCode: 'USD'
      }).returning({ documentLocale: quotes.documentLocale });
      return [i, qq];
    });
    expect(inv?.documentLocale).toBeNull();
    expect(q?.documentLocale).toBeNull();
  });

  it('information_schema has document_locale varchar(16), nullable, no default on both tables', async () => {
    const rows = await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT table_name, data_type, character_maximum_length, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name IN ('invoices', 'quotes')
          AND column_name = 'document_locale'
        ORDER BY table_name
      `)
    ) as unknown as {
      table_name: string; data_type: string; character_maximum_length: number | null;
      is_nullable: string; column_default: string | null;
    }[];
    expect(rows.map((r) => r.table_name)).toEqual(['invoices', 'quotes']);
    for (const r of rows) {
      expect(r.data_type).toBe('character varying');
      expect(r.character_maximum_length).toBe(16);
      expect(r.is_nullable).toBe('YES');
      expect(r.column_default).toBeNull();
    }
  });

  it('is classified as included in the tenant export policy for both tables', () => {
    for (const table of ['invoices', 'quotes'] as const) {
      const decision = CORE_TENANT_EXPORT_POLICY[table]?.columns['document_locale'];
      expect(decision, `${table}.document_locale must be classified`).toBeDefined();
      expect(decision?.decision).toBe('include');
    }
  });
});
