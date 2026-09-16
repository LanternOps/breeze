// What the poller is configured to do, and whether it is doing it. The Edit
// button hands off to W04's settings modal — this page shows state, the modal
// owns every write (D7).

import { useTranslation } from 'react-i18next';
import { Section } from './primitives';
import { formatLastPoll, type TFn } from './reachabilityCopy';
import { buildDetailHash } from './settings/settingsHash';
import type { Collection } from './types';
import type { SnmpDeviceSummary } from './useAssetMonitoring';

/** 300 → "every 5 min"; 90 → "every 90 sec". */
export function formatInterval(seconds: number | null | undefined, t: TFn): string {
  if (!seconds || seconds <= 0) return t('common:states.unknown');
  if (seconds % 3600 === 0) return t('networkDeviceDetailPage.poll.everyHours', { count: seconds / 3600 });
  if (seconds % 60 === 0) return t('networkDeviceDetailPage.poll.everyMinutes', { count: seconds / 60 });
  return t('networkDeviceDetailPage.poll.everySeconds', { count: seconds });
}

export function PollConfigSummary({
  collection,
  snmpDevice,
  templateName,
  timezone,
  onEdit,
  templateError = false,
  onRetry,
}: {
  collection: Collection | null;
  snmpDevice: SnmpDeviceSummary | null;
  templateName: string | null;
  timezone: string;
  /** W04's `openSettings('monitoring')` when the page exposes it. */
  onEdit?: () => void;
  templateError?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation('devices');
  const tf = t as unknown as TFn;
  const poll = formatLastPoll(collection, tf, timezone);
  const unknown = <span aria-label={t('common:states.unknown')}>—</span>;

  const handleEdit = () => {
    if (onEdit) {
      onEdit();
      return;
    }
    // buildDetailHash returns the hash WITHOUT a leading '#'; the browser adds
    // it. Never hand-build this string — parseDetailHash is the only thing that
    // has to agree with the grammar, and it is W04's.
    window.location.hash = buildDetailHash('monitoring', 'monitoring');
  };

  return (
    <Section title={t('networkDeviceDetailPage.sections.pollConfiguration')} testId="network-detail-poll-config">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div data-testid="network-detail-poll-status">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.pollStatus')}</dt>
          <dd className="font-medium" title={poll.title || undefined}>{poll.label}</dd>
        </div>
        <div data-testid="network-detail-poll-template">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.template')}</dt>
          <dd className="font-medium break-words">
            {templateError ? (
              <>
                <p className="text-sm text-destructive" data-testid="network-detail-template-error">
                  {t('networkDeviceDetailPage.errors.templateLoad')}
                </p>
                <button
                  type="button"
                  data-testid="network-detail-template-retry"
                  onClick={onRetry}
                  className="mt-2 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('networkDeviceDetailPage.tryAgain')}
                </button>
              </>
            ) : templateName ?? unknown}
          </dd>
        </div>
        <div data-testid="network-detail-poll-interval">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.pollingInterval')}</dt>
          <dd className="font-medium">
            {formatInterval(collection?.pollingInterval ?? snmpDevice?.pollingInterval, tf)}
          </dd>
        </div>
        <div data-testid="network-detail-poll-transport">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.snmpTransport')}</dt>
          <dd className="font-medium">
            {snmpDevice ? `${snmpDevice.snmpVersion} · ${snmpDevice.port}` : unknown}
          </dd>
        </div>
      </dl>
      <button
        type="button"
        data-testid="network-detail-edit-poll-config"
        onClick={handleEdit}
        className="mt-3 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('common:actions.edit')}
      </button>
    </Section>
  );
}
