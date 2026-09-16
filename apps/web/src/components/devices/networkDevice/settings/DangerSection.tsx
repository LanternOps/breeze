// apps/web/src/components/devices/networkDevice/settings/DangerSection.tsx
// Approval triage and destructive removal (spec §10 Danger, D9).
//
// Approve/Dismiss live here as well as on Discovery's rows on purpose: spec F7
// found that the "Approved" badge is the ONLY signal on a deep-linked pending
// asset and carries no action, so an operator who arrived from a topology node
// or a saved link had no way to act on it at all.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import { SettingsSectionShell } from './SettingsSectionShell';
import { useNetworkAssetMutations } from './useNetworkAssetMutations';

type PendingAction = 'approve' | 'dismiss' | 'delete';

export function DangerSection({
  asset,
  assetId,
  onSaved,
  onClose,
  onAnnounce,
}: {
  asset: DiscoveredAsset;
  assetId: string;
  onSaved: () => void | boolean | Promise<void | boolean>;
  onClose: () => void;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  const { approve, dismiss, deleteAsset } = useNetworkAssetMutations();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [typedName, setTypedName] = useState('');

  const displayName = asset.label || asset.hostname || asset.ip;
  // Case-insensitive and trimmed: the gate exists to prove deliberate intent,
  // not to be a typing exam, and a scan-authored name can carry capitals the
  // operator has no reason to reproduce.
  const deleteArmed = typedName.trim().toLowerCase() === displayName.trim().toLowerCase();

  /** Runs a mutation, returns whether it succeeded. Never leaves a silent failure. */
  const run = async (action: PendingAction, fn: () => Promise<void>, fallback: string): Promise<boolean> => {
    setPending(action);
    try {
      await fn();
      return true;
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return false; // auth redirect owns it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
      return false;
    } finally {
      setPending(null);
    }
  };

  const handleApprove = async () => {
    const okResult = await run('approve', () => approve(assetId),
      t('networkDeviceDetailPage.settings.toasts.approveFailed'));
    if (!okResult) return;
    if (await onSaved() === false) {
      showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
    }
    onAnnounce(t('networkDeviceDetailPage.settings.toasts.approved'));
  };

  const handleDismiss = async () => {
    const okResult = await run('dismiss', () => dismiss(assetId),
      t('networkDeviceDetailPage.settings.toasts.dismissFailed'));
    if (!okResult) return;
    if (await onSaved() === false) {
      showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
    }
    onAnnounce(t('networkDeviceDetailPage.settings.toasts.dismissed'));
  };

  const handleDelete = async () => {
    setConfirmDeleteOpen(false);
    const okResult = await run('delete', () => deleteAsset(assetId),
      t('networkDeviceDetailPage.settings.toasts.assetDeleteFailed'));
    if (!okResult) return;
    onAnnounce(t('networkDeviceDetailPage.settings.toasts.assetDeleted'));
    onClose();
    // The asset is gone; staying would drop the operator on the page's
    // not-found state with no explanation of why.
    void navigateTo('/devices#deviceClass=network');
  };

  const explainerKey =
    asset.approvalStatus === 'pending'
      ? 'networkDeviceDetailPage.settings.danger.pendingExplainer'
      : asset.approvalStatus === 'dismissed'
        ? 'networkDeviceDetailPage.settings.danger.dismissedExplainer'
        : 'networkDeviceDetailPage.settings.danger.approvedExplainer';

  return (
    <SettingsSectionShell
      section="danger"
      title={t('networkDeviceDetailPage.settings.sections.danger')}
      description={t('networkDeviceDetailPage.settings.danger.description')}
    >
      <div className="space-y-6 text-sm">
        <div className="rounded-md border p-4">
          <h4 className="text-sm font-medium">{t('networkDeviceDetailPage.settings.danger.approvalTitle')}</h4>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="network-settings-approval-explainer">
            {t(/* i18n-dynamic */ explainerKey)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {asset.approvalStatus !== 'approved' && (
              <button
                type="button"
                data-testid="network-settings-approve"
                onClick={() => void handleApprove()}
                disabled={pending !== null}
                className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {pending === 'approve'
                  ? t('common:states.saving')
                  : t('networkDeviceDetailPage.settings.danger.approve')}
              </button>
            )}
            {asset.approvalStatus !== 'dismissed' && (
              <button
                type="button"
                data-testid="network-settings-dismiss"
                onClick={() => void handleDismiss()}
                disabled={pending !== null}
                className="h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {pending === 'dismiss'
                  ? t('common:states.saving')
                  : t('networkDeviceDetailPage.settings.danger.dismiss')}
              </button>
            )}
          </div>
        </div>

        <div className="rounded-md border border-destructive/40 p-4">
          <h4 className="text-sm font-medium text-destructive">
            {t('networkDeviceDetailPage.settings.danger.deleteTitle')}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('networkDeviceDetailPage.settings.danger.deleteDescription')}
          </p>
          <button
            type="button"
            data-testid="network-settings-delete"
            onClick={() => { setTypedName(''); setConfirmDeleteOpen(true); }}
            disabled={pending !== null}
            className="mt-3 h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.settings.danger.deleteAsset')}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title={t('networkDeviceDetailPage.settings.danger.deleteConfirmTitle')}
        message={t('networkDeviceDetailPage.settings.danger.deleteConfirmMessage', { name: displayName })}
        confirmLabel={t('networkDeviceDetailPage.settings.danger.deleteAsset')}
        variant="destructive"
        isLoading={pending === 'delete'}
        confirmDisabled={!deleteArmed}
        confirmTestId="network-settings-delete-confirm"
        dialogTestId="network-settings-delete-dialog"
      >
        <div className="space-y-3">
          {/* Enumerated from the route's own transaction
              (routes/discovery.ts:1671-1731) — this is what actually goes. */}
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.snmp')}</li>
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.metrics')}</li>
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.thresholds')}</li>
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.checks')}</li>
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.topology')}</li>
          </ul>
          <div>
            <label
              htmlFor="network-settings-delete-confirm-input"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t('networkDeviceDetailPage.settings.danger.deleteConfirmPrompt', { name: displayName })}
            </label>
            <input
              id="network-settings-delete-confirm-input"
              data-testid="network-settings-delete-confirm-input"
              type="text"
              value={typedName}
              autoComplete="off"
              onChange={(e) => setTypedName(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
      </ConfirmDialog>
    </SettingsSectionShell>
  );
}
