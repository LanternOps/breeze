// apps/web/src/components/devices/networkDevice/settings/LinkSection.tsx
// The identity link between this discovered asset and a managed device. The
// device page has been the single link surface since the 2026-08-08
// asset-link-lifecycle decision; W04 moves the CONTROLS off the page body into
// this section so every asset-scoped write sits behind one modal. The page
// keeps the read-only "Same device as X" line, which is status, not an action.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import { isManualLink } from '@/components/discovery/networkTypes';
import type { NetworkAssetExtras } from '../types';
import { LinkManuallyControl } from '../LinkManuallyControl';
import { SettingsSectionShell } from './SettingsSectionShell';
import { useNetworkAssetMutations } from './useNetworkAssetMutations';

export function LinkSection({
  asset,
  assetId,
  extras,
  onSaved,
  onAnnounce,
}: {
  asset: DiscoveredAsset;
  assetId: string;
  extras: NetworkAssetExtras;
  onSaved: () => void | boolean | Promise<void | boolean>;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  const { unlink } = useNetworkAssetMutations();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  // Unlink works for auto AND manual links (#3261 Task 2): the server stamps
  // auto_link_suppressed_at so the next scan doesn't silently re-create it.
  const handleUnlink = async () => {
    setConfirmOpen(false);
    setUnlinking(true);
    try {
      await unlink(assetId);
      if (await onSaved() === false) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
      }
      onAnnounce(t('networkDeviceDetailPage.toasts.unlinked'));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect owns it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.toasts.unlinkFailed') });
      }
    } finally {
      setUnlinking(false);
    }
  };

  return (
    <SettingsSectionShell
      section="link"
      title={t('networkDeviceDetailPage.settings.sections.link')}
      description={asset.linkSource === 'agent_report'
        ? t('hardwareHealth.bmcAssociation')
        : t('networkDeviceDetailPage.settings.link.description')}
    >
      {asset.linkedDeviceId ? (
        <div className="space-y-4 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <a
              href={`/devices/${asset.linkedDeviceId}`}
              data-testid="network-settings-link-device"
              className="text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {asset.linkSource === 'agent_report'
                ? t('hardwareHealth.bmcHost', { name: asset.linkedDeviceName || t('common:states.unknown') })
                : t('networkDeviceDetailPage.sameDeviceAs', {
                    name: asset.linkedDeviceName || t('common:states.unknown'),
                  })}
            </a>
            <span className="text-xs text-muted-foreground" data-testid="network-settings-link-provenance">
              {asset.linkSource === 'agent_report'
                ? t('hardwareHealth.bmcAgentReport')
                : isManualLink(asset.linkSource)
                  ? t('networkDeviceDetailPage.provenance.manual')
                  : t('networkDeviceDetailPage.provenance.auto')}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.settings.link.unlinkHint')}</p>
          <button
            type="button"
            data-testid="network-settings-link-unlink"
            onClick={() => setConfirmOpen(true)}
            disabled={unlinking}
            className="h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {unlinking ? t('networkDeviceDetailPage.unlinking') : t('networkDeviceDetailPage.unlink')}
          </button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>{t('networkDeviceDetailPage.notLinked')}</p>
          {extras.autoLinkSuppressedAt && (
            <p className="text-xs text-muted-foreground" data-testid="network-settings-link-suppressed">
              {t('networkDeviceDetailPage.autoLinkSuppressed')}
            </p>
          )}
          {/* Site-scoped on purpose: the link route requires same-org AND
              same-site, so an unscoped list would offer guaranteed 403s. */}
          <LinkManuallyControl assetId={assetId} siteId={extras.siteId ?? null} onLinked={async () => {
            if (await onSaved() === false) {
              showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
            }
          }} />
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void handleUnlink()}
        title={t('networkDeviceDetailPage.confirmUnlink')}
        message={asset.linkSource === 'agent_report'
          ? t('hardwareHealth.bmcConfirmUnlink')
          : t('networkDeviceDetailPage.confirmUnlinkMessage')}
        confirmLabel={t('networkDeviceDetailPage.unlink')}
        variant="destructive"
        isLoading={unlinking}
        confirmTestId="network-settings-link-unlink-confirm"
      />
    </SettingsSectionShell>
  );
}
