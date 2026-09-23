import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { metricAnomalyEpisodes } from '../db/schema/metricAnomalyEpisodes';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Metric anomaly episodes W01 (spec §14). The export-policy row is the one that
 * fires on a new COLUMN, not just a new table, and both export suites need a
 * live DB — pinning it here moves a missed classification into Test API.
 */
describe('metric anomaly episodes export policy', () => {
  const registry = getTenantExportPolicyRegistry();

  it('classifies every metric_anomaly_episodes column; attribution (jsonb) is excludedOpen', () => {
    const policy = registry['metric_anomaly_episodes'];
    expect(policy).toBeDefined();
    const columnNames = Object.values(getTableColumns(metricAnomalyEpisodes)).map((column) => column.name);
    for (const name of columnNames) {
      const expected = name === 'attribution' ? 'exclude' : 'include';
      expect(policy?.columns[name]?.decision, name).toBe(expected);
    }
  });

  it('amends the existing entries for the new columns on metric_anomalies and metric_anomaly_incidents', () => {
    expect(registry['metric_anomalies']?.columns['episode_id']?.decision).toBe('include');
    expect(registry['metric_anomaly_incidents']?.columns['episode_id']?.decision).toBe('include');
    expect(registry['metric_anomaly_incidents']?.columns['suppressed_by_episode']?.decision).toBe('include');
  });
});
