import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Bot, PauseCircle, Plus } from 'lucide-react';
import { AI_AGENT_KINDS, type AiAgentsSystemStatusDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { useOrgScope } from '@/hooks/useOrgScope';
import { useHashState } from '@/lib/useHashState';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { handleActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { badgeClass, modeTone, runStatusTone } from '../aiAgents/statusBadge';
import { Drawer } from '../shared/Drawer';
import { EmptyState } from '../shared/EmptyState';
import { PageHeader } from '../shared/PageHeader';
import AiAgentForm, { type AiAgentDto } from './AiAgentForm';
import AgentCreateFlow from './aiAgents/AgentCreateFlow';

// Task 13 (#5051): create no longer opens this drawer at all — it opens the
// full-width `AgentCreateFlow` in place of the list instead (see `creating`
// below) — so an open editor always names a real, persisted agent.
type Editing = { agent: AiAgentDto } | null;

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

/**
 * Settings → AI Agents (wave 1). An agent is a named policy row, not a running
 * process: nothing executes until a later wave, and `BREEZE_AI_AGENTS_ENABLED`
 * keeps the resolved policy disabled on deployments that have not opted in.
 *
 * Partner-wide rows are invisible to an org session by design — RLS hides them
 * from org tokens — so an org admin manages only their own overrides here and
 * sees the inherited baseline through the effective-policy endpoint.
 *
 * Disabled agents are soft-deleted, never removed, so this page asks for them
 * too (`includeDisabled=1`) and keeps them in their own collapsed section with
 * a way back. Without that, disabling the only agent left an operator looking
 * at "No agents yet" while its run history and its partner-wide schedule were
 * both still there.
 */
export default function AiAgentsPage() {
  const { t } = useTranslation('settings');
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  // AI patch agent W01 (#5747): which org a "Run now" would belong to.
  const orgScope = useOrgScope();

  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  // #4170: which kinds already have an active partner-wide baseline for this
  // org's partner — reported alongside `data` because a not-yet-created org
  // row has no `hasPartnerBaseline` of its own for the create form to read.
  const [partnerBaselineKinds, setPartnerBaselineKinds] = useState<Set<string>>(new Set());
  /**
   * #5380 — the SUBSYSTEM's state, as opposed to any one row's `enabled`
   * flag. `null` means the API did not report it (an older server), which is
   * deliberately NOT treated as "disabled": inventing an outage banner from a
   * missing field would be its own false alarm.
   */
  const [system, setSystem] = useState<AiAgentsSystemStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  // True once a load has completed at least once. `loading` alone would make
  // every refresh (a save, a re-enable) tear the empty state down and put the
  // header's create button back for one frame — a visible flicker on the
  // quietest screen in the product.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  /** The open editor holds unsaved work of its own (AiAgentForm reports it).
   *  Held here because the Drawer — which owns Escape, the X and the backdrop —
   *  is rendered here, not in the form. */
  const [editorDirty, setEditorDirty] = useState(false);
  const [enablingId, setEnablingId] = useState<string | null>(null);
  /** AI patch agent W01 (#5747) — the patch agent whose "Run now" is in
   *  flight; every Run now is disabled while one is, the same single-fire
   *  posture `reenable` takes. */
  const [runningNowId, setRunningNowId] = useState<string | null>(null);
  const allOrgsHintId = useId();
  const inertHintId = useId();
  /** The agent a Re-enable just restored, so its live row can show a one-time
   *  "switched off, review its policy" note (Finding 1). Cleared by any
   *  further state change — opening or closing the editor — rather than a
   *  timer, so it never lingers past the moment it stops being news. */
  const [justReenabledId, setJustReenabledId] = useState<string | null>(null);
  /** Task 13 (#5051): "New agent" opens the four-step guided flow FULL WIDTH
   *  in place of the list, rather than the drawer. Mutually exclusive with
   *  `editing` (Edit still opens the drawer) — nothing opens both. */
  const [creating, setCreating] = useState(false);
  /** The agent `AgentCreateFlow` just created, so its row can be called out
   *  once the list reloads and the flow closes — same "cleared by any
   *  further state change" rule as `justReenabledId` above. */
  const [highlightedAgentId, setHighlightedAgentId] = useState<string | null>(null);
  /** First row's Re-enable button in the Disabled section — the target the
   *  all-disabled empty state's primary CTA focuses (Finding 4). */
  const firstDisabledReenableRef = useRef<HTMLButtonElement | null>(null);

  // Literal keys, not a dynamic `t()` on the token: the closed three-member
  // union is spelled out so the keyUsage guard verifies every label and hint
  // statically (same reason as AiAgentSchedulesSection's `scheduleKindLabel`).
  const KIND_LABEL: Record<(typeof AI_AGENT_KINDS)[number], string> = {
    triage: t('aiAgentsPage.kinds.triage'),
    patch: t('aiAgentsPage.kinds.patch'),
    helpdesk: t('aiAgentsPage.kinds.helpdesk'),
    designer: t('aiAgentsPage.kinds.designer'),
  };
  const KIND_HINT: Record<(typeof AI_AGENT_KINDS)[number], string> = {
    triage: t('aiAgentsPage.kindHints.triage'),
    patch: t('aiAgentsPage.kindHints.patch'),
    helpdesk: t('aiAgentsPage.kindHints.helpdesk'),
    designer: t('aiAgentsPage.kindHints.designer'),
  };
  // Same reason, over `AI_AGENT_RUN_STATUSES`. Shares the runs page's own
  // vocabulary rather than minting a second set of status words.
  const RUN_STATUS_LABEL: Record<string, string> = {
    queued: t('aiAgentsPage.runs.statuses.queued'),
    running: t('aiAgentsPage.runs.statuses.running'),
    awaiting_approval: t('aiAgentsPage.runs.statuses.awaiting_approval'),
    completed: t('aiAgentsPage.runs.statuses.completed'),
    failed: t('aiAgentsPage.runs.statuses.failed'),
    cancelled: t('aiAgentsPage.runs.statuses.cancelled'),
    expired: t('aiAgentsPage.runs.statuses.expired'),
    skipped: t('aiAgentsPage.runs.statuses.skipped'),
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      // fetchWithAuth appends the selected orgId; the route ignores it and
      // scopes the read through RLS plus the caller's accessible orgs.
      // `includeDisabled=1`: a soft-deleted agent still owns its runs and its
      // schedules, so the page must be able to say it exists.
      const response = await fetchWithAuth('/ai/agents?includeDisabled=1');
      if (!response.ok) throw new Error(`GET /ai/agents ${response.status}`);
      // response.json() throws on a non-JSON 200 — a gateway error page, a
      // truncated body. Unguarded, that rejection escaped `void load()` with
      // no unhandledrejection handler anywhere, leaving the page in a
      // permanent loading state that renders as an ordinary empty screen.
      const body = (await response.json()) as {
        data?: unknown; partnerBaselineKinds?: unknown; system?: unknown;
      };
      // A body we cannot read is an ERROR, not zero agents. `?? []` reported
      // "no agents yet" for a shape change and, worse, told the create form
      // every kind was free — so the next save 409'd on an agent the page had
      // just said did not exist.
      if (!Array.isArray(body.data)) throw new Error('GET /ai/agents: malformed body');
      setAgents(body.data as AiAgentDto[]);
      setPartnerBaselineKinds(new Set(Array.isArray(body.partnerBaselineKinds) ? body.partnerBaselineKinds : []));
      // Shape-checked on the one field every branch below reads. Anything
      // else (a partial block, an older server) stays `null` = "not reported".
      const reported = body.system as AiAgentsSystemStatusDto | undefined;
      setSystem(reported && typeof reported.enabled === 'boolean' ? reported : null);
    } catch (err) {
      console.error('[AiAgentsPage] could not load agents', err);
      setError(true);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // `#agent=<id>` opens that agent's editor — the run-detail page links here,
  // and a shared link has to land on the row it names rather than on the list.
  const [hashAgentId, setHashAgentId] = useHashState<string | null>(null, (hash) =>
    hash.startsWith('agent=') ? hash.slice('agent='.length) : undefined,
  );
  // Applied once per hash VALUE. Without the latch, every list reload (a save,
  // a re-enable) re-opened the drawer the operator had just closed.
  const appliedHashRef = useRef<string | null>(null);
  useEffect(() => {
    // The guided create flow (Task 13, #5051) is mutually exclusive with the
    // edit drawer — nothing opens both. Bail rather than force-close it: its
    // own Cancel already discards the in-progress draft with no confirmation
    // (`onCancel={() => setCreating(false)}` below), so a stray hash must not
    // silently do the same to a draft the operator never asked to abandon.
    // `creating` is a dependency so the link is honoured once the flow
    // closes (Cancel or Create) and the hash is still unlatched.
    if (creating || !hashAgentId || appliedHashRef.current === hashAgentId) return;
    // Live rows only. The list deliberately carries soft-deleted agents
    // (`includeDisabled=1`), so a stale link would otherwise open the full
    // editor on one — every field live, and a Save aimed at a PATCH the server
    // refuses outright because `updateAgent` rejects a disabled row. Such an
    // agent is reachable through the Disabled section, which offers the one
    // action that actually applies to it.
    const target = agents.find((row) => row.id === hashAgentId && !row.disabledAt);
    // A hash naming an agent this session cannot see is not an error to
    // report — it is simply not actionable, so the list renders as usual.
    if (!target) return;
    appliedHashRef.current = hashAgentId;
    setEditing({ agent: target });
  }, [agents, creating, hashAgentId]);

  /**
   * Closing the editor, from any affordance.
   *
   * The deep link is ONE-SHOT: the applied-hash latch (above) exists so a list
   * reload cannot re-open a drawer the operator dismissed, but it also meant
   * `#agent=<id>` outlived the drawer it opened — so the same link could never
   * open that agent a second time, and a reload landed straight back on the
   * editor. Both the latch and the fragment are cleared here, together: the
   * latch alone would let the effect re-fire on the hash still in the URL.
   */
  /** Opens the editor for an existing agent. The one place that starts an
   *  edit, so it is also the one place that dismisses a still-open re-enable
   *  note and any create-flow highlight — opening the editor is unambiguously
   *  a "state change". */
  const openEditor = useCallback((next: Editing) => {
    setJustReenabledId(null);
    setHighlightedAgentId(null);
    setEditing(next);
  }, []);

  /** "New agent" — opens `AgentCreateFlow` full-width in place of the list
   *  (Task 13, #5051), replacing what used to be `openEditor({ agent: null })`. */
  const startCreate = useCallback(() => {
    setJustReenabledId(null);
    setHighlightedAgentId(null);
    setCreating(true);
  }, []);

  const closeEditor = useCallback(() => {
    setEditing(null);
    setJustReenabledId(null);
    appliedHashRef.current = null;
    setHashAgentId(null);
    // replaceState, not `location.hash = ''`: assigning leaves a bare '#' in
    // the URL and pushes a history entry, so Back would step through empty
    // fragments instead of leaving the page.
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#agent=')) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  }, [setHashAgentId]);

  const { live, disabled } = useMemo(() => ({
    live: agents.filter((row) => !row.disabledAt),
    disabled: agents.filter((row) => row.disabledAt),
  }), [agents]);

  // Seeded open when the disabled list is the only thing on the page, then
  // owned by the operator. An uncontrolled `open={live.length === 0}` would let
  // a later re-render slam a section they had just expanded.
  const [disabledOpen, setDisabledOpen] = useState(false);
  useEffect(() => {
    if (live.length === 0 && disabled.length > 0) setDisabledOpen(true);
  }, [live.length, disabled.length]);

  // Single-fire latch, the same one ConfirmDialog carries (#3705). `enablingId`
  // and `disabled={enablingId !== null}` are both read from the render that
  // produced the handler, so neither holds on the second half of a real
  // double-click — two POSTs went out, and the second answered 409
  // `agent_not_disabled` on the row the first had just restored, so the
  // operator got a success toast AND an error toast for one action. A ref reads
  // CURRENT, so it holds synchronously inside the one handler invocation.
  const enablingRef = useRef(false);
  const reenable = useCallback(async (agent: AiAgentDto) => {
    if (enablingRef.current) return;
    enablingRef.current = true;
    setEnablingId(agent.id);
    let enabled = false;
    try {
      await runAction({
        // Inline thunk: the no-silent-mutations guard is a lexical AST check,
        // so a hoisted request function reads as an unwrapped mutation (#2429).
        request: () => fetchWithAuth(`/ai/agents/${agent.id}/enable`, { method: 'POST' }),
        successMessage: t('aiAgentsPage.toasts.reenabled'),
        errorFallback: t('aiAgentsPage.toasts.reenableFailed'),
        friendly: (code) => (code === 'agent_not_disabled'
          ? t('aiAgentsPage.errors.notDisabled')
          : code === 'agent_kind_exists'
            ? t('aiAgentsPage.errors.kindExists')
            : undefined),
        onUnauthorized: UNAUTHORIZED,
      });
      enabled = true;
      // Set on SUCCESS, before the reload below: the row this note belongs to
      // is about to move from the Disabled section back into the live list,
      // and the note has to survive that re-render to land on it there.
      setJustReenabledId(agent.id);
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.toasts.reenableFailed'));
    } finally {
      setEnablingId(null);
      enablingRef.current = false;
    }
    if (enabled) await load();
  }, [load, t]);

  /**
   * #5380 — the row-level badge, now aware of the SUBSYSTEM.
   *
   * Three states, not two. "Running" is a claim about liveness, so it may
   * only be made when both the row and the subsystem are on; an enabled row
   * on a kill-switched server gets a third word that says the row is on AND
   * that nothing will fire. A server that did not report its subsystem state
   * (`system === null`) keeps the original two-state behaviour rather than
   * accusing a healthy deployment of being off.
   */
  const subsystemOff = system !== null && !system.enabled;
  const runningLabel = (enabled: boolean): string => {
    if (!enabled) return t('aiAgentsPage.runningBadge.notRunning');
    return subsystemOff
      ? t('aiAgentsPage.runningBadge.inactive')
      : t('aiAgentsPage.runningBadge.running');
  };
  const runningTone = (enabled: boolean): 'success' | 'warning' | 'muted' => {
    if (!enabled) return 'muted';
    return subsystemOff ? 'warning' : 'success';
  };

  /**
   * The disabled-subsystem banner (#5380) plus its skip trace (#5381).
   *
   * The two switches get DIFFERENT sentences because they have different
   * remedies: the env flag is an operator's `.env` (named outright, since a
   * self-hoster has no other way to learn it), the kill switch is an admin
   * flip. Telling someone to set an env var that is already set is how a
   * banner wastes an outage.
   */
  const subsystemBanner = () => {
    if (!subsystemOff || system === null) return null;
    const skips = system.skips;
    return (
      <div
        className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
        role="status"
        data-testid="ai-agents-subsystem-disabled"
      >
        <p className="font-medium">{t('aiAgentsPage.subsystemDisabled.title')}</p>
        {system.envFlagEnabled ? (
          <p className="mt-1 text-muted-foreground" data-testid="ai-agents-subsystem-killswitch">
            {t('aiAgentsPage.subsystemDisabled.killSwitch')}
          </p>
        ) : (
          <p className="mt-1 text-muted-foreground" data-testid="ai-agents-subsystem-envflag">
            {t('aiAgentsPage.subsystemDisabled.envFlag', { flag: system.envFlagName })}
          </p>
        )}
        {/* `skips === null` is UNKNOWN, not zero — rendering "0 skipped"
            would be the same false reassurance #5381 is about. */}
        {skips && skips.total > 0 && (
          <p className="mt-1 text-muted-foreground" data-testid="ai-agents-skip-trace">
            {t('aiAgentsPage.subsystemDisabled.skips', {
              total: skips.total,
              // `kill_switch_off (15)` — the reason is a machine-readable
              // `AgentRunSkipReason` value and the count a number, so this
              // format carries no wording to translate.
              reasons: skips.reasons.map((r) => `${r.reason} (${r.count})`).join(', '),
            })}
          </p>
        )}
      </div>
    );
  };

  /** The last-run cell: an absolute timestamp plus the run's own outcome
   *  badge, or a plain sentence when the agent has never run. Both matter —
   *  "enabled, shadow" says nothing about whether the agent is actually
   *  doing anything. */
  const lastRunCell = (agent: AiAgentDto) => {
    // P0: a run can complete "successfully" and still leave findings an
    // operator has not looked at yet — the status badge alone says nothing
    // about that. The list DTO carries no `lastRunId`, so the badge links to
    // the runs list filtered to this agent, same as the row's own Runs link,
    // rather than the run directly.
    const findings = agent.lastRunFindingsToReview;
    const runHref = `/ai-agents/runs#agent=${agent.id}`;
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={`ai-agent-lastrun-${agent.id}`}>
        {agent.lastRunAt && agent.lastRunStatus ? (
          <>
            {/* Paper cut 22: this badge's word can coincide with the row's own
                on/off badge (both read "Running" for a live agent mid-run).
                A visible caption — not just the aria-label — is what tells a
                sighted user which "Running" is which. */}
            <span className="inline-flex items-center gap-1">
              <span
                className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                aria-hidden="true"
                data-testid={`ai-agent-lastrun-badge-label-${agent.id}`}
              >
                {t('aiAgentsPage.chipLabels.lastRunStatus')}
              </span>
              <span
                className={badgeClass(runStatusTone(agent.lastRunStatus), { size: 'sm' })}
                aria-label={`${t('aiAgentsPage.chipLabels.lastRunStatus')}: ${RUN_STATUS_LABEL[agent.lastRunStatus] ?? agent.lastRunStatus}`}
              >
                {RUN_STATUS_LABEL[agent.lastRunStatus] ?? agent.lastRunStatus}
              </span>
            </span>
            <span>{t('aiAgentsPage.lastRun.at', { at: formatDateTime(agent.lastRunAt) })}</span>
          </>
        ) : (
          t('aiAgentsPage.lastRun.never')
        )}
        {typeof findings === 'number' && findings > 0 && (
          <a
            href={runHref}
            className={`${badgeClass('warning', { size: 'sm' })} hover:opacity-90`}
            data-testid={`ai-agent-findings-badge-${agent.id}`}
          >
            {t('aiAgentsRuns.detail.findings.badge', { count: findings })}
          </a>
        )}
      </span>
    );
  };

  /**
   * AI patch agent W01 (#5747) — when this agent next fires, computed by the
   * list route with the same cron evaluator the schedules drawer uses. An
   * agent with no enabled baseline, or one whose stored cron cannot be
   * evaluated, reports null and renders an em dash: "no next run" is a fact
   * worth showing, not a cell to omit.
   */
  const nextOccurrenceCell = (agent: AiAgentDto) => (
    <span data-testid={`ai-agent-next-occurrence-${agent.id}`}>
      {agent.nextOccurrenceAt
        ? t('aiAgentsPage.nextOccurrence', { at: formatDateTime(agent.nextOccurrenceAt) })
        // A bare em dash, not a translated key: it is punctuation in every
        // locale, and an eight-way "translation" of it is what pushes the
        // exact-English duplicate baselines up. Same precedent as
        // `sweepReasonLabel`'s own `'—'` on RunDetailPage.
        : '—'}
    </span>
  );

  /**
   * "Run now" for a patch agent: queues one device-less patch run for the
   * SELECTED org. Wrapped in `runAction` with an inline thunk (the
   * no-silent-mutations guard is a lexical check), so the route's HTTP-200
   * `{ success: false, skipped }` decline surfaces as a failure toast rather
   * than as a button that appears to do nothing.
   *
   * There is no shared API client for AI agents — this file calls
   * `fetchWithAuth` inline everywhere else, and one call does not justify
   * introducing one.
   */
  const runningRef = useRef(false);
  const runPatchNow = useCallback(async (agent: AiAgentDto, orgId: string) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunningNowId(agent.id);
    try {
      await runAction({
        request: () => fetchWithAuth('/ai/patch-plan/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId }),
        }),
        successMessage: t('aiAgentsPage.toasts.runNowQueued'),
        errorFallback: t('aiAgentsPage.toasts.runNowFailed'),
        friendly: (code) => (code === 'no_patch_agent'
          ? t('aiAgentsPage.errors.noPatchAgent')
          : undefined),
        onUnauthorized: UNAUTHORIZED,
      });
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.toasts.runNowFailed'));
    } finally {
      setRunningNowId(null);
      runningRef.current = false;
    }
  }, [t]);

  /** The Run now control, for an enabled patch agent only. Disabled — with the
   *  reason in its tooltip — while the page is on "All organizations": a patch
   *  run belongs to exactly one org, and guessing one is worse than asking. */
  const runNowButton = (agent: AiAgentDto) => {
    if (agent.kind !== 'patch' || !agent.enabled) return null;
    const orgId = orgScope.scope === 'org' ? orgScope.orgId : null;
    return (
      <button
        type="button"
        onClick={() => { if (orgId) void runPatchNow(agent, orgId); }}
        disabled={orgId === null || runningNowId !== null}
        title={orgId === null ? t('aiAgentsPage.runNowNoOrg') : undefined}
        className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        data-testid={`ai-agent-run-now-${agent.id}`}
      >
        {t('aiAgentsPage.actions.runNow')}
      </button>
    );
  };

  const showFirstRun = loaded && !error && agents.length === 0;
  const showAllDisabled = loaded && !error && live.length === 0 && disabled.length > 0;

  // Disabled until the list has loaded: the create flow's first-render
  // defaults (free kind, partner-wide vs org-only) read `agents` and
  // `partnerBaselineKinds`, which are empty until then (#5064 review).
  const createButton = (testId: string) => (
    <button
      type="button"
      onClick={startCreate}
      disabled={!loaded}
      className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      data-testid={testId}
    >
      <Plus className="h-4 w-4" />
      {t('aiAgentsPage.actions.add')}
    </button>
  );

  return (
    <div className="space-y-6" data-testid="ai-agents-page">
      <PageHeader
        testId="ai-agents-page-header"
        icon={<Bot className="h-5 w-5" />}
        title={t('aiAgentsPage.title')}
        description={t('aiAgentsPage.description')}
        // One create affordance at a time: while the first-run panel is on
        // screen it owns the call to action, and a second identical button in
        // the header just competes with it. Hidden entirely while the guided
        // create flow is open (Task 13, #5051) — it has its own Cancel.
        actions={!showFirstRun && !showAllDisabled && !creating ? createButton('ai-agent-create-button') : undefined}
      />

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('aiAgentsPage.errors.load')}
        </div>
      )}

      {/* Above everything the page says about individual agents: no per-row
          detail matters while nothing can run at all. */}
      {subsystemBanner()}

      {/* Task 13 (#5051): the guided create flow replaces the list ENTIRELY
          while open — full width, its own header/footer — rather than
          opening in the drawer. Edit is unaffected: it still opens
          AiAgentForm in the Drawer below. */}
      {creating && (
        <AgentCreateFlow
          agents={agents}
          partnerBaselineKinds={partnerBaselineKinds}
          showOwnerScope={isPartnerScope}
          defaultOwnerScope={defaultOwnerScope}
          onCancel={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            setHighlightedAgentId(agent.id);
            void load();
          }}
        />
      )}

      {/* The editor used to render INLINE, above the list, which pushed every
          existing agent below the fold the moment you clicked Edit. It opens
          in the app's Drawer instead — the same idiom as the impact-weights
          editor — so the list you are editing against stays on screen. */}
      <Drawer
        open={editing !== null}
        onClose={closeEditor}
        title={editing?.agent ? t('aiAgentsPage.editor.editTitle') : t('aiAgentsPage.editor.newTitle')}
        width="max-w-3xl"
        dataTestId="ai-agent-editor-drawer"
        // The unsaved-work guard belongs HERE, not inside the form: the drawer
        // owns Escape, the header X and the backdrop, and the form could only
        // ever defend its own Cancel button. Cancel itself stays live and
        // prompts (see AiAgentForm's discard dialog) — it is the deliberate
        // exit, and disabling it is what taught operators to reach for the X.
        closeDisabled={editorDirty}
        closeDisabledReason={t('aiAgentsPage.unsavedSchedule.closeBlocked')}
      >
        {editing && (
          <AiAgentForm
            // The draft lives in the form's own state, seeded once at mount. With
            // the list still on screen, switching edit targets kept the previous
            // draft and PATCHed the newly-selected agent with the old agent's
            // policy. Keying on the target remounts it instead.
            key={editing.agent?.id ?? 'new'}
            agent={editing.agent}
            onClose={closeEditor}
            onDirtyChange={setEditorDirty}
            onSaved={() => {
              closeEditor();
              void load();
            }}
          />
        )}
      </Drawer>

      {/* The list, first-run panel and disabled section all yield to the
          create flow above while it is open (Task 13, #5051) — this is not
          "hidden AND rendered underneath", it never mounts while creating. */}
      {!creating && (
      <>
      {loading && !loaded && (
        <p className="text-sm text-muted-foreground" data-testid="ai-agents-loading">
          {t('aiAgentsPage.loading')}
        </p>
      )}

      {/* First run, not a blank line of muted text: this is the only place the
          product explains what an agent IS before you are asked to configure
          one, and the safe starting mode is named here rather than discovered
          from the mode cards. Gated on the FULL list, disabled rows included —
          a tenant that has disabled its only agent has not "no agents yet". */}
      {showFirstRun && (
        <EmptyState
          testId="ai-agents-empty"
          headingLevel={2}
          icon={<Bot className="h-7 w-7" />}
          title={t('aiAgentsPage.emptyState.title')}
          description={t('aiAgentsPage.emptyState.description')}
          intro={
            // Above the CTA, not trailing after it: the glossary is what tells
            // an operator which kind to pick, so it has to be read first. Two
            // real columns, so the terms line up instead of each definition
            // starting wherever its term happened to end.
            <dl
              className="mx-auto grid max-w-md grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-left text-xs"
              data-testid="ai-agents-kind-glossary"
            >
              {/* dt/dd are direct grid children — no wrapper, no subgrid — so
                  the three definitions share one measured term column and
                  actually line up. Wrapped in flex rows they each started
                  wherever their own term happened to end. */}
              {AI_AGENT_KINDS.map((kind) => (
                <Fragment key={kind}>
                  <dt className="font-medium text-foreground">{KIND_LABEL[kind]}</dt>
                  <dd className="text-muted-foreground">{KIND_HINT[kind]}</dd>
                </Fragment>
              ))}
            </dl>
          }
          action={
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
              data-testid="ai-agents-empty-create"
            >
              <Plus className="h-4 w-4" />
              {t('aiAgentsPage.emptyState.action')}
            </button>
          }
        />
      )}

      {/* Every agent disabled is a real state with a real recovery, and it is
          NOT the first-run state — saying "No agents yet" here hid both the
          run history and the way back. The primary CTA is Re-enable-oriented
          (the Disabled section is already expanded by the effect above; this
          just moves focus down to it) rather than pointing straight back at
          "New agent" — creating a duplicate of the very kind that already has
          one, disabled. */}
      {showAllDisabled && (
        <EmptyState
          testId="ai-agents-all-disabled"
          headingLevel={2}
          icon={<PauseCircle className="h-7 w-7" />}
          title={t('aiAgentsPage.allDisabled.title')}
          description={t('aiAgentsPage.allDisabled.description')}
          action={
            <button
              type="button"
              onClick={() => {
                setDisabledOpen(true);
                // Deferred a frame: the section is already open in this state,
                // but this also has to work the instant `disabledOpen` flips
                // true from false, before that render has committed.
                requestAnimationFrame(() => firstDisabledReenableRef.current?.focus());
              }}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
              data-testid="ai-agents-all-disabled-reenable"
            >
              {t('aiAgentsPage.allDisabled.reenableCta')}
            </button>
          }
          secondary={
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted"
              data-testid="ai-agents-all-disabled-create"
            >
              <Plus className="h-4 w-4" />
              {t('aiAgentsPage.actions.add')}
            </button>
          }
        />
      )}

      {live.length > 0 && (
        <>
        <span id={allOrgsHintId} className="sr-only">{t('aiAgentsPage.allOrgsHint')}</span>
        <span id={inertHintId} className="sr-only">{t('aiAgentsPage.inertBadge.hint')}</span>
        <ul className="divide-y rounded-lg border" data-testid="ai-agents-list">
          {live.map((agent) => (
            <li
              key={agent.id}
              className={`flex flex-wrap items-center gap-3 p-3 ${
                highlightedAgentId === agent.id ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''
              }`}
              data-testid={`ai-agent-row-${agent.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{agent.name}</span>
                  {/* One badge idiom per row. This used to be a bespoke
                      `bg-muted` pill sitting beside two `badgeClass` badges —
                      a different shape for the same kind of information, and
                      4.2:1 against its own background in light mode. */}
                  <span
                    className={badgeClass('neutral', { size: 'sm' })}
                    aria-label={`${t('aiAgentsPage.chipLabels.kind')}: ${t(/* i18n-dynamic */ `aiAgentsPage.kinds.${agent.kind}`)}`}
                    data-testid={`ai-agent-kind-badge-${agent.id}`}
                  >
                    {t(/* i18n-dynamic */ `aiAgentsPage.kinds.${agent.kind}`)}
                  </span>
                  {agent.allOrgs && (
                    // `title=` alone is invisible to touch and to keyboard
                    // users, so the explanation is a real described-by node.
                    <span
                      className={badgeClass('info', { size: 'sm' })}
                      aria-describedby={allOrgsHintId}
                      aria-label={`${t('aiAgentsPage.chipLabels.ownership')}: ${t('aiAgentsPage.allOrgs')}`}
                      data-testid={`ai-agent-allorgs-${agent.id}`}
                    >
                      {t('aiAgentsPage.allOrgs')}
                    </span>
                  )}
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {/* One word, not the editor's full sentence ("Shadow —
                      investigate and propose only") — this is a row chip
                      among four others, not the place to re-explain the
                      mode. */}
                  <span
                    className={badgeClass(modeTone(agent.mode), { size: 'sm' })}
                    aria-label={`${t('aiAgentsPage.chipLabels.mode')}: ${t(/* i18n-dynamic */ `aiAgentsPage.modeChoice.${agent.mode}`)}`}
                  >
                    {t(/* i18n-dynamic */ `aiAgentsPage.modeChoice.${agent.mode}`)}
                  </span>
                  {/* Deliberately NOT "Enabled"/"Disabled" (Finding 1): those
                      words are also the Disabled SECTION's own name, so a
                      just-restored agent — enabled: false by design, see the
                      re-enable note below — read as if it had landed back in
                      that section. "Running"/"Not running" names the thing
                      this badge actually reports. */}
                  {/* #5380: an enabled row on a server where the subsystem
                      is off is NOT running — it reported "Running" for hours
                      on US prod while every trigger was a no-op. The third
                      state says the row is on AND that nothing will fire. */}
                  {/* Paper cut 22: paired with the last-run badge below, this
                      can print the same word ("Running") with nothing visibly
                      telling them apart — a caption, not only an aria-label. */}
                  <span className="inline-flex items-center gap-1">
                    <span
                      className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                      aria-hidden="true"
                      data-testid={`ai-agent-running-badge-label-${agent.id}`}
                    >
                      {t('aiAgentsPage.chipLabels.running')}
                    </span>
                    <span
                      className={badgeClass(runningTone(agent.enabled), { size: 'sm' })}
                      aria-label={`${t('aiAgentsPage.chipLabels.running')}: ${runningLabel(agent.enabled)}`}
                      data-testid={`ai-agent-running-badge-${agent.id}`}
                    >
                      {runningLabel(agent.enabled)}
                    </span>
                  </span>
                  {/* #4170: an org-only row is an override of a partner
                      baseline, never a standalone policy — with no baseline
                      for its kind, the resolver treats it as if it did not
                      exist, regardless of what `enabled`/`mode` say above. */}
                  {!agent.allOrgs && agent.hasPartnerBaseline === false && (
                    <span
                      className={badgeClass('warning', { size: 'sm' })}
                      aria-describedby={inertHintId}
                      aria-label={`${t('aiAgentsPage.chipLabels.baseline')}: ${t('aiAgentsPage.inertBadge.label')}`}
                      data-testid={`ai-agent-inert-badge-${agent.id}`}
                    >
                      {t('aiAgentsPage.inertBadge.label')}
                    </span>
                  )}
                  {lastRunCell(agent)}
                  {nextOccurrenceCell(agent)}
                </p>
                {justReenabledId === agent.id && (
                  <p
                    className="mt-1 text-xs text-muted-foreground"
                    data-testid={`ai-agent-reenabled-note-${agent.id}`}
                  >
                    {t('aiAgentsPage.reenableNote')}
                  </p>
                )}
              </div>
              {/* A real navigation, not a fragment on this page — a plain
                  anchor, so cmd-click and the browser's own affordances work. */}
              <a
                href={`/ai-agents/runs#agent=${agent.id}`}
                className="rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                data-testid={`ai-agent-runs-link-${agent.id}`}
              >
                {t('aiAgentsPage.actions.runs')}
              </a>
              {runNowButton(agent)}
              <button
                type="button"
                onClick={() => openEditor({ agent })}
                className="rounded-md border px-3 py-1.5 text-sm font-medium"
                data-testid={`ai-agent-edit-${agent.id}`}
              >
                {t('aiAgentsPage.actions.edit')}
              </button>
            </li>
          ))}
        </ul>
        </>
      )}

      {/* Collapsed by default, because a retired agent must not compete with
          the live ones — but present, because until this section existed a
          disabled agent was simply gone from the product with its runs and
          schedules still in the database. */}
      {disabled.length > 0 && (
        <details
          className="rounded-lg border"
          open={disabledOpen}
          onToggle={(event) => setDisabledOpen(event.currentTarget.open)}
          data-testid="ai-agents-disabled-section"
        >
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
            {t('aiAgentsPage.disabledSection.title')}
            {/* The count as a badge rather than inside the label: no plural
                family to carry through eight catalogs for a number. */}
            <span className={badgeClass('muted', { size: 'sm' })}>{disabled.length}</span>
          </summary>
          <p className="px-3 pb-2 text-xs text-muted-foreground">
            {t('aiAgentsPage.disabledSection.hint')}
          </p>
          <ul className="divide-y border-t">
            {disabled.map((agent, index) => (
              <li
                key={agent.id}
                className="flex flex-wrap items-center gap-3 p-3"
                data-testid={`ai-agent-disabled-row-${agent.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{agent.name}</span>
                    <span
                      className={badgeClass('neutral', { size: 'sm' })}
                      aria-label={`${t('aiAgentsPage.chipLabels.kind')}: ${t(/* i18n-dynamic */ `aiAgentsPage.kinds.${agent.kind}`)}`}
                    >
                      {t(/* i18n-dynamic */ `aiAgentsPage.kinds.${agent.kind}`)}
                    </span>
                    {agent.allOrgs && (
                      <span
                        className={badgeClass('info', { size: 'sm' })}
                        aria-describedby={allOrgsHintId}
                        aria-label={`${t('aiAgentsPage.chipLabels.ownership')}: ${t('aiAgentsPage.allOrgs')}`}
                      >
                        {t('aiAgentsPage.allOrgs')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {t('aiAgentsPage.disabledSection.disabledAt', {
                        at: formatDateTime(agent.disabledAt),
                      })}
                    </span>
                    {lastRunCell(agent)}
                    {/* A disabled agent never fires, so this reads "—" for
                        every row here — kept for column parity with the live
                        list above rather than as live information. */}
                    {nextOccurrenceCell(agent)}
                  </p>
                </div>
                <a
                  href={`/ai-agents/runs#agent=${agent.id}`}
                  className="rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                  data-testid={`ai-agent-disabled-runs-link-${agent.id}`}
                >
                  {t('aiAgentsPage.actions.runs')}
                </a>
                <button
                  type="button"
                  // The all-disabled empty state's primary CTA focuses THIS
                  // button on the first row (Finding 4) — only ever the first,
                  // so re-enabling agents one at a time never leaves the ref
                  // pointing at a row that has since left the list.
                  ref={index === 0 ? firstDisabledReenableRef : undefined}
                  onClick={() => void reenable(agent)}
                  disabled={enablingId !== null}
                  className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                  data-testid={`ai-agent-reenable-${agent.id}`}
                >
                  {t('aiAgentsPage.actions.reenable')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      </>
      )}
    </div>
  );
}
