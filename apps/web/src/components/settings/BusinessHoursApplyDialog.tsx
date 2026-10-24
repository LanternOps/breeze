import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { BusinessCalendarApplyPreviewDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { runAction, ActionError } from '@/lib/runAction';

type Props = {
  calendarId: string;
  calendarName: string;
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
};

/**
 * D12: "Apply to open tickets". Loads the preview first, shows what would change,
 * and only on confirm POSTs apply-revision with the previewed revision id.
 */
export default function BusinessHoursApplyDialog({ calendarId, calendarName, open, onClose, onApplied }: Props) {
  const { t } = useTranslation('settings');
  const [preview, setPreview] = useState<BusinessCalendarApplyPreviewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [changedNote, setChangedNote] = useState(false);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    setPreview(null);
    try {
      const res = await fetchWithAuth(`/business-calendars/${calendarId}/apply-revision/preview`);
      if (!res.ok) throw new Error(`preview failed: ${res.status}`);
      const body = (await res.json()) as { data: BusinessCalendarApplyPreviewDto };
      setPreview(body.data);
    } catch (err) {
      console.warn('[BusinessHoursApplyDialog] preview failed', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [calendarId]);

  useEffect(() => {
    if (open) {
      setChangedNote(false);
      void loadPreview();
    }
  }, [open, loadPreview]);

  const confirm = async () => {
    if (!preview || applying) return;
    setApplying(true);
    try {
      const result = await runAction<{ data: { updated: number; skippedLocked: number } }>({
        request: () => fetchWithAuth(`/business-calendars/${calendarId}/apply-revision`, {
          method: 'POST',
          body: JSON.stringify({ expectedRevisionId: preview.revisionId }),
        }),
        errorFallback: t('businessHoursCard.errors.apply'),
        successMessage: (r) => t('businessHoursCard.toasts.applied', { count: r.data?.updated ?? 0 }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
        // 409 REVISION_CHANGED is handled inline below (reload the preview).
        suppressErrorToast: (status, code) => status === 409 && code === 'REVISION_CHANGED',
      });
      onApplied();
      const skipped = result?.data?.skippedLocked ?? 0;
      if (skipped > 0) {
        // Some tickets were held by a concurrent edit through every retry and
        // kept their old revision: say so and leave the dialog open on a fresh
        // preview so the operator can apply again.
        showToast({ type: 'warning', message: t('businessHoursCard.toasts.appliedPartial', { skipped }) });
        await loadPreview();
        return;
      }
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.code === 'REVISION_CHANGED') {
        setChangedNote(true);
        showToast({ type: 'error', message: t('businessHoursCard.apply.revisionChanged') });
        await loadPreview();
      } else if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('businessHoursCard.errors.apply') });
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={() => void confirm()}
      title={t('businessHoursCard.apply.title', { name: calendarName })}
      message={t('businessHoursCard.apply.explanation')}
      confirmLabel={t('businessHoursCard.apply.confirm')}
      variant="warning"
      isLoading={applying}
      confirmDisabled={!preview || loading}
      confirmTestId="business-hours-apply-confirm"
      dialogTestId="business-hours-apply-dialog"
    >
      <div className="mt-3 text-sm" data-testid="business-hours-apply-preview">
        {loading && <p className="text-muted-foreground">{t('businessHoursCard.apply.loading')}</p>}
        {loadFailed && (
          <p className="text-destructive" role="alert" data-testid="business-hours-apply-error">
            {t('businessHoursCard.apply.loadFailed')}{' '}
            <button type="button" className="underline" onClick={() => void loadPreview()} data-testid="business-hours-apply-retry">
              {t('businessHoursCard.retry')}
            </button>
          </p>
        )}
        {changedNote && (
          <p className="mb-2 text-amber-700" role="alert" data-testid="business-hours-apply-changed">
            {t('businessHoursCard.apply.revisionChanged')}
          </p>
        )}
        {preview && (
          <ul className="space-y-1">
            <li data-testid="business-hours-apply-eligible">{t('businessHoursCard.apply.eligible', { count: preview.eligibleCount })}</li>
            <li data-testid="business-hours-apply-breached">{t('businessHoursCard.apply.breached', { count: preview.immediatelyBreachedCount })}</li>
            <li data-testid="business-hours-apply-paused">{t('businessHoursCard.apply.paused', { count: preview.skippedPausedCount })}</li>
          </ul>
        )}
      </div>
    </ConfirmDialog>
  );
}
