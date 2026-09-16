// apps/web/src/components/devices/networkDevice/settings/NetworkAssetSettingsModal.tsx
// The one settings surface for a discovered network asset (spec §10, D7).
// Four independently-saved sections behind a left rail; the selected section is
// URL state (`#<tab>/settings/<section>`), owned by the page, so a rail click,
// a deep link from Discovery, and browser back/forward all agree.

import { useTranslation } from 'react-i18next';
import { Info, Link2, Radio, ShieldAlert } from 'lucide-react';

import { Dialog } from '@/components/shared/Dialog';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import type { NetworkAssetExtras } from '../types';
import { SETTINGS_SECTIONS, type SettingsSection } from './settingsHash';
import { IdentitySection } from './IdentitySection';
import { MonitoringSection } from './MonitoringSection';
import { LinkSection } from './LinkSection';
import { DangerSection } from './DangerSection';

const SECTION_META: Record<SettingsSection, { labelKey: string; Icon: typeof Info }> = {
  identity: { labelKey: 'networkDeviceDetailPage.settings.sections.identity', Icon: Info },
  monitoring: { labelKey: 'networkDeviceDetailPage.settings.sections.monitoring', Icon: Radio },
  link: { labelKey: 'networkDeviceDetailPage.settings.sections.link', Icon: Link2 },
  danger: { labelKey: 'networkDeviceDetailPage.settings.sections.danger', Icon: ShieldAlert },
};

export type NetworkAssetSettingsModalProps = {
  open: boolean;
  section: SettingsSection | null;
  assetId: string;
  onClose: () => void;
  onSaved: () => void | boolean | Promise<void | boolean>;
  asset: DiscoveredAsset;
  extras: NetworkAssetExtras;
  onSectionChange: (section: SettingsSection) => void;
  onAnnounce: (message: string) => void;
};

export function NetworkAssetSettingsModal({
  open,
  section,
  assetId,
  onClose,
  onSaved,
  asset,
  extras,
  onSectionChange,
  onAnnounce,
}: NetworkAssetSettingsModalProps) {
  const { t } = useTranslation('devices');
  // `section === null` is the closed state in the hash grammar; rendering the
  // Dialog with no section would show an empty shell on a plain `#overview`.
  if (!open || section === null) return null;

  const displayName = asset.label || asset.hostname || asset.ip;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('networkDeviceDetailPage.settings.title', { name: displayName })}
      maxWidth="4xl"
      alignTop
      className="flex flex-col max-h-[calc(100vh-4rem)]"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="network-asset-settings-modal">
        <div className="border-b px-5 py-4">
          <h2 className="text-base font-semibold">
            {t('networkDeviceDetailPage.settings.title', { name: displayName })}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('networkDeviceDetailPage.settings.subtitle')}
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label={t('networkDeviceDetailPage.settings.navLabel')}
            className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r"
          >
            {SETTINGS_SECTIONS.map((id) => {
              const { labelKey, Icon } = SECTION_META[id];
              const active = id === section;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`network-settings-nav-${id}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSectionChange(id)}
                  className={`flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-medium transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <Icon aria-hidden="true" className="h-4 w-4" />
                  {t(/* i18n-dynamic */ labelKey)}
                </button>
              );
            })}
          </nav>

          {section === 'identity' && (
            <IdentitySection asset={asset} assetId={assetId} onSaved={onSaved} onAnnounce={onAnnounce} />
          )}
          {section === 'monitoring' && (
            <MonitoringSection asset={asset} assetId={assetId} onSaved={onSaved} onAnnounce={onAnnounce} />
          )}
          {section === 'link' && (
            <LinkSection asset={asset} assetId={assetId} extras={extras} onSaved={onSaved} onAnnounce={onAnnounce} />
          )}
          {section === 'danger' && (
            <DangerSection asset={asset} assetId={assetId} onSaved={onSaved} onClose={onClose} onAnnounce={onAnnounce} />
          )}
        </div>
      </div>
    </Dialog>
  );
}
