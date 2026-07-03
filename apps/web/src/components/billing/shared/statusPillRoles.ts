/**
 * Status-pill color roles, built from the app's semantic tokens (success /
 * warning / info / destructive) rather than raw Tailwind palette hues. Shared by
 * the invoice, quote AND contract status pills (imported by invoiceTypes,
 * quoteTypes and the contracts API layer) so the vocabulary can't drift between
 * the sibling surfaces.
 *
 * This lives in `billing/shared/` — not `invoiceTypes.ts` — so non-component
 * layers (e.g. `lib/api/contracts.ts`) can type against `StatusPillRole` without
 * reaching up into an invoice-specific component module (an api→components
 * layering smell).
 *
 * Five roles, not a per-status rainbow: meaning drives the hue (neutral = not
 * sent, info = awaiting the customer, success = won/paid, warning = lapsing,
 * danger = lost/overdue). The text label carries the finer distinction (Sent vs
 * Viewed, Accepted vs Converted), so colour stays scannable.
 *
 * `info`/`success` base tokens are dark enough (L≈37-38%) to read on their own
 * 10% tint; `warning`/`danger` base tokens (amber L50% / red L56%) fail WCAG as
 * text on a light tint, so light mode uses a darker shade of the SAME token hue
 * and dark mode (where the bg is dark) uses the token directly.
 */
export const STATUS_PILL = {
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-info/30 bg-info/10 text-info',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/15 text-[hsl(36_92%_28%)] dark:text-warning',
  danger: 'border-destructive/40 bg-destructive/10 text-[hsl(4_74%_42%)] dark:text-destructive',
} as const;

/** The five semantic pill roles (keys of STATUS_PILL). Consumed by the shared
 *  `<StatusPill role>` and by the per-domain status→role maps in
 *  invoiceTypes / quoteTypes / contracts. */
export type StatusPillRole = keyof typeof STATUS_PILL;
