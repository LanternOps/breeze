import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';
import { formatLastSeen } from '@/lib/formatTime';
import ComponentStatePill from './ComponentStatePill';
import type { HardwareComponentView } from './types';
const datum = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
function smartPowerOnHours(attributes: Record<string, unknown>): unknown {
  const smart = attributes.smart;
  return typeof smart === 'object' && smart !== null && !Array.isArray(smart)
    ? (smart as Record<string, unknown>).powerOnHours : undefined;
}
const size = (bytes: number | null): string => bytes === null ? '—'
  : `${formatNumber(bytes / 1024 ** 3, { maximumFractionDigits: 1 })} GiB`;
const expired = (c: HardwareComponentView) => c.stale || !c.fresh;
function State({ c }: { c: HardwareComponentView }) {
  const { t } = useTranslation('devices');
  return <>
    <ComponentStatePill health={c.health} state={c.state} stale={expired(c)}
      predictiveFailure={c.predictiveFailure} title={c.stateDetail ?? undefined} />
    {expired(c) && <p className="mt-1 text-xs text-muted-foreground">
      {t('hardwareHealth.notSeen', { time: formatLastSeen(c.lastSeenAt) })}
    </p>}
  </>;
}
export function PhysicalDisksTable({ disks }: { disks: HardwareComponentView[] }) {
  const { t } = useTranslation('devices');
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm">
    <thead><tr className="border-b text-xs text-muted-foreground">
      <th scope="col" className="p-2">{t('hardwareHealth.diskIdentity')}</th>
      <th scope="col" className="p-2">{t('hardwareHealth.size')}</th>
      <th scope="col" className="p-2">{t('hardwareHealth.state')}</th>
      <th scope="col" className="p-2">{t('hardwareHealth.telemetry')}</th>
    </tr></thead>
    <tbody>{disks.map(c => <tr key={c.componentKey}
      data-testid={`hardware-disk-${c.componentKey}`}
      className={`border-b align-top ${expired(c) ? 'opacity-60 text-muted-foreground' : ''}`}>
      <td className="p-2"><p>{datum(c.attributes.slot)} · {c.name}</p>
        <p>{c.model ?? '—'}</p><p className="font-mono text-xs">{c.serial ?? '—'}</p>
        <p>{datum(c.attributes.mediaType)} / {datum(c.attributes.interface)}</p></td>
      <td className="p-2 whitespace-nowrap">{size(c.sizeBytes)}</td>
      <td className="p-2"><State c={c} /></td>
      <td className="p-2 whitespace-nowrap">{c.temperatureC === null ? '—' : `${c.temperatureC} °C`}
        {' / '}{datum(c.attributes.mediaErrors)}{' / '}{datum(c.attributes.otherErrors)}
        {' / '}{datum(smartPowerOnHours(c.attributes))}</td>
    </tr>)}</tbody>
  </table></div>;
}
export default function ControllerCard({ controller, components }: {
  controller: HardwareComponentView; components: HardwareComponentView[];
}) {
  const { t } = useTranslation('devices');
  const children = components.filter(c => c.parentKey === controller.componentKey);
  const virtual = children.filter(c => c.componentType === 'virtual_disk');
  const virtualKeys = new Set(virtual.map(c => c.componentKey));
  const memberKeys = new Set(virtual.flatMap(c => Array.isArray(c.attributes.memberKeys)
    ? c.attributes.memberKeys.filter((key): key is string => typeof key === 'string') : []));
  const disks = components.filter(c => c.componentType === 'physical_disk'
    && (c.parentKey === controller.componentKey || virtualKeys.has(c.parentKey ?? '')
      || memberKeys.has(c.componentKey))
    && c.source !== 'windows_physical_disk' && c.source !== 'smartctl');
  return <article data-testid="hardware-controller-card" className="rounded-lg border p-4 space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div><h4 className="font-semibold">{controller.name}</h4>
        <p className="text-xs text-muted-foreground">{t('hardwareHealth.identity')}</p>
        <p className="text-sm">{controller.model ?? '—'} / {controller.serial ?? '—'} / {controller.firmware ?? '—'}</p>
      </div><State c={controller} />
    </header>
    <div className="flex flex-wrap items-center gap-2">
      {children.filter(c => c.componentType === 'cache_battery').map(c =>
        <div key={c.componentKey}>{c.name} <State c={c} /></div>)}
      <span className="text-xs text-muted-foreground">{t('hardwareHealth.enclosures', {
        total: children.filter(c => c.componentType === 'enclosure').length,
      })}</span>
    </div>
    {virtual.length > 0 && <div><h5 className="mb-2 text-sm font-medium">{t('hardwareHealth.virtualDisks')}</h5>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr><th scope="col">{t('hardwareHealth.virtualDisks')}</th><th scope="col">RAID</th>
          <th scope="col">{t('hardwareHealth.size')}</th><th scope="col">{t('hardwareHealth.state')}</th></tr></thead>
        <tbody>{virtual.map(c => <tr key={c.componentKey} className={expired(c) ? 'opacity-60' : ''}>
          <td className="py-2">{c.name}</td><td>{datum(c.attributes.raidLevel)}</td>
          <td>{size(c.sizeBytes)}</td><td><State c={c} />
            {c.progressPercent !== null && <div className="flex items-center gap-2">
              <progress data-testid={`hardware-progress-${c.componentKey}`} max={100}
                value={c.progressPercent} className="h-2 w-24 accent-warning"
                aria-label={t('hardwareHealth.progress', { name: c.name })} />
              <span>{c.progressPercent}%</span></div>}
          </td></tr>)}</tbody>
      </table></div></div>}
    {disks.length > 0 && <div><h5 className="mb-2 text-sm font-medium">{t('hardwareHealth.physicalDisks')}</h5>
      <PhysicalDisksTable disks={disks} /></div>}
  </article>;
}
