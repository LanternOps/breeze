/**
 * Shared loading skeleton for the billing list tables. Generalizes the 6-row
 * pulsing-bar block that QuotesPage rendered inline while a list loads, so the
 * contracts / invoices / quotes surfaces show a table-shaped placeholder instead
 * of a bare spinner.
 *
 * The first cell of each row is a fixed-width bar, the last stretches to the
 * right (the money column), and the middle cells fill the remaining width —
 * matching the visual rhythm of the original quotes skeleton.
 */
export interface TableSkeletonProps {
  /** Number of placeholder cells per row. */
  cols: number;
  /** Number of skeleton rows (defaults to 6, the original count). */
  rows?: number;
}

export function TableSkeleton({ cols, rows = 6 }: TableSkeletonProps) {
  const cellClass = (col: number) => {
    if (col === 0) return 'h-4 w-20 animate-pulse rounded bg-muted';
    if (col === cols - 1) return 'ml-auto h-4 w-24 animate-pulse rounded bg-muted';
    return 'h-4 w-1/4 animate-pulse rounded bg-muted';
  };
  return (
    <div className="divide-y" data-testid="table-skeleton">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: Math.max(cols, 1) }).map((_, c) => (
            <div key={c} className={cellClass(c)} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default TableSkeleton;
