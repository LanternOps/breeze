import { useEffect, useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import type { TCCPermissions } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

type MacOSPermissionsBannerProps = {
  deviceId: string;
  osType: string;
};

/**
 * Fetches TCC permission status for macOS devices and shows a warning banner.
 * If Full Disk Access is missing, prompts the user to grant it (the only manual step).
 * If FDA is granted but SR/Accessibility are still pending, shows a "configuring" message.
 * Renders nothing for non-macOS devices or when all permissions are granted.
 */
export default function MacOSPermissionsBanner({ deviceId, osType }: MacOSPermissionsBannerProps) {
  const [tcc, setTcc] = useState<TCCPermissions | null>(null);

  useEffect(() => {
    setTcc(null); // Clear stale state from previous device

    if (osType !== 'macos') return;

    fetchWithAuth(`/devices/${deviceId}`)
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
  }, [deviceId, osType]);

  if (!tcc) return null;

  const fdaMissing = !tcc.fullDiskAccess;
  const srMissing = !tcc.screenRecording;
  const accessibilityMissing = !tcc.accessibility;

  if (!fdaMissing && !srMissing && !accessibilityMissing) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0 text-amber-600" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {fdaMissing ? 'Full Disk Access Required' : 'Permissions Configuring'}
        </p>
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
          {fdaMissing
            ? 'Full Disk Access is required. Grant it in System Settings > Privacy & Security > Full Disk Access. Screen Recording and Accessibility will be configured automatically.'
            : 'Screen Recording and Accessibility are being configured automatically. This should resolve within a few minutes. If not, try restarting the agent.'}
        </p>
        {fdaMissing && (
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-red-400/40 bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
              <XCircle className="h-3 w-3" />
              Full Disk Access
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
