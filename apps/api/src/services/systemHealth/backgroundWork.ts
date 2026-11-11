/**
 * System → Health: shared background-processing observations (spec 2026-10-30
 * system-health-admin-design §5, §6.2, §12). Read-only, Redis-backed, bounded.
 *
 * - Queues: a fixed registry of four BullMQ queues, counts only. Status is
 *   `unknown` until the owning domain defines a threshold (§12.2, D7/D8).
 * - Jobs: connection-health heartbeats only, via readConnectionHealthJobStatus()
 *   (§12.3). A known failure streak is `degraded`; stale or missing evidence is
 *   `unknown` (§12.4).
 *
 * Never throws and never returns raw error text: failures become a stable
 * `detailCode` so one broken source does not hide the others (§6.3).
 */
import type { Queue } from 'bullmq';
import { getConnectionHealthQueue } from '../../jobs/connectionHealthReconcile';
import { getConnectionHealthDigestQueue } from '../../jobs/connectionHealthDigest';
import { getAlertQueue } from '../../jobs/alertWorker';
import { getEventDispatchQueue } from '../eventDispatchQueue';
import {
  readConnectionHealthJobStatus,
  type HeartbeatRedis,
} from '../connectionHealth/heartbeat';

export type HealthStatus = 'operational' | 'degraded' | 'unavailable' | 'unknown' | 'disabled';
export type HealthDetailCode =
  | 'redis_unavailable'
  | 'read_failed'
  | 'timeout'
  | 'stale'
  | 'missing'
  | 'no_threshold';

export type QueueCountKey = 'waiting' | 'prioritized' | 'delayed' | 'active';
export type QueueId = 'connection-health-reconcile' | 'connection-health-digest' | 'alerts' | 'event-dispatch';

export type QueueObservation = {
  id: QueueId;
  status: HealthStatus;
  checkedAt: string;
  detailCode: HealthDetailCode | null;
  counts: Partial<Record<QueueCountKey, number>> | null;
};

export type JobObservation = {
  id: 'reconcile' | 'digest' | 'kind';
  /** Connection-health kind name for per-kind heartbeats; null for the two loops. */
  kind: string | null;
  status: HealthStatus;
  checkedAt: string;
  lastRunAt: string | null;
  failureStreak?: number;
  detailCode: HealthDetailCode | null;
};

export type SystemHealthReport = {
  generatedAt: string;
  queues: QueueObservation[];
  jobs: JobObservation[];
};

export const QUEUE_READ_TIMEOUT_MS = 2000;

const QUEUE_REGISTRY: ReadonlyArray<{ id: QueueId; get: () => Queue }> = [
  { id: 'connection-health-reconcile', get: getConnectionHealthQueue },
  { id: 'connection-health-digest', get: getConnectionHealthDigestQueue },
  { id: 'alerts', get: getAlertQueue },
  { id: 'event-dispatch', get: getEventDispatchQueue },
];

const COUNT_KEYS: readonly QueueCountKey[] = ['waiting', 'prioritized', 'delayed', 'active'];

async function readQueueCounts(get: () => Queue): Promise<Partial<Record<QueueCountKey, number>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('queue_read_timeout')), QUEUE_READ_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([get().getJobCounts(...COUNT_KEYS), timeout]);
    const counts: Partial<Record<QueueCountKey, number>> = {};
    for (const key of COUNT_KEYS) {
      const value = Number((raw as Record<string, unknown>)[key]);
      if (Number.isFinite(value)) counts[key] = value;
    }
    return counts;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyQueueError(err: unknown): HealthDetailCode {
  return err instanceof Error && err.message === 'queue_read_timeout' ? 'timeout' : 'read_failed';
}

async function observeQueue(id: QueueId, get: () => Queue, redisDown: boolean, now: string): Promise<QueueObservation> {
  if (redisDown) {
    return { id, status: 'unknown', checkedAt: now, detailCode: 'redis_unavailable', counts: null };
  }
  try {
    const counts = await readQueueCounts(get);
    // No domain threshold is defined yet, so a readable count is never a verdict (§12.2).
    return { id, status: 'unknown', checkedAt: now, detailCode: 'no_threshold', counts };
  } catch (err) {
    const detailCode = classifyQueueError(err);
    console.warn(JSON.stringify({ event: 'system_health_queue_read_failed', queue: id, detailCode }));
    return { id, status: 'unknown', checkedAt: now, detailCode, counts: null };
  }
}

export async function buildSystemHealthReport(input: {
  redis: HeartbeatRedis | null;
  kinds: ReadonlyArray<{ kind: string; intervalMinutes: number }>;
  now: Date;
}): Promise<SystemHealthReport> {
  const nowIso = input.now.toISOString();
  const jobStatus = await readConnectionHealthJobStatus(input.redis, input.kinds, input.now);
  const redisDown = jobStatus.redis === 'unavailable';

  const queues = await Promise.all(
    QUEUE_REGISTRY.map((q) => observeQueue(q.id, q.get, redisDown, nowIso)),
  );

  const heartbeatStatus = (
    state: 'ok' | 'stale' | 'missing',
  ): { status: HealthStatus; detailCode: HealthDetailCode | null } => {
    if (redisDown) return { status: 'unknown', detailCode: 'redis_unavailable' };
    if (state === 'ok') return { status: 'operational', detailCode: null };
    return { status: 'unknown', detailCode: state };
  };

  const loops: JobObservation[] = (['reconcile', 'digest'] as const).map((id) => {
    const job = jobStatus[id];
    return {
      id,
      kind: null,
      ...heartbeatStatus(job.state),
      checkedAt: nowIso,
      lastRunAt: job.lastRunAt,
    };
  });

  const kinds: JobObservation[] = jobStatus.kinds.map((k) => {
    const base = { id: 'kind' as const, kind: k.kind, checkedAt: nowIso, lastRunAt: k.lastOkAt, failureStreak: k.failureStreak };
    if (k.state === 'failing' && !redisDown) {
      return { ...base, status: 'degraded', detailCode: null };
    }
    return { ...base, ...heartbeatStatus(k.state === 'failing' ? 'missing' : k.state) };
  });

  return { generatedAt: nowIso, queues, jobs: [...loops, ...kinds] };
}
