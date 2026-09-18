// The "Set up monitoring" affordance. Named after what is missing, not after
// what the card would have shown: an operator landing here has an asset that
// nothing is polling, and the only useful thing on the card is the way to fix
// that. The description names what SNMP would add for THIS device type so the
// CTA is an offer, not a chore.

import { Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import EmptyState from '../../../shared/EmptyState';
import { Section } from '../primitives';
import type { HealthCardProps } from './types';

const TYPE_BENEFIT_KEYS: Record<string, string> = {
  printer: 'networkDeviceDetailPage.health.empty.benefit.printer',
  switch: 'networkDeviceDetailPage.health.empty.benefit.switch',
  router: 'networkDeviceDetailPage.health.empty.benefit.switch',
  firewall: 'networkDeviceDetailPage.health.empty.benefit.switch',
  access_point: 'networkDeviceDetailPage.health.empty.benefit.switch',
};

export function EmptyHealth({ assetType, onSetUpMonitoring }: HealthCardProps) {
  const { t } = useTranslation('devices');
  const benefitKey = TYPE_BENEFIT_KEYS[assetType] ?? 'networkDeviceDetailPage.health.empty.benefit.generic';

  return (
    <Section title={t('networkDeviceDetailPage.sections.deviceHealth')} testId="network-detail-health">
      <EmptyState
        variant="plain"
        size="sm"
        testId="network-detail-health-empty"
        icon={<Activity aria-hidden="true" />}
        title={t('networkDeviceDetailPage.health.empty.title')}
        description={t(/* i18n-dynamic */ benefitKey)}
        action={
          <button
            type="button"
            data-testid="network-detail-setup-monitoring"
            onClick={onSetUpMonitoring}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.health.empty.action')}
          </button>
        }
      />
    </Section>
  );
}
