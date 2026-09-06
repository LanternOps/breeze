import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AI_AGENT_KINDS, SUPPORTED_AGENT_MODES, type AiAgentDto } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { handleActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { useOrgScope } from '@/hooks/useOrgScope';
import type { OwnerScope } from '@/hooks/useDefaultOwnerScope';
import SetupStepper from '../../setup/SetupStepper';
import { useAgentToolCatalog } from './useAgentToolCatalog';
import { ALERT_SEVERITY_KINDS, buildAgentSaveBody, draftFrom, firstFreeKind, freeKinds, type Draft } from './agentDraft';
import { AGENT_ERROR_COPY, agentSaveIssuesFromError } from './agentErrors';
import type { PolicyDecidableKeyOption } from './PolicyKeysCheckboxes';
import PurposeStep from './steps/PurposeStep';
import WhatItDoesStep from './steps/WhatItDoesStep';
import SafetyStep, { type RoleOption } from './steps/SafetyStep';
import ReviewStep from './steps/ReviewStep';

export interface AgentCreateFlowProps {
  /** Every agent visible to this session — same prop `AiAgentForm.tsx` takes,
   *  needed to compute which kinds are still free for the chosen owner. */
  agents: AiAgentDto[];
  /** Kinds that already have an active partner-wide baseline for this org's
   *  partner (#4170) — see `AiAgentForm.tsx`'s `partnerBaselineKinds` doc. */
  partnerBaselineKinds: Set<string>;
  /** Show the partner-wide vs org-owned selector (partner-scope sessions only). */
  showOwnerScope: boolean;
  defaultOwnerScope: OwnerScope;
  onCancel: () => void;
  onCreated: (agent: AiAgentDto) => void;
}

const STEP_KEYS = ['purpose', 'does', 'safety', 'review'] as const;
type StepKey = (typeof STEP_KEYS)[number];
/** `AgentSummaryCard`'s `onEdit` names three of the four steps — "review" has
 *  no row that could ever link back to itself. */
type EditSection = 'purpose' | 'does' | 'safety';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

/**
 * The four-step guided create flow (spec §4.6, Task 13 #5051): Purpose and
 * posture -> What it does -> Safety and oversight -> Review and create.
 * Renders full-width in place of the agents list while open. Owns ONE
 * `Draft` (the same shape `AiAgentForm.tsx`'s drawer edits) and builds its
 * `POST /ai/agents` body through the identical `buildAgentSaveBody` — the
 * two surfaces can never diverge on what an identical draft would submit.
 */
export default function AgentCreateFlow({
  agents,
  partnerBaselineKinds,
  showOwnerScope,
  defaultOwnerScope,
  onCancel,
  onCreated,
}: AgentCreateFlowProps) {
  const { t } = useTranslation('settings');
  const orgScope = useOrgScope();

  const [draft, setDraft] = useState<Draft>(() => {
    // An org-only agent only ever OVERRIDES a partner-wide baseline of its
    // kind (#4170); with no baseline yet, the hook's org-owned default (a
    // focused org) would produce an agent that does nothing. A partner-scope
    // session with the selector shown starts partner-wide instead in that
    // case — the operator can still pick "This organization only" (#5048 QA).
    const orgKind = firstFreeKind(agents, 'organization', orgScope.orgId) ?? AI_AGENT_KINDS[0];
    const partnerWideInstead =
      showOwnerScope
      && defaultOwnerScope === 'organization'
      && !partnerBaselineKinds.has(orgKind)
      && freeKinds(agents, 'partner', orgScope.orgId).length > 0;
    const ownerScope: OwnerScope = partnerWideInstead ? 'partner' : defaultOwnerScope;
    return draftFrom(null, {
      ownerScope,
      kind: firstFreeKind(agents, ownerScope, orgScope.orgId) ?? AI_AGENT_KINDS[0],
    });
  });
  const patch = useCallback((values: Partial<Draft>) => setDraft((current) => ({ ...current, ...values })), []);

  const [step, setStep] = useState(0);
  // Furthest step the operator has reached — every step up to it stays
  // reachable from the stepper (an "Edit" link from Review sends them back;
  // returning should not cost three Next clicks — #5048 QA).
  const [maxStepReached, setMaxStepReached] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const [forceNameError, setForceNameError] = useState(false);
  const [actAck, setActAck] = useState(false);
  const [saving, setSaving] = useState(false);

  // Create has no existing agent, so entering act is simply "mode is act" —
  // there is no prior mode to compare against (mirrors AiAgentForm's
  // `initialMode` always being 'off' on create).
  const enteringActMode = draft.mode === 'act';
  const actKeysWillBeOmitted =
    draft.ownerScope !== 'organization' && draft.mode !== 'act' && draft.supervisedActionKeys.length > 0;
  const actSupported = SUPPORTED_AGENT_MODES.includes('act');
  // Mirrors the drawer's `availableKinds.length === 0` Save guard
  // (AiAgentForm.tsx): every kind for this owner is already taken, so
  // there is nothing a further step could do but submit a duplicate that
  // the server would 409 on `agent_kind_exists` anyway.
  const kindsExhausted = freeKinds(agents, draft.ownerScope, orgScope.orgId).length === 0;

  const { catalog: fetchedCatalog, ceiling, loading: catalogLoading } = useAgentToolCatalog({
    kind: draft.kind,
    ownerScope: draft.ownerScope,
  });
  const catalog = fetchedCatalog && Array.isArray(fetchedCatalog.tools) && fetchedCatalog.presets ? fetchedCatalog : null;

  // Same cancelled-flag fetch pattern as AiAgentForm.tsx's own roles effect —
  // a failure must not render as "no roles configured" (see that file's doc).
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [rolesFailed, setRolesFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/roles');
        if (!response.ok) throw new Error(`GET /roles ${response.status}`);
        const body = (await response.json()) as { data?: RoleOption[] };
        if (!cancelled) setRoles(Array.isArray(body.data) ? body.data : []);
      } catch (err) {
        console.error('[AgentCreateFlow] could not load roles', err);
        if (!cancelled) setRolesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Same cancelled-flag fetch pattern as AiAgentForm.tsx's own registry
  // effect — fetched once per mount, rendered only for a partner draft
  // (SafetyStep.tsx).
  const [policyKeys, setPolicyKeys] = useState<PolicyDecidableKeyOption[]>([]);
  const [policyKeysFailed, setPolicyKeysFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/ai/agents/policy-decidable-keys');
        if (!response.ok) throw new Error(`GET /ai/agents/policy-decidable-keys ${response.status}`);
        const body = (await response.json()) as { data?: PolicyDecidableKeyOption[] };
        const rows = Array.isArray(body.data)
          ? body.data.filter(
              (row): row is PolicyDecidableKeyOption =>
                typeof row?.key === 'string' && typeof row?.toolName === 'string',
            )
          : [];
        if (!cancelled) setPolicyKeys(rows);
      } catch (err) {
        console.error('[AgentCreateFlow] could not load policy-decidable keys', err);
        if (!cancelled) setPolicyKeysFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stepLabel = (key: StepKey) => t(/* i18n-dynamic */ `aiAgentsPage.flow.steps.${key}.label`);
  const stepDescription = (key: StepKey) => t(/* i18n-dynamic */ `aiAgentsPage.flow.steps.${key}.description`);

  /** The gate for LEAVING step `index` forward — the same checks whether the
   *  operator clicks Next or jumps ahead from the stepper. */
  const validateStep = (index: number): string[] => {
    const problems: string[] = [];
    if (index === 0 && !draft.name.trim()) {
      problems.push(t('aiAgentsPage.issues.name'));
      setForceNameError(true);
    }
    if (index === 1 && ALERT_SEVERITY_KINDS.has(draft.kind) && draft.severities.length === 0) {
      problems.push(t('aiAgentsPage.issues.severities'));
    }
    return problems;
  };

  const goToStep = (target: number) => {
    const clamped = Math.max(0, Math.min(STEP_KEYS.length - 1, target));
    if (clamped > step) {
      // Validate every step being left behind, not just the current one: a
      // step edited earlier and then backed out of is only ever re-checked
      // here (its own Next was never clicked again).
      const problems: string[] = [];
      for (let index = step; index < clamped; index += 1) problems.push(...validateStep(index));
      if (problems.length > 0) {
        setIssues(problems);
        return;
      }
    }
    setIssues([]);
    setStep(clamped);
    setMaxStepReached((reached) => Math.max(reached, clamped));
  };

  const goBack = () => goToStep(step - 1);
  const goNext = () => goToStep(step + 1);
  const goToSection = (section: EditSection) => goToStep(STEP_KEYS.indexOf(section));

  // Mirrors AiAgentForm.tsx's Save disable condition: an act-mode transition
  // needs the acknowledgement before the operator can move past this step —
  // there is nothing else here for "Next" to gate on for act mode, since a
  // create draft is always "entering" act the first time it's selected.
  const nextDisabled = step === 0 && ((enteringActMode && !actAck) || kindsExhausted);
  // The same gate applies to a forward jump from the stepper.
  const reachableStep = nextDisabled ? step : maxStepReached;

  const create = useCallback(async () => {
    if (saving) return;
    const problems: string[] = [];
    if (draft.ownerScope === 'organization' && !orgScope.orgId) {
      problems.push(t('aiAgentsPage.issues.org'));
    }
    if (problems.length > 0) {
      setIssues(problems);
      return;
    }
    setIssues([]);
    setSaving(true);
    const body = buildAgentSaveBody(draft, { isCreate: true, orgId: orgScope.orgId });

    let created: AiAgentDto | null = null;
    try {
      const result = await runAction<{ data: AiAgentDto }>({
        request: () => fetchWithAuth('/ai/agents', { method: 'POST', body: JSON.stringify(body) }),
        successMessage: t('aiAgentsPage.toasts.saved'),
        errorFallback: t('aiAgentsPage.toasts.saveFailed'),
        friendly: (code) => AGENT_ERROR_COPY[code]?.(t),
        onUnauthorized: UNAUTHORIZED,
      });
      created = result.data;
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.toasts.saveFailed'));
      // Same mapping the edit drawer uses (`agentErrors.ts`), so the two
      // surfaces can never read a 422 differently. The issues render above
      // whichever step the operator lands on, so an Edit link back to
      // Safety keeps the reason in view.
      const fieldIssues = agentSaveIssuesFromError(err, t, { recipientsSelected: draft.roleIds.length > 0 });
      if (fieldIssues) setIssues(fieldIssues);
    } finally {
      setSaving(false);
    }
    if (created) onCreated(created);
  }, [draft, orgScope.orgId, saving, onCreated, t]);

  const orgName = draft.ownerScope === 'organization' ? (orgScope.org?.name ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-create-flow">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <h2 className="text-lg font-semibold">{t('aiAgentsPage.flow.title')}</h2>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-3 py-1.5 text-sm font-medium"
          data-testid="agent-create-flow-cancel"
        >
          {t('aiAgentsPage.actions.cancel')}
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto p-5 md:grid-cols-[220px_minmax(0,1fr)]">
        <SetupStepper
          steps={STEP_KEYS.map((key) => ({ label: stepLabel(key), description: stepDescription(key) }))}
          currentStep={step}
          onStepClick={goToStep}
          reachableStep={reachableStep}
          orientation="vertical"
          ariaLabel={t('aiAgentsPage.flow.stepperAriaLabel')}
        />

        <div className="min-w-0 space-y-3">
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

          {step === 0 && (
            <PurposeStep
              draft={draft}
              patch={patch}
              agents={agents}
              orgId={orgScope.orgId}
              showOwnerScope={showOwnerScope}
              partnerBaselineKinds={partnerBaselineKinds}
              actSupported={actSupported}
              actAck={actAck}
              onActAckChange={setActAck}
              actKeysWillBeOmitted={actKeysWillBeOmitted}
              forceNameError={forceNameError}
            />
          )}
          {step === 1 && (
            <WhatItDoesStep draft={draft} patch={patch} catalog={catalog} ceiling={ceiling} catalogLoading={catalogLoading} />
          )}
          {step === 2 && (
            <SafetyStep
              draft={draft}
              patch={patch}
              roles={roles}
              rolesFailed={rolesFailed}
              policyKeys={policyKeys}
              policyKeysFailed={policyKeysFailed}
            />
          )}
          {step === 3 && (
            <ReviewStep draft={draft} patch={patch} orgId={orgScope.orgId} orgName={orgName} roles={roles} onEdit={goToSection} />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t bg-card px-5 py-4">
        <div>
          {step > 0 && (
            <button
              type="button"
              onClick={goBack}
              className="rounded-md border px-3 py-1.5 text-sm font-medium"
              data-testid="agent-create-flow-back"
            >
              {t('aiAgentsPage.flow.back')}
            </button>
          )}
        </div>
        {step < STEP_KEYS.length - 1 ? (
          <button
            type="button"
            onClick={goNext}
            disabled={nextDisabled}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="agent-create-flow-next"
          >
            {t('aiAgentsPage.flow.next', { step: stepLabel(STEP_KEYS[step + 1]!) })}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void create()}
            disabled={saving || kindsExhausted}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="agent-create-flow-create"
          >
            {t('aiAgentsPage.flow.createAgent')}
          </button>
        )}
      </div>
    </div>
  );
}
