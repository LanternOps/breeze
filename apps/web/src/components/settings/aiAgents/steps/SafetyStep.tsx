import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import PolicyKeysCheckboxes, { type PolicyDecidableKeyOption } from '../PolicyKeysCheckboxes';
import { lines, toggle, type Draft } from '../agentDraft';

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

/** GET /roles projection. Duplicated from `AiAgentForm.tsx` (small, and the
 *  two never need to stay byte-identical) rather than exported from it —
 *  `AiAgentForm.tsx` has no reason to know this step file exists. */
export interface RoleOption {
  id: string;
  name: string;
  /** `roles.scope` as GET /roles projects it. Optional on the type because an
   *  older API build omits it; such a role is grouped with the organization
   *  roles rather than dropped — a recipient must never disappear because a
   *  field it never had is missing. */
  scope?: 'partner' | 'organization';
}

function roleScope(role: RoleOption): 'partner' | 'organization' {
  return role.scope === 'partner' ? 'partner' : 'organization';
}

/** Rendered in this order; a group with no roles is skipped entirely. */
const ROLE_GROUPS = ['partner', 'organization'] as const;

export interface SafetyStepProps {
  draft: Draft;
  patch: (values: Partial<Draft>) => void;
  roles: RoleOption[];
  rolesFailed: boolean;
  policyKeys: PolicyDecidableKeyOption[];
  policyKeysFailed: boolean;
}

const listField = (
  testId: string,
  label: string,
  value: string,
  onChange: (next: string) => void,
) => (
  <label className="space-y-1 text-sm">
    <span className="font-medium">{label}</span>
    <textarea
      className={`${inputCls} font-mono`}
      rows={2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
    />
  </label>
);

const numberField = (
  testId: string,
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (next: number) => void,
) => (
  <label className="space-y-1 text-sm">
    <span className="font-medium">{label}</span>
    <input
      type="number"
      className={inputCls}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        // Clearing a number input yields '' -> NaN, which JSON.stringify
        // emits as null and the server rejects with a bare 400.
        const next = Number(e.target.value);
        onChange(Number.isFinite(next) ? next : min);
      }}
      data-testid={testId}
    />
  </label>
);

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
  const rolesGroupBaseId = useId();

  const ROLE_GROUP_LABEL: Record<(typeof ROLE_GROUPS)[number], string> = {
    partner: t('aiAgentsPage.fields.recipientRolesPartner'),
    organization: t('aiAgentsPage.fields.recipientRolesOrganization'),
  };

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
          <p className="text-xs text-muted-foreground" data-testid="ai-agent-supervised-keys-ceiling-hint">
            {t('aiAgentsPage.graduation.ceilingHint')}
          </p>
          <PolicyKeysCheckboxes
            policyKeys={policyKeys}
            policyKeysFailed={policyKeysFailed}
            selectedKeys={draft.supervisedActionKeys}
            onToggle={(key) => patch({ supervisedActionKeys: toggle(draft.supervisedActionKeys, key) })}
          />
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

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          {t('aiAgentsPage.sections.notifications')}
        </legend>
        <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.recipientRolesHint')}</p>
        {rolesFailed ? (
          <p className="text-sm text-destructive" data-testid="ai-agent-roles-failed">
            {t('aiAgentsPage.fields.recipientRolesFailed')}
          </p>
        ) : roles.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="ai-agent-roles-empty">
            {t('aiAgentsPage.fields.recipientRolesEmpty')}
          </p>
        ) : (
          <div className="space-y-3">
            {ROLE_GROUPS.map((scope) => {
              const group = roles.filter((role) => roleScope(role) === scope);
              if (group.length === 0) return null;
              return (
                <div key={scope} role="group" aria-labelledby={`${rolesGroupBaseId}-${scope}`}>
                  <p id={`${rolesGroupBaseId}-${scope}`} className="text-xs font-medium">
                    {ROLE_GROUP_LABEL[scope]}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-3" data-testid={`ai-agent-roles-${scope}`}>
                    {group.map((role) => (
                      <label key={role.id} className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.roleIds.includes(role.id)}
                          onChange={() => patch({ roleIds: toggle(draft.roleIds, role.id) })}
                          data-testid={`ai-agent-role-${role.id}`}
                        />
                        {role.name}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>
    </div>
  );
}
