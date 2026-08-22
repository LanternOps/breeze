import React from 'react';
import { cn } from '@/lib/utils';

/**
 * The Guest Ledger's shared vocabulary. Every list and form in the portal
 * composes from these so the register reads as one hand throughout:
 *  - page titles in the serif display face with one line of service copy;
 *  - ledgers ruled by hairlines (divide-y on the tbody), never boxed chips;
 *  - statuses as a small ink dot beside quiet text, not filled pills;
 *  - one primary button shape.
 *
 * Responsive contract carried over from the previous tables: below `sm` a row
 * reflows from a table row into a stacked card (portal readers usually arrive
 * on a phone from an email); at `sm` and up real table semantics return. One
 * DOM tree either way, so data-testids and `scope="col"` headers stay unique.
 */

export const ROW =
  'ledger-row flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3.5 sm:table-row sm:p-0';
export const CELL = 'block sm:table-cell sm:px-4 sm:py-3.5';
export const TH =
  'px-4 pb-2.5 pt-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground';

export const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';

export const BTN_SECONDARY =
  'inline-flex items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';

export const INPUT =
  'mt-1.5 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary';

/** Serif page title plus one line of service copy — how every page opens. */
export function PageHeader({
  title,
  lede,
  action,
}: {
  title: string;
  lede?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">
          {title}
        </h1>
        {lede && <p className="mt-1.5 text-sm text-muted-foreground">{lede}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * Status as a mark in the register: a small dot of the status hue beside
 * quiet text in the AA-safe `-on-tint` foreground. `dotClass` takes the
 * background-tuned token (`bg-success`), `textClass` its on-tint pair.
 */
export function StatusMark({
  dotClass,
  textClass,
  children,
  className,
  ...rest
}: {
  dotClass: string;
  textClass: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold uppercase tracking-[0.08em]', textClass, className)}
    >
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)} />
      {children}
    </span>
  );
}

/** Ruled empty state: no dashed box, just the register saying so politely. */
export function EmptyState({
  icon,
  title,
  children,
  className,
  ...rest
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('border-y border-border/70 py-14 text-center', className)}>
      {icon && <div className="mx-auto mb-4 flex justify-center text-muted-foreground/70">{icon}</div>}
      <h3 className="font-display text-lg font-semibold text-foreground">{title}</h3>
      {children}
    </div>
  );
}

/** Error banner shared by every list. */
export function ErrorNotice({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-lg bg-destructive/10 p-4 text-center text-sm font-medium text-destructive-on-tint">
      {children}
    </div>
  );
}
