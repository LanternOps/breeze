// Scheduled sweeps editor (phase 2 wave P2-2, #4187 / #4189), extended in
// P2-3 (#4190) to the second schedule KIND.
//
// A schedule now declares what its occurrences produce: `sweep` (one
// sweep-profile run per org, the only thing a schedule did before P2-3) or
// `narrative` (one weekly-report run per org). The kind is chosen on CREATE
// and is immutable afterwards — the update schema is `.strict()` and admits
// no `kind` — and an org override always inherits its baseline's, never sets
// one. The two branches carry incompatible server rules, so the editor
// switches wholesale between them rather than letting a half-narrative,
// half-sweep draft exist: narrative fires on a WEEKLY LITERAL cron and
// evaluates no sweep kinds; sweep keeps the hourly floor and requires at
// least one kind.
//
// Rendered inside AiAgentForm, edit mode only, for a `triage` agent — the only
// kind the API will schedule (`agent_kind_not_triage`). Two audiences, one
// component, mirroring the Partner-Wide First playbook (CLAUDE.md):
//
//   partner-scope session  -> full CRUD over the partner's BASELINE schedules
//                             (cron, timezone, checks, enabled).
//   org-scope session      -> every baseline read-only, plus one "override for
//                             this org" control per baseline. An override
//                             carries no cadence of its own and may only
//                             TIGHTEN: it can disable the sweep or drop checks,
//                             never add one the baseline does not run. That is
//                             enforced server-side (`kinds_not_subset`); the
//                             editor simply never offers a kind outside the
//                             baseline, so the operator cannot author a request
//                             the server will refuse.
//
// Deliberately NOT a cron builder: this wave ships a validated text field. The
// validation is the SAME predicate the server applies — `isStructurallyValidCron`
// AND exactly five fields — because `isStructurallyValidCron` alone tolerates
// the optional leading seconds field for BullMQ's benefit, and the sweeper's
// occurrence evaluator is strictly five-field, so a six-field pattern would be
// accepted here and then silently never fire.
//
// Deletes use an INLINE two-step confirm, never `window.confirm`: a native
// dialog cannot be dismissed by the browser-automation harness, so an E2E run
// wedges on it.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  AI_AGENT_SCHEDULE_KINDS,
  AI_SWEEP_KINDS,
  isHourlyFloorCron,
  isStructurallyValidCron,
  isWeeklyLiteralCron,
  listIanaTimezones,
  normalizeTimezone,
  type AiAgentEffectiveScheduleDto,
  type AiAgentScheduleKind,
  type AiSweepKind,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { badgeClass } from '../aiAgents/statusBadge';
import { EmptyState } from '../shared/EmptyState';
import { handleActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';

interface Props {
  agentId: string;
  /** Schedules only attach to a partner-wide agent — an org-owned one gets the
   *  explanatory note instead of a CRUD surface it cannot use. */
  agentOwnerScope: 'partner' | 'organization';
  /** True for a partner-scope session (`useDefaultOwnerScope().isPartnerScope`),
   *  the only kind that may write a partner-wide baseline. */
  isPartnerScope: boolean;
  /** The concrete org selected in the org switcher, or null in the fleet view.
   *  Overrides are per-org, so there is nothing to override without one. */
  orgId: string | null;
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

/**
 * `ScheduleValidationCode` (apps/api/src/services/aiAgents/scheduleService.ts)
 * -> operator-facing sentence. The route answers 422 `{ error: <code> }` with
 * no `code` field, so runAction's `friendly` hook is called with the token in
 * `error`; without this map the toast reads literally "kinds_not_subset".
 * `override_exists` is the duplicate-override conflict — the UI already avoids
 * authoring one (an existing override is edited, not re-created), so this is
 * the last line of defence against a concurrent second tab.
 */
const SCHEDULE_ERROR_COPY: Record<string, ((t: (key: string) => string) => string) | undefined> = {
  invalid_cron: (t) => t('aiAgentsPage.schedules.errors.invalidCron'),
  invalid_timezone: (t) => t('aiAgentsPage.schedules.errors.invalidTimezone'),
  kinds_not_subset: (t) => t('aiAgentsPage.schedules.errors.kindsNotSubset'),
  override_exists: (t) => t('aiAgentsPage.schedules.errors.overrideExists'),
  baseline_wrong_partner: (t) => t('aiAgentsPage.schedules.errors.baselineWrongPartner'),
  baseline_is_override: (t) => t('aiAgentsPage.schedules.errors.baselineIsOverride'),
  baseline_not_partner_row: (t) => t('aiAgentsPage.schedules.errors.baselineNotPartnerRow'),
  baseline_agent_mismatch: (t) => t('aiAgentsPage.schedules.errors.baselineAgentMismatch'),
  agent_not_partner_wide: (t) => t('aiAgentsPage.schedules.errors.agentNotPartnerWide'),
  agent_kind_not_triage: (t) => t('aiAgentsPage.schedules.errors.agentKindNotTriage'),
  // P2-3's two narrative-only codes. Both are unreachable through this form
  // (it never offers a kind on a narrative draft, and blocks Save on a
  // non-weekly narrative cron), so these are the concurrent-second-tab and
  // future-API-change safety net — the same role `override_exists` plays.
  kinds_not_empty: (t) => t('aiAgentsPage.schedules.errors.kindsNotEmpty'),
  invalid_cron_for_kind: (t) => t('aiAgentsPage.schedules.errors.invalidCronForKind'),
};

/** The server's rule, restated client-side — see the module doc. */
function isFiveFieldCron(value: string): boolean {
  return isStructurallyValidCron(value) && value.trim().split(/\s+/).length === 5;
}

// ---------------------------------------------------------------------------
// Next-run preview
//
// A cron field is validated by `isStructurallyValidCron` but never EVALUATED
// anywhere on the client, so `0 3 * * 7` and `0 3 * * 0` (Sunday, twice) look
// identical to an operator and a typo'd day-of-week is invisible until the
// sweep silently fails to fire for a week. `cron-parser` is not a dependency
// of apps/web (only of apps/api, transitively through BullMQ), so this
// evaluates the same grammar `isValidCronField` accepts — comma lists of `*`,
// a value, or `a-b`, each optionally `/step`, with month and day names.
//
// TIMEZONE. The result is WALL-CLOCK TIME IN THE SCHEDULE'S OWN ZONE, and the
// label says which zone, so no instant conversion is needed: "now" is read
// into that zone's wall clock once and the search then walks a plain calendar.
// The consequence is that a DST transition is not modelled — a preview one
// hour off twice a year is the accepted cost of not shipping a tz library to
// render a hint. The scheduler, not this function, decides when a sweep runs.
// ---------------------------------------------------------------------------

const CRON_MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CRON_DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Every value one cron field matches, or null when the field does not parse. */
function expandCronField(
  field: string,
  min: number,
  max: number,
  names: readonly string[],
): Set<number> | null {
  const readValue = (token: string): number | null => {
    const named = names.indexOf(token.toLowerCase());
    // Month names are 1-based, day names 0-based — the same asymmetry
    // `isValidCronField` encodes.
    if (named >= 0) return names === CRON_MONTH_NAMES ? named + 1 : named;
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    return value >= min && value <= max ? value : null;
  };

  const values = new Set<number>();
  for (const listItem of field.split(',')) {
    if (listItem === '') return null;
    const [rangePart, stepPart, ...extra] = listItem.split('/');
    if (extra.length > 0) return null;
    if (stepPart !== undefined && !/^[1-9]\d*$/.test(stepPart)) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = min;
      to = max;
    } else {
      const bounds = (rangePart ?? '').split('-');
      if (bounds.length > 2) return null;
      const parsed = bounds.map(readValue);
      if (parsed.some((value) => value === null)) return null;
      from = parsed[0] as number;
      // A bare `5/15` means "from 5 to the end of the range, every 15" —
      // a lone value with no step is just itself.
      to = parsed.length === 2 ? (parsed[1] as number) : stepPart === undefined ? from : max;
      if (from > to) return null;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size === 0 ? null : values;
}

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseFiveFieldCron(cron: string): CronFields | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = expandCronField(parts[0]!, 0, 59, []);
  const hours = expandCronField(parts[1]!, 0, 23, []);
  const daysOfMonth = expandCronField(parts[2]!, 1, 31, []);
  const months = expandCronField(parts[3]!, 1, 12, CRON_MONTH_NAMES);
  const rawDaysOfWeek = expandCronField(parts[4]!, 0, 7, CRON_DAY_NAMES);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDaysOfWeek) return null;
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    // 7 and 0 are both Sunday.
    daysOfWeek: new Set([...rawDaysOfWeek].map((day) => (day === 7 ? 0 : day))),
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/**
 * First matching wall-clock minute strictly after `fromMs`, expressed as a
 * floating instant (the Y-M-D H:M read as if it were UTC). Null when nothing
 * matches inside a year — `0 0 30 2 *` is structurally valid and never fires.
 */
export function nextCronOccurrence(fields: CronFields, fromMs: number): Date | null {
  const cursor = new Date(Math.floor(fromMs / 60000) * 60000 + 60000);
  for (let day = 0; day < 400; day += 1) {
    if (fields.months.has(cursor.getUTCMonth() + 1)) {
      const domHit = fields.daysOfMonth.has(cursor.getUTCDate());
      const dowHit = fields.daysOfWeek.has(cursor.getUTCDay());
      // Vixie cron: when BOTH day fields are restricted the day matches if
      // EITHER does; otherwise the unrestricted one is a no-op `*`.
      const dayHit = fields.domRestricted && fields.dowRestricted ? domHit || dowHit : domHit && dowHit;
      if (dayHit) {
        const fromHour = cursor.getUTCHours();
        for (let hour = fromHour; hour < 24; hour += 1) {
          if (!fields.hours.has(hour)) continue;
          const fromMinute = hour === fromHour ? cursor.getUTCMinutes() : 0;
          for (let minute = fromMinute; minute < 60; minute += 1) {
            if (!fields.minutes.has(minute)) continue;
            return new Date(Date.UTC(
              cursor.getUTCFullYear(),
              cursor.getUTCMonth(),
              cursor.getUTCDate(),
              hour,
              minute,
            ));
          }
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }
  return null;
}

/** "Now" as a floating instant on `timezone`'s wall clock. */
function wallClockNow(timezone: string, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const year = read('year');
    if (!Number.isFinite(year)) throw new Error('unreadable parts');
    // `hour12: false` renders midnight as 24 in some ICU versions.
    return Date.UTC(year, read('month') - 1, read('day'), read('hour') % 24, read('minute'));
  } catch {
    // An unknown zone must not blank the whole row — fall back to UTC and
    // keep the label, which names the zone the schedule actually stores.
    return Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(),
    );
  }
}

type NextRun =
  | { kind: 'invalid' }
  | { kind: 'none' }
  | { kind: 'at'; at: string };

export function describeNextRun(cron: string, timezone: string, now = new Date()): NextRun {
  const fields = parseFiveFieldCron(cron);
  if (!fields) return { kind: 'invalid' };
  const occurrence = nextCronOccurrence(fields, wallClockNow(timezone, now));
  if (!occurrence) return { kind: 'none' };
  // Formatted as UTC because the value IS a floating wall-clock instant; the
  // zone it belongs to is named beside it, never inferred from the viewer's.
  return {
    kind: 'at',
    at: new Intl.DateTimeFormat(undefined, {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(occurrence),
  };
}

/**
 * Phase 2 wave P2-3 — the create defaults per schedule kind. A narrative
 * schedule must fire exactly once a week (`isWeeklyLiteralCron`), so its
 * default cron is a weekly literal; a sweep schedule may fire as often as
 * hourly and keeps the pre-P2-3 nightly default.
 */
const CRON_DEFAULTS: Readonly<Record<AiAgentScheduleKind, string>> = Object.freeze({
  sweep: '0 3 * * *',
  narrative: '0 7 * * 1',
});

/**
 * A row's kind, tolerant of a body written by a pre-P2-3 API build (which
 * emits no `kind` at all). Anything that is not the literal `narrative` is
 * the sweep behaviour every schedule had before this wave — never an
 * `undefined` that would render `aiAgentsPage.schedules.kinds.undefined` as
 * a visible key path.
 */
function kindOf(schedule: Pick<AiAgentEffectiveScheduleDto, 'kind'>): AiAgentScheduleKind {
  return schedule.kind === 'narrative' ? 'narrative' : 'sweep';
}

/** Canonical AI_SWEEP_KINDS order, so a toggled list never depends on click
 *  sequence — the wire body is then stable and assertable. */
function orderKinds(kinds: readonly AiSweepKind[]): AiSweepKind[] {
  return AI_SWEEP_KINDS.filter((kind) => kinds.includes(kind));
}

function toggleKind(kinds: readonly AiSweepKind[], kind: AiSweepKind): AiSweepKind[] {
  return orderKinds(kinds.includes(kind) ? kinds.filter((entry) => entry !== kind) : [...kinds, kind]);
}

/**
 * The fields this component actually dereferences while rendering. Anything
 * missing one of them is not a schedule row, whatever the endpoint answered.
 */
function isScheduleRow(value: unknown): value is AiAgentEffectiveScheduleDto {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Partial<AiAgentEffectiveScheduleDto>;
  return typeof row.id === 'string'
    && typeof row.cron === 'string'
    && typeof row.timezone === 'string'
    && typeof row.enabled === 'boolean'
    && Array.isArray(row.sweepKinds)
    && !!row.effective
    && Array.isArray(row.effective.sweepKinds);
}

/** The browser's own zone as the create default — never a hardcoded 'UTC',
 *  which is the #1318 mistake this helper's `normalizeTimezone` exists to end. */
function defaultTimezone(): string {
  try {
    return normalizeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return 'UTC';
  }
}

type BaselineDraft = {
  mode: 'baseline';
  /** null = creating. */
  id: string | null;
  /** Which run profile this schedule's occurrences produce. Chosen on CREATE
   *  only — the API's update schema is `.strict()` and admits no `kind`, so a
   *  saved schedule's kind is immutable by construction. */
  kind: AiAgentScheduleKind;
  cron: string;
  timezone: string;
  sweepKinds: AiSweepKind[];
  enabled: boolean;
};

type OverrideDraft = {
  mode: 'override';
  /** null = creating this org's first override of `baselineId`. */
  id: string | null;
  baselineId: string;
  /** The BASELINE's kind, inherited and never editable here — an override
   *  that could flip a sweep baseline into a narrative one for a single org
   *  would produce a run profile the partner never configured. */
  kind: AiAgentScheduleKind;
  /** The baseline's kinds — the ONLY kinds an override may name. */
  allowedKinds: AiSweepKind[];
  sweepKinds: AiSweepKind[];
  enabled: boolean;
};

type Draft = BaselineDraft | OverrideDraft;

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

export default function AiAgentSchedulesSection({
  agentId,
  agentOwnerScope,
  isPartnerScope,
  orgId,
}: Props) {
  const { t } = useTranslation('settings');
  const schedulable = agentOwnerScope === 'partner';
  const canManageBaselines = schedulable && isPartnerScope;
  const canOverride = schedulable && orgId !== null;

  const [schedules, setSchedules] = useState<AiAgentEffectiveScheduleDto[]>([]);
  const [loading, setLoading] = useState(schedulable);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const allOrgsHintId = useId();

  const load = useCallback(async () => {
    if (!schedulable) return;
    setLoading(true);
    setFailed(false);
    try {
      // fetchWithAuth appends the selected orgId, which is exactly what the
      // route wants: with one, it merges each baseline with that org's
      // override; without one (fleet view) it returns the bare baselines.
      const response = await fetchWithAuth(`/ai/agents/schedules?agentId=${encodeURIComponent(agentId)}`);
      if (!response.ok) throw new Error(`GET /ai/agents/schedules ${response.status}`);
      const body = (await response.json()) as { data?: unknown };
      // A body we cannot read is an ERROR, not "no schedules": rendering it as
      // an empty list would invite the operator to create a duplicate baseline
      // whose POST then fails on the (agent_id, partner) uniqueness.
      // Row-shaped, not just array-shaped. `Array.isArray` alone let a body of
      // the WRONG array through — a gateway page, or a caller whose route
      // matcher swallowed this path and answered with the agents list — and the
      // first `schedule.sweepKinds.map` then threw inside render, taking the
      // whole agent form down with it. A row we cannot read is a load failure.
      if (!Array.isArray(body.data) || !body.data.every(isScheduleRow)) {
        throw new Error('GET /ai/agents/schedules: malformed body');
      }
      setSchedules(body.data);
    } catch (err) {
      console.error('[AiAgentSchedulesSection] could not load schedules', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
    // `orgId` is a dependency even though it never appears in the URL above:
    // fetchWithAuth reads it from the org store to build the `?orgId=`
    // query itself, but THIS callback still has to be re-created (and thus
    // re-run by the effect below) when the org switcher changes, or the
    // section keeps showing the previous org's merged overrides until some
    // unrelated prop forces a reload.
  }, [agentId, orgId, schedulable]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only the baseline editor has a timezone field. Memoised on the VALUE, not
  // on the draft, so typing in the cron box does not rebuild 418 options.
  const draftTimezone = draft?.mode === 'baseline' ? draft.timezone : null;
  const zones = useMemo(() => {
    const all = listIanaTimezones();
    // A stored zone outside the Intl list (legacy row, or a value the API
    // accepted from another surface) must still render, or saving an unrelated
    // field would silently rewrite it to the first option.
    return draftTimezone && !all.includes(draftTimezone) ? [draftTimezone, ...all] : all;
  }, [draftTimezone]);

  const openCreate = () => {
    setConfirmDelete(false);
    setDraft({
      mode: 'baseline',
      id: null,
      kind: 'sweep',
      cron: CRON_DEFAULTS.sweep,
      timezone: defaultTimezone(),
      // Every check by default: a sweep is read-only reconnaissance in this
      // wave, and `sweepKinds` is `.min(1)` server-side, so an empty default
      // would ship a form whose Save is disabled on open.
      sweepKinds: [...AI_SWEEP_KINDS],
      enabled: true,
    });
  };

  /**
   * Switching the create form's kind rewrites the whole cadence/kinds pair,
   * not just the kind: the two branches have incompatible server rules
   * (narrative = weekly literal + NO sweep kinds; sweep = hourly floor + at
   * least one). Carrying either field across would leave the form in a state
   * whose Save the server refuses — or, worse, silently valid but wrong.
   */
  const setCreateKind = (drafted: BaselineDraft, kind: AiAgentScheduleKind) => {
    setDraft({
      ...drafted,
      kind,
      cron: CRON_DEFAULTS[kind],
      sweepKinds: kind === 'narrative' ? [] : [...AI_SWEEP_KINDS],
    });
  };

  const openBaseline = (schedule: AiAgentEffectiveScheduleDto) => {
    setConfirmDelete(false);
    setDraft({
      mode: 'baseline',
      id: schedule.id,
      kind: kindOf(schedule),
      cron: schedule.cron,
      timezone: schedule.timezone,
      sweepKinds: orderKinds(schedule.sweepKinds),
      enabled: schedule.enabled,
    });
  };

  const openOverride = (schedule: AiAgentEffectiveScheduleDto) => {
    setConfirmDelete(false);
    setDraft({
      mode: 'override',
      id: schedule.override?.id ?? null,
      baselineId: schedule.id,
      kind: kindOf(schedule),
      allowedKinds: orderKinds(schedule.sweepKinds),
      // Seeded from the STORED override when there is one, so opening the
      // editor never silently re-widens a tightened org back to the baseline.
      sweepKinds: orderKinds(schedule.override?.sweepKinds ?? schedule.sweepKinds),
      enabled: schedule.override?.enabled ?? true,
    });
  };

  // A SWEEP baseline must ALSO clear the server's hourly floor
  // (`isHourlyFloorCron` — see the module doc), and a narrative baseline must
  // ALSO be a weekly literal (`isWeeklyLiteralCron`) — both the same
  // predicates the server applies, restated rather than approximated, so a
  // cron this form accepts is never one the API then refuses.
  const cronValid = draft?.mode !== 'baseline'
    ? true
    : isFiveFieldCron(draft.cron)
      && (draft.kind === 'narrative' ? isWeeklyLiteralCron(draft.cron) : isHourlyFloorCron(draft.cron));
  // `.min(1)` on a SWEEP baseline (a sweep baseline that sweeps nothing is
  // pointless); a narrative baseline evaluates no kinds at all, and an
  // override's `[]` is meaningful — "run no check for this org".
  const kindsValid = draft?.mode === 'baseline' && draft.kind === 'sweep'
    ? draft.sweepKinds.length > 0
    : true;

  const save = useCallback(async () => {
    if (!draft || saving || !cronValid || !kindsValid) return;
    // An override is per-org; without a selected org there is no owner to
    // create it under and the server would reject the body outright.
    if (draft.mode === 'override' && draft.id === null && !orgId) return;

    // A NARRATIVE schedule evaluates no sweep kinds, and the create schema
    // refuses a non-empty list on that branch (`kinds_not_empty`). Omitting
    // the key entirely — rather than sending `[]` — is what the schema's
    // "omitted or empty" wording means, and keeps the wire body honest about
    // the fact that a narrative schedule has no checks to select.
    const narrative = draft.kind === 'narrative';

    const payload: Record<string, unknown> =
      draft.mode === 'baseline'
        ? draft.id === null
          ? {
              ownerScope: 'partner',
              ...(narrative ? { kind: 'narrative' } : {}),
              agentId,
              cron: draft.cron.trim(),
              timezone: draft.timezone,
              ...(narrative ? {} : { sweepKinds: draft.sweepKinds }),
              enabled: draft.enabled,
            }
          : {
              cron: draft.cron.trim(),
              timezone: draft.timezone,
              ...(narrative ? {} : { sweepKinds: draft.sweepKinds }),
              enabled: draft.enabled,
            }
        : draft.id === null
          ? {
              ownerScope: 'organization',
              orgId,
              baselineScheduleId: draft.baselineId,
              enabled: draft.enabled,
              // Required on this branch even for a narrative baseline, where
              // the only admissible value is the empty list.
              sweepKinds: narrative ? [] : draft.sweepKinds,
            }
          : // `updateAiAgentScheduleSchema` is `.strict()` and admits neither
            // ownerScope nor baselineScheduleId — both are immutable.
            {
              enabled: draft.enabled,
              ...(narrative ? {} : { sweepKinds: draft.sweepKinds }),
            };

    const path = draft.id === null ? '/ai/agents/schedules' : `/ai/agents/schedules/${draft.id}`;
    const method = draft.id === null ? 'POST' : 'PATCH';

    setSaving(true);
    let saved = false;
    try {
      await runAction({
        // Inline thunk: the no-silent-mutations guard is a lexical AST check,
        // so a hoisted request function reads as an unwrapped mutation (#2429).
        request: () => fetchWithAuth(path, { method, body: JSON.stringify(payload) }),
        successMessage: t('aiAgentsPage.schedules.toasts.saved'),
        errorFallback: t('aiAgentsPage.schedules.toasts.saveFailed'),
        friendly: (code) => SCHEDULE_ERROR_COPY[code]?.(t),
        onUnauthorized: UNAUTHORIZED,
      });
      saved = true;
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.schedules.toasts.saveFailed'));
    } finally {
      setSaving(false);
    }
    if (saved) {
      setDraft(null);
      await load();
    }
  }, [agentId, cronValid, draft, kindsValid, load, orgId, saving, t]);

  const remove = useCallback(async () => {
    if (!draft || draft.id === null || saving) return;
    // Inline two-step, never window.confirm — see the module doc.
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    const id = draft.id;
    setSaving(true);
    let deleted = false;
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/agents/schedules/${id}`, { method: 'DELETE' }),
        successMessage: t('aiAgentsPage.schedules.toasts.deleted'),
        errorFallback: t('aiAgentsPage.schedules.toasts.deleteFailed'),
        friendly: (code) => SCHEDULE_ERROR_COPY[code]?.(t),
        onUnauthorized: UNAUTHORIZED,
      });
      deleted = true;
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.schedules.toasts.deleteFailed'));
    } finally {
      setSaving(false);
    }
    if (deleted) {
      setDraft(null);
      await load();
    }
  }, [confirmDelete, draft, load, saving, t]);

  const kindLabel = (kind: AiSweepKind) =>
    t(/* i18n-dynamic */ `aiAgentsPage.schedules.kindLabels.${kind}`);

  // Literal keys, not a dynamic `t()` on the token: the closed two-member
  // union is worth spelling out so the keyUsage guard verifies both labels
  // statically (the same reason RunsListPage's statusLabel is a switch).
  const scheduleKindLabel = (kind: AiAgentScheduleKind) =>
    kind === 'narrative'
      ? t('aiAgentsPage.schedules.kinds.narrative')
      : t('aiAgentsPage.schedules.kinds.sweep');

  const kindsSentence = (kinds: readonly AiSweepKind[]) =>
    kinds.length === 0
      ? t('aiAgentsPage.schedules.noKinds')
      : kinds.map(kindLabel).join(', ');

  /**
   * "Next run" beside the raw cron. Without it the only feedback a five-field
   * expression gives is structural validity, so a wrong day-of-week reads as
   * a working schedule until it fails to fire.
   */
  const nextRunLine = (cron: string, timezone: string, testId: string) => {
    const next = describeNextRun(cron, timezone);
    if (next.kind === 'invalid') {
      return (
        <span className="block text-xs text-destructive" data-testid={`${testId}-invalid`}>
          {t('aiAgentsPage.schedules.nextRunInvalid')}
        </span>
      );
    }
    if (next.kind === 'none') {
      return (
        <span className="block text-xs text-muted-foreground" data-testid={`${testId}-none`}>
          {t('aiAgentsPage.schedules.nextRunNone')}
        </span>
      );
    }
    return (
      <span className="block text-xs text-muted-foreground" data-testid={testId}>
        {t('aiAgentsPage.schedules.nextRun', { at: next.at, timezone })}
      </span>
    );
  };

  const editor = (drafted: Draft) => (
    <div className="mt-3 space-y-3 rounded-md border bg-background p-3" data-testid="ai-agent-schedule-editor">
      {/* CREATE only. `kind` is immutable once saved (the update schema is
          `.strict()` and admits none), so offering the control on an edit
          would present a choice the API would reject. */}
      {drafted.mode === 'baseline' && drafted.id === null && (
        <label className="space-y-1 text-sm">
          <span className="font-medium">{t('aiAgentsPage.schedules.kind')}</span>
          <select
            className={inputCls}
            value={drafted.kind}
            onChange={(e) => setCreateKind(drafted, e.target.value as AiAgentScheduleKind)}
            data-testid="ai-agent-schedule-kind"
          >
            {AI_AGENT_SCHEDULE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {scheduleKindLabel(kind)}
              </option>
            ))}
          </select>
        </label>
      )}

      {drafted.mode === 'baseline' ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium">{t('aiAgentsPage.schedules.cron')}</span>
            <input
              type="text"
              className={`${inputCls} font-mono`}
              value={drafted.cron}
              onChange={(e) => setDraft({ ...drafted, cron: e.target.value })}
              data-testid="ai-agent-schedule-cron"
            />
            <span
              className="block text-xs text-muted-foreground"
              data-testid={drafted.kind === 'narrative' ? 'ai-agent-schedule-weekly-hint' : 'ai-agent-schedule-cron-hint'}
            >
              {drafted.kind === 'narrative'
                ? t('aiAgentsPage.schedules.weeklyOnlyHint')
                : t('aiAgentsPage.schedules.cronHint')}
            </span>
            {!cronValid && (
              <span className="block text-xs text-destructive" data-testid="ai-agent-schedule-cron-invalid">
                {t('aiAgentsPage.schedules.cronInvalid')}
              </span>
            )}
            {/* Only while the cron actually validates — otherwise this and
                the cronInvalid banner above say the same "this is broken"
                thing twice, once as a generic banner and once as the
                preview's own "Invalid schedule" state. */}
            {cronValid && nextRunLine(drafted.cron, drafted.timezone, 'ai-agent-schedule-editor-next-run')}
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">{t('aiAgentsPage.schedules.timezone')}</span>
            <select
              className={inputCls}
              value={drafted.timezone}
              onChange={(e) => setDraft({ ...drafted, timezone: e.target.value })}
              data-testid="ai-agent-schedule-timezone"
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('aiAgentsPage.schedules.overrideHint')}</p>
      )}

      {/* A narrative schedule evaluates NO sweep kinds — neither as a
          baseline (`kinds_not_empty`) nor through an org override, which
          inherits the baseline's kind. The whole block is absent rather than
          rendered empty, so an override of a narrative baseline offers
          exactly one control: the enabled toggle. */}
      {drafted.kind === 'sweep' && (
        <div className="space-y-1" data-testid="ai-agent-schedule-kinds">
          <span className="text-sm font-medium">{t('aiAgentsPage.schedules.kindsLabel')}</span>
          <div className="flex flex-wrap gap-3">
            {(drafted.mode === 'baseline' ? [...AI_SWEEP_KINDS] : drafted.allowedKinds).map((kind) => (
              <label key={kind} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={drafted.sweepKinds.includes(kind)}
                  onChange={() => setDraft({ ...drafted, sweepKinds: toggleKind(drafted.sweepKinds, kind) })}
                  data-testid={`ai-agent-schedule-kind-${kind}`}
                />
                {kindLabel(kind)}
              </label>
            ))}
          </div>
          {!kindsValid && (
            <p className="text-xs text-destructive" data-testid="ai-agent-schedule-kinds-invalid">
              {t('aiAgentsPage.schedules.kindsRequired')}
            </p>
          )}
          {drafted.mode === 'override' && (
            <p className="text-xs text-muted-foreground">{t('aiAgentsPage.schedules.tightenOnly')}</p>
          )}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={drafted.enabled}
          onChange={() => setDraft({ ...drafted, enabled: !drafted.enabled })}
          data-testid="ai-agent-schedule-enabled"
        />
        {t('aiAgentsPage.schedules.enabled')}
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !cronValid || !kindsValid}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
          data-testid="ai-agent-schedule-save"
        >
          {t('aiAgentsPage.schedules.save')}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirmDelete(false);
            setDraft(null);
          }}
          className="rounded-md border px-3 py-1.5 text-sm font-medium"
          data-testid="ai-agent-schedule-cancel"
        >
          {t('aiAgentsPage.schedules.cancel')}
        </button>
        {drafted.id !== null && (
          <button
            type="button"
            onClick={() => void remove()}
            className="ml-auto rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive"
            data-testid="ai-agent-schedule-delete"
          >
            {confirmDelete
              ? t('aiAgentsPage.schedules.confirmDelete')
              : drafted.mode === 'override'
                ? t('aiAgentsPage.schedules.deleteOverride')
                : t('aiAgentsPage.schedules.delete')}
          </button>
        )}
      </div>
    </div>
  );

  const editingThis = (schedule: AiAgentEffectiveScheduleDto): Draft | null => {
    if (!draft) return null;
    if (draft.mode === 'baseline') return draft.id === schedule.id ? draft : null;
    return draft.baselineId === schedule.id ? draft : null;
  };

  return (
    <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2" data-testid="ai-agent-schedules">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {t('aiAgentsPage.schedules.title')}
      </legend>
      <p className="text-xs text-muted-foreground">{t('aiAgentsPage.schedules.description')}</p>
      <span id={allOrgsHintId} className="sr-only">{t('aiAgentsPage.allOrgsHint')}</span>

      {!schedulable ? (
        <p className="text-sm text-muted-foreground" data-testid="ai-agent-schedules-partner-only">
          {t('aiAgentsPage.schedules.partnerOnly')}
        </p>
      ) : (
        <>
          {failed && (
            <p className="text-sm text-destructive" data-testid="ai-agent-schedules-failed">
              {t('aiAgentsPage.schedules.loadFailed')}
            </p>
          )}
          {loading && !failed && (
            <p className="text-sm text-muted-foreground" data-testid="ai-agent-schedules-loading">
              {t('aiAgentsPage.schedules.loading')}
            </p>
          )}
          {!loading && !failed && schedules.length === 0 && (
            <EmptyState
              size="sm"
              headingLevel={4}
              testId="ai-agent-schedules-empty"
              title={t('aiAgentsPage.schedules.empty')}
            />
          )}

          {schedules.length > 0 && (
            <ul className="divide-y rounded-md border" data-testid="ai-agent-schedules-list">
              {schedules.map((schedule) => {
                const drafted = editingThis(schedule);
                return (
                  <li key={schedule.id} className="p-3" data-testid={`ai-agent-schedule-${schedule.id}`}>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span
                        className={badgeClass('info', { size: 'sm' })}
                        data-testid={`ai-agent-schedule-kind-badge-${schedule.id}`}
                      >
                        {scheduleKindLabel(kindOf(schedule))}
                      </span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{schedule.cron}</code>
                      <span className="text-muted-foreground">{schedule.timezone}</span>
                      {/* `title=` alone is invisible to touch and keyboard, so
                          the explanation is a real described-by node. */}
                      <span
                        className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary"
                        aria-describedby={allOrgsHintId}
                      >
                        {t('aiAgentsPage.allOrgs')}
                      </span>
                      <span className={badgeClass(schedule.enabled ? 'success' : 'muted', { size: 'sm' })}>
                        {schedule.enabled
                          ? t('aiAgentsPage.stateEnabled')
                          : t('aiAgentsPage.stateDisabled')}
                      </span>
                    </div>
                    <p className="mt-1">
                      {nextRunLine(
                        schedule.cron,
                        schedule.timezone,
                        `ai-agent-schedule-next-run-${schedule.id}`,
                      )}
                    </p>
                    {/* A narrative row has no checks to name — "No checks"
                        would read as a misconfiguration rather than as the
                        kind's defining property. */}
                    {kindOf(schedule) === 'sweep' && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {kindsSentence(schedule.sweepKinds)}
                      </p>
                    )}
                    {schedule.override && (
                      <p
                        className="mt-1 text-xs text-primary"
                        data-testid={`ai-agent-schedule-override-summary-${schedule.id}`}
                      >
                        {kindOf(schedule) === 'narrative'
                          ? t('aiAgentsPage.schedules.overrideSummaryNarrative', {
                              state: schedule.override.enabled
                                ? t('aiAgentsPage.stateEnabled')
                                : t('aiAgentsPage.stateDisabled'),
                            })
                          : t('aiAgentsPage.schedules.overrideSummary', {
                              state: schedule.override.enabled
                                ? t('aiAgentsPage.stateEnabled')
                                : t('aiAgentsPage.stateDisabled'),
                              kinds: kindsSentence(schedule.effective.sweepKinds),
                            })}
                      </p>
                    )}
                    {schedule.lastRunSummary && (
                      <p
                        className="mt-1 text-xs text-muted-foreground"
                        data-testid={`ai-agent-schedule-lastrun-${schedule.id}`}
                      >
                        {t('aiAgentsPage.schedules.lastRun', {
                          at: formatDateTime(schedule.lastRunSummary.enqueuedAt),
                          admitted: schedule.lastRunSummary.runsAdmitted,
                          total: schedule.lastRunSummary.orgsTotal,
                          skipped: schedule.lastRunSummary.runsSkipped,
                        })}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {canManageBaselines && (
                        <button
                          type="button"
                          onClick={() => openBaseline(schedule)}
                          className="rounded-md border px-3 py-1.5 text-sm font-medium"
                          data-testid={`ai-agent-schedule-edit-${schedule.id}`}
                        >
                          {t('aiAgentsPage.schedules.edit')}
                        </button>
                      )}
                      {canOverride && (
                        <button
                          type="button"
                          onClick={() => openOverride(schedule)}
                          className="rounded-md border px-3 py-1.5 text-sm font-medium"
                          data-testid={`ai-agent-schedule-override-${schedule.id}`}
                        >
                          {schedule.override
                            ? t('aiAgentsPage.schedules.editOverride')
                            : t('aiAgentsPage.schedules.override')}
                        </button>
                      )}
                    </div>
                    {drafted && editor(drafted)}
                  </li>
                );
              })}
            </ul>
          )}

          {/* The create editor renders here (it belongs to no row); every OTHER
              draft renders inline in its row. Exactly one editor is open at a
              time, which is what lets the editor's controls carry unqualified
              test ids (`ai-agent-schedule-cron`, `-save`, …) without colliding. */}
          {canManageBaselines
            && (draft?.mode === 'baseline' && draft.id === null ? (
              editor(draft)
            ) : draft === null ? (
              <button
                type="button"
                onClick={openCreate}
                className="rounded-md border px-3 py-1.5 text-sm font-medium"
                data-testid="ai-agent-schedule-add"
              >
                {t('aiAgentsPage.schedules.add')}
              </button>
            ) : null)}
        </>
      )}
    </fieldset>
  );
}
