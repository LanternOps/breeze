// Every status sentence on the network device page is built here. The spec's
// copy rule (§10, §11) is "no bare Online": each status string is
// `<state> · <source> <relative time>`. Keeping the assembly in one pure module
// is what stops the header badge, the stat strip and the two overview cards
// from drifting into three different phrasings of the same fact.

import { formatLastSeen } from '@/lib/formatTime';
import { formatTimestamp } from './format';
import type {
  Collection,
  Reachability,
  ReachabilitySource,
  ReachabilityState,
} from './types';

export type TFn = (key: string, options?: Record<string, unknown>) => string;
export type ReachabilityTone = 'success' | 'destructive' | 'muted';

export type ReachabilityCopy = {
  label: string;
  title: string;
  tone: ReachabilityTone;
  observedAt: string | null;
};

const SOURCE_KEYS: Record<ReachabilitySource, string> = {
  network_check: 'devices:networkDeviceDetailPage.reachability.source.networkCheck',
  probe: 'devices:networkDeviceDetailPage.reachability.source.probe',
  scan: 'devices:networkDeviceDetailPage.reachability.source.scan',
  unifi: 'devices:networkDeviceDetailPage.reachability.source.unifi',
  snmp: 'devices:networkDeviceDetailPage.reachability.source.snmp',
};

const STATE_KEYS: Record<ReachabilityState, string> = {
  responding: 'devices:networkDeviceDetailPage.reachability.state.responding',
  not_responding: 'devices:networkDeviceDetailPage.reachability.state.notResponding',
  unverified: 'devices:networkDeviceDetailPage.reachability.state.unverified',
};

const COLLECTION_STATUS_KEYS: Record<Collection['status'], string> = {
  ok: 'devices:networkDeviceDetailPage.collection.status.ok',
  failing: 'devices:networkDeviceDetailPage.collection.status.failing',
  no_template: 'devices:networkDeviceDetailPage.collection.status.noTemplate',
  no_agent: 'devices:networkDeviceDetailPage.collection.status.noAgent',
  asset_moved: 'devices:networkDeviceDetailPage.collection.status.assetMoved',
  never_polled: 'devices:networkDeviceDetailPage.collection.status.neverPolled',
  paused: 'devices:networkDeviceDetailPage.collection.status.paused',
};

export function reachabilitySourceKey(source: ReachabilitySource): string {
  return SOURCE_KEYS[source];
}

export function reachabilityToneFor(state: ReachabilityState): ReachabilityTone {
  if (state === 'responding') return 'success';
  if (state === 'not_responding') return 'destructive';
  return 'muted';
}

/**
 * The site's IANA zone when the asset has a site, else the browser's.
 *
 * `sites.timezone` is NOT NULL with a 'UTC' default, so a site-bound asset
 * always has one; null/'' means a site-less (manual) asset or a pre-W05 API.
 * Mirrors `DeviceDetails.tsx`'s `effectiveTimezone` fallback exactly.
 */
export function resolveAssetTimezone(siteTimezone?: string | null): string {
  if (typeof siteTimezone === 'string' && siteTimezone.trim() !== '') return siteTimezone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Absolute stamp for a `title` attribute; '' (never '—') when there is nothing to stamp. */
export function formatAbsolute(value: string | null | undefined, timezone: string): string {
  if (!value) return '';
  const formatted = formatTimestamp(value, timezone);
  return formatted === '—' ? '' : formatted;
}

export function formatReachability(
  r: Reachability | null | undefined,
  t: TFn,
  timezone: string,
): ReachabilityCopy {
  // A pre-W01 API (or a route that forgot the field) must not render as
  // "Offline" — an absent verdict is unverified, which is the honest word.
  if (!r) {
    return {
      label: `${t(/* i18n-dynamic */ STATE_KEYS.unverified)} · ${t('devices:networkDeviceDetailPage.reachability.neverObserved')}`,
      title: '',
      tone: 'muted',
      observedAt: null,
    };
  }

  const stateLabel = t(/* i18n-dynamic */ STATE_KEYS[r.state] ?? STATE_KEYS.unverified);

  if (r.state === 'unverified') {
    if (r.lastKnown) {
      return {
        label: `${stateLabel} · ${t('devices:networkDeviceDetailPage.reachability.lastSeenBy', {
          source: t(/* i18n-dynamic */ reachabilitySourceKey(r.lastKnown.source)),
          relative: formatLastSeen(r.lastKnown.observedAt, timezone),
        })}`,
        title: formatAbsolute(r.lastKnown.observedAt, timezone),
        tone: 'muted',
        observedAt: r.lastKnown.observedAt,
      };
    }
    return {
      label: `${stateLabel} · ${t('devices:networkDeviceDetailPage.reachability.neverObserved')}`,
      title: '',
      tone: 'muted',
      observedAt: null,
    };
  }

  const sourceLabel = r.source
    ? t(/* i18n-dynamic */ reachabilitySourceKey(r.source))
    : t('common:states.unknown');
  const relative = r.observedAt
    ? formatLastSeen(r.observedAt, timezone)
    : t('devices:networkDeviceDetailPage.reachability.neverObserved');

  return {
    label: `${stateLabel} · ${sourceLabel} ${relative}`,
    title: formatAbsolute(r.observedAt, timezone),
    tone: reachabilityToneFor(r.state),
    observedAt: r.observedAt,
  };
}

/** "3 collecting · 1 unsupported · 1 stale" — null when there is no SNMP device. */
export function formatCollectionSummary(
  collection: Collection | null | undefined,
  t: TFn,
): string | null {
  if (!collection) return null;
  const counts = { collecting: 0, unsupported: 0, stale: 0, never_polled: 0, unknown: 0 };
  for (const oid of collection.oids) counts[oid.state] += 1;

  const parts: string[] = [];
  if (counts.collecting > 0) parts.push(t('devices:networkDeviceDetailPage.collection.count.collecting', { count: counts.collecting }));
  if (counts.unsupported > 0) parts.push(t('devices:networkDeviceDetailPage.collection.count.unsupported', { count: counts.unsupported }));
  if (counts.stale > 0) parts.push(t('devices:networkDeviceDetailPage.collection.count.stale', { count: counts.stale }));
  if (counts.unknown > 0) parts.push(t('devices:networkDeviceDetailPage.collection.count.unknown', { count: counts.unknown }));
  if (counts.never_polled > 0) parts.push(t('devices:networkDeviceDetailPage.collection.count.neverPolled', { count: counts.never_polled }));

  if (parts.length === 0) return t('devices:networkDeviceDetailPage.collection.count.noOids');
  return parts.join(' · ');
}

/** The stat strip's "Last poll" cell: a status word paired with its age or its cause. */
export function formatLastPoll(
  collection: Collection | null | undefined,
  t: TFn,
  timezone: string,
): ReachabilityCopy {
  if (!collection) {
    return {
      label: t('devices:networkDeviceDetailPage.collection.status.notConfigured'),
      title: '',
      tone: 'muted',
      observedAt: null,
    };
  }

  const statusLabel = t(/* i18n-dynamic */ COLLECTION_STATUS_KEYS[collection.status]
    ?? COLLECTION_STATUS_KEYS.never_polled);

  // A cause (no template / no agent / moved) is the whole answer — pairing it
  // with "12 hr ago" would suggest something was actually polled 12 hours ago.
  if (collection.status === 'no_template' || collection.status === 'no_agent' || collection.status === 'asset_moved') {
    return { label: statusLabel, title: '', tone: 'destructive', observedAt: null };
  }
  if (collection.status === 'never_polled' || !collection.lastPolledAt) {
    return { label: statusLabel, title: '', tone: 'muted', observedAt: null };
  }

  const tone: ReachabilityTone =
    collection.status === 'ok' ? 'success' : collection.status === 'paused' ? 'muted' : 'destructive';

  return {
    label: `${statusLabel} · ${formatLastSeen(collection.lastPolledAt, timezone)}`,
    title: formatAbsolute(collection.lastPolledAt, timezone),
    tone,
    observedAt: collection.lastPolledAt,
  };
}
