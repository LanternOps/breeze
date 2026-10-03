/**
 * Fix-outcome state machine (AI Suggested Fixes W1, spec "Outcome lifecycle").
 *
 *   pending ─script failed/timeout─► failed      ─cancelled─► cancelled
 *      │     ─never delivered (delivery-clock expiry)─► inconclusive
 *      │ script ok
 *      ▼
 *   awaiting_recovery ─still active at deadline─► failed ("ran, didn't fix")
 *      │             ─human/cleanup/expiry/dismiss─► inconclusive
 *      │ objective condition clear (resolution_reason = condition_cleared,
 *      ▼       resolved_by IS NULL, after the script started — else dispatch)
 *   holding ─same signature recurs on the device─► recurred
 *      │    ─telemetry gap / device offline────► inconclusive
 *      ▼
 *   verified
 *
 * The deciders are PURE. advanceOutcome reads, decides, and hands the
 * transition to store.transitionOutcome, whose CAS makes every path
 * (sweeper, event, redelivery) safe to run concurrently.
 */
import { and, asc, eq, gt, isNotNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { FIX_OUTCOME_WINDOWS, isFixOutcomeTerminal, type FixOutcomeState } from '@breeze/shared';
import { db } from '../../db';
import {
  alerts, deviceCommands, deviceFilesystemCleanupRuns, devices, fixOutcomes, metricAnomalies, metricAnomalyEpisodes, scriptExecutions, type FixOutcomeRow,
} from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import {
  inSystemDbContext, probeTelemetryFreshness, readAlertRecovery, telemetryProbeFor,
  type AlertRecoveryReading, type TelemetryFreshness,
} from '../outcomeProbes';
import { alertSignature } from './signatureLoader';
import { fillOutcomeSignature, transitionOutcome, type OutcomeTransition } from './store';

const HOUR_MS = 3_600_000;
const EVENT_FANOUT_LIMIT = 50;
const RECURRENCE_PAGE = 50;
const RECURRENCE_MAX_PAGES = 20;

/**
 * `neverDelivered`: the execution failed because its command expired on the
 * reaper's DELIVERY clock (it never reached the device). Not evidence about the fix.
 */
export interface ScriptReading { status: string; exitCode: number | null; neverDelivered?: boolean }
export interface EpisodeReading { status: string; closeReason: string | null; resolvedByUserId: string | null; resolvedAt: Date | null }
export type RecoveryReading =
  | { kind: 'still_active' }
  | { kind: 'unknown' }
  | { kind: 'no_observable_condition' }
  | { kind: 'source_missing' }
  | { kind: 'device_moved' }
  | { kind: 'recovered'; at: Date }
  | { kind: 'cleared_other'; reason: string };

export function decidePending(i: { script: ScriptReading | null; deadlineAt: Date; now: Date }): OutcomeTransition | null {
  const deadlinePassed = i.now.getTime() >= i.deadlineAt.getTime();
  if (!i.script) return deadlinePassed ? { to: 'inconclusive', reason: 'script_execution_missing' } : null;
  switch (i.script.status) {
    case 'completed':
      return {
        to: 'awaiting_recovery', reason: 'script_succeeded',
        deadlineAt: new Date(i.now.getTime() + FIX_OUTCOME_WINDOWS.recoveryTimeoutHours * HOUR_MS),
      };
    case 'failed':
    case 'timeout':
      if (i.script.neverDelivered) return { to: 'inconclusive', reason: 'script_never_delivered' };
      return { to: 'failed', reason: i.script.status === 'failed' ? 'script_failed' : 'script_timeout' };
    case 'cancelled': return { to: 'cancelled', reason: 'script_cancelled' };
    default: return deadlinePassed ? { to: 'inconclusive', reason: 'script_never_finished' } : null;
  }
}

export function readingFromAlert(a: AlertRecoveryReading | null): RecoveryReading {
  if (!a) return { kind: 'source_missing' };
  if (a.status === 'dismissed') return { kind: 'cleared_other', reason: 'alert_dismissed' };
  // Suppressed = silenced by a person or rule, not observed to persist: no
  // evidence either way about the fix, so never 'still_active' (→ failed at 24h).
  if (a.status === 'suppressed') return { kind: 'cleared_other', reason: 'alert_suppressed' };
  if (a.status !== 'resolved') return { kind: 'still_active' };
  if (a.resolvedBy) return { kind: 'cleared_other', reason: 'human_resolved' };
  if (a.resolutionReason === 'condition_cleared' && a.resolvedAt) return { kind: 'recovered', at: a.resolvedAt };
  return { kind: 'cleared_other', reason: `resolved_${a.resolutionReason ?? 'unspecified'}` };
}

export function readingFromEpisode(e: EpisodeReading | 'unassembled' | 'missing'): RecoveryReading {
  if (e === 'unassembled') return { kind: 'unknown' };
  if (e === 'missing') return { kind: 'source_missing' };
  if (e.status === 'dismissed') return { kind: 'cleared_other', reason: 'episode_dismissed' };
  if (e.status === 'open') return { kind: 'still_active' };
  if (e.resolvedByUserId) return { kind: 'cleared_other', reason: 'human_resolved' };
  if (e.closeReason === 'cleared' && e.resolvedAt) return { kind: 'recovered', at: e.resolvedAt };
  return { kind: 'cleared_other', reason: `episode_${e.closeReason ?? 'closed'}` };
}

/**
 * `startedAt` is when the fix's script actually started on the device
 * (script_executions.started_at), when recorded. A recovery before that point
 * cannot be the fix's doing, even if it came after the attempt was dispatched
 * (`createdAt`). Without a start time, dispatch time is the best bound.
 */
export function decideAwaitingRecovery(i: {
  reading: RecoveryReading; createdAt: Date; startedAt?: Date | null; deadlineAt: Date; now: Date;
}): OutcomeTransition | null {
  const deadlinePassed = i.now.getTime() >= i.deadlineAt.getTime();
  const r = i.reading;
  switch (r.kind) {
    case 'device_moved': return { to: 'cancelled', reason: 'device_moved' };
    case 'no_observable_condition': return { to: 'inconclusive', reason: 'no_observable_condition' };
    case 'source_missing': return { to: 'inconclusive', reason: 'source_missing' };
    case 'cleared_other': return { to: 'inconclusive', reason: r.reason };
    case 'recovered':
      if (r.at.getTime() < (i.startedAt ?? i.createdAt).getTime()) return { to: 'inconclusive', reason: 'cleared_before_fix' };
      return {
        to: 'holding', reason: 'condition_cleared', recoveredAt: r.at,
        holdingUntil: new Date(r.at.getTime() + FIX_OUTCOME_WINDOWS.holdHours * HOUR_MS),
      };
    case 'unknown': return deadlinePassed ? { to: 'inconclusive', reason: 'recovery_unobservable' } : null;
    case 'still_active': return deadlinePassed ? { to: 'failed', reason: 'condition_persisted' } : null;
  }
}

export type Recurrence = 'recurred' | 'clear' | 'unscanned' | 'unsignable';

export function decideHolding(i: {
  recurrence: Recurrence; deviceMoved: boolean; holdingUntil: Date; now: Date; freshness: TelemetryFreshness | null;
}): OutcomeTransition | null {
  if (i.deviceMoved) return { to: 'cancelled', reason: 'device_moved' };
  if (i.recurrence === 'recurred') return { to: 'recurred', reason: 'same_signature_recurred' };
  if (i.now.getTime() < i.holdingUntil.getTime()) return null;
  // Too many candidate alerts to rule a recurrence out: never call that "held".
  if (i.recurrence === 'unscanned') return { to: 'inconclusive', reason: 'recurrence_scan_capped' };
  // No signature to compare against: a recurrence scan can never be run, so
  // never let a hold reach "verified" unsigned (fail closed, same principle
  // as 'unscanned').
  if (i.recurrence === 'unsignable') return { to: 'inconclusive', reason: 'recurrence_unsignable' };
  if (!i.freshness) return null;
  return i.freshness.fresh
    ? { to: 'verified', reason: 'held_with_fresh_telemetry' }
    : { to: 'inconclusive', reason: `telemetry_${i.freshness.reason}` };
}

// ---------------------------------------------------------------- orchestration

async function deviceLeftOrg(row: FixOutcomeRow): Promise<boolean> {
  const [device] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, row.deviceId)).limit(1);
  return !device || device.orgId !== row.orgId;
}

/**
 * A failed/timed-out execution that never started is checked against its
 * command row: only a DELIVERY-clock expiry (staleCommandReaper,
 * result.clock = 'delivery') means it never reached the device. A missing
 * started_at alone is not enough: agents on the HTTP polling path never get
 * one, and their reported failures are real.
 */
async function readScript(executionId: string | null, deviceId: string): Promise<ScriptReading | null> {
  if (!executionId) return null;
  const [s] = await db.select({ status: scriptExecutions.status, exitCode: scriptExecutions.exitCode, startedAt: scriptExecutions.startedAt })
    .from(scriptExecutions).where(eq(scriptExecutions.id, executionId)).limit(1);
  if (!s) return null;
  const reading: ScriptReading = { status: s.status, exitCode: s.exitCode ?? null };
  if ((s.status === 'failed' || s.status === 'timeout') && !s.startedAt) {
    const [expired] = await db.select({ id: deviceCommands.id }).from(deviceCommands).where(and(
      eq(deviceCommands.deviceId, deviceId),
      eq(deviceCommands.type, 'script'),
      sql`${deviceCommands.payload}->>'executionId' = ${executionId}`,
      sql`${deviceCommands.result}->>'clock' = 'delivery'`,
    )).limit(1);
    if (expired) reading.neverDelivered = true;
  }
  return reading;
}

/**
 * When the fix's script started on the device. script_executions.started_at is
 * `timestamp without time zone`; Drizzle reads it as UTC, the same convention
 * it was written with (scriptDispatch sets it from a JS Date), so it compares
 * directly with the timestamptz recovery times.
 */
/** device_commands.status → the pending decision's reading (W2 built-ins). */
export function readingFromCommand(status: string | null): ScriptReading | null {
  if (!status) return null;
  if (status === 'completed') return { status: 'completed', exitCode: 0 };
  if (status === 'failed' || status === 'timeout' || status === 'cancelled') return { status, exitCode: null };
  return { status: 'running', exitCode: null }; // pending / sent: not finished yet
}

/** OS-native cleanup run status (filesystem_cleanup_run_status enum). */
export function readingFromCleanupRun(status: string | null, _error: string | null): ScriptReading | null {
  if (!status) return null;
  if (status === 'executed') return { status: 'completed', exitCode: 0 };
  if (status === 'failed') return { status: 'failed', exitCode: null };
  return { status: 'running', exitCode: null };
}

/** A built-in attempt follows its queued command, or the cleanup run for disk_cleanup. */
async function readActionReading(row: FixOutcomeRow): Promise<ScriptReading | null> {
  if (row.actionCleanupRunId) {
    const [run] = await db.select({ status: deviceFilesystemCleanupRuns.status, error: deviceFilesystemCleanupRuns.error })
      .from(deviceFilesystemCleanupRuns).where(eq(deviceFilesystemCleanupRuns.id, row.actionCleanupRunId)).limit(1);
    return readingFromCleanupRun(run?.status ?? null, run?.error ?? null);
  }
  const [cmd] = await db.select({ status: deviceCommands.status }).from(deviceCommands)
    .where(and(eq(deviceCommands.id, row.actionCommandId!), eq(deviceCommands.deviceId, row.deviceId))).limit(1);
  return readingFromCommand(cmd?.status ?? null);
}

async function readScriptStartedAt(executionId: string | null): Promise<Date | null> {
  if (!executionId) return null;
  const [s] = await db.select({ startedAt: scriptExecutions.startedAt })
    .from(scriptExecutions).where(eq(scriptExecutions.id, executionId)).limit(1);
  return s?.startedAt ?? null;
}

async function readRecovery(row: FixOutcomeRow, alertOverride?: AlertRecoveryReading): Promise<RecoveryReading> {
  if (row.alertId) return readingFromAlert(alertOverride ?? await readAlertRecovery(row.alertId));
  if (row.sourceType === 'anomaly') {
    let episodeId = row.anomalyEpisodeId;
    if (!episodeId) {
      const [a] = await db.select({ episodeId: metricAnomalies.episodeId }).from(metricAnomalies)
        .where(eq(metricAnomalies.id, row.sourceId)).limit(1);
      if (!a) return readingFromEpisode('missing');
      if (!a.episodeId) return readingFromEpisode('unassembled');
      episodeId = a.episodeId;
      await db.update(fixOutcomes).set({ anomalyEpisodeId: episodeId }).where(eq(fixOutcomes.id, row.id));
    }
    const [e] = await db.select({
      status: metricAnomalyEpisodes.status, closeReason: metricAnomalyEpisodes.closeReason,
      resolvedByUserId: metricAnomalyEpisodes.resolvedByUserId, resolvedAt: metricAnomalyEpisodes.resolvedAt,
    }).from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, episodeId)).limit(1);
    return readingFromEpisode(e ?? 'missing');
  }
  if (row.sourceType === 'alert' || row.sourceType === 'correlation') return { kind: 'source_missing' };
  return { kind: 'no_observable_condition' };
}

function conditionOf(row: FixOutcomeRow): { family: string | null; condition: string | null } {
  const facets = (row.signatureFacets ?? null) as { family?: unknown; condition?: unknown } | null;
  return {
    family: typeof facets?.family === 'string' ? facets.family : null,
    condition: typeof facets?.condition === 'string' ? facets.condition : null,
  };
}

const SOURCED_CONTEXT_SOURCES: Readonly<Record<string, string>> = {
  network_monitor: 'network_monitor', script_exit_code: 'script_exit_code', patch_failed: 'patch-job-finalizer',
  reboot_pending: 'maintenance-reboot-sweep', warranty_expiry: 'warranty_evaluator', backup_provider: 'backup_provider',
  network_baseline: 'network_baseline', policy_violation: 'policy-evaluation',
};

/**
 * A SQL prefilter that can only EXCLUDE alerts whose signature cannot equal
 * this condition's (mirrors signature.ts: rule:* needs a rule, sourced:* needs
 * that context.source, anomaly:* comes from a metric_anomaly alert). null = no
 * safe narrowing; every alert in the window is a candidate.
 */
export function recurrencePrefilter(condition: string | null): SQL | null {
  if (!condition) return null;
  if (condition.startsWith('rule:')) return isNotNull(alerts.ruleId);
  if (condition.startsWith('sourced:')) {
    const source = SOURCED_CONTEXT_SOURCES[condition.split(':')[1] ?? ''];
    return source ? sql`${alerts.context}->>'source' = ${source}` : null;
  }
  if (condition.startsWith('anomaly:')) return sql`${alerts.context}->>'source' = 'metric_anomaly'`;
  return null;
}

/**
 * Did the same signature come back on this device inside the hold window?
 * Candidates are filtered in SQL (device, (recovered_at, min(now, holding_until)],
 * prefilter), ordered by (triggered_at, id) and paged by keyset, so a real
 * recurrence can never be hidden behind an arbitrary unordered LIMIT.
 * 'unscanned' = page cap hit without an answer (fails closed as inconclusive).
 */
async function scanRecurrence(row: FixOutcomeRow, now: Date): Promise<Recurrence> {
  // No signature means there is nothing to compare a candidate recurrence
  // against — that is a failure to rule recurrence out, not evidence there is
  // none, so it must fail closed the same way a capped scan does.
  if (!row.signatureKey) return 'unsignable';
  if (!row.recoveredAt || !row.holdingUntil) return 'clear';
  const { family, condition } = conditionOf(row);
  const windowEnd = new Date(Math.min(now.getTime(), row.holdingUntil.getTime()));
  if (family === 'anomaly' && condition?.startsWith('anomaly:')) {
    const conds: SQL[] = [
      eq(metricAnomalyEpisodes.deviceId, row.deviceId),
      eq(metricAnomalyEpisodes.episodeKey, condition.slice('anomaly:'.length)),
      gt(metricAnomalyEpisodes.firstSeenAt, row.recoveredAt),
      lte(metricAnomalyEpisodes.firstSeenAt, windowEnd),
    ];
    if (row.anomalyEpisodeId) conds.push(ne(metricAnomalyEpisodes.id, row.anomalyEpisodeId));
    const [again] = await db.select({ id: metricAnomalyEpisodes.id }).from(metricAnomalyEpisodes).where(and(...conds)).limit(1);
    if (again) return 'recurred';
  }
  const base: SQL[] = [
    eq(alerts.deviceId, row.deviceId),
    gt(alerts.triggeredAt, row.recoveredAt),
    lte(alerts.triggeredAt, windowEnd),
    eq(alerts.requiresHuman, false),
  ];
  if (row.alertId) base.push(ne(alerts.id, row.alertId));
  const prefilter = recurrencePrefilter(condition);
  if (prefilter) base.push(prefilter);
  const alertFamily = family === 'correlation' ? 'correlation' : 'alert';
  let cursor: { triggeredAt: Date; id: string } | null = null;
  for (let page = 0; page < RECURRENCE_MAX_PAGES; page += 1) {
    const conds = [...base];
    if (cursor) {
      conds.push(or(gt(alerts.triggeredAt, cursor.triggeredAt), and(eq(alerts.triggeredAt, cursor.triggeredAt), gt(alerts.id, cursor.id)))!);
    }
    const batch = await db.select({ id: alerts.id, triggeredAt: alerts.triggeredAt }).from(alerts)
      .where(and(...conds)).orderBy(asc(alerts.triggeredAt), asc(alerts.id)).limit(RECURRENCE_PAGE);
    for (const candidate of batch) {
      const resolved = await alertSignature(candidate.id, alertFamily);
      if (resolved && resolved.signature.key === row.signatureKey) return 'recurred';
    }
    if (batch.length < RECURRENCE_PAGE) return 'clear';
    cursor = batch[batch.length - 1]!;
  }
  return 'unscanned';
}

/**
 * The one cheap re-read before a hold is allowed to become "verified":
 * has the source re-opened, or did the event we based the hold on never
 * actually commit (eventBus publishers may publish before their commit)?
 * Only 'recovered' (the objective clear the hold was based on) confirms.
 * Anything else — including 'cleared_other' (now human-resolved, dismissed,
 * suppressed, expired) — fails closed rather than confirming.
 */
async function sourceStillResolved(row: FixOutcomeRow): Promise<boolean> {
  const reading = await readRecovery(row);
  return reading.kind === 'recovered';
}

async function decide(
  row: FixOutcomeRow, moved: boolean, now: Date,
  overrides: { script?: ScriptReading; alert?: AlertRecoveryReading },
): Promise<OutcomeTransition | null> {
  if (row.state === 'pending') {
    if (moved) return { to: 'cancelled', reason: 'device_moved' };
    const script = overrides.script
      ?? (row.actionCommandId || row.actionCleanupRunId
        ? await readActionReading(row)
        : await readScript(row.scriptExecutionId, row.deviceId));
    return decidePending({ script, deadlineAt: row.deadlineAt, now });
  }
  if (row.state === 'awaiting_recovery') {
    const reading: RecoveryReading = moved ? { kind: 'device_moved' } : await readRecovery(row, overrides.alert);
    // The start time only matters when there is a recovery to date.
    const startedAt = reading.kind === 'recovered' ? await readScriptStartedAt(row.scriptExecutionId) : null;
    return decideAwaitingRecovery({ reading, createdAt: row.createdAt, startedAt, deadlineAt: row.deadlineAt, now });
  }
  if (!row.holdingUntil || !row.recoveredAt) return { to: 'inconclusive', reason: 'hold_window_missing' };
  const recurrence: Recurrence = moved ? 'clear' : await scanRecurrence(row, now);
  const due = now.getTime() >= row.holdingUntil.getTime();
  const freshness = !moved && recurrence === 'clear' && due
    ? await probeTelemetryFreshness({
      deviceId: row.deviceId, from: row.recoveredAt, to: row.holdingUntil,
      probe: telemetryProbeFor(conditionOf(row).condition),
    })
    : null;
  const transition = decideHolding({ recurrence, deviceMoved: moved, holdingUntil: row.holdingUntil, now, freshness });
  if (transition?.to === 'verified' && !moved && !(await sourceStillResolved(row))) {
    return { to: 'inconclusive', reason: 'source_not_resolved' };
  }
  return transition;
}

export async function advanceOutcome(
  outcomeId: string,
  opts: { now?: Date; overrides?: { script?: ScriptReading; alert?: AlertRecoveryReading } } = {},
): Promise<FixOutcomeState | null> {
  const now = opts.now ?? new Date();
  return inSystemDbContext(async () => {
    const [loaded] = await db.select().from(fixOutcomes).where(eq(fixOutcomes.id, outcomeId)).limit(1);
    if (!loaded) return null;
    if (isFixOutcomeTerminal(loaded.state)) return loaded.state;
    // fillOutcomeSignature returns the PERSISTED row (reloaded if another writer
    // signed it first), so `decide` never sees an unsigned snapshot. The same
    // reload can reveal that a concurrent writer already finished the attempt.
    const row = await fillOutcomeSignature(loaded, now);
    if (isFixOutcomeTerminal(row.state)) return row.state;
    const transition = await decide(row, await deviceLeftOrg(row), now, opts.overrides ?? {});
    if (!transition) return row.state;
    // transitionOutcome aggregates from the row its CAS returns, not from `row`.
    const won = await transitionOutcome(row, transition, now);
    return won ? transition.to : row.state;
  }, 'fixOutcomeWatcher.advance');
}

async function outcomeIdsWhere(condition: SQL): Promise<string[]> {
  return inSystemDbContext(async () => {
    const found = await db.select({ id: fixOutcomes.id }).from(fixOutcomes).where(condition).limit(EVENT_FANOUT_LIMIT);
    return found.map((r) => r.id);
  }, 'fixOutcomeWatcher.lookup');
}

/**
 * Durable subscriber 'fix-outcome-watcher' on alert.resolved (fast path). The
 * 5-minute sweeper is authoritative; this only shortens latency. alert.triggered
 * is deliberately not handled: a recurrence only decides a hold at its end,
 * where the sweeper scans for it anyway. Gates on the PUBLISHED
 * payload (eventBus contract: publishers may publish before their commit), and
 * every write goes through the CAS, so redelivery is harmless. Throws on DB
 * failure so queue mode retries.
 */
export async function handleFixOutcomeEvent(event: BreezeEvent): Promise<void> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const now = new Date();

  // Script terminal verdicts arrive through the inline hook (scriptTerminalHook.ts,
  // decision D-a), never as events.
  if (event.type === 'alert.resolved') {
    const alertId = typeof p.alertId === 'string' ? p.alertId : null;
    if (!alertId) return;
    const resolvedAt = typeof p.resolvedAt === 'string' ? new Date(p.resolvedAt) : null;
    // Without the C2 payload fields, fall back to reading the row (sweeper-safe).
    const alert: AlertRecoveryReading | undefined = resolvedAt && !Number.isNaN(resolvedAt.getTime())
      ? {
        status: 'resolved', resolvedAt,
        resolvedBy: typeof p.resolvedBy === 'string' ? p.resolvedBy : null,
        resolutionReason: typeof p.resolutionReason === 'string' ? p.resolutionReason : null,
      }
      : undefined;
    for (const id of await outcomeIdsWhere(and(eq(fixOutcomes.alertId, alertId), eq(fixOutcomes.state, 'awaiting_recovery'))!)) {
      await advanceOutcome(id, { now, overrides: { alert } });
    }
  }
}
