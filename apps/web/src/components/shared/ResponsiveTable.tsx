import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Responsive data-table container.
 *
 * Above the `sm` breakpoint it renders a horizontally *scrollable* table. The
 * tables across monitoring/discovery previously used `overflow-hidden`, which
 * silently clips right-hand columns (Type, status, Actions) on any viewport
 * narrower than the table — the exact defect mobile users reported. `overflow-x-auto`
 * keeps every column reachable on tablet/narrow-desktop.
 *
 * Below `sm` the table is hidden entirely and a stacked card list is shown,
 * because a 6–7 column table never reads well on a phone no matter how it scrolls.
 *
 * Each surface supplies its own `table` and `cards` because cell content is
 * heterogeneous (status pills, button groups, nested host metadata); this
 * primitive owns only the responsive switch, the scroll fallback, and a
 * consistent breakpoint so the seven tables can't drift apart again.
 */
export function ResponsiveTable({
  table,
  cards,
  className,
}: {
  table: ReactNode;
  cards: ReactNode;
  className?: string;
}) {
  return (
    <div className={className} data-testid="responsive-table">
      <div className="hidden overflow-x-auto rounded-md border sm:block" data-testid="responsive-table-desktop">
        {table}
      </div>
      <div className="space-y-2 sm:hidden" data-testid="responsive-table-cards">
        {cards}
      </div>
    </div>
  );
}

/**
 * Card chrome for the mobile (`sm:hidden`) representation of a table row.
 * Mirrors the table row's hover/click affordance: pass `onClick` to make the
 * whole card tappable (44px+ touch target via padding).
 */
export function DataCard({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-md border bg-card p-4 text-sm',
        onClick && 'cursor-pointer transition active:bg-muted/60',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Bottom actions row for a {@link DataCard}: a top divider plus a touch-target
 * floor. Desktop tables keep their compact 32px icon buttons (mouse), but on a
 * phone those are below the 44px tap-target minimum, so this enlarges every
 * contained button to 44×44 — the icon stays centered. Pass `className` for any
 * extra layout the row's buttons need (e.g. `flex flex-wrap justify-end gap-2`
 * when the action group doesn't bring its own flex wrapper).
 */
export function CardActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mt-3 border-t pt-3 [&_button]:h-11 [&_button]:w-11', className)}>
      {children}
    </div>
  );
}

/**
 * A single "label — value" line inside a {@link DataCard}. Label sits left in
 * muted caps, value right-aligned, so a stack of fields stays scannable the way
 * the table columns were. Use for secondary attributes (Type, SNMP, Last seen);
 * render the row's primary identity above the fields as a heading.
 */
export function CardField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}
