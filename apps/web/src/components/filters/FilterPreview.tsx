import { RefreshCw, Monitor, AlertCircle } from 'lucide-react';
import type { FilterPreviewResult } from '@breeze/shared';

interface FilterPreviewProps {
  preview: FilterPreviewResult | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function FilterPreview({
  preview,
  loading,
  error,
  onRefresh
}: FilterPreviewProps) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Matching Devices</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !preview && (
        <div className="flex items-center justify-center py-6">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {!loading && !preview && !error && (
        <div className="text-center py-6">
          <p className="text-sm text-muted-foreground">
            Add filter conditions to see matching devices
          </p>
        </div>
      )}

      {preview && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">{preview.totalCount}</span>
              <span className="text-sm text-muted-foreground">
                device{preview.totalCount !== 1 ? 's' : ''} match
              </span>
            </div>
            {preview.totalCount > preview.devices.length && (
              <span className="text-xs text-muted-foreground">
                Showing {preview.devices.length} of {preview.totalCount}
              </span>
            )}
          </div>

          {preview.devices.length > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {preview.devices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between rounded border bg-background px-3 py-2"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusIndicator status={device.status} />
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">
                        {device.displayName || device.hostname}
                      </div>
                      {device.displayName && device.hostname !== device.displayName && (
                        <div className="text-xs text-muted-foreground truncate">
                          {device.hostname}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <OsBadge osType={device.osType} />
                    <StatusBadge status={device.status} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {preview.totalCount === 0 && (
            <div className="text-center py-4 text-sm text-muted-foreground">
              No devices match the current filter criteria
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusIndicator({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    online: 'bg-green-500',
    offline: 'bg-gray-400',
    maintenance: 'bg-amber-500',
    decommissioned: 'bg-red-500'
  };

  return (
    <div
      className={`h-2 w-2 rounded-full ${colorMap[status] || 'bg-gray-400'}`}
      title={status}
    />
  );
}

function OsBadge({ osType }: { osType: string }) {
  const osLabels: Record<string, string> = {
    windows: 'Win',
    macos: 'Mac',
    linux: 'Linux'
  };

  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {osLabels[osType] || osType}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusColors: Record<string, string> = {
    online: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    offline: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
    maintenance: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    decommissioned: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
  };

  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${
        statusColors[status] || 'bg-gray-100 text-gray-700'
      }`}
    >
      {status}
    </span>
  );
}

export default FilterPreview;
