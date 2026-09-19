import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Rows handed back, in order, to successive `db.select()` chains. */
let selectResults: unknown[][] = [];
const captured: { wheres: unknown[] } = { wheres: [] };

vi.mock('../db', () => {
  const chain = () => {
    const rows = selectResults.shift() ?? [];
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.leftJoin = () => c;
    c.innerJoin = () => c;
    c.where = (condition: unknown) => { captured.wheres.push(condition); return c; };
    c.orderBy = () => c;
    c.limit = () => Promise.resolve(rows);
    c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, err);
    return c;
  };
  return { db: { select: () => chain() } };
});

import { loadReachabilityInputs, loadReachability } from './assetReachabilityLoader';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-16T12:00:00.000Z');

beforeEach(() => {
  selectResults = [];
  captured.wheres = [];
});

describe('loadReachabilityInputs', () => {
  it('returns an empty map without touching the database for an empty id list', async () => {
    const result = await loadReachabilityInputs([]);
    expect(result.size).toBe(0);
    expect(captured.wheres).toHaveLength(0);
  });

  it('assembles asset, snmp, monitors and scan interval per asset', async () => {
    selectResults = [
      // 1. assets (+ profile schedule via last_job_id -> discovery_jobs -> discovery_profiles)
      [
        {
          id: A1, isOnline: true, statusObservedAt: NOW, statusSource: 'scan', lastSeenAt: NOW,
          lastProbeAt: null, lastProbeStatus: null, lastProbeResponseMs: null,
          profileSchedule: { type: 'interval', intervalMinutes: 30 },
        },
        {
          id: A2, isOnline: false, statusObservedAt: null, statusSource: null, lastSeenAt: null,
          lastProbeAt: null, lastProbeStatus: null, lastProbeResponseMs: null,
          profileSchedule: { type: 'cron', cron: '0 * * * *' },
        },
      ],
      // 2. snmp devices (DISTINCT ON asset_id)
      [{ assetId: A1, isActive: true, lastStatus: 'online', lastPolled: NOW, lastPollAttemptedAt: NOW, pollingInterval: 300, consecutiveFailures: 0 }],
      // 3. host-class network monitors
      [{ assetId: A1, id: 'mon-1', monitorType: 'icmp_ping', isActive: true, lastStatus: 'online', lastChecked: NOW, lastResponseMs: 3, pollingInterval: 60 }],
    ];

    const map = await loadReachabilityInputs([A1, A2]);

    expect(map.get(A1)!.scanIntervalSeconds).toBe(1800);
    expect(map.get(A1)!.snmpDevice!.lastStatus).toBe('online');
    expect(map.get(A1)!.networkMonitors).toHaveLength(1);
    // A cron schedule yields no interval — the service falls back to 24 h.
    expect(map.get(A2)!.scanIntervalSeconds).toBeNull();
    expect(map.get(A2)!.snmpDevice).toBeNull();
    expect(map.get(A2)!.networkMonitors).toEqual([]);
  });

  it('omits an asset id that does not resolve to a row', async () => {
    selectResults = [[], [], []];
    const map = await loadReachabilityInputs([A1]);
    expect(map.has(A1)).toBe(false);
  });
});

describe('loadReachability', () => {
  it('derives per asset with a single injected clock', async () => {
    selectResults = [
      [{ id: A1, isOnline: true, statusObservedAt: NOW, statusSource: 'unifi', lastSeenAt: NOW, lastProbeAt: null, lastProbeStatus: null, lastProbeResponseMs: null, profileSchedule: null }],
      [],
      [],
    ];
    const map = await loadReachability([A1], NOW);
    expect(map.get(A1)!.state).toBe('responding');
    expect(map.get(A1)!.source).toBe('unifi');
  });
});
