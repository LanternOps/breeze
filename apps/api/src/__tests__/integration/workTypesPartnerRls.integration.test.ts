// apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts
import './setup';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { sql } from 'drizzle-orm';

const partnerA = randomUUID();
const partnerB = randomUUID();

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

async function seedPartner(id: string, name: string) {
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO partners (id, name, slug, currency_code)
    VALUES (${id}, ${name}, ${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}, 'USD')
    ON CONFLICT (id) DO NOTHING
  `));
}

describe('work_types partner-axis RLS', () => {
  // The shared setup truncates partners before every test.
  beforeEach(async () => {
    await seedPartner(partnerA, `wt-rls-a-${partnerA.slice(0, 8)}`);
    await seedPartner(partnerB, `wt-rls-b-${partnerB.slice(0, 8)}`);
  });

  afterAll(async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM time_entries WHERE partner_id IN (${partnerA}, ${partnerB})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM ticket_categories WHERE partner_id IN (${partnerA}, ${partnerB})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM users WHERE partner_id IN (${partnerA}, ${partnerB})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM work_types WHERE partner_id IN (${partnerA}, ${partnerB})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})
    `));
  });

  it('ENABLE and FORCE row level security are both on', async () => {
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'work_types'
    `))) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('a partner-scoped context can insert and read its OWN work type', async () => {
    const id = randomUUID();
    await withDbAccessContext(partnerContext(partnerA), () =>
      db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${id}, ${partnerA}, 'Remote')`),
    );
    const rows = (await withDbAccessContext(partnerContext(partnerA), () =>
      db.execute(sql`SELECT id FROM work_types WHERE id = ${id}`),
    )) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  it('FORGE: partner B cannot insert a work type attributed to partner A (42501)', async () => {
    await expect(
      withDbAccessContext(partnerContext(partnerB), () =>
        db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${randomUUID()}, ${partnerA}, 'Forged')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('FORGE: partner B cannot READ partner A rows (zero rows, not an error)', async () => {
    const id = randomUUID();
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${id}, ${partnerA}, 'Hidden')`),
    );
    // CONTROL: the row really exists — a system-scope read sees it. Without this
    // control an empty result below would also "pass" if the INSERT had failed.
    const control = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT id FROM work_types WHERE id = ${id}`),
    )) as unknown as Array<{ id: string }>;
    expect(control).toHaveLength(1);

    const rows = (await withDbAccessContext(partnerContext(partnerB), () =>
      db.execute(sql`SELECT id FROM work_types WHERE id = ${id}`),
    )) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });

  it('FORGE: a time entry cannot point at another partner\'s work type (composite FK, 23503)', async () => {
    const wtA = randomUUID();
    const userB = randomUUID();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO users (id, partner_id, email, name)
      VALUES (${userB}, ${partnerB}, ${`wt-fk-${userB}@example.test`}, 'Work type FK user')
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO work_types (id, partner_id, name) VALUES (${wtA}, ${partnerA}, 'CrossFk')
    `));

    // System scope proves the constraint, not RLS. A real user and the exact
    // constraint name prevent an unrelated foreign-key failure from passing.
    await expect(
      withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO time_entries (partner_id, user_id, started_at, work_type_id)
        VALUES (${partnerB}, ${userB}, now(), ${wtA})
      `)),
    ).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'time_entries_work_type_partner_fk' },
    });

    const wtB = randomUUID();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO work_types (id, partner_id, name) VALUES (${wtB}, ${partnerB}, 'CrossFk')
    `));
    // Same-partner control: only the referenced work type changes.
    await expect(
      withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO time_entries (partner_id, user_id, started_at, work_type_id)
        VALUES (${partnerB}, ${userB}, now(), ${wtB})
      `)),
    ).resolves.toBeDefined();
  });

  it('FORGE: a category cannot default to another partner\'s work type (composite FK, 23503)', async () => {
    const wtA = randomUUID();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO work_types (id, partner_id, name) VALUES (${wtA}, ${partnerA}, 'CategoryFk')
    `));
    await expect(
      withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO ticket_categories (partner_id, name, default_work_type_id)
        VALUES (${partnerB}, 'Cross-partner default', ${wtA})
      `)),
    ).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'ticket_categories_default_work_type_partner_fk' },
    });
    await expect(
      withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO ticket_categories (partner_id, name, default_work_type_id)
        VALUES (${partnerA}, 'Same-partner default', ${wtA})
      `)),
    ).resolves.toBeDefined();
  });

  it('UNIQUE (partner_id, lower(name)) is case-insensitive within a partner and does NOT collide across partners', async () => {
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${randomUUID()}, ${partnerA}, 'On-site')`),
    );
    await expect(
      withSystemDbAccessContext(() =>
        db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${randomUUID()}, ${partnerA}, 'ON-SITE')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    // Same name under a DIFFERENT partner is fine.
    await expect(
      withSystemDbAccessContext(() =>
        db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${randomUUID()}, ${partnerB}, 'On-site')`),
      ),
    ).resolves.toBeDefined();
  });
});
