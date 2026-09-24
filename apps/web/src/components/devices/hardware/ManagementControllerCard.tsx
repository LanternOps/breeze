import { useTranslation } from 'react-i18next';
import type { HardwareComponentView } from './types';

const text = (value: unknown): string => typeof value === 'string' && value.trim() ? value : '—';
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ManagementControllerCard({ component }: { component: HardwareComponentView }) {
  const { t } = useTranslation('devices');
  const link = object(component.attributes.bmcLink);
  const assetId = typeof link.assetId === 'string' && UUID_RE.test(link.assetId) ? link.assetId : null;
  const linked = (link.status === 'linked' || link.status === 'already_linked') && assetId;
  const ip = text(component.attributes.ip);
  return <section data-testid="hardware-management-controller-card" className="rounded-lg border bg-card p-4 space-y-3">
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="font-medium">{t('hardwareHealth.managementController', { defaultValue: 'Management controller' })}</h4>
      <span className="text-sm text-muted-foreground">{component.name}</span>
    </header>
    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{t('hardwareHealth.bmcVendor', { defaultValue: 'Vendor' })}</dt>
        <dd>{text(component.attributes.vendor)}</dd></div>
      <div><dt className="text-muted-foreground">{t('hardwareHealth.bmcFirmware', { defaultValue: 'Firmware' })}</dt>
        <dd>{text(component.firmware)}</dd></div>
      <div><dt className="text-muted-foreground">{t('hardwareHealth.bmcIp', { defaultValue: 'IP address' })}</dt>
        <dd data-testid="hardware-bmc-ip">{linked ? <a data-testid="hardware-bmc-asset-link"
          href={`/devices/network/${assetId}`} className="text-primary hover:underline">{ip === '—' ? component.name : ip}</a> : ip}</dd></div>
      <div><dt className="text-muted-foreground">{t('hardwareHealth.bmcMac', { defaultValue: 'MAC address' })}</dt>
        <dd className="break-all font-mono">{text(component.attributes.mac)}</dd></div>
    </dl>
    {link.status === 'other_site' && typeof link.siteName === 'string' && <p data-testid="hardware-bmc-other-site" className="text-sm text-muted-foreground">
      {t('hardwareHealth.bmcOtherSite', { defaultValue: 'Management controller found in site {{site}}', site: link.siteName })}
    </p>}
    <p className="text-xs text-muted-foreground">
      {t('hardwareHealth.bmcObserved', { defaultValue: 'Last reported {{time}}; collected daily.', time: new Date(component.lastSeenAt).toLocaleString() })}
    </p>
  </section>;
}
