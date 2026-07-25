import './setup';

import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import {
  dropExpiredMetricRollupPartitions,
  ensureMetricRollupPartitions,
  runMetricRollupMaintenance,
} from '../../services/metricRollupMaintenance';
import { getTestDb } from './setup';

/**
 * Regression guard for BREEZE-10: metric-rollup partition maintenance ran pure
 * DDL (CREATE TABLE ... PARTITION OF, ALTER TABLE ... FORCE RLS, CREATE POLICY,
 * GRANT, DROP TABLE) straight from the app connection. The API connects as the
 * unprivileged `breeze_app`, which has no CREATE on schema public and owns
 * neither metric_rollups nor its children, so every production run aborted on
 * its first statement with 42501 `permission denied for schema public` — and
 * because `ensureMetricRollupPartitions()` runs first, retention never ran at
 * all. Postgres ACL-checks the schema BEFORE the IF NOT EXISTS short-circuit,
 * so even a month whose partition already existed failed.
 *
 * The mocked unit suite could not catch this: it asserts on generated SQL and
 * executes none of it. The whole point of this file is that the maintenance
 * path is driven through the real `db` pool — i.e. as `breeze_app` with the
 * same privileges prod has — so reintroducing inline DDL fails here.
 *
 * The DDL now lives in SECURITY DEFINER functions owned by the migration role
 * (migration 2026-08-05-metric-rollup-partition-maintenance-privileges.sql).
 */

/** Months no other integration test touches, so the default partition can
 * never already hold rows for them (which would legitimately skip the create). */
const FUTURE_MONTH = new Date(Date.UTC(2031, 4, 1));
const EXPIRED_MONTH = new Date(Date.UTC(2019, 0, 1));
const FUTURE_PARTITION = 'metric_rollups_y2031m05';
const EXPIRED_PARTITION = 'metric_rollups_y2019m01';
/** ensureMetricRollupPartitions floors monthsAhead at Math.max(1, ...), so the
 * anchor month always comes with the following month — there is no way to ask
 * for a single month. Spell both out rather than asserting a loose superset. */
const FUTURE_PARTITIONS = [FUTURE_PARTITION, 'metric_rollups_y2031m06'];
const EXPIRED_PARTITIONS = [EXPIRED_PARTITION, 'metric_rollups_y2019m02'];

async function partitionExists(name: string): Promise<boolean> {
  const rows = await getTestDb().execute(sql`
    SELECT 1 AS present
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    WHERE parent.relname = 'metric_rollups'
      AND child_ns.nspname = 'public'
      AND child.relname = ${name}
  `);
  return (Array.isArray(rows) ? rows : []).length > 0;
}

describe('metric rollup partition maintenance (real DB, breeze_app privileges)', () => {
  beforeAll(async () => {
    // Non-vacuity guard. If the code-under-test pool were a superuser or a
    // BYPASSRLS role, the inline DDL would have succeeded and every assertion
    // below would pass while proving nothing about production.
    const rows = await db.execute(sql`SELECT current_user AS who`);
    const who = (Array.isArray(rows) ? (rows[0] as { who?: unknown } | undefined) : undefined)?.who;
    expect(who).toBe('breeze_app');
  });

  it('creates a monthly partition as breeze_app, fully converged with RLS and grants', async () => {
    for (const name of FUTURE_PARTITIONS) {
      await getTestDb().execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
    }

    const ensured = await withSystemDbAccessContext(() =>
      ensureMetricRollupPartitions({ referenceDate: FUTURE_MONTH, monthsBack: 0, monthsAhead: 1 }),
    );

    // A skipped month returns nothing; these months are untouched by other
    // tests, so a skip here is a real failure and must not read as success.
    expect(ensured).toEqual(FUTURE_PARTITIONS);
    expect(await partitionExists(FUTURE_PARTITION)).toBe(true);

    const [flags] = (await getTestDb().execute(sql`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = ${FUTURE_PARTITION}
    `)) as unknown as Array<{ rls: boolean; forced: boolean }>;
    expect(flags).toMatchObject({ rls: true, forced: true });

    const policies = (await getTestDb().execute(sql`
      SELECT polname FROM pg_policy
      WHERE polrelid = ${`public.${FUTURE_PARTITION}`}::regclass
      ORDER BY polname
    `)) as unknown as Array<{ polname: string }>;
    expect(policies.map((p) => p.polname)).toEqual([
      'breeze_org_isolation_delete',
      'breeze_org_isolation_insert',
      'breeze_org_isolation_select',
      'breeze_org_isolation_update',
    ]);

    const grants = (await getTestDb().execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = ${FUTURE_PARTITION} AND grantee = 'breeze_app'
    `)) as unknown as Array<{ privilege_type: string }>;
    const granted = grants.map((g) => g.privilege_type);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(granted).toContain(privilege);
    }

    // Re-running must be an idempotent no-op that still reports the partitions.
    const again = await withSystemDbAccessContext(() =>
      ensureMetricRollupPartitions({ referenceDate: FUTURE_MONTH, monthsBack: 0, monthsAhead: 1 }),
    );
    expect(again).toEqual(FUTURE_PARTITIONS);

    for (const name of FUTURE_PARTITIONS) {
      await getTestDb().execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
    }
  });

  it('drops an expired partition as breeze_app and leaves the default partition intact', async () => {
    const ensured = await withSystemDbAccessContext(() =>
      ensureMetricRollupPartitions({ referenceDate: EXPIRED_MONTH, monthsBack: 0, monthsAhead: 1 }),
    );
    expect(ensured).toEqual(EXPIRED_PARTITIONS);

    const dropped = await withSystemDbAccessContext(() => dropExpiredMetricRollupPartitions(new Date()));

    expect(dropped).toContain(EXPIRED_PARTITION);
    for (const name of EXPIRED_PARTITIONS) {
      expect(await partitionExists(name)).toBe(false);
    }
    // The drop seam derives the name from the month, so no month can ever
    // resolve to the catch-all partition.
    expect(await partitionExists('metric_rollups_default')).toBe(true);
  });

  it('runs the whole maintenance job through to retention without aborting', async () => {
    // The BREEZE-10 symptom was not a bad partition — it was that ensure()
    // threw first, so dropExpired/prune never ran. Assert the job reaches the
    // end and reports a retention result for all three bucket tiers.
    const result = await withSystemDbAccessContext(() =>
      runMetricRollupMaintenance({ now: new Date(Date.UTC(2031, 4, 15)) }),
    );

    expect(result.skipped).toBeUndefined();
    expect(result.ensuredPartitions.length).toBeGreaterThan(0);
    expect(result.retention.map((tier) => tier.bucketSeconds)).toEqual([300, 3600, 86400]);
    for (const tier of result.retention) {
      expect(tier.deleted).toBeGreaterThanOrEqual(0);
    }

    for (const name of result.ensuredPartitions) {
      await getTestDb().execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
    }
  });
});
