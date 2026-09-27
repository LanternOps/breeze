import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface LineItemColumn<T> {
  /** Unique key for React list rendering. */
  key: string;
  /** Column header (desktop `<th>`) and, below `sm`, the inline field label. */
  header: string;
  align?: 'left' | 'right';
  cellClassName?: string;
  cell: (line: T) => ReactNode;
}

export interface LineItemsTableProps<T> {
  rows: T[];
  columns: LineItemColumn<T>[];
  /** Rendered once per row into the description cell — the only cell that
   *  never gets an inline label, mirroring the description-first stacked-card
   *  layout below `sm`. */
  renderDescription: (line: T) => ReactNode;
  descriptionHeader: ReactNode;
  keyFor: (line: T) => string;
  rowTestId: (line: T) => string;
  tableTestId: string;
  scrollAriaLabel: string;
  /** Optional content rendered above the table inside the card chrome (e.g.
   *  a section label or a provenance notice). */
  header?: ReactNode;
  emptyMessage: ReactNode;
  emptyTestId?: string;
  rowClassName?: (line: T) => string;
  descriptionCellClassName?: (line: T) => string;
  className?: string;
}

/**
 * Shared line-item table for invoice and quote detail pages (#7175).
 *
 * `InvoiceDetail` and `QuoteDetail` each used to keep their own copy of this
 * table (`overflow-x-auto` + `min-w-[Nrem]`), so on a 390px phone the price
 * and total columns sat past the card edge with only a sliver of the next
 * column hinting that the table scrolled sideways.
 *
 * This renders ONE `<table>` (not a duplicate desktop-table + mobile-cards
 * pair): the description cell holds a `InvoiceLineDevices`-style stateful
 * subcomponent on the invoice side, and rendering it twice would double its
 * fetches and duplicate its data-testids. Instead, Tailwind's `sm:table*`
 * utilities turn the same `<tr>`/`<td>` elements into a block/flex stacked
 * card below `sm` (each field shown as "LABEL  value") and back into a real
 * table at `sm` and up — one row of markup, one set of test ids, and the
 * rendered amounts can't drift between "mobile" and "desktop" because
 * there's only one copy of them.
 *
 * The `min-w-[32rem]` that forced horizontal scrolling on a phone only
 * applies at `sm` and up now (`sm:min-w-[32rem]`), so below `sm` there's
 * nothing to scroll — the "no scroll cue" complaint stops applying because
 * there's no hidden horizontal content left.
 */
export function LineItemsTable<T>({
  rows,
  columns,
  renderDescription,
  descriptionHeader,
  keyFor,
  rowTestId,
  tableTestId,
  scrollAriaLabel,
  header,
  emptyMessage,
  emptyTestId,
  rowClassName,
  descriptionCellClassName,
  className,
}: LineItemsTableProps<T>) {
  const colSpan = columns.length + 1;
  return (
    <div className={cn('rounded-lg border bg-card shadow-xs', className)}>
      {header}
      {/* Keyboard-reachable scroll region for the (sm and up) wide internal
          view, which can still run past a tablet viewport. Below `sm` the
          table has no min-width, so there is nothing to scroll here. */}
      <div className="overflow-x-auto" role="region" aria-label={scrollAriaLabel} tabIndex={0}>
        <table
          className="block w-full text-sm sm:table sm:min-w-[32rem]"
          data-testid={tableTestId}
        >
          <thead className="hidden sm:table-header-group">
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">{descriptionHeader}</th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn('px-3 py-2 font-medium', col.align === 'right' && 'text-right')}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="block space-y-2 p-2 sm:table-row-group sm:space-y-0 sm:p-0">
            {rows.length === 0 ? (
              <tr className="block sm:table-row">
                <td
                  colSpan={colSpan}
                  className="block px-3 py-6 text-center text-sm text-muted-foreground sm:table-cell"
                  data-testid={emptyTestId}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((line) => (
                <tr
                  key={keyFor(line)}
                  data-testid={rowTestId(line)}
                  className={cn(
                    'block rounded-md border p-3 sm:table-row sm:rounded-none sm:border-0 sm:border-t sm:p-0',
                    rowClassName?.(line),
                  )}
                >
                  <td className={cn('block pb-2 sm:table-cell sm:px-3 sm:py-2 sm:pb-2 sm:align-top', descriptionCellClassName?.(line))}>
                    {renderDescription(line)}
                  </td>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        'flex items-center justify-between gap-3 py-1 text-sm sm:table-cell sm:px-3 sm:py-2',
                        col.align === 'right' && 'sm:text-right',
                        col.cellClassName,
                      )}
                    >
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
                        {col.header}
                      </span>
                      <span>{col.cell(line)}</span>
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
