// Shared presentational helpers for the quote + invoice billing UI, so copy and
// affordances can't drift between the editor and detail/document surfaces.

/**
 * Inline "Unsaved" affordance for blur-saved fields (terms / notes). Shown while
 * the field holds uncommitted edits; the field's onBlur save clears the dirty
 * flag on success, so this also stays lit if a save FAILS — surfacing that the
 * edit didn't persist instead of relying on a transient toast the user may miss.
 */
export function UnsavedBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-warning"
      data-testid="unsaved-badge"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
      Unsaved
    </span>
  );
}

/**
 * The recurring-billing explanation shown beneath quote totals. Single source so
 * the editor and the detail view can't drift (the customer-facing QuoteDocument
 * keeps its own shorter copy intentionally).
 */
export function RecurringBillingNote({ className, testId }: { className?: string; testId?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-muted-foreground ${className ?? ''}`} data-testid={testId}>
      Accepting this quote invoices only the one-time charges now. Recurring lines (monthly + annual) bill on their
      own schedule via the contract. The first-period total combines the one-time charges with the first period of
      each recurring cadence.
    </p>
  );
}
