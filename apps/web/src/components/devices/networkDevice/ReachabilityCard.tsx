// "Why does it say that?" — the card that answers it. One line per source that
// actually contributed an observation, each with its own age, because the whole
// point of D1 is that the page's verdict is derived from several sources whose
// freshness differs. The SNMP line is deliberately phrased as protocol-level:
// consecutive_failures increments at DISPATCH (snmpWorker's markPollDispatched),
// so "SNMP failing" can mean the bridging agent, not the device.

import { useTranslation } from 'react-i18next';
import EmptyState from '../../shared/EmptyState';
import { formatLastSeen } from '@/lib/formatTime';
import { formatPing } from '../../discovery/pingFormat';
import { Section } from './primitives';
import {
  formatAbsolute,
  formatCollectionSummary,
  formatReachability,
  reachabilitySourceKey,
  type ReachabilityTone,
  type TFn,
} from './reachabilityCopy';
import { PROBE_ERROR_KEYS, type useAssetProbe } from './useAssetProbe';
import type { Collection, Reachability } from './types';

const TONE_TEXT: Record<ReachabilityTone, string> = {
  success: 'text-success',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

const TONE_DOT: Record<ReachabilityTone, string> = {
  success: 'bg-success',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
};

export type DetailLine = { key: string; label: string; value: string; title: string };

/**
 * One line per branch of `reachability.detail` that is actually present.
 * Pure and exported so the copy can be asserted without rendering.
 */
export function detailLines(r: Reachability | null, t: TFn, timezone: string): DetailLine[] {
  if (!r) return [];
  const lines: DetailLine[] = [];
  const { networkCheck, probe, snmp, scan } = r.detail;

  if (networkCheck) {
    const parts = [t(/* i18n-dynamic */ `networkDeviceDetailPage.reachability.detail.check.${networkCheck.state}`)];
    if (networkCheck.responseMs !== null) parts.push(formatPing(networkCheck.responseMs));
    parts.push(formatLastSeen(networkCheck.observedAt, timezone));
    lines.push({
      key: 'network_check',
      label: t(/* i18n-dynamic */ reachabilitySourceKey('network_check')),
      value: parts.join(' · '),
      title: formatAbsolute(networkCheck.observedAt, timezone),
    });
  }

  if (probe) {
    const parts = [t(/* i18n-dynamic */ `networkDeviceDetailPage.reachability.detail.probe.${probe.state}`)];
    if (probe.responseMs !== null) parts.push(formatPing(probe.responseMs));
    if (probe.observedAt) parts.push(formatLastSeen(probe.observedAt, timezone));
    lines.push({
      key: 'probe',
      label: t(/* i18n-dynamic */ reachabilitySourceKey('probe')),
      value: parts.join(' · '),
      title: formatAbsolute(probe.observedAt, timezone),
    });
  }

  if (snmp) {
    const parts = [t(/* i18n-dynamic */ `networkDeviceDetailPage.reachability.detail.snmp.${snmp.state}`)];
    if (snmp.consecutiveFailures > 0) {
      parts.push(t('networkDeviceDetailPage.reachability.detail.snmpFailures', { count: snmp.consecutiveFailures }));
    }
    if (snmp.observedAt) parts.push(formatLastSeen(snmp.observedAt, timezone));
    lines.push({
      key: 'snmp',
      label: t(/* i18n-dynamic */ reachabilitySourceKey('snmp')),
      value: parts.join(' · '),
      title: formatAbsolute(snmp.observedAt, timezone),
    });
  }

  if (scan) {
    const parts = [t(/* i18n-dynamic */ `networkDeviceDetailPage.reachability.detail.scan.${scan.state}`)];
    if (scan.observedAt) parts.push(formatLastSeen(scan.observedAt, timezone));
    lines.push({
      // The testid stays `scan` for both sources — it is the scan/controller
      // branch — while the LABEL distinguishes a UniFi controller from a sweep.
      key: 'scan',
      label: t(/* i18n-dynamic */ reachabilitySourceKey(scan.source)),
      value: parts.join(' · '),
      title: formatAbsolute(scan.observedAt, timezone),
    });
  }

  return lines;
}

export type ReachabilityCardProps = {
  reachability: Reachability | null;
  collection: Collection | null;
  timezone: string;
  bridgeDeviceId: string | null;
  bridgeDeviceName: string | null;
  probeState: ReturnType<typeof useAssetProbe>;
  onViewMonitoring: () => void;
};

export function ReachabilityCard({
  reachability,
  collection,
  timezone,
  bridgeDeviceId,
  bridgeDeviceName,
  probeState,
  onViewMonitoring,
}: ReachabilityCardProps) {
  const { t } = useTranslation('devices');
  const tf = t as unknown as TFn;
  const headline = formatReachability(reachability, tf, timezone);
  const lines = detailLines(reachability, tf, timezone);
  const collectionSummary = formatCollectionSummary(collection, tf);
  const snmpFailing = reachability?.detail.snmp?.state === 'failing';

  return (
    <Section
      title={t('networkDeviceDetailPage.sections.reachability')}
      testId="network-detail-reachability-card"
    >
      <p
        className={`flex items-center gap-2 text-sm font-medium ${TONE_TEXT[headline.tone]}`}
        data-testid="network-detail-reach-headline"
        title={headline.title || undefined}
      >
        <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[headline.tone]}`} />
        {headline.label}
      </p>

      {lines.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          testId="network-detail-reach-empty"
          title={t('networkDeviceDetailPage.reachability.detail.emptyTitle')}
          description={t('networkDeviceDetailPage.reachability.detail.emptyDescription')}
        />
      ) : (
        <dl className="mt-3 space-y-2 border-t pt-3 text-sm">
          {lines.map((line) => (
            <div key={line.key} className="flex items-baseline justify-between gap-3" data-testid={`network-detail-reach-${line.key}`}>
              <dt className="shrink-0 text-muted-foreground">{line.label}</dt>
              <dd className="min-w-0 text-right" title={line.title || undefined}>{line.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {snmpFailing && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="network-detail-reach-snmp-note">
          {t('networkDeviceDetailPage.reachability.detail.snmpNote')}
        </p>
      )}

      {collectionSummary && (
        <div className="mt-3 border-t pt-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">
            {t('networkDeviceDetailPage.sections.collection')}
          </p>
          <p className="mt-1" data-testid="network-detail-collection-summary">{collectionSummary}</p>
          <button
            type="button"
            data-testid="network-detail-view-oids"
            onClick={onViewMonitoring}
            className="mt-1 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.collection.viewOids')}
          </button>
        </div>
      )}

      <div className="mt-3 flex items-baseline justify-between gap-3 border-t pt-3 text-sm" data-testid="network-detail-bridge-agent">
        <span className="shrink-0 text-muted-foreground">{t('networkDeviceDetailPage.fields.bridgingAgent')}</span>
        {bridgeDeviceId && bridgeDeviceName ? (
          <a
            href={`/devices/${bridgeDeviceId}`}
            data-testid="network-detail-bridge-agent-link"
            className="min-w-0 truncate text-right text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {bridgeDeviceName}
          </a>
        ) : (
          // A raw uuid is not an answer to "which agent" — until the device
          // list resolves the name, say unknown rather than print an id.
          <span aria-label={t('common:states.unknown')}>—</span>
        )}
      </div>

      <div className="mt-3 border-t pt-3">
        <button
          type="button"
          data-testid="network-detail-card-check-now"
          disabled={probeState.checking || probeState.pending}
          onClick={() => void probeState.checkNow()}
          className="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.probe.checkNow')}
        </button>
        {(probeState.checking || probeState.pending) && (
          <p className="mt-1 text-xs text-muted-foreground" role="status" data-testid="network-detail-card-probe-status">
            {t('networkDeviceDetailPage.probe.checking')}
          </p>
        )}
        {probeState.errorCode && (
          <p className="mt-1 text-xs text-destructive" role="status" data-testid="network-detail-card-probe-error">
            {t(/* i18n-dynamic */ `networkDeviceDetailPage.probe.errors.${PROBE_ERROR_KEYS[probeState.errorCode]}`)}
          </p>
        )}
      </div>
    </Section>
  );
}
