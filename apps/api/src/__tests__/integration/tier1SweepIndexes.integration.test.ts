/**
 * #5020 Tier 1 — discovery_jobs / organization_users / automations sweep
 * indexes, proved against real Postgres (the migration lives in
 * migrations/2026-12-23-100000-tier1-sweep-indexes.sql).
 *
 * `pnpm db:check-drift` compares the Drizzle model to the migrations, not to a
 * live database, and the indexes are not declared in the model (same as the
 * #5021 set), so only a real catalog read can tell whether they exist, are
 * VALID, and lead with the columns the recurring jobs filter on.
 *
 * The EXPLAIN cases force `enable_seqscan = off` because the test tables are
 * near-empty; what they prove is that each worker predicate shape (the org
 * branch only for the automations event path) — sent as a bound
 * parameter, as Drizzle sends it — is *able* to use the index (for the partial
 * automations index that means the planner proves `enabled = $1` implies the
 * index predicate).
 */
import './setup';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const INDEXES = [
  { table: 'discovery_jobs', index: 'discovery_jobs_profile_status_idx', columns: '(profile_id, status)', partial: null },
  { table: 'discovery_jobs', index: 'discovery_jobs_status_updated_at_idx', columns: '(status, updated_at)', partial: null },
  { table: 'organization_users', index: 'organization_users_org_user_idx', columns: '(org_id, user_id)', partial: null },
  { table: 'organization_users', index: 'organization_users_user_id_idx', columns: '(user_id)', partial: null },
  { table: 'automations', index: 'automations_enabled_org_idx', columns: '(org_id)', partial: 'WHERE enabled' },
] as const;

async function explain(query: ReturnType<typeof sql>): Promise<string> {
  const db = getTestDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const rows = await tx.execute(sql`EXPLAIN ${query}`);
    return (rows as unknown as Array<Record<string, string>>).map((r) => r['QUERY PLAN']).join('\n');
  });
}

describe('Tier-1 sweep indexes (#5020)', () => {
  for (const { table, index, columns, partial } of INDEXES) {
    runDb(`${index} exists on ${table}${columns}, is valid, and has the expected predicate`, async () => {
      const db = getTestDb();
      const rows = (await db.execute(sql`
        SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid, i.indisunique
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relname = ${index}
           AND i.indrelid = ${`public.${table}`}::regclass
      `)) as unknown as Array<{ indexdef: string; indisvalid: boolean; indisunique: boolean }>;

      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row!.indisvalid).toBe(true);
      // Not UNIQUE: these are lookup indexes; uniqueness on existing data is a
      // separate decision.
      expect(row!.indisunique).toBe(false);
      expect(row!.indexdef).toContain(`USING btree ${columns}`);
      if (partial) {
        expect(row!.indexdef).toContain(partial);
      } else {
        expect(row!.indexdef).not.toContain('WHERE');
      }
    });
  }

  runDb('discoveryWorker per-profile in-flight check can use (profile_id, status)', async () => {
    const plan = await explain(sql`
      SELECT id FROM discovery_jobs
       WHERE profile_id = ${'00000000-0000-0000-0000-000000000001'}::uuid
         AND status IN ('scheduled', 'running')
       LIMIT 1
    `);
    expect(plan).toContain('discovery_jobs_profile_status_idx');
  });

  runDb('discoveryWorker stale-running / stale-scheduled sweeps can use (status, updated_at)', async () => {
    const plan = await explain(sql`
      SELECT id FROM discovery_jobs
       WHERE status = ${'scheduled'}
         AND updated_at < ${new Date().toISOString()}::timestamptz
       ORDER BY updated_at ASC
       LIMIT 50
    `);
    expect(plan).toContain('discovery_jobs_status_updated_at_idx');
  });

  runDb('organization_users lookups by user and by org can use an index', async () => {
    const byUser = await explain(sql`
      SELECT org_id FROM organization_users WHERE user_id = ${'00000000-0000-0000-0000-000000000001'}::uuid
    `);
    expect(byUser).toContain('organization_users_user_id_idx');

    const byOrg = await explain(sql`
      SELECT user_id FROM organization_users WHERE org_id = ${'00000000-0000-0000-0000-000000000001'}::uuid
    `);
    expect(byOrg).toContain('organization_users_org_user_idx');
  });

  runDb('automationWorker enabled sweep (bound `enabled = $1`) can use the partial index', async () => {
    const sweep = await explain(sql`SELECT id FROM automations WHERE enabled = ${true}`);
    expect(sweep).toContain('automations_enabled_org_idx');

    const eventPath = await explain(sql`
      SELECT id FROM automations
       WHERE org_id = ${'00000000-0000-0000-0000-000000000001'}::uuid
         AND enabled = ${true}
         AND retired_at IS NULL
    `);
    expect(eventPath).toContain('automations_enabled_org_idx');
  });
});
