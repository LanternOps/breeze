import { useTranslation } from 'react-i18next';

import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import { SettingsSectionShell } from './SettingsSectionShell';

export function IdentitySection(_props: {
  asset: DiscoveredAsset;
  assetId: string;
  onSaved: () => void | Promise<void>;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  return (
    <SettingsSectionShell
      section="identity"
      title={t('networkDeviceDetailPage.settings.sections.identity')}
    >
      {/* TODO: Implement the identity section in its follow-up task. */}
      {null}
    </SettingsSectionShell>
  );
}
