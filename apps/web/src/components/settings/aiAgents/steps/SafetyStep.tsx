import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import PolicyKeysCheckboxes, { collapsedForCeiling, type PolicyDecidableKeyOption } from '../PolicyKeysCheckboxes';
import { listField, numberField, RecipientRolesFieldset, type RoleOption } from '../agentFields';
import { lines, toggle, type Draft } from '../agentDraft';

// Re-exported so `AgentCreateFlow.tsx`'s `import { type RoleOption } from
// './steps/SafetyStep'` keeps resolving — `RoleOption` itself now lives in
// `agentFields.tsx` (Task 13, #5051 review) alongside the field helpers this
// step shares with `AiAgentForm.tsx`.
export type { RoleOption };

export interface SafetyStepProps {
  draft: Draft;
  patch: (values: Partial<Draft>) => void;
  roles: RoleOption[];
  rolesFailed: boolean;
  policyKeys: PolicyDecidableKeyOption[];
  policyKeysFailed: boolean;
}

/**
 * Step 3 of the guided create flow (spec §4.6): protected resources, the six
 * exposed limits, recipient roles and — for a PARTNER draft only — the
 * unattended-ceiling registry (`PolicyKeysCheckboxes`, extracted from
 * `AiAgentForm.tsx`). An ORG draft shows nothing here: a brand-new org row
 * holds no keys yet, and a key can only go live later through the four-eyes
 * grant executor (spec §4.4) — there is nothing to review or edit at create
 * time.
 */
export default function SafetyStep({ draft, patch, roles, rolesFailed, policyKeys, policyKeysFailed }: SafetyStepProps) {
  const { t } = useTranslation('settings');
  const limitsBudgetId = useId();
  const limitsTimingId = useId();

  // The registry rendering, shared with everything the collapsed/uncollapsed
  // branches below both need.
  const policyKeysCheckboxes = (
    <PolicyKeysCheckboxes
      policyKeys={policyKeys}
      policyKeysFailed={policyKeysFailed}
      selectedKeys={draft.supervisedActionKeys}
      onToggle={(key) => patch({ supervisedActionKeys: toggle(draft.supervisedActionKeys, key) })}
    />
  );
  const ceilingHint = (
    <p className="text-xs text-muted-foreground" data-testid="ai-agent-supervised-keys-ceiling-hint">
      {t('aiAgentsPage.graduation.ceilingHint')}
    </p>
  );

  return (
    <div className="space-y-3">
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          {t('aiAgentsPage.flow.protectedResourcesLegend')}
        </legend>
        <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.protectedHint')}</p>
        <div className="grid gap-3 md:grid-cols-3">
          {listField('ai-agent-services', t('aiAgentsPage.fields.protectedServices'), draft.services, (v) => patch({ services: v }))}
          {listField('ai-agent-paths', t('aiAgentsPage.fields.protectedPaths'), draft.paths, (v) => patch({ paths: v }))}
          {listField('ai-agent-registrykeys', t('aiAgentsPage.fields.protectedRegistryKeys'), draft.registryKeys, (v) => patch({ registryKeys: v }))}
        </div>
      </fieldset>

      {draft.ownerScope === 'partner' && (
        <fieldset className="space-y-2 rounded-md border p-3" data-testid="ai-agent-policy-decide">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('aiAgentsPage.sections.policyDecide')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.supervisedActionKeysHint')}</p>
          {/* Same collapse rule as the edit drawer (`AiAgentForm.tsx`'s
              `policyDecideFieldset`, via the shared `collapsedForCeiling`
              helper): a shadow/off partner draft's registry starts collapsed
              behind a summary that counts the selection, since ticking a key
              here authorizes nothing on its own until the row is acting.
              Entering act mode unwraps it entirely. */}
          {collapsedForCeiling(draft.ownerScope, draft.mode) ? (
            <details data-testid="ai-agent-policy-keys-details">
              <summary className="cursor-pointer text-xs font-medium">
                {t('aiAgentsPage.fields.supervisedActionKeysCeilingSummary', {
                  count: draft.supervisedActionKeys.length,
                })}
              </summary>
              <div className="mt-1 space-y-2">
                {ceilingHint}
                {policyKeysCheckboxes}
              </div>
            </details>
          ) : (
            <>
              {ceilingHint}
              {policyKeysCheckboxes}
            </>
          )}
        </fieldset>
      )}

      <fieldset className="space-y-3 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          {t('aiAgentsPage.sections.limits')}
        </legend>
        <div role="group" aria-labelledby={limitsBudgetId} className="space-y-1.5">
          <p id={limitsBudgetId} className="text-xs font-medium">{t('aiAgentsPage.sections.limitsBudget')}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {numberField('ai-agent-limit-devices', t('aiAgentsPage.fields.maxDevicesPerRun'), draft.limits.maxDevicesPerRun, 1, 50, (v) => patch({ limits: { ...draft.limits, maxDevicesPerRun: v } }))}
            {numberField('ai-agent-limit-runs', t('aiAgentsPage.fields.maxRunsPerHour'), draft.limits.maxRunsPerHour, 1, 500, (v) => patch({ limits: { ...draft.limits, maxRunsPerHour: v } }))}
            {numberField('ai-agent-limit-budget', t('aiAgentsPage.fields.maxBudgetCentsPerDay'), draft.limits.maxBudgetCentsPerDay, 1, 100000, (v) => patch({ limits: { ...draft.limits, maxBudgetCentsPerDay: v } }))}
            {numberField('ai-agent-limit-fleet', t('aiAgentsPage.fields.maxFleetPercentPerDay'), draft.limits.maxFleetPercentPerDay, 1, 100, (v) => patch({ limits: { ...draft.limits, maxFleetPercentPerDay: v } }))}
          </div>
        </div>
        <div role="group" aria-labelledby={limitsTimingId} className="space-y-1.5">
          <p id={limitsTimingId} className="text-xs font-medium">{t('aiAgentsPage.sections.limitsTiming')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {numberField('ai-agent-limit-wallclock', t('aiAgentsPage.fields.wallClockSeconds'), draft.limits.wallClockSeconds, 30, 1800, (v) => patch({ limits: { ...draft.limits, wallClockSeconds: v } }))}
            {numberField('ai-agent-cooldown', t('aiAgentsPage.fields.cooldownSeconds'), draft.cooldownSeconds, 0, 86400, (v) => patch({ cooldownSeconds: v }))}
          </div>
        </div>
      </fieldset>

      <RecipientRolesFieldset
        className="space-y-2 rounded-md border p-3"
        t={t}
        roles={roles}
        rolesFailed={rolesFailed}
        roleIds={draft.roleIds}
        onToggleRole={(id) => patch({ roleIds: toggle(draft.roleIds, id) })}
      />
    </div>
  );
}
