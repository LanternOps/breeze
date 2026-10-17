/**
 * metric_rollups leaf partitions must carry their own autovacuum ANALYZE
 * thresholds (migration 2026-12-23-120000-metric-rollups-analyze-freshness).
 *
 * Partitions do not inherit reloptions from the partitioned parent, and the
 * default 10 % scale factor on a 7 M-row monthly leaf means the bucket_start
 * histogram lags `now()` by up to 8 h. The anomaly detectors then get a
 * rows=1 estimate for the recent window, choose a nested loop over the
 * open-episode set and time out at 90 s (US prod 2026-10-12: 23 s with stale
 * stats vs 2.3 s with a fresh histogram for the same org and shape).
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';

interface LeafRow {
  relname: string;
  reloptions: string[] | null;
}

const LEAF_SQL = sql`
  WITH RECURSIVE tree AS (
    SELECT 'public.metric_rollups'::regclass AS oid
    UNION ALL
    SELECT i.inhrelid FROM pg_inherits i JOIN tree ON i.inhparent = tree.oid
  )
  SELECT c.relname, c.reloptions
  FROM tree JOIN pg_class c ON c.oid = tree.oid
  WHERE c.relkind = 'r'
  ORDER BY c.relname
`;

function hasAnalyzeOptions(row: LeafRow): boolean {
  const opts = row.reloptions ?? [];
  return (
    opts.some((o) => o.startsWith('autovacuum_analyze_scale_factor=')) &&
    opts.some((o) => o.startsWith('autovacuum_analyze_threshold='))
  );
}

describe('metric_rollups leaf partitions keep their statistics fresh', () => {
  it('every existing leaf (incl. the default partition) carries analyze thresholds', async () => {
    const rows = (await getTestDb().execute(LEAF_SQL)) as unknown as LeafRow[];
    expect(rows.length).toBeGreaterThan(0);
    const missing = rows.filter((r) => !hasAnalyzeOptions(r)).map((r) => r.relname);
    expect(missing).toEqual([]);
  });

  it('a month created by breeze_create_metric_rollup_month gets the thresholds on each leaf', async () => {
    const sudo = getTestDb();
    const monthStart = '2031-03-01 00:00:00';
    const name = 'metric_rollups_y2031m03';
    try {
      await sudo.execute(sql`SELECT public.breeze_create_metric_rollup_month(${monthStart}::timestamp)`);
      const rows = (await sudo.execute(LEAF_SQL)) as unknown as LeafRow[];
      const leaves = rows.filter((r) => r.relname.startsWith(`${name}_`));
      expect(leaves.map((r) => r.relname)).toEqual([`${name}_1d`, `${name}_1h`, `${name}_5m`]);
      expect(leaves.filter((r) => !hasAnalyzeOptions(r))).toEqual([]);
    } finally {
      await sudo.execute(sql.raw(`DROP TABLE IF EXISTS public.${name} CASCADE`));
    }
  });
});
