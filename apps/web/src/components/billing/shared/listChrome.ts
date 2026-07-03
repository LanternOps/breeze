// Shared chrome for the billing list surfaces (quotes / invoices / contracts).

/** className for a row-title link inside a clickable table or card row. The
 *  `focus-visible` ring gives keyboard users a clear affordance; the anchor
 *  `stopPropagation`s at the call site so it navigates natively instead of
 *  firing the row's SPA onClick. Kept in one place so the quotes, invoices and
 *  contracts lists can't drift. */
export const ROW_LINK_CLASS =
  'rounded-xs text-foreground hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Write hash-based list filters to the URL. With active filters, set
 *  `#key=value&…`; when cleared, strip the fragment cleanly via `replaceState`
 *  (a bare `location.hash = ''` leaves a dangling `#` in the URL). Shared by the
 *  quotes, invoices and contracts lists so the clear-residue fix can't regress
 *  on one surface. */
export function writeHashFilters(params: URLSearchParams): void {
  if (typeof window === 'undefined') return;
  const next = params.toString();
  if (next) {
    window.location.hash = `#${next}`;
  } else if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}
