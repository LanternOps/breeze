import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentCeilingDto } from '@breeze/shared';
import PolicyKeysCheckboxes, {
  collapsedForCeiling,
  policyActionLabel,
  sentenceCase,
  type PolicyDecidableKeyOption,
} from '../PolicyKeysCheckboxes';
import ScriptAuthorizationPicker from '../ScriptAuthorizationPicker';
import { listField, numberField, RecipientRolesFieldset, type RoleOption } from '../agentFields';
import { allowsRunScript, toggle, type Draft } from '../agentDraft';

// Re-exported so `AgentCreateFlow.tsx`'s `import { type RoleOption } from
// './steps/SafetyStep'` keeps resolving — `RoleOption` itself now lives in
// `agentFields.tsx` (Task 13, #5051 review) alongside the field helpers this
// step shares with `AiAgentForm.tsx`.
export type { RoleOption };

export interface SafetyStepProps {
  draft: Draft;
  patch: (values: Partial<Draft>) => void;
  /** The partner baseline's projection for an org draft (`useAgentToolCatalog`);
   *  `null` for a partner draft or when no baseline exists. Narrows which
   *  scripts an org row may authorize (#5065). */
  ceiling: AgentCeilingDto | null;
  /** An org draft's ceiling fetch failed, so `ceiling === null` is "unknown",
   *  not "no baseline" — the script picker locks rather than offering an
   *  unrestricted choice the server would 422 (#5089 review). */
  ceilingFailed?: boolean;
  roles: RoleOption[];
  rolesFailed: boolean;
  policyKeys: PolicyDecidableKeyOption[];
  policyKeysFailed: boolean;
  /** Rendered inside the edit drawer (an existing row) rather than the
   *  guided create flow. An org row's read-only held-keys list is only
   *  meaningful there: a brand-new org draft holds no keys and the grant path
   *  it points at (the Graduation panel) is mounted by the drawer alone. */
  editing?: boolean;
}

/**
 * "Safety and oversight" — step 3 of the guided create flow (spec §4.6) AND
 * the same block of the edit drawer (`AiAgentForm.tsx`, #5063): protected
 * resources, the six exposed limits, recipient roles and the unattended
 * policy authorization registry. One rendering per setting, so the two
 * surfaces cannot drift.
 *
 * The registry has three shapes, all driven by the draft alone:
 * - PARTNER row: the interactive checkbox registry — a partner row's keys are
 *   a CEILING on what its organizations may be granted (P2-5, #4192), so it
 *   is offered regardless of the row's own mode, collapsed behind a summary
 *   while the row is not acting (`collapsedForCeiling`).
 * - ORG row in act mode, EDITING an existing row (or a draft that somehow
 *   holds keys): a read-only list of the keys the row already holds. #5049:
 *   the API refuses any org-row write that ADDS a key — a key goes live on an
 *   org row only through the four-eyes grant executor — so a checkbox here
 *   could never be honored by Save, and the rest of the registry (never
 *   held) is noise, not information.
 * - ORG row in act mode on a brand-new create draft: nothing — it holds no
 *   keys, and the grant path the read-only list points at (the Graduation
 *   panel) is mounted by the drawer only (#5063 review).
 * - ORG row not in act mode: nothing — the "act acknowledgement pattern":
 *   additional unattended authority is only shown once the operator is
 *   already looking at the act-mode warning.
 */
export default function SafetyStep({
  draft,
  patch,
  ceiling,
  ceilingFailed = false,
  roles,
  rolesFailed,
  policyKeys,
  policyKeysFailed,
  editing = false,
}: SafetyStepProps) {
  const { t } = useTranslation('settings');
  const limitsBudgetId = useId();
  const limitsTimingId = useId();

  const orgOwned = draft.ownerScope === 'organization';
  const showPolicyDecide =
    draft.ownerScope === 'partner'
    || (draft.mode === 'act' && (editing || draft.supervisedActionKeys.length > 0));

  /** Registry entries keyed by their `key`, so an org row's read-only list
   *  can translate its currently-held keys without walking the full
   *  registry-grouped-by-tool structure the checkboxes build. */
  const policyKeysByKey = useMemo(
    () => new Map(policyKeys.map((entry) => [entry.key, entry] as const)),
    [policyKeys],
  );

  const orgHeldKeysList = draft.supervisedActionKeys.length === 0 ? (
    <p className="text-sm text-muted-foreground" data-testid="ai-agent-policy-keys-empty">
      {t('aiAgentsPage.fields.supervisedActionKeysNoneHeld')}
    </p>
  ) : (
    <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="ai-agent-supervised-keys-readonly-list">
      {draft.supervisedActionKeys.map((key) => {
        const entry = policyKeysByKey.get(key);
        return (
          <li key={key} data-testid={`ai-agent-supervised-key-${key}`}>
            {entry ? policyActionLabel(t, entry) : sentenceCase(key)}
          </li>
        );
      })}
    </ul>
  );

  const policyKeysCheckboxes = (
    <PolicyKeysCheckboxes
      policyKeys={policyKeys}
      policyKeysFailed={policyKeysFailed}
      selectedKeys={draft.supervisedActionKeys}
      onToggle={(key) => patch({ supervisedActionKeys: toggle(draft.supervisedActionKeys, key) })}
    />
  );
  const policyKeysBody = orgOwned ? orgHeldKeysList : policyKeysCheckboxes;

  const ceilingHint = draft.ownerScope === 'partner' && (
    <p className="text-xs text-muted-foreground" data-testid="ai-agent-supervised-keys-ceiling-hint">
      {t('aiAgentsPage.graduation.ceilingHint')}
    </p>
  );
  const grantOnlyHint = orgOwned && (
    <p className="text-xs text-muted-foreground" data-testid="ai-agent-supervised-keys-grant-only-hint">
      {t('aiAgentsPage.graduation.grantOnlyHint')}
    </p>
  );

  return (
    <div className="space-y-3" data-testid="agent-step-safety">
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

      {showPolicyDecide && (
        <fieldset className="space-y-2 rounded-md border p-3" data-testid="ai-agent-policy-decide">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('aiAgentsPage.sections.policyDecide')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.supervisedActionKeysHint')}</p>
          {/* A shadow/off partner row's registry starts collapsed behind a
              summary that counts the selection, since ticking a key here
              authorizes nothing on its own until an organization's row is
              acting. Entering act mode unwraps it entirely. */}
          {collapsedForCeiling(draft.ownerScope, draft.mode) ? (
            <details data-testid="ai-agent-policy-keys-details">
              <summary className="cursor-pointer text-xs font-medium">
                {t('aiAgentsPage.fields.supervisedActionKeysCeilingSummary', {
                  count: draft.supervisedActionKeys.length,
                })}
              </summary>
              <div className="mt-1 space-y-2">
                {ceilingHint}
                {/* Only a PARTNER row ever collapses (`collapsedForCeiling`),
                    so this is always the interactive registry — spelled out
                    rather than routed through `policyKeysBody`, so a later
                    widening of the collapse rule cannot silently tuck an org
                    row's read-only list under the partner-ceiling summary. */}
                {policyKeysCheckboxes}
              </div>
            </details>
          ) : (
            <>
              {ceilingHint}
              {grantOnlyHint}
              {policyKeysBody}
            </>
          )}
        </fieldset>
      )}

      {/* #5065: the scripts `run_script` may execute unattended — shown under
          the same gate as the registry above (act mode, or a partner row
          whose list is the ceiling for its organizations). */}
      {showPolicyDecide && (
        <ScriptAuthorizationPicker
          ownerScope={draft.ownerScope}
          ceiling={ceiling}
          ceilingUnavailable={draft.ownerScope === 'organization' && ceilingFailed}
          runScriptAllowed={allowsRunScript(draft.toolAllowlist)}
          selectedIds={draft.scriptIds}
          onChange={(scriptIds) => patch({ scriptIds })}
        />
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
