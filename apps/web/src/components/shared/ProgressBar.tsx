import { cn } from '@/lib/utils';

export type ProgressBarVariant = 'default' | 'success' | 'warning' | 'error';

const variantStyles: Record<ProgressBarVariant, string> = {
  default: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-destructive',
};

export interface ProgressBarProps {
  current: number;
  total: number;
  label?: string;
  variant?: ProgressBarVariant;
  showCount?: boolean;
  className?: string;
}

export default function ProgressBar({
  current,
  total,
  label,
  variant = 'default',
  showCount = true,
  className,
}: ProgressBarProps) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div className={cn('w-full', className)}>
      {(label || showCount) && (
        <div className="flex justify-between text-xs text-muted-foreground mb-1">
          <span>{label}</span>
          {showCount && (
            <span>
              {current} of {total}
            </span>
          )}
        </div>
      )}
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300 ease-out',
            variantStyles[variant],
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/* ─── Per-item status list ─────────────────────────────────────── */

export type ItemStatus = 'pending' | 'running' | 'success' | 'failed';

const itemStatusStyles: Record<ItemStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-blue-500/15 text-blue-700',
  success: 'bg-success/15 text-success',
  failed: 'bg-destructive/15 text-destructive',
};

const itemStatusLabels: Record<ItemStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
};

export interface ProgressItem {
  id: string;
  label: string;
  status: ItemStatus;
  detail?: string;
}

export interface ProgressItemListProps {
  items: ProgressItem[];
  maxVisible?: number;
  className?: string;
}

/**
 * Compact per-item status list for use alongside ProgressBar.
 * Shows each device/item with a status badge.
 */
export function ProgressItemList({
  items,
  maxVisible = 10,
  className,
}: ProgressItemListProps) {
  const visible = items.slice(0, maxVisible);
  const remaining = items.length - visible.length;

  return (
    <div className={cn('space-y-1', className)}>
      {visible.map((item) => (
        <div
          key={item.id}
          className="flex items-center justify-between rounded-md px-3 py-1.5 text-sm"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate font-medium text-foreground">
              {item.label}
            </span>
            {item.detail && (
              <span className="text-xs text-muted-foreground truncate">
                {item.detail}
              </span>
            )}
          </div>
          <span
            className={cn(
              'shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              itemStatusStyles[item.status],
            )}
          >
            {itemStatusLabels[item.status]}
          </span>
        </div>
      ))}
      {remaining > 0 && (
        <p className="px-3 text-xs text-muted-foreground">
          and {remaining} more...
        </p>
      )}
    </div>
  );
}
