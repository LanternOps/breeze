export interface BulkAction {
  key: string;
  label: string;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
  onClick: () => void;
}

export interface BulkActionBarProps {
  count: number;
  actions: BulkAction[];
  onClear: () => void;
  testIdPrefix: string;
}

export function BulkActionBar({ count, actions, onClear, testIdPrefix }: BulkActionBarProps) {
  if (count === 0) return null;
  return (
    <>
      {/* In-flow spacer: the bar itself is absolutely positioned and would float
          over the last table row(s). This sibling reserves an equal slice of
          height in normal flow so the bar overlays blank space, never data — the
          caller needs no `pb-*` padding hack of its own. */}
      <div aria-hidden="true" data-testid="bulk-bar-spacer" className="h-14" />
      <div
        className="absolute inset-x-0 bottom-0 z-10 border-t bg-background px-3 py-2 shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.15)] animate-[fade-up_0.18s_ease-out_both]"
        data-testid={`${testIdPrefix}-bulk-bar`}
      >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium tabular-nums">{count} selected</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              disabled={a.disabled}
              data-testid={`${testIdPrefix}-bulk-action-${a.key}`}
              className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                a.variant === 'destructive'
                  ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
                  : 'border hover:bg-muted'
              }`}
            >
              {a.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClear}
            data-testid={`${testIdPrefix}-bulk-clear`}
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            Clear
          </button>
        </div>
      </div>
      </div>
    </>
  );
}
