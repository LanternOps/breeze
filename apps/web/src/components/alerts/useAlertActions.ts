import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth, AuthSessionExpiredError } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { runAction, ActionError } from '../../lib/runAction';

/** Minimum alert shape the single-alert actions need. */
export type ActionableAlert = { id: string; title: string; status: string };

export type UseAlertActionsOptions<A extends ActionableAlert> = {
  /** Re-fetch the host surface's alert list (fire-and-forget). */
  refresh: () => unknown;
  /** Optimistically patch one alert row in the host's local state. */
  patchAlert: (id: string, patch: Record<string, unknown>) => void;
  /** Ack succeeded — host may refresh an open detail panel. */
  onAcknowledged?: (alert: A) => void | Promise<void>;
  /** Resolve finished with the alert terminal (success or 409 lost-race). */
  onResolveSettled?: (alert: A) => void;
  /** Suppress confirmed — host may close an open detail panel. */
  onSuppressStarted?: (alert: A) => void;
};

/**
 * Single-alert Acknowledge / Resolve / Suppress, shared by the fleet AlertsPage
 * and the per-device alert history (#8137) so there is exactly one copy of the
 * runAction, 409 compare-and-swap (#4094) and optimistic-suppress-with-undo
 * logic.
 */
export function useAlertActions<A extends ActionableAlert>({
  refresh,
  patchAlert,
  onAcknowledged,
  onResolveSettled,
  onSuppressStarted,
}: UseAlertActionsOptions<A>) {
  const { t } = useTranslation('alerts');
  const [submitting, setSubmitting] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [suppressTarget, setSuppressTarget] = useState<A | null>(null);

  const acknowledge = useCallback(
    async (alert: A) => {
      // The round-trip can be slow; keep the in-flight spinner up the whole time (#1300).
      setSubmitting(true);
      setSubmittingId(alert.id);
      try {
        await runAction({
          request: () => fetchWithAuth(`/alerts/${alert.id}/acknowledge`, { method: 'POST' }),
          errorFallback: t('alertsPage.failedToAcknowledgeAlert'),
          successMessage: t('alertsPage.alertAcknowledged'),
          onUnauthorized: () => void navigateTo('/login', { replace: true }),
        });
        patchAlert(alert.id, { status: 'acknowledged', acknowledgedAt: new Date().toISOString() });
        await onAcknowledged?.(alert);
        refresh();
      } catch (err) {
        // runAction already toasted any ActionError (and 401 → login redirect).
        if (!(err instanceof ActionError)) {
          showToast({ message: t('alertsPage.failedToAcknowledgeAlert'), type: 'error' });
        } else if (err.status === 409) {
          // Lost a race (already resolved/acknowledged elsewhere): refresh so
          // the row stops offering actions on a finished alert.
          refresh();
        }
      } finally {
        setSubmitting(false);
        setSubmittingId(null);
      }
    },
    [t, patchAlert, onAcknowledged, refresh],
  );

  const resolve = useCallback(
    async (alert: A, note: string) => {
      setSubmitting(true);
      setSubmittingId(alert.id);
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/alerts/${alert.id}/resolve`, {
              method: 'POST',
              body: JSON.stringify({ note }),
            }),
          errorFallback: t('alertsPage.failedToResolveAlert'),
          successMessage: t('alertsPage.alertResolved'),
          onUnauthorized: () => void navigateTo('/login', { replace: true }),
        });
        patchAlert(alert.id, { status: 'resolved', resolvedAt: new Date().toISOString() });
        onResolveSettled?.(alert);
        refresh();
      } catch (err) {
        if (!(err instanceof ActionError)) {
          showToast({ message: t('alertsPage.failedToResolveAlert'), type: 'error' });
          return;
        }
        // 409 = another technician (or the auto-resolve sweep) won the
        // compare-and-swap; the alert IS finished, this request just didn't do
        // it (#4094). runAction already toasted the reason. Refresh so the row
        // stops offering Resolve on a finished alert.
        if (err.status === 409) {
          onResolveSettled?.(alert);
          refresh();
        }
      } finally {
        setSubmitting(false);
        setSubmittingId(null);
      }
    },
    [t, patchAlert, onResolveSettled, refresh],
  );

  /** Opens the duration picker; `confirmSuppress` runs on confirm. */
  const requestSuppress = useCallback((alert: A) => setSuppressTarget(alert), []);
  const cancelSuppress = useCallback(() => setSuppressTarget(null), []);

  // `until === null` means indefinite ("Forever") suppression — send no `until`.
  const confirmSuppress = useCallback(
    async (alert: A, until: Date | null) => {
      setSuppressTarget(null);

      const previousStatus = alert.status;
      patchAlert(alert.id, { status: 'suppressed' });
      onSuppressStarted?.(alert);

      const revert = () => patchAlert(alert.id, { status: previousStatus });

      showToast({
        message: t('alertsPage.alertSuppressed', { title: alert.title }),
        type: 'undo',
        onUndo: revert,
        duration: 5000,
      });

      try {
        // runaction-exempt: optimistic-with-undo handler — it shows its outcome
        // inline (the optimistic row mutation + the undo toast above, and an
        // explicit revert + error toast on failure below). Routing through
        // runAction would double-toast and fight the optimistic flow.
        const response = await fetchWithAuth(`/alerts/${alert.id}/suppress`, {
          method: 'POST',
          body: JSON.stringify(until ? { until: until.toISOString() } : {}),
        });
        if (!response.ok) {
          // Surface the server's specific reason (e.g. "Cannot suppress a
          // resolved alert") rather than a generic message.
          const body = await response.json().catch(() => null);
          revert();
          console.error('[alerts] suppress failed', alert.id, response.status, body?.error);
          showToast({
            message: typeof body?.error === 'string' ? body.error : t('alertsPage.failedToSuppressAlert'),
            type: 'error',
          });
          // The revert restores the pre-click status, which may now be stale
          // (e.g. resolved concurrently) — re-sync from the server.
          if (response.status === 409) refresh();
        } else {
          refresh();
        }
      } catch (err) {
        // fetchWithAuth already redirects to /login on session expiry.
        if (err instanceof AuthSessionExpiredError) return;
        revert();
        console.error('[alerts] suppress failed', alert.id, err);
        showToast({ message: t('alertsPage.failedToSuppressAlert'), type: 'error' });
      }
    },
    [t, patchAlert, onSuppressStarted, refresh],
  );

  return {
    submitting,
    submittingId,
    suppressTarget,
    acknowledge,
    resolve,
    requestSuppress,
    cancelSuppress,
    confirmSuppress,
  };
}
