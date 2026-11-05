import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { indexNoticeKind, type SnapshotIndexView } from './snapshotIndexState';

/**
 * Why a snapshot's file list is not shown (#11026). Renders nothing when the
 * list is ready, or the API said nothing about it.
 */
export default function SnapshotIndexNotice({
  view,
  retrying,
  onRetry,
}: {
  view: SnapshotIndexView | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation('backup');
  const notice = indexNoticeKind(view);
  if (!notice) return null;
  // Literal keys, so the key-usage check can resolve each one.
  const message = {
    building: () => t('snapshotBrowser.fileIndexBuilding'),
    integrity: () => t('snapshotBrowser.fileIndexIntegrityFailed'),
    deviceLocal: () => t('snapshotBrowser.fileIndexDeviceLocal'),
    unavailable: () => t('snapshotBrowser.fileIndexUnavailable'),
  }[notice.message]();
  return (
    <div
      data-testid={notice.message === 'building' ? 'snapshot-index-building' : 'snapshot-index-unavailable'}
      className="space-y-2"
    >
      <p>{message}</p>
      {notice.canRetry && (
        <button
          type="button"
          data-testid="snapshot-index-retry"
          disabled={retrying}
          onClick={onRetry}
          className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
        >
          {t('snapshotBrowser.fileIndexRetry')}
        </button>
      )}
    </div>
  );
}
