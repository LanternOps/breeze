import { useEffect, useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatNumber } from '@/lib/i18n/format';
import { fetchWithAuth } from '../../stores/auth';
import { createCancellableRequest } from '../../lib/cancellableRequest';

export type ReliabilityBaselineReason = 'reimaged' | 'remediated' | 'hardware_replaced';
export type ReliabilityBaselineSource = 'manual' | 'bare_metal_recovery';

// The active marker as summarised on the `GET /reliability/:deviceId` snapshot.
export type ReliabilityBaselineDetails = {
  id: string;
  baselineAt: string;
  reason: ReliabilityBaselineReason;
  source: ReliabilityBaselineSource;
  reportedDaysSinceBaseline: number;
  provisional: boolean;
};

type BaselineUser = { id: string; name: string | null } | null;

type BaselineBeforeSnapshot = {
  coverageDays: number;
  reliabilityScore: number;
  counts30d: { crashes: number; hangs: number; serviceFailures: number; hardwareErrors: number };
};

// One row of `GET /reliability/:deviceId/baselines` (newest first).
type ReliabilityBaselineMarker = {
  id: string;
  baselineAt: string;
  reason: ReliabilityBaselineReason;
  source: ReliabilityBaselineSource;
  note: string | null;
  beforeSnapshot: BaselineBeforeSnapshot | null;
  createdBy: BaselineUser;
  createdAt: string;
  clearedAt: string | null;
  clearedBy: BaselineUser;
  active: boolean;
};

export type ReliabilityBaselineSectionProps = {
  deviceId: string;
  snapshot: {
    reliabilityScore: number;
    crashCount30d: number;
    hangCount30d: number;
    serviceFailureCount30d: number;
    hardwareErrorCount30d: number;
    provisional: boolean;
    baseline: ReliabilityBaselineDetails | null;
  };
  // Consumed by the write actions (Task 12); accepted now so the mount site is final.
  canWrite: boolean;
  onChanged: () => void;
};

// Mirrors the scorer's provisional floor: a marker matures after this many
// distinct reported days.
const REQUIRED_REPORTED_DAYS = 14;
// The before-snapshot's scoring window; a shorter coverage gets a caption.
const FULL_COVERAGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; markers: ReliabilityBaselineMarker[] };

function formatMarkerDate(value: string): string {
  return formatDateTime(value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', fallback: value });
}

function markerAuthor(
  t: TFunction,
  marker: { source: ReliabilityBaselineSource; createdBy?: BaselineUser }
): string {
  if (marker.createdBy?.name) return marker.createdBy.name;
  if (marker.source === 'bare_metal_recovery') return t('deviceReliabilityPanel.baseline.system');
  // Either no author row, or an author invisible to this viewer (partner staff
  // under an org-scoped session).
  return t('deviceReliabilityPanel.baseline.someone');
}

function reasonLabel(t: TFunction, reason: ReliabilityBaselineReason): string {
  return t(/* i18n-dynamic */ `deviceReliabilityPanel.baseline.reasons.${reason}`);
}

function calendarDaysSince(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / DAY_MS));
}

export default function ReliabilityBaselineSection({ deviceId, snapshot }: ReliabilityBaselineSectionProps) {
  const { t } = useTranslation('devices');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    const request = createCancellableRequest();
    setState({ status: 'loading' });
    setHistoryOpen(false);
    (async () => {
      try {
        const response = await fetchWithAuth(`/reliability/${deviceId}/baselines`, { signal: request.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (request.cancelled) return;
        setState({ status: 'ready', markers: Array.isArray(json?.baselines) ? json.baselines : [] });
      } catch (err) {
        if (request.cancelled) return;
        // A read: the marker section is supplementary, so a failure must not
        // take the score panel down with it — log and render nothing.
        console.error('[ReliabilityBaselineSection] failed to load baseline markers', err);
        setState({ status: 'error' });
      } finally {
        request.settle();
      }
    })();
    return () => request.cancel();
  }, [deviceId]);

  if (state.status !== 'ready') return null;
  const { markers } = state;
  const baseline = snapshot.baseline;
  if (markers.length === 0 && !baseline) return null;

  // The snapshot names the marker the score was computed against; prefer it so
  // the banner and the score can't disagree mid-race.
  const activeMarker = baseline
    ? markers.find((marker) => marker.id === baseline.id) ?? null
    : null;
  const before = activeMarker?.beforeSnapshot ?? null;

  const beforeAfterRows = before
    ? [
        { key: 'score', label: t('deviceReliabilityPanel.score'), before: before.reliabilityScore, now: snapshot.reliabilityScore },
        { key: 'crashes', label: t('deviceReliabilityPanel.issueLabels.crashes'), before: before.counts30d.crashes, now: snapshot.crashCount30d },
        { key: 'hangs', label: t('deviceReliabilityPanel.issueLabels.hangs'), before: before.counts30d.hangs, now: snapshot.hangCount30d },
        { key: 'serviceFailures', label: t('deviceReliabilityPanel.issueLabels.services'), before: before.counts30d.serviceFailures, now: snapshot.serviceFailureCount30d },
        { key: 'hardwareErrors', label: t('deviceReliabilityPanel.issueLabels.hardware'), before: before.counts30d.hardwareErrors, now: snapshot.hardwareErrorCount30d },
      ]
    : [];

  return (
    <div className="mt-4 space-y-3" data-testid="reliability-baseline-section">
      {baseline && (
        <div
          data-testid="reliability-baseline-banner"
          className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm"
        >
          <History className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p>
              {baseline.provisional
                ? t('deviceReliabilityPanel.baseline.bannerProvisional', {
                    reason: reasonLabel(t, baseline.reason),
                    date: formatMarkerDate(baseline.baselineAt),
                    who: markerAuthor(t, activeMarker ?? baseline),
                    days: baseline.reportedDaysSinceBaseline,
                    required: REQUIRED_REPORTED_DAYS,
                  })
                : t('deviceReliabilityPanel.baseline.bannerMature', {
                    reason: reasonLabel(t, baseline.reason),
                    date: formatMarkerDate(baseline.baselineAt),
                    who: markerAuthor(t, activeMarker ?? baseline),
                    days: calendarDaysSince(baseline.baselineAt),
                  })}
            </p>
            {activeMarker?.note && (
              <p className="mt-1 whitespace-pre-line text-muted-foreground">{activeMarker.note}</p>
            )}
          </div>
        </div>
      )}

      {before && (
        <div data-testid="reliability-before-after" className="rounded-md border p-3">
          <div className="text-xs font-medium text-muted-foreground">
            {t('deviceReliabilityPanel.baseline.beforeAfterTitle')}
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
            {beforeAfterRows.map((row) => (
              <div key={row.key} data-testid={`reliability-before-after-${row.key}`}>
                <dt className="text-xs text-muted-foreground">{row.label}</dt>
                <dd className="text-sm font-medium tabular-nums">
                  <span className="text-muted-foreground">{formatNumber(row.before)}</span>
                  <span className="mx-1 text-muted-foreground" aria-hidden="true">→</span>
                  <span>{formatNumber(row.now)}</span>
                </dd>
              </div>
            ))}
          </dl>
          {before.coverageDays < FULL_COVERAGE_DAYS && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('deviceReliabilityPanel.baseline.basedOnDays', { count: before.coverageDays })}
            </p>
          )}
        </div>
      )}

      {markers.length > 0 && (
        <div data-testid="reliability-baseline-history">
          <button
            type="button"
            data-testid="reliability-baseline-history-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
            {t('deviceReliabilityPanel.baseline.history')}
            <span className="tabular-nums">({formatNumber(markers.length)})</span>
          </button>
          {historyOpen && (
            <ul className="mt-2 divide-y divide-border/60">
              {markers.map((marker) => (
                <li
                  key={marker.id}
                  data-testid={`reliability-baseline-history-item-${marker.id}`}
                  className={`py-2 text-sm ${marker.clearedAt ? 'text-muted-foreground' : ''}`}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium">{reasonLabel(t, marker.reason)}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatMarkerDate(marker.baselineAt)} · {markerAuthor(t, marker)}
                    </span>
                    {marker.clearedAt && (
                      <span
                        className="rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        title={formatMarkerDate(marker.clearedAt)}
                      >
                        {t('deviceReliabilityPanel.baseline.cleared')}
                      </span>
                    )}
                  </div>
                  {marker.note && (
                    <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{marker.note}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
