import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isActiveIsolationState, isUnresolvedIsolationState, isUnresolvedTerminalIsolationState } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, handleActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
import type { IsolationEpisode } from './types';
import { useDeviceIsolation } from './useDeviceIsolation';
import BreakGlassCodePopover from './BreakGlassCodePopover';
import IsolationActionDialog from './IsolationActionDialog';
import { isolationRefusalCopy } from './isolationEligibility';
import '../../../lib/i18n';

export default function IsolationBadge({ episode, onChange }: { episode: IsolationEpisode; onChange: () => void }) {
  const { t } = useTranslation('devices');
  const [busy, setBusy] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const pending = useRef(false);
  const hours = Math.max(0, Math.ceil((new Date(episode.expiresAt).getTime() - Date.now()) / 3600000));
  const active = isActiveIsolationState(episode.state);
  // The server refuses extend once release is requested; never offer an action that always fails.
  const extendable = active && episode.state !== 'release_requested';
  async function acknowledge() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/${episode.deviceId}/network-isolation/${episode.id}/acknowledge`, { method: 'POST' }),
        successMessage: t('networkIsolation.acknowledgeSuccess'),
        errorFallback: t('networkIsolation.acknowledgeError'),
        friendly: code => isolationRefusalCopy(code, t),
      });
      onChange();
    } catch (err) { handleActionError(err, t('networkIsolation.acknowledgeError')); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="flex flex-wrap items-center gap-2">
    <span data-testid="isolation-badge" role="status" className="inline-flex rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium">
      {episode.state === 'verified' ? t('networkIsolation.isolatedExpires', { hours }) : t(/* i18n-dynamic */ `networkIsolation.states.${episode.state}`)}
    </span>
    {active && <>
      <BreakGlassCodePopover deviceId={episode.deviceId} isolationId={episode.id} generation={episode.lastReportedGeneration ?? episode.generation} />
      {extendable && <button type="button" data-testid="isolation-extend" onClick={() => setExtendOpen(true)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t('networkIsolation.extend')}</button>}
    </>}
    {isUnresolvedTerminalIsolationState(episode.state) && <button type="button" data-testid="isolation-acknowledge" disabled={busy} onClick={() => void acknowledge()} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">{t('networkIsolation.acknowledge')}</button>}
    {extendOpen && <IsolationActionDialog mode="extend" deviceId={episode.deviceId} isolationId={episode.id} onClose={() => setExtendOpen(false)} onSuccess={onChange} />}
  </div>;
}

function DeviceIsolationStatus({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const { data, error, refresh } = useDeviceIsolation(deviceId);
  const episode = data?.episodes.find(row => isUnresolvedIsolationState(row.state));
  return <>
    {episode && <IsolationBadge episode={episode} onChange={refresh} />}
    {error && <button type="button" data-testid="isolation-status-retry" onClick={refresh} title={t('networkIsolation.loadError')} className="text-sm text-destructive underline">{t('networkIsolation.retry')}</button>}
  </>;
}

/** Do not fetch the execute-protected endpoint for read-only viewers. */
export function DeviceIsolationBadge({ deviceId }: { deviceId: string }) {
  const { can } = usePermissions();
  return can('devices', 'execute') ? <DeviceIsolationStatus deviceId={deviceId} /> : null;
}
