import { RefreshCw, Monitor, AlertCircle } from 'lucide-react';
import type { FilterPreviewResult } from '@breeze/shared';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation('common');
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('filters.preview.title')}</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          {t('actions.refresh')}
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
            {t('filters.preview.addConditions')}
          </p>
        </div>
      )}

      {preview && (() => {
        // Defensive: a malformed/enveloped response previously made
        // `preview.devices` undefined and `.length` threw, taking the whole
        // page down rather than degrading this one panel. The unwrap in
        // FilterBuilder is the real fix; this keeps the blast radius small if
        // the shape ever drifts again.
        const devices = Array.isArray(preview.devices) ? preview.devices : [];
        const totalCount = typeof preview.totalCount === 'number' ? preview.totalCount : devices.length;
        return (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">{totalCount}</span>
              <span className="text-sm text-muted-foreground">
                {t('filters.preview.matchCount', { count: totalCount })}
              </span>
            </div>
            {totalCount > devices.length && (
              <span className="text-xs text-muted-foreground">
                {t('filters.preview.showing', { shown: devices.length, total: totalCount })}
              </span>
            )}
          </div>

          {devices.length > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {devices.map((device) => (
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

          {totalCount === 0 && (
            <div className="text-center py-4 text-sm text-muted-foreground">
              {t('filters.preview.noMatches')}
            </div>
          )}
        </div>
        );
      })()}
    </div>
  );
}

// Enum values whose raw name no longer matches the product's preferred wording
// get an explicit locale-key override instead of a hard-coded English string —
// see filters.value.enumOverrides in common.json (shared with ValueInput.tsx).
const STATUS_LABEL_OVERRIDE_KEYS: Record<string, string> = {
  decommissioned: 'filters.value.enumOverrides.decommissioned'
};

function StatusIndicator({ status }: { status: string }) {
  const { t } = useTranslation('common');
  const colorMap: Record<string, string> = {
    online: 'bg-green-500',
    offline: 'bg-gray-400',
    maintenance: 'bg-amber-500',
    // Removed is a terminal, non-error state — muted grey like offline, not red.
    decommissioned: 'bg-gray-400'
  };
  const overrideKey = STATUS_LABEL_OVERRIDE_KEYS[status];
  const label = overrideKey ? t(/* i18n-dynamic */ overrideKey) : status;

  return (
    <div
      className={`h-2 w-2 rounded-full ${colorMap[status] || 'bg-gray-400'}`}
      title={label}
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
  const { t } = useTranslation('common');
  const statusColors: Record<string, string> = {
    online: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    offline: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
    maintenance: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    // Removed is a terminal, non-error state — muted grey like offline, not red.
    decommissioned: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
  };
  const overrideKey = STATUS_LABEL_OVERRIDE_KEYS[status];
  const label = overrideKey ? t(/* i18n-dynamic */ overrideKey) : status;

  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${
        statusColors[status] || 'bg-gray-100 text-gray-700'
      }`}
    >
      {label}
    </span>
  );
}

export default FilterPreview;
