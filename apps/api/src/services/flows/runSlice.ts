/**
 * Tool catalog W04 (#5219), plan Task A8 — ONE slice of a flow run: from a
 * BullMQ job to the next park, the end of the run, or a slot refusal.
 *
 * Order (plan Task A8 `processFlowRunJob`, steps 1–8):
 *   1. read; terminal ⇒ return; acquire the lease (null ⇒ another slice
 *      owns the run ⇒ return). From here every write is a fenced
 *      `checkpoint`; a `false` ends the slice silently. A parked intent the
 *      release worker owns (approved / executing) ⇒ release and return —
 *      BEFORE the flag, so no early end ever records a running step as not
 *      run. Flag off ⇒ failed `flows_disabled`; an early wake of a `waiting`
 *      run ⇒ return.
 *   2. the flow is enabled on THIS run's publication, else cancelled
 *      `flow_disabled` (disabled) / failed `drift` — checked before anything
 *      that can pause the flow, so a stale run never pauses a re-enabled one
 *      (every pause is also fenced to the run's publication seq).
 *   3. pins / bindings / the document parse, else failed `drift` + pause
 *      `drift`; the delegator still holds what they delegated, rule 7
 *      included (every slice, resumes included) else pause
 *      `delegator_inactive`; `cancel_requested_at` ⇒ cancelled.
 *   Every early end (1–3) records a parked step whose intent already
 *   executed from that intent (runLedger.parkedRowOnEarlyEnd): completed
 *   stays completed; may-have-run is `unknown_outcome` and ends the run so.
 *   3. the flow is enabled on THIS publication, else cancelled
 *      `flow_disabled` (disabled) / failed `drift`; `cancel_requested_at` ⇒
 *      cancelled.
 *   4. a parked run's intent decides the parked step (runLedger.ts); not
 *      terminal yet ⇒ release the lease and return (spurious wake).
 *   5. a `running` step row of a dead slice: tier 1 ⇒ `worker_lost`, run it
 *      again as attempt + 1; tier ≥ 2 ⇒ `unknown_outcome`, run failed.
 *   6. claim a run slot; refused ⇒ release the lease and tell the job to
 *      delay itself (flowRunner.ts) — no attempt consumed.
 *   7. walk the steps from the ledger, executing what has not happened.
 *   8. end ⇒ completed (failed when a `continue` step failed), publish
 *      `flow.run.*` after commit.
 *
 * Steps 2–5 run BEFORE the slot claim on purpose: a stalled run is itself
 * `running` and holds its slot (runAdmission.ts), and a run that is about to
 * end must never wait 15 s for a slot to say so.
 *
 * DB: every read is a short system transaction; every write is a fenced
 * checkpoint (runLease.ts). Nothing here holds a transaction across a step —
 * the executor opens its own contexts and runs external I/O outside any
 * (spec §6.5).
 */
import { randomUUID } from 'node:crypto';
import {
  evaluateExpr,
  FLOW_RUN_LIMITS,
  flowDocumentV1Schema,
  parseExpr,
  type FlowDocumentV1,
  type FlowPausedReason,
  type FlowRunErrorCode,
  type FlowRunTerminalStatus,
  type FlowScope,
  type FlowStepErrorCode,
  type FlowValue,
} from '@breeze/shared';
import { flowsEnabled } from '../../config/env';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { FlowRunRow, FlowRunStepRow, FlowVersionRow } from '../../db/schema/flowRuns';
import type { AuthContext } from '../../middleware/auth';
import { flowPreApprovalBindingSchema, flowStepPinSchema, type FlowStepPin } from '../flowValidator';
import { captureException } from '../sentry';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { enqueueFlowRunSlice } from '../../jobs/flowRunQueue';
import { buildFlowAuthContext } from './flowAuthContext';
import { claimRunSlot } from './runAdmission';
import {
  closeOpenRows,
  isRetryMarker,
  latestAttempts,
  ledgerKey,
  parkedRowOnEarlyEnd,
  resolveParkedIntent,
  type ParkedEarlyEnd,
  WORKER_LOST_RETRY_TEXT,
  WORKER_LOST_UNKNOWN_TEXT,
  type ParkedResolution,
  type RunEnd,
  type StepRowValues,
} from './runLedger';
import { notifyFlowRunUnknownOutcome, publishFlowRunTerminalEvent } from './runEvents';
import { acquireRunLease, checkpoint, releaseRunLease, startLeaseHeartbeat, type FlowRunCheckpointStep } from './runLease';
import * as store from './runStore';
import { executeFlowStep, type StepOutcome } from './stepExecutor';
import { effectiveForEachConcurrency, runForEachItems, type ForEachItemResult } from './forEachConcurrent';
import { assertDelegatorAuthority, pauseFlow } from './versions';

export type FlowSliceResult = { kind: 'done' } | { kind: 'no_slot' };

type FlowStep = FlowDocumentV1['steps'][number];
type UnitResult =
  | { flow: 'stop' }
  | { flow: 'continue'; status: 'completed' | 'skipped' | 'failed'; output: FlowValue | null };

const DONE: FlowSliceResult = { kind: 'done' };
const STOP: UnitResult = { flow: 'stop' };
const ACTIVE = store.ACTIVE_FLOW_RUN_STATUSES as FlowRunRow['status'][];
const TERMINAL: ReadonlySet<string> = new Set(store.TERMINAL_FLOW_RUN_STATUSES);
const PAUSE_FOR_CODE: Partial<Record<FlowStepErrorCode, FlowPausedReason>> = {
  binding_drift: 'binding_drift',
  drift: 'drift',
  tool_unavailable: 'drift',
  tool_blocked: 'drift',
};

function read<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** Sentry tags for a flow run (convention: ids as tags, a literal call-site name, bounded fingerprint). */
function captureFlow(err: unknown, site: string, ids: { orgId?: string; flowId?: string; runId?: string }): void {
  captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
    ...(ids.orgId ? { org_id: ids.orgId } : {}),
    ...(ids.flowId ? { flow_id: ids.flowId } : {}),
    ...(ids.runId ? { flow_run_id: ids.runId } : {}),
    flow_site: site,
  }, { fingerprint: ['flow', site] });
}

/**
 * Pause the flow — fenced to THIS run's publication, so a run of an old
 * publication can never pause a flow re-enabled since (round-2 review).
 */
async function safePause(
  run: Pick<FlowRunRow, 'id' | 'orgId' | 'flowId'>,
  publicationSeq: number,
  reason: FlowPausedReason,
): Promise<void> {
  try {
    await pauseFlow(run.flowId, reason, { expectedPublicationSeq: publicationSeq });
  } catch (err) {
    // The run is already terminal; the next slice of any run of this flow
    // re-checks and pauses again.
    console.error(`[FlowRunner] pause failed (flow=${run.flowId}, reason=${reason})`, err);
    captureFlow(err, 'flows.runSlice.pause', { orgId: run.orgId, flowId: run.flowId, runId: run.id });
  }
}

/** Everything a slice knows once it holds the lease. */
interface Slice {
  runId: string;
  token: string;
  run: FlowRunRow;
  publication: FlowVersionRow;
  flow: store.SliceFlowRow;
  resumeSeq: number;
  activeMs: number;
  anyContinueFailure: boolean;
  /** Filled after the preconditions pass. */
  doc?: FlowDocumentV1;
  pins?: Map<string, FlowStepPin>;
  auth?: AuthContext;
  latest?: Map<string, FlowRunStepRow>;
  stepScope: Record<string, { output: FlowValue | null; status: string }>;
}

function runRef(s: Slice) {
  return { id: s.run.id, orgId: s.run.orgId, flowId: s.run.flowId, chainDepth: s.run.chainDepth };
}

/**
 * End the run: one checkpoint (terminal patch + any step writes), then the
 * pause, the unknown-outcome notification and the `flow.run.*` event — all
 * after commit. Returns false when the fence refused (nothing written).
 */
async function finish(
  s: Slice,
  end: { status: FlowRunTerminalStatus; errorCode: FlowRunErrorCode | null; error: string | null },
  step?: FlowRunCheckpointStep,
  after: { pause?: FlowPausedReason | null; unknownStepId?: string | null } = {},
): Promise<boolean> {
  const ok = await checkpoint(s.runId, s.token, {
    status: end.status,
    errorCode: end.errorCode,
    error: end.error,
    finishedAt: new Date(),
    wakeAt: null,
    activeMs: s.activeMs,
  }, step);
  if (after.pause) await safePause(s.run, s.publication.publicationSeq, after.pause);
  if (!ok) return false;
  if (after.unknownStepId) {
    await notifyFlowRunUnknownOutcome({
      delegatorUserId: s.publication.enabledByUserId ?? null,
      orgId: s.run.orgId,
      flowId: s.run.flowId,
      flowName: s.flow.name,
      runId: s.runId,
      stepId: after.unknownStepId,
    });
  }
  await publishFlowRunTerminalEvent(runRef(s), end.status);
  return true;
}

/**
 * End the run before any step ran in this slice, closing whatever rows are
 * open. `parked` (review finding 3): the parked row's own outcome when its
 * intent already executed — a completed step stays completed, a may-have-run
 * one is `unknown_outcome`. Any `unknown_outcome` row ends the run
 * `unknown_outcome`, outranking the precondition's code (cancelled, drift,
 * flows_disabled, delegator_inactive): "it may have taken effect" is the fact
 * an operator must act on. A pause still happens.
 */
async function finishEarly(
  s: Slice,
  rows: readonly FlowRunStepRow[],
  end: RunEnd,
  pause?: FlowPausedReason,
  parked: ParkedEarlyEnd | null = null,
): Promise<FlowSliceResult> {
  const latest = latestAttempts(rows);
  const { updates, unknownStepIds } = closeOpenRows(latest.values(), new Date(), parked);
  const unknownStepId = unknownStepIds[0] ?? null;
  const runEnd: RunEnd = unknownStepId
    ? { status: 'failed', errorCode: 'unknown_outcome', error: `Step ${unknownStepId} may or may not have taken effect.` }
    : end;
  await finish(s, runEnd, updates.length > 0 ? { updates } : undefined, { pause: pause ?? null, unknownStepId });
  return DONE;
}

function ownerOf(flow: store.SliceFlowRow, orgPartnerId: string | null): ToolOwnerRef | null {
  if (flow.orgId) return orgPartnerId ? { orgId: flow.orgId, partnerId: orgPartnerId } : null;
  return flow.partnerId ? { orgId: null, partnerId: flow.partnerId } : null;
}

/** The publication, parsed: a failure is drift (jsonb decides unattended work — never trust it). */
function parsePublication(publication: FlowVersionRow): { doc: FlowDocumentV1; pins: Map<string, FlowStepPin> } | null {
  const doc = flowDocumentV1Schema.safeParse(publication.definition);
  if (!doc.success) return null;
  if (!Array.isArray(publication.stepPins) || !Array.isArray(publication.preApprovals)) return null;
  const pins = new Map<string, FlowStepPin>();
  for (const raw of publication.stepPins) {
    const parsed = flowStepPinSchema.safeParse(raw);
    if (!parsed.success || pins.has(parsed.data.stepId)) return null;
    pins.set(parsed.data.stepId, parsed.data);
  }
  for (const raw of publication.preApprovals) {
    if (!flowPreApprovalBindingSchema.safeParse(raw).success) return null;
  }
  for (const step of doc.data.steps) {
    if (!pins.has(step.id)) return null;
  }
  return { doc: doc.data, pins };
}

function parkedRowOf(rows: readonly FlowRunStepRow[]): FlowRunStepRow | null {
  for (const row of latestAttempts(rows).values()) {
    if (row.status === 'awaiting_approval' && row.actionIntentId) return row;
  }
  return null;
}

export async function runFlowSlice(runId: string): Promise<FlowSliceResult> {
  // ── 1. read, flag, early wake, lease ─────────────────────────────────────
  const first = await read(() => store.loadSliceSnapshot(runId), 'flows.runSlice.load');
  if (!first || TERMINAL.has(first.run.status)) return DONE;
  if (flowsEnabled() && first.run.status === 'waiting' && first.wakePending) return DONE;

  const lease = await acquireRunLease(runId, ACTIVE);
  if (!lease) return DONE;
  const snap = await read(() => store.loadSliceSnapshot(runId), 'flows.runSlice.reload');
  if (!snap || TERMINAL.has(snap.run.status) || snap.run.leaseToken !== lease.token || !snap.publication || !snap.flow) {
    // Gone, finished or taken over between the CAS and the read (or an FK
    // invariant broke): nothing here is ours to decide.
    await releaseRunLease(runId, lease.token);
    return DONE;
  }
  const s: Slice = {
    runId,
    token: lease.token,
    run: snap.run,
    publication: snap.publication,
    flow: snap.flow,
    resumeSeq: snap.run.resumeSeq,
    activeMs: Number(snap.run.activeMs ?? 0),
    anyContinueFailure: false,
    stepScope: {},
  };
  const rows = await read(() => store.loadStepRows(runId), 'flows.runSlice.steps');

  // An approved/executing parked intent belongs to the release worker right
  // now; deciding anything (flag, cancel, drift, delegator) under it would
  // record a step as not-run while it may be running. Its terminal transition
  // wakes us. Checked BEFORE the flag: with FLOWS_ENABLED off the dispatch
  // claim refuses an approved intent and ends the run itself (intentClaim.ts),
  // and an executing one finishes and wakes this run into the flag-off end.
  const parked = s.run.status === 'awaiting_approval' ? parkedRowOf(rows) : null;
  const parkedIntent = parked?.actionIntentId
    ? await read(() => store.loadParkedIntent(runId, parked.actionIntentId!), 'flows.runSlice.intent')
    : null;
  if (parkedIntent && (parkedIntent.status === 'approved' || parkedIntent.status === 'executing')) {
    await releaseRunLease(runId, s.token);
    return DONE;
  }
  // Review finding 3: what a TERMINAL parked intent already decided, so an
  // early end below records an executed step as executed (never `cancelled`).
  // `onFailure` cannot change which intents executed, so 'stop' stands in
  // before the document is parsed.
  const parkedEnd = parked
    ? parkedRowOnEarlyEnd(parked.id, parkedIntent, resolveParkedIntent(parkedIntent, {
      stepId: parked.stepId, tool: parked.tool, toolSource: parked.toolSource, onFailure: 'stop', cancelRequested: false, now: new Date(),
    }))
    : null;
  const endEarly = (end: RunEnd, pause?: FlowPausedReason) => finishEarly(s, rows, end, pause, parkedEnd);

  if (!flowsEnabled()) {
    return endEarly({ status: 'failed', errorCode: 'flows_disabled', error: 'Flows are turned off on this deployment.' });
  }
  if (s.run.status === 'waiting' && snap.wakePending) {
    await releaseRunLease(runId, s.token);
    return DONE;
  }

  // ── 2. flow live on THIS publication ─────────────────────────────────────
  // Before anything that can pause the flow (round-2 review): a run of an old
  // publication (the flow was disabled, paused, or re-enabled on a newer
  // publication by someone else) ends here, without judging its delegator or
  // its pins — those belong to a publication that no longer governs the flow.
  if (s.flow.status !== 'enabled') {
    return s.flow.status === 'paused'
      ? endEarly({ status: 'failed', errorCode: 'drift', error: 'The flow was paused.' })
      : endEarly({ status: 'cancelled', errorCode: 'flow_disabled', error: 'The flow was disabled.' });
  }
  if (s.flow.enabledPublicationSeq !== s.publication.publicationSeq) {
    return endEarly({ status: 'failed', errorCode: 'drift', error: 'The flow was re-published after this run started.' });
  }

  // ── 3. publication + delegator; cancel ───────────────────────────────────
  const owner = ownerOf(s.flow, snap.orgPartnerId);
  if (!owner) {
    return endEarly({ status: 'failed', errorCode: 'drift', error: "The flow's owner could not be resolved." });
  }
  // Parsed BEFORE the delegator check: rule 7 (review finding 6) measures the
  // delegator against the publication's steps.
  const parsed = parsePublication(s.publication);
  if (!parsed) {
    return endEarly({ status: 'failed', errorCode: 'drift', error: "The flow's enable-time record could not be read." }, 'drift');
  }
  if (!(await assertDelegatorAuthority(s.publication, owner, { doc: parsed.doc, pins: [...parsed.pins.values()] }))) {
    return endEarly({
      status: 'failed', errorCode: 'delegator_inactive',
      error: 'The person who enabled this flow no longer has the access it delegates.',
    }, 'delegator_inactive');
  }
  s.doc = parsed.doc;
  s.pins = parsed.pins;

  if (s.run.cancelRequestedAt) {
    return endEarly({ status: 'cancelled', errorCode: 'cancelled', error: 'The run was cancelled.' });
  }

  try {
    s.auth = buildFlowAuthContext(
      { id: s.flow.id, orgId: s.flow.orgId, partnerId: s.flow.partnerId, status: s.flow.status as 'enabled', name: s.flow.name },
      { id: s.run.id, orgId: s.run.orgId, flowId: s.run.flowId },
      { id: s.run.orgId, partnerId: snap.orgPartnerId ?? '' },
    );
  } catch (err) {
    return endEarly({ status: 'failed', errorCode: 'drift', error: `This run no longer belongs to the flow's owner (${messageOf(err)}).` });
  }

  // ── 4. a parked step's intent ────────────────────────────────────────────
  if (parked) {
    const stepDef = s.doc.steps.find((st) => st.id === parked.stepId);
    const resolution = resolveParkedIntent(parkedIntent, {
      stepId: parked.stepId,
      tool: parked.tool,
      toolSource: parked.toolSource,
      onFailure: stepDef?.onFailure ?? 'stop',
      cancelRequested: false,
      now: new Date(),
    });
    if (resolution.kind === 'pending') {
      await releaseRunLease(runId, s.token);
      return DONE;
    }
    if (resolution.kind === 'end') {
      await finish(s, resolution.run, { update: { id: parked.id, values: resolution.step } }, {
        unknownStepId: resolution.unknownOutcome ? parked.stepId : null,
      });
      return DONE;
    }
    // `continue` is written in the walk, after the slot claim (step 7).
  }

  // ── 5. stalled rows of a dead slice ──────────────────────────────────────
  const latest = latestAttempts(rows);
  const retryMarks: Array<{ id: string; values: StepRowValues }> = [];
  for (const row of latest.values()) {
    if (row.status !== 'running') continue;
    const now = new Date();
    if (row.tier >= 2) {
      await finish(s, { status: 'failed', errorCode: 'unknown_outcome', error: `Step ${row.stepId} may or may not have taken effect.` }, {
        update: { id: row.id, values: { status: 'unknown_outcome', errorCode: 'unknown_outcome', error: WORKER_LOST_UNKNOWN_TEXT, finishedAt: now } },
      }, { unknownStepId: row.stepId });
      return DONE;
    }
    retryMarks.push({ id: row.id, values: { status: 'failed', errorCode: 'worker_lost', error: WORKER_LOST_RETRY_TEXT, finishedAt: now } });
  }
  if (retryMarks.length > 0) {
    if (!(await checkpoint(runId, s.token, {}, { updates: retryMarks }))) return DONE;
  }

  // ── 6. the slot ──────────────────────────────────────────────────────────
  if (!(await claimRunSlot({ id: s.run.id, flowId: s.run.flowId, orgId: s.run.orgId }, owner, s.token))) {
    // FIRST: a delayed attempt must be able to re-acquire the lease.
    await releaseRunLease(runId, s.token);
    return { kind: 'no_slot' };
  }

  // ── 7. the walk ──────────────────────────────────────────────────────────
  s.latest = latestAttempts(await read(() => store.loadStepRows(runId), 'flows.runSlice.steps'));
  for (const [index, step] of s.doc.steps.entries()) {
    const result = step.forEach ? await walkForEach(s, step, index) : await walkStep(s, step, index);
    if (result === 'stop') return DONE;
  }

  // ── 8. the end ───────────────────────────────────────────────────────────
  await finish(s, s.anyContinueFailure
    ? { status: 'failed', errorCode: 'step_failed', error: 'One or more steps failed (onFailure: continue).' }
    : { status: 'completed', errorCode: null, error: null });
  return DONE;
}

// ── the walk ────────────────────────────────────────────────────────────────

function scopeFor(s: Slice): FlowScope {
  return {
    trigger: (s.run.triggerPayload ?? {}) as FlowValue,
    inputs: (s.run.inputs ?? {}) as FlowValue,
    steps: { ...s.stepScope } as FlowValue,
    flow: { id: s.flow.id, name: s.flow.name, orgId: s.run.orgId },
    now: new Date().toISOString(),
  };
}

function record(s: Slice, stepId: string, status: string, output: FlowValue | null): void {
  s.stepScope[stepId] = { output, status };
}

/** Where the run is now; the unit that runs next (or the step after a wait). */
function nextCursor(s: Slice, index: number, itemIndex: number | null, itemCount: number | null): { stepId: string; itemIndex: number | null } {
  const step = s.doc!.steps[index]!;
  if (itemIndex !== null && itemCount !== null && itemIndex + 1 < itemCount) return { stepId: step.id, itemIndex: itemIndex + 1 };
  const next = s.doc!.steps[index + 1];
  return next ? { stepId: next.id, itemIndex: null } : { stepId: step.id, itemIndex };
}

/** A finished ledger row's meaning for the walk. 'end' rows mean the run should already be over. */
function settledRow(row: FlowRunStepRow | undefined): 'none' | 'done' | 'failed' | 'parked' | 'end' {
  if (!row || isRetryMarker(row)) return 'none';
  switch (row.status) {
    case 'completed':
    case 'skipped':
      return 'done';
    case 'failed':
      return 'failed';
    case 'awaiting_approval':
      return 'parked';
    case 'running':
      return 'none'; // closed as worker_lost in step 5; unreachable here
    default:
      return 'end';
  }
}

async function walkStep(s: Slice, step: FlowStep, index: number): Promise<'continue' | 'stop'> {
  const row = s.latest!.get(ledgerKey(step.id, null));
  const unit = await walkUnit(s, step, index, null, undefined, null, row);
  if (unit.flow === 'stop') return 'stop';
  record(s, step.id, unit.status, unit.output);
  if (unit.status === 'failed') s.anyContinueFailure = true;
  return 'continue';
}

async function walkForEach(s: Slice, step: FlowStep, index: number): Promise<'continue' | 'stop'> {
  const head = s.latest!.get(ledgerKey(step.id, null));
  const headState = settledRow(head);
  if (headState === 'failed') {
    // The items could not be listed; recorded once, under onFailure 'continue'.
    record(s, step.id, 'failed', null);
    s.anyContinueFailure = true;
    return 'continue';
  }

  const items = evaluateItems(step, scopeFor(s));
  if (!items.ok || items.value.length > step.forEach!.maxItems) {
    const code: FlowStepErrorCode = items.ok ? 'too_many_items' : 'input_invalid';
    const message = items.ok
      ? `forEach produced ${items.value.length} items; the limit is ${step.forEach!.maxItems}.`
      : items.error;
    const pin = s.pins!.get(step.id)!;
    const now = new Date();
    const insert = {
      id: randomUUID(), runId: s.runId, orgId: s.run.orgId, stepId: step.id, itemIndex: null, attempt: (head?.attempt ?? 0) + 1,
      tool: pin.tool, toolSource: pin.source, tier: pin.tier, status: 'failed' as const, errorCode: code, error: message,
      startedAt: now, finishedAt: now, durationMs: 0,
    };
    if (step.onFailure === 'stop') {
      await finish(s, { status: 'failed', errorCode: code, error: `Step ${step.id}: ${message}` }, { insert });
      return 'stop';
    }
    if (!(await checkpoint(s.runId, s.token, { currentStepId: step.id, currentItemIndex: null }, { insert }))) return 'stop';
    record(s, step.id, 'failed', null);
    s.anyContinueFailure = true;
    return 'continue';
  }

  // W5 (#5220, Decision 11): a Tier-1/2, non-wait step with concurrency > 1
  // runs its items in parallel — unless an item row is parked or closed on a
  // live run, which only the sequential walk knows how to resume or end.
  const pin = s.pins!.get(step.id)!;
  if (effectiveForEachConcurrency(step, pin) > 1 && !items.value.some((_, i) => {
    const state = settledRow(s.latest!.get(ledgerKey(step.id, i)));
    return state === 'parked' || state === 'end';
  })) {
    return walkForEachConcurrent(s, step, index, items.value);
  }

  const outputs: Array<FlowValue | null> = [];
  let failed = false;
  for (const [i, item] of items.value.entries()) {
    const row = s.latest!.get(ledgerKey(step.id, i));
    const unit = await walkUnit(s, step, index, i, item, items.value.length, row);
    if (unit.flow === 'stop') return 'stop';
    outputs.push(unit.status === 'completed' ? unit.output : null);
    if (unit.status === 'failed') failed = true;
  }
  record(s, step.id, failed ? 'failed' : 'completed', outputs);
  if (failed) s.anyContinueFailure = true;
  return 'continue';
}

function evaluateItems(step: FlowStep, scope: FlowScope): { ok: true; value: FlowValue[] } | { ok: false; error: string } {
  const parsed = parseExpr(step.forEach!.items);
  if (!parsed.ok) return { ok: false, error: `forEach.items: ${parsed.error}` };
  const evaluated = evaluateExpr(parsed.ast, scope);
  if (!evaluated.ok) return { ok: false, error: `forEach.items: ${evaluated.error}` };
  if (!Array.isArray(evaluated.value)) return { ok: false, error: 'forEach.items did not evaluate to a list.' };
  return { ok: true, value: evaluated.value };
}

/** One unit (a step, or one for-each item) given its latest ledger row. */
async function walkUnit(
  s: Slice,
  step: FlowStep,
  index: number,
  itemIndex: number | null,
  item: FlowValue | undefined,
  itemCount: number | null,
  row: FlowRunStepRow | undefined,
): Promise<UnitResult> {
  switch (settledRow(row)) {
    case 'done':
      return { flow: 'continue', status: row!.status as 'completed' | 'skipped', output: (row!.output ?? null) as FlowValue | null };
    case 'failed':
      // Only an onFailure 'continue' failure leaves a run going (a stop
      // failure is written with the run's terminal status).
      return { flow: 'continue', status: 'failed', output: null };
    case 'parked':
      return resumeParkedUnit(s, step, index, itemIndex, itemCount, row!);
    case 'end':
      // A closed unknown_outcome / cancelled row on a live run: end it the same way.
      await finish(s, row!.status === 'cancelled'
        ? { status: 'cancelled', errorCode: 'cancelled', error: 'The run was cancelled.' }
        : { status: 'failed', errorCode: 'unknown_outcome', error: `Step ${step.id} may or may not have taken effect.` });
      return STOP;
    case 'none':
    default:
      return executeUnit(s, step, index, itemIndex, item, itemCount, (row?.attempt ?? 0) + 1);
  }
}

async function resumeParkedUnit(
  s: Slice,
  step: FlowStep,
  index: number,
  itemIndex: number | null,
  itemCount: number | null,
  row: FlowRunStepRow,
): Promise<UnitResult> {
  const intent = await read(() => store.loadParkedIntent(s.runId, row.actionIntentId!), 'flows.runSlice.intent');
  const resolution: ParkedResolution = resolveParkedIntent(intent, {
    stepId: step.id, tool: row.tool, toolSource: row.toolSource, onFailure: step.onFailure, cancelRequested: false, now: new Date(),
  });
  if (resolution.kind === 'pending') {
    // Unreachable after step 4 (terminal intent statuses are final); park again rather than guess.
    await checkpoint(s.runId, s.token, {
      status: 'awaiting_approval', currentStepId: step.id, currentItemIndex: itemIndex, resumeSeq: ++s.resumeSeq, activeMs: s.activeMs,
    }, undefined, { releaseLease: true });
    return STOP;
  }
  if (resolution.kind === 'end') {
    await finish(s, resolution.run, { update: { id: row.id, values: resolution.step } }, {
      unknownStepId: resolution.unknownOutcome ? step.id : null,
    });
    return STOP;
  }
  const cursor = nextCursor(s, index, itemIndex, itemCount);
  const ok = await checkpoint(s.runId, s.token, { currentStepId: cursor.stepId, currentItemIndex: cursor.itemIndex, activeMs: s.activeMs },
    { update: { id: row.id, values: resolution.step } });
  if (!ok) return STOP;
  return { flow: 'continue', status: resolution.status, output: resolution.output };
}

async function executeUnit(
  s: Slice,
  step: FlowStep,
  index: number,
  itemIndex: number | null,
  item: FlowValue | undefined,
  itemCount: number | null,
  attempt: number,
): Promise<UnitResult> {
  if (s.activeMs > FLOW_RUN_LIMITS.maxActiveMs) {
    await finish(s, { status: 'failed', errorCode: 'run_timeout', error: 'The run exceeded its active-time limit.' });
    return STOP;
  }
  // Checked before every step and every for-each item (spec §6.5).
  const control = await read(() => store.readRunControl(s.runId), 'flows.runSlice.control');
  if (!control || control.leaseToken !== s.token || TERMINAL.has(control.status)) return STOP;
  if (control.cancelRequestedAt) {
    await finish(s, { status: 'cancelled', errorCode: 'cancelled', error: 'The run was cancelled.' });
    return STOP;
  }

  const pin = s.pins!.get(step.id)!;
  const stepRowId = randomUUID();
  const startedAt = new Date();
  const inserted = await checkpoint(s.runId, s.token, { currentStepId: step.id, currentItemIndex: itemIndex, lastHeartbeatAt: startedAt }, {
    insert: {
      id: stepRowId, runId: s.runId, orgId: s.run.orgId, stepId: step.id, itemIndex, attempt,
      tool: pin.tool, toolSource: pin.source, tier: pin.tier, status: 'running', startedAt,
    },
  });
  if (!inserted) return STOP;

  const exec = await runStepExecutor(s, step, pin, itemIndex, item, stepRowId);
  if (exec.lost) return STOP;
  s.activeMs += exec.elapsed;
  return applyOutcome(s, step, index, itemIndex, itemCount, stepRowId, exec.outcome, exec.elapsed);
}

/**
 * Execute one unit's step under a lease heartbeat. Shared by the sequential
 * walk and the parallel for-each (W5): no run state is touched here.
 */
async function runStepExecutor(
  s: Slice,
  step: FlowStep,
  pin: FlowStepPin,
  itemIndex: number | null,
  item: FlowValue | undefined,
  stepRowId: string,
): Promise<{ lost: true } | { lost: false; outcome: StepOutcome; elapsed: number }> {
  const heartbeat = startLeaseHeartbeat(s.runId, s.token, { stepId: step.id });
  const t0 = Date.now();
  let outcome: StepOutcome;
  try {
    outcome = await executeFlowStep({
      run: s.run,
      version: s.publication,
      step,
      pin,
      itemIndex,
      item,
      scope: scopeFor(s),
      auth: s.auth!,
      deadline: t0 + step.timeoutSec * 1000,
      stepRowId,
    });
  } catch (err) {
    // The executor catches every tool-call failure itself; what escapes is a
    // revalidation/DB error before any effect. Never skippable by 'continue'.
    console.error(`[FlowRunner] step executor threw (run=${s.runId}, step=${step.id})`, err);
    captureFlow(err, 'flows.runSlice.executeStep', { orgId: s.run.orgId, flowId: s.run.flowId, runId: s.runId });
    outcome = { kind: 'failed', code: 'step_failed', message: `The step could not be executed: ${messageOf(err)}`, policy: true };
  } finally {
    heartbeat.stop();
  }
  const elapsed = Math.max(0, Date.now() - t0);
  // A lost heartbeat means another slice may own the run: never write a late result.
  if (heartbeat.lost()) {
    console.warn(
      `[FlowRunner] lease lost while the step ran; its result (${outcome.kind}) is dropped `
      + `(run=${s.runId}, step=${step.id}${itemIndex === null ? '' : `, item=${itemIndex}`})`,
    );
    return { lost: true };
  }
  return { lost: false, outcome, elapsed };
}

// ── W5: parallel for-each (#5220, Decision 11) ─────────────────────────────

/** What an item that ended the batch said, for the run's terminal write. */
type ItemEnd =
  | { kind: 'failed'; code: FlowStepErrorCode; message: string; policy: boolean }
  | { kind: 'unknown_outcome' };

/**
 * One for-each item of a parallel batch: insert its `running` row, execute,
 * write its outcome — every write lease-fenced with an EMPTY run patch (no
 * cursor, no active time, no lease release: only Tier ≤ 2, non-wait steps get
 * here, so an item never parks). The batch writes the cursor and active time.
 */
async function executeUnitRow(
  s: Slice,
  step: FlowStep,
  pin: FlowStepPin,
  itemIndex: number,
  item: FlowValue,
  attempt: number,
  ends: Map<number, ItemEnd>,
): Promise<ForEachItemResult> {
  const stepRowId = randomUUID();
  const inserted = await checkpoint(s.runId, s.token, {}, {
    insert: {
      id: stepRowId, runId: s.runId, orgId: s.run.orgId, stepId: step.id, itemIndex, attempt,
      tool: pin.tool, toolSource: pin.source, tier: pin.tier, status: 'running', startedAt: new Date(),
    },
  });
  if (!inserted) return { kind: 'stop' };

  const exec = await runStepExecutor(s, step, pin, itemIndex, item, stepRowId);
  if (exec.lost) return { kind: 'stop' };
  const { outcome, elapsed: durationMs } = exec;
  const finishedAt = new Date();
  const rendered = outcome.kind === 'skipped' ? null : (outcome.renderedInput ?? null);
  const write = (values: StepRowValues) => checkpoint(s.runId, s.token, {}, {
    update: { id: stepRowId, values: { renderedInput: rendered, durationMs, ...values } },
  });

  switch (outcome.kind) {
    case 'skipped':
      return (await write({ status: 'skipped', output: null, finishedAt })) ? { kind: 'done', status: 'skipped', output: null } : { kind: 'stop' };
    case 'completed':
      return (await write({ status: 'completed', output: outcome.output, outputTruncated: outcome.truncated, finishedAt }))
        ? { kind: 'done', status: 'completed', output: outcome.output }
        : { kind: 'stop' };
    case 'failed':
      if (!(await write({ status: 'failed', errorCode: outcome.code, error: outcome.message, finishedAt }))) return { kind: 'stop' };
      ends.set(itemIndex, { kind: 'failed', code: outcome.code, message: outcome.message, policy: outcome.policy });
      return { kind: 'failed', terminal: outcome.policy };
    case 'unknown_outcome':
      if (!(await write({ status: 'unknown_outcome', errorCode: 'unknown_outcome', error: outcome.message, finishedAt }))) return { kind: 'stop' };
      ends.set(itemIndex, { kind: 'unknown_outcome' });
      return { kind: 'failed', terminal: true };
    case 'park_approval':
    case 'park_wait': {
      // Unreachable (Tier ≤ 2, never wait). Never park inside a batch.
      const message = 'A parallel for-each item cannot wait or ask for approval.';
      if (!(await write({ status: 'failed', errorCode: 'step_failed', error: message, finishedAt }))) return { kind: 'stop' };
      ends.set(itemIndex, { kind: 'failed', code: 'step_failed', message, policy: true });
      return { kind: 'failed', terminal: true };
    }
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled step outcome ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The parallel for-each walk: the coordinator launches the unsettled items in
 * index order (resume derives settled items from the ledger, never from the
 * cursor), then ONE checkpoint writes the cursor and the batch's wall-clock
 * active time — or the run's terminal write when an item ended the batch.
 */
async function walkForEachConcurrent(s: Slice, step: FlowStep, index: number, items: FlowValue[]): Promise<'continue' | 'stop'> {
  const pin = s.pins!.get(step.id)!;
  const ends = new Map<number, ItemEnd>();
  const t0 = Date.now();
  const { results, halted } = await runForEachItems({
    count: items.length,
    parallelism: effectiveForEachConcurrency(step, pin),
    stopOnFailure: step.onFailure === 'stop',
    settled: (i) => {
      const row = s.latest!.get(ledgerKey(step.id, i));
      const state = settledRow(row);
      if (state === 'done') return { kind: 'done', status: row!.status as 'completed' | 'skipped', output: (row!.output ?? null) as FlowValue | null };
      // Only an onFailure 'continue' failure leaves a run going.
      if (state === 'failed') return { kind: 'failed', terminal: false };
      return null;
    },
    beforeLaunch: async () => {
      if (s.activeMs + (Date.now() - t0) > FLOW_RUN_LIMITS.maxActiveMs) return 'timeout';
      const control = await read(() => store.readRunControl(s.runId), 'flows.runSlice.control');
      if (!control || control.leaseToken !== s.token || TERMINAL.has(control.status)) return 'stop';
      return control.cancelRequestedAt ? 'cancelled' : 'ok';
    },
    runItem: (i) => executeUnitRow(s, step, pin, i, items[i]!, (s.latest!.get(ledgerKey(step.id, i))?.attempt ?? 0) + 1, ends),
  });
  s.activeMs += Math.max(0, Date.now() - t0);

  if (halted === 'stop') return 'stop';
  const firstEnd = [...ends.entries()].sort(([a], [b]) => a - b);
  const unknown = firstEnd.find(([, e]) => e.kind === 'unknown_outcome');
  if (unknown) {
    await finish(s, { status: 'failed', errorCode: 'unknown_outcome', error: `Step ${step.id} may or may not have taken effect.` }, undefined, {
      unknownStepId: step.id,
    });
    return 'stop';
  }
  if (halted === 'cancelled') {
    await finish(s, { status: 'cancelled', errorCode: 'cancelled', error: 'The run was cancelled.' });
    return 'stop';
  }
  if (halted === 'timeout') {
    await finish(s, { status: 'failed', errorCode: 'run_timeout', error: 'The run exceeded its active-time limit.' });
    return 'stop';
  }
  const ending = firstEnd.find(([, e]) => e.kind === 'failed' && (e.policy || step.onFailure === 'stop'));
  if (halted === 'failure' && ending) {
    const end = ending[1] as Extract<ItemEnd, { kind: 'failed' }>;
    await finish(s, { status: 'failed', errorCode: end.code, error: `Step ${step.id}: ${end.message}` }, undefined, {
      pause: PAUSE_FOR_CODE[end.code] ?? null,
    });
    return 'stop';
  }

  const outputs = results.map((r) => (r?.kind === 'done' && r.status === 'completed' ? r.output : null));
  const failed = results.some((r) => r?.kind === 'failed');
  const cursor = nextCursor(s, index, null, null);
  const ok = await checkpoint(s.runId, s.token, { currentStepId: cursor.stepId, currentItemIndex: cursor.itemIndex, activeMs: s.activeMs });
  if (!ok) return 'stop';
  // A non-terminal drift-class failure under continue still pauses the flow (the sequential rule).
  const pauses = new Set([...ends.values()].flatMap((e) => (e.kind === 'failed' && PAUSE_FOR_CODE[e.code] ? [PAUSE_FOR_CODE[e.code]!] : [])));
  for (const pause of pauses) await safePause(s.run, s.publication.publicationSeq, pause);
  record(s, step.id, failed ? 'failed' : 'completed', outputs);
  if (failed) s.anyContinueFailure = true;
  return 'continue';
}

async function applyOutcome(
  s: Slice,
  step: FlowStep,
  index: number,
  itemIndex: number | null,
  itemCount: number | null,
  stepRowId: string,
  outcome: StepOutcome,
  durationMs: number,
): Promise<UnitResult> {
  const finishedAt = new Date();
  const rendered = outcome.kind === 'skipped' ? null : (outcome.renderedInput ?? null);
  const approvalMode = outcome.kind !== 'skipped' && outcome.approvalMode === 'pre_approved' ? 'pre_approved' as const : undefined;
  const cursor = nextCursor(s, index, itemIndex, itemCount);
  const advance = { currentStepId: cursor.stepId, currentItemIndex: cursor.itemIndex, activeMs: s.activeMs };
  const write = (values: StepRowValues): FlowRunCheckpointStep => ({
    update: { id: stepRowId, values: { renderedInput: rendered, durationMs, ...(approvalMode ? { approvalMode } : {}), ...values } },
  });

  switch (outcome.kind) {
    case 'skipped': {
      const ok = await checkpoint(s.runId, s.token, advance, write({ status: 'skipped', output: null, finishedAt }));
      return ok ? { flow: 'continue', status: 'skipped', output: null } : STOP;
    }
    case 'completed': {
      const ok = await checkpoint(s.runId, s.token, advance,
        write({ status: 'completed', output: outcome.output, outputTruncated: outcome.truncated, finishedAt }));
      return ok ? { flow: 'continue', status: 'completed', output: outcome.output } : STOP;
    }
    case 'failed': {
      const stepWrite = write({ status: 'failed', errorCode: outcome.code, error: outcome.message, finishedAt });
      const pause = PAUSE_FOR_CODE[outcome.code] ?? null;
      if (outcome.policy || step.onFailure === 'stop') {
        await finish(s, { status: 'failed', errorCode: outcome.code, error: `Step ${step.id}: ${outcome.message}` }, stepWrite, { pause });
        return STOP;
      }
      const ok = await checkpoint(s.runId, s.token, advance, stepWrite);
      if (pause) await safePause(s.run, s.publication.publicationSeq, pause);
      return ok ? { flow: 'continue', status: 'failed', output: null } : STOP;
    }
    case 'unknown_outcome':
      await finish(s, { status: 'failed', errorCode: 'unknown_outcome', error: `Step ${step.id}: ${outcome.message}` },
        write({ status: 'unknown_outcome', errorCode: 'unknown_outcome', error: outcome.message, finishedAt }),
        { unknownStepId: step.id });
      return STOP;
    case 'park_approval':
      await checkpoint(s.runId, s.token, {
        status: 'awaiting_approval', currentStepId: step.id, currentItemIndex: itemIndex, resumeSeq: ++s.resumeSeq, activeMs: s.activeMs,
      }, write({ status: 'awaiting_approval', approvalMode: 'intent', actionIntentId: outcome.intentId }), { releaseLease: true });
      // No enqueue: the intent's terminal transition wakes the run (wake.ts);
      // the reconciler's clause (b) covers a lost wake.
      return STOP;
    case 'park_wait': {
      // The wait step is COMPLETED now, so a resume never re-enters it.
      const parked = await checkpoint(s.runId, s.token, {
        status: 'waiting', wakeAt: outcome.resumeAt, currentStepId: cursor.stepId, currentItemIndex: cursor.itemIndex,
        resumeSeq: ++s.resumeSeq, activeMs: s.activeMs,
      }, write({ status: 'completed', output: outcome.output as FlowValue, finishedAt }), { releaseLease: true });
      if (parked) {
        try {
          await enqueueFlowRunSlice(s.runId, { delayMs: Math.max(0, outcome.resumeAt.getTime() - Date.now()) });
        } catch (err) {
          // Reconciler clause (d) re-enqueues an overdue wait.
          console.error(`[FlowRunner] timed wake enqueue failed (run=${s.runId})`, err);
          captureFlow(err, 'flows.runSlice.enqueueTimedWake', { orgId: s.run.orgId, flowId: s.run.flowId, runId: s.runId });
        }
      }
      return STOP;
    }
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled step outcome ${JSON.stringify(exhaustive)}`);
    }
  }
}
