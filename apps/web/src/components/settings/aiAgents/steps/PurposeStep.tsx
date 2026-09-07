import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AI_AGENT_KINDS, type AiAgentDto, type AiAgentKind } from '@breeze/shared';
import ModeChoice from '../ModeChoice';
import { freeKinds, firstFreeKind, type Draft } from '../agentDraft';

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';
const INSTRUCTIONS_MAX = 2000;

export interface PurposeStepProps {
  draft: Draft;
  patch: (values: Partial<Draft>) => void;
  agents: AiAgentDto[];
  orgId: string | null;
  showOwnerScope: boolean;
  partnerBaselineKinds: Set<string>;
  actSupported: boolean;
  actAck: boolean;
  onActAckChange: (checked: boolean) => void;
  actKeysWillBeOmitted: boolean;
  /** Set by the flow when a "Next" click was blocked on an empty name, so the
   *  field shows red even before the operator has focused/blurred it once. */
  forceNameError: boolean;
}

/**
 * Step 1 of the guided create flow (spec §4.6): Mode first — the only choice
 * here that can reach a device — then Kind (as cards, each naming what it
 * does, when it runs and what the recommended preset covers), owner scope,
 * name, and instructions. Mirrors `AiAgentForm.tsx`'s field order and test
 * ids everywhere the same control is reused (`ModeChoice`, the owner-scope
 * fieldset, the no-baseline hint, the name field, the instructions fieldset).
 *
 * Deviation from spec §4.6's literal "name, model, instructions": there is no
 * `model` field anywhere in this codebase's agent policy UI today —
 * `AiAgentForm.tsx`'s `Draft` has never carried one, `createAiAgentSchema`'s
 * `model` always defaults to `null` server-side, and no i18n/test-id
 * convention exists to follow. Adding a first-of-its-kind model selector is
 * out of scope for a task whose job is to reuse the drawer's existing
 * fields — it would need its own design pass (an options source, a default,
 * a save-body slot), not a copy of something that already exists.
 */
export default function PurposeStep({
  draft,
  patch,
  agents,
  orgId,
  showOwnerScope,
  partnerBaselineKinds,
  actSupported,
  actAck,
  onActAckChange,
  actKeysWillBeOmitted,
  forceNameError,
}: PurposeStepProps) {
  const { t } = useTranslation('settings');
  const nameInputId = useId();
  const nameErrorId = useId();
  const [nameTouched, setNameTouched] = useState(false);
  const nameInvalid = (nameTouched || forceNameError) && draft.name.trim() === '';

  const availableKinds = freeKinds(agents, draft.ownerScope, orgId);
  // Create has no existing agent, so entering act is simply "mode is act" —
  // there is no prior mode to compare against (mirrors AiAgentForm's
  // `initialMode` always being 'off' on create).
  const enteringActMode = draft.mode === 'act';

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <ModeChoice
        mode={draft.mode}
        onChange={(mode) => patch({ mode })}
        actSupported={actSupported}
        enteringActMode={enteringActMode}
        actAck={actAck}
        onActAckChange={onActAckChange}
        actKeysWillBeOmitted={actKeysWillBeOmitted}
      />

      {/* Kind, as cards rather than the drawer's `<select>`: each names what
          the kind does, when it runs, and what its recommended preset
          covers — the picker's own "Recommended for {kind}" banner (spec
          §4.5) is what actually applies it, on the next step. A kind already
          taken for this owner scope renders disabled, same rule as the
          drawer's option list (`freeKinds`). */}
      <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2" data-testid="ai-agent-kind">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          {t('aiAgentsPage.fields.kind')}
        </legend>
        <div role="radiogroup" aria-label={t('aiAgentsPage.fields.kind')} className="grid gap-2 sm:grid-cols-3">
          {AI_AGENT_KINDS.map((kind) => {
            const selected = draft.kind === kind;
            const taken = !availableKinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={taken}
                onClick={() => patch({ kind })}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'bg-background hover:border-primary/50 hover:bg-muted/40'
                }`}
                data-testid={`ai-agent-kind-card-${kind}`}
              >
                <span className="text-sm font-medium">{t(/* i18n-dynamic */ `aiAgentsPage.kinds.${kind}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(/* i18n-dynamic */ `aiAgentsPage.flow.kinds.${kind}.blurb`)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('aiAgentsPage.flow.kindCard.runsWhenPrefix')}{' '}
                  {t(/* i18n-dynamic */ `aiAgentsPage.flow.kinds.${kind}.runsWhen`)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('aiAgentsPage.flow.kindCard.recommendedPrefix')}{' '}
                  {t(/* i18n-dynamic */ `aiAgentsPage.flow.kinds.${kind}.recommended`)}
                </span>
                {taken && (
                  <span className="text-xs font-medium text-muted-foreground" data-testid={`ai-agent-kind-card-${kind}-taken`}>
                    {t('aiAgentsPage.flow.kindCard.taken')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {availableKinds.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="ai-agent-kinds-exhausted">
            {t('aiAgentsPage.issues.allKindsTaken')}
          </p>
        )}
      </fieldset>

      {showOwnerScope && (
        <fieldset className="space-y-2 rounded-md border p-3 md:col-span-2" data-testid="ai-agent-ownerscope">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('aiAgentsPage.editor.scopeLegend')}
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="ai-agent-owner"
              value="partner"
              checked={draft.ownerScope === 'partner'}
              onChange={() => patch({ ownerScope: 'partner', kind: firstFreeKind(agents, 'partner', orgId) ?? draft.kind })}
              data-testid="ai-agent-owner-partner"
            />
            {t('aiAgentsPage.editor.allOrgs')}{' '}
            <span className="text-muted-foreground">{t('aiAgentsPage.editor.allOrgsHint')}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="ai-agent-owner"
              value="organization"
              checked={draft.ownerScope === 'organization'}
              onChange={() => patch({ ownerScope: 'organization', kind: firstFreeKind(agents, 'organization', orgId) ?? draft.kind })}
              data-testid="ai-agent-owner-org"
            />
            {t('aiAgentsPage.editor.thisOrg')}
          </label>
        </fieldset>
      )}

      {/* #4170: an org-only agent overrides a partner-wide baseline of the
          same kind — it is never a standalone policy. */}
      {draft.ownerScope === 'organization' && !partnerBaselineKinds.has(draft.kind) && (
        <p
          className="rounded-md border border-amber-300 bg-amber-100 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200 md:col-span-2"
          data-testid="ai-agent-no-baseline-hint"
        >
          {t('aiAgentsPage.inertBadge.hint')}
        </p>
      )}

      <div className="space-y-1 text-sm md:col-span-2">
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

      <p className="text-xs text-muted-foreground md:col-span-2" data-testid="agent-create-flow-disabled-note">
        {t('aiAgentsPage.flow.createdDisabledNote')}
      </p>
    </div>
  );
}
