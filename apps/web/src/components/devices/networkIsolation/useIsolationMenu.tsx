import { useState } from 'react';
import { Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Device } from '../DeviceList';
import { useDeviceIsolation } from './useDeviceIsolation';
import { releaseEligibility, startEligibility, refusalKey } from './isolationEligibility';
import IsolateDialog from './IsolateDialog';
import ReleaseDialog from './ReleaseDialog';
import type { IsolationEpisode } from './types';

/** Menu wiring lives here so the three DeviceActions layouts share recovery semantics. */
export function useIsolationMenu(device: Device, permitted: boolean, menuOpen: boolean, closeMenu: () => void) {
  const { t } = useTranslation('devices');
  const { data, error, refresh } = useDeviceIsolation(device.id, permitted && menuOpen);
  const [dialog, setDialog] = useState<'start' | IsolationEpisode | null>(null);
  const episode = data?.episodes.find(row => releaseEligibility(row).visible);
  const start = startEligibility(error ? null : data);
  const blocked = !episode && !start.enabled;
  const label = episode ? t(/* i18n-dynamic */ device.status === 'offline' ? 'networkIsolation.release_queued' : 'networkIsolation.release') : t('networkIsolation.isolate');
  const reason = blocked ? t(/* i18n-dynamic */ refusalKey(start.reason ?? 'unavailable')) : undefined;
  const item = permitted ? <button
    type="button" role="menuitem" tabIndex={-1}
    data-testid={episode ? 'device-isolation-release' : 'device-isolation-start'}
    aria-disabled={blocked || undefined} title={reason}
    onClick={() => { if (blocked) return; closeMenu(); setDialog(episode ?? 'start'); }}
    className="flex w-full items-center gap-2 whitespace-nowrap px-4 py-2 text-left text-sm hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
  ><Shield className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="max-w-xs whitespace-normal">{label}{reason && <span className="block text-xs text-muted-foreground">{reason}</span>}</span></button> : null;
  const modal = !permitted || !dialog ? null : dialog === 'start'
    ? <IsolateDialog key={device.id} deviceId={device.id} serverOs={/server/i.test(device.osVersion) || device.deviceRole === 'server'} onClose={() => setDialog(null)} onSuccess={refresh} />
    : <ReleaseDialog key={dialog.id} deviceId={device.id} episode={dialog} offline={device.status === 'offline'} onClose={() => setDialog(null)} onSuccess={refresh} />;
  return { item, dialog: modal };
}
