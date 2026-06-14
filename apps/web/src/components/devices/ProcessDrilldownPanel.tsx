import { useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { Dialog } from '../shared/Dialog';

type Row = { name: string; pid: number; cpu: number; ramMb: number; diskBps?: number; netBps?: number };
type SortKey = 'cpu' | 'ramMb';

type Props = {
  deviceId: string;
  at: string; // ISO timestamp of the clicked chart point
  onClose: () => void;
};

export default function ProcessDrilldownPanel({ deviceId, at, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [sampleTime, setSampleTime] = useState<string | null>(null);
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
        } else {
          const res = await fetchWithAuth(`/devices/${deviceId}/process-samples?at=${encodeURIComponent(at)}`);
          if (!res.ok) throw new Error('Failed to fetch process sample');
          const json = await res.json();
          if (cancelled) return;
          if (!json.sample) { setRows([]); setSampleTime(null); return; }
          setRows((json.sample.topProcesses ?? []) as Row[]);
          setSampleTime(json.sample.timestamp);
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
          {live
            ? 'Live (now)'
            : sampleTime
              ? `Nearest sample: ${new Date(sampleTime).toLocaleString()}`
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
