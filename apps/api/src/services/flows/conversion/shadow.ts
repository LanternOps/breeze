/**
 * Tool Catalog W06 (#5221) Task B4 — the shadow hooks' service side (plan
 * Decision 3). While a conversion is `shadow`, the LEGACY engine keeps running
 * the Job; these hooks compare each occurrence with what the converted draft
 * would have done and count the result. Shadow never executes anything and
 * creates no flow runs: it reads the draft, resolves device sets read-only and
 * writes three counter columns of the ledger row.
 *
 *  - the event fan-out compares the trigger in BOTH directions for every event
 *    of the trigger's type (`shadowTriggerVerdict`); a mismatch is recorded
 *    there, because a flow-only match never reaches a legacy run;
 *  - after a legacy run is created, `observeShadowRun` compares the target
 *    set, the fleet cap and the steps that would park under the switch
 *    defaults (no pre-approval ticked) — `evaluateShadow` (PR A) decides.
 *
 * Both are best effort: every failure goes to Sentry and nothing is ever
 * thrown into the legacy path. The counter write (`recordShadow`) is ONE
 * conditional UPDATE in its own system transaction — never a read-modify-write
 * — so concurrent observations each land exactly once; it matches nothing once
 * the generation left `shadow`, or (with a digest) once the draft it judged was
 * replaced (a reset zeroes the counters and moves `document_digest`).
 *
 * Scope note: a partner-wide Job's legacy run spans every owner org in one
 * run, while its flow runs once per org; the two device sets are not
 * comparable, so for a partner-wide Job the target-set and over-cap
 * comparisons are skipped (the converter already raises
 * `partner_wide_org_set_differs`). The trigger and would-park comparisons
 * still run.
 */
import { sql } from 'drizzle-orm';
import {
  flowDocumentV1Schema,
  type FlowDocumentV1,
  type ShadowDivergenceKind,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { isCronDue } from '../../cronDue';
import { captureException } from '../../sentry';
import { resolveDeviceIdsInRunOrg, resolveTargetsOnce, type FleetRunOrg } from '../builtins/fleetTargets';
import { eventMatchesFilter } from '../eventFilter';
import { evaluateShadow, wouldParkSteps, type ShadowVerdict } from './shadowEvaluate';

const LOG = '[conversion shadow]';
/** Bounds the stored divergence text (it is shown in the conversion panel). */
const DETAIL_MAX = 500;
/** A switch or reset holding the ledger row must never stall a legacy worker for long. */
const LOCK_TIMEOUT = sql.raw(`'5s'`);

export interface ShadowOutcome extends ShadowVerdict {
  /** The draft digest the observation judged; the write is dropped when the ledger moved on. */
  documentDigest?: string;
}

function system<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function report(err: unknown, site: 'conversion.shadow_record' | 'conversion.shadow_observe'): void {
  console.error(`${LOG} ${site} failed`, err);
  captureException(err instanceof Error ? err : new Error(String(err)), undefined, { flow_site: site }, { fingerprint: ['flow', site] });
}

/**
 * Counts one observation: `shadow_runs + 1`, and for a divergence
 * `shadow_divergences + 1` with the last divergence. One statement, so the
 * row lock serializes concurrent writers and each re-reads the committed
 * counters (READ COMMITTED re-evaluation): no increment is ever lost. True
 * when a row was updated; false when the generation is no longer `shadow`
 * (or no longer judged on this draft) — and on any failure, which is
 * reported, never thrown.
 */
export async function recordShadow(conversionId: string, outcome: ShadowOutcome): Promise<boolean> {
  try {
    const divergence = outcome.divergent && outcome.kind
      ? sql`,
        shadow_divergences = shadow_divergences + 1,
        shadow_last_divergence = jsonb_build_object(
          'kind', ${outcome.kind}::text,
          'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'detail', ${outcome.detail.slice(0, DETAIL_MAX)}::text)`
      : sql``;
    const digest = outcome.documentDigest ? sql` AND document_digest = ${outcome.documentDigest}` : sql``;
    const rows = await system(async () => {
      await db.execute(sql`SET LOCAL lock_timeout = ${LOCK_TIMEOUT}`);
      return db.execute(sql`UPDATE flow_automation_conversions
        SET shadow_runs = shadow_runs + 1${divergence},
          shadow_last_at = now(),
          updated_at = now()
        WHERE id = ${conversionId} AND state = 'shadow'${digest}
        RETURNING id`);
    }, 'flows.conversion.recordShadow');
    return (rows as unknown as unknown[]).length > 0;
  } catch (err) {
    report(err, 'conversion.shadow_record');
    return false;
  }
}

// ── trigger (the fan-out, both directions) ─────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether the flow engine would start this flow for the event (its event trigger and strict filter). */
export function flowEventTriggerMatches(trigger: unknown, eventType: string, payload: unknown): boolean {
  if (!isRecord(trigger) || trigger.type !== 'event' || trigger.event !== eventType) return false;
  const filter = trigger.filter === undefined ? {} : trigger.filter;
  if (!isRecord(filter)) return false;
  return eventMatchesFilter(filter as Record<string, string | number | boolean | null>, payload);
}

/**
 * The fan-out's comparison for one event and one shadow row. Null when both
 * engines agree: agreement on "no" says nothing, and agreement on "yes" is
 * observed after the legacy run is created (with its device set). A mismatch
 * in either direction is the `trigger_mismatch` divergence.
 */
export function shadowTriggerVerdict(o: { flowTrigger: unknown; eventType: string; payload: unknown; legacyMatched: boolean }): ShadowVerdict | null {
  const flowMatched = flowEventTriggerMatches(o.flowTrigger, o.eventType, o.payload);
  if (flowMatched === o.legacyMatched) return null;
  return evaluateShadow({
    document: { version: 1, name: '', trigger: { type: 'manual' }, inputs: [], steps: [] } as unknown as FlowDocumentV1,
    legacyMatched: o.legacyMatched,
    flowMatched,
    legacyTargetIds: [],
    flowTargetIds: [],
    wouldParkStepIds: [],
  });
}

// ── after a legacy run (target set, over-cap, would-park) ──────────────────

export type ShadowRunTrigger =
  | { kind: 'schedule'; at: Date | null }
  | { kind: 'event'; eventType: string; payload: unknown };

export interface ShadowRunObservation {
  conversionId: string;
  automation: { id: string; orgId: string | null; partnerId: string | null };
  run: ShadowRunTrigger;
  /** The device set the legacy run was created with. */
  legacyTargetIds: readonly string[];
}

type Raw = Record<string, unknown>;

const FLEET_TOOLS: ReadonlySet<string> = new Set(['run_script_on_targets', 'resolve_targets']);
const TRIGGER_DEVICE = '{{trigger.device.id}}';

/**
 * The device set the draft's FIRST fleet step would resolve in the run org —
 * the step the converter seeds with the Job's selector (later fleet steps
 * chain on it) — or null when the draft has none (nothing to compare).
 */
async function flowTargetIds(document: FlowDocumentV1, run: FleetRunOrg, trigger: ShadowRunTrigger): Promise<string[] | null> {
  const step = document.steps.find((s) => FLEET_TOOLS.has(s.tool) && !s.forEach);
  if (!step) return null;
  const input = step.input as Record<string, unknown>;
  if (input.target !== undefined) {
    const r = await resolveTargetsOnce(run, { target: input.target as never });
    return r.problems.length > 0 ? [] : r.deviceIds;
  }
  if (input.conditions !== undefined) {
    const r = await resolveTargetsOnce(run, { conditions: input.conditions as never });
    return r.problems.length > 0 ? [] : r.deviceIds;
  }
  if (Array.isArray(input.deviceIds)) {
    const payload = trigger.kind === 'event' && isRecord(trigger.payload) ? trigger.payload : {};
    const ids = input.deviceIds.flatMap((id) => {
      if (id === TRIGGER_DEVICE) return typeof payload.deviceId === 'string' ? [payload.deviceId] : [];
      return typeof id === 'string' && !id.includes('{{') ? [id] : [];
    });
    return (await resolveDeviceIdsInRunOrg(run, ids)).map((d) => d.id);
  }
  return null;
}

function flowTriggerFires(document: FlowDocumentV1, trigger: ShadowRunTrigger): boolean {
  if (trigger.kind === 'event') return flowEventTriggerMatches(document.trigger, trigger.eventType, trigger.payload);
  const t = document.trigger;
  if (t.type !== 'schedule') return false;
  // No slot instant (a malformed slot): the converter proved cron parity; nothing to compare.
  return trigger.at ? isCronDue(t.cron, t.timezone, trigger.at) : true;
}

/**
 * One legacy run of a shadow row, compared with the draft. Reads the ledger
 * and the draft in system scope (one statement, the run org's partner
 * joined), resolves the draft's device set read-only in the run org, and
 * records the verdict. An event the draft's trigger does not match is left
 * alone: the fan-out already counted it as a trigger mismatch. Never throws.
 */
export async function observeShadowRun(o: ShadowRunObservation): Promise<void> {
  try {
    const [subject] = (await system(() => db.execute(sql`
      SELECT fac.document_digest, f.definition, fac.org_id, o.partner_id AS run_partner_id
      FROM flow_automation_conversions fac
      JOIN flows f ON f.id = fac.flow_id
      LEFT JOIN organizations o ON o.id = fac.org_id
      WHERE fac.id = ${o.conversionId} AND fac.state = 'shadow'`), 'flows.conversion.shadowSubject')) as unknown as Raw[];
    if (!subject) return;
    const parsed = flowDocumentV1Schema.safeParse(subject.definition);
    if (!parsed.success) {
      console.warn(`${LOG} conversion ${o.conversionId}: the draft does not parse; occurrence not observed`);
      return;
    }
    const document = parsed.data;
    const flowMatched = flowTriggerFires(document, o.run);
    if (o.run.kind === 'event' && !flowMatched) return;

    const orgId = typeof subject.org_id === 'string' ? subject.org_id : null;
    const partnerId = typeof subject.run_partner_id === 'string' ? subject.run_partner_id : null;
    let flowSet: readonly string[] = o.legacyTargetIds;
    if (flowMatched && orgId && partnerId) {
      flowSet = (await flowTargetIds(document, { orgId, partnerId }, o.run)) ?? o.legacyTargetIds;
    }
    const verdict = evaluateShadow({
      document,
      legacyMatched: true,
      flowMatched,
      legacyTargetIds: o.legacyTargetIds,
      flowTargetIds: flowSet,
      wouldParkStepIds: wouldParkSteps(
        document,
        o.run.kind === 'schedule' ? { triggerKind: 'schedule', triggeredVia: 'scheduler' } : { triggerKind: 'event', triggeredVia: 'event' },
        [],
      ),
    });
    await recordShadow(o.conversionId, { ...verdict, documentDigest: String(subject.document_digest) });
  } catch (err) {
    report(err, 'conversion.shadow_observe');
  }
}

export type { ShadowDivergenceKind };
