import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drizzle mock pattern per the breeze-testing skill / reportGenerationService
// .manualAssets.test.ts (its `queueSelects` shape is reused verbatim): every
// `db.select()` call resolves the next queued row set, in call order.
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../db';
import type { OrgReportExecutionAuthority } from './siteScope';
import { generateHardwareLifecycleReport } from './hardwareLifecycleReport';
import type { HardwareLifecycleSummary } from '@breeze/shared';
import type { ReportResult } from './reportGenerationService';

/** `ReportResult.summary` is typed as a generic `Record<string, unknown>`
 *  (it is a persisted JSON blob shared by every report type), and every field
 *  of `HardwareLifecycleSummary` itself is optional (older, thinner snapshots
 *  can lack a field) — narrow both away back to what
 *  `generateHardwareLifecycleReport` actually always populates. */
type FullSummary = HardwareLifecycleSummary
  & Required<Pick<HardwareLifecycleSummary, 'org' | 'computers' | 'otherEquipmentCount' | 'rows' | 'other'>>;
function summaryOf(result: ReportResult): FullSummary {
  return result.summary as FullSummary;
}

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function queueSelects(...resultSets: unknown[][]) {
  const queue = [...resultSets];
  vi.mocked(db.select).mockImplementation((() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'leftJoin', 'where', 'limit']) {
      chain[method] = () => chain;
    }
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  }) as never);
}

function authority(
  kind: 'unrestricted' | 'restricted' = 'unrestricted',
  siteIds: string[] = [],
): OrgReportExecutionAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId: ORG_ID, siteIds }
      : { version: 1, kind, orgId: ORG_ID },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-09-07T12:00:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

const ORG_ROW = [{ id: ORG_ID, name: 'Acme Legal' }];

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd0000000-0000-4000-8000-000000000001',
    hostname: 'host-1',
    displayName: null,
    lastUser: null,
    osType: 'windows',
    osVersion: 'Windows 11 Pro',
    deviceRole: 'workstation',
    purchaseDate: '2021-01-01',
    purchaseDateSource: 'vendor',
    siteName: 'Main',
    manufacturer: 'Dell Inc.',
    model: 'OptiPlex 3050',
    serialNumber: 'SN-1',
    warrantyEndDate: null,
    warrantyIsSubscription: false,
    ...overrides,
  };
}

function manualAssetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    name: 'Spare laptop',
    assetType: 'workstation',
    manufacturer: 'Lenovo',
    model: 'T14',
    serialNumber: 'SN-A1',
    purchaseDate: '2021-01-01',
    purchaseDateSource: 'manual',
    siteName: 'Main',
    warrantyEndDate: null,
    warrantyIsSubscription: false,
    ...overrides,
  };
}

describe('generateHardwareLifecycleReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a server row uses cfg.serverReplaceAgeYears; a workstation uses cfg.replaceAgeYears', async () => {
    const workstation = deviceRow({
      id: 'd0000000-0000-4000-8000-000000000001',
      deviceRole: 'workstation',
      purchaseDate: '2021-01-01',
    });
    const server = deviceRow({
      id: 'd0000000-0000-4000-8000-000000000002',
      hostname: 'srv-1',
      deviceRole: 'server',
      purchaseDate: '2021-01-01',
    });
    queueSelects(ORG_ROW, [workstation, server], []);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { replaceAgeYears: 4, serverReplaceAgeYears: 6, includeOtherEquipment: false },
      authority('unrestricted'),
    );

    const wsRow = summaryOf(result).rows.find((r) => r.id === workstation.id)!;
    const srvRow = summaryOf(result).rows.find((r) => r.id === server.id)!;
    // Purchased the same day, but the server gets 2 extra years of runway —
    // proves the two config knobs are wired to the right subject, not both
    // reading replaceAgeYears.
    expect(wsRow.replaceBy).toBe('2025-01-01');
    expect(srvRow.replaceBy).toBe('2027-01-01');
    expect(wsRow.deviceKind).toBe('workstation');
    expect(srvRow.deviceKind).toBe('server');
  });

  it('a manual asset of unknown type lands in `other`, never in `rows`', async () => {
    const unknownAsset = manualAssetRow({
      id: 'a0000000-0000-4000-8000-000000000009',
      name: 'Mystery box',
      assetType: null,
    });
    queueSelects(ORG_ROW, [], [unknownAsset]);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { includeManualAssets: true, includeOtherEquipment: true },
      authority('unrestricted'),
    );

    expect(summaryOf(result).rows.find((r) => r.id === unknownAsset.id)).toBeUndefined();
    const otherRow = summaryOf(result).other.find((r) => r.id === unknownAsset.id);
    expect(otherRow).toBeDefined();
    expect(otherRow!.category).toBe('unknown');
  });

  it('an AppleCare-subscription warranty does NOT extend replaceBy past the age rule', async () => {
    const subscriptionDevice = deviceRow({
      id: 'd0000000-0000-4000-8000-000000000003',
      purchaseDate: '2021-01-01',
      // Far in the future — if this were treated as an active fixed-term
      // warranty it would push replaceBy out to here. A subscription's
      // "end" is just the next renewal, not real coverage.
      warrantyEndDate: '2032-01-01',
      warrantyIsSubscription: true,
    });
    queueSelects(ORG_ROW, [subscriptionDevice], []);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { replaceAgeYears: 4, includeOtherEquipment: false },
      authority('unrestricted'),
    );

    const row = summaryOf(result).rows.find((r) => r.id === subscriptionDevice.id)!;
    expect(row.replaceBy).toBe('2025-01-01');
    expect(row.replaceBy).not.toBe('2032-01-01');
    expect(row.warrantyExtended).toBe(false);
  });

  it('warrantyLookupFailed is true when the last warranty sync errored (status unknown + lastSyncError set)', async () => {
    const failedLookupDevice = deviceRow({
      id: 'd0000000-0000-4000-8000-000000000006',
      purchaseDate: '2020-01-01', // old enough to land in "replace" purely off age
      warrantyEndDate: null,
      warrantyStatus: 'unknown',
      warrantyLastSyncError: 'Dell API: 503 Service Unavailable',
    });
    queueSelects(ORG_ROW, [failedLookupDevice], []);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { replaceAgeYears: 4, includeOtherEquipment: false },
      authority('unrestricted'),
    );

    const row = summaryOf(result).rows.find((r) => r.id === failedLookupDevice.id)!;
    expect(row.warrantyLookupFailed).toBe(true);
    // Still classified off the purchase-date rule — this flags the
    // uncertainty rather than silently reclassifying the row.
    expect(row.replacement).toBe('replace');
  });

  it('warrantyLookupFailed is false when the vendor genuinely reports no coverage (status unknown, no error)', async () => {
    const noWarrantyDevice = deviceRow({
      id: 'd0000000-0000-4000-8000-000000000007',
      warrantyEndDate: null,
      warrantyStatus: 'unknown',
      warrantyLastSyncError: null,
    });
    queueSelects(ORG_ROW, [noWarrantyDevice], []);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { includeOtherEquipment: false },
      authority('unrestricted'),
    );

    const row = summaryOf(result).rows.find((r) => r.id === noWarrantyDevice.id)!;
    expect(row.warrantyLookupFailed).toBe(false);
  });

  it('warrantyLookupFailed is false with no device_warranty row at all (never synced)', async () => {
    const neverSyncedDevice = deviceRow({
      id: 'd0000000-0000-4000-8000-000000000008',
      warrantyEndDate: null,
      warrantyStatus: null,
      warrantyLastSyncError: null,
    });
    queueSelects(ORG_ROW, [neverSyncedDevice], []);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { includeOtherEquipment: false },
      authority('unrestricted'),
    );

    const row = summaryOf(result).rows.find((r) => r.id === neverSyncedDevice.id)!;
    expect(row.warrantyLookupFailed).toBe(false);
  });

  it('warrantyLookupFailed is derived for a manual asset too, not just agent devices', async () => {
    const failedLookupAsset = manualAssetRow({
      id: 'a0000000-0000-4000-8000-000000000006',
      warrantyEndDate: null,
      warrantyStatus: 'unknown',
      warrantyLastSyncError: 'Lenovo API: expired API key',
    });
    queueSelects(ORG_ROW, [], [failedLookupAsset]);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { includeManualAssets: true, includeOtherEquipment: false },
      authority('unrestricted'),
    );

    const row = summaryOf(result).rows.find((r) => r.id === failedLookupAsset.id)!;
    expect(row.warrantyLookupFailed).toBe(true);
  });

  it('a device with no purchase date and no warranty is kept with replacement: "unknown", not dropped', async () => {
    const unknownDevice = deviceRow({
      id: 'd0000000-0000-4000-8000-000000000004',
      purchaseDate: null,
      warrantyEndDate: null,
    });
    queueSelects(ORG_ROW, [unknownDevice], []);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { includeOtherEquipment: false },
      authority('unrestricted'),
    );

    const row = summaryOf(result).rows.find((r) => r.id === unknownDevice.id);
    expect(row).toBeDefined();
    expect(row!.replaceBy).toBeNull();
    expect(row!.replacement).toBe('unknown');
  });

  it('an empty restrictedScope.siteIds short-circuits without querying the database at all', async () => {
    queueSelects(ORG_ROW, [deviceRow()], []);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      {},
      authority('restricted', []),
    );

    expect(db.select).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(summaryOf(result).computers.total!).toBe(0);
    expect(summaryOf(result).org.id!).toBe(ORG_ID);
  });

  it('includeManualAssets: false skips the manual-asset query and excludes manual rows entirely', async () => {
    // Only two result sets queued (org, devices) — a third db.select() call
    // (the manual-asset query) would starve the queue and return [], which
    // would make this assertion pass for the wrong reason, so it also
    // checks the call count directly.
    queueSelects(ORG_ROW, [deviceRow()]);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { includeManualAssets: false },
      authority('unrestricted'),
    );

    expect(db.select).toHaveBeenCalledTimes(2);
    expect(summaryOf(result).rows.every((r) => r.kind === 'device')).toBe(true);
  });

  it('includeOtherEquipment: false hides non-computer subjects from the summary even though they were fetched', async () => {
    const printer = manualAssetRow({
      id: 'a0000000-0000-4000-8000-000000000005',
      name: 'Office printer',
      assetType: 'printer',
    });
    queueSelects(ORG_ROW, [deviceRow()], [printer]);

    const result = await generateHardwareLifecycleReport(
      ORG_ID,
      { includeManualAssets: true, includeOtherEquipment: false },
      authority('unrestricted'),
    );

    expect(summaryOf(result).other).toEqual([]);
    expect(summaryOf(result).otherEquipmentCount).toBe(0);
  });
});
