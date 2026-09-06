import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AI_AGENT_KINDS,
  type AiAgentDto,
  type AiAgentKind,
  type AiAgentMode,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { useOrgScope } from '@/hooks/useOrgScope';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import AiAgentSchedulesSection from './AiAgentSchedulesSection';
import AiAgentGraduationPanel from './AiAgentGraduationPanel';
import { useAgentToolCatalog } from './aiAgents/useAgentToolCatalog';
import ModeChoice from './aiAgents/ModeChoice';
import { useAgentFormLists } from './aiAgents/useAgentFormLists';
import { AGENT_ERROR_COPY, agentSaveIssuesFromError } from './aiAgents/agentErrors';
import WhatItDoesStep from './aiAgents/steps/WhatItDoesStep';
import SafetyStep from './aiAgents/steps/SafetyStep';
import { ALERT_SEVERITY_KINDS, authorizedScriptCountFor, buildAgentSaveBody, type Draft, draftFrom } from './aiAgents/agentDraft';

export type { AiAgentDto };
export type { Draft } from './aiAgents/agentDraft';

interface Props {
  agent: AiAgentDto;
  onClose: () => void;
  onSaved: () => void;
  /**
   * Fires when this form starts or stops holding unsaved work of its own (an
   * edited schedule draft, which persists through a separate endpoint).
   *
   * Lifted to the parent because the DRAWER owns three of the four ways out —
   * Escape, the header X and the backdrop — and none of them could see a guard
   * that lived down here. The form used to defend the only exit it controlled,
   * its own Cancel button, while the reflexive ones discarded the draft
   * silently.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';
const INSTRUCTIONS_MAX = 2000;

/**
 * Edit form for one existing AI agent policy row. Create is handled entirely
 * by the guided create flow (`AgentCreateFlow.tsx`, Task 13 #5051) —
 * `AiAgentsPage.tsx` opens this drawer only for `openEditor`, never for
 * "New agent" — so `kind` and `ownerScope` are fixed for the life of this
 * form: the API has no update path for either (an agent's identity is
 * `(owner, kind)`, and both unique indexes are partial on `disabled_at IS
 * NULL`), which is exactly why they are rendered read-only below rather than
 * as the editable controls the create flow's Purpose step offers.
 */
export default function AiAgentForm({
  agent,
  onClose,
  onSaved,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation('settings');
  const orgScope = useOrgScope();
  // The schedules section asks whether this session may write partner-wide
  // policy at all (canManagePartnerWidePolicies' client-side counterpart) —
  // independent of this agent's own `ownerScope`.
  const { isPartnerScope } = useDefaultOwnerScope();

  // `agent.ownerScope`/`agent.kind` feed `draftFrom`'s `defaults` param only
  // as a type-satisfying placeholder — `agent` is always present here (this
  // form is edit-only), so `draftFrom`'s own `agent?.ownerScope ?? defaults.*`
  // fallbacks never actually reach for it. The create flow
  // (`AgentCreateFlow.tsx`) is the caller that exercises real defaults.
  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(agent, { ownerScope: agent.ownerScope, kind: agent.kind }),
  );

  // Captured once at mount (the parent keys this form by agent id, so a new
  // edit target remounts rather than reusing state — see
  // "does not carry a stale draft" below). The acknowledgement gate only
  // applies to a genuine transition INTO act mode, not to every subsequent
  // edit of an agent that is already acting.
  const [initialMode] = useState<AiAgentMode>(agent.mode);
  const [actAck, setActAck] = useState(false);
  const enteringActMode = draft.mode === 'act' && initialMode !== 'act';

  // Recipient roles + the policy-decidable registry — one hook, shared with
  // the guided create flow (#5063 review), so the two forms cannot drift on
  // how a failed fetch is told apart from a genuinely empty list.
  const { roles, rolesFailed, policyKeys, policyKeysFailed } = useAgentFormLists();
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  /** An unsaved schedule draft is open below (AiAgentSchedulesSection reports
   *  it). Schedules persist through their own endpoint, so the agent's Save
   *  would close the drawer and discard it silently. */
  const [scheduleDirty, setScheduleDirty] = useState(false);
  /** Cancel pressed while a schedule draft is unsaved. Cancel is the
   *  DELIBERATE exit, so it stays live and asks rather than going inert — the
   *  inert version taught operators to reach for the X instead, which is
   *  exactly the exit that used to discard the draft without a word. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Same latest-ref idiom AiAgentSchedulesSection uses for its own reporter: an
  // inline `onDirtyChange={...}` at the call site must not re-fire this on
  // every parent render, only on a change of DIRTINESS.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(scheduleDirty);
  }, [scheduleDirty]);
  // Unmounting is not "the operator resolved the draft" — but the draft goes
  // with it, and leaving the parent latched dirty would wedge the next agent's
  // drawer shut.
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);
  /**
   * Riley bug (#4187 UI critique): leaving act mode used to only HIDE the
   * supervised-keys fieldset, so Save still submitted keys the operator
   * could no longer see. The first fix over-corrected by CLEARING
   * `draft.supervisedActionKeys` on the way out of act, which meant an
   * act -> shadow -> act round trip silently lost a persisted grant list the
   * operator never touched (P2 review finding).
   *
   * The keys now stay in the draft for the whole life of the form —
   * `selectMode` below never touches them — and are omitted only from the
   * SAVE PAYLOAD while `draft.mode !== 'act'` (see `save()`'s `actAssets`).
   * This derived flag drives the announcement of that omission; it is not
   * separate state, so it can never drift from what Save will actually send.
   *
   * #5049: an ORG row never sends `actAssets` at all any more (see `save()`)
   * — leaving act mode there does not clear anything server-side, it just
   * stops offering a control the server would reject a grant through. This
   * flag would otherwise announce a "cleared" that no longer happens.
   */
  const actKeysWillBeOmitted =
    draft.ownerScope !== 'organization' && draft.mode !== 'act' && draft.supervisedActionKeys.length > 0;

  const patch = (values: Partial<Draft>) => setDraft((current) => ({ ...current, ...values }));

  const nameInputId = useId();
  const nameErrorId = useId();
  /** Name has been left at least once. Until then an empty Name is "not
   *  filled in yet", not an error — a form that goes red before the operator
   *  has reached the field is scolding them for a field they were on their
   *  way to. */
  const [nameTouched, setNameTouched] = useState(false);
  const nameInvalid = nameTouched && draft.name.trim() === '';

  // ---- Mode: the privileged choice --------------------------------------
  const actSupported = agent.supportedModes.includes('act');

  // Task 10 (#5050): the capability picker replaces the free-text tool
  // allowlist textarea. `catalog` is fetched once per mount; `ceiling`
  // re-fetches whenever kind or ownerScope changes (only meaningful for an
  // organization-owned draft — see the hook's own doc). Neither fetch ever
  // blocks this form: a failed/absent catalog falls back to the old
  // textarea below (see the Permissions section).
  const { catalog: fetchedCatalog, ceiling, ceilingResolved, ceilingFailed, loading: catalogLoading } = useAgentToolCatalog({
    kind: draft.kind,
    ownerScope: draft.ownerScope,
  });
  // Defensive, same reasoning as the policy-decidable-keys row filter above:
  // this catalog is server-owned, so a shape the picker cannot use must
  // degrade to the textarea fallback, never crash the form on
  // `catalog.tools`/`catalog.presets`.
  const catalog = fetchedCatalog && Array.isArray(fetchedCatalog.tools) && fetchedCatalog.presets ? fetchedCatalog : null;

  const save = useCallback(async () => {
    if (saving) return;
    // A schedule saves through its OWN request. Letting the agent Save run
    // while one is half-written closed the drawer and threw the draft away
    // without a word; the footer says why the button is inert.
    if (scheduleDirty) return;
    const problems: string[] = [];
    if (!draft.name.trim()) {
      problems.push(t('aiAgentsPage.issues.name'));
      // Also mark the field itself, so the summary at the top of the form and
      // the control it is about say the same thing.
      setNameTouched(true);
    }
    // `alertSeverities` is `.min(1)` server-side — an empty list is not
    // "all severities", it is a 400. Only asked of the kinds that can read it
    // (ALERT_SEVERITY_KINDS); for the others the field is hidden AND omitted
    // below, so there is nothing here to be empty.
    if (ALERT_SEVERITY_KINDS.has(draft.kind) && draft.severities.length === 0) {
      problems.push(t('aiAgentsPage.issues.severities'));
    }
    if (problems.length > 0) {
      setIssues(problems);
      return;
    }
    setIssues([]);
    setSaving(true);

    // Task 13 (#5051), order-of-work step 1: the body is built by the SAME
    // `buildAgentSaveBody` the guided create flow uses, so an identical draft
    // produces an identical PATCH/POST body from either surface — see
    // `agentDraft.ts` for the merge/omission reasoning this used to carry
    // inline. `isCreate: false` unconditionally: this form only ever edits
    // (see the module doc) — the guided create flow is the only caller that
    // ever passes `true`.
    const body = buildAgentSaveBody(draft, { isCreate: false, orgId: orgScope.orgId });

    let saved = false;
    try {
      await runAction({
        // Inline thunk: the no-silent-mutations guard is a lexical AST check,
        // so a hoisted request function reads as an unwrapped mutation (#2429).
        request: () => fetchWithAuth(`/ai/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
        successMessage: t('aiAgentsPage.toasts.saved'),
        errorFallback: t('aiAgentsPage.toasts.saveFailed'),
        // Without this the operator sees the raw machine token the API puts in
        // `error` — literally "agent_kind_exists: triage".
        friendly: (code) => AGENT_ERROR_COPY[code]?.(t),
        onUnauthorized: UNAUTHORIZED
      });
      saved = true;
    } catch (err) {
      // Project rule: 401 is handled by the redirect, other ActionErrors were
      // already toasted by runAction, and anything else must still be loud.
      handleActionError(err, t('aiAgentsPage.toasts.saveFailed'));
      // The client-side ack checkbox is only a UX nudge — the server's 422
      // prerequisites (Task 6, #3826) are authoritative, e.g. the agent's
      // recipients or act-eligible tools changed between load and save.
      // Surfaces exactly what the server named as unmet/rejected, not just
      // the generic toast — same mapping the guided create flow's `create()`
      // uses, so the two can never read a 422 differently.
      // `recipients.userIds` is API-only (the draft never carries it, the
      // PATCH merge preserves it) but still counts as "selected" here —
      // a stale user recipient must read as unreachable, not as absent.
      const fieldIssues = agentSaveIssuesFromError(err, t, {
        recipientsSelected: draft.roleIds.length > 0 || (agent.recipients?.userIds?.length ?? 0) > 0,
      });
      if (fieldIssues) setIssues(fieldIssues);
    } finally {
      setSaving(false);
    }
    // Outside the try: a render error thrown by the parent's reload must not
    // be reported to the operator as "could not save the agent".
    if (saved) onSaved();
  }, [agent, draft, orgScope.orgId, saving, scheduleDirty, onSaved, t]);

  const disable = useCallback(async () => {
    // `saving` guards this too: without it a double-click fires two DELETEs and
    // the second answers 404, so the operator sees a success toast AND
    // "Agent not found" for the kill switch they just used successfully.
    if (!agent || saving) return;
    // The dialog stays MOUNTED for the whole request, driven by `isLoading`,
    // and is closed in `finally`. Tearing it down here instead meant its
    // focus-restore fired while `saving` had already disabled the Disable
    // button it was restoring to — `.focus()` on a disabled element is a
    // no-op, so a keyboard user was dropped onto <body> in the middle of the
    // one action on this form that cannot be undone from here.
    setSaving(true);
    let disabled = false;
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/agents/${agent.id}`, { method: 'DELETE' }),
        successMessage: t('aiAgentsPage.toasts.disabled'),
        errorFallback: t('aiAgentsPage.toasts.disableFailed'),
        friendly: (code) => AGENT_ERROR_COPY[code]?.(t),
        onUnauthorized: UNAUTHORIZED
      });
      disabled = true;
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.toasts.disableFailed'));
    } finally {
      setSaving(false);
      setConfirmDisable(false);
    }
    if (disabled) onSaved();
  }, [agent, onSaved, saving, t]);

  /** The mode radiogroup, extracted to `ModeChoice.tsx` (Task 13, #5051) so
   *  the guided create flow's Purpose step renders the identical control —
   *  a pure move, every test id unchanged. Rendered as the first block of
   *  the form, before Kind and Name: it is the only choice here that can
   *  reach a device. */
  const modeChoice = (
    <ModeChoice
      mode={draft.mode}
      onChange={(mode) => patch({ mode })}
      actSupported={actSupported}
      enteringActMode={enteringActMode}
      actAck={actAck}
      onActAckChange={setActAck}
      actKeysWillBeOmitted={actKeysWillBeOmitted}
    />
  );

  // The DRAFT's scriptIds (#5065 — live as the operator ticks scripts on
  // the Safety step below), narrowed the way effectivePolicy.ts computes the
  // effective list (`authorizedScriptCountFor`: partner ∩ org, and nothing
  // at all when the baseline bars run_script). Until an org row's ceiling
  // is actually KNOWN, nothing counts as authorized: `ceiling === null`
  // would otherwise read as "no ceiling" while the fetch is still in flight
  // or has failed, and badge run_script as unattended (#5063, #5089 review).
  const authorizedScriptCount = !ceilingResolved || ceilingFailed
    ? 0
    : authorizedScriptCountFor(draft.scriptIds, ceiling);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-agent-editor">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
        {issues.length > 0 && (
          <ul
            className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive"
            data-testid="ai-agent-issues"
          >
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {modeChoice}

          {/* `kind` and `ownerScope` are create-only (see the module doc) —
              this form only ever edits, so both render as fixed rather than
              as the editable owner-scope selector / kind picker the create
              flow's Purpose step offers. */}
          <label className="space-y-1 text-sm">
            <span className="font-medium">{t('aiAgentsPage.fields.kind')}</span>
            <select
              className={inputCls}
              value={draft.kind}
              disabled
              onChange={(e) => patch({ kind: e.target.value as AiAgentKind })}
              data-testid="ai-agent-kind"
            >
              {AI_AGENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(/* i18n-dynamic */ `aiAgentsPage.kinds.${kind}`)}
                </option>
              ))}
            </select>
            <span className="block text-xs text-muted-foreground">
              {t('aiAgentsPage.fields.kindImmutable')}
            </span>
          </label>

          {/* The only required free-text field on the form, and it used to
              look exactly like the optional ones — the first sign it was
              required was a Save that refused. Marked with the repo's
              required convention (the destructive-toned asterisk from
              ApiKeyForm.tsx) and validated on blur, so the operator learns it
              at the field rather than at the button.
              A <div> with `htmlFor` rather than a wrapping <label>: the error
              paragraph is a sibling of the input, and nesting it inside the
              label would fold the error text into the input's own accessible
              name instead of its description. */}
          <div className="space-y-1 text-sm">
            <label className="block font-medium" htmlFor={nameInputId}>
              {t('aiAgentsPage.fields.name')}<span className="text-destructive">*</span>
            </label>
            <input
              id={nameInputId}
              className={`${inputCls} ${nameInvalid ? 'border-destructive' : ''}`}
              maxLength={120}
              required
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid ? nameErrorId : undefined}
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              onBlur={() => setNameTouched(true)}
              data-testid="ai-agent-name"
            />
            {nameInvalid && (
              <p id={nameErrorId} className="text-xs text-destructive" data-testid="ai-agent-name-error">
                {t('aiAgentsPage.issues.name')}
              </p>
            )}
          </div>

          {/* `enabled` and `mode` are two independent gates, and BOTH have to
              pass: runService's admission skips `agent_disabled` before it ever
              looks at the mode, and skips `mode_off` right after. Representable
              nonsense (`enabled: true, mode: 'off'`) is therefore real, and the
              helper below is the only place the form says so. */}
          <div className="space-y-1 self-end text-sm md:col-span-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
                data-testid="ai-agent-enabled"
              />
              <span className="font-medium">{t('aiAgentsPage.fields.enabled')}</span>
            </label>
            <p className="pl-6 text-xs text-muted-foreground" data-testid="ai-agent-enabled-hint">
              {t('aiAgentsPage.fields.enabledHint')}
            </p>
          </div>

          {/* Graduation evidence (P2-5, #4192). NOT gated on `draft.mode ===
              'act'` — evidence an agent already earned is a fact about the
              past, so toggling the draft back to shadow must not make it
              disappear. The panel is read-only-useful with
              `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` off; see its module doc.
              `agent.kind` (stored), not `draft.kind`, since kind is create-only.
              An org-owned agent always reads its OWN org's evidence; a partner
              baseline follows the org switcher, and falls through to the
              partner-wide grouping when it is on "all organizations". */}
          <AiAgentGraduationPanel
            orgId={agent.orgId ?? orgScope.orgId}
            kind={agent.kind}
            isPartnerScope={isPartnerScope}
          />

          {/* #5063: everything from "When it runs" through recipients is the
              guided create flow's own step components — "What it does"
              (runs-when + capability picker) and "Safety and oversight"
              (protected resources, unattended authorization, limits,
              recipients) — so each of those settings has exactly one
              rendering and one test surface; the org-row read-only registry
              and the partner-ceiling collapse (#5049, P2-5) live in
              SafetyStep. What stays the drawer's own: the mode choice, the
              fixed kind, Name, the enabled switch, graduation, schedules,
              Instructions and the Save/Cancel/Disable footer. */}
          <div className="md:col-span-2">
            <WhatItDoesStep
              draft={draft}
              patch={patch}
              catalog={catalog}
              ceiling={ceiling}
              catalogLoading={catalogLoading}
              authorizedScriptCount={authorizedScriptCount}
            />
          </div>
          <div className="md:col-span-2">
            <SafetyStep
              draft={draft}
              patch={patch}
              ceiling={ceiling}
              ceilingFailed={ceilingFailed}
              editing
              roles={roles}
              rolesFailed={rolesFailed}
              policyKeys={policyKeys}
              policyKeysFailed={policyKeysFailed}
            />
          </div>

          {/* Scheduled sweeps (P2-2, #4189). Triage-only, because the API
              refuses every other kind (`agent_kind_not_triage`). Gated on the
              STORED kind, not the draft: kind is create-only, so the two
              cannot diverge on this form. */}
          {agent.kind === 'triage' && (
            <AiAgentSchedulesSection
              agentId={agent.id}
              agentOwnerScope={agent.ownerScope}
              isPartnerScope={isPartnerScope}
              orgId={orgScope.orgId}
              onDirtyChange={setScheduleDirty}
            />
          )}

          <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
              {t('aiAgentsPage.sections.instructions')}
            </legend>
            <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.instructionsHint')}</p>
            <textarea
              className={inputCls}
              rows={5}
              maxLength={INSTRUCTIONS_MAX}
              value={draft.instructions}
              onChange={(e) => patch({ instructions: e.target.value })}
              data-testid="ai-agent-instructions"
            />
            <p className="text-xs text-muted-foreground">
              {t('aiAgentsPage.fields.charactersLeft', { count: INSTRUCTIONS_MAX - draft.instructions.length })}
            </p>
          </fieldset>
        </div>
      </div>

      {/* Outside the scroll area: in the drawer the form now opens in, Save
          must stay reachable without scrolling past the schedules section and
          two graduation tables. */}
      <div className="border-t bg-card px-5 py-4">
        {/* Beside the buttons it explains, not buried in the scroll area
            above: while it is showing, Save and Cancel are inert, and the
            reason has to be visible at the point the operator reaches for
            them. */}
        {scheduleDirty && (
          <p
            className="mb-3 rounded-md border border-warning-strong/50 bg-warning/10 px-3 py-2 text-sm"
            role="status"
            data-testid="ai-agent-schedule-dirty"
          >
            {t('aiAgentsPage.issues.unsavedSchedule')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={
              saving
              || scheduleDirty
              || (enteringActMode && !actAck)
            }
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="ai-agent-save"
          >
            {t('aiAgentsPage.actions.save')}
          </button>
          <button
            type="button"
            onClick={() => (scheduleDirty ? setConfirmDiscard(true) : onClose())}
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            data-testid="ai-agent-cancel"
          >
            {t('aiAgentsPage.actions.cancel')}
          </button>
          {agent && (
            <button
              type="button"
              onClick={() => setConfirmDisable(true)}
              disabled={saving || scheduleDirty}
              className="ml-auto rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive disabled:opacity-60"
              data-testid="ai-agent-disable"
            >
              {t('aiAgentsPage.actions.disable')}
            </button>
          )}
        </div>
      </div>

      {/* The kill switch was a label swap — "Disable" became "Confirm
          disable", stayed armed indefinitely, and never said what disabling
          actually does. Same ConfirmDialog ceremony as every other guarded
          action in the app, and the message names both halves: what stops,
          and what survives.
          `variant="warning"`, not the destructive default: disabling an agent
          is reversible (re-enabling is one checkbox away, and the retained
          text below says what survives), so the destructive red/octagon
          treatment overstated the stakes of a switch, not a deletion. */}
      {agent && (
        <ConfirmDialog
          open={confirmDisable}
          onClose={() => setConfirmDisable(false)}
          onConfirm={() => void disable()}
          variant="warning"
          title={t('aiAgentsPage.disableDialog.title', { name: agent.name })}
          message={t('aiAgentsPage.disableDialog.message')}
          confirmLabel={t('aiAgentsPage.actions.disable')}
          isLoading={saving}
          confirmTestId="ai-agent-disable-confirm"
        >
          <p className="text-sm text-muted-foreground" data-testid="ai-agent-disable-retained">
            {t('aiAgentsPage.disableDialog.retained')}
          </p>
        </ConfirmDialog>
      )}

      {/* Warning, not destructive: nothing persisted is being removed — the
          operator is throwing away a draft that never left the browser. */}
      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        variant="warning"
        title={t('aiAgentsPage.unsavedSchedule.discardTitle')}
        message={t('aiAgentsPage.unsavedSchedule.discardMessage')}
        confirmLabel={t('aiAgentsPage.unsavedSchedule.discardConfirm')}
        confirmTestId="ai-agent-discard-schedule-confirm"
      />
    </div>
  );
}
