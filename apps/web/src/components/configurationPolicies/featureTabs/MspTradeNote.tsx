import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { i18n } from '@/lib/i18n';
import { useFeaturePolicy } from './featurePolicyContext';

/**
 * The MSP-managed trade, stated in each linked picker (spec Decision 1, plan
 * W03d C2): an MSP-managed policy links only items shared across the MSP's
 * organizations. Renders nothing on an org-managed policy, or outside a
 * policy page.
 */
export default function MspTradeNote() {
  useTranslation('policies');
  const info = useFeaturePolicy();
  if (!info?.mspManaged) return null;
  return (
    <p data-testid="linked-picker-msp-trade" className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      {i18n.t('policies:configurationPolicies.policyCreate.mspTradePicker')}
    </p>
  );
}
