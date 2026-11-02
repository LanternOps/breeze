import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../../lib/permissions';
import { useDeviceIsolation } from './useDeviceIsolation';
import { releaseEligibility } from './isolationEligibility';
import IsolationBadge from './IsolationBadge';
import ReleaseDialog from './ReleaseDialog';
import type { IsolationEpisode } from './types';

function IncidentDeviceIsolation({ deviceId, incidentId }: { deviceId: string; incidentId: string }) {
  const { t } = useTranslation('devices');
  const { data, error, refresh } = useDeviceIsolation(deviceId);
  const hasData = data !== null;
  const [device, setDevice] = useState<{ hostname?: string; displayName?: string; status?: string } | null>(null);
  useEffect(() => {
    if (!hasData) return;
    let cancelled = false;
    void fetchWithAuth(`/devices/${deviceId}`).then(async response => {
      if (response.ok) {
        const result = await response.json();
        if (!cancelled) setDevice(result);
      }
    }).catch(() => { /* Metadata never gates release; retain the last known status. */ });
    return () => { cancelled = true; };
  }, [deviceId, hasData]);
  const offline = device?.status === 'offline';
  const [release, setRelease] = useState<IsolationEpisode | null>(null);
  const episodes = data?.episodes.filter(episode => episode.incidentId === incidentId) ?? [];
  return <>
    {error && <p role="alert" className="text-sm text-destructive">{t('networkIsolation.loadError')} <button type="button" data-testid="incident-isolation-retry" onClick={refresh} className="underline">{t('networkIsolation.retry')}</button></p>}
    {episodes.map(episode => <div key={episode.id} data-testid="incident-isolation-episode" className="flex flex-wrap items-center gap-3 py-2">
      <a href={`/devices/${deviceId}`} data-testid="incident-isolation-device" className="font-mono text-xs text-primary underline">{device?.displayName || device?.hostname || deviceId}</a>
      <IsolationBadge episode={episode} onChange={refresh} />
      {releaseEligibility(episode).visible && <button type="button" data-testid="incident-isolation-release" onClick={() => setRelease(episode)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t(/* i18n-dynamic */ offline ? 'networkIsolation.release_queued' : 'networkIsolation.release')}</button>}
    </div>)}
    {release && <ReleaseDialog offline={offline} deviceId={deviceId} episode={release} onClose={() => setRelease(null)} onSuccess={refresh} />}
  </>;
}

export default function IncidentIsolation({ incidentId, deviceIds }: { incidentId: string; deviceIds: string[] }) {
  const { t } = useTranslation('devices');
  const { can } = usePermissions();
  if (!deviceIds.length || !can('devices', 'execute')) return null;
  return <section aria-label={t('networkIsolation.incidentHeading')} className="rounded-lg border bg-card p-4">
    <h2 className="text-sm font-medium">{t('networkIsolation.incidentHeading')}</h2>
    {[...new Set(deviceIds)].map(deviceId => <IncidentDeviceIsolation key={deviceId} deviceId={deviceId} incidentId={incidentId} />)}
  </section>;
}
