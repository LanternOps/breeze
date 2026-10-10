import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, runAfterDbContextExit, withDbTransaction } from '../db';
import { lockTimeoutWasChanged, tightenLockTimeout } from '../db/lockTimeout';
import { deviceReliabilityBaselines, users } from '../db/schema';
import {
  RELIABILITY_SCORER_VERSION, reliabilityBeforeSnapshotSchema,
  type ReliabilityBaselineReason, type ReliabilityBaselineSource, type ReliabilityBeforeSnapshot,
} from './reliabilityBaselinePolicy';
import { getActiveReliabilityBaseline } from './reliabilityBaselineQueries';
import { computeAndPersistDeviceReliability, scoreDeviceReliabilityAsOf } from './reliabilityScoring';
import { enqueueDeviceReliabilityComputation } from '../jobs/reliabilityWorker';
import { captureException } from './sentry';
import { isTransientLockError } from '../utils/pgErrors';

// #5876 reliability baseline markers: create (with a frozen before snapshot),
// clear and list. Callers own the DB access context; every statement here runs
// inside it, so a route's marker write and its inline recompute share one
// transaction (the recompute in its own savepoint; see recomputeInlineOrDefer).

export interface CreateReliabilityBaselineInput {
  device: { id: string; orgId: string; deviceRole: string | null; enrolledAt: Date | null };
  reason: ReliabilityBaselineReason;
  baselineAt: Date;                 // already resolved via resolveBaselineAt
  note: string | null;
  source: ReliabilityBaselineSource;
  sourceRef: string | null;
  createdBy: string | null;
  recompute: boolean;               // true = inline recompute in the caller's transaction
}

export interface ReliabilityBaselineDto {
  id: string; baselineAt: string; reason: ReliabilityBaselineReason; source: ReliabilityBaselineSource;
  note: string | null; beforeSnapshot: ReliabilityBeforeSnapshot | null;
  createdBy: { id: string; name: string | null } | null; createdAt: string;
  clearedAt: string | null; clearedBy: { id: string; name: string | null } | null;
  active: boolean;                  // true only for the single effective marker
}

export async function computeBeforeSnapshot(
  device: CreateReliabilityBaselineInput['device'],
  baselineAt: Date,
): Promise<ReliabilityBeforeSnapshot> {
  // Chronological predecessor: the latest active marker strictly before baselineAt
  // (a marker at the same instant must not zero the window it is snapshotting).
  const predecessor = await getActiveReliabilityBaseline(device.id, { before: baselineAt });
  const { values, coverageDays, weightProfile } = await scoreDeviceReliabilityAsOf(device, baselineAt, predecessor);
  return reliabilityBeforeSnapshotSchema.parse({
    version: 1,
    scorerVersion: RELIABILITY_SCORER_VERSION,
    asOf: baselineAt.toISOString(),
    coverageDays,
    reliabilityScore: values.reliabilityScore,
    weightProfile,
    factors: {
      uptime: { score: values.uptimeScore },
      crashes: { score: values.crashScore },
      hangs: { score: values.hangScore },
      serviceFailures: { score: values.serviceFailureScore },
      hardwareErrors: { score: values.hardwareErrorScore },
    },
    counts30d: {
      crashes: values.crashCount30d ?? 0,
      hangs: values.hangCount30d ?? 0,
      serviceFailures: values.serviceFailureCount30d ?? 0,
      hardwareErrors: values.hardwareErrorCount30d ?? 0,
    },
  });
}

// The nightly compute-org job scores a whole org in ONE system transaction, so it
// holds every device_reliability row lock it has upserted until the org finishes.
// An inline recompute on the request path must not wait that out on a pooled
// connection: it runs in a savepoint with a bounded lock wait, and on a lost lock
// race the recompute is handed to the worker instead. The marker itself still
// commits; the scorer's compare-and-set guard makes the later worker write safe.
const INLINE_RECOMPUTE_LOCK_TIMEOUT_MS = 2000;

async function recomputeInlineOrDefer(deviceId: string, dedupeKey: string): Promise<void> {
  try {
    await withDbTransaction(async () => {
      const priorMs = await tightenLockTimeout(db, INLINE_RECOMPUTE_LOCK_TIMEOUT_MS);
      await computeAndPersistDeviceReliability(deviceId);
      // SET LOCAL outlives RELEASE SAVEPOINT, so put the caller's value back.
      if (lockTimeoutWasChanged(priorMs, INLINE_RECOMPUTE_LOCK_TIMEOUT_MS)) {
        await db.execute(sql`SELECT set_config('lock_timeout', ${`${priorMs}ms`}, true)`);
      }
    });
  } catch (err) {
    if (!isTransientLockError(err)) throw err;
    console.warn('[reliability] inline recompute lost a lock race; deferring to the worker', { deviceId });
    runAfterDbContextExit('reliability-baseline-recompute', () =>
      enqueueDeviceReliabilityComputation(deviceId, { dedupeKey }).catch((enqueueErr) => {
        console.error('[reliability] deferred recompute enqueue failed', { deviceId, err: enqueueErr });
        captureException(enqueueErr);
      }));
  }
}

/** Returns null when an automatic marker with the same source_ref already exists (idempotent no-op). */
export async function createReliabilityBaseline(input: CreateReliabilityBaselineInput): Promise<ReliabilityBaselineDto | null> {
  const beforeSnapshot = await computeBeforeSnapshot(input.device, input.baselineAt);
  const inserted = await db
    .insert(deviceReliabilityBaselines)
    .values({
      orgId: input.device.orgId,
      deviceId: input.device.id,
      baselineAt: input.baselineAt,
      reason: input.reason,
      source: input.source,
      sourceRef: input.sourceRef,
      note: input.note?.trim() ? input.note.trim() : null,
      beforeSnapshot,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({
      target: [deviceReliabilityBaselines.deviceId, deviceReliabilityBaselines.sourceRef],
      where: sql`${deviceReliabilityBaselines.sourceRef} IS NOT NULL`,
    })
    .returning({ id: deviceReliabilityBaselines.id });
  if (inserted.length === 0) return null;
  if (input.recompute) await recomputeInlineOrDefer(input.device.id, `baseline-${inserted[0]!.id}`);
  const list = await listReliabilityBaselines(input.device.id);
  return list.find((m) => m.id === inserted[0]!.id) ?? null;
}

export async function clearReliabilityBaseline(input: { deviceId: string; baselineId: string; clearedBy: string | null }):
  Promise<'cleared' | 'not_found' | 'already_cleared'> {
  const updated = await db
    .update(deviceReliabilityBaselines)
    .set({ clearedAt: new Date(), clearedBy: input.clearedBy })
    .where(and(
      eq(deviceReliabilityBaselines.id, input.baselineId),
      eq(deviceReliabilityBaselines.deviceId, input.deviceId),
      isNull(deviceReliabilityBaselines.clearedAt),
    ))
    .returning({ id: deviceReliabilityBaselines.id });
  if (updated.length === 0) {
    const [existing] = await db
      .select({ id: deviceReliabilityBaselines.id })
      .from(deviceReliabilityBaselines)
      .where(and(eq(deviceReliabilityBaselines.id, input.baselineId), eq(deviceReliabilityBaselines.deviceId, input.deviceId)))
      .limit(1);
    return existing ? 'already_cleared' : 'not_found';
  }
  await recomputeInlineOrDefer(input.deviceId, `baseline-clear-${input.baselineId}`);
  return 'cleared';
}

export async function listReliabilityBaselines(deviceId: string): Promise<ReliabilityBaselineDto[]> {
  const creator = alias(users, 'baseline_creator');
  const clearer = alias(users, 'baseline_clearer');
  const rows = await db
    .select({
      id: deviceReliabilityBaselines.id,
      baselineAt: deviceReliabilityBaselines.baselineAt,
      reason: deviceReliabilityBaselines.reason,
      source: deviceReliabilityBaselines.source,
      note: deviceReliabilityBaselines.note,
      beforeSnapshot: deviceReliabilityBaselines.beforeSnapshot,
      createdAt: deviceReliabilityBaselines.createdAt,
      clearedAt: deviceReliabilityBaselines.clearedAt,
      createdById: deviceReliabilityBaselines.createdBy,
      createdByName: creator.name,
      clearedById: deviceReliabilityBaselines.clearedBy,
      clearedByName: clearer.name,
    })
    .from(deviceReliabilityBaselines)
    .leftJoin(creator, eq(creator.id, deviceReliabilityBaselines.createdBy))
    .leftJoin(clearer, eq(clearer.id, deviceReliabilityBaselines.clearedBy))
    .where(eq(deviceReliabilityBaselines.deviceId, deviceId))
    // Same order as ACTIVE_ORDER in reliabilityBaselineQueries, so the first
    // non-cleared row is the active marker by construction.
    .orderBy(
      desc(deviceReliabilityBaselines.baselineAt),
      desc(deviceReliabilityBaselines.createdAt),
      desc(deviceReliabilityBaselines.id),
    );
  const activeId = rows.find((r) => r.clearedAt === null)?.id ?? null;
  return rows.map((r) => {
    const snapshot = reliabilityBeforeSnapshotSchema.safeParse(r.beforeSnapshot);
    return {
      id: r.id,
      baselineAt: r.baselineAt.toISOString(),
      reason: r.reason,
      source: r.source,
      note: r.note,
      beforeSnapshot: snapshot.success ? snapshot.data : null,
      createdBy: r.createdById ? { id: r.createdById, name: r.createdByName ?? null } : null,
      createdAt: r.createdAt.toISOString(),
      clearedAt: r.clearedAt ? r.clearedAt.toISOString() : null,
      clearedBy: r.clearedById ? { id: r.clearedById, name: r.clearedByName ?? null } : null,
      active: r.id === activeId,
    };
  });
}
