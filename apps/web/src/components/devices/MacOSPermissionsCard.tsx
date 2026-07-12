import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TCCPermissions } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

const POLL_INTERVAL_MISSING = 30_000;  // 30s when any permission is missing
const POLL_INTERVAL_GRANTED = 300_000; // 5 min when all granted

type MacOSPermissionsCardProps = {
  deviceId: string;
  tccPermissions: TCCPermissions;
  formatDate: (dateString: string | null | undefined) => string;
};

export default function MacOSPermissionsCard({ deviceId, tccPermissions: initialTcc, formatDate }: MacOSPermissionsCardProps) {
  const { t } = useTranslation('devices');
  const [tccPermissions, setTccPermissions] = useState<TCCPermissions>(initialTcc);

  // Sync local state when parent passes new initial data (e.g. device switch)
  useEffect(() => {
    setTccPermissions(initialTcc);
  }, [initialTcc]);

  const fetchTcc = useCallback(() => {
    return fetchWithAuth(`/devices/${deviceId}`)
      .then(r => {
        if (!r.ok) {
          console.debug('[MacOSPermissionsCard] Non-OK response fetching device:', r.status);
          return null;
        }
        return r.json();
      })
      .then(data => {
        if (data?.tccPermissions) {
          setTccPermissions(data.tccPermissions);
        }
      })
      .catch((err) => {
        console.debug('[MacOSPermissionsCard] Error polling TCC status:', err);
      });
  }, [deviceId]);

  // Derive a stable boolean so the polling effect only resets when the
  // polling rate actually needs to change, not on every response.
  const hasMissing = !tccPermissions.fullDiskAccess
    || !tccPermissions.screenRecording
    || !tccPermissions.accessibility
    || tccPermissions.remoteDesktop === false;

  // Poll while any permission is missing; slow poll when all granted
  useEffect(() => {
    const interval = hasMissing ? POLL_INTERVAL_MISSING : POLL_INTERVAL_GRANTED;
    const timer = setInterval(fetchTcc, interval);
    return () => clearInterval(timer);
  }, [hasMissing, fetchTcc]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('macOSPermissionsCard.title')}</h3>
      </div>
      {hasMissing && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {!tccPermissions.fullDiskAccess
              ? t('macOSPermissionsCard.fullDiskAccessWarning')
              : tccPermissions.remoteDesktop === false
                ? t('macOSPermissionsCard.remoteDesktopWarning')
              : t('macOSPermissionsCard.configuringWarning')}
          </p>
        </div>
      )}
      <dl className="divide-y">
        <div className="flex justify-between py-2">
          <dt className="text-sm text-muted-foreground">{t('macOSPermissionsCard.permissions.fullDiskAccess')}</dt>
          <dd className="text-sm font-medium">
            {tccPermissions.fullDiskAccess ? (
              <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" /> {t('macOSPermissionsCard.states.granted')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <XCircle className="h-4 w-4" /> {t('macOSPermissionsCard.states.missing')}
              </span>
            )}
          </dd>
        </div>
        {([
          [t('macOSPermissionsCard.permissions.screenRecording'), tccPermissions.screenRecording],
          [t('macOSPermissionsCard.permissions.accessibility'), tccPermissions.accessibility],
          [t('macOSPermissionsCard.permissions.remoteDesktop'), tccPermissions.remoteDesktop],
        ] as const).map(([label, granted]) => (
          <div key={label} className="flex justify-between py-2">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium">
              {granted === true ? (
                <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" /> {t('macOSPermissionsCard.states.granted')}
                </span>
              ) : granted === false ? (
                <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                  <XCircle className="h-4 w-4" /> {t('macOSPermissionsCard.states.missing')}
                </span>
              ) : tccPermissions.fullDiskAccess ? (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" /> {t('macOSPermissionsCard.states.unknown')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  {t('macOSPermissionsCard.states.autoManaged')}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        {t('macOSPermissionsCard.lastChecked', { date: formatDate(tccPermissions.checkedAt) })}
      </p>
    </div>
  );
}
