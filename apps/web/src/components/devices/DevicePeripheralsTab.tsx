import { useState, useEffect, useCallback } from 'react';
import { Usb, ShieldAlert, Activity, Shield } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type PeripheralEvent = {
  id: string;
  eventType: string;
  peripheralType: string;
  vendor?: string;
  product?: string;
  serialNumber?: string;
  policyId?: string;
  occurredAt: string;
};

type PeripheralPolicy = {
  id: string;
  name: string;
  deviceClass: string;
  action: string;
  targetType: string;
  isActive: boolean;
};

type DevicePeripheralsTabProps = {
  deviceId: string;
  timezone?: string;
};

const eventTypeBadge: Record<string, string> = {
  connected: 'bg-success/15 text-success border-success/30',
  disconnected: 'bg-muted text-muted-foreground border-border',
  blocked: 'bg-destructive/15 text-destructive border-destructive/30',
  mounted_read_only: 'bg-warning/15 text-warning border-warning/30',
  policy_override: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
};

const actionBadge: Record<string, string> = {
  allow: 'bg-success/15 text-success border-success/30',
  block: 'bg-destructive/15 text-destructive border-destructive/30',
  read_only: 'bg-warning/15 text-warning border-warning/30',
  alert: 'bg-warning/15 text-warning border-warning/30',
};

function formatDateTime(value?: string, timezone?: string) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

export default function DevicePeripheralsTab({ deviceId, timezone }: DevicePeripheralsTabProps) {
  const [events, setEvents] = useState<PeripheralEvent[]>([]);
  const [policies, setPolicies] = useState<PeripheralPolicy[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [loadingPolicies, setLoadingPolicies] = useState(true);
  const [error, setError] = useState<string>();

  // Summary counters
  const [totalEvents24h, setTotalEvents24h] = useState(0);
  const [blockedEvents24h, setBlockedEvents24h] = useState(0);
  const [connectedCount, setConnectedCount] = useState(0);

  const fetchEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const response = await fetchWithAuth(`/peripherals/activity?deviceId=${deviceId}&limit=50`);
      if (!response.ok) throw new Error('Failed to fetch events');
      const json = await response.json();
      const data = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
      setEvents(data);

      // Compute 24h summaries
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const recent = data.filter((e: PeripheralEvent) => new Date(e.occurredAt).getTime() > oneDayAgo);
      setTotalEvents24h(recent.length);
      setBlockedEvents24h(recent.filter((e: PeripheralEvent) => e.eventType === 'blocked').length);
      setConnectedCount(recent.filter((e: PeripheralEvent) => e.eventType === 'connected').length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoadingEvents(false);
    }
  }, [deviceId]);

  const fetchPolicies = useCallback(async () => {
    setLoadingPolicies(true);
    try {
      const response = await fetchWithAuth('/peripherals/policies');
      if (!response.ok) throw new Error('Failed to fetch policies');
      const json = await response.json();
      const data = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
      setPolicies(data.filter((p: PeripheralPolicy) => p.isActive));
    } catch (err) {
      console.error('[DevicePeripheralsTab] Failed to fetch policies:', err);
    } finally {
      setLoadingPolicies(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    fetchPolicies();
  }, [fetchEvents, fetchPolicies]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity className="h-4 w-4" />
            Events (24h)
          </div>
          <p className="mt-2 text-2xl font-bold">{loadingEvents ? '—' : totalEvents24h}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldAlert className="h-4 w-4" />
            Blocked (24h)
          </div>
          <p className="mt-2 text-2xl font-bold">{loadingEvents ? '—' : blockedEvents24h}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Usb className="h-4 w-4" />
            Connected (24h)
          </div>
          <p className="mt-2 text-2xl font-bold">{loadingEvents ? '—' : connectedCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Shield className="h-4 w-4" />
            Active Policies
          </div>
          <p className="mt-2 text-2xl font-bold">{loadingPolicies ? '—' : policies.length}</p>
        </div>
      </div>

      {/* Recent events */}
      <div className="rounded-lg border bg-card shadow-sm">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Recent Events</h3>
        </div>
        {loadingEvents ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : events.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No peripheral events recorded for this device.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Occurred At</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Serial</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {events.map((event) => (
                  <tr key={event.id} className="text-sm">
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(event.occurredAt, timezone)}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Applied policies */}
      <div className="rounded-lg border bg-card shadow-sm">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Active Policies</h3>
        </div>
        {loadingPolicies ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : policies.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No active peripheral policies.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Device Class</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {policies.map((p) => (
                  <tr key={p.id} className="text-sm">
                    <td className="px-4 py-3 font-medium">{p.name}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium capitalize">
                        {p.deviceClass.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${actionBadge[p.action] ?? 'bg-muted text-muted-foreground'}`}>
                        {p.action.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{p.targetType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
