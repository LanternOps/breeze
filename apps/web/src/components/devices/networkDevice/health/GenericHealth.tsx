// The default Health card: the template's key OIDs with their latest values.
// Deliberately NOT a chart — at this altitude the question is "is anything
// coming back", and a row that says WHY it isn't (unsupported + its error code,
// unknown + "update the agent") is worth more than a sparkline of nothing.

import { useTranslation } from 'react-i18next';
import { formatLastSeen } from '@/lib/formatTime';
import { Section } from '../primitives';
import { formatAbsolute } from '../reachabilityCopy';
import type { CollectionOid, CollectionOidState } from '../types';
import type { HealthCardProps } from './types';

const VISIBLE_ROWS = 8;

const STATE_KEYS: Record<CollectionOidState, string> = {
  collecting: 'networkDeviceDetailPage.collection.oidState.collecting',
  unsupported: 'networkDeviceDetailPage.collection.oidState.unsupported',
  stale: 'networkDeviceDetailPage.collection.oidState.stale',
  never_polled: 'networkDeviceDetailPage.collection.oidState.neverPolled',
  unknown: 'networkDeviceDetailPage.collection.oidState.unknown',
};

const STATE_CLASSES: Record<CollectionOidState, string> = {
  collecting: 'bg-success/15 text-success border-success/30',
  unsupported: 'bg-warning/15 text-warning border-warning/30',
  stale: 'bg-warning/15 text-warning border-warning/30',
  never_polled: 'bg-muted text-muted-foreground border-muted',
  unknown: 'bg-muted text-muted-foreground border-muted',
};

export function latestValue(entry: CollectionOid): string | null {
  const row = entry.instances[0];
  return row?.value ?? null;
}

export function GenericHealth({
  collection,
  timezone,
  onSetUpMonitoring,
  onViewMonitoring,
}: HealthCardProps) {
  const { t } = useTranslation('devices');

  if (collection && collection.status === 'no_template') {
    return (
      <Section title={t('networkDeviceDetailPage.sections.deviceHealth')} testId="network-detail-health">
        <p className="text-sm text-muted-foreground" data-testid="network-detail-health-no-template">
          {t('networkDeviceDetailPage.health.noTemplate')}
        </p>
        <button
          type="button"
          data-testid="network-detail-health-pick-template"
          onClick={onSetUpMonitoring}
          className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.health.pickTemplate')}
        </button>
      </Section>
    );
  }

  const oids = collection?.oids ?? [];
  const visible = oids.slice(0, VISIBLE_ROWS);

  return (
    <Section title={t('networkDeviceDetailPage.sections.deviceHealth')} testId="network-detail-health">
      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="network-detail-health-no-oids">
          {t('networkDeviceDetailPage.collection.count.noOids')}
        </p>
      ) : (
        <dl className="space-y-2 text-sm">
          {visible.map((entry) => {
            const value = latestValue(entry);
            return (
              <div
                key={entry.baseOid}
                className="flex items-baseline justify-between gap-3"
                data-testid={`network-detail-health-row-${entry.baseOid}`}
              >
                <dt className="min-w-0 truncate text-muted-foreground" title={entry.baseOid}>{entry.name}</dt>
                <dd className="flex min-w-0 shrink-0 items-center gap-2 text-right">
                  <span className="truncate" title={entry.observedAt ? formatAbsolute(entry.observedAt, timezone) : undefined}>
                    {value === null
                      ? <span aria-label={t('common:states.unknown')}>—</span>
                      : value}
                  </span>
                  <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-xs ${STATE_CLASSES[entry.state]}`}>
                    {t(/* i18n-dynamic */ STATE_KEYS[entry.state])}
                  </span>
                  {entry.state === 'unsupported' && entry.error && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{entry.error}</span>
                  )}
                  {entry.observedAt && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatLastSeen(entry.observedAt, timezone)}
                    </span>
                  )}
                </dd>
                {entry.state === 'unknown' && (
                  <p className="basis-full text-xs text-muted-foreground">
                    {t('networkDeviceDetailPage.collection.unknownNeedsAgentUpdate')}
                  </p>
                )}
              </div>
            );
          })}
        </dl>
      )}
      {oids.length > VISIBLE_ROWS && (
        <button
          type="button"
          data-testid="network-detail-health-view-all"
          onClick={onViewMonitoring}
          className="mt-2 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.health.viewAllOids', { count: oids.length })}
        </button>
      )}
    </Section>
  );
}
