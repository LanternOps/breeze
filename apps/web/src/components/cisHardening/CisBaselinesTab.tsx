import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pencil, Play, Plus } from 'lucide-react';
import { cn, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import CisBaselineForm from './CisBaselineForm';
import type { Baseline } from './types';

const levelBadge: Record<string, string> = {
  l1: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  l2: 'bg-purple-500/20 text-purple-700 border-purple-500/30',
  custom: 'bg-gray-500/20 text-gray-700 border-gray-500/30',
};

interface CisBaselinesTabProps {
  refreshKey: number;
  onMutate: () => void;
}

export default function CisBaselinesTab({ refreshKey, onMutate }: CisBaselinesTabProps) {
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editBaseline, setEditBaseline] = useState<Baseline | null | undefined>(undefined);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchBaselines = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetchWithAuth('/cis/baselines?limit=200', {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const payload = await response.json();
      setBaselines(Array.isArray(payload.data) ? payload.data : []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBaselines();
    return () => abortRef.current?.abort();
  }, [fetchBaselines, refreshKey]);

  const handleTriggerScan = async (baselineId: string) => {
    setScanningId(baselineId);
    try {
      const res = await fetchWithAuth('/cis/scan', {
        method: 'POST',
        body: JSON.stringify({ baselineId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger scan');
    } finally {
      setScanningId(null);
    }
  };

  const handleSaved = () => {
    setEditBaseline(undefined);
    fetchBaselines();
    onMutate();
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {editBaseline !== undefined && (
        <CisBaselineForm
          baseline={editBaseline}
          onClose={() => setEditBaseline(undefined)}
          onSaved={handleSaved}
        />
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Baselines</h3>
        <button
          type="button"
          onClick={() => setEditBaseline(null)}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Baseline
        </button>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">OS</th>
              <th className="px-4 py-3">Level</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading baselines...
                  </span>
                </td>
              </tr>
            ) : baselines.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No baselines configured.
                </td>
              </tr>
            ) : (
              baselines.map((bl) => (
                <tr key={bl.id} className="text-sm">
                  <td className="px-4 py-3 font-medium">{bl.name}</td>
                  <td className="px-4 py-3 uppercase text-muted-foreground">{bl.osType}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold uppercase',
                        levelBadge[bl.level] ?? levelBadge.custom
                      )}
                    >
                      {bl.level}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{bl.benchmarkVersion}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {bl.scanSchedule?.enabled
                      ? `Every ${bl.scanSchedule.intervalHours}h`
                      : 'Manual'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold',
                        bl.isActive
                          ? 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30'
                          : 'bg-gray-500/20 text-gray-700 border-gray-500/30'
                      )}
                    >
                      {bl.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditBaseline(bl)}
                        className="rounded-md p-1.5 hover:bg-muted"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4 text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTriggerScan(bl.id)}
                        disabled={scanningId === bl.id || !bl.isActive}
                        className="rounded-md p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        title="Trigger Scan"
                      >
                        {scanningId === bl.id ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : (
                          <Play className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
