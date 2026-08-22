import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, partners, tickets, users } from '../../db/schema';

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
