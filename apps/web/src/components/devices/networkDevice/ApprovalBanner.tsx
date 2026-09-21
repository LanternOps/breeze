// D9: the approval badge was dead chrome — always "Approved" on every page
// reachable from a list, and on the pending/dismissed assets Discovery
// deep-links it was the ONLY signal and carried no action. The badge is now
// hidden when approved (see NetworkDeviceHeader) and the two states that
// actually block monitoring get a banner that says what is not happening and
// offers the decision inline.

import { AlertTriangle, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAssetApprovalStatus } from '../../discovery/DiscoveredAssetList';

export type ApprovalBannerProps = {
  approvalStatus: DiscoveredAssetApprovalStatus;
  onApprove: () => Promise<void>;
  onDismiss: () => Promise<void>;
  busy: boolean;
};

export function ApprovalBanner({
  approvalStatus,
  onApprove,
  onDismiss,
  busy,
}: ApprovalBannerProps) {
  const { t } = useTranslation('devices');
  if (approvalStatus !== 'pending' && approvalStatus !== 'dismissed') return null;

  const pending = approvalStatus === 'pending';
  const Icon = pending ? AlertTriangle : EyeOff;

  return (
    <div
      role="alert"
      data-testid="network-detail-approval-banner"
      className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${
        pending
          ? 'border-warning/40 bg-warning/10 text-warning-foreground'
          : 'border-muted bg-muted/50 text-muted-foreground'
      }`}
    >
      <p className="flex items-start gap-2 text-sm">
        <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {pending
            ? t('networkDeviceDetailPage.approval.pendingBanner')
            : t('networkDeviceDetailPage.approval.dismissedBanner')}
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="network-detail-approve"
          disabled={busy}
          onClick={() => void onApprove()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.approval.approve')}
        </button>
        {pending && (
          <button
            type="button"
            data-testid="network-detail-dismiss"
            disabled={busy}
            onClick={() => void onDismiss()}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.approval.dismiss')}
          </button>
        )}
      </div>
    </div>
  );
}
