import { useTranslation } from 'react-i18next';

import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import type { NetworkAssetExtras } from '@/components/devices/networkDevice/types';
import { SettingsSectionShell } from './SettingsSectionShell';

export function LinkSection(_props: {
  asset: DiscoveredAsset;
  assetId: string;
  extras: NetworkAssetExtras;
  onSaved: () => void | Promise<void>;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  return (
    <SettingsSectionShell
      section="link"
      title={t('networkDeviceDetailPage.settings.sections.link')}
    >
      {/* TODO: Implement the link section in its follow-up task. */}
      {null}
    </SettingsSectionShell>
  );
}
