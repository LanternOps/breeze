import { useEffect, useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import type { TCCPermissions } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

type MacOSPermissionsBannerProps = {
  deviceId: string;
  osType: string;
};

/**
 * Fetches TCC permission status for macOS devices and shows a warning banner
 * when critical permissions (especially Screen Recording) are missing.
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

  const missing: string[] = [];
  if (!tcc.screenRecording) missing.push('Screen Recording');
  if (!tcc.accessibility) missing.push('Accessibility');
  if (!tcc.fullDiskAccess) missing.push('Full Disk Access');

  if (missing.length === 0) return null;

  const hasScreenRecordingMissing = !tcc.screenRecording;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0 text-amber-600" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          Missing macOS Permissions
        </p>
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
          {hasScreenRecordingMissing
            ? 'Screen Recording permission is not granted. Remote Desktop will not work until the user enables it in System Settings > Privacy & Security > Screen Recording.'
            : `The following permissions are missing: ${missing.join(', ')}. The user should grant them in System Settings > Privacy & Security.`}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {missing.map(perm => (
            <span
              key={perm}
              className="inline-flex items-center gap-1 rounded-full border border-red-400/40 bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:text-red-400"
            >
              <XCircle className="h-3 w-3" />
              {perm}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
