import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import CisComplianceRow from './CisComplianceRow';
import type { ComplianceEntry } from './types';

interface CisComplianceTabProps {
  refreshKey: number;
}

export default function CisComplianceTab({ refreshKey }: CisComplianceTabProps) {
  const [entries, setEntries] = useState<ComplianceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [osFilter, setOsFilter] = useState('all');
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const params = new URLSearchParams({ limit: '200' });
      if (osFilter !== 'all') params.set('osType', osFilter);

      const response = await fetchWithAuth(`/cis/compliance?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const payload = await response.json();
      const data: ComplianceEntry[] = Array.isArray(payload.data) ? payload.data : [];
      data.sort((a, b) => a.result.score - b.result.score);
      setEntries(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [osFilter]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData, refreshKey]);

  const filtered = search.trim()
    ? entries.filter(
        (e) =>
          e.device.hostname.toLowerCase().includes(search.toLowerCase()) ||
          e.baseline.name.toLowerCase().includes(search.toLowerCase())
      )
    : entries;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search hostname or baseline..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={osFilter}
          onChange={(e) => setOsFilter(e.target.value)}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All OS types</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="linux">Linux</option>
        </select>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-4 py-3" />
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Baseline</th>
              <th className="px-4 py-3">OS</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Failed Checks</th>
              <th className="px-4 py-3">Last Scanned</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading compliance data...
                  </span>
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No compliance results found.
                </td>
              </tr>
            ) : (
              filtered.map((entry) => (
                <CisComplianceRow key={entry.result.id} entry={entry} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
