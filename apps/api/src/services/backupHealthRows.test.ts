// apps/api/src/services/backupHealthRows.test.ts
import { describe, expect, it } from 'vitest';

import { EXTERNAL_BACKUP_STATUSES, deriveBackupHealth, mapBackupJobStatus } from '@breeze/shared';
import { RESTORABLE_BACKUP_JOB_STATUSES } from '../db/schema/backup';
import {
  BACKUP_HISTORY_DAYS,
  GENERIC_PROVIDER_LABEL,
  buildHistoryWindow,
  deviceRoleToRowType,
  emptyBackupHealthSummary,
  fillHistoryWindow,
  foldBackupHealthSummary,
  foldJobsIntoDays,
  invertBackupJobStatus,
  isConnectionStale,
  mergeSortedRows,
  providerLabelFor,
  toBreezeHealthRow,
  toProviderHealthRow,
  type BackupJobStatus,
  type BreezeLegRow,
  type ProviderLegRow,
} from './backupHealthRows';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const breezeLeg = (o: Partial<BreezeLegRow> = {}): BreezeLegRow => ({
  key: `breeze:${DEVICE}`,
  orgId: ORG,
  orgName: 'Acme',
  siteId: SITE,
  deviceId: DEVICE,
  name: 'SRV01',
  computerName: 'srv01.acme.local',
  deviceRole: 'server',
  deviceStatus: 'online',
  jobStatus: 'completed',
  lastSessionAt: '2026-09-15T02:00:00.000Z',
  lastSuccessAt: '2026-09-15T02:30:00.000Z',
  totalSize: 1024,
  errorsCount: 0,
  hasJobs: true,
  ...o,
});

const providerLeg = (o: Partial<ProviderLegRow> = {}): ProviderLegRow => ({
  key: `provider:${ROW}`,
  id: ROW,
  orgId: ORG,
  orgName: 'Acme',
  provider: 'cove',
  portalShowProviderName: false,
  name: 'ACME-SRV01',
  computerName: 'srv01',
  osType: 'server',
  accountType: 'backup_manager',
  dataSources: ['files', 'system_state'],
  status: 'completed',
  lastSessionAt: '2026-09-15T01:00:00.000Z',
  lastSuccessAt: '2026-09-15T01:00:00.000Z',
  selectedBytes: 2048,
  usedBytes: 4096,
  errorsCount: 0,
  breezeDeviceId: DEVICE,
  deviceStatus: 'offline',
  deviceSiteId: SITE,
  connectionIsActive: true,
  connectionLastSyncAt: '2026-09-15T11:50:00.000Z',
  connectionSyncIntervalMinutes: 30,
  ...o,
});

describe('invertBackupJobStatus', () => {
  it('round-trips every backup_status value through mapBackupJobStatus', () => {
    const jobStatuses: BackupJobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled', 'partial'];
    for (const jobStatus of jobStatuses) {
      const external = mapBackupJobStatus(jobStatus);
      expect(
        invertBackupJobStatus(external).jobStatuses,
        `${jobStatus} -> ${external} must invert back`,
      ).toContain(jobStatus);
    }
  });

  it('maps the no-jobs case to matchNoJobs, with no job statuses', () => {
    expect(invertBackupJobStatus('no_backups')).toEqual({ jobStatuses: [], matchNoJobs: true });
  });

  it.each(['over_quota', 'no_selection', 'not_started', 'unknown'] as const)(
    'has no first-party spelling for %s, so it selects nothing',
    (status) => {
      expect(invertBackupJobStatus(status)).toEqual({ jobStatuses: [], matchNoJobs: false });
    },
  );

  it('covers every enum value without throwing', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      expect(() => invertBackupJobStatus(status)).not.toThrow();
    }
  });

  it('keeps partial (a degraded but restorable run) out of the failed bucket', () => {
    expect(invertBackupJobStatus('failed').jobStatuses).not.toContain('partial');
    expect(invertBackupJobStatus('completed_with_errors').jobStatuses).toContain('partial');
    expect(RESTORABLE_BACKUP_JOB_STATUSES).toContain('partial');
  });
});

describe('isConnectionStale', () => {
  it('is false when the connection row is invisible (org token, RLS filtered it)', () => {
    expect(isConnectionStale({ isActive: null, lastSyncAt: null, syncIntervalMinutes: null }, NOW)).toBe(false);
  });

  it('is true when the connection is deactivated', () => {
    expect(
      isConnectionStale({ isActive: false, lastSyncAt: NOW.toISOString(), syncIntervalMinutes: 30 }, NOW),
    ).toBe(true);
  });

  it('is true when a visible connection has never recorded a sync', () => {
    expect(isConnectionStale({ isActive: true, lastSyncAt: null, syncIntervalMinutes: 30 }, NOW)).toBe(true);
  });

  it('is false inside 2x the interval and true outside it', () => {
    const inside = new Date(NOW.getTime() - 59 * 60_000).toISOString();
    const outside = new Date(NOW.getTime() - 61 * 60_000).toISOString();
    expect(isConnectionStale({ isActive: true, lastSyncAt: inside, syncIntervalMinutes: 30 }, NOW)).toBe(false);
    expect(isConnectionStale({ isActive: true, lastSyncAt: outside, syncIntervalMinutes: 30 }, NOW)).toBe(true);
  });

  it('falls back to a 30-minute interval when the column is null', () => {
    const outside = new Date(NOW.getTime() - 61 * 60_000).toISOString();
    expect(isConnectionStale({ isActive: true, lastSyncAt: outside, syncIntervalMinutes: null }, NOW)).toBe(true);
  });
});

describe('providerLabelFor', () => {
  it('returns the adapter label for the web (vendor mode) regardless of the portal toggle', () => {
    expect(providerLabelFor('cove', { portalShowProviderName: false, labels: 'vendor' })).toBe('Cove Data Protection');
  });

  it('hides the vendor behind the generic label in portal mode when the toggle is off', () => {
    expect(providerLabelFor('cove', { portalShowProviderName: false, labels: 'portal' })).toBe(GENERIC_PROVIDER_LABEL);
    expect(providerLabelFor('cove', { portalShowProviderName: true, labels: 'portal' })).toBe('Cove Data Protection');
  });

  it('falls back to the raw key for an unregistered provider instead of throwing', () => {
    expect(providerLabelFor('veeam', { portalShowProviderName: true, labels: 'vendor' })).toBe('veeam');
  });

  it('is null for a null key', () => {
    expect(providerLabelFor(null, { portalShowProviderName: true, labels: 'vendor' })).toBeNull();
  });
});

describe('deviceRoleToRowType', () => {
  it.each([
    ['workstation', 'workstation'],
    ['server', 'server'],
    ['printer', 'unknown'],
    ['unknown', 'unknown'],
    [null, 'unknown'],
  ])('%s -> %s', (role, expected) => {
    expect(deviceRoleToRowType(role as string | null)).toBe(expected);
  });
});

describe('toBreezeHealthRow', () => {
  it('projects a completed recent run as a healthy, covered Breeze row', () => {
    const row = toBreezeHealthRow(breezeLeg(), { now: NOW });
    expect(row).toMatchObject({
      key: `breeze:${DEVICE}`,
      source: 'breeze',
      providerKey: null,
      providerLabel: null,
      orgId: ORG,
      orgName: 'Acme',
      siteId: SITE,
      deviceId: DEVICE,
      name: 'SRV01',
      computerName: 'srv01.acme.local',
      osType: 'server',
      accountType: 'endpoint',
      status: 'completed',
      health: 'healthy',
      recency: 'under_24h',
      covered: true,
      stale: false,
      selectedBytes: null,
      usedBytes: 1024,
      errorsCount: 0,
      dataSources: [],
      agentOnline: true,
    });
    expect(row.history28d).toEqual([]); // filled by the read model, not here
  });

  it('is status no_backups — never dropped — when the device has no jobs at all', () => {
    const row = toBreezeHealthRow(
      breezeLeg({ jobStatus: null, lastSessionAt: null, lastSuccessAt: null, hasJobs: false, totalSize: null }),
      { now: NOW },
    );
    expect(row.status).toBe('no_backups');
    expect(row.health).toBe('critical');
    expect(row.covered).toBe(false);
    expect(row.lastSuccessAt).toBeNull();
  });

  it('agentOnline is false for any non-online device status, never null when linked', () => {
    expect(toBreezeHealthRow(breezeLeg({ deviceStatus: 'offline' }), { now: NOW }).agentOnline).toBe(false);
  });

  it('serialises timestamps as ISO strings', () => {
    const row = toBreezeHealthRow(breezeLeg({ lastSuccessAt: new Date('2026-09-15T02:30:00.000Z') }), { now: NOW });
    expect(row.lastSuccessAt).toBe('2026-09-15T02:30:00.000Z');
  });
});

describe('toProviderHealthRow', () => {
  it('projects a provider row with its vendor label and linked device', () => {
    const row = toProviderHealthRow(providerLeg(), { now: NOW, labels: 'vendor' });
    expect(row).toMatchObject({
      key: `provider:${ROW}`,
      source: 'provider',
      providerKey: 'cove',
      providerLabel: 'Cove Data Protection',
      deviceId: DEVICE,
      siteId: SITE,
      accountType: 'endpoint',
      status: 'completed',
      covered: true,
      stale: false,
      selectedBytes: 2048,
      usedBytes: 4096,
      dataSources: ['files', 'system_state'],
      agentOnline: false,
    });
  });

  it('has a null siteId and a null agentOnline when unlinked', () => {
    const row = toProviderHealthRow(
      providerLeg({ breezeDeviceId: null, deviceStatus: null, deviceSiteId: null }),
      { now: NOW, labels: 'vendor' },
    );
    expect(row.deviceId).toBeNull();
    expect(row.siteId).toBeNull();
    expect(row.agentOnline).toBeNull();
  });

  it('marks an m365 account with its own accountType', () => {
    expect(toProviderHealthRow(providerLeg({ accountType: 'm365' }), { now: NOW, labels: 'vendor' }).accountType).toBe('m365');
  });

  it('forces health unknown and covered false when the sync is stale, and says so', () => {
    const row = toProviderHealthRow(
      providerLeg({ connectionLastSyncAt: '2026-09-15T09:00:00.000Z' }), // 3h > 2 x 30min
      { now: NOW, labels: 'vendor' },
    );
    expect(row.stale).toBe(true);
    expect(row.health).toBe('unknown');
    expect(row.covered).toBe(false);
    // The raw status and timestamps survive — the UI still shows what was last seen.
    expect(row.status).toBe('completed');
    expect(row.lastSuccessAt).toBe('2026-09-15T01:00:00.000Z');
  });

  it('keeps a critical health when the vendor says failed but a fresh restore point exists', () => {
    const row = toProviderHealthRow(
      providerLeg({ status: 'failed', errorsCount: 3, lastSuccessAt: '2026-09-15T01:00:00.000Z' }),
      { now: NOW, labels: 'vendor' },
    );
    // D4: coverage says "it has a backup", health says "look at it".
    expect(row.health).toBe('critical');
    expect(row.covered).toBe(true);
  });
});

describe('buildHistoryWindow / fillHistoryWindow', () => {
  it('is 28 UTC days ending today, ascending', () => {
    const window = buildHistoryWindow(NOW);
    expect(window).toHaveLength(BACKUP_HISTORY_DAYS);
    expect(window[0]).toBe('2026-08-19');
    expect(window[BACKUP_HISTORY_DAYS - 1]).toBe('2026-09-15');
  });

  it('renders an unobserved day as null rather than dropping the cell', () => {
    const window = ['2026-09-13', '2026-09-14', '2026-09-15'];
    const filled = fillHistoryWindow(window, new Map([['2026-09-14', 'failed' as const]]));
    expect(filled).toEqual([
      { day: '2026-09-13', status: null },
      { day: '2026-09-14', status: 'failed' },
      { day: '2026-09-15', status: null },
    ]);
  });
});

describe('foldJobsIntoDays', () => {
  it('keeps the WORST status observed on a day, so a nightly failure is not laundered by a retry', () => {
    const days = foldJobsIntoDays([
      { status: 'completed', at: '2026-09-14T23:00:00.000Z' },
      { status: 'failed', at: '2026-09-14T01:00:00.000Z' },
      { status: 'completed', at: '2026-09-15T01:00:00.000Z' },
    ]);
    expect(days.get('2026-09-14')).toBe('failed');
    expect(days.get('2026-09-15')).toBe('completed');
  });

  it('ignores a job with no usable timestamp instead of bucketing it into today', () => {
    expect(foldJobsIntoDays([{ status: 'failed', at: null }]).size).toBe(0);
  });
});

describe('mergeSortedRows', () => {
  const r = (name: string, key: string) => ({ name, key });

  it('interleaves two already-sorted legs by (lower(name), key)', () => {
    const left = [r('alpha', 'breeze:1'), r('charlie', 'breeze:3')];
    const right = [r('Bravo', 'provider:2'), r('delta', 'provider:4')];
    expect(mergeSortedRows(left, right, 10).map((x) => x.name)).toEqual(['alpha', 'Bravo', 'charlie', 'delta']);
  });

  it('stops at the limit without consuming the rest', () => {
    const left = [r('a', 'breeze:1'), r('c', 'breeze:3')];
    const right = [r('b', 'provider:2')];
    expect(mergeSortedRows(left, right, 2).map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('handles an empty leg (provider sync not merged yet)', () => {
    const left = [r('a', 'breeze:1')];
    expect(mergeSortedRows(left, [], 10)).toEqual(left);
    expect(mergeSortedRows([], left, 10)).toEqual(left);
  });
});

describe('foldBackupHealthSummary', () => {
  const row = (o: Partial<ReturnType<typeof toBreezeHealthRow>>) =>
    ({ ...toBreezeHealthRow(breezeLeg(), { now: NOW }), ...o }) as ReturnType<typeof toBreezeHealthRow>;

  it('starts from an all-zero shape with every enum key present', () => {
    const empty = emptyBackupHealthSummary();
    expect(empty.endpoints).toEqual({ total: 0, covered: 0, uncovered: 0 });
    expect(Object.keys(empty.byStatus).sort()).toEqual([...EXTERNAL_BACKUP_STATUSES].sort());
    expect(empty.byHealth).toEqual({ healthy: 0, warning: 0, critical: 0, unknown: 0 });
    expect(empty.byRecency).toEqual({ under_24h: 0, under_48h: 0, over_48h: 0, never: 0 });
  });

  it('counts a dual-source device ONCE in endpoints and ORs its coverage', () => {
    const summary = foldBackupHealthSummary([
      row({ key: `breeze:${DEVICE}`, source: 'breeze', deviceId: DEVICE, covered: false, status: 'no_backups', health: 'critical', recency: 'never' }),
      row({ key: `provider:${ROW}`, source: 'provider', deviceId: DEVICE, covered: true, status: 'completed', health: 'healthy', recency: 'under_24h' }),
    ]);
    expect(summary.endpoints).toEqual({ total: 1, covered: 1, uncovered: 0 });
    expect(summary.providerOnly).toBe(0);
    // Both rows still count in the status/health/recency bars — they are row-level facts.
    expect(summary.byStatus.no_backups).toBe(1);
    expect(summary.byStatus.completed).toBe(1);
  });

  it('counts an unlinked provider endpoint under providerOnly, not endpoints', () => {
    const summary = foldBackupHealthSummary([
      row({ key: `provider:${ROW}`, source: 'provider', deviceId: null, accountType: 'endpoint', covered: true }),
    ]);
    expect(summary.endpoints.total).toBe(0);
    expect(summary.providerOnly).toBe(1);
  });

  it('counts m365 accounts under their own denominator and never as endpoints', () => {
    const summary = foldBackupHealthSummary([
      row({ key: `provider:${ROW}`, source: 'provider', deviceId: null, accountType: 'm365', covered: true }),
    ]);
    expect(summary.m365Accounts).toBe(1);
    expect(summary.providerOnly).toBe(0);
    expect(summary.endpoints.total).toBe(0);
  });

  it('keeps uncovered = total - covered', () => {
    const summary = foldBackupHealthSummary([
      row({ key: 'breeze:1', deviceId: '1', covered: true }),
      row({ key: 'breeze:2', deviceId: '2', covered: false }),
      row({ key: 'breeze:3', deviceId: '3', covered: false }),
    ]);
    expect(summary.endpoints).toEqual({ total: 3, covered: 1, uncovered: 2 });
  });
});

describe('derivation is delegated, never re-implemented', () => {
  it('every provider row reports exactly what deriveBackupHealth says', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      const leg = providerLeg({ status, lastSuccessAt: '2026-09-13T12:00:00.000Z', errorsCount: 2 });
      const expected = deriveBackupHealth({ status, lastSuccessAt: leg.lastSuccessAt, errorsCount: 2, now: NOW });
      const row = toProviderHealthRow(leg, { now: NOW, labels: 'vendor' });
      expect({ health: row.health, recency: row.recency, covered: row.covered }).toEqual(expected);
    }
  });
});
