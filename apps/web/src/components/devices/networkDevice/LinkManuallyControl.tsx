// The one manual-override control this surface adds beyond Unlink: for the
// case auto-link can't handle (cross-subnet discovery — no MAC visible, IPs
// don't match), let a human assert the identity link directly. Site-scoped
// on purpose: the link route requires same-org AND same-site
// (discovery.ts:1458-1464), so an unscoped device list would offer choices
// guaranteed to 403.

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { extractApiError } from '../../../lib/apiError';
import { asList } from '@/lib/asList';
import type { DeviceOption } from './types';

export function LinkManuallyControl({
  assetId,
  siteId,
  onLinked,
}: {
  assetId: string;
  siteId: string | null;
  onLinked: () => void | Promise<void>;
}) {
  const { t } = useTranslation('devices');
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string>();

  const openPicker = useCallback(async () => {
    setOpen(true);
    setError(undefined);
    if (!siteId) {
      setError(t('networkDeviceDetailPage.linkManuallyErrors.noSite'));
      return;
    }
    setLoadingDevices(true);
    try {
      const response = await fetchWithAuth(`/devices?siteId=${encodeURIComponent(siteId)}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(extractApiError(body, t('networkDeviceDetailPage.linkManuallyErrors.loadDevices')));
        return;
      }
      const data = await response.json();
      const raw: any[] = asList(data, 'devices');
      setDevices(
        raw.map((d: any) => ({
          id: d.id,
          name: d.displayName || d.hostname || d.id,
          online: d.status === 'online',
        })),
      );
    } catch {
      setError(t('networkDeviceDetailPage.linkManuallyErrors.loadDevices'));
    } finally {
      setLoadingDevices(false);
    }
  }, [siteId, t]);

  const handleLink = useCallback(async () => {
    if (!deviceId) return;
    setLinking(true);
    setError(undefined);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/discovery/assets/${assetId}/link`, {
            method: 'POST',
            body: JSON.stringify({ deviceId }),
          }),
        successMessage: t('networkDeviceDetailPage.toasts.linked'),
        errorFallback: t('networkDeviceDetailPage.toasts.linkFailed'),
      });
      setOpen(false);
      setDeviceId('');
      await onLinked();
    } catch (err) {
      // runAction's message is already extractApiError's output — reuse it
      // for the inline error instead of a second, possibly different string.
      setError(err instanceof ActionError ? err.message : t('networkDeviceDetailPage.toasts.linkFailed'));
    } finally {
      setLinking(false);
    }
  }, [deviceId, assetId, onLinked, t]);

  if (!open) {
    return (
      <button
        type="button"
        data-testid="network-detail-link-manually"
        onClick={() => void openPicker()}
        className="text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('networkDeviceDetailPage.linkManually')}
      </button>
    );
  }

  return (
    <div className="mt-1 space-y-2 rounded-md border bg-background p-3" data-testid="network-detail-link-manually-picker">
      {loadingDevices ? (
        <p className="text-xs text-muted-foreground">{t('common:states.loading')}</p>
      ) : devices.length === 0 && !error ? (
        <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.linkManuallyErrors.noDevices')}</p>
      ) : (
        <select
          data-testid="network-detail-link-manually-select"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          className="h-8 w-full rounded-md border bg-background px-2 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{t('networkDeviceDetailPage.linkManuallySelectDevice')}</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="network-detail-link-manually-submit"
          onClick={() => void handleLink()}
          disabled={linking || !deviceId}
          className="h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {linking ? t('networkDeviceDetailPage.linkManuallyLinking') : t('common:actions.save')}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(undefined); }}
          disabled={linking}
          className="text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('common:actions.cancel')}
        </button>
      </div>
      {error && (
        <p className="text-xs text-destructive" data-testid="network-detail-link-manually-error">
          {error}
        </p>
      )}
    </div>
  );
}
