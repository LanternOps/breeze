import { useTranslation } from 'react-i18next';
import { Copy, Info } from 'lucide-react';
import type { ConfigFeatureType } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import { configFeatureLabel } from '../configPolicyLabels';

type UnavailableFeaturePanelProps = {
  featureType: ConfigFeatureType;
  /** The policy still carries a link for it (one that pre-dates the restriction). */
  hasLink: boolean;
  readOnly: boolean;
  removing: boolean;
  removeError: string | null;
  onRemove: () => void;
  /**
   * Copy the policy to one organization, where the feature can be set (plan
   * D17: OneDrive Helper on an MSP-managed policy). Omitted = no Copy control.
   */
  onCopyToOrganization?: () => void;
};

/**
 * The panel shown in place of an editor for a feature this policy cannot
 * carry: an org-only feature on an MSP-managed policy (#2101). It says why,
 * offers Copy to one organization, and keeps a removal path for a leftover
 * link, which would otherwise be stuck: the editor is never rendered here.
 */
export default function UnavailableFeaturePanel({
  featureType,
  hasLink,
  readOnly,
  removing,
  removeError,
  onRemove,
  onCopyToOrganization,
}: UnavailableFeaturePanelProps) {
  useTranslation('policies');
  const feature = configFeatureLabel(featureType);
  return (
    <div
      data-testid="config-policy-feature-unavailable"
      className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium text-foreground">{i18n.t('policies:configurationPolicies.configPolicyDetailPage.gatedFeatureUnavailable', { feature })}</p>
        <p className="mt-1">{i18n.t('policies:configurationPolicies.configPolicyDetailPage.gatedFeatureReason', { feature })}</p>
        {onCopyToOrganization && (
          <button
            type="button"
            data-testid="config-policy-copy-to-organization"
            onClick={onCopyToOrganization}
            className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
            {i18n.t('policies:configurationPolicies.copyPolicy.copyToOrganization')}
          </button>
        )}
        {hasLink && (
          <div className="mt-4">
            <p className="text-warning">
              {i18n.t('policies:configurationPolicies.configPolicyDetailPage.thisPolicyStillCarriesAnExisting')} {feature.toLowerCase()}
              {i18n.t('policies:configurationPolicies.configPolicyDetailPage.configurationThatWillNeverBeApplied')}
            </p>
            {removeError && <p className="mt-2 text-destructive">{removeError}</p>}
            {!readOnly && (
              <button
                type="button"
                disabled={removing}
                onClick={onRemove}
                className="mt-2 h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
              >
                {removing ? i18n.t('policies:configurationPolicies.configPolicyDetailPage.removing') : i18n.t('policies:configurationPolicies.configPolicyDetailPage.removeConfiguration')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
