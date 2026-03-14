import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type PeripheralEvent = {
  id: string;
  eventType: string;
  peripheralType: string;
  vendor?: string;
  product?: string;
  serialNumber?: string;
  deviceId: string;
  policyId?: string;
  occurredAt: string;
  details?: Record<string, unknown>;
};

const eventTypeBadge: Record<string, string> = {
  connected: 'bg-green-500/20 text-green-700 border-green-500/40',
  disconnected: 'bg-gray-500/20 text-gray-700 border-gray-500/40',
  blocked: 'bg-red-500/20 text-red-700 border-red-500/40',
  mounted_read_only: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  policy_override: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
};

type PeripheralActivityLogProps = {
  deviceId?: string;
  limit?: number;
};

function formatDateTime(value?: string) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export default function PeripheralActivityLog({ deviceId, limit: propLimit }: PeripheralActivityLogProps) {
  const [events, setEvents] = useState<PeripheralEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const limit = propLimit ?? 50;

  // Filters
  const [filterEventType, setFilterEventType] = useState('');
  const [filterPeripheralType, setFilterPeripheralType] = useState('');
  const [filterVendor, setFilterVendor] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      if (deviceId) params.set('deviceId', deviceId);
      if (filterEventType) params.set('eventType', filterEventType);
      if (filterPeripheralType) params.set('peripheralType', filterPeripheralType);
      if (filterVendor) params.set('vendor', filterVendor);
      if (filterFrom) params.set('start', new Date(filterFrom).toISOString());
      if (filterTo) params.set('end', new Date(filterTo + 'T23:59:59').toISOString());
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      const response = await fetchWithAuth(`/peripherals/activity?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch activity');
      const json = await response.json();
      const data = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
      setEvents(data);
      setTotal(json.pagination?.total ?? json.total ?? data.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [deviceId, filterEventType, filterPeripheralType, filterVendor, filterFrom, filterTo, limit, offset]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handlePrev = () => setOffset(Math.max(0, offset - limit));
  const handleNext = () => setOffset(offset + limit);
  const hasNext = offset + limit < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterEventType}
          onChange={(e) => { setFilterEventType(e.target.value); setOffset(0); }}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All Events</option>
          <option value="connected">Connected</option>
          <option value="disconnected">Disconnected</option>
          <option value="blocked">Blocked</option>
          <option value="mounted_read_only">Read Only</option>
          <option value="policy_override">Policy Override</option>
        </select>
        <input
          value={filterPeripheralType}
          onChange={(e) => { setFilterPeripheralType(e.target.value); setOffset(0); }}
          placeholder="Peripheral type"
          className="h-9 w-32 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          value={filterVendor}
          onChange={(e) => { setFilterVendor(e.target.value); setOffset(0); }}
          placeholder="Vendor"
          className="h-9 w-32 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="date"
          value={filterFrom}
          onChange={(e) => { setFilterFrom(e.target.value); setOffset(0); }}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="date"
          value={filterTo}
          onChange={(e) => { setFilterTo(e.target.value); setOffset(0); }}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => fetchEvents()}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted ml-auto"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : events.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No peripheral activity found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Occurred At</th>
                  <th className="px-4 py-3">Event Type</th>
                  <th className="px-4 py-3">Peripheral Type</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Serial Number</th>
                  {!deviceId && <th className="px-4 py-3">Device</th>}
                  <th className="px-4 py-3">Policy</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {events.map((event) => (
                  <tr key={event.id} className="text-sm">
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(event.occurredAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${eventTypeBadge[event.eventType] ?? 'bg-muted text-muted-foreground'}`}>
                        {event.eventType.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{event.peripheralType}</td>
                    <td className="px-4 py-3 text-muted-foreground">{event.vendor ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{event.product ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{event.serialNumber ?? '—'}</td>
                    {!deviceId && (
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {event.deviceId.slice(0, 8)}...
                      </td>
                    )}
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {event.policyId ? `${event.policyId.slice(0, 8)}...` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handlePrev}
              disabled={!hasPrev}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              <ChevronLeft className="h-3 w-3" /> Prev
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={!hasNext}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              Next <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
