import { useEffect, useMemo } from 'react';
import { Search } from 'lucide-react';
import type { UseDeviceOptionsResult } from '../../hooks/useDeviceOptions';

export type DeviceOptionPickerProps = {
  result: UseDeviceOptionsResult;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  search: string;
  onSearchChange: (search: string) => void;
  selectionMode?: 'single' | 'multiple';
  showSelectAll?: boolean;
  onCanSubmitChange?: (canSubmit: boolean) => void;
  disabled?: boolean;
  className?: string;
};

export function DeviceOptionPicker({
  result,
  selectedIds,
  onSelectedIdsChange,
  search,
  onSearchChange,
  selectionMode = 'multiple',
  showSelectAll = false,
  onCanSubmitChange,
  disabled = false,
  className = '',
}: DeviceOptionPickerProps) {
  const optionIds = useMemo(
    () => new Set(result.options.map((option) => option.id)),
    [result.options],
  );
  const unresolvedIds = selectedIds.filter((id) => !optionIds.has(id));
  const canSubmit = result.canSubmit && unresolvedIds.length === 0 && !disabled;

  useEffect(() => {
    onCanSubmitChange?.(canSubmit);
  }, [canSubmit, onCanSubmitChange]);

  const toggle = (id: string, checked: boolean) => {
    if (selectionMode === 'single') {
      onSelectedIdsChange(checked ? [id] : []);
      return;
    }
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedIdsChange([...next]);
  };

  const choicesDisabled = disabled
    || result.state === 'loading'
    || result.state === 'stale'
    || result.state === 'error';
  const complete = !!result.page && !result.page.hasMore;

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          aria-label="Search devices"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search devices"
          disabled={disabled || result.state === 'loading'}
          className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>

      {result.state === 'loading' && (
        <p role="status" className="py-3 text-center text-sm text-muted-foreground">
          Loading devices…
        </p>
      )}
      {result.state === 'stale' && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          Updating device choices. Existing labels are stale until this request completes.
        </p>
      )}
      {result.state === 'error' && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{result.error?.message ?? 'Unable to load devices.'}</span>
          <button type="button" onClick={result.retry} className="font-medium underline underline-offset-2">
            Retry
          </button>
        </div>
      )}
      {unresolvedIds.length > 0 && result.state !== 'loading' && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {unresolvedIds.length === 1
            ? 'A selected device could not be resolved in the authorized scope.'
            : `${unresolvedIds.length} selected devices could not be resolved in the authorized scope.`}
        </p>
      )}
      {result.state === 'truncated' && unresolvedIds.length === 0 && (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          More devices must be loaded before this complete selection can be submitted.
        </p>
      )}

      {result.state === 'empty' && (
        <p className="py-4 text-center text-sm text-muted-foreground">No devices found.</p>
      )}

      {result.options.length > 0 && (
        <div className="max-h-64 space-y-1 overflow-y-auto" aria-label="Device choices">
          {result.options.map((device) => {
            const checked = selectedIds.includes(device.id);
            const label = device.displayName?.trim() || device.hostname;
            return (
              <label
                key={device.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm transition hover:bg-muted/40 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
              >
                <input
                  type={selectionMode === 'single' ? 'radio' : 'checkbox'}
                  name={selectionMode === 'single' ? 'device-option' : undefined}
                  checked={checked}
                  disabled={choicesDisabled}
                  onChange={(event) => toggle(device.id, event.target.checked)}
                  className="h-4 w-4 border-muted text-primary focus:ring-primary"
                />
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{label}</span>
                  {label !== device.hostname && (
                    <span className="block truncate text-xs text-muted-foreground">{device.hostname}</span>
                  )}
                  <span className="text-xs text-muted-foreground">{device.osType}</span>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  device.status === 'online'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                }`}>
                  {device.status}
                </span>
              </label>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        {result.page?.hasMore && (
          <button
            type="button"
            onClick={() => void result.loadMore()}
            disabled={disabled || result.state === 'loading' || result.state === 'stale'}
            className="text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            Load more
          </button>
        )}
        {showSelectAll && complete && canSubmit && result.options.length > 0 && selectionMode === 'multiple' && (
          <button
            type="button"
            onClick={() => onSelectedIdsChange(result.options.map((option) => option.id))}
            className="ml-auto text-sm font-medium text-primary hover:underline"
          >
            Select all
          </button>
        )}
      </div>
    </div>
  );
}
