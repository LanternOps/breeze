// History for one OID (spec §6.3). One hook instance per chart, so a failing
// series fails its own chart rather than the tab.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { useStableT } from '@/lib/i18n/useStableT';

export type MetricRange = '24h' | '7d' | '30d';
export type MetricBucket = '5m' | '1h' | '1d';

/** Mirrors DevicePerformanceGraphs' rangeIntervals so the two pages bucket alike. */
export const RANGE_BUCKET: Record<MetricRange, MetricBucket> = { '24h': '5m', '7d': '1h', '30d': '1d' };
export const RANGE_MS: Record<MetricRange, number> = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};
export const MAX_SELECTED_OIDS = 4;

export type MetricSeries = {
  oid: string;
  instance: string;
  name: string;
  points: Array<[string, number]>;
};

export type UseAssetMetricsArgs = {
  assetId: string;
  oid: string | null;
  range: MetricRange;
  delta?: boolean;
  windowMs?: number;
  bucket?: MetricBucket;
};

export function useAssetMetrics({
  assetId,
  oid,
  range,
  delta,
  windowMs,
  bucket,
}: UseAssetMetricsArgs) {
  const { t } = useTranslation('devices');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [truncatedSeries, setTruncatedSeries] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Same stale-response guard as useNetworkAsset.fetchDevices: switching
  // 24h → 7d → 24h is one click each, and an older response landing last paints
  // the wrong window with no visible sign that it is wrong.
  const seqRef = useRef(0);

  useEffect(() => {
    setTruncatedSeries(false);
    if (!oid) {
      setSeries([]);
      setError(null);
      setLoading(false);
      return;
    }

    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setSeries([]);

    const to = new Date();
    const from = new Date(to.getTime() - (windowMs ?? RANGE_MS[range]));
    const params = new URLSearchParams({
      oid,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: bucket ?? RANGE_BUCKET[range],
    });
    if (delta) params.set('delta', '1');

    void (async () => {
      try {
        const response = await fetchWithAuth(`/monitoring/assets/${assetId}/metrics?${params.toString()}`);
        const body = (await response.json().catch(() => null)) as { series?: MetricSeries[]; truncatedSeries?: boolean; error?: string } | null;
        if (seq !== seqRef.current) return;
        if (!response.ok) {
          // The 400 carries the cap in its message (§14) — showing it is the
          // whole point; a silent empty chart reads as "no data".
          setError(typeof body?.error === 'string' ? body.error : stableT('networkDeviceDetailPage.charts.loadFailed'));
          setSeries([]);
          return;
        }
        setSeries(Array.isArray(body?.series) ? body.series : []);
        setTruncatedSeries(body?.truncatedSeries === true);
      } catch {
        if (seq !== seqRef.current) return;
        setError(stableT('networkDeviceDetailPage.charts.loadFailed'));
        setSeries([]);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    })();

    // Invalidate pending responses on suspension, request changes and unmount.
    return () => { ++seqRef.current; };
  }, [assetId, oid, range, delta, windowMs, bucket, nonce, stableT]);

  return { series, truncatedSeries, loading, error, reload: () => setNonce((n) => n + 1) };
}
