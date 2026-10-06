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

/** Every button is the same height side by side (the border keeps primary level with
 *  secondary) and a 44px tap target on phones (V-24). */
export const BTN_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-transparent bg-primary px-4 py-2 sm:min-h-9 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';

export const BTN_SECONDARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2 sm:min-h-9 text-sm font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';

/** Hand-styled checkbox and radio: contrasty border (a faint hairline once hid the
 *  signature checkbox from real customers), the one green ink, a visible ring. */
export const CHECKBOX =
  'mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border border-muted-foreground/50 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed';
export const RADIO =
  'mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed';

/** The portal has no ghost or tertiary button: a quieter action is a real link. */
export const LINK =
  'rounded-sm font-medium text-primary-on-tint underline decoration-primary-on-tint/40 underline-offset-4 transition-colors hover:decoration-primary-on-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** A primary action that ends something the client can't undo themselves
 *  (precedent: SignaturePanel's decline). */
export const BTN_DANGER = cn(BTN_PRIMARY, 'bg-destructive text-destructive-foreground hover:bg-destructive/90');

/** Phone-first: a primary action spans the column on phones, sizes to its label from sm. */
export const BTN_BLOCK = 'w-full sm:w-auto';

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
 * The five tones a status can take anywhere in the portal. Producers map a
 * domain status (ticket, invoice, quote, device) to a tone; only this file
 * knows which classes a tone wears, so the dot/text/chip pairing that
 * tokenContrast.test.ts asserts AA-safe cannot drift per call site.
 *
 * Amber (`warning`) is reserved for states the customer should act on;
 * `primary` is informational; `neutral` is anything quiet.
 */
export type MarkTone = 'success' | 'warning' | 'destructive' | 'primary' | 'neutral';

const MARK_TONES: Record<MarkTone, { dot: string; text: string; chip: string }> = {
  success: { dot: 'bg-success', text: 'text-success-on-tint', chip: 'bg-success/10 text-success-on-tint' },
  warning: { dot: 'bg-warning', text: 'text-warning-on-tint', chip: 'bg-warning/10 text-warning-on-tint' },
  destructive: { dot: 'bg-destructive', text: 'text-destructive-on-tint', chip: 'bg-destructive/10 text-destructive-on-tint' },
  primary: { dot: 'bg-primary', text: 'text-primary-on-tint', chip: 'bg-primary/10 text-primary-on-tint' },
  neutral: { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground', chip: 'bg-muted text-muted-foreground' },
};

/** Tinted-chip classes for a tone — the stamped presentation paper documents
 *  (documentShell) keep instead of the ledger's dot. */
export function markChipClass(tone: MarkTone): string {
  return MARK_TONES[tone].chip;
}

/**
 * Status as a mark in the register: a small dot of the tone's hue beside
 * quiet text in its AA-safe `-on-tint` foreground.
 */
export function StatusMark({
  tone,
  children,
  className,
  ...rest
}: {
  tone: MarkTone;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const t = MARK_TONES[tone];
  return (
    <span
      data-tone={tone}
      {...rest}
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold uppercase tracking-[0.08em]', t.text, className)}
    >
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', t.dot)} />
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
      {/* <h2>, not <h3>: every page opens with PageHeader's single <h1>, so an
          <h3> here skips a level and reads as a missing section. */}
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
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

/**
 * Inline notice, left-aligned, for a message inside a page or panel (ErrorNotice
 * stays the centered list banner). Text always wears the tone's AA-safe -on-tint
 * foreground. Destructive is an alert; every other tone is a polite status.
 */
export function Notice({
  tone,
  title,
  children,
  action,
  className,
  ...rest
}: {
  tone: MarkTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div
      role={tone === 'destructive' ? 'alert' : 'status'}
      {...rest}
      className={cn('rounded-lg p-4 text-sm', MARK_TONES[tone].chip, className)}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cn('space-y-1.5 leading-relaxed', title && 'mt-1')}>{children}</div>}
      {action && <div className="mt-3 flex flex-wrap items-center gap-3">{action}</div>}
    </div>
  );
}
