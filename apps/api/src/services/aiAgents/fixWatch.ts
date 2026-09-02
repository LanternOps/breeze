// apps/api/src/services/aiAgents/fixWatch.ts
/**
 * Wave 6 PR 2 (#3828), Task 3 — the fix-held watch's DB-side logic.
 *
 * After an act-lane remediation VERIFIES (`actVerify.ts`'s `verification:
 * 'passed'`), this module watches whether the alert that triggered the run
 * recovers, and — if it does — whether it recurs within `FIX_HOLD_MINUTES`.
 * The watch NEVER mutates the run's own outcome or status; it is a purely
 * observational, additive record (self-review note in the plan doc).
 *
 * Deliberately BullMQ-free, same reasoning as `runFinishedNotify.ts`: it is
 * imported by `runLoop.ts` (via `jobs/fixWatchWorker.ts`'s `scheduleFixWatch`,
 * see that file's header for why the enqueue side lives there instead), and
 * `runLoop.ts`'s own header keeps BullMQ out of its module graph so its
 * guardrail-hook tests don't have to stub Redis. `jobs/fixWatchWorker.ts` owns
 * the Queue/Worker plumbing and calls the phase functions below; this module
 * has no import of that file (or of `runLoop.ts`), so there is no cycle.
 *
 * Absence of recurrence is `held_qualified`, never an unconditional "held" —
 * alert dedupe/cooldown can suppress a would-be recurrence row, so silence is
 * evidence of nothing (wave-6 quorum, 2026-08-28). A `dismissed` alert can
 * never establish recovery (a human dismissing an alert is not the same as
 * the underlying condition clearing) — it cancels the watch instead.
 */
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { AgentRunVerdict, AiAgentMode } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, not the schema barrel — same reasoning as
// agentCircuit.ts/runService.ts: this sits on the run-finish path, and the
// barrel would drag every partial-mock unit test of that path into stubbing
// the whole schema surface.
import {
  aiAgentFixWatches,
  type AiAgentFixWatch,
  type NewAiAgentFixWatch,
} from '../../db/schema/aiAgentFixWatches';
import { alerts } from '../../db/schema/alerts';
import { aiAgents, aiAgentRuns } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { createNotification } from '../userNotifications';
import { resolveRecipientUserIds } from './recipients';
import { insertOpEvidence, watchEvidenceSourceId } from './opEvidence';

/** Same skip-if-already-system shape duplicated across this module family. */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * v1 watch windows are CONSTANTS (plan header) — configurability needs the
 * quorum's own merge-semantics design (OR/max across org+partner-wide
 * policies, not tighten-only min) and is deliberately deferred.
 */
export const FIX_HOLD_MINUTES = 60;
export const RECOVERY_TIMEOUT_HOURS = 24;

/**
 * The minimal shape `isFixWatchEligible`/`createFixWatchRow` need from a
 * finished run. Deliberately NOT imported from `runLoop.ts` (its `RunRow`) —
 * that would pull this module into `runLoop.ts`'s import graph the wrong
 * direction. `AiAgentMode` itself is a leaf type from `@breeze/shared`, so
 * importing it here creates no cycle.
 */
export interface FinishedRunForWatch {
  id: string;
  orgId: string;
  agentId: string;
  alertId: string | null;
  modeAtStart: Exclude<AiAgentMode, 'off'>;
}

/**
 * The minimal shape of `AgentRunOutcome` this module needs — structurally
 * compatible with `runLoop.ts`'s real `OutcomeExecutedAction[]` without
 * importing that type (same "no cycle" reasoning as `FinishedRunForWatch`).
 * `AgentRunVerdict` itself is a leaf type from `@breeze/shared` (same as
 * `AiAgentMode` above), so importing it creates no cycle either.
 */
export interface FixWatchOutcomeInput {
  executedActions: ReadonlyArray<{
    verification?: 'passed' | 'failed' | 'inconclusive' | 'skipped';
    execution?: 'succeeded' | 'failed' | 'timeout' | 'unknown';
    /**
     * The manifest op key of this execution (`manage_services.restart` — a
     * DOT key, unlike an intent's colon key). Snapshotted onto the watch row
     * (P2-5, #4192) so the phase-2 verdict knows which operations its
     * `recurred` / `held_qualified` outcome grades, without re-reading a run
     * outcome that may have been pruned by then. Structurally compatible with
     * `runLoop.ts`'s `OutcomeExecutedAction.actOpKey`; absent on every
     * pre-Part-B (non-act) execution.
     */
    actOpKey?: string;
  }>;
  /**
   * The run's own rollup verdict (`computeRunVerdict`, runLoop.ts). LOCKED:
   * "act-lane clean runs only" — a mixed run whose overall verdict is
   * `needs_attention` is not clean even when one individual action happened
   * to read back `verification: 'passed'` (that's exactly the "one clean,
   * one dirty" case `computeRunVerdict` itself rejects). Optional only for
   * structural-compatibility symmetry with the other fields here; the real
   * caller (`runLoop.ts`'s `finishRun`) always has it set by the time it
   * calls `scheduleFixWatch` (`outcome.runVerdict = computeRunVerdict(outcome)`
   * runs before every terminal branch).
   */
  runVerdict?: AgentRunVerdict;
}

/**
 * Eligibility (plan, Task 3): the triggering alert is known, the run went
 * through the act lane (`modeAtStart === 'act'` — a policy-decided run never
 * sets this, so it is excluded until it gains its own post-execution
 * verification, per the plan's deferral note), the run's own rollup verdict
 * is not `needs_attention`, and at least one act execution both DISPATCHED
 * cleanly (`execution: 'succeeded'`) and VERIFIED clean
 * (`verification: 'passed'`) — mirroring `computeRunVerdict`'s own rule that
 * a dispatch which itself failed/timed out/is unknown is not "clean" even
 * when its read-back reports 'passed'. Anything short of that is not what a
 * fix-held watch is for — that is `actVerify.ts`'s own rule-less attention
 * alert's job, immediately, not 60 minutes from now.
 */
export function isFixWatchEligible(run: FinishedRunForWatch, outcome: FixWatchOutcomeInput): boolean {
  if (!run.alertId) return false;
  if (run.modeAtStart !== 'act') return false;
  if (outcome.runVerdict === 'needs_attention') return false;
  return outcome.executedActions.some(
    (action) => action.verification === 'passed' && action.execution === 'succeeded',
  );
}

/**
 * Inserts the watch row for an eligible run, denormalizing `rule_id` /
 * `device_id` / `config_item_name` from the TRIGGERING ALERT ROW (not the
 * run's own `device_id`, which can be null for a non-device-scoped trigger) —
 * per the plan's Task 3 spec. Returns the new watch id, or `null` when the
 * run is ineligible, the triggering alert can no longer be read (deleted, or
 * moved to another org), the run's org has no resolvable partner, or a watch
 * for this run already exists (`ai_agent_fix_watches_run_id_uq` —
 * `onConflictDoNothing` makes a duplicate call idempotent rather than a
 * thrown 23505).
 */
export async function createFixWatchRow(
  run: FinishedRunForWatch,
  outcome: FixWatchOutcomeInput,
): Promise<string | null> {
  if (!isFixWatchEligible(run, outcome)) return null;
  const alertId = run.alertId as string;

  return inSystemDbContext(async () => {
    const anchor = await loadWatchAnchor({ orgId: run.orgId, alertId, logContext: { runId: run.id } });
    if (!anchor) return null;

    const [watch] = await insertFixWatchRowQuery({
      orgId: run.orgId,
      partnerId: anchor.partnerId,
      agentId: run.agentId,
      runId: run.id,
      alertId,
      ruleId: anchor.ruleId,
      deviceId: anchor.deviceId,
      configItemName: anchor.configItemName,
      state: 'pending',
      sourceKind: 'act_run',
      opKeys: snapshotActOpKeys(outcome),
    });

    return watch?.id ?? null;
  });
}

/**
 * The op keys this run's executions are about to be graded on, de-duplicated
 * and in first-seen order (P2-5, #4192). Every executed action contributes,
 * not just the verified ones: the watch's verdict is about the ALERT the run
 * as a whole was trying to fix, and Task 6 writes one evidence row per key.
 * Duplicates would collide on `watchEvidenceSourceId(watchId, key)` and be
 * absorbed by ON CONFLICT DO NOTHING anyway — dropping them here keeps the
 * stored array honest about what it means. A pre-Part-B run (no act keys at
 * all) snapshots `[]`, which Task 6 reads as "nothing to grade".
 */
function snapshotActOpKeys(outcome: FixWatchOutcomeInput): string[] {
  const keys = new Set<string>();
  for (const action of outcome.executedActions) {
    if (action.actOpKey) keys.add(action.actOpKey);
  }
  return [...keys];
}

/**
 * The statement executor. Defaults to the ambient `db`, but a caller inside a
 * SAVEPOINT (`intentReleaseWorker.ts`'s terminalization) MUST thread the
 * savepoint's own executor: postgres-js records the first failed query of a
 * scope in that scope's `uncaughtError` and rethrows it when the scope ends
 * EVEN IF the caller caught the rejection, so a statement issued through the
 * ambient proxy would abort the OUTER transaction — here, a terminal CAS for
 * an action that already ran. Same contract, same reason, as
 * `insertOpEvidence`'s second parameter.
 */
export type WatchDatabase = Pick<typeof db, 'select' | 'insert'>;

/**
 * The triggering alert's denormalized identity plus the org's partner — the
 * two reads both watch constructors need, in the caller's ambient
 * transaction. Returns null (already logged) when either is unusable, which
 * is a skipped watch, never a thrown error: a watch is observational, and
 * losing one must not fail the run or the release that asked for it.
 */
async function loadWatchAnchor(
  input: { orgId: string; alertId: string; logContext: Record<string, unknown> },
  database: WatchDatabase = db,
): Promise<{ ruleId: string | null; deviceId: string; configItemName: string | null; partnerId: string } | null> {
  const [alertRow] = await database
    .select({ ruleId: alerts.ruleId, deviceId: alerts.deviceId, configItemName: alerts.configItemName })
    .from(alerts)
    .where(and(eq(alerts.id, input.alertId), eq(alerts.orgId, input.orgId)))
    .limit(1);
  if (!alertRow) {
    console.warn('[fixWatch] triggering alert is not (or no longer) in the run org — skipping watch', {
      ...input.logContext, orgId: input.orgId, alertId: input.alertId,
    });
    return null;
  }

  const [org] = await database
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);
  if (!org?.partnerId) {
    console.warn('[fixWatch] run org has no resolvable partner — skipping watch', {
      ...input.logContext, orgId: input.orgId,
    });
    return null;
  }

  return { ...alertRow, partnerId: org.partnerId };
}

/**
 * The act-run watch insert, unexecuted — exported so its ON CONFLICT clause
 * (the thing that absorbs a duplicate `finishRun`) can be asserted as
 * compiled SQL rather than against a mocked builder. `run_id`'s UNIQUE became
 * PARTIAL in `2026-10-01-100000-ai-agents-graduation-evidence.sql` (`WHERE
 * source_kind = 'act_run'`, since one run may now also spawn N intent
 * watches), and Postgres cannot infer a partial unique index as the arbiter
 * unless the statement repeats its predicate — without it this is a runtime
 * 42P10 on exactly the redelivery the clause exists for.
 */
export function insertFixWatchRowQuery(values: NewAiAgentFixWatch, database: WatchDatabase = db) {
  return database
    .insert(aiAgentFixWatches)
    .values(values)
    .onConflictDoNothing({
      target: aiAgentFixWatches.runId,
      where: sql`${aiAgentFixWatches.sourceKind} = 'act_run'`,
    })
    .returning({ id: aiAgentFixWatches.id });
}

/** The intent-anchored sibling. Arbitrates on the partial `intent_id` UNIQUE,
 *  never on `run_id` — N independently-released intents legitimately share
 *  one run (#4206). Same predicate-repetition requirement as above. */
export function insertIntentFixWatchRowQuery(values: NewAiAgentFixWatch, database: WatchDatabase = db) {
  return database
    .insert(aiAgentFixWatches)
    .values(values)
    .onConflictDoNothing({
      target: aiAgentFixWatches.intentId,
      where: sql`${aiAgentFixWatches.intentId} is not null`,
    })
    .returning({ id: aiAgentFixWatches.id });
}

/** Everything an intent-anchored watch needs from a just-released intent. */
export interface IntentForWatch {
  intentId: string;
  orgId: string;
  runId: string;
  agentId: string;
  alertId: string;
  /** The colon key `canonicalPolicyKey` resolved for this intent. */
  opKey: string;
}

/**
 * Sibling of `createFixWatchRow` for a released ACTION INTENT rather than an
 * act-mode run (P2-5, #4192 — closes #4206). `createFixWatchRow` rejects
 * anything but an act-mode, execution-succeeded, verification-passed RUN
 * (`isFixWatchEligible`) and cannot be reused: a released intent has no
 * manifest execution and no `actVerify` read-back, and N intents from one run
 * each need their OWN verification episode instead of sharing one run-unique
 * watch.
 *
 * Reuses the same denormalisation (`rule_id` / `device_id` /
 * `config_item_name` off the TRIGGERING ALERT ROW, read predicated by BOTH id
 * and org) and the same partner resolution, and JOINS the caller's ambient
 * system transaction so the watch row commits with the terminal CAS that
 * released the intent.
 *
 * Returns null ONLY when no watch row exists for this intent afterwards — the
 * alert is unreadable in this org, or the org has no resolvable partner. A
 * conflict on the partial `intent_id` UNIQUE returns the EXISTING row's id,
 * because the caller reads null as "nothing will ever verify this operation"
 * and credits it `verified` on the spot; saying null while a live watch is
 * about to render a verdict would write a premature, immutable ledger row.
 */
export async function createIntentFixWatchRow(
  input: IntentForWatch,
  database: WatchDatabase = db,
): Promise<string | null> {
  return inSystemDbContext(async () => {
    const anchor = await loadWatchAnchor(
      { orgId: input.orgId, alertId: input.alertId, logContext: { intentId: input.intentId, runId: input.runId } },
      database,
    );
    if (!anchor) return null;

    const [watch] = await insertIntentFixWatchRowQuery({
      orgId: input.orgId,
      partnerId: anchor.partnerId,
      agentId: input.agentId,
      runId: input.runId,
      intentId: input.intentId,
      alertId: input.alertId,
      ruleId: anchor.ruleId,
      deviceId: anchor.deviceId,
      configItemName: anchor.configItemName,
      state: 'pending',
      sourceKind: 'intent',
      opKeys: [input.opKey],
    }, database);
    if (watch) return watch.id;

    // ON CONFLICT DO NOTHING returned no row: a watch for this intent already
    // exists (only a redelivery that also re-won a terminal CAS can get here,
    // which the release guard makes unreachable in practice). Report ITS id
    // so the null contract above stays literally true.
    const [existing] = await database
      .select({ id: aiAgentFixWatches.id })
      .from(aiAgentFixWatches)
      .where(and(eq(aiAgentFixWatches.intentId, input.intentId), eq(aiAgentFixWatches.orgId, input.orgId)))
      .limit(1);
    return existing?.id ?? null;
  });
}

/** DB page size for one recovery-sweep read. The page is a list of
 *  CANDIDATES, not of proven strandings — nothing in this table records
 *  whether a watch's phase-1 job was ever added, so the sweep's Redis probe
 *  (`fixWatchWorker.ts`) is what actually discriminates. The reader therefore
 *  pages instead of taking one capped slice: a fleet with more concurrently
 *  `pending` watches than the cap would otherwise hand the sweep the same
 *  oldest-N healthy rows every tick and never reach a newer stranded one
 *  until those aged out (review finding, P2-5). */
export const STRANDED_WATCH_SWEEP_PAGE = 200;

/** Keyset position in the pending set, ordered `(created_at, id)`. */
export interface PendingWatchCursor {
  id: string;
  createdAt: Date;
}

/**
 * One page of `pending` watches created more than `olderThanMs` ago, oldest
 * first — the reader behind `fixWatchWorker.ts`'s recovery sweep (P2-5,
 * #4192). Pass the previous page's last row as `after` to continue.
 *
 * A watch row is committed inside a DB transaction and its BullMQ job is
 * added AFTER that transaction closes (`bullmqQueue.ts`'s #1105 tripwire
 * forbids enqueueing inside a held context), so a crash — or a Redis blip —
 * between the two strands the row: `pending` forever, with no job to move it.
 * A phase-1 job that exhausts its `attempts` strands it the same way.
 *
 * Neither mode is visible here: a healthy watch stays `pending` for up to
 * `RECOVERY_TIMEOUT_HOURS` while phase 1 self-re-delays every 5 minutes, so
 * every row this returns may be perfectly healthy. The caller probes Redis
 * per id and acts only on the ones with no live job. Keyset paging (rather
 * than OFFSET) keeps each page an index range scan on
 * `ai_agent_fix_watches_pending_recovery_idx`.
 */
export async function listPendingWatchesForRecovery(
  olderThanMs: number,
  after: PendingWatchCursor | null = null,
  limit = STRANDED_WATCH_SWEEP_PAGE,
): Promise<PendingWatchCursor[]> {
  return inSystemDbContext(async () => {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await db
      .select({ id: aiAgentFixWatches.id, createdAt: aiAgentFixWatches.createdAt })
      .from(aiAgentFixWatches)
      .where(
        and(
          eq(aiAgentFixWatches.state, 'pending'),
          lt(aiAgentFixWatches.createdAt, cutoff),
          // Row-value comparison, so the tuple order matches the ORDER BY
          // exactly and no row is visited twice or skipped when several
          // watches share a `created_at`. Casts are explicit because the
          // driver sends parameters untyped.
          after
            ? sql`(${aiAgentFixWatches.createdAt}, ${aiAgentFixWatches.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(aiAgentFixWatches.createdAt), asc(aiAgentFixWatches.id))
      .limit(limit);
    return rows;
  });
}

export type FixWatchPhase1Outcome =
  | { action: 'recovered' }
  | { action: 'cancelled' }
  | { action: 'still_pending' }
  | { action: 'timed_out' }
  | { action: 'not_found' };

/**
 * Phase 1: has the triggering alert recovered? `resolved` → recovery
 * observed, watch moves to `watching` with `due_at` set `FIX_HOLD_MINUTES`
 * out. `dismissed` → a human dismissing the alert must NEVER establish
 * recovery (wave-6 quorum) — the watch cancels instead. Anything else
 * (`active`/`acknowledged`/`suppressed`, or the alert row itself having gone
 * missing) keeps waiting, up to `RECOVERY_TIMEOUT_HOURS` from `created_at`,
 * after which it gives up as `inconclusive` — absence of resolution is not
 * proof of anything either way.
 *
 * `not_found` covers both a genuinely missing watch id AND a watch that is
 * no longer `pending` (already progressed past phase 1, or cancelled by a
 * duplicate job delivery) — either way, this call has nothing to do and the
 * caller (the worker) must not re-enqueue.
 *
 * Exception: a watch already `watching` with `recoveryObservedAt` set
 * reports `recovered` again rather than `not_found`. That state is only
 * reachable by THIS function already having committed the 'resolved' branch
 * below — a retried delivery of the SAME phase-1 job (BullMQ `attempts`,
 * fired because the phase-2 enqueue that follows a `recovered` result threw)
 * must re-run that follow-on enqueue, not report `not_found` and strand the
 * watch in `watching` forever with no sweeper over it.
 */
export async function checkFixWatchPhase1(watchId: string): Promise<FixWatchPhase1Outcome> {
  return inSystemDbContext(async () => {
    const [watch] = await db.select().from(aiAgentFixWatches).where(eq(aiAgentFixWatches.id, watchId)).limit(1);
    if (!watch) return { action: 'not_found' };
    if (watch.state === 'watching' && watch.recoveryObservedAt) return { action: 'recovered' };
    if (watch.state !== 'pending') return { action: 'not_found' };

    let alertStatus: string | null = null;
    if (watch.alertId) {
      const [alertRow] = await db
        .select({ status: alerts.status })
        .from(alerts)
        .where(eq(alerts.id, watch.alertId))
        .limit(1);
      alertStatus = alertRow?.status ?? null;
    }

    if (alertStatus === 'resolved') {
      const recoveryObservedAt = new Date();
      const dueAt = new Date(recoveryObservedAt.getTime() + FIX_HOLD_MINUTES * 60_000);
      const [moved] = await db
        .update(aiAgentFixWatches)
        .set({ state: 'watching', recoveryObservedAt, dueAt })
        .where(and(eq(aiAgentFixWatches.id, watchId), eq(aiAgentFixWatches.state, 'pending')))
        .returning({ id: aiAgentFixWatches.id });
      // Lost the CAS race (a concurrent delivery already moved this row out
      // of 'pending') — that other call owns the outcome now; this one has
      // nothing more to do.
      if (!moved) return { action: 'not_found' };
      return { action: 'recovered' };
    }

    if (alertStatus === 'dismissed') {
      const [moved] = await db
        .update(aiAgentFixWatches)
        .set({ state: 'cancelled', evaluatedAt: new Date() })
        .where(and(eq(aiAgentFixWatches.id, watchId), eq(aiAgentFixWatches.state, 'pending')))
        .returning({ id: aiAgentFixWatches.id });
      if (!moved) return { action: 'not_found' };
      return { action: 'cancelled' };
    }

    // active / acknowledged / suppressed / the alert row is gone entirely —
    // still open, unless the 24h ceiling has passed.
    const ageMs = Date.now() - watch.createdAt.getTime();
    if (ageMs >= RECOVERY_TIMEOUT_HOURS * 60 * 60 * 1000) {
      const [moved] = await db
        .update(aiAgentFixWatches)
        .set({ state: 'inconclusive', evaluatedAt: new Date() })
        .where(and(eq(aiAgentFixWatches.id, watchId), eq(aiAgentFixWatches.state, 'pending')))
        .returning({ id: aiAgentFixWatches.id });
      if (!moved) return { action: 'not_found' };
      return { action: 'timed_out' };
    }

    return { action: 'still_pending' };
  });
}

export type FixWatchPhase2Outcome =
  | { action: 'recurred' }
  | { action: 'held_qualified' }
  | { action: 'not_found' };

interface RecurrenceDetected {
  watch: AiAgentFixWatch;
  recurrenceAlertId: string;
}

/**
 * Watch-verdict op evidence (Task 6, P2-5, #4192) — one row per entry of
 * `watch.opKeys`, written INSIDE the caller's winning CAS transaction,
 * before it returns. A pre-P2-5 watch (or one whose `snapshotActOpKeys`
 * snapshotted nothing) carries `op_keys: []` and writes nothing — there is
 * no key to grade.
 *
 * `namespace` follows `source_kind`: an intent-anchored watch grades a
 * released intent's canonical `tool:action` key (`policy_key`); an
 * act-run-anchored watch grades a manifest op key (`act_op`) — same mapping
 * `createIntentFixWatchRow`/`createFixWatchRow` use to pick `source_kind` in
 * the first place.
 *
 * No try/catch here on purpose: an insert failure propagates and rolls back
 * the SAME transaction as the CAS that just won, undoing both together. That
 * is safe (unlike `intentReleaseWorker.ts`'s SAVEPOINT-isolated evidence
 * write) because nothing externally visible has happened yet at this point —
 * `sendRecurrenceNotifications` runs strictly AFTER this function returns,
 * in ITS OWN `inSystemDbContext` call — so a rollback here just means the
 * next redelivery of this phase-2 job re-evaluates from `watching` again.
 */
async function recordWatchVerdictEvidence(watch: AiAgentFixWatch, metric: 'recurred' | 'verified'): Promise<void> {
  if (watch.opKeys.length === 0) return;
  const occurredAt = new Date();
  await insertOpEvidence(
    watch.opKeys.map((opKey) => ({
      orgId: watch.orgId,
      agentId: watch.agentId,
      namespace: watch.sourceKind === 'intent' ? ('policy_key' as const) : ('act_op' as const),
      opKey,
      ruleId: watch.ruleId,
      sourceKind: 'watch' as const,
      sourceId: watchEvidenceSourceId(watch.id, opKey),
      metric,
      runId: watch.runId,
      occurredAt,
    })),
  );
}

/**
 * Sends the recurrence notification + rule-less attention alert. Deliberately
 * a SEPARATE `inSystemDbContext` call from `checkFixWatchPhase2`'s own
 * detection/write transaction (same pattern as `agentCircuit.ts`'s
 * `recordRunTerminal`: notify/alert fan-out runs OUTSIDE the row-locked
 * update so a slow recipient-resolution or notification write can never hold
 * a pooled connection across it, and so a failure here can never roll back
 * the watch's already-committed `recurred` state).
 */
async function sendRecurrenceNotifications(watch: AiAgentFixWatch, recurrenceAlertId: string): Promise<void> {
  await inSystemDbContext(async () => {
    const [agentRow] = await db
      .select({ name: aiAgents.name, orgId: aiAgents.orgId, partnerId: aiAgents.partnerId })
      .from(aiAgents)
      .where(eq(aiAgents.id, watch.agentId))
      .limit(1);
    const [runRow] = await db
      .select({ policySnapshot: aiAgentRuns.policySnapshot })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, watch.runId))
      .limit(1);
    if (!agentRow || !runRow) {
      console.warn('[fixWatch] agent or run no longer exists — skipping recurrence notify', {
        watchId: watch.id, agentId: watch.agentId, runId: watch.runId,
      });
      return;
    }

    // The run's immutable snapshot, not the agent row's live `recipients`
    // column — same reasoning as `runFinishedNotify.ts`.
    const userIds = await resolveRecipientUserIds(
      { orgId: agentRow.orgId, partnerId: agentRow.partnerId, recipients: runRow.policySnapshot.effective.recipients },
      watch.orgId,
    );

    for (const userId of userIds) {
      await createNotification({
        userId,
        orgId: watch.orgId,
        type: 'ai',
        title: `Fix did not hold: ${agentRow.name}`,
        message:
          `${agentRow.name}'s remediation appeared to fix the triggering alert, but it recurred within `
          + `${FIX_HOLD_MINUTES} minutes of recovery.`,
        link: `/ai-agents/runs/${watch.runId}`,
        priority: 'high',
        metadata: {
          watchId: watch.id, runId: watch.runId, agentId: watch.agentId, recurrenceAlertId,
        },
        // Discriminated by the WATCH, not just the agent — one dedupe key
        // per watch episode (a watch is terminal-once, so this never
        // re-fires for the same watch id).
        dedupeKey: `fix-watch-${watch.id}-recurred`,
      });
    }

    // Rule-less attention alert — mirrors `actVerify.ts`'s
    // `recordActVerifyFailureAlert` direct-insert pattern (`ruleId: null`,
    // `status: 'active'`), with the `configItemName`/`context.source` the
    // plan specifies for this alert family.
    await db.insert(alerts).values({
      ruleId: null,
      deviceId: watch.deviceId,
      orgId: watch.orgId,
      configPolicyId: null,
      configItemName: 'ai_agent_fix_watch',
      severity: 'high',
      title: `Agent fix did not hold: ${agentRow.name}`,
      message:
        'An unattended agent action appeared to remediate the triggering alert, but it recurred within '
        + `${FIX_HOLD_MINUTES} minutes.`,
      context: {
        source: 'ai_agent_fix_watch',
        watchId: watch.id,
        runId: watch.runId,
        agentId: watch.agentId,
        recurrenceAlertId,
      },
      status: 'active',
      triggeredAt: new Date(),
    });
  });
}

/**
 * Phase 2: fires `FIX_HOLD_MINUTES` after observed recovery. Recurrence query
 * is anchored on the SAME rule+device as the triggering alert, restricted to
 * `triggeredAt > recovery_observed_at` — a re-alert from BEFORE recovery was
 * observed is not a recurrence, it's the same episode. A watch whose
 * triggering alert was rule-LESS (`rule_id IS NULL` — e.g. one of
 * `actVerify.ts`'s own rule-less alerts) matches on `device_id` +
 * `config_item_name` instead, since there is no rule to key on (plan, Task
 * 3). Any matching row → `recurred`; none → `held_qualified` — quiet, never
 * an unconditional "held" (module header).
 *
 * `not_found` covers a missing watch id AND a watch that is no longer
 * `watching` (already terminal, or a duplicate job delivery) — the caller
 * must not act further either way.
 */
export async function checkFixWatchPhase2(watchId: string): Promise<FixWatchPhase2Outcome> {
  const detected = await inSystemDbContext(async (): Promise<RecurrenceDetected | 'held_qualified' | null> => {
    const [watch] = await db.select().from(aiAgentFixWatches).where(eq(aiAgentFixWatches.id, watchId)).limit(1);
    if (!watch || watch.state !== 'watching' || !watch.recoveryObservedAt) return null;

    const recurrenceWhere = watch.ruleId
      ? and(
          eq(alerts.orgId, watch.orgId),
          eq(alerts.deviceId, watch.deviceId),
          eq(alerts.ruleId, watch.ruleId),
          gt(alerts.triggeredAt, watch.recoveryObservedAt),
        )
      : and(
          eq(alerts.orgId, watch.orgId),
          eq(alerts.deviceId, watch.deviceId),
          isNull(alerts.ruleId),
          watch.configItemName ? eq(alerts.configItemName, watch.configItemName) : isNull(alerts.configItemName),
          gt(alerts.triggeredAt, watch.recoveryObservedAt),
        );

    const [recurrence] = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(recurrenceWhere)
      .orderBy(desc(alerts.triggeredAt))
      .limit(1);

    if (recurrence) {
      const [moved] = await db
        .update(aiAgentFixWatches)
        .set({
          state: 'recurred', recurrenceAlertId: recurrence.id, evaluatedAt: new Date(), notifiedAt: new Date(),
        })
        .where(and(eq(aiAgentFixWatches.id, watchId), eq(aiAgentFixWatches.state, 'watching')))
        .returning({ id: aiAgentFixWatches.id });
      // Lost the CAS race — a stalled/duplicate delivery of the SAME phase-2
      // job saw `state: 'watching'` on its own read too, but the other
      // invocation's write already won. Notifying/alerting here as well
      // would double-fire the operator-facing attention alert (it has no
      // dedupe key), so stand down entirely rather than returning 'recurred'
      // a second time.
      if (!moved) return null;
      await recordWatchVerdictEvidence(watch, 'recurred');
      return { watch, recurrenceAlertId: recurrence.id };
    }

    const [moved] = await db
      .update(aiAgentFixWatches)
      .set({ state: 'held_qualified', evaluatedAt: new Date() })
      .where(and(eq(aiAgentFixWatches.id, watchId), eq(aiAgentFixWatches.state, 'watching')))
      .returning({ id: aiAgentFixWatches.id });
    if (!moved) return null;
    await recordWatchVerdictEvidence(watch, 'verified');
    return 'held_qualified';
  });

  if (detected === null) return { action: 'not_found' };
  if (detected === 'held_qualified') return { action: 'held_qualified' };

  try {
    await sendRecurrenceNotifications(detected.watch, detected.recurrenceAlertId);
  } catch (error) {
    console.error('[fixWatch] failed to notify a recurrence (non-fatal — the watch state is already committed)', {
      watchId, error,
    });
  }
  return { action: 'recurred' };
}
