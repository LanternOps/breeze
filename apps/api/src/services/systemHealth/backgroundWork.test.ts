/**
 * System → Health background-work report (spec 2026-10-30-system-health-admin-design
 * §5, §6.3, §9). Queues are counts-only with `unknown` status (§12.2); jobs are
 * connection-health heartbeats only (§12.3, §12.4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queues = vi.hoisted(() => ({
  reconcile: { getJobCounts: vi.fn() },
  digest: { getJobCounts: vi.fn() },
  alerts: { getJobCounts: vi.fn() },
  dispatch: { getJobCounts: vi.fn() },
}));

vi.mock('../../jobs/connectionHealthReconcile', () => ({ getConnectionHealthQueue: () => queues.reconcile }));
vi.mock('../../jobs/connectionHealthDigest', () => ({ getConnectionHealthDigestQueue: () => queues.digest }));
vi.mock('../../jobs/alertWorker', () => ({ getAlertQueue: () => queues.alerts }));
vi.mock('../eventDispatchQueue', () => ({ getEventDispatchQueue: () => queues.dispatch }));

import { buildSystemHealthReport, QUEUE_READ_TIMEOUT_MS } from './backgroundWork';
import {
  RECONCILE_HEARTBEAT_KEY,
  DIGEST_HEARTBEAT_KEY,
  kindStateKey,
  type HeartbeatRedis,
} from '../connectionHealth/heartbeat';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const KINDS = [{ kind: 'm365_sync', intervalMinutes: 15 }];

function fakeRedis(values: Record<string, string>): HeartbeatRedis {
  return {
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => values[k] ?? null)),
    set: vi.fn(async () => 'OK'),
  };
}

function healthyValues(): Record<string, string> {
  return {
    [RECONCILE_HEARTBEAT_KEY]: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    [DIGEST_HEARTBEAT_KEY]: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    [kindStateKey('m365_sync', 'last-ok')]: String(NOW.getTime() - 2 * 60_000),
    [kindStateKey('m365_sync', 'failures')]: '0',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const q of Object.values(queues)) {
    q.getJobCounts.mockResolvedValue({ waiting: 2, prioritized: 1, delayed: 3, active: 0, paused: 0 });
  }
});

describe('buildSystemHealthReport', () => {
  it('reports queue counts as unknown with no_threshold, and fresh heartbeats as operational', async () => {
    const report = await buildSystemHealthReport({ redis: fakeRedis(healthyValues()), kinds: KINDS, now: NOW });

    expect(report.queues.map((q) => q.id)).toEqual([
      'connection-health-reconcile',
      'connection-health-digest',
      'alerts',
      'event-dispatch',
    ]);
    for (const q of report.queues) {
      expect(q.status).toBe('unknown');
      expect(q.detailCode).toBe('no_threshold');
      expect(q.counts).toEqual({ waiting: 2, prioritized: 1, delayed: 3, active: 0 });
    }
    const byId = Object.fromEntries(report.jobs.map((j) => [`${j.id}:${j.kind ?? ''}`, j]));
    expect(byId['reconcile:']?.status).toBe('operational');
    expect(byId['digest:']?.status).toBe('operational');
    expect(byId['kind:m365_sync']?.status).toBe('operational');
  });

  it('maps a known failure streak to degraded and a stale heartbeat to unknown', async () => {
    const values = healthyValues();
    values[kindStateKey('m365_sync', 'failures')] = '3';
    values[RECONCILE_HEARTBEAT_KEY] = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
    const report = await buildSystemHealthReport({ redis: fakeRedis(values), kinds: KINDS, now: NOW });

    const kind = report.jobs.find((j) => j.id === 'kind');
    expect(kind?.status).toBe('degraded');
    expect(kind?.failureStreak).toBe(3);
    const reconcile = report.jobs.find((j) => j.id === 'reconcile');
    expect(reconcile).toMatchObject({ status: 'unknown', detailCode: 'stale' });
  });

  it('marks everything unknown with redis_unavailable and never calls the queues when Redis is absent', async () => {
    const report = await buildSystemHealthReport({ redis: null, kinds: KINDS, now: NOW });

    for (const q of report.queues) {
      expect(q.status).toBe('unknown');
      expect(q.detailCode).toBe('redis_unavailable');
      expect(q.counts).toBeNull();
    }
    for (const j of report.jobs) {
      expect(j.status).toBe('unknown');
      expect(j.detailCode).toBe('redis_unavailable');
    }
    expect(queues.reconcile.getJobCounts).not.toHaveBeenCalled();
  });

  it('isolates a failing queue: the others are still read and the error text never reaches the report', async () => {
    queues.alerts.getJobCounts.mockRejectedValue(new Error('ECONNREFUSED redis://user:secret@10.0.0.5:6379'));
    const report = await buildSystemHealthReport({ redis: fakeRedis(healthyValues()), kinds: KINDS, now: NOW });

    const alerts = report.queues.find((q) => q.id === 'alerts');
    expect(alerts).toMatchObject({ status: 'unknown', detailCode: 'read_failed', counts: null });
    const dispatch = report.queues.find((q) => q.id === 'event-dispatch');
    expect(dispatch?.counts).not.toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/secret|10\.0\.0\.5|ECONNREFUSED/);
  });

  it('times out a hanging queue read with detailCode timeout', async () => {
    vi.useFakeTimers();
    try {
      queues.digest.getJobCounts.mockReturnValue(new Promise(() => undefined));
      const pending = buildSystemHealthReport({ redis: fakeRedis(healthyValues()), kinds: KINDS, now: NOW });
      await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS + 10);
      const report = await pending;
      expect(report.queues.find((q) => q.id === 'connection-health-digest')).toMatchObject({
        status: 'unknown',
        detailCode: 'timeout',
        counts: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
