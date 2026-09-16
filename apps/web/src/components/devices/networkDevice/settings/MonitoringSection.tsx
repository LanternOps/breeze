import { useTranslation } from 'react-i18next';

import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import { SettingsSectionShell } from './SettingsSectionShell';

export function MonitoringSection(_props: {
  asset: DiscoveredAsset;
  assetId: string;
  onSaved: () => void | Promise<void>;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  return (
    <SettingsSectionShell
      section="monitoring"
      title={t('networkDeviceDetailPage.settings.sections.monitoring')}
    >
      {/* TODO: Implement the monitoring section in its follow-up task. */}
      {null}
    </SettingsSectionShell>
  );
}
