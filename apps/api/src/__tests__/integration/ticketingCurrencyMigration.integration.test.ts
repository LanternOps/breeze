import './setup';
import { describe, expect, it, vi } from 'vitest';

// Lifecycle events are fire-and-forget BullMQ side effects, not the snapshot
// behaviour under test (same rationale as timeEntryRace).
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  organizations, orgTicketSettings, partners, ticketCategories, ticketParts, tickets, timeEntries, users,
} from '../../db/schema';
import { updateTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';
import { upsertOrgTicketSettings } from '../../services/ticketConfigService';
import { ticketCategoriesRoutes } from '../../routes/ticketCategories';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;

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
      name: `Ticket Cur ${suffix}`,
      slug: `ticket-cur-${suffix}`,
      type: 'msp',
      plan: 'pro',
      status: 'active',
      currencyCode: 'USD',
    }).returning({ id: partners.id });
    const partnerId = partner!.id;

    const [organization] = await db.insert(organizations).values({
      partnerId,
      name: `Ticket Cur Org ${suffix}`,
      slug: `ticket-cur-org-${suffix}`,
      currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const orgId = organization!.id;

    const [user] = await db.insert(users).values({
      partnerId,
      orgId,
      email: `ticket-cur-${suffix}@example.test`,
      name: `Ticket Cur Tech ${suffix}`,
      status: 'active',
    }).returning({ id: users.id });
    const userId = user!.id;

    const [ticket] = await db.insert(tickets).values({
      partnerId,
      orgId,
      ticketNumber: `TC-${suffix}`,
      subject: `Ticket currency migration ${suffix}`,
      source: 'manual',
    }).returning({ id: tickets.id });

    return { partnerId, orgId, userId, ticketId: ticket!.id };
  });
}

function sqlstate(error: unknown): string | undefined {
  const wrapped = error as { code?: string; cause?: { code?: string } } | undefined;
  return wrapped?.cause?.code ?? wrapped?.code;
}

async function expectSqlstate(operation: Promise<unknown>, expected: string): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(sqlstate(caught)).toBe(expected);
}

describe.runIf(RUN)('ticketing currency migration (wave 4 #3776)', () => {
  it('installs the four columns with the required nullability and all named constraints', async () => {
    const columns = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE (table_name, column_name) IN (
        ('time_entries', 'currency_code'),
        ('ticket_parts', 'currency_code'),
        ('org_ticket_settings', 'rate_currency'),
        ('ticket_categories', 'rate_currency')
      )
      ORDER BY table_name, column_name
    `)) as unknown as Array<{ table_name: string; column_name: string; is_nullable: string }>;

    expect(columns).toEqual([
      { table_name: 'org_ticket_settings', column_name: 'rate_currency', is_nullable: 'NO' },
      { table_name: 'ticket_categories', column_name: 'rate_currency', is_nullable: 'YES' },
      { table_name: 'ticket_parts', column_name: 'currency_code', is_nullable: 'NO' },
      { table_name: 'time_entries', column_name: 'currency_code', is_nullable: 'YES' },
    ]);

    const constraints = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT conname AS name
      FROM pg_constraint
      WHERE conname IN (
        'time_entries_currency_required_when_org_chk',
        'time_entries_currency_required_when_rate_chk',
        'ticket_categories_rate_currency_chk',
        'time_entries_currency_code_fkey',
        'ticket_parts_currency_code_fkey',
        'org_ticket_settings_rate_currency_fkey',
        'ticket_categories_rate_currency_fkey'
      )
      ORDER BY conname
    `)) as unknown as Array<{ name: string }>;

    expect(constraints.map((constraint) => constraint.name)).toEqual([
      'org_ticket_settings_rate_currency_fkey',
      'ticket_categories_rate_currency_chk',
      'ticket_categories_rate_currency_fkey',
      'ticket_parts_currency_code_fkey',
      'time_entries_currency_code_fkey',
      'time_entries_currency_required_when_org_chk',
      'time_entries_currency_required_when_rate_chk',
    ]);
  });

  it('requires time-entry currency for an org or rate but permits money-less standalone entries', async () => {
    const fixture = await seedFixture();

    await expectSqlstate(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO time_entries (partner_id, org_id, user_id, started_at, ended_at, is_billable)
      VALUES (${fixture.partnerId}, ${fixture.orgId}, ${fixture.userId}, now(), now(), false)
    `)), '23514');

    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO time_entries (partner_id, org_id, user_id, started_at, ended_at, is_billable)
      VALUES (${fixture.partnerId}, NULL, ${fixture.userId}, now(), now(), false)
    `))).resolves.toBeDefined();

    await expectSqlstate(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO time_entries (partner_id, org_id, user_id, started_at, ended_at, is_billable, hourly_rate)
      VALUES (${fixture.partnerId}, NULL, ${fixture.userId}, now(), now(), false, '50.00')
    `)), '23514');

    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO time_entries (
        partner_id, org_id, user_id, started_at, ended_at, is_billable, hourly_rate, currency_code
      ) VALUES (${fixture.partnerId}, NULL, ${fixture.userId}, now(), now(), false, '50.00', 'USD')
    `))).resolves.toBeDefined();
  });

  it('requires part currency and rejects unsupported currency codes', async () => {
    const fixture = await seedFixture();

    await expectSqlstate(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ticket_parts (ticket_id, org_id, description, quantity, unit_price)
      VALUES (${fixture.ticketId}, ${fixture.orgId}, 'No currency part', '1.00', '25.00')
    `)), '23502');

    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ticket_parts (
        ticket_id, org_id, description, quantity, unit_price, currency_code
      ) VALUES (${fixture.ticketId}, ${fixture.orgId}, 'USD part', '1.00', '25.00', 'USD')
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    await expectSqlstate(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ticket_parts SET currency_code = 'ZZZ' WHERE id = ${rows[0]!.id}
    `)), '23503');
  });

  it('requires category rate currency only when a default hourly rate is present', async () => {
    const fixture = await seedFixture();

    await expectSqlstate(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ticket_categories (partner_id, name, default_hourly_rate)
      VALUES (${fixture.partnerId}, 'Rated without currency', '100.00')
    `)), '23514');

    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ticket_categories (partner_id, name, default_hourly_rate)
      VALUES (${fixture.partnerId}, 'No rate or currency', NULL)
    `))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Snapshot permanence (Task 19): currency snapshots are written once and never
// restamped by rate edits, org/partner currency flips, or same-value resends.
// ---------------------------------------------------------------------------

function partnerCtx(f: Fixture): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId],
    accessiblePartnerIds: [f.partnerId], userId: f.userId,
  };
}

function timeActor(f: Fixture): TimeEntryActor {
  return { userId: f.userId, partnerId: f.partnerId, manageAll: true, accessibleOrgIds: [f.orgId] };
}

async function seedMoneyRows(f: Fixture): Promise<{ linkedEntryId: string; standaloneEntryId: string; partId: string }> {
  return withSystemDbAccessContext(async () => {
    const now = new Date();
    const [linked] = await db.insert(timeEntries).values({
      partnerId: f.partnerId, orgId: f.orgId, ticketId: f.ticketId, userId: f.userId,
      startedAt: new Date(now.getTime() - 3_600_000), endedAt: now, durationMinutes: 60,
      description: 'Linked work', isBillable: true, hourlyRate: '100.00',
      billingStatus: 'not_billed', currencyCode: 'USD',
    }).returning({ id: timeEntries.id });
    const [standalone] = await db.insert(timeEntries).values({
      partnerId: f.partnerId, orgId: null, ticketId: null, userId: f.userId,
      startedAt: new Date(now.getTime() - 3_600_000), endedAt: now, durationMinutes: 60,
      description: 'Standalone work', isBillable: false, hourlyRate: '50.00',
      billingStatus: 'not_billed', currencyCode: 'USD',
    }).returning({ id: timeEntries.id });
    const [part] = await db.insert(ticketParts).values({
      ticketId: f.ticketId, orgId: f.orgId, description: 'SSD', quantity: '1.00', unitPrice: '120.00',
      currencyCode: 'USD', isBillable: true, billingStatus: 'not_billed', addedBy: f.userId,
    }).returning({ id: ticketParts.id });
    await db.insert(orgTicketSettings).values({
      orgId: f.orgId, defaultHourlyRate: '80.00', defaultBillable: true, rateCurrency: 'USD',
    });
    return { linkedEntryId: linked!.id, standaloneEntryId: standalone!.id, partId: part!.id };
  });
}

async function readEntry(id: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ hourlyRate: timeEntries.hourlyRate, currencyCode: timeEntries.currencyCode })
    .from(timeEntries).where(eq(timeEntries.id, id)));
  return row;
}

async function readSettings(orgId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      defaultHourlyRate: orgTicketSettings.defaultHourlyRate,
      rateCurrency: orgTicketSettings.rateCurrency,
      defaultBillable: orgTicketSettings.defaultBillable,
      slaOverrides: orgTicketSettings.slaOverrides,
    })
    .from(orgTicketSettings).where(eq(orgTicketSettings.orgId, orgId)));
  return row;
}

async function flipOrgCurrency(orgId: string, currencyCode: string): Promise<void> {
  await withSystemDbAccessContext(() => db.update(organizations).set({ currencyCode }).where(eq(organizations.id, orgId)));
}

describe.runIf(RUN)('ticketing currency snapshot permanence (wave 4 #3776)', () => {
  it('(a) editing hourly_rate never restamps currency_code — linked and standalone entries alike', async () => {
    const f = await seedFixture();
    const rows = await seedMoneyRows(f);

    await withDbAccessContext(partnerCtx(f), () => updateTimeEntry(rows.linkedEntryId, { hourlyRate: 200 }, timeActor(f)));
    expect(await readEntry(rows.linkedEntryId)).toEqual({ hourlyRate: '200.00', currencyCode: 'USD' });

    // Even after the org AND partner move to GBP, a rate edit is still not a restamp.
    await flipOrgCurrency(f.orgId, 'GBP');
    await withSystemDbAccessContext(() => db.update(partners).set({ currencyCode: 'GBP' }).where(eq(partners.id, f.partnerId)));
    await withDbAccessContext(partnerCtx(f), () => updateTimeEntry(rows.linkedEntryId, { hourlyRate: 250 }, timeActor(f)));
    expect(await readEntry(rows.linkedEntryId)).toEqual({ hourlyRate: '250.00', currencyCode: 'USD' });
    await withDbAccessContext(partnerCtx(f), () => updateTimeEntry(rows.standaloneEntryId, { hourlyRate: 75 }, timeActor(f)));
    expect(await readEntry(rows.standaloneEntryId)).toEqual({ hourlyRate: '75.00', currencyCode: 'USD' });
  });

  it('(b) flipping organizations.currency_code leaves every existing entry, part and org-settings row untouched', async () => {
    const f = await seedFixture();
    const rows = await seedMoneyRows(f);

    await flipOrgCurrency(f.orgId, 'GBP');

    expect(await readEntry(rows.linkedEntryId)).toEqual({ hourlyRate: '100.00', currencyCode: 'USD' });
    expect(await readEntry(rows.standaloneEntryId)).toEqual({ hourlyRate: '50.00', currencyCode: 'USD' });
    const [part] = await withSystemDbAccessContext(() => db
      .select({ unitPrice: ticketParts.unitPrice, currencyCode: ticketParts.currencyCode })
      .from(ticketParts).where(eq(ticketParts.id, rows.partId)));
    expect(part).toEqual({ unitPrice: '120.00', currencyCode: 'USD' });
    expect(await readSettings(f.orgId)).toMatchObject({ defaultHourlyRate: '80.00', rateCurrency: 'USD' });
  });

  it('(c) org ticket settings restamp rate_currency only when the stored rate actually changes', async () => {
    const f = await seedFixture();
    await seedMoneyRows(f);
    await flipOrgCurrency(f.orgId, 'GBP');

    // Billability-only edit after the flip: the rate is untouched, so is its currency.
    await withDbAccessContext(partnerCtx(f), () => upsertOrgTicketSettings(f.orgId, { defaultBillable: false }));
    expect(await readSettings(f.orgId)).toMatchObject({ defaultHourlyRate: '80.00', rateCurrency: 'USD', defaultBillable: false });

    // The exact shape the editor sends on an SLA-only save: it RESENDS the
    // same rate. `IS DISTINCT FROM excluded.default_hourly_rate` must see no
    // change and keep the historical USD pair.
    await withDbAccessContext(partnerCtx(f), () => upsertOrgTicketSettings(f.orgId, {
      slaOverrides: { high: { responseMinutes: 30, resolutionMinutes: 240 } },
      defaultHourlyRate: 80,
      defaultBillable: true,
    }));
    expect(await readSettings(f.orgId)).toMatchObject({
      defaultHourlyRate: '80.00', rateCurrency: 'USD', defaultBillable: true,
      slaOverrides: { high: { responseMinutes: 30, resolutionMinutes: 240 } },
    });

    // A genuinely new number is new money entered under the CURRENT org currency.
    await withDbAccessContext(partnerCtx(f), () => upsertOrgTicketSettings(f.orgId, { defaultHourlyRate: 90 }));
    expect(await readSettings(f.orgId)).toMatchObject({ defaultHourlyRate: '90.00', rateCurrency: 'GBP' });
  });

  it('(d) PATCH /ticket-categories/:id restamps rate_currency only for a new rate value after a partner currency flip', async () => {
    const adminDb = getTestDb();
    // Partner-scope environment: wildcard permissions + orgAccess 'all' so the
    // partner-wide category gate (canManagePartnerWidePolicies) passes.
    const env = await setupTestEnvironment({ scope: 'partner' });
    await adminDb.update(partners).set({ currencyCode: 'USD' }).where(eq(partners.id, env.partner.id));
    const [category] = await adminDb.insert(ticketCategories).values({
      partnerId: env.partner.id, name: 'Snapshot category', defaultHourlyRate: '100.00', rateCurrency: 'USD',
    }).returning({ id: ticketCategories.id });

    const app = new Hono();
    app.route('/ticket-categories', ticketCategoriesRoutes);
    const patch = (body: Record<string, unknown>) => app.request(`/ticket-categories/${category!.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const read = async () => {
      const [row] = await adminDb
        .select({ name: ticketCategories.name, defaultHourlyRate: ticketCategories.defaultHourlyRate, rateCurrency: ticketCategories.rateCurrency })
        .from(ticketCategories).where(eq(ticketCategories.id, category!.id));
      return row;
    };

    await adminDb.update(partners).set({ currencyCode: 'GBP' }).where(eq(partners.id, env.partner.id));

    // The editor resends the rate alongside a rename — same number, no restamp.
    const renamed = await patch({ name: 'renamed', defaultHourlyRate: 100 });
    expect(renamed.status, await renamed.text()).toBe(200);
    expect(await read()).toEqual({ name: 'renamed', defaultHourlyRate: '100.00', rateCurrency: 'USD' });

    // A new number restamps to the partner's CURRENT currency.
    const repriced = await patch({ defaultHourlyRate: 125 });
    expect(repriced.status, await repriced.text()).toBe(200);
    expect(await read()).toEqual({ name: 'renamed', defaultHourlyRate: '125.00', rateCurrency: 'GBP' });
  });
});
