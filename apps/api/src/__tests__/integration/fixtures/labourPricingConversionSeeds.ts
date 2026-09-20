import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTestDb } from '../setup';
import { legacyResolve, type LegacyCategory, type LegacyOrgSettings } from './legacyLabourPricingResolver';

interface CategorySeed extends LegacyCategory {
  name: string;
  parentIndex?: number;
  isActive?: boolean;
}
interface OrgSeed {
  name?: string;
  currency?: string;
  settings?: LegacyOrgSettings;
}
export interface Shape {
  name: string;
  categories: CategorySeed[];
  orgs?: OrgSeed[];
  partnerCurrency?: string;
  nullTicketPartner?: boolean;
}
const category = (name: string, rate: string | null = '125.00', billable = true, currency = 'USD'): CategorySeed => ({
  name, defaultBillable: billable, defaultHourlyRate: rate, rateCurrency: rate === null ? null : currency,
});
const settings = (billable: boolean | null, rate: string | null, currency = 'USD'): LegacyOrgSettings => ({
  defaultBillable: billable, defaultHourlyRate: rate, rateCurrency: currency,
});
const overlayCategories = () => [
  category('Rated'), category('Non-billable', null, false),
  category('Non-billable with rate', '200.00', false), category('Billable without rate', null),
];

// One independent partner per enumerated §9 shape. Additional org variants in
// a shape exercise the full (org × category-or-none) overlay cross-product.
export const LEGACY_SHAPES: Shape[] = [
  { name: '01 category rate', categories: [category('Rated')] },
  { name: '02 non-billable category', categories: [category('Non-billable', null, false)] },
  { name: '03 non-billable category with rate', categories: [category('Non-billable with rate', '200.00', false)] },
  { name: '04 org rate', categories: overlayCategories(), orgs: [{ settings: settings(true, '150.00') }] },
  { name: '05 org billable-only', categories: overlayCategories(), orgs: [
    { name: 'Billable override', settings: settings(true, null) },
    { name: 'Non-billable override', settings: settings(false, null) },
  ] },
  { name: '06 org NULL billable with rate', categories: overlayCategories(), orgs: [{ settings: settings(null, '150.00') }] },
  { name: '07 org row absent', categories: Array.from({ length: 7 }, (_, n) => category(`Unpriced ${n}`, null)) },
  // rate_currency is NOT NULL in the live schema; "all-NULL pricing" means
  // the two optional pricing fields, not the mandatory currency stamp.
  { name: '08 org all-NULL pricing', categories: overlayCategories(), orgs: [{ settings: settings(null, null) }] },
  { name: '09 wrong-currency org rate', categories: overlayCategories(), orgs: [
    { settings: settings(null, '135.00', 'EUR') },
    { settings: settings(true, '135.00', 'EUR') },
  ] },
  { name: '10 wrong-currency category rate', categories: [category('EUR rate', '90.00', true, 'EUR')] },
  { name: '11 duplicate case-colliding names', categories: [category('Remote'), category('remote', '125'), category('REMOTE', '125.0')] },
  { name: '12 nested same names different rates', categories: [
    category('Hardware', null), category('Software', null),
    { ...category('Support', '100.00'), parentIndex: 0 },
    { ...category('support', '200.00'), parentIndex: 1 },
    category('Support (Hardware)', '300.00'),
    { ...category('SUPPORT', '400.00'), parentIndex: 0 },
  ] },
  { name: '13 inactive categories', categories: [
    { ...category('Retired'), isActive: false },
    { ...category('Retired non-billable', null, false), isActive: false },
    { ...category('Shared'), isActive: false }, category('shared'),
  ] },
  { name: '14 category currency no org uses', partnerCurrency: 'CAD', categories: [category('EUR only', '80.00', true, 'EUR')] },
  { name: '15 org-only configuration', categories: [], orgs: [{ settings: settings(true, '175.00') }] },
  { name: '16 nothing at all', categories: [] },
  { name: '17 NULL ticket partner', categories: [category('Resolved via organization')], nullTicketPartner: true },
];

export const PRODUCTION_SHAPE: Shape = {
  name: 'production dry-run shape',
  categories: [category('Billable', '125.00'), category('Non-billable without rate', null, false),
    ...Array.from({ length: 6 }, (_, n) => category(`Non-billable rated ${n}`, '125.00', false))],
  orgs: [
    { name: 'True and 125', settings: settings(true, '125.00') },
    { name: 'Inherit coverage and 135', settings: settings(null, '135.00') },
  ],
};

export interface SeededFixture {
  shape: Shape;
  partner: { id: string; name: string; currencyCode: string };
  categories: Array<CategorySeed & { id: string; partnerId: string; parentId: string | null; isActive: boolean }>;
  orgs: Array<{ id: string; name: string; currencyCode: string; settings: LegacyOrgSettings | null }>;
  pairs: Array<{ ticketId: string; orgId: string; categoryId: string | null }>;
}

export async function seedShape(shape: Shape): Promise<SeededFixture> {
  const db = getTestDb();
  const partner = { id: randomUUID(), name: shape.name, currencyCode: shape.partnerCurrency ?? 'USD' };
  await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code)
    VALUES (${partner.id}, ${partner.name}, ${`parity-${partner.id}`}, ${partner.currencyCode})`);
  const categoryIds = shape.categories.map(() => randomUUID());
  const categories: SeededFixture['categories'] = [];
  for (const [index, seed] of shape.categories.entries()) {
    const row = { ...seed, id: categoryIds[index]!, partnerId: partner.id,
      parentId: seed.parentIndex === undefined ? null : categoryIds[seed.parentIndex]!, isActive: seed.isActive ?? true };
    await db.execute(sql`INSERT INTO ticket_categories
      (id, partner_id, name, parent_id, is_active, default_billable, default_hourly_rate, rate_currency)
      VALUES (${row.id}, ${partner.id}, ${row.name}, ${row.parentId}, ${row.isActive},
        ${row.defaultBillable}, ${row.defaultHourlyRate}, ${row.rateCurrency})`);
    // Numeric database columns normalize scale, so the frozen oracle receives
    // exactly what the real legacy resolver reads (125 -> "125.00").
    const [stored] = await db.execute(sql`SELECT default_hourly_rate FROM ticket_categories WHERE id = ${row.id}`);
    row.defaultHourlyRate = stored!.default_hourly_rate as string | null;
    categories.push(row);
  }
  const fixture: SeededFixture = { shape, partner, categories, orgs: [], pairs: [] };
  for (const [index, seed] of (shape.orgs ?? [{}]).entries()) {
    const org = { id: randomUUID(), name: seed.name ?? `${shape.name} org ${index}`,
      currencyCode: seed.currency ?? 'USD', settings: seed.settings ?? null };
    fixture.orgs.push(org);
    await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
      VALUES (${org.id}, ${partner.id}, ${org.name}, ${`parity-${org.id}`}, ${org.currencyCode})`);
    if (org.settings) {
      await db.execute(sql`INSERT INTO org_ticket_settings (org_id, default_billable, default_hourly_rate, rate_currency)
        VALUES (${org.id}, ${org.settings.defaultBillable}, ${org.settings.defaultHourlyRate}, ${org.settings.rateCurrency})`);
    }
    const userId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, partner_id, org_id, email, name)
      VALUES (${userId}, ${partner.id}, ${org.id}, ${`parity-${userId}@example.test`}, 'Parity technician')`);
    for (const cat of [...categories, null]) {
      const ticketId = randomUUID();
      await db.execute(sql`INSERT INTO tickets (id, partner_id, org_id, category_id, ticket_number, subject, source)
        VALUES (${ticketId}, ${shape.nullTicketPartner ? null : partner.id}, ${org.id}, ${cat?.id ?? null},
          ${`PARITY-${ticketId}`}, 'Conversion parity', 'manual')`);
      fixture.pairs.push({ ticketId, orgId: org.id, categoryId: cat?.id ?? null });
      const legacy = legacyResolve({ orgSettings: org.settings, category: cat, orgCurrency: org.currencyCode });
      await db.execute(sql`INSERT INTO time_entries
        (partner_id, org_id, ticket_id, user_id, started_at, ended_at, duration_minutes,
          is_billable, hourly_rate, currency_code, billing_status)
        VALUES (${partner.id}, ${org.id}, ${ticketId}, ${userId}, now() - interval '1 hour', now(), 60,
          ${legacy.isBillable}, ${legacy.hourlyRate}, ${org.currencyCode}, 'not_billed')`);
    }
  }
  return fixture;
}
