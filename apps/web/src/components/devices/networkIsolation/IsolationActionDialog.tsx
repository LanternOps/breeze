import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NETWORK_ISOLATION_TTL, startNetworkIsolationSchema, releaseNetworkIsolationSchema, extendNetworkIsolationSchema } from '@breeze/shared';
import { Dialog } from '../../shared/Dialog';
import { runAction, handleActionError } from '../../../lib/runAction';
import { fetchWithAuth } from '../../../stores/auth';
import { isolationRefusalCopy } from './isolationEligibility';

export interface IsolationActionDialogProps {
  deviceId: string;
  isolationId?: string;
  mode: 'start' | 'release' | 'extend';
  serverOs?: boolean;
  offline?: boolean;
  onClose: () => void;
  onSuccess: () => void;
}
const inputClass = 'mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm';
export default function IsolationActionDialog({ deviceId, isolationId, mode, serverOs, offline, onClose, onSuccess }: IsolationActionDialogProps) {
  const { t } = useTranslation('devices');
  const [reason, setReason] = useState('');
  const [ttlHours, setTtlHours] = useState<number>(NETWORK_ISOLATION_TTL.defaultHours);
  const [incidentId, setIncidentId] = useState('');
  const [incidentTitle, setIncidentTitle] = useState('');
  const [remoteRelay, setRemoteRelay] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const body = mode === 'start'
    ? { reason: reason.trim(), ttlHours, remoteRelay, ...(incidentId.trim() ? { incidentId: incidentId.trim() } : { createIncident: { title: incidentTitle.trim(), severity: 'p2' as const } }) }
    : mode === 'release' ? { reason: reason.trim() } : { ttlHours };
  const schema = mode === 'start' ? startNetworkIsolationSchema : mode === 'release' ? releaseNetworkIsolationSchema : extendNetworkIsolationSchema;
  const valid = schema.safeParse(body).success;
  const title = t(/* i18n-dynamic */ `networkIsolation.${mode}Title`);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/${deviceId}/network-isolation${mode === 'start' ? '' : `/${isolationId}/${mode}`}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        successMessage: t(/* i18n-dynamic */ `networkIsolation.${mode}Success`),
        errorFallback: t('networkIsolation.mutationError'),
        friendly: code => isolationRefusalCopy(code, t),
      });
      onSuccess();
      onClose();
    } catch (err) { handleActionError(err, t('networkIsolation.mutationError')); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Dialog open onClose={busy ? () => {} : onClose} title={title} maxWidth="lg" className="p-6">
    <form onSubmit={submit} className="space-y-4" data-testid="isolation-dialog">
      <h2 className="text-lg font-semibold">{title}</h2>
      {mode !== 'extend' && <p className="text-sm text-muted-foreground">{t(/* i18n-dynamic */ `networkIsolation.${mode}Description`)}</p>}
      {mode === 'start' && serverOs && <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="alert" data-testid="isolation-server-warning">{t('networkIsolation.serverWarning')}</p>}
      {mode !== 'extend' && <label className="block text-sm">{t('networkIsolation.reason')}<textarea data-testid="isolation-reason" required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} className={inputClass} disabled={busy} /></label>}
      {mode !== 'release' && <label className="block text-sm">{t('networkIsolation.ttlHours')}<input data-testid="isolation-ttl" type="number" required min={1} max={NETWORK_ISOLATION_TTL.maxHours} step={1} value={ttlHours} onChange={event => setTtlHours(event.target.valueAsNumber)} className={inputClass} disabled={busy} /></label>}
      {mode === 'start' && <>
        <label className="block text-sm">{t('networkIsolation.incidentId')}<input data-testid="isolation-incident-id" value={incidentId} onChange={event => setIncidentId(event.target.value)} className={inputClass} disabled={busy} /></label>
        {!incidentId.trim() && <label className="block text-sm">{t('networkIsolation.incidentTitle')}<input data-testid="isolation-incident-title" required maxLength={200} value={incidentTitle} onChange={event => setIncidentTitle(event.target.value)} className={inputClass} disabled={busy} /></label>}
        <label className="flex items-center gap-2 text-sm"><input data-testid="isolation-remote-relay" type="checkbox" checked={remoteRelay} onChange={event => setRemoteRelay(event.target.checked)} disabled={busy} />{t('networkIsolation.remoteRelay')}</label>
      </>}
      <div className="flex flex-wrap justify-end gap-3 pt-2">
        <button data-testid="isolation-cancel" type="button" onClick={onClose} disabled={busy} className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50">{t('common:actions.cancel')}</button>
        <button data-testid="isolation-submit" type="submit" disabled={!valid || busy} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">{busy ? t('common:states.processing') : mode === 'start' ? t('networkIsolation.isolate') : mode === 'extend' ? t('networkIsolation.extend') : t(/* i18n-dynamic */ offline ? 'networkIsolation.release_queued' : 'networkIsolation.release')}</button>
      </div>
    </form>
  </Dialog>;
}
