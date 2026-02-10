import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Monitor, RefreshCcw, Search } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';

type LauncherMode = 'terminal' | 'files';

type RemoteDeviceLauncherPageProps = {
  mode: LauncherMode;
};

type Device = {
  id: string;
  hostname: string;
  displayName?: string;
  osType?: string;
  status?: string;
  lastSeenAt?: string;
};

type ModeConfig = {
  title: string;
  description: string;
  actionLabel: string;
  pathPrefix: string;
};

const MODE_CONFIG: Record<LauncherMode, ModeConfig> = {
  terminal: {
    title: 'Start Terminal Session',
    description: 'Choose an online device to open a remote terminal.',
    actionLabel: 'Open Terminal',
    pathPrefix: '/remote/terminal'
  },
  files: {
    title: 'Start File Transfer',
    description: 'Choose an online device to open the remote file manager.',
    actionLabel: 'Open Files',
    pathPrefix: '/remote/files'
  }
};

function toDevice(value: unknown): Device | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) return null;

  const hostname = typeof record.hostname === 'string'
    ? record.hostname
    : typeof record.displayName === 'string'
      ? record.displayName
      : 'Unknown';

  return {
    id,
    hostname,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    osType: typeof record.osType === 'string'
      ? record.osType
      : typeof record.os === 'string'
        ? record.os
        : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
    lastSeenAt: typeof record.lastSeenAt === 'string'
      ? record.lastSeenAt
      : typeof record.lastSeen === 'string'
        ? record.lastSeen
        : undefined
  };
}

function formatOs(osType?: string): string {
  if (!osType) return '-';
  if (osType === 'darwin' || osType === 'macos') return 'macOS';
  return osType.charAt(0).toUpperCase() + osType.slice(1);
}

function formatLastSeen(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

export default function RemoteDeviceLauncherPage({ mode }: RemoteDeviceLauncherPageProps) {
  const config = MODE_CONFIG[mode];
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const loadDevices = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetchWithAuth('/devices?status=online&limit=200');
      if (!response.ok) {
        throw new Error('Failed to load devices');
      }

      const payload = await response.json();
      const list: unknown[] = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.devices)
          ? payload.devices
          : Array.isArray(payload)
            ? payload
            : [];

      const normalized = list
        .map(toDevice)
        .filter((device): device is Device => device !== null)
        .sort((a, b) => {
          const left = (a.displayName || a.hostname).toLowerCase();
          const right = (b.displayName || b.hostname).toLowerCase();
          return left.localeCompare(right);
        });

      setDevices(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const filteredDevices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return devices;
    return devices.filter(device => {
      const name = (device.displayName || device.hostname).toLowerCase();
      const hostname = device.hostname.toLowerCase();
      return name.includes(normalizedQuery) || hostname.includes(normalizedQuery);
    });
  }, [devices, query]);

  const handleLaunch = (deviceId: string) => {
    window.location.href = `${config.pathPrefix}/${deviceId}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <a
          href="/remote"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          aria-label="Back to Remote Access"
        >
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div>
          <h1 className="text-2xl font-bold">{config.title}</h1>
          <p className="text-muted-foreground">{config.description}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search online devices..."
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadDevices()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            <RefreshCcw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        {loading ? (
          <div className="flex min-h-[220px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm text-red-600">{error}</p>
            <button
              type="button"
              onClick={() => void loadDevices()}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Retry
            </button>
          </div>
        ) : filteredDevices.length === 0 ? (
          <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 p-8 text-center">
            <Monitor className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {devices.length === 0
                ? 'No online devices are available.'
                : 'No devices match your search.'}
            </p>
            <a
              href="/devices"
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Open Device List
            </a>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Device</th>
                  <th className="px-4 py-3">OS</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Last Seen</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredDevices.map((device) => (
                  <tr key={device.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{device.displayName || device.hostname}</p>
                        <p className="text-xs text-muted-foreground font-mono">{device.hostname}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatOs(device.osType)}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/20 px-2.5 py-1 text-xs font-medium text-green-700">
                        {device.status || 'online'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatLastSeen(device.lastSeenAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleLaunch(device.id)}
                        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                      >
                        {config.actionLabel}
                      </button>
                    </td>
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
