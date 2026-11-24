import { useTranslation } from 'react-i18next';
import { Info, Lock, Play } from 'lucide-react';
import { i18n } from '@/lib/i18n';
import StartFrom, { eligibleParentsUrl } from '../ConfigPolicyCreatePage';
import { offersMspOwner, offersOrgChoice } from './policyOwner';
import type { PolicyDraftApi } from './usePolicyDraft';

type PolicyCreateHeaderProps = {
  draft: PolicyDraftApi;
  /** The organizations the caller can access (org switcher's list). */
  organizations: { id: string; name: string }[];
  /** Opens the Applies-to decision (Activate, or Don't apply yet). */
  onActivate: () => void;
};

const MSP_VALUE = '__msp__';

/**
 * The header of `/configuration-policies/new` (plan W03d C1/C2). Name and
 * description, Start from, and the Managed-by line with its default. Nothing
 * here writes: the policy is created, inactive, by the first feature Save,
 * Activate or Don't apply yet. Managed by and Based on are fixed at that
 * first save, and the page says so before it.
 */
export default function PolicyCreateHeader({ draft, organizations, onActivate }: PolicyCreateHeaderProps) {
  useTranslation(['policies', 'common']);
  const { kind, draft: d, nameError, ownerError } = draft;
  const mspOffered = offersMspOwner(kind);
  const orgChoice = offersOrgChoice(kind);
  const ownerOrgId = d.owner.kind === 'org' ? d.owner.orgId : null;
  const ownerOrgName = ownerOrgId ? (organizations.find((o) => o.id === ownerOrgId)?.name ?? null) : null;
  const ownerValue = d.owner.kind === 'msp' ? MSP_VALUE : (ownerOrgId ?? '');

  return (
    <div className="min-w-0 flex-1 space-y-4" data-testid="config-policy-create-header">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{i18n.t('policies:configurationPolicies.policyCreate.title')}</h1>
        <span className="inline-flex items-center rounded-full border border-warning/30 bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning">
          {i18n.t('common:states.inactive')}
        </span>
        <button
          type="button"
          data-testid="config-policy-activate"
          onClick={onActivate}
          disabled={draft.creating}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/40 bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          {i18n.t('policies:configurationPolicies.policyStateActions.activateAction')}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">{i18n.t('policies:configurationPolicies.policyCreate.startsInactive')}</p>

      <div className="grid max-w-2xl gap-4">
        <div>
          <label htmlFor="config-policy-create-name" className="text-sm font-medium">
            {i18n.t('common:labels.name')}
          </label>
          <input
            id="config-policy-create-name"
            data-testid="config-policy-create-name"
            value={d.name}
            maxLength={255}
            onChange={(e) => draft.setName(e.target.value)}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'config-policy-create-name-error' : undefined}
            placeholder={i18n.t('policies:configurationPolicies.policyCreate.namePlaceholder')}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
          {nameError && (
            <p id="config-policy-create-name-error" data-testid="config-policy-create-name-error" className="mt-1 text-xs text-destructive">
              {nameError}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="config-policy-create-description" className="text-sm font-medium">
            {i18n.t('common:labels.description')}
          </label>
          <textarea
            id="config-policy-create-description"
            data-testid="config-policy-create-description"
            value={d.description}
            onChange={(e) => draft.setDescription(e.target.value)}
            placeholder={i18n.t('policies:configurationPolicies.policyCreate.descriptionPlaceholder')}
            className="mt-1 h-16 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-1" data-testid="config-policy-managed-by-line">
          {orgChoice ? (
            <>
              <label htmlFor="config-policy-managed-by-select" className="text-sm font-medium">
                {i18n.t('policies:configurationPolicies.policyCreate.managedByLabel')}
              </label>
              <select
                id="config-policy-managed-by-select"
                data-testid="config-policy-managed-by-select"
                value={ownerValue}
                onChange={(e) =>
                  draft.setOwner(e.target.value === MSP_VALUE ? { kind: 'msp' } : { kind: 'org', orgId: e.target.value || null })
                }
                className="block h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-80"
              >
                {mspOffered ? (
                  <option value={MSP_VALUE} data-testid="config-policy-managed-by-msp">
                    {i18n.t('policies:configurationPolicies.policyCreate.managedByMspOption')}
                  </option>
                ) : (
                  <option value="">{i18n.t('policies:configurationPolicies.policyCreate.chooseOrganizationOption')}</option>
                )}
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <p className="text-sm" data-testid="config-policy-managed-by-fixed">
              {ownerOrgName
                ? i18n.t('policies:configurationPolicies.policyCreate.managedByOrganization', { organization: ownerOrgName })
                : i18n.t('policies:configurationPolicies.policyCreate.managedByOwnOrgFallback')}
            </p>
          )}
          {ownerError && (
            <p data-testid="config-policy-owner-error" role="alert" className="text-xs text-destructive">
              {ownerError}
            </p>
          )}
          {d.owner.kind === 'msp' ? (
            <p data-testid="config-policy-owner-trade" className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {i18n.t('policies:configurationPolicies.policyCreate.mspTrade')}
            </p>
          ) : (
            orgChoice && (
              <p className="text-xs text-muted-foreground" data-testid="config-policy-owner-org-hint">
                {i18n.t('policies:configurationPolicies.policyCreate.orgManagedHint')}
              </p>
            )
          )}
        </div>

        <StartFrom eligibleUrl={eligibleParentsUrl(d.owner)} parent={d.parent} onChange={draft.setParent} />

        <p data-testid="config-policy-fixed-at-first-save" className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {i18n.t('policies:configurationPolicies.policyCreate.fixedAtFirstSave')}
        </p>
      </div>
    </div>
  );
}
