import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import HashLink from '../shared/HashLink';
import '../../lib/i18n';

const POLL_MS = 30_000;

/**
 * "Backup running" chip for the device header (#11027). Links to the Backup
 * tab, where the progress cards live. Renders nothing while no backup runs, and
 * nothing when the request fails (a read-only viewer gets 403): it is an
 * at-a-glance hint, so a failure must not add noise to the header.
 */
export default function DeviceBackupActivityBadge({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async (wasRunning: boolean) => {
      let isRunning = false;
      let answered = false;
      try {
        const res = await fetchWithAuth(`/backup/jobs?deviceId=${encodeURIComponent(deviceId)}&status=running`);
        if (res.ok) {
          const payload = await res.json();
          isRunning = Array.isArray(payload?.data) && payload.data.length > 0;
          answered = true;
        }
      } catch {
        // Quiet by design: see the component comment.
      }
      if (cancelled) return;
      setRunning(isRunning);
      // A failed check says nothing about a backup that was running, so keep
      // checking and let the badge come back after a blip.
      const keepChecking = isRunning || (wasRunning && !answered);
      if (keepChecking) timer = setTimeout(() => void check(isRunning || wasRunning), POLL_MS);
    };

    void check(false);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [deviceId]);

  if (!running) return null;

  return (
    <HashLink
      hash="backup"
      data-testid="device-backup-running-badge"
      title={t('deviceDetails.backupRunningTooltip')}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/15"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {t('deviceDetails.backupRunning')}
    </HashLink>
  );
}
