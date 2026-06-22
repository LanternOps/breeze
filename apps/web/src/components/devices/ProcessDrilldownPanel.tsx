import { useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { Dialog } from '../shared/Dialog';

type Row = { name: string; pid: number; cpu: number; ramMb: number; diskBps?: number; netBps?: number };
type SortKey = 'cpu' | 'ramMb';

type Props = {
  deviceId: string;
  at: string; // ISO timestamp of the clicked chart point
  onClose: () => void;
};

// Why a sample-less drilldown is empty:
// - 'none-recorded': the device has never recorded any process sample
//   (e.g. the sampler hasn't run / isn't shipping yet) — issue #1722.
// - 'none-near-time': samples exist, but none at-or-before the clicked time
//   (the click predates the first sample).
type EmptyKind = null | 'none-recorded' | 'none-near-time';

export default function ProcessDrilldownPanel({ deviceId, at, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [sampleTime, setSampleTime] = useState<string | null>(null);
  const [emptyKind, setEmptyKind] = useState<EmptyKind>(null);
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // `cancelled` guards against a slow/older response clobbering newer state
    // (e.g. toggling Live on→off fast) or setting state after unmount.
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(undefined);
      setEmptyKind(null);
      try {
        if (live) {
          // On-demand process listing lives under /system-tools; the agent
          // already returns CPU-desc order by default (sortBy/sortDesc aren't
          // accepted query params here).
          const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/processes?limit=16`);
          if (!res.ok) throw new Error('Failed to fetch live processes');
          const json = await res.json();
          // The on-demand endpoint returns { data: [...processes], meta } — the
          // process array lives directly under `data`.
          const procs = (Array.isArray(json.data)
            ? json.data
            : json.processes ?? json.data?.processes ?? []) as Array<Record<string, unknown>>;
          if (cancelled) return;
          setRows(procs.map((p) => ({
            name: String(p.name ?? ''),
            pid: Number(p.pid ?? 0),
            cpu: Number(p.cpuPercent ?? p.cpu ?? 0),
            ramMb: Number(p.memoryMb ?? p.ramMb ?? 0),
          })));
          setSampleTime(null);
          setEmptyKind(null);
        } else {
          const res = await fetchWithAuth(`/devices/${deviceId}/process-samples?at=${encodeURIComponent(at)}`);
          if (!res.ok) throw new Error('Failed to fetch process sample');
          const json = await res.json();
          if (cancelled) return;
          if (!json.sample) {
            setRows([]);
            setSampleTime(null);
            // The API tells us whether the device has ANY recorded sample so we
            // can disambiguate the empty state (issue #1722).
            setEmptyKind(json.hasAnySample ? 'none-near-time' : 'none-recorded');
            return;
          }
          setRows((json.sample.topProcesses ?? []) as Row[]);
          setSampleTime(json.sample.timestamp);
          setEmptyKind(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load processes');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [deviceId, at, live]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => (sortKey === 'cpu' ? b.cpu - a.cpu : b.ramMb - a.ramMb)),
    [rows, sortKey]
  );

  return (
    <Dialog open onClose={onClose} title="Top processes" maxWidth="lg">
      <div className="p-4" data-testid="process-drilldown-panel">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">Top processes</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
              data-testid="process-drilldown-live-toggle"
            />
            Live
          </label>
        </div>

        <p className="mt-1 text-xs text-muted-foreground" data-testid="process-drilldown-sample-time">
          {/* Suppressed on error so the red error banner below isn't contradicted
              by a stale "no sample" subtitle (the catch sets neither sampleTime
              nor emptyKind). */}
          {error
            ? ''
            : live
              ? 'Live (now)'
              : sampleTime
                ? `Nearest sample: ${formatDateTime(sampleTime)}`
                : emptyKind === 'none-recorded'
                  ? 'No process samples recorded for this device yet'
                  : emptyKind === 'none-near-time'
                    ? 'No process sample recorded at or before this time'
                    : 'No sample near this time'}
        </p>

        <div className="mt-3 flex gap-2 text-sm">
          <button type="button" onClick={() => setSortKey('cpu')} aria-pressed={sortKey === 'cpu'} className={sortKey === 'cpu' ? 'font-semibold' : ''}>CPU</button>
          <button type="button" onClick={() => setSortKey('ramMb')} aria-pressed={sortKey === 'ramMb'} className={sortKey === 'ramMb' ? 'font-semibold' : ''}>RAM</button>
        </div>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        {loading && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}

        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th>Process</th><th>PID</th><th>CPU %</th><th>RAM (MB)</th>
            </tr>
          </thead>
          <tbody>
            {!loading && sorted.length === 0 && !error && (
              <tr data-testid="process-drilldown-empty">
                <td colSpan={4} className="py-4 text-center text-muted-foreground">
                  {live
                    ? 'No processes returned for this device.'
                    : emptyKind === 'none-recorded'
                      ? 'No process samples have been recorded for this device yet. The agent collects them periodically — check back once it has reported.'
                      : 'No process sample was recorded at or before this point. Try clicking a more recent point on the graph.'}
                </td>
              </tr>
            )}
            {sorted.map((r, i) => (
              <tr key={r.pid} data-testid={`process-drilldown-row-${i}`}>
                <td>{r.name}</td>
                <td>{r.pid}</td>
                <td>{r.cpu.toFixed(1)}</td>
                <td>{Math.round(r.ramMb)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
