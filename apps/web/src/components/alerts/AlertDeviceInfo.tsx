import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

export type AlertDeviceInfoProps = {
  deviceId: string;
  deviceName: string;
  ruleName?: string;
  monitorId?: string | null;
};

/**
 * Device / alert-rule / monitor field rows shared by the alert detail
 * slide-over (`AlertDetails.tsx`) and the full alert detail page
 * (`AlertDetailPage.tsx`). Extracted per #5678 — `AlertDetailPage` had
 * re-implemented this block by hand and drifted out of sync with the
 * `monitor_id` link added for #5287, so it never rendered there.
 *
 * Renders only the field rows, not a wrapping card/heading — the two hosts
 * lay this out differently (grid vs. stacked), so each caller keeps its own
 * wrapper and just places this inside it.
 */
export default function AlertDeviceInfo({ deviceId, deviceName, ruleName, monitorId }: AlertDeviceInfoProps) {
  const { t } = useTranslation('alerts');

  return (
    <>
      <div>
        <p className="text-xs text-muted-foreground">{t('alertDetails.device')}</p>
        <a
          href={`/devices/${deviceId}`}
          className="flex items-center gap-1 text-sm font-medium hover:underline"
        >
          {deviceName}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {ruleName && (
        <div>
          <p className="text-xs text-muted-foreground">{t('alertDetails.alertRule')}</p>
          <p className="text-sm font-medium">{ruleName}</p>
          <a href="/configuration-policies" className="mt-1 flex items-center gap-1 text-xs hover:underline">
            {t('alertDetails.managedInConfigurationPolicies')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
      {monitorId && (
        // #5287 — raised by a rule compiled from a monitor definition.
        // The monitor UI page lands in a later wave; the route is
        // reserved now so this link lights up without another edit.
        <div data-testid="alert-details-monitor">
          <p className="text-xs text-muted-foreground">{t('monitoring:managed.monitorLabel')}</p>
          <a
            href={`/alerts/monitors/${monitorId}`}
            className="flex items-center gap-1 text-sm font-medium hover:underline"
          >
            {t('monitoring:managed.open')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </>
  );
}
