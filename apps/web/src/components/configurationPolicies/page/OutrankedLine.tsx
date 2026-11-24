import { useTranslation } from 'react-i18next';
import { Layers } from 'lucide-react';
import { i18n } from '@/lib/i18n';
import type { FeatureType } from '../featureTabs/types';
import type { FeatureState } from './featureState';
import { outrankedFor, type PolicyPrecedence } from './precedenceApi';

type OutrankedLineProps = {
  featureType: FeatureType;
  state: FeatureState;
  precedence: PolicyPrecedence | null;
};

/**
 * "Outranked on N devices" for the open feature (#12472, plan W05a O3): where
 * a more specific or higher-priority policy wins this feature. Renders nothing
 * when the answer is unknown, zero, or silent about the feature. Capped is its
 * own message with no number. There is no device-list filter by policy, so
 * the line points at a device's Configuration tab instead of a link.
 */
export default function OutrankedLine({ featureType, state, precedence }: OutrankedLineProps) {
  useTranslation('policies');
  const outranked = outrankedFor(precedence, featureType, state);
  if (!outranked) return null;
  return (
    <div
      data-testid="config-policy-outranked"
      data-state={outranked.kind}
      role="note"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm"
    >
      <Layers className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      {outranked.kind === 'capped' ? (
        <p>
          <span className="font-medium">{i18n.t('policies:configurationPolicies.outranked.capped')}</span>{' '}
          <span className="text-muted-foreground">{i18n.t('policies:configurationPolicies.outranked.openDevice')}</span>
        </p>
      ) : (
        <p>
          <span className="font-medium">{i18n.t('policies:configurationPolicies.outranked.line', { count: outranked.count })}</span>{' '}
          <span className="text-muted-foreground">
            {i18n.t('policies:configurationPolicies.outranked.detail', { reached: outranked.reached })} {i18n.t('policies:configurationPolicies.outranked.openDevice')}
          </span>
        </p>
      )}
    </div>
  );
}
