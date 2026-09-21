// What will actually fire. The OID is resolved to its template name when the
// collection knows it — a bare 1.3.6.1.2.1.43.11.1.1.9.1.1 in an alert list is
// unreadable to the technician who has to decide whether the rule is right.

import { useTranslation } from 'react-i18next';
import EmptyState from '../../shared/EmptyState';
import { Section } from './primitives';
import type { Collection } from './types';
import type { ThresholdSummary } from './useAssetMonitoring';

const SEVERITY_CLASSES: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  high: 'bg-destructive/10 text-destructive border-destructive/20',
  medium: 'bg-warning/15 text-warning border-warning/30',
  low: 'bg-muted text-muted-foreground border-muted',
  info: 'bg-muted text-muted-foreground border-muted',
};

/** Longest matching base OID wins, so an instance OID resolves to its column's name. */
export function oidDisplayName(oid: string, collection: Collection | null): string | null {
  if (!collection) return null;
  const match = collection.oids
    .filter((entry) => oid === entry.baseOid || oid.startsWith(`${entry.baseOid}.`))
    .sort((a, b) => b.baseOid.length - a.baseOid.length)[0];
  return match?.name ?? null;
}

export function ThresholdAlertsSection({
  thresholds,
  collection,
  thresholdsError = false,
  onRetry,
}: {
  thresholds: ThresholdSummary[];
  collection: Collection | null;
  thresholdsError?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation('devices');

  return (
    <Section title={t('networkDeviceDetailPage.sections.thresholds')} testId="network-detail-thresholds">
      {thresholdsError ? (
        <div>
          <p className="text-sm text-destructive" data-testid="network-detail-thresholds-error">
            {t('networkDeviceDetailPage.errors.thresholdsLoad')}
          </p>
          <button
            type="button"
            data-testid="network-detail-thresholds-retry"
            onClick={onRetry}
            className="mt-2 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.tryAgain')}
          </button>
        </div>
      ) : thresholds.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          testId="network-detail-thresholds-empty"
          title={t('networkDeviceDetailPage.thresholds.emptyTitle')}
          description={t('networkDeviceDetailPage.thresholds.emptyDescription')}
        />
      ) : (
        <ul className="divide-y text-sm">
          {thresholds.map((threshold) => {
            const name = oidDisplayName(threshold.oid, collection);
            return (
              <li key={threshold.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2" data-testid={`network-detail-threshold-${threshold.id}`}>
                <span className="min-w-0">
                  <span className="font-medium">{name ?? threshold.oid}</span>
                  {name && <span className="ml-1 font-mono text-xs text-muted-foreground">{threshold.oid}</span>}
                  {threshold.message && <span className="block text-xs text-muted-foreground">{threshold.message}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-xs">
                    {threshold.operator ?? '?'} {threshold.threshold ?? '?'}
                  </span>
                  <span className={`rounded-full border px-1.5 py-0.5 text-xs ${SEVERITY_CLASSES[threshold.severity] ?? SEVERITY_CLASSES.info}`}>
                    {t(/* i18n-dynamic */ `alerts:alertDetailPage.severity.${threshold.severity}`)}
                  </span>
                  {!threshold.isActive && (
                    <span className="text-xs text-muted-foreground">{t('common:states.disabled')}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
