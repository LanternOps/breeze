import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Bot, PauseCircle, Plus } from 'lucide-react';
import { AI_AGENT_KINDS } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { useHashState } from '@/lib/useHashState';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { handleActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { badgeClass, modeTone, runStatusTone } from '../aiAgents/statusBadge';
import { Drawer } from '../shared/Drawer';
import { EmptyState } from '../shared/EmptyState';
import AiAgentForm, { type AiAgentDto } from './AiAgentForm';

type Editing = { agent: AiAgentDto | null } | null;

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

  const [agents, setAgents] = useState<AiAgentDto[]>([]);
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
  const allOrgsHintId = useId();

  // Literal keys, not a dynamic `t()` on the token: the closed three-member
  // union is spelled out so the keyUsage guard verifies every label and hint
  // statically (same reason as AiAgentSchedulesSection's `scheduleKindLabel`).
  const KIND_LABEL: Record<(typeof AI_AGENT_KINDS)[number], string> = {
    triage: t('aiAgentsPage.kinds.triage'),
    patch: t('aiAgentsPage.kinds.patch'),
    helpdesk: t('aiAgentsPage.kinds.helpdesk'),
  };
  const KIND_HINT: Record<(typeof AI_AGENT_KINDS)[number], string> = {
    triage: t('aiAgentsPage.kindHints.triage'),
    patch: t('aiAgentsPage.kindHints.patch'),
    helpdesk: t('aiAgentsPage.kindHints.helpdesk'),
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
      const body = (await response.json()) as { data?: unknown };
      // A body we cannot read is an ERROR, not zero agents. `?? []` reported
      // "no agents yet" for a shape change and, worse, told the create form
      // every kind was free — so the next save 409'd on an agent the page had
      // just said did not exist.
      if (!Array.isArray(body.data)) throw new Error('GET /ai/agents: malformed body');
      setAgents(body.data as AiAgentDto[]);
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
    if (!hashAgentId || appliedHashRef.current === hashAgentId) return;
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
  }, [agents, hashAgentId]);

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
  const closeEditor = useCallback(() => {
    setEditing(null);
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
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.toasts.reenableFailed'));
    } finally {
      setEnablingId(null);
      enablingRef.current = false;
    }
    if (enabled) await load();
  }, [load, t]);

  /** The last-run cell: an absolute timestamp plus the run's own outcome
   *  badge, or a plain sentence when the agent has never run. Both matter —
   *  "enabled, shadow" says nothing about whether the agent is actually
   *  doing anything. */
  const lastRunCell = (agent: AiAgentDto) => (
    <span className="inline-flex items-center gap-1.5" data-testid={`ai-agent-lastrun-${agent.id}`}>
      {agent.lastRunAt && agent.lastRunStatus ? (
        <>
          <span className={badgeClass(runStatusTone(agent.lastRunStatus), { size: 'sm' })}>
            {RUN_STATUS_LABEL[agent.lastRunStatus] ?? agent.lastRunStatus}
          </span>
          <span>{t('aiAgentsPage.lastRun.at', { at: formatDateTime(agent.lastRunAt) })}</span>
        </>
      ) : (
        t('aiAgentsPage.lastRun.never')
      )}
    </span>
  );

  const showFirstRun = loaded && !error && agents.length === 0;
  const showAllDisabled = loaded && !error && live.length === 0 && disabled.length > 0;

  const createButton = (testId: string) => (
    <button
      type="button"
      onClick={() => setEditing({ agent: null })}
      className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
      data-testid={testId}
    >
      <Plus className="h-4 w-4" />
      {t('aiAgentsPage.actions.add')}
    </button>
  );

  return (
    <div className="space-y-6" data-testid="ai-agents-page">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Bot className="h-5 w-5" />
            {t('aiAgentsPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('aiAgentsPage.description')}</p>
        </div>
        {/* One create affordance at a time: while the first-run panel is on
            screen it owns the call to action, and a second identical button in
            the header just competes with it. */}
        {!showFirstRun && !showAllDisabled && createButton('ai-agent-create-button')}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('aiAgentsPage.errors.load')}
        </div>
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
            agents={agents}
            showOwnerScope={isPartnerScope}
            defaultOwnerScope={defaultOwnerScope}
            onClose={closeEditor}
            onDirtyChange={setEditorDirty}
            onSaved={() => {
              closeEditor();
              void load();
            }}
          />
        )}
      </Drawer>

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
              onClick={() => setEditing({ agent: null })}
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
          run history and the way back. */}
      {showAllDisabled && (
        <EmptyState
          testId="ai-agents-all-disabled"
          headingLevel={2}
          icon={<PauseCircle className="h-7 w-7" />}
          title={t('aiAgentsPage.allDisabled.title')}
          description={t('aiAgentsPage.allDisabled.description')}
          action={createButton('ai-agents-all-disabled-create')}
        />
      )}

      {live.length > 0 && (
        <>
        <span id={allOrgsHintId} className="sr-only">{t('aiAgentsPage.allOrgsHint')}</span>
        <ul className="divide-y rounded-lg border" data-testid="ai-agents-list">
          {live.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center gap-3 p-3" data-testid={`ai-agent-row-${agent.id}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{agent.name}</span>
                  {/* One badge idiom per row. This used to be a bespoke
                      `bg-muted` pill sitting beside two `badgeClass` badges —
                      a different shape for the same kind of information, and
                      4.2:1 against its own background in light mode. */}
                  <span
                    className={badgeClass('neutral', { size: 'sm' })}
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
                      data-testid={`ai-agent-allorgs-${agent.id}`}
                    >
                      {t('aiAgentsPage.allOrgs')}
                    </span>
                  )}
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className={badgeClass(modeTone(agent.mode), { size: 'sm' })}>
                    {t(/* i18n-dynamic */ `aiAgentsPage.modes.${agent.mode}`)}
                  </span>
                  <span className={badgeClass(agent.enabled ? 'success' : 'muted', { size: 'sm' })}>
                    {agent.enabled ? t('aiAgentsPage.stateEnabled') : t('aiAgentsPage.stateDisabled')}
                  </span>
                  {lastRunCell(agent)}
                </p>
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
              <button
                type="button"
                onClick={() => setEditing({ agent })}
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
            {disabled.map((agent) => (
              <li
                key={agent.id}
                className="flex flex-wrap items-center gap-3 p-3"
                data-testid={`ai-agent-disabled-row-${agent.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{agent.name}</span>
                    <span className={badgeClass('neutral', { size: 'sm' })}>
                      {t(/* i18n-dynamic */ `aiAgentsPage.kinds.${agent.kind}`)}
                    </span>
                    {agent.allOrgs && (
                      <span className={badgeClass('info', { size: 'sm' })} aria-describedby={allOrgsHintId}>
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
    </div>
  );
}
