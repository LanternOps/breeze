// The printer Health card. Every number here is a claim about a physical
// consumable, so each one is either shown with its unit or shown as unknown —
// there is no in-between. A negative prtMarkerSuppliesLevel (RFC 3805's
// "other"/"unknown"/"some remaining") is the case that used to render as a
// negative bar; it now renders as the word.

import { useTranslation } from 'react-i18next';
import { formatNumber, formatPercent } from '@/lib/i18n/format';
import { formatLastSeen } from '@/lib/formatTime';
import { formatAbsolute } from '../reachabilityCopy';
import { Section } from '../primitives';
import { useAssetMetrics } from '../useAssetMetrics';
import {
  groupSupplies,
  readPageCount,
  readStatusWords,
  summariseDeltas,
  type SupplyReading,
  type ReadingFreshness,
} from './printerMib';
import type { HealthCardProps } from './types';

/** At or below this, the supply is called out in words as well as color. */
const LOW_SUPPLY_PERCENT = 20;
/** One request covers both deltas: yesterday is the last bucket, the week is the last seven. */
const PAGE_COUNT_WINDOW_MS = 8 * 86_400_000;

function StaleReading({ reading, timezone }: { reading: ReadingFreshness | null; timezone: string }) {
  const { t } = useTranslation('devices');
  if (reading?.state !== 'stale') return null;
  return (
    <span className="ml-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span className="rounded-full border border-warning/30 bg-warning/15 px-1.5 py-0.5 text-warning">
        {t('networkDeviceDetailPage.collection.oidState.stale')}
      </span>
      {reading.observedAt && <span title={formatAbsolute(reading.observedAt, timezone)}>{formatLastSeen(reading.observedAt, timezone)}</span>}
    </span>
  );
}

function SupplyMeter({ supply, timezone }: { supply: SupplyReading; timezone: string }) {
  const { t } = useTranslation('devices');
  const label =
    supply.description
    ?? supply.colorant
    ?? t('networkDeviceDetailPage.printer.supplyFallback', { instance: supply.instance });
  const stale = supply.state === 'stale';
  const low = !stale && supply.percent !== null && supply.percent <= LOW_SUPPLY_PERCENT;

  return (
    <div data-testid={`network-detail-supply-${supply.instance}`}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums">
          {stale ? <StaleReading reading={supply} timezone={timezone} /> : supply.percent === null ? (
            <span aria-label={t('common:states.unknown')}>{t('common:states.unknown')}</span>
          ) : (
            <>
              {formatPercent(supply.percent / 100, { maximumFractionDigits: 0 })}
              {/* The word, not only the warning hue — color alone is not a signal. */}
              {low && <span className="ml-1 text-warning">{t('networkDeviceDetailPage.printer.low')}</span>}
            </>
          )}
        </span>
      </div>
      {supply.percent !== null && (
        <div
          role="meter"
          aria-valuenow={supply.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={stale ? `${label} · ${t('networkDeviceDetailPage.collection.oidState.stale')}` : label}
          className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={`h-full rounded-full ${stale ? 'bg-muted-foreground/30' : low ? 'bg-warning' : 'bg-primary'}`}
            style={{ width: `${supply.percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function PrinterHealth({
  assetId,
  collection,
  timezone,
  onSetUpMonitoring,
}: HealthCardProps) {
  const { t } = useTranslation('devices');
  const supplies = groupSupplies(collection);
  const pageCount = readPageCount(collection);
  const { printerStatus, deviceStatus, errors, freshness } = readStatusWords(collection);

  // `oid: null` suspends the hook, so a printer with no page-count OID makes no
  // request at all rather than firing one that can only 400.
  const { series, error: deltaError } = useAssetMetrics({
    assetId,
    oid: pageCount?.instanceOid ?? null,
    range: '7d',
    windowMs: PAGE_COUNT_WINDOW_MS,
    bucket: '1d',
    delta: true,
  });
  const deltas = summariseDeltas(series[0]?.points ?? []);

  if (collection?.status === 'no_template') {
    return (
      <Section title={t('networkDeviceDetailPage.sections.printerHealth')} testId="network-detail-health">
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

  // Nothing readable yet. The honest cause on a legacy agent is that it issues
  // a GET against column OIDs and stores nulls (spec §1 F3) — name the fix.
  if (supplies.length === 0 && pageCount === null && printerStatus === null && deviceStatus === null && errors.length === 0) {
    return (
      <Section title={t('networkDeviceDetailPage.sections.printerHealth')} testId="network-detail-health">
        <p className="text-sm text-muted-foreground" data-testid="network-detail-health-unavailable">
          {t('networkDeviceDetailPage.printer.notCollectedYet')}
          {collection?.oids.some((entry) => entry.state === 'unknown') && (
            <>{' '}{t('networkDeviceDetailPage.collection.unknownNeedsAgentUpdate')}</>
          )}
        </p>
      </Section>
    );
  }

  return (
    <Section title={t('networkDeviceDetailPage.sections.printerHealth')} testId="network-detail-health">
      {(printerStatus || deviceStatus) && (
        <p className="text-sm" data-testid="network-detail-printer-status">
          {printerStatus && <span className={freshness.printerStatus?.state === 'stale' ? 'text-muted-foreground' : undefined}>{t(/* i18n-dynamic */ `networkDeviceDetailPage.printer.status.${printerStatus}`)}<StaleReading reading={freshness.printerStatus} timezone={timezone} /></span>}
          {printerStatus && deviceStatus && ' · '}
          {deviceStatus && <span className={freshness.deviceStatus?.state === 'stale' ? 'text-muted-foreground' : undefined}>{t(/* i18n-dynamic */ `networkDeviceDetailPage.printer.deviceStatus.${deviceStatus}`)}<StaleReading reading={freshness.deviceStatus} timezone={timezone} /></span>}
        </p>
      )}

      {errors.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="network-detail-printer-errors">
          {errors.map((bit) => (
            <li
              key={bit}
              className="rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-xs text-warning"
            >
              {t(/* i18n-dynamic */ `networkDeviceDetailPage.printer.errors.${bit}`)}
            </li>
          ))}
          {freshness.errors?.state === 'stale' && <li><StaleReading reading={freshness.errors} timezone={timezone} /></li>}
        </ul>
      )}

      {supplies.length > 0 && (
        <div className="mt-3 space-y-2 border-t pt-3">
          {supplies.map((supply) => (
            <SupplyMeter key={supply.instance} supply={supply} timezone={timezone} />
          ))}
        </div>
      )}

      {pageCount && (
        <div className="mt-3 border-t pt-3 text-sm">
          <dl>
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.printer.pageCount')}</dt>
            <dd className="font-medium tabular-nums" data-testid="network-detail-page-count">
              {formatNumber(pageCount.value)}
            </dd>
          </dl>
          {/* Absent deltas stay absent: "0 since yesterday" is a different
              claim from "we could not read yesterday". */}
          {!deltaError && (deltas.yesterday !== null || deltas.lastWeek !== null) && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="network-detail-page-deltas">
              {[
                deltas.yesterday !== null
                  ? t('networkDeviceDetailPage.printer.sinceYesterday', { count: deltas.yesterday })
                  : null,
                deltas.lastWeek !== null
                  ? t('networkDeviceDetailPage.printer.sinceLastWeek', { count: deltas.lastWeek })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
