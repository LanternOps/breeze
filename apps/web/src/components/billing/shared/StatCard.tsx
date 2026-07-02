import type { ReactNode } from 'react';

interface StatCardProps {
  /** Small muted caption above the figure (e.g. 'Outstanding', 'Drafts'). */
  label: string;
  /** The figure itself — a formatted money string, a count, or per-currency JSX. */
  value: ReactNode;
  /** Optional sub-caption below the figure (e.g. '3 open', 'needs follow-up'). */
  hint?: string;
  /** When provided the card is an interactive filter button; omit for a static
   *  read-only stat (e.g. contracts MRR). */
  onClick?: () => void;
  /** Whether the filter this card sets is currently applied — draws a ring so the
   *  active filter is visible. Only meaningful for a clickable card. */
  active?: boolean;
  /** 'destructive' tints the card red for attention-worthy stats (overdue). */
  tone?: 'default' | 'destructive';
  /** Extra classes on the outer element (e.g. `inline-flex` to size to content). */
  className?: string;
  testId?: string;
}

const BASE = 'rounded-lg border px-4 py-3 text-left';

/**
 * The one summary-strip stat card for every billing surface (invoices, quotes,
 * contracts). Clickable cards render as a real <button> with a focus ring so
 * keyboard users can operate the stat-as-filter affordance; static cards render
 * as a <div>. Extracted from the Invoices strip so quotes/contracts can't drift
 * in padding, tone, or focus behaviour.
 */
export function StatCard({ label, value, hint, onClick, active, tone = 'default', className, testId }: StatCardProps) {
  const destructive = tone === 'destructive';
  const toneCls = destructive ? 'border-destructive/30 bg-destructive/5' : 'bg-card';
  const labelCls = destructive ? 'text-destructive' : 'text-muted-foreground';
  const valueCls = destructive ? 'text-destructive' : 'text-foreground';
  const classes = [BASE, toneCls, className].filter(Boolean).join(' ');

  const content = (
    <>
      <div className={`text-xs ${labelCls}`}>{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${valueCls}`}>{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </>
  );

  if (!onClick) {
    return (
      <div className={classes} data-testid={testId}>
        {content}
      </div>
    );
  }

  const hover = destructive ? 'hover:bg-destructive/10' : 'hover:bg-muted/40';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={`${classes} transition ${hover} focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${active ? 'ring-2 ring-ring' : ''}`}
    >
      {content}
    </button>
  );
}

export default StatCard;
