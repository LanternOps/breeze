import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { metricAnomalies } from './schema/analytics';
import { metricAnomalyEpisodes } from './schema/metricAnomalyEpisodes';
import { metricAnomalyIncidents } from './schema/metricAnomalyIncidents';

/**
 * Metric anomaly episodes W01 — static check of the migration and its Drizzle
 * mirror. Runtime proof (RLS, cascade, export contracts) is the integration
 * suites run in the final task; this file only moves the cheap failures into
 * Test API.
 */
const MIGRATION_PATH = join(__dirname, '..', '..', 'migrations', '2026-10-28-100000-metric-anomaly-episodes.sql');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

const EPISODE_COLUMNS = [
  'id', 'org_id', 'device_id', 'episode_key', 'source_table', 'anomaly_type', 'metric_family',
  'metric_names', 'status', 'close_reason', 'first_seen_at', 'last_seen_at', 'bucket_count',
  'peak_value', 'peak_metric_name', 'peak_baseline_value', 'peak_score', 'peak_at',
  'recurrence_count', 'attribution', 'linked_alert_id', 'snoozed_until', 'resolved_at',
  'resolved_by_user_id', 'note', 'created_at', 'updated_at',
];

describe('metric anomaly episodes migration', () => {
  it('creates the table with RLS enabled, forced, and all four org-isolation policies', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS metric_anomaly_episodes');
    expect(migrationSql).toContain('ALTER TABLE metric_anomaly_episodes ENABLE ROW LEVEL SECURITY;');
    expect(migrationSql).toContain('ALTER TABLE metric_anomaly_episodes FORCE ROW LEVEL SECURITY;');
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(migrationSql).toContain(`CREATE POLICY breeze_org_isolation_${cmd} ON metric_anomaly_episodes`);
      expect(migrationSql).toContain(`DROP POLICY IF EXISTS breeze_org_isolation_${cmd} ON metric_anomaly_episodes;`);
    }
    expect(migrationSql).toContain('public.breeze_has_org_access(org_id)');
  });

  it('makes attach-or-create race-proof with a partial unique index on the open key', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS metric_anomaly_episodes_open_key_uq\s+ON metric_anomaly_episodes \(device_id, episode_key\)\s+WHERE status = 'open';/,
    );
  });

  it('allows detection_off as a close reason (flag turned off, second quorum A5)', () => {
    expect(migrationSql).toContain(
      "close_reason IN ('cleared', 'expired_offline', 'expired_no_data', 'detection_off', 'user', 'snoozed')",
    );
  });

  it('re-creates the metric_anomalies status check with cleared', () => {
    expect(migrationSql).toContain('ALTER TABLE metric_anomalies DROP CONSTRAINT IF EXISTS metric_anomalies_status_check;');
    expect(migrationSql).toContain("CHECK (status IN ('open', 'dismissed', 'promoted', 'resolved', 'cleared'))");
  });

  it('adds the new columns idempotently', () => {
    expect(migrationSql).toContain('ALTER TABLE metric_anomalies ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES metric_anomaly_episodes(id) ON DELETE SET NULL;');
    expect(migrationSql).toContain('ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS episode_id UUID;');
    expect(migrationSql).toContain('ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS suppressed_by_episode BOOLEAN NOT NULL DEFAULT false;');
  });

  it('writes no rows, so it needs no breeze.scope elevation', () => {
    expect(migrationSql).not.toMatch(/^\s*(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|MERGE\s+INTO)\b/im);
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
    expect(migrationSql).not.toContain('CONCURRENTLY');
  });

  it('is mirrored by Drizzle', () => {
    const episodes = getTableConfig(metricAnomalyEpisodes);
    expect(episodes.name).toBe('metric_anomaly_episodes');
    expect(episodes.columns.map((column) => column.name).sort()).toEqual([...EPISODE_COLUMNS].sort());
    expect(episodes.indexes.map((index) => index.config.name).sort()).toEqual([
      'metric_anomaly_episodes_device_key_resolved_idx',
      'metric_anomaly_episodes_device_status_last_seen_idx',
      'metric_anomaly_episodes_linked_alert_idx',
      'metric_anomaly_episodes_open_key_uq',
      'metric_anomaly_episodes_org_status_last_seen_idx',
    ]);
    const anomalies = getTableConfig(metricAnomalies);
    expect(anomalies.columns.map((column) => column.name)).toContain('episode_id');
    expect(anomalies.indexes.map((index) => index.config.name)).toEqual(expect.arrayContaining([
      'metric_anomalies_episode_id_idx',
      'metric_anomalies_unassigned_open_idx',
      'metric_anomalies_device_metric_window_idx',
    ]));
    const incidents = getTableConfig(metricAnomalyIncidents);
    expect(incidents.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['episode_id', 'suppressed_by_episode']));
    // No FK on incidents.episode_id — same cycle-avoidance as agent_run_id (§4.1).
    expect(incidents.foreignKeys.map((fk) => fk.reference().columns.map((c) => c.name)).flat()).not.toContain('episode_id');
  });
});
