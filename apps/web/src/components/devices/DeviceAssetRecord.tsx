// The Details tab's "Asset record": the full-detail home for who to contact
// and where the box physically sits (both summarised in the header), plus
// which contract bills it (Details only). Placement is edited here; contacts
// and billing are read-only. Overview stays a triage view and ends at
// the performance graphs (DeviceDetails.overviewOrder.test.tsx); a new record
// about the device joins this section, not the bottom of Overview.
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import ContactResponsibilitiesCard from '../shared/ContactResponsibilitiesCard';
import PhysicalPlacementCard from './PhysicalPlacementCard';
import DeviceBillingCard from './DeviceBillingCard';
import type { Device } from './DeviceList';

export default function DeviceAssetRecord({
  device,
  onPlacementSaved,
}: {
  device: Device;
  /** Placement is a header fact too; the page reloads it there. */
  onPlacementSaved?: () => void;
}) {
  const { t } = useTranslation('devices');
  return (
    <section data-testid="device-asset-record" aria-labelledby="device-asset-record-title" className="space-y-4">
      <div>
        <h2 id="device-asset-record-title" className="text-lg font-semibold">
          {t('deviceAssetRecord.title')}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('deviceAssetRecord.description')}</p>
      </div>
      <ContactResponsibilitiesCard
        orgId={device.orgId}
        siteId={device.siteId}
        deviceId={device.id}
        assignHref={device.orgId ? `/organizations/${device.orgId}#contacts` : undefined}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <PhysicalPlacementCard subject="device" id={device.id} onSaved={onPlacementSaved} />
        <DeviceBillingCard deviceId={device.id} />
      </div>
    </section>
  );
}
