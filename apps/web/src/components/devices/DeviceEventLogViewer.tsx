import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileText, Info, XCircle } from 'lucide-react';

type EventLogEntry = {
  id?: string;
  level?: string;
  message?: string;
  source?: string;
  timestamp?: string;
  createdAt?: string;
};

type DeviceEventLogViewerProps = {
  deviceId: string;
};

const levelConfig: Record<string, { label: string; icon: typeof Info; badge: string }> = {
  error: {
    label: 'Error',
    icon: XCircle,
    badge: 'bg-red-500/20 text-red-700 border-red-500/40'
  },
  warning: {
    label: 'Warning',
    icon: AlertTriangle,
    badge: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
  },
  info: {
    label: 'Info',
    icon: Info,
    badge: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
  }
};

function formatDateTime(value?: string) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function DeviceEventLogViewer({ deviceId }: DeviceEventLogViewerProps) {
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [levelFilters, setLevelFilters] = useState({
    error: true,
    warning: true,
    info: true
  });

  const selectedLevels = useMemo(() => {
    return Object.entries(levelFilters)
      .filter(([, enabled]) => enabled)
      .map(([level]) => level);
  }, [levelFilters]);

  const fetchEvents = useCallback(async () => {
    if (selectedLevels.length === 0) {
      setEvents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      params.set('levels', selectedLevels.join(','));
      const response = await fetch(`/api/devices/${deviceId}/events?${params}`);
      if (!response.ok) throw new Error('Failed to fetch event logs');
      const json = await response.json();
      const payload = json?.data ?? json;
      setEvents(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch event logs');
    } finally {
      setLoading(false);
    }
  }, [deviceId, selectedLevels]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const toggleLevel = (level: keyof typeof levelFilters) => {
    setLevelFilters(prev => ({ ...prev, [level]: !prev[level] }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading event logs...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchEvents}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Event Log Viewer</h3>
        </div>
        <div className="flex items-center gap-2">
          {(Object.keys(levelConfig) as Array<keyof typeof levelConfig>).map(level => {
            const config = levelConfig[level];
            return (
              <button
                key={level}
                type="button"
                onClick={() => toggleLevel(level)}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  levelFilters[level]
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-muted text-muted-foreground hover:border-muted-foreground hover:text-foreground'
                }`}
              >
                {config.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events match the selected levels.</p>
        ) : (
          events.map((event, index) => {
            const level = (event.level || 'info').toLowerCase();
            const config = levelConfig[level] ?? levelConfig.info;
            const Icon = config.icon;
            return (
              <div key={event.id ?? `${event.message ?? 'event'}-${index}`} className="rounded-md border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <Icon className="mt-1 h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{event.message || 'Event logged'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {event.source ? `${event.source} • ` : ''}
                        {formatDateTime(event.timestamp || event.createdAt)}
                      </p>
                    </div>
                  </div>
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${config.badge}`}>
                    {level}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
