import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, TrendingUp } from 'lucide-react';
import type { MetricAnomalyEpisodeDto, MetricAnomalyEpisodeListResponse } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import { useOrgStore } from '../../stores/orgStore';
import { Trans, useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/dateTimeFormat';
import AnomalyEpisodeCard from './AnomalyEpisodeCard';
import { formatMetricValue } from './anomalyEpisodeSentence';
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

type DeviceAnomaliesPanelProps = {
  deviceId: string;
  compact?: boolean;
  focusedAnomalyId?: string;
};

type Filter = 'open' | 'closed' | 'all';

/** A9: refresh cadence while an open episode is on screen and the tab is visible. */
const EPISODE_POLL_MS = 60_000;

/** The fields the A9 fallback reads from the legacy per-row serializer (routes/devices/anomalies.ts). */
type LegacyAnomalyRow = {
  id: string;
  metricName: string;
  anomalyType: string;
  windowStart: string;
  observedValue: number;
  baselineValue: number | null;
};

export default function DeviceAnomaliesPanel({
  deviceId, compact = false, focusedAnomalyId,
}: DeviceAnomaliesPanelProps) {
  const { t } = useTranslation('devices');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const mlFlags = useMlFeatureFlags();
  const currentOrgId = useOrgStore((state) => state.currentOrgId);
  const [filter, setFilter] = useState<Filter>('open');
  const [episodes, setEpisodes] = useState<MetricAnomalyEpisodeDto[]>([]);
  // W02 resolves `ref` (episode id OR member anomaly id) to the episode to ring.
  const [focusedEpisodeId, setFocusedEpisodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [hasClosed, setHasClosed] = useState(false);
  // A9: a `ref` W02 could not resolve to an episode (a detection that predates
  // episode grouping) is shown read-only from the legacy per-row list.
  const [legacyRow, setLegacyRow] = useState<LegacyAnomalyRow | null>(null);
  const anomaliesDisabled = mlFlags.isDisabled('ml.anomalies.enabled');

  const effectiveFilter: Filter = focusedAnomalyId ? 'all' : filter;
  const limit = focusedAnomalyId ? 100 : compact ? 3 : 25;

  const loadLegacyRow = useCallback(async (anomalyId: string) => {
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/anomalies?status=all&limit=100`);
      if (!response.ok) {
        console.warn('[DeviceAnomaliesPanel] legacy anomaly lookup failed', response.status);
        setLegacyRow(null);
        return;
      }
      const json = (await response.json()) as { data?: LegacyAnomalyRow[] };
      setLegacyRow(Array.isArray(json?.data) ? json.data.find((row) => row.id === anomalyId) ?? null : null);
    } catch (err) {
      console.warn('[DeviceAnomaliesPanel] legacy anomaly lookup failed', err);
      setLegacyRow(null); // best-effort; the episode list still renders
    }
  }, [deviceId]);

  // `silent` (the A9 poll) keeps the current list on screen: no spinner, and a
  // failed refresh keeps the last good list instead of replacing it with an error.
  const fetchEpisodes = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setLoading(true);
      setError(undefined);
    }
    try {
      const params = new URLSearchParams({ status: effectiveFilter, limit: String(limit) });
      if (focusedAnomalyId) params.set('ref', focusedAnomalyId);
      const response = await fetchWithAuth(`/devices/${deviceId}/anomaly-episodes?${params.toString()}`);
      if (!response.ok) throw new Error(stableT('deviceAnomaliesPanel.failedToLoadMetricAnomalies'));
      const json = (await response.json()) as Partial<MetricAnomalyEpisodeListResponse>;
      const resolved = typeof json?.focusedEpisodeId === 'string' ? json.focusedEpisodeId : null;
      setEpisodes(Array.isArray(json?.data) ? json.data : []);
      setFocusedEpisodeId(resolved);
      if (focusedAnomalyId && resolved === null) {
        await loadLegacyRow(focusedAnomalyId);
      } else {
        setLegacyRow(null);
      }
    } catch (err) {
      console.warn('[DeviceAnomaliesPanel] episode list fetch failed', { silent: !!options.silent }, err);
      if (!options.silent) {
        setError(err instanceof Error ? err.message : stableT('deviceAnomaliesPanel.failedToLoadMetricAnomalies'));
      }
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, [deviceId, effectiveFilter, limit, focusedAnomalyId, loadLegacyRow, stableT]);

  const checkHasClosed = useCallback(async () => {
    try {
      // Same predicate the "Recently closed" pill uses (W02 status=closed:
      // resolved/dismissed within the last 7 days), so the link never leads to
      // an empty list.
      const response = await fetchWithAuth(`/devices/${deviceId}/anomaly-episodes?status=closed&limit=1`);
      if (!response.ok) {
        console.warn('[DeviceAnomaliesPanel] recently-closed check failed', response.status);
        return;
      }
      const json = (await response.json()) as Partial<MetricAnomalyEpisodeListResponse>;
      setHasClosed(Array.isArray(json?.data) && json.data.length > 0);
    } catch (err) {
      // Best-effort; the "show recently closed" link simply stays hidden.
      console.warn('[DeviceAnomaliesPanel] recently-closed check failed', err);
    }
  }, [deviceId]);

  useEffect(() => {
    if (!mlFlags.loaded) return;
    if (anomaliesDisabled) {
      setEpisodes([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    void fetchEpisodes();
  }, [anomaliesDisabled, fetchEpisodes, mlFlags.loaded]);

  useEffect(() => {
    if (!mlFlags.loaded || anomaliesDisabled || compact || effectiveFilter !== 'open' || episodes.length > 0) return;
    void checkHasClosed();
  }, [anomaliesDisabled, checkHasClosed, compact, effectiveFilter, episodes.length, mlFlags.loaded]);

  const visible = useMemo(
    () => (compact ? episodes.filter((e) => e.ongoing).slice(0, 3) : episodes),
    [compact, episodes],
  );

  // A9: an ongoing episode changes under the tech's eyes (it extends, clears,
  // or gets closed by a colleague). Refresh every 60 s while one is shown and
  // the tab is visible; a hidden tab skips the tick, and unmount clears it.
  const showsOpenEpisode = visible.some((e) => e.ongoing);
  useEffect(() => {
    if (!showsOpenEpisode) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchEpisodes({ silent: true });
    }, EPISODE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [showsOpenEpisode, fetchEpisodes]);

  function handleChanged(updated: MetricAnomalyEpisodeDto) {
    setEpisodes((current) => {
      const next = current.map((e) => (e.id === updated.id ? updated : e));
      // A resolve/dismiss/unsnooze can move the episode out of the current
      // filter's membership (e.g. Open no longer includes a just-resolved
      // row); drop it from the visible list in that case.
      if (effectiveFilter === 'open' && !updated.ongoing) return next.filter((e) => e.id !== updated.id);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-center py-8">
          <div className="h-7 w-7 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-destructive">{error}</p>
          <button type="button" onClick={() => void fetchEpisodes()}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
            <RefreshCw className="h-4 w-4" />
            {t('deviceAnomaliesPanel.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (anomaliesDisabled) {
    return (
      <div className={`rounded-lg border bg-card shadow-xs ${compact ? 'p-4' : 'p-6'}`}>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">{t('deviceAnomaliesPanel.metricAnomalies')}</h3>
        </div>
        <div className="mt-5 rounded-md border border-dashed p-6 text-center">
          <p className="text-sm font-medium">{t('deviceAnomaliesPanel.anomalyDetectionDisabled')}</p>
          {currentOrgId && (
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans
                i18nKey="deviceAnomaliesPanel.anomalyDetectionDisabledHint"
                t={t}
                components={{
                  orgLink: (
                    <a
                      href={`/settings/organizations/${currentOrgId}#ai`}
                      className="underline hover:text-foreground"
                    />
                  ),
                }}
              />
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border bg-card shadow-xs ${compact ? 'p-4' : 'p-6'}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">{t('deviceAnomaliesPanel.metricAnomalies')}</h3>
        </div>
        {!compact && (
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border p-0.5 text-sm">
              {(['open', 'closed', 'all'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`rounded px-2 py-1 ${filter === f && !focusedAnomalyId ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
                >
                  {f === 'open' ? t('deviceAnomaliesPanel.filterOpen') : f === 'closed' ? t('deviceAnomaliesPanel.filterRecentlyClosed') : t('deviceAnomaliesPanel.filterAll')}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => void fetchEpisodes()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('deviceAnomaliesPanel.refreshAnomalies')} aria-label={t('deviceAnomaliesPanel.refreshAnomalies')}>
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {legacyRow && (
        // A9: read-only — the web UI offers no per-row actions (spec §8.4).
        <div data-testid="anomaly-legacy-detection" className="mt-5 rounded-md border border-primary/60 bg-primary/5 p-4 ring-2 ring-primary/20">
          <p className="text-sm font-medium">
            {legacyRow.anomalyType.replace(/_/g, ' ')} · <span className="font-mono text-xs">{legacyRow.metricName}</span>
            {' · '}
            {formatDateTime(new Date(legacyRow.windowStart), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </p>
          <p className="mt-1 text-sm tabular-nums">
            {formatMetricValue(legacyRow.metricName, legacyRow.observedValue)}
            {legacyRow.baselineValue != null && ` · ${t('deviceAnomaliesPanel.baseline')} ${formatMetricValue(legacyRow.metricName, legacyRow.baselineValue)}`}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{t('deviceAnomaliesPanel.legacyDetectionNote')}</p>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="mt-5 rounded-md border border-dashed p-6 text-center">
          <p className="text-sm font-medium">{t('deviceAnomaliesPanel.noOpenAnomalies')}</p>
          {!compact && <p className="text-sm text-muted-foreground">{t('deviceAnomaliesPanel.recentMetricRollupsAreWithinBaseline')}</p>}
          {!compact && effectiveFilter === 'open' && hasClosed && (
            <button type="button" onClick={() => setFilter('closed')} className="mt-3 text-sm font-medium text-primary hover:underline">
              {t('deviceAnomaliesPanel.showRecentlyClosed')}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {visible.map((ep) => (
            <AnomalyEpisodeCard
              key={ep.id}
              deviceId={deviceId}
              episode={ep}
              compact={compact}
              focused={focusedEpisodeId !== null && ep.id === focusedEpisodeId}
              onChanged={handleChanged}
              onStale={() => void fetchEpisodes()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
