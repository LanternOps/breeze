import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({ rows: [] as unknown[], wheres: [] as unknown[] }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain);
      chain.where = vi.fn((arg: unknown) => {
        state.wheres.push(arg);
        return chain;
      });
      chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(state.rows).then(resolve);
      return chain;
    }),
  },
}));

const coverage = vi.hoisted(() => ({ getProviderCoverageForDevices: vi.fn() }));
vi.mock('./backupHealthReadModel', () => coverage);

import { db } from '../db';
import { loadBackupProviderEvidence } from './securityComplianceReportBackupProviders';
import { buildSecurityProductInventory } from './securityComplianceReportProducts';

const ORG = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.wheres = [];
  coverage.getProviderCoverageForDevices.mockResolvedValue(new Map());
});

describe('loadBackupProviderEvidence', () => {
  it('reports a linked provider as a backup product, split into linked and freshly-covered devices', async () => {
    state.rows = [
      { provider: 'cove', portalShowProviderName: true, breezeDeviceId: 'dev-1' },
      { provider: 'cove', portalShowProviderName: true, breezeDeviceId: 'dev-2' },
    ];
    coverage.getProviderCoverageForDevices.mockResolvedValue(new Map([
      ['dev-1', { covered: true, health: 'healthy' }],
      ['dev-2', { covered: false, health: 'critical' }],
    ]));

    const result = await loadBackupProviderEvidence(ORG, ['dev-1', 'dev-2', 'dev-3']);
    expect(result.coveredDeviceCount).toBe(1);
    expect(buildSecurityProductInventory(result.evidence)).toEqual([{
      product: 'Cove Data Protection',
      category: 'backup',
      active: true,
      lastSyncStatus: null,
      deviceCoverage: 2,
      activeDeviceCoverage: 1,
    }]);
    expect(coverage.getProviderCoverageForDevices).toHaveBeenCalledWith(ORG, ['dev-1', 'dev-2'], {});
  });

  it('only reads rows linked to the devices in the report scope (restricted sites / config.sites)', async () => {
    await loadBackupProviderEvidence(ORG, ['dev-1']);
    const where = new PgDialect().sqlToQuery(state.wheres[0] as SQL);
    expect(where.sql).toContain('"backup_provider_devices"."org_id" = $');
    expect(where.sql).toContain('"backup_provider_devices"."breeze_device_id" in');
    expect(where.params).toEqual([ORG, 'dev-1']);
  });

  it('drops a row linked outside the report scope even if the query returned it', async () => {
    state.rows = [
      { provider: 'cove', portalShowProviderName: true, breezeDeviceId: 'dev-1' },
      { provider: 'cove', portalShowProviderName: true, breezeDeviceId: 'dev-other-site' },
    ];
    coverage.getProviderCoverageForDevices.mockResolvedValue(new Map([
      ['dev-1', { covered: true, health: 'healthy' }],
      ['dev-other-site', { covered: true, health: 'healthy' }],
    ]));

    const result = await loadBackupProviderEvidence(ORG, ['dev-1']);
    const [product] = buildSecurityProductInventory(result.evidence);
    expect(product).toMatchObject({ deviceCoverage: 1, activeDeviceCoverage: 1 });
    expect(result.coveredDeviceCount).toBe(1);
  });

  it('uses the generic label unless the connection shows the vendor name (spec D5)', async () => {
    state.rows = [{ provider: 'cove', portalShowProviderName: false, breezeDeviceId: 'dev-1' }];
    const result = await loadBackupProviderEvidence(ORG, ['dev-1']);
    expect(result.evidence.map((e) => e.product)).toEqual(['Managed cloud backup']);
    expect(JSON.stringify(result)).not.toContain('Cove');
  });

  it('is an inactive product when no linked device has a fresh successful backup', async () => {
    state.rows = [{ provider: 'cove', portalShowProviderName: true, breezeDeviceId: 'dev-1' }];
    coverage.getProviderCoverageForDevices.mockResolvedValue(new Map([['dev-1', { covered: false, health: 'critical' }]]));
    const result = await loadBackupProviderEvidence(ORG, ['dev-1']);
    expect(result.coveredDeviceCount).toBe(0);
    expect(buildSecurityProductInventory(result.evidence)[0]).toMatchObject({ active: false, deviceCoverage: 1, activeDeviceCoverage: 0 });
  });

  it('does not query at all for an empty device scope', async () => {
    await expect(loadBackupProviderEvidence(ORG, [])).resolves.toEqual({ evidence: [], coveredDeviceCount: 0 });
    expect(db.select).not.toHaveBeenCalled();
    expect(coverage.getProviderCoverageForDevices).not.toHaveBeenCalled();
  });

  it('returns nothing and skips the coverage read when no row is linked', async () => {
    const result = await loadBackupProviderEvidence(ORG, ['dev-1']);
    expect(result).toEqual({ evidence: [], coveredDeviceCount: 0 });
    expect(coverage.getProviderCoverageForDevices).not.toHaveBeenCalled();
  });
});
