import { useTranslation } from 'react-i18next';

import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import { SettingsSectionShell } from './SettingsSectionShell';

export function DangerSection(_props: {
  asset: DiscoveredAsset;
  assetId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  return (
    <SettingsSectionShell
      section="danger"
      title={t('networkDeviceDetailPage.settings.sections.danger')}
    >
      {/* TODO: Implement the danger section in its follow-up task. */}
      {null}
    </SettingsSectionShell>
  );
}
