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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  AI_AGENT_SCHEDULE_KINDS,
  AI_SWEEP_KINDS,
  isStructurallyValidCron,
  isWeeklyLiteralCron,
  listIanaTimezones,
  normalizeTimezone,
  type AiAgentEffectiveScheduleDto,
  type AiAgentScheduleKind,
  type AiSweepKind,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
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
  }, [agentId, schedulable]);

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

  // A narrative baseline must ALSO be a weekly literal (`isWeeklyLiteralCron`)
  // — the same predicate the server applies, restated rather than approximated,
  // so a cron this form accepts is never one the API then refuses.
  const cronValid = draft?.mode !== 'baseline'
    ? true
    : isFiveFieldCron(draft.cron) && (draft.kind !== 'narrative' || isWeeklyLiteralCron(draft.cron));
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
            <p className="text-sm text-muted-foreground" data-testid="ai-agent-schedules-empty">
              {t('aiAgentsPage.schedules.empty')}
            </p>
          )}

          {schedules.length > 0 && (
            <ul className="divide-y rounded-md border" data-testid="ai-agent-schedules-list">
              {schedules.map((schedule) => {
                const drafted = editingThis(schedule);
                return (
                  <li key={schedule.id} className="p-3" data-testid={`ai-agent-schedule-${schedule.id}`}>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span
                        className="rounded bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700"
                        data-testid={`ai-agent-schedule-kind-badge-${schedule.id}`}
                      >
                        {scheduleKindLabel(kindOf(schedule))}
                      </span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{schedule.cron}</code>
                      <span className="text-muted-foreground">{schedule.timezone}</span>
                      <span
                        className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary"
                        title={t('aiAgentsPage.allOrgsHint')}
                      >
                        {t('aiAgentsPage.allOrgs')}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {schedule.enabled
                          ? t('aiAgentsPage.stateEnabled')
                          : t('aiAgentsPage.stateDisabled')}
                      </span>
                    </div>
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
