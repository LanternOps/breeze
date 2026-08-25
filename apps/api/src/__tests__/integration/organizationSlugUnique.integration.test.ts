/**
 * #3967 — `organizations.slug` uniqueness, proved against real Postgres.
 *
 * This suite exists because the bug it covers was invisible to every other
 * layer of testing: the Drizzle model and three service paths all behaved as if
 * the column were unique, `pnpm db:check-drift` compares the model to the
 * migrations rather than to a live database, and the mocked route tests can
 * only assert the query we chose to write. Nothing but a real INSERT can tell
 * you whether the constraint is actually there.
 *
 * The three properties asserted here are the three deliberate choices recorded
 * in migrations/2026-09-08-organizations-partner-slug-unique.sql: per-partner
 * (not global), case-insensitive, and lifetime (soft-deleted rows keep their
 * slug).
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { organizations } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-09-08-organizations-partner-slug-unique.sql',
);
const INDEX = 'organizations_partner_slug_uniq';

function isUniqueViolation(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; candidate && typeof candidate === 'object' && depth < 5; depth++) {
    const e = candidate as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === '23505') return true;
    if (typeof e.message === 'string' && e.message.includes(INDEX)) return true;
    candidate = e.cause;
  }
  return false;
}

describe('organizations.slug uniqueness (#3967)', () => {
  runDb('the unique index exists, on (partner_id, lower(slug)), with no partial predicate', async () => {
    const db = getTestDb();
    const rows = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'organizations' AND indexname = ${INDEX}
    `);

    // The index missing entirely is exactly the shipped bug — assert presence
    // before asserting its shape, so a regression reads as "gone", not "odd".
    expect(rows).toHaveLength(1);
    const indexdef = (rows[0] as { indexdef: string }).indexdef;
    expect(indexdef).toContain('CREATE UNIQUE INDEX');
    expect(indexdef).toContain('partner_id');
    expect(indexdef).toContain('lower(');
    // Lifetime, not live-rows-only: a WHERE clause here would let a
    // replacement org steal a soft-deleted org's slug and turn the import
    // pipeline's reactivate path into a 23505.
    expect(indexdef).not.toContain('WHERE');
  });

  runDb('rejects a second organization with the same slug under the same partner', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id, slug: 'qa-sweep-org' });

    await expect(
      createOrganization({ partnerId: partner.id, slug: 'qa-sweep-org' }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  runDb('rejects a case-variant of an existing slug under the same partner', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id, slug: 'acme' });

    await expect(
      createOrganization({ partnerId: partner.id, slug: 'ACME' }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  runDb('allows the SAME slug under a different partner (per-partner, not global)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    const orgA = await createOrganization({ partnerId: partnerA.id, slug: 'acme' });
    const orgB = await createOrganization({ partnerId: partnerB.id, slug: 'acme' });

    // Two unrelated MSPs must both be able to onboard an "acme"; a global index
    // would also leak one tenant's org existence to the other via the 409.
    expect(orgA.id).not.toBe(orgB.id);
    expect(orgA.slug).toBe('acme');
    expect(orgB.slug).toBe('acme');
  });

  runDb('keeps a soft-deleted organization’s slug reserved', async () => {
    const partner = await createPartner();
    await createOrganization({
      partnerId: partner.id,
      slug: 'churned-customer',
      deletedAt: new Date(),
    });

    await expect(
      createOrganization({ partnerId: partner.id, slug: 'churned-customer' }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  runDb('the migration renames pre-existing duplicates and is re-runnable', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const migration = readFileSync(MIGRATION_FILE, 'utf8');

    // Recreate the pre-fix world: without the index, duplicates insert happily.
    await db.execute(sql.raw(`DROP INDEX IF EXISTS ${INDEX}`));
    try {
      const keeper = await createOrganization({
        partnerId: partner.id,
        slug: 'dup-slug',
        name: 'Original',
      });
      const loser = await createOrganization({
        partnerId: partner.id,
        slug: 'DUP-SLUG',
        name: 'Duplicate',
      });
      // Deterministic winner: oldest created_at. The fixtures can land in the
      // same millisecond, so pin it rather than trusting insert order.
      await db.execute(sql`
        UPDATE organizations SET created_at = now() - interval '1 day' WHERE id = ${keeper.id}
      `);

      await db.execute(sql.raw(migration));

      const after = await db.execute(sql`
        SELECT id, slug FROM organizations WHERE partner_id = ${partner.id} ORDER BY created_at
      `);
      const byId = new Map((after as unknown as { id: string; slug: string }[]).map((r) => [r.id, r.slug]));
      // Oldest row keeps the slug; the newer one is suffixed with its own id
      // prefix rather than deleted — a slug clash is never a reason to drop a
      // tenant's row.
      expect(byId.get(keeper.id)).toBe('dup-slug');
      expect(byId.get(loser.id)).toBe(`DUP-SLUG-${loser.id.slice(0, 8)}`);

      // Re-applying must be a no-op (autoMigrate replays on every boot of a
      // database that has not recorded the file).
      await db.execute(sql.raw(migration));
      const afterSecondRun = await db.execute(sql`
        SELECT id, slug FROM organizations WHERE partner_id = ${partner.id}
      `);
      for (const row of afterSecondRun as unknown as { id: string; slug: string }[]) {
        expect(row.slug).toBe(byId.get(row.id));
      }
    } finally {
      // Leave the schema as we found it even if an expectation above threw.
      await db.execute(sql.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON organizations (partner_id, lower(slug))`,
      ));
    }
  });

  runDb('the Drizzle model can still insert a distinct slug (guards a wrong model)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, slug: 'distinct-slug' });
    const [row] = await getTestDb()
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(sql`${organizations.id} = ${org.id}`)
      .limit(1);
    expect(row?.slug).toBe('distinct-slug');
  });
});
