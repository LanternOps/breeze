/**
 * Pieces shared by the three #3198 business report generators
 * (ticket_sla_attainment, technician_time_billability, ar_aging). Kept free of
 * `db` so the dispatcher and the unit tests can import it cheaply.
 */

/**
 * Tickets, time entries and invoices carry no site axis, so a site-restricted
 * authority queries NOTHING. Printed on the artifact rather than a reassuring
 * zero — a zero here would read as "you had no overdue invoices", which is a
 * lie. Used by the dispatcher's zero-safe branch (restricted to zero sites) AND
 * by each generator (restricted to some sites — the dispatcher lets that
 * through to the generator, which must refuse it itself: there is no site
 * filter it could apply).
 */
export const SITE_RESTRICTED_NOTE =
  'This report ran under a site-restricted authority. Tickets, time entries and '
  + 'invoices have no site dimension, so nothing was queried — the figures below '
  + 'are not measured, and they are not zero.';

/** Partner scope only. The org list is `resolvePartnerReportOrgIds`
 *  (services/reportScope.ts): active/trial, not deleted, not quick_support. */
export const PARTNER_ORG_LIST_NOTE =
  'Partner-wide figures cover the partner\'s active and trial customer organizations; '
  + 'suspended, archived and deleted organizations (and the internal quick-support '
  + 'organization) are excluded.';

/** Partner scope with an empty org list: the generator short-circuits. */
export const NO_ORGS_NOTE =
  'This partner has no active or trial organizations, so there was nothing to measure.';

/** `db.execute` returns an array-like RowList on postgres-js; tolerate a
 *  `{ rows }` envelope too (node-postgres shape, some mocks). */
export function rowsOf<T>(result: unknown): T[] {
  const maybe = result as { rows?: T[] };
  return maybe.rows ?? (result as T[]);
}

/** part / whole, or null when the denominator is zero — an unmeasured ratio
 *  is null, never 0 and never NaN (spec §3.3). */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}
