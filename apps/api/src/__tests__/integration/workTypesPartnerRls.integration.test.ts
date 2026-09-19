// apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts
import './setup';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { sql } from 'drizzle-orm';
import { cascadeDeletePartner } from '../../services/tenantCascade';

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

  // PARTNER ERASURE (plan Task 14 Step 2). `work_types` is reached by
  // cascadeDeletePartner's information_schema `partner_id` sweep, ordered by
  // topologicalCascadeOrder's pg_constraint read -- there is no static list to
  // register it in, so nothing in CI would notice if the ordering were wrong.
  // Both new FKs into work_types are NO ACTION composites, so if time_entries
  // or ticket_categories were swept AFTER work_types the purge would abort with
  // 23503 and the partner would be left half-erased.
  it('cascadeDeletePartner erases a partner whose work types are referenced by a category and a time entry', async () => {
    const wt = randomUUID();
    const user = randomUUID();
    const category = randomUUID();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO work_types (id, partner_id, name) VALUES (${wt}, ${partnerA}, 'Erasure')
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ticket_categories (id, partner_id, name, default_work_type_id)
      VALUES (${category}, ${partnerA}, 'Erasure category', ${wt})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO users (id, partner_id, email, name)
      VALUES (${user}, ${partnerA}, ${`wt-erasure-${user}@example.test`}, 'Erasure user')
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO time_entries (partner_id, user_id, started_at, work_type_id)
      VALUES (${partnerA}, ${user}, now(), ${wt})
    `));

    // CONTROL: the referencing rows really exist, so a clean purge below is
    // evidence about THESE FK edges and not about an empty partner.
    const before = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT
        (SELECT count(*) FROM work_types WHERE partner_id = ${partnerA}) AS work_types,
        (SELECT count(*) FROM time_entries WHERE work_type_id = ${wt}) AS entries,
        (SELECT count(*) FROM ticket_categories WHERE default_work_type_id = ${wt}) AS categories
    `))) as unknown as Array<{ work_types: string; entries: string; categories: string }>;
    expect(Number(before[0]?.work_types)).toBe(1);
    expect(Number(before[0]?.entries)).toBe(1);
    expect(Number(before[0]?.categories)).toBe(1);

    // No 23503: cascadeDeletePartner rethrows any sweep failure as a
    // "[tenantCascade] DELETE from ..." Error, so a wrong order fails here.
    await expect(cascadeDeletePartner(partnerA, randomUUID())).resolves.toBeDefined();

    const after = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT count(*)::int AS remaining FROM work_types WHERE partner_id = ${partnerA}
    `))) as unknown as Array<{ remaining: number }>;
    expect(after[0]?.remaining).toBe(0);
    const partnerRows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT id FROM partners WHERE id = ${partnerA}
    `))) as unknown as Array<{ id: string }>;
    expect(partnerRows).toHaveLength(0);
    // Partner B is untouched by A's purge.
    const bRows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT id FROM partners WHERE id = ${partnerB}
    `))) as unknown as Array<{ id: string }>;
    expect(bRows).toHaveLength(1);
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
