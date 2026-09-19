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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  AI_SWEEP_KINDS,
  DESIGN_DEFAULT_CRON,
  PATCH_DEFAULT_CRON,
  isDailyOrRarerLiteralCron,
  isHourlyFloorCron,
  isMonthlyOrRarerLiteralCron,
  isStructurallyValidCron,
  nextCronOccurrence,
  parseFiveFieldCron,
  wallClockNow,
  isWeeklyLiteralCron,
  listIanaTimezones,
  normalizeTimezone,
  type AiAgentEffectiveScheduleDto,
  type AiAgentKind,
  type AiAgentScheduleKind,
  type AiSweepKind,
} from '@breeze/shared';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useFeaturesStore } from '../../stores/featuresStore';
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
  /**
   * Fleet Designer (W01) — which schedule KINDS this section's create form
   * may offer, keyed off the target agent's own kind. A `design` schedule
   * targets a partner-wide DESIGNER agent (`agent_kind_not_designer`), never
   * the triage agent sweep/narrative schedules attach to — the two sets are
   * disjoint, so a triage row's chooser must never offer `design` and a
   * designer row's must never offer `sweep`/`narrative`. Defaults to
   * `'triage'` (pre-W01 behaviour, and the only other kind this section is
   * ever mounted for) so every pre-existing call site keeps compiling
   * without passing it.
   */
  agentKind?: AiAgentKind;
  /** True for a partner-scope session (`useDefaultOwnerScope().isPartnerScope`),
   *  the only kind that may write a partner-wide baseline. */
  isPartnerScope: boolean;
  /** The concrete org selected in the org switcher, or null in the fleet view.
   *  Overrides are per-org, so there is nothing to override without one. */
  orgId: string | null;
  /**
   * Fires whenever an unsaved schedule draft opens or closes.
   *
   * A schedule saves through its OWN request, not through the agent form's
   * Save — so the form's Save used to close the drawer and silently discard a
   * half-written cron. The parent uses this to block its Save/Cancel and say
   * why, rather than throwing the draft away without mentioning it.
   */
  onDirtyChange?: (dirty: boolean) => void;
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
  agent_kind_not_designer: (t) => t('aiAgentsPage.schedules.errors.agentKindNotDesigner'),
  agent_kind_not_patch: (t) => t('aiAgentsPage.schedules.errors.agentKindNotPatch'),
  // P2-3's two narrative-only codes. Both are unreachable through this form
  // (it never offers a kind on a narrative draft, and blocks Save on a
  // non-weekly narrative cron), so these are the concurrent-second-tab and
  // future-API-change safety net — the same role `override_exists` plays.
  kinds_not_empty: (t) => t('aiAgentsPage.schedules.errors.kindsNotEmpty'),
  invalid_cron_for_kind: (t) => t('aiAgentsPage.schedules.errors.invalidCronForKind'),
  // #4442 W04. Unreachable through this form — the override editor is
  // structurally incapable of authoring `actMode: true` — but mapped for the
  // same reason `override_exists` is: a concurrent second tab, or a future
  // API change, must not toast the raw machine token.
  sweep_act_mode_disabled: (t) => t('aiAgentsPage.schedules.actMode.deploymentDisabledHint'),
  act_mode_org_cannot_arm: (t) => t('aiAgentsPage.schedules.errors.actModeOrgCannotArm'),
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
// sweep silently fails to fire for a week.
//
// The evaluator itself now lives in `@breeze/shared` (`utils/cron.ts`): the AI
// patch agent (W01, #5747) made the agents LIST ROUTE report each agent's next
// occurrence on its card, and a second implementation would let the card and
// this drawer disagree. Re-exported here because this module is where the
// component's own tests reach for it.
//
// TIMEZONE. `nextCronOccurrence` returns WALL-CLOCK TIME IN THE SCHEDULE'S OWN
// ZONE and the label says which zone, so no instant conversion happens here.
// A DST transition is not modelled — a preview one hour off twice a year is
// the accepted cost of not shipping a tz library to render a hint. The
// scheduler, not this function, decides when a sweep runs.
// ---------------------------------------------------------------------------

export { nextCronOccurrence, parseFiveFieldCron };

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
 * hourly and keeps the pre-P2-3 nightly default. Fleet Designer (W01) adds
 * `design`, which must fire at most once a month (`isMonthlyOrRarerLiteralCron`)
 * — `DESIGN_DEFAULT_CRON` (shared) is the quarterly literal the server ships
 * as its own default, restated here rather than duplicated.
 */
const CRON_DEFAULTS: Readonly<Record<AiAgentScheduleKind, string>> = Object.freeze({
  sweep: '0 3 * * *',
  narrative: '0 7 * * 1',
  design: DESIGN_DEFAULT_CRON,
  // AI patch agent (W01) — at most once a day (`isDailyOrRarerLiteralCron`);
  // `PATCH_DEFAULT_CRON` (shared) is the 02:00 nightly literal the server
  // creates on enable, restated here rather than duplicated.
  patch: PATCH_DEFAULT_CRON,
});

/**
 * Fleet Designer (W01) — which schedule kinds a create form may offer, keyed
 * off the target agent's kind. See the `agentKind` prop's docstring: a
 * design schedule targets a designer agent exclusively, disjoint from the
 * sweep/narrative pair every other schedulable kind (triage, today) offers.
 */
const SCHEDULE_KINDS_FOR_AGENT_KIND: Readonly<Record<SchedulableAgentKind, readonly AiAgentScheduleKind[]>> =
  Object.freeze({
    triage: ['sweep', 'narrative'],
    designer: ['design'],
    // AI patch agent (W01) — disjoint from both sets above, for the same
    // reason `design` is: the API refuses any other kind on a patch agent.
    patch: ['patch'],
  });

/** The agent kinds this section is ever mounted for (`AiAgentForm`'s gate). */
type SchedulableAgentKind = 'triage' | 'designer' | 'patch';

/**
 * Which set a given agent kind may choose from. A real lookup keyed by the
 * agent kind, with `triage` as the default — before AI patch agent W01 this
 * was a `=== 'designer'` ternary, which would have silently handed a patch
 * agent the sweep/narrative pair.
 */
function scheduleKindsFor(agentKind: string): readonly AiAgentScheduleKind[] {
  return SCHEDULE_KINDS_FOR_AGENT_KIND[agentKind as SchedulableAgentKind]
    ?? SCHEDULE_KINDS_FOR_AGENT_KIND.triage;
}

/**
 * A row's kind, tolerant of a body written by a pre-P2-3 API build (which
 * emits no `kind` at all). Anything that is not `narrative` or `design` is
 * the sweep behaviour every schedule had before this wave — never an
 * `undefined` that would render `aiAgentsPage.schedules.kinds.undefined` as
 * a visible key path.
 */
function kindOf(schedule: Pick<AiAgentEffectiveScheduleDto, 'kind'>): AiAgentScheduleKind {
  if (schedule.kind === 'narrative') return 'narrative';
  if (schedule.kind === 'design') return 'design';
  if (schedule.kind === 'patch') return 'patch';
  return 'sweep';
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

/** The part of an IANA zone name before its first '/' ("America", "Europe",
 *  "UTC"). Used only to group the 418-option select into `<optgroup>`s — a
 *  bare list that long forces the operator to scan every option in order to
 *  find their own continent. */
function timezoneRegion(zone: string): string {
  const slash = zone.indexOf('/');
  return slash === -1 ? zone : zone.slice(0, slash);
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
  /**
   * #4442 W04 — unattended ("act mode") sweep execution. THREE-VALUED on the
   * wire (`null` = not armed), but always a plain boolean here: a baseline
   * draft reports its CURRENT arm state on every save, the same PUT-style
   * convention `enabled` already follows, so `null` only ever appears as the
   * seeded "not armed" reading of a stored row (`schedule.actMode !== true`)
   * — this editor never itself writes `null` back.
   */
  actMode: boolean;
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
  /** #4442 W04 — whether the BASELINE currently has act mode armed. Read-only
   *  context carried into the draft (never sent on save) so the editor can
   *  compute the EFFECTIVE act-mode state live, as the disarm switch below
   *  is toggled, without a second round trip. */
  baselineActMode: boolean;
  /**
   * The override's own act-mode choice — and the ONLY act-mode field this
   * mode may edit. A plain boolean by construction, not the three-valued
   * `boolean | null` the wire carries: `true` here means "disable act mode
   * for this org" (sent as `actMode: false`) and `false` means "inherit the
   * baseline" (sent as `actMode: null`). There is deliberately no state that
   * maps to sending `actMode: true` — the server refuses it
   * (`act_mode_org_cannot_arm`) and this type makes authoring it impossible
   * in the first place, not merely rejected.
   */
  actModeDisabled: boolean;
};

type Draft = BaselineDraft | OverrideDraft;

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

export default function AiAgentSchedulesSection({
  agentId,
  agentOwnerScope,
  agentKind = 'triage',
  isPartnerScope,
  orgId,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation('settings');
  const schedulable = agentOwnerScope === 'partner';
  const canManageBaselines = schedulable && isPartnerScope;
  const canOverride = schedulable && orgId !== null;
  // #4442 W04 — arming act mode on a partner baseline is additionally gated
  // on `canManagePartnerWidePolicies` server-side, stricter than the plain
  // `isPartnerScope` that already gates the rest of this editor (a
  // partner-scope session with org_access='selected' can still edit
  // cron/timezone/checks, but may not arm unattended execution). This is the
  // SAME client-side flag CustomFieldsPage.tsx and ScriptForm.tsx already
  // read for their own partner-wide gating — not a new permission source.
  // Absent means capable (a session persisted before the field existed),
  // matching every other reader of it; the server enforces regardless.
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const sweepActEnabled = useFeaturesStore((s) => s.features.aiAgentsSweepAct);
  const loadFeatures = useFeaturesStore((s) => s.load);
  useEffect(() => { void loadFeatures(); }, [loadFeatures]);
  const canArmActMode = canManageBaselines && canManagePartnerWide && sweepActEnabled;
  const actModeDisabledHint = sweepActEnabled
    ? t('aiAgentsPage.schedules.actMode.disabledHint')
    : t('aiAgentsPage.schedules.actMode.deploymentDisabledHint');
  // See `SCHEDULE_KINDS_FOR_AGENT_KIND`'s docstring — a real lookup keyed by
  // the agent kind, defaulting to the sweep/narrative pair.
  const availableScheduleKinds = scheduleKindsFor(agentKind);

  const [schedules, setSchedules] = useState<AiAgentEffectiveScheduleDto[]>([]);
  const [loading, setLoading] = useState(schedulable);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  /**
   * Whether the operator has actually CHANGED a field of the open draft.
   *
   * Dirtiness used to be `draft !== null`, so merely opening a schedule to look
   * at it latched the parent form dirty — wedging the agent's own Save (and,
   * before the close guard, its Cancel) behind a "you have unsaved work"
   * warning about work nobody had done. Seeded drafts are pure reads of the
   * stored row, so nothing is at risk until the first edit.
   */
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const allOrgsHintId = useId();
  const scheduleEnabledLabelId = useId();
  const actModeLabelId = useId();
  const actModeDisabledHintId = useId();

  // Read through a ref so an inline `onDirtyChange={...}` at the call site
  // cannot re-fire the effect on every parent render — the effect must run on
  // a change of DRAFTEDNESS, never on a change of callback identity.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const hasUnsavedEdits = draft !== null && touched;
  useEffect(() => {
    onDirtyChangeRef.current?.(hasUnsavedEdits);
  }, [hasUnsavedEdits]);
  // Unmount (the agent form closing, the agent switching) is not "the operator
  // resolved the draft", but the draft is gone with it — leaving the parent
  // latched dirty would wedge its Save for the next agent.
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);

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
  // `listIanaTimezones()` is already alphabetical, so entries sharing a
  // region are already contiguous — grouping by insertion order here never
  // has to re-sort. A Map preserves that order, which is what makes the
  // `<optgroup>`s below come out in the same order the flat list did.
  const zoneGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const zone of zones) {
      const region = timezoneRegion(zone);
      const list = groups.get(region);
      if (list) list.push(zone);
      else groups.set(region, [zone]);
    }
    return groups;
  }, [zones]);

  /**
   * A field CHANGE. The only thing that makes this section dirty — kept
   * separate from `seedDraft` below so opening, saving, deleting or cancelling
   * a draft can never be mistaken for unsaved work.
   */
  const editDraft = (next: Draft) => {
    setDraft(next);
    setTouched(true);
  };

  /** Open a draft from stored values, or close one. Never an edit. */
  const seedDraft = (next: Draft | null) => {
    setDraft(next);
    setTouched(false);
  };

  const openCreate = () => {
    setConfirmDelete(false);
    const kind = availableScheduleKinds[0] ?? 'sweep';
    seedDraft({
      mode: 'baseline',
      id: null,
      kind,
      cron: CRON_DEFAULTS[kind],
      timezone: defaultTimezone(),
      // Every check by default: a sweep is read-only reconnaissance in this
      // wave, and `sweepKinds` is `.min(1)` server-side, so an empty default
      // would ship a form whose Save is disabled on open. Neither narrative
      // nor design evaluates any sweep kind.
      sweepKinds: kind === 'sweep' ? [...AI_SWEEP_KINDS] : [],
      enabled: true,
      // Off by default — arming unattended execution is an explicit choice,
      // never something a new schedule starts with.
      actMode: false,
    });
  };

  /**
   * Switching the create form's kind rewrites the whole cadence/kinds pair,
   * not just the kind: the branches have incompatible server rules
   * (narrative = weekly literal + NO sweep kinds; design = monthly-or-rarer
   * literal + NO sweep kinds; sweep = hourly floor + at least one). Carrying
   * either field across would leave the form in a state whose Save the
   * server refuses — or, worse, silently valid but wrong.
   */
  const setCreateKind = (drafted: BaselineDraft, kind: AiAgentScheduleKind) => {
    editDraft({
      ...drafted,
      kind,
      cron: CRON_DEFAULTS[kind],
      sweepKinds: kind === 'sweep' ? [...AI_SWEEP_KINDS] : [],
    });
  };

  const openBaseline = (schedule: AiAgentEffectiveScheduleDto) => {
    setConfirmDelete(false);
    seedDraft({
      mode: 'baseline',
      id: schedule.id,
      kind: kindOf(schedule),
      cron: schedule.cron,
      timezone: schedule.timezone,
      sweepKinds: orderKinds(schedule.sweepKinds),
      enabled: schedule.enabled,
      actMode: schedule.actMode === true,
    });
  };

  const openOverride = (schedule: AiAgentEffectiveScheduleDto) => {
    setConfirmDelete(false);
    seedDraft({
      mode: 'override',
      id: schedule.override?.id ?? null,
      baselineId: schedule.id,
      kind: kindOf(schedule),
      allowedKinds: orderKinds(schedule.sweepKinds),
      // Seeded from the STORED override when there is one, so opening the
      // editor never silently re-widens a tightened org back to the baseline.
      sweepKinds: orderKinds(schedule.override?.sweepKinds ?? schedule.sweepKinds),
      enabled: schedule.override?.enabled ?? true,
      baselineActMode: schedule.actMode === true,
      actModeDisabled: schedule.override?.actMode === false,
    });
  };

  // A SWEEP baseline must ALSO clear the server's hourly floor
  // (`isHourlyFloorCron` — see the module doc), a narrative baseline must
  // ALSO be a weekly literal (`isWeeklyLiteralCron`), and a Fleet Designer
  // (W01) design baseline must ALSO be monthly-or-rarer
  // (`isMonthlyOrRarerLiteralCron`) — all three the same predicates the
  // server applies, restated rather than approximated, so a cron this form
  // accepts is never one the API then refuses.
  const cronValid = draft?.mode !== 'baseline'
    ? true
    : isFiveFieldCron(draft.cron)
      && (draft.kind === 'narrative'
        ? isWeeklyLiteralCron(draft.cron)
        : draft.kind === 'design'
          ? isMonthlyOrRarerLiteralCron(draft.cron)
          // AI patch agent (W01) — daily or rarer, the server's own floor.
          : draft.kind === 'patch'
            ? isDailyOrRarerLiteralCron(draft.cron)
            : isHourlyFloorCron(draft.cron));
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

    // A NARRATIVE or DESIGN schedule evaluates no sweep kinds, and the
    // create schema refuses a non-empty list on either branch
    // (`kinds_not_empty`). Omitting the key entirely — rather than sending
    // `[]` — is what the schema's "omitted or empty" wording means, and
    // keeps the wire body honest about the fact that neither kind has any
    // checks to select. Neither branch sends a bare `kind: 'sweep'` either —
    // that stays the server's own omitted-key default.
    const noSweepKinds = draft.kind !== 'sweep';

    const payload: Record<string, unknown> =
      draft.mode === 'baseline'
        ? draft.id === null
          ? {
              ownerScope: 'partner',
              ...(noSweepKinds ? { kind: draft.kind } : {}),
              agentId,
              cron: draft.cron.trim(),
              timezone: draft.timezone,
              ...(noSweepKinds ? {} : { sweepKinds: draft.sweepKinds }),
              enabled: draft.enabled,
              // New schedules stay disarmed when deployment gating prevents arming.
              actMode: sweepActEnabled && draft.actMode,
            }
          : {
              cron: draft.cron.trim(),
              timezone: draft.timezone,
              ...(noSweepKinds ? {} : { sweepKinds: draft.sweepKinds }),
              enabled: draft.enabled,
              // Preserve stored arming while the deployment flag is off.
              ...(sweepActEnabled ? { actMode: draft.actMode } : {}),
            }
        : draft.id === null
          ? {
              ownerScope: 'organization',
              orgId,
              baselineScheduleId: draft.baselineId,
              enabled: draft.enabled,
              // Required on this branch even for a narrative/design baseline,
              // where the only admissible value is the empty list.
              sweepKinds: noSweepKinds ? [] : draft.sweepKinds,
              // #4442 W04 — tighten-only: `false` (disarm) or `null`
              // (inherit). `OverrideDraft.actModeDisabled` structurally
              // cannot represent `true` — see its docstring.
              actMode: draft.actModeDisabled ? false : null,
            }
          : // `updateAiAgentScheduleSchema` is `.strict()` and admits neither
            // ownerScope nor baselineScheduleId — both are immutable.
            {
              enabled: draft.enabled,
              ...(noSweepKinds ? {} : { sweepKinds: draft.sweepKinds }),
              ...(sweepActEnabled ? { actMode: draft.actModeDisabled ? false : null } : {}),
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
      seedDraft(null);
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
      seedDraft(null);
      await load();
    }
  }, [confirmDelete, draft, load, saving, t]);

  const kindLabel = (kind: AiSweepKind) =>
    t(/* i18n-dynamic */ `aiAgentsPage.schedules.kindLabels.${kind}`);

  // Literal keys, not a dynamic `t()` on the token: the closed three-member
  // union is worth spelling out so the keyUsage guard verifies every label
  // statically (the same reason RunsListPage's statusLabel is a switch).
  const scheduleKindLabel = (kind: AiAgentScheduleKind) =>
    kind === 'narrative'
      ? t('aiAgentsPage.schedules.kinds.narrative')
      : kind === 'design'
        ? t('aiAgentsPage.schedules.kinds.design')
        : kind === 'patch'
          ? t('aiAgentsPage.schedules.kinds.patch')
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
            {availableScheduleKinds.map((kind) => (
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
              onChange={(e) => editDraft({ ...drafted, cron: e.target.value })}
              data-testid="ai-agent-schedule-cron"
            />
            <span
              className="block text-xs text-muted-foreground"
              data-testid={
                drafted.kind === 'narrative'
                  ? 'ai-agent-schedule-weekly-hint'
                  : drafted.kind === 'design'
                    ? 'ai-agent-schedule-monthly-hint'
                    : drafted.kind === 'patch'
                      ? 'ai-agent-schedule-daily-hint'
                      : 'ai-agent-schedule-cron-hint'
              }
            >
              {drafted.kind === 'narrative'
                ? t('aiAgentsPage.schedules.weeklyOnlyHint')
                : drafted.kind === 'design'
                  ? t('aiAgentsPage.schedules.monthlyOrRarerHint')
                  : drafted.kind === 'patch'
                    ? t('aiAgentsPage.schedules.dailyOrRarerHint')
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
            <div className="flex items-center gap-2">
              <select
                className={inputCls}
                value={drafted.timezone}
                onChange={(e) => editDraft({ ...drafted, timezone: e.target.value })}
                data-testid="ai-agent-schedule-timezone"
              >
                {/* Grouped by continent — a flat 418-option list forces the
                    operator to scan every entry to find their own region. */}
                {[...zoneGroups.entries()].map(([region, regionZones]) => (
                  <optgroup key={region} label={region}>
                    {regionZones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                onClick={() => editDraft({ ...drafted, timezone: defaultTimezone() })}
                className="shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs font-medium"
                data-testid="ai-agent-schedule-use-my-timezone"
              >
                {t('aiAgentsPage.schedules.useMyTimezone')}
              </button>
            </div>
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
                  onChange={() => editDraft({ ...drafted, sweepKinds: toggleKind(drafted.sweepKinds, kind) })}
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

      {/* A labelled switch row, set apart with its own top border — not an
          unlabelled seventh checkbox sitting directly under "Checks to run"
          (six of those, for a sweep draft), which read as one more item in
          that group rather than the schedule's own on/off gate. */}
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-sm font-medium" id={scheduleEnabledLabelId}>
          {t('aiAgentsPage.schedules.enabled')}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={drafted.enabled}
          aria-labelledby={scheduleEnabledLabelId}
          onClick={() => editDraft({ ...drafted, enabled: !drafted.enabled })}
          data-testid="ai-agent-schedule-enabled"
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition ${
            drafted.enabled ? 'bg-emerald-500/80' : 'bg-muted'
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
              drafted.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* #4442 W04 — the schedule-level unattended-execution arm switch. A
          baseline gets the actual arm control; an org override gets only a
          tighten-only disable, structurally incapable of arming (see
          `OverrideDraft.actModeDisabled`'s docstring). Both share the single
          scope-note callout below, rendered whenever the state THIS editor is
          about to save would leave the row effectively armed — never merely
          "the toggle is on", which for an override also depends on the
          baseline it can't see rendered elsewhere. */}
      {/* Act mode only means anything for a SWEEP schedule: narrative, design
          and patch schedules propose no actions at all, so showing an arm
          switch on one would advertise autonomy that has nothing to execute. */}
      {drafted.kind === 'sweep' && (
      <div className="border-t pt-3">
        {drafted.mode === 'baseline' ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium" id={actModeLabelId}>
              {t('aiAgentsPage.schedules.actMode.label')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={drafted.actMode}
              aria-labelledby={actModeLabelId}
              aria-describedby={canArmActMode ? undefined : actModeDisabledHintId}
              disabled={!canArmActMode}
              title={canArmActMode ? undefined : actModeDisabledHint}
              onClick={() => editDraft({ ...drafted, actMode: !drafted.actMode })}
              data-testid="ai-agent-schedule-act-mode"
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                drafted.actMode ? 'bg-amber-500/80' : 'bg-muted'
              }`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                  drafted.actMode ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium" id={actModeLabelId}>
              {t('aiAgentsPage.schedules.actMode.disableForOrg')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={drafted.actModeDisabled}
              aria-labelledby={actModeLabelId}
              onClick={() => editDraft({ ...drafted, actModeDisabled: !drafted.actModeDisabled })}
              data-testid="ai-agent-schedule-act-mode-disable"
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition ${
                drafted.actModeDisabled ? 'bg-emerald-500/80' : 'bg-muted'
              }`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                  drafted.actModeDisabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {drafted.mode === 'baseline'
            ? t('aiAgentsPage.schedules.actMode.hint')
            : t('aiAgentsPage.schedules.actMode.disableForOrgHint')}
        </p>
        {drafted.mode === 'baseline' && !canArmActMode && (
          <p
            className="mt-1 text-xs text-muted-foreground"
            id={actModeDisabledHintId}
            data-testid="ai-agent-schedule-act-mode-disabled-hint"
          >
            {actModeDisabledHint}
          </p>
        )}
        {/* Sweeps v1 covers exactly one unattended operation — named here
            every time arming is live, so an operator who arms it expecting
            broader remediation (vulnerability patching, disk cleanup, …)
            cannot miss the actual scope. */}
        {sweepActEnabled && (drafted.mode === 'baseline' ? drafted.actMode : drafted.baselineActMode && !drafted.actModeDisabled) && (
          <p
            className="mt-1 text-xs text-amber-700 dark:text-amber-400"
            data-testid="ai-agent-schedule-act-mode-scope-note"
          >
            {t('aiAgentsPage.schedules.actMode.scopeNote')}
          </p>
        )}
      </div>
      )}

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
            seedDraft(null);
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
          {/* `draft === null` too: without it, the empty state rendered ABOVE
              an already-open create editor the instant the list was empty —
              "No sweep schedules yet" sitting directly on top of the form
              that was already fixing that. */}
          {!loading && !failed && schedules.length === 0 && draft === null && (
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
                        className={badgeClass('info', { size: 'sm' })}
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
