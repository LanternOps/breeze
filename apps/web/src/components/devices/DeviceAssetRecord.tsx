// The Details tab's "Asset record": the editable, full-detail home of the
// facts the header summarises — who to contact, where the box physically
// sits, and which contract bills it. Overview stays a triage view and ends at
// the performance graphs (DeviceDetails.overviewOrder.test.tsx); a new record
// about the device joins this section, not the bottom of Overview.
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import ContactResponsibilitiesCard from '../shared/ContactResponsibilitiesCard';
import PhysicalPlacementCard from './PhysicalPlacementCard';
import DeviceBillingCard from './DeviceBillingCard';
import type { Device } from './DeviceList';

export default function DeviceAssetRecord({ device }: { device: Device }) {
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
        <PhysicalPlacementCard subject="device" id={device.id} />
        <DeviceBillingCard deviceId={device.id} />
      </div>
    </section>
  );
}
