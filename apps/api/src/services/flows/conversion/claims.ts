/**
 * Tool Catalog W06 (#5221) Task B2 — occurrence claims: the cross-engine
 * exactly-once contract of plan Decision 6.
 *
 * `automation_occurrence_claims` is automation-wide (independent of engine and
 * generation) with a unique `(automation_id, occurrence_key)`. Each engine
 * inserts its claim IN THE SAME TRANSACTION as its run admission:
 *
 *  - legacy: `createAutomationRunRecord`'s `onCreated(tx, run)` hook, after the
 *    `automation_runs` insert (the claim names that run: `legacy_run_id` is
 *    NOT NULL for a legacy claim, `automation_occurrence_claims_run_chk`);
 *  - flow: `createFlowRun`, after the `flow_runs` insert and the charge.
 *
 * A conflict rolls the caller's admission back and reports who won.
 *
 * Preference (who ATTEMPTS) is separate from claims (who WINS):
 * `legacyPrefers` / `flowPrefers` decide from the generation state the
 * attempting engine observed; claims then dedupe whatever both attempt.
 *
 * Lock order (no cycle with the conversion writers):
 *  - legacy locks the automation row (`currentConversionForAutomation`,
 *    `FOR NO KEY UPDATE`), reads the ledger without a lock, then inserts the
 *    claim. Creating a conversion (B1) takes the automation row `FOR UPDATE`,
 *    which conflicts, so a conversion appears either before the admission
 *    reads the state or after it commits.
 *    `FOR NO KEY UPDATE` rather than the plan's `FOR SHARE`: the same admission
 *    later UPDATEs the row (`run_count`), and a SHARE lock upgraded by two
 *    concurrent admissions of one automation deadlocks. NO KEY UPDATE does not
 *    block the claim insert's FK `KEY SHARE`, so the flow side never waits on it.
 *  - the flow side takes no automation lock: it reads the ledger by flow id
 *    and relies on the unique index alone.
 *
 * Everything runs on the executor the caller passes (its transaction): this
 * module opens no DB context and commits nothing.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { OCCURRENCE_KEY_RE, occurrenceKey, type FlowConversionState } from '@breeze/shared';
import { automations, flowAutomationConversions, flows } from '../../../db/schema';
import { captureMessage } from '../../sentry';
import type { DbExecutor } from './ledger';

export type { DbExecutor };

type AutomationRow = typeof automations.$inferSelect;
type Engine = 'legacy' | 'flow';

/** The automation's owner pair, copied verbatim (the owner guard compares both columns). */
export interface ClaimOwner {
  orgId: string | null;
  partnerId: string | null;
}

export interface ClaimExisting {
  engine: Engine;
  legacyRunId: string | null;
  flowRunId: string | null;
}

export type ClaimResult = { ok: true } | { ok: false; existing: ClaimExisting };

export interface ConversionStateView {
  id: string;
  state: FlowConversionState;
  switchAt: Date | null;
}

export interface FlowConversionView extends ConversionStateView {
  automationId: string;
  orgId: string | null;
  partnerId: string | null;
}

/** Thrown from inside an admission transaction to roll it back when the claim lost. */
export class OccurrenceClaimedError extends Error {
  constructor(readonly existing: ClaimExisting) {
    super(`occurrence already claimed by the ${existing.engine} engine`);
    this.name = 'OccurrenceClaimedError';
  }
}

// ── preference ──────────────────────────────────────────────────────────────

/**
 * Whether the legacy engine attempts an occurrence (Decision 6):
 *  - no conversion, a shadow or a reverted generation: always;
 *  - switched: a job its fan-out/scan enqueued while the row was unswitched,
 *    or an occurrence whose instant is before `switch_at`. A missing instant
 *    (or, defensively, a missing `switch_at`) prefers legacy; claims dedupe.
 */
export function legacyPrefers(
  c: { state: FlowConversionState; switchAt: Date | null } | null,
  instant: Date | null,
  enqueuedWhileUnswitched: boolean,
): boolean {
  if (!c || c.state !== 'switched') return true;
  if (enqueuedWhileUnswitched) return true;
  if (!instant || !c.switchAt) return true;
  return instant.getTime() < c.switchAt.getTime();
}

/** The flow attempts exactly while its generation is switched. */
export function flowPrefers(c: { state: FlowConversionState } | null): boolean {
  return c?.state === 'switched';
}

// ── occurrence identity ─────────────────────────────────────────────────────

const ISO_SCHEDULE_KEY_RE = /^schedule:(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/;
const COMPACT_SLOT_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/**
 * The spellings under which `automation_runs.occurrence_key` may hold an
 * occurrence admitted before claims existed. Claims always store the ISO
 * minute (`occurrenceKey.schedule`); legacy writes `schedule:<slotKey>` with
 * `formatScheduleTriggerKey`'s compact UTC `YYYYMMDDHHmm`. Same instant,
 * different text (plan deviation, lead decision (a)). Event keys are spelled
 * identically on both sides. Pinned against `formatScheduleTriggerKey` in
 * claims.test.ts.
 */
export function legacyScheduleHistoryKeys(key: string): string[] {
  if (!key.startsWith('schedule:')) return [key];
  const m = ISO_SCHEDULE_KEY_RE.exec(key);
  if (!m) throw new Error(`legacyScheduleHistoryKeys: '${key}' is not an ISO-minute schedule key`);
  return [key, `schedule:${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`];
}

/** Legacy's compact UTC slot (`YYYYMMDDHHmm`) as an instant, or null when it is not one. */
export function scheduleInstantFromSlotKey(slotKey: unknown): Date | null {
  if (typeof slotKey !== 'string') return null;
  const m = COMPACT_SLOT_RE.exec(slotKey);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi));
  // Date.UTC rolls an out-of-range field over; a real slot round-trips.
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d
      || at.getUTCHours() !== h || at.getUTCMinutes() !== mi) return null;
  return at;
}

/** `event:<id>`, or null when the id cannot be a key (not a uuid): both engines then prefer legacy. */
export function eventOccurrenceKey(eventId: unknown): string | null {
  if (typeof eventId !== 'string') return null;
  try {
    return occurrenceKey.event(eventId);
  } catch {
    return null;
  }
}

/** An event's instant (`metadata.timestamp`), or null when missing or unparseable. */
export function eventInstant(timestamp: unknown): Date | null {
  if (typeof timestamp !== 'string' || timestamp.length === 0) return null;
  const at = new Date(timestamp);
  return Number.isNaN(at.getTime()) ? null : at;
}

// ── anomaly reporting ───────────────────────────────────────────────────────

const REPORTED_MAX = 2048;
let reported = new Set<string>();

/**
 * Sentry, once per (code, engine, occurrence) per process. The occurrence is
 * never a tag (ids are not bounded); it is logged.
 */
export function reportOccurrenceAnomaly(
  code: 'flow_conversion_event_instant_missing' | 'flow_conversion_event_key_unbuildable',
  engine: Engine,
  occurrence: string,
): void {
  const id = `${code}|${engine}|${occurrence}`;
  if (reported.has(id)) return;
  if (reported.size >= REPORTED_MAX) reported = new Set();
  reported.add(id);
  const tags = { flow_site: engine === 'legacy' ? 'conversion_claims.legacy' : 'conversion_claims.flow' };
  if (code === 'flow_conversion_event_instant_missing') {
    console.warn(`[conversion claims] ${engine}: occurrence ${occurrence} has no usable instant; legacy is preferred`);
    captureMessage('converted automation event without a usable timestamp', {
      eventCode: 'flow_conversion_event_instant_missing', level: 'warning', tags,
    });
  } else {
    console.warn(`[conversion claims] ${engine}: occurrence ${occurrence} has no usable event id; legacy is preferred, no claim`);
    captureMessage('converted automation event whose id cannot be an occurrence key', {
      eventCode: 'flow_conversion_event_key_unbuildable', level: 'warning', tags,
    });
  }
}

// ── reads ───────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const rowsOf = (r: unknown): Raw[] => r as Raw[];

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function stateView(r: Raw): ConversionStateView {
  return { id: String(r.id), state: r.state as FlowConversionState, switchAt: toDate(r.switch_at) };
}

/**
 * The automation's current generation — the live one, or the newest reverted
 * one when none is live (a newer generation exists only after a revert) — or
 * null when it was never converted. Locks the automation row first
 * (`FOR NO KEY UPDATE`, see the module comment); call it inside the admission
 * transaction, immediately before the run insert.
 *
 * Plan name: `liveConversionForAutomation` (FOR SHARE). Renamed because it
 * also returns a reverted generation: legacy claims for a row with a
 * conversion in ANY state.
 */
export async function currentConversionForAutomation(tx: DbExecutor, automationId: string): Promise<ConversionStateView | null> {
  const locked = rowsOf(await tx.execute(sql`
    SELECT c.id, c.state, c.switch_at
    FROM automations a
    LEFT JOIN LATERAL (
      SELECT fac.id, fac.state, fac.switch_at
      FROM flow_automation_conversions fac
      WHERE fac.automation_id = a.id
      ORDER BY fac.created_at DESC, fac.id DESC
      LIMIT 1
    ) c ON true
    WHERE a.id = ${automationId}
    FOR NO KEY UPDATE OF a`));
  if (locked.length > 0) return locked[0]!.id ? stateView(locked[0]!) : null;
  // The row is not lockable in this context (RLS UPDATE policy): read the
  // ledger without the lock rather than treat a converted row as unconverted.
  const plain = rowsOf(await tx.execute(sql`
    SELECT fac.id, fac.state, fac.switch_at
    FROM flow_automation_conversions fac
    WHERE fac.automation_id = ${automationId}
    ORDER BY fac.created_at DESC, fac.id DESC
    LIMIT 1`));
  return plain[0] ? stateView(plain[0]) : null;
}

/** The generation a flow was converted from (one per flow), or null for a plain flow. */
export async function conversionForFlow(tx: DbExecutor, flowId: string): Promise<FlowConversionView | null> {
  const [r] = rowsOf(await tx.execute(sql`
    SELECT fac.id, fac.state, fac.switch_at, fac.automation_id, fac.org_id, fac.partner_id
    FROM flow_automation_conversions fac
    WHERE fac.flow_id = ${flowId}
    LIMIT 1`));
  if (!r) return null;
  return {
    ...stateView(r),
    automationId: String(r.automation_id),
    orgId: (r.org_id as string | null) ?? null,
    partnerId: (r.partner_id as string | null) ?? null,
  };
}

/**
 * A row the switch retired (`enabled = false`, `converted_to_flow`) whose
 * generation is switched. The legacy reads OR this into their ordinary
 * predicate (Decision 6: legacy keeps loading switched rows). A row disabled
 * any other way never matches. `converted_to_flow_id IS NOT NULL` is the
 * predicate of the partial index `automations_converted_to_flow_idx`.
 */
export function switchedConvertedAutomationCondition(): SQL {
  return and(
    isNotNull(automations.convertedToFlowId),
    eq(automations.enabled, false),
    eq(automations.retiredReason, 'converted_to_flow'),
    sql`EXISTS (SELECT 1 FROM flow_automation_conversions fac
      WHERE fac.automation_id = ${automations.id} AND fac.state = 'switched')`,
  )!;
}

/** What the event fan-out's shadow comparison needs of a shadow row (#5221 B4): the draft's trigger and digest. */
export interface ShadowFanoutView {
  documentDigest: string;
  flowTrigger: unknown;
}

export interface ConvertedAutomationRow {
  automation: AutomationRow;
  conversion: ConversionStateView;
  /** Present exactly for a `shadow` generation (only with `withShadow`). */
  shadow?: ShadowFanoutView;
}

/**
 * The switched rows for the scan and the event fan-out, with the state the
 * enqueuer reads. With `withShadow` (the event fan-out, #5221 B4) the SAME
 * statement also returns each enabled, unretired row's `shadow` generation
 * with its draft's trigger, so the shadow hook needs no query of its own and
 * a row without a conversion costs nothing more.
 */
export async function loadSwitchedConvertedAutomations(
  tx: DbExecutor,
  where?: SQL,
  opts: { withShadow?: boolean } = {},
): Promise<ConvertedAutomationRow[]> {
  const switchedRow = and(
    eq(flowAutomationConversions.state, 'switched'),
    isNotNull(automations.convertedToFlowId),
    eq(automations.enabled, false),
    eq(automations.retiredReason, 'converted_to_flow'),
  );
  if (!opts.withShadow) {
    const rows = await tx
      .select({
        automation: automations,
        id: flowAutomationConversions.id,
        state: flowAutomationConversions.state,
        switchAt: flowAutomationConversions.switchAt,
      })
      .from(automations)
      .innerJoin(flowAutomationConversions, and(
        eq(flowAutomationConversions.automationId, automations.id),
        eq(flowAutomationConversions.state, 'switched'),
      ))
      .where(and(switchedRow, where));
    return rows.map((r) => ({ automation: r.automation, conversion: { id: r.id, state: r.state, switchAt: r.switchAt } }));
  }
  const rows = await tx
    .select({
      automation: automations,
      id: flowAutomationConversions.id,
      state: flowAutomationConversions.state,
      switchAt: flowAutomationConversions.switchAt,
      documentDigest: flowAutomationConversions.documentDigest,
      flowTrigger: sql<unknown>`CASE WHEN ${flowAutomationConversions.state} = 'shadow' THEN ${flows.definition}->'trigger' END`,
    })
    .from(automations)
    .innerJoin(flowAutomationConversions, and(
      eq(flowAutomationConversions.automationId, automations.id),
      inArray(flowAutomationConversions.state, ['switched', 'shadow']),
    ))
    .innerJoin(flows, eq(flows.id, flowAutomationConversions.flowId))
    .where(and(
      or(
        switchedRow,
        and(eq(flowAutomationConversions.state, 'shadow'), eq(automations.enabled, true), isNull(automations.retiredAt)),
      ),
      where,
    ));
  return rows.map((r) => ({
    automation: r.automation,
    conversion: { id: r.id, state: r.state, switchAt: r.switchAt },
    ...(r.state === 'shadow' ? { shadow: { documentDigest: r.documentDigest, flowTrigger: r.flowTrigger } } : {}),
  }));
}

// ── the schedule tick's parent claim (#5221 B5) ────────────────────────────

/**
 * The PARENT claim of a converted flow's schedule occurrence: written by the
 * flow schedule tick before its per-org fan-out, engine `flow` with neither
 * run id (children never claim; every other flow claim names its run). It IS
 * that occurrence's admission (Decision 7): after a revert the per-org
 * children are execution and still run.
 */
const parentScheduleClaimOf = (c: { id: string; automationId: string }) => sql`
  automation_id = ${c.automationId}
  AND conversion_id = ${c.id}
  AND engine = 'flow'
  AND flow_run_id IS NULL
  AND legacy_run_id IS NULL`;

/** Whether this generation holds the parent claim of the schedule occurrence `key` (`schedule:<UTC minute>`). */
export async function heldParentScheduleClaim(tx: DbExecutor, c: { id: string; automationId: string }, key: string): Promise<boolean> {
  if (!ISO_SCHEDULE_KEY_RE.test(key)) return false;
  const [r] = rowsOf(await tx.execute(sql`
    SELECT 1 AS held FROM automation_occurrence_claims
    WHERE ${parentScheduleClaimOf(c)} AND occurrence_key = ${key}
    LIMIT 1`));
  return !!r;
}

/** This generation's newest parent schedule claim for an occurrence at or after `since`, or null. */
export async function newestParentScheduleClaim(
  tx: DbExecutor,
  c: { id: string; automationId: string },
  since: Date,
): Promise<{ key: string; at: Date } | null> {
  const [r] = rowsOf(await tx.execute(sql`
    SELECT occurrence_key, occurrence_at FROM automation_occurrence_claims
    WHERE ${parentScheduleClaimOf(c)}
      AND occurrence_key LIKE 'schedule:%'
      AND occurrence_at >= ${since.toISOString()}::timestamptz
    ORDER BY occurrence_at DESC
    LIMIT 1`));
  const at = r ? toDate(r.occurrence_at) : null;
  if (!r || !at) return null;
  return { key: String(r.occurrence_key), at };
}

// ── the claim ───────────────────────────────────────────────────────────────

/** Rolls the alias savepoint back when any key conflicted. */
class AliasConflict extends Error {}

export interface ClaimOccurrenceInput {
  automationId: string;
  owner: ClaimOwner;
  keys: readonly string[];
  engine: Engine;
  conversionId: string | null;
  legacyRunId?: string;
  flowRunId?: string;
  occurrenceAt: Date | null;
}

/**
 * Inside the admission transaction. All keys or none: the aliases of one
 * occurrence (a webhook's `webhook:sig:` and `webhook:dlv:`) go in under one
 * savepoint, and a conflict on any key rolls the others back.
 *
 * The flow engine first reads `automation_runs (automation_id, occurrence_key)`
 * for history admitted before claims existed (both slot spellings, see
 * `legacyScheduleHistoryKeys`). The legacy engine skips that read: its own
 * runs are already unique per (automation, occurrence key) in automation_runs,
 * and the run it just inserted carries the key.
 *
 * `{ ok: false }` names the winner; the CALLER must then roll back its own
 * admission (the legacy hook and createFlowRun throw `OccurrenceClaimedError`).
 */
export async function claimOccurrence(tx: DbExecutor, i: ClaimOccurrenceInput): Promise<ClaimResult> {
  const keys = [...new Set(i.keys)];
  if (keys.length === 0) throw new Error('claimOccurrence: no occurrence key');
  for (const key of keys) {
    if (!OCCURRENCE_KEY_RE.test(key)) throw new Error(`claimOccurrence: '${key}' is not an occurrence key`);
  }
  if (i.engine === 'legacy' && !i.legacyRunId) throw new Error('claimOccurrence: a legacy claim needs its legacyRunId');
  if (i.engine === 'flow' && i.legacyRunId) throw new Error('claimOccurrence: a flow claim never names a legacy run');

  if (i.engine === 'flow') {
    const history = keys.filter((k) => k.startsWith('event:') || k.startsWith('schedule:')).flatMap(legacyScheduleHistoryKeys);
    if (history.length > 0) {
      const [prior] = rowsOf(await tx.execute(sql`
        SELECT id FROM automation_runs
        WHERE automation_id = ${i.automationId}
          AND occurrence_key IN (${sql.join(history.map((k) => sql`${k}`), sql`, `)})
        LIMIT 1`));
      if (prior) return { ok: false, existing: { engine: 'legacy', legacyRunId: String(prior.id), flowRunId: null } };
    }
  }

  const at = i.occurrenceAt ? i.occurrenceAt.toISOString() : null;
  const values = keys.map((key) => sql`(
    ${i.owner.orgId}::uuid, ${i.owner.partnerId}::uuid, ${i.automationId}::uuid, ${key}, ${i.engine},
    ${i.conversionId}::uuid, ${i.legacyRunId ?? null}::uuid, ${i.flowRunId ?? null}::uuid, ${at}::timestamptz)`);
  try {
    await tx.transaction(async (sp) => {
      const inserted = rowsOf(await sp.execute(sql`
        INSERT INTO automation_occurrence_claims
          (org_id, partner_id, automation_id, occurrence_key, engine, conversion_id, legacy_run_id, flow_run_id, occurrence_at)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (automation_id, occurrence_key) DO NOTHING
        RETURNING occurrence_key`));
      if (inserted.length !== keys.length) throw new AliasConflict();
    });
    return { ok: true };
  } catch (err) {
    if (!(err instanceof AliasConflict)) throw err;
  }

  const [winner] = rowsOf(await tx.execute(sql`
    SELECT engine, legacy_run_id, flow_run_id
    FROM automation_occurrence_claims
    WHERE automation_id = ${i.automationId}
      AND occurrence_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
    ORDER BY claimed_at, id
    LIMIT 1`));
  if (!winner) throw new Error('claimOccurrence: the claim conflicted but no claim is visible');
  return {
    ok: false,
    existing: {
      engine: winner.engine as Engine,
      legacyRunId: (winner.legacy_run_id as string | null) ?? null,
      flowRunId: (winner.flow_run_id as string | null) ?? null,
    },
  };
}
