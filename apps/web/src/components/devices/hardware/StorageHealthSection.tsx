import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { formatLastSeen } from '@/lib/formatTime';
import ComponentStatePill from './ComponentStatePill';
import ControllerCard, { PhysicalDisksTable } from './ControllerCard';
import SourcesFooter, { HARDWARE_DOCS_URL } from './SourcesFooter';
import HardwareEventsList from './HardwareEventsList';
import type { HardwareHealthView } from './types';

type Load = { status: 'loading' | 'error' | 'absent' } | { status: 'ready'; view: HardwareHealthView };
export default function StorageHealthSection({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoad({ status: 'loading' });
    void (async () => {
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}/hardware-health`, { signal: controller.signal });
        const body = await response.json();
        if (!active) return;
        if (response.status === 404 && body.error === 'no_hardware_health') {
          setLoad({ status: 'absent' });
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setLoad({ status: 'ready', view: body as HardwareHealthView });
      } catch {
        if (active) setLoad({ status: 'error' });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [deviceId, attempt]);
  const data = load.status === 'ready' ? load.view : null;
  const disabled = data?.policy?.enabled === false || data?.tiersRun.includes('disabled');
  const controllers = data?.components.filter(c => c.componentType === 'controller') ?? [];
  const disks = data?.components.filter(c => c.componentType === 'physical_disk') ?? [];
  const osDisks = disks.filter(c => c.source === 'windows_physical_disk' || c.source === 'smartctl');
  const backed = osDisks.filter(c => c.attributes.backedByVd === true);
  const standalone = osDisks.filter(c => c.attributes.backedByVd !== true);
  const storage = data?.components.filter(c => !['collector', 'bmc'].includes(c.componentType)) ?? [];
  const noTools = data && (data.tiersRun.includes('none') || (data.sources.length > 0
    && data.sources.every(s => s.status === 'unavailable')));
  const docs = <a className="underline text-primary" href={HARDWARE_DOCS_URL}>{t('hardwareHealth.docs')}</a>;
  return <section data-testid="hardware-storage-section" className="rounded-lg border bg-card p-4 shadow-xs sm:p-6 space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">{t('hardwareHealth.title')}</h3>
      {data && <ComponentStatePill health={data.health} stale={Boolean(disabled)} testId="hardware-rollup-pill" />}
    </header>
    {data?.lastCollectedAt && <p className="text-xs text-muted-foreground">
      {t('hardwareHealth.collected', { time: formatLastSeen(data.lastCollectedAt) })}
    </p>}
    {load.status === 'loading' && <p role="status">{t('hardwareHealth.loading')}</p>}
    {load.status === 'error' && <div role="alert"><p>{t('hardwareHealth.error')}</p>
      <button type="button" className="mt-2 text-primary underline" onClick={() => setAttempt(n => n + 1)}>
        {t('hardwareHealth.retry')}</button></div>}
    {load.status === 'absent' && <p data-testid="hardware-empty-state">{t('hardwareHealth.noReport')} {docs}</p>}
    {data && <>
      {disabled ? <p data-testid="hardware-empty-state">{t('hardwareHealth.disabled', {
        policy: data.policy?.policyName ?? '—',
      })}</p> : storage.length === 0 && <p data-testid="hardware-empty-state">
        {noTools ? t('hardwareHealth.noTools', { sources: data.sources.map(s => s.source).join(', ') })
          : t('hardwareHealth.noComponents')} {docs}
      </p>}
      {controllers.map(c => <ControllerCard key={c.componentKey} controller={c} components={data.components} />)}
      {controllers.length === 0 && disks.some(c => !osDisks.includes(c)) &&
        <PhysicalDisksTable disks={disks.filter(c => !osDisks.includes(c))} />}
      {osDisks.length > 0 && <div data-testid="hardware-os-disks" className="space-y-2">
        <h4 className="font-medium">{t('hardwareHealth.osDisks')}</h4>
        {standalone.length > 0 && <PhysicalDisksTable disks={standalone} />}
        {backed.length > 0 && <details data-testid="hardware-backed-disks">
          <summary data-testid="hardware-backed-toggle" className="cursor-pointer text-sm text-muted-foreground">
            {t('hardwareHealth.backed')} ({backed.length})</summary>
          <PhysicalDisksTable disks={backed} />
        </details>}
      </div>}
      <SourcesFooter sources={data.sources} lastCollectedAt={data.lastCollectedAt} />
      <HardwareEventsList events={data.events} />
    </>}
  </section>;
}
