import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { tightenStatementTimeout } from '../../db/lockTimeout';
import { sendOpsAlert } from '../opsAlerts';
import { getRedis } from '../redis';
import { deliverPendingNotices } from './notifier';
import { HEALTH_SOURCES } from './sources';
import { applyActions, deleteExpiredResolved, loadTracked } from './store';
import { planTransitions } from './transitions';
import type { HealthSource } from './types';

// The connection health reconciler (spec 2026-10-15 §1.2, §1.3, §8). One run:
// every due kind in its own system transaction, then the notice outbox, then
// retention. Redis only remembers cadence, the seed flag and failure streaks;
// when it is missing or erroring, every kind is due and none seeds, because a
// seed run opens incidents without notifying and Redis is what proves the
// seed already happened.

const KIND_STATEMENT_TIMEOUT_MS = 5_000;
const RUN_BUDGET_MS = 60_000;
const FAILURE_ALERT_AT = 3;
// A 15-minute kind must stay due on every 15-minute tick despite job jitter.
const DUE_SLACK_MS = 30_000;
const HEARTBEAT_KEY = 'connection-health:reconcile:heartbeat';
const HEARTBEAT_TTL_S = 3600;
const key = (kind: string, k: 'last-ok' | 'seeded' | 'failures') => `connection-health:kind:${kind}:${k}`;

type KindCounts = { opened: number; resolved: number; pending: number; observations: number };

/** The four Redis calls the reconciler makes; an ioredis client satisfies it. */
export type ReconcileRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  del(key: string): Promise<number>;
};

export type ReconcileDeps = {
  sources: readonly HealthSource[];
  now: () => Date;
  redis: ReconcileRedis | null;
  budgetMs: number;
  runKind: (source: HealthSource, now: Date, seed: boolean) => Promise<KindCounts>;
  deliver: (now: Date) => Promise<{ delivered: number; failed: number }>;
  retention: (now: Date) => Promise<number>;
  alert: (msg: { title: string; body: string }) => Promise<boolean>;
};

export type KindResult = {
  kind: string;
  status: 'ok' | 'failed' | 'skipped_not_due' | 'skipped_budget';
  durationMs: number;
  error?: string;
} & Partial<KindCounts>;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Load → observe → plan → apply for one kind, in ONE system-scope transaction
 * (spec §1.2 step 3). Any throw, from observe() or part-way through applying,
 * rolls the whole kind back, so its incidents are left exactly as they were.
 */
export async function runKindInSystemScope(source: HealthSource, now: Date, seed: boolean): Promise<KindCounts> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await tightenStatementTimeout(db, KIND_STATEMENT_TIMEOUT_MS);
    const tracked = await loadTracked(source.kind, now);
    const observations = await source.observe(now, tracked.map((t) => t.sourceId));
    const actions = planTransitions({ observations, tracked, now, seed });
    const counts = await applyActions(actions, now);
    return { ...counts, observations: observations.length };
  }, `connectionHealth.reconcile.${source.kind}`));
}

function resolveDeps(overrides: Partial<ReconcileDeps>): ReconcileDeps {
  return {
    sources: overrides.sources ?? HEALTH_SOURCES,
    now: overrides.now ?? (() => new Date()),
    // `null` is meaningful (no Redis), so only an absent key falls back.
    redis: 'redis' in overrides ? overrides.redis ?? null : getRedis(),
    budgetMs: overrides.budgetMs ?? RUN_BUDGET_MS,
    runKind: overrides.runKind ?? runKindInSystemScope,
    deliver: overrides.deliver ?? ((now) => deliverPendingNotices(now)),
    retention: overrides.retention ?? ((now) => runOutsideDbContext(() => withSystemDbAccessContext(
      () => deleteExpiredResolved(now),
      'connectionHealth.retention',
    ))),
    alert: overrides.alert ?? sendOpsAlert,
  };
}

/** A Redis call that degrades to `fallback` instead of failing the run. */
async function tryRedis<T>(op: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(JSON.stringify({ event: 'connection_health_redis_error', op, error: errorMessage(err) }));
    return fallback;
  }
}

/** Due and seed, decided from Redis. Unreadable Redis → due, and no seed. */
async function readKindState(
  redis: ReconcileDeps['redis'],
  source: HealthSource,
  now: Date,
): Promise<{ due: boolean; seed: boolean }> {
  if (!redis) return { due: true, seed: false };
  try {
    const [lastOkRaw, seeded] = await Promise.all([
      redis.get(key(source.kind, 'last-ok')),
      redis.get(key(source.kind, 'seeded')),
    ]);
    const lastOk = Number(lastOkRaw ?? 0);
    const due = !(lastOk > 0 && now.getTime() - lastOk < source.intervalMinutes * 60_000 - DUE_SLACK_MS);
    return { due, seed: seeded === null };
  } catch (err) {
    console.warn(JSON.stringify({ event: 'connection_health_redis_error', op: 'read-kind-state', kind: source.kind, error: errorMessage(err) }));
    return { due: true, seed: false };
  }
}

async function recordSuccess(redis: NonNullable<ReconcileDeps['redis']>, kind: string, at: Date, seeded: boolean) {
  // Only after the kind's transaction committed: a failed seed run seeds again.
  // Written first and on its own, since losing it is the costly miss (the next
  // run would seed again and silently open any new break).
  if (seeded) await tryRedis('mark-seeded', () => redis.set(key(kind, 'seeded'), '1'), null);
  await tryRedis('record-last-ok', () => redis.set(key(kind, 'last-ok'), String(at.getTime())), null);
  await tryRedis('reset-failures', () => redis.del(key(kind, 'failures')), 0);
}

async function recordFailure(d: ReconcileDeps, kind: string, message: string) {
  if (!d.redis) return;
  const redis = d.redis;
  const streak = await tryRedis('record-failure', () => redis.incr(key(kind, 'failures')), 0);
  // Exactly at the threshold: one alert per streak, not one per run after it.
  if (streak !== FAILURE_ALERT_AT) return;
  try {
    await d.alert({
      title: `Connection health: ${kind} source failing`,
      body: `The ${kind} health check failed ${streak} runs in a row. Its incidents are frozen until it recovers. Last error: ${message}`,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'connection_health_alert_failed', kind, error: errorMessage(err) }));
  }
}

export async function runReconcile(overrides: Partial<ReconcileDeps> = {}): Promise<{
  kinds: KindResult[];
  notices: { delivered: number; failed: number };
  retained: number;
}> {
  const d = resolveDeps(overrides);
  const started = d.now();
  const kinds: KindResult[] = [];

  for (const source of d.sources) {
    const t0 = d.now();
    if (t0.getTime() - started.getTime() >= d.budgetMs) {
      kinds.push({ kind: source.kind, status: 'skipped_budget', durationMs: 0 });
      continue;
    }
    const { due, seed } = await readKindState(d.redis, source, t0);
    if (!due) {
      kinds.push({ kind: source.kind, status: 'skipped_not_due', durationMs: 0 });
      continue;
    }
    try {
      const counts = await d.runKind(source, t0, seed);
      if (d.redis) await recordSuccess(d.redis, source.kind, t0, seed);
      kinds.push({ kind: source.kind, status: 'ok', durationMs: d.now().getTime() - t0.getTime(), ...counts });
    } catch (err) {
      const message = errorMessage(err);
      kinds.push({ kind: source.kind, status: 'failed', durationMs: d.now().getTime() - t0.getTime(), error: message });
      await recordFailure(d, source.kind, message);
    }
  }

  // After every kind committed, outside any DB context (both helpers open their own).
  // A failure in either still lets the other run, then fails the job without a heartbeat.
  const failures: Array<{ step: string; err: unknown }> = [];
  let notices = { delivered: 0, failed: 0 };
  let retained = 0;
  try {
    notices = await d.deliver(d.now());
  } catch (err) {
    failures.push({ step: 'deliver', err });
  }
  try {
    retained = await d.retention(d.now());
  } catch (err) {
    failures.push({ step: 'retention', err });
  }

  const finished = d.now();
  const skippedBudget = kinds.filter((k) => k.status === 'skipped_budget').length;
  const summary = {
    event: 'connection_health_reconcile',
    durationMs: finished.getTime() - started.getTime(),
    kinds,
    notices,
    retained,
    skippedBudget,
    failedKinds: kinds.filter((k) => k.status === 'failed').length,
    ...(failures.length ? { errors: failures.map((f) => ({ step: f.step, error: errorMessage(f.err) })) } : {}),
  };
  if (failures.length || skippedBudget || summary.failedKinds) console.warn(JSON.stringify(summary));
  else console.info(JSON.stringify(summary));

  if (failures.length) throw failures[0]!.err;

  if (d.redis) {
    const redis = d.redis;
    await tryRedis('heartbeat', () => redis.set(HEARTBEAT_KEY, finished.toISOString(), 'EX', HEARTBEAT_TTL_S), null);
  }
  return { kinds, notices, retained };
}
