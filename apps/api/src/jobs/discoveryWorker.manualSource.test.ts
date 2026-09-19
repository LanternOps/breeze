/**
 * #5213 W01 — a scan must never overwrite an operator's manual row.
 *
 * These assertions deliberately inspect the *bound SQL* of the update set and
 * the condition list rather than deep-searching the Drizzle condition tree: a
 * deep search matches a pg enum's `enumValues` array and silently passes on
 * unfixed code (memory: drizzle_condition_deep_search_matches_enum_values_vacuous).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: async <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

import { buildScanUpdateSet, buildMonitoredAssetConditions } from './discoveryWorker';

const assetData = {
  ipAddress: '10.0.0.9',
  macAddress: 'aa:bb:cc:dd:ee:ff',
  hostname: 'scanner-guess',
  netbiosName: null,
  manufacturer: 'Acme',
  model: 'X100',
  openPorts: null,
  osFingerprint: null,
  snmpData: null,
  responseTimeMs: null,
  discoveryMethods: [],
  lastSeenAt: new Date(),
  lastJobId: '00000000-0000-0000-0000-000000000001',
  updatedAt: new Date(),
};

const sqlText = (frag: unknown): string => {
  const chunks = (frag as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      const anyC = c as { value?: unknown; name?: unknown };
      if (Array.isArray(anyC.value)) return anyC.value.join('');
      if (typeof anyC.name === 'string') return anyC.name;
      return '';
    })
    .join(' ');
};

describe('discoveryWorker manual-source guards (#5213)', () => {
  it('guards hostname, manufacturer and model behind source <> manual', () => {
    const set = buildScanUpdateSet(assetData, null);
    for (const col of ['hostname', 'manufacturer', 'model'] as const) {
      const text = sqlText(set[col]);
      expect(text).toContain('source');
      expect(text).toContain('manual');
      // The CASE must fall back to the STORED column, not to a literal.
      expect(text).toContain(col === 'hostname' ? 'hostname' : col === 'model' ? 'model' : 'manufacturer');
    }
  });

  it('leaves ip/mac/liveness columns as plain values — only operator fields are guarded', () => {
    const set = buildScanUpdateSet(assetData, null);
    expect(set.ipAddress).toBe('10.0.0.9');
    expect(set.macAddress).toBe('aa:bb:cc:dd:ee:ff');
    expect(set.lastSeenAt).toBe(assetData.lastSeenAt);
  });

  it('leaves label untouched — the scan never writes it', () => {
    const set = buildScanUpdateSet(assetData, null);
    expect(set).not.toHaveProperty('label');
  });

  it('still applies the classification write when the scan has an opinion', () => {
    const set = buildScanUpdateSet(assetData, { type: 'printer', source: 'agent_scan' });
    expect(set).toHaveProperty('assetType');
    expect(set).toHaveProperty('detectedAssetType');
    expect(set).toHaveProperty('detectedTypeSource');
  });

  it('excludes never-scanned rows from the disappeared sweep', () => {
    const conds = buildMonitoredAssetConditions('org-1', 'site-1', []);
    const joined = conds.map(sqlText).join(' ');
    expect(joined).toContain('last_seen_at');
    expect(joined).toContain('is not null');
  });

  it('keeps the subnet predicates when the profile declares them', () => {
    const conds = buildMonitoredAssetConditions('org-1', 'site-1', ['10.0.0.0/24']);
    expect(conds.length).toBeGreaterThan(
      buildMonitoredAssetConditions('org-1', 'site-1', []).length,
    );
  });
});
