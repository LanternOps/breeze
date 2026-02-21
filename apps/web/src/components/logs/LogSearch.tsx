import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Save, Search } from 'lucide-react';

import { fetchWithAuth } from '../../stores/auth';

type EventLogRow = {
  log: {
    id: string;
    timestamp: string;
    level: 'info' | 'warning' | 'error' | 'critical';
    category: 'security' | 'hardware' | 'application' | 'system';
    source: string;
    eventId: string | null;
    message: string;
    deviceId: string;
  };
  device: {
    id: string;
    hostname: string;
    displayName: string | null;
    siteId: string;
  } | null;
  site: {
    id: string;
    name: string;
  } | null;
};

type SearchResponse = {
  results: EventLogRow[];
  total: number | null;
  totalMode?: 'exact' | 'estimated' | 'none';
  limit: number;
  offset: number;
  hasMore?: boolean;
  nextCursor?: string | null;
};

const LEVELS: Array<{ value: EventLogRow['log']['level']; label: string }> = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'critical', label: 'Critical' },
];

function toDatetimeLocalInput(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function escapeCsv(value: string): string {
  const escaped = value.replaceAll('"', '""');
  return `"${escaped}"`;
}

export default function LogSearch() {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [selectedLevels, setSelectedLevels] = useState<Array<EventLogRow['log']['level']>>([]);
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);

  const [startTime, setStartTime] = useState(() => toDatetimeLocalInput(new Date(Date.now() - (24 * 60 * 60 * 1000))));
  const [endTime, setEndTime] = useState(() => toDatetimeLocalInput(new Date()));

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<EventLogRow[]>([]);
  const [total, setTotal] = useState(0);

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const canSearch = useMemo(() => {
    const start = new Date(startTime);
    const end = new Date(endTime);
    return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start <= end;
  }, [startTime, endTime]);

  const fetchLogs = useCallback(async (nextOffset = 0) => {
    if (!canSearch) {
      setError('Start time must be before end time.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = {
        query: query.trim() || undefined,
        source: source.trim() || undefined,
        level: selectedLevels.length > 0 ? selectedLevels : undefined,
        timeRange: {
          start: new Date(startTime).toISOString(),
          end: new Date(endTime).toISOString(),
        },
        limit,
        offset: nextOffset,
        countMode: 'estimated' as const,
        sortBy: 'timestamp' as const,
        sortOrder: 'desc' as const,
      };

      const response = await fetchWithAuth('/logs/search', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Failed to search logs');
      }

      const data: SearchResponse = await response.json();
      setResults(Array.isArray(data.results) ? data.results : []);
      setTotal(Number(data.total ?? 0));
      setOffset(nextOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search logs');
    } finally {
      setLoading(false);
    }
  }, [canSearch, query, source, selectedLevels, startTime, endTime, limit]);

  useEffect(() => {
    fetchLogs(0);
  }, [fetchLogs]);

  const toggleLevel = (level: EventLogRow['log']['level']) => {
    setSelectedLevels((prev) => prev.includes(level)
      ? prev.filter((value) => value !== level)
      : [...prev, level]);
  };

  const saveQuery = async () => {
    const name = window.prompt('Name this saved query:');
    if (!name || !name.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetchWithAuth('/logs/queries', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          isShared: false,
          filters: {
            query: query.trim() || undefined,
            source: source.trim() || undefined,
            level: selectedLevels.length > 0 ? selectedLevels : undefined,
            timeRange: {
              start: new Date(startTime).toISOString(),
              end: new Date(endTime).toISOString(),
            },
            limit,
            sortBy: 'timestamp',
            sortOrder: 'desc',
          },
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Failed to save query');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save query');
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () => {
    if (results.length === 0) {
      setError('No rows to export.');
      return;
    }

    const header = [
      'Timestamp',
      'Level',
      'Category',
      'Source',
      'Event ID',
      'Message',
      'Device',
      'Site',
    ];

    const rows = results.map((row) => [
      row.log.timestamp,
      row.log.level,
      row.log.category,
      row.log.source,
      row.log.eventId ?? '',
      row.log.message,
      row.device?.hostname ?? row.log.deviceId,
      row.site?.name ?? '',
    ]);

    const csv = [header, ...rows]
      .map((line) => line.map((value) => escapeCsv(String(value))).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fleet-logs-${new Date().toISOString().slice(0, 19)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Search</label>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="error code, source, stack trace..."
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Source</label>
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="e.g. kernel"
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Start</label>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">End</label>
            <input
              type="datetime-local"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Rows</label>
            <select
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              className="w-full rounded-md border px-3 py-2 text-sm"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
            </select>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {LEVELS.map((item) => (
            <label key={item.value} className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={selectedLevels.includes(item.value)}
                onChange={() => toggleLevel(item.value)}
              />
              {item.label}
            </label>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => fetchLogs(0)}
            disabled={loading || !canSearch}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Search className="h-4 w-4" />
            Search Fleet Logs
          </button>

          <button
            onClick={saveQuery}
            disabled={saving || loading || !canSearch}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            Save Query
          </button>

          <button
            onClick={exportCsv}
            disabled={results.length === 0}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="rounded-lg border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Search Results</h2>
          <span className="text-xs text-muted-foreground">
            {loading ? 'Loading...' : `${results.length} shown of ${total} total`}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Timestamp</th>
                <th className="px-3 py-2">Level</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Message</th>
                <th className="px-3 py-2">Device</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row) => (
                <tr key={row.log.id} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {new Date(row.log.timestamp).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded px-2 py-0.5 text-xs font-medium capitalize bg-muted">
                      {row.log.level}
                    </span>
                  </td>
                  <td className="px-3 py-2 capitalize">{row.log.category}</td>
                  <td className="px-3 py-2">{row.log.source}</td>
                  <td className="max-w-[640px] px-3 py-2 text-xs leading-relaxed">{row.log.message}</td>
                  <td className="px-3 py-2 text-xs">
                    <div className="font-medium">{row.device?.hostname ?? row.log.deviceId}</div>
                    <div className="text-muted-foreground">{row.site?.name ?? 'Unknown site'}</div>
                  </td>
                </tr>
              ))}

              {results.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    No logs matched the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <span className="text-muted-foreground">Page {currentPage} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => fetchLogs(Math.max(0, offset - limit))}
              disabled={loading || offset === 0}
              className="rounded-md border px-3 py-1.5 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => fetchLogs(offset + limit)}
              disabled={loading || (offset + limit) >= total}
              className="rounded-md border px-3 py-1.5 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
