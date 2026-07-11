import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TCCPermissions } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

const POLL_INTERVAL_MISSING = 30_000;  // 30s when any permission is missing
const POLL_INTERVAL_GRANTED = 300_000; // 5 min when all granted

type MacOSPermissionsBannerProps = {
  deviceId: string;
  osType: string;
};

/**
 * Fetches TCC permission status for macOS devices and shows a warning banner.
 * If Full Disk Access is missing, prompts the user to grant it (the only manual step).
 * If FDA is granted but SR/Accessibility are still pending, shows a "configuring" message.
 * Renders nothing for non-macOS devices or when all permissions are granted.
 *
 * Polls every 30s while any permission is missing so the UI updates automatically
 * after the user grants FDA in System Settings.
 */
export default function MacOSPermissionsBanner({ deviceId, osType }: MacOSPermissionsBannerProps) {
  const { t } = useTranslation('devices');
  const [tcc, setTcc] = useState<TCCPermissions | null>(null);

  const fetchTcc = useCallback(() => {
    return fetchWithAuth(`/devices/${deviceId}`)
      .then(r => {
        if (!r.ok) {
          console.debug('[MacOSPermissionsBanner] Non-OK response fetching device:', r.status);
          return null;
        }
        return r.json();
      })
      .then(data => {
        if (data?.tccPermissions) {
          setTcc(data.tccPermissions);
        }
      })
      .catch((err) => {
        console.debug('[MacOSPermissionsBanner] Error fetching TCC status:', err);
      });
  }, [deviceId]);

  // Initial fetch
  useEffect(() => {
    setTcc(null); // Clear stale state from previous device

    if (osType !== 'macos') return;

    fetchTcc();
  }, [deviceId, osType, fetchTcc]);

  // Derive a stable boolean so the polling effect only resets when the
  // polling rate actually needs to change, not on every response.
  const hasMissing = tcc
    ? (!tcc.fullDiskAccess || !tcc.screenRecording || !tcc.accessibility || tcc.remoteDesktop === false)
    : false;

  // Poll while any permission is missing
  useEffect(() => {
    if (osType !== 'macos' || !tcc) return;

    const interval = hasMissing ? POLL_INTERVAL_MISSING : POLL_INTERVAL_GRANTED;
    const timer = setInterval(fetchTcc, interval);
    return () => clearInterval(timer);
  }, [osType, hasMissing, fetchTcc]);

  if (!tcc || !hasMissing) return null;

  const fdaMissing = !tcc.fullDiskAccess;
  const remoteDesktopMissing = tcc.remoteDesktop === false;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
      <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {fdaMissing
            ? t('macOSPermissionsBanner.fullDiskAccessRequired')
            : remoteDesktopMissing
              ? t('macOSPermissionsBanner.remoteDesktopRequired')
              : t('macOSPermissionsBanner.permissionsConfiguring')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {fdaMissing
            ? t('macOSPermissionsBanner.fullDiskAccessDescription')
            : remoteDesktopMissing
              ? t('macOSPermissionsBanner.remoteDesktopDescription')
            : t('macOSPermissionsBanner.configuringDescription')}
        </p>
        {(fdaMissing || remoteDesktopMissing) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {fdaMissing && (
              <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/15 px-2.5 py-0.5 text-xs font-medium text-destructive">
                <XCircle className="h-3 w-3" />
                {t('macOSPermissionsBanner.fullDiskAccess')}
              </span>
            )}
            {remoteDesktopMissing && (
              <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/15 px-2.5 py-0.5 text-xs font-medium text-destructive">
                <XCircle className="h-3 w-3" />
                {t('macOSPermissionsBanner.remoteDesktop')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
