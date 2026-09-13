/**
 * "Still open" status vocabularies shared by the org-scoped aggregates —
 * the record Overview (routes/orgSummary.ts) and the Organizations account
 * board (services/orgAccountReadiness.ts). One definition, so the two
 * surfaces can never disagree about what counts as an open ticket or an
 * outstanding invoice.
 */
import { sql, type SQL } from 'drizzle-orm';
import { INVOICE_STATUSES } from '@breeze/shared';

// Mirrors OPEN_STATUSES in routes/tickets/tickets.ts. Kept local — that
// constant scopes the ticketing queue routes, and importing that whole
// module here for one array would be a needless coupling.
export const TICKET_OPEN_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

// Every invoice status the billing program still considers "outstanding" —
// i.e. everything except the two terminal states (paid, void) and the
// pre-issuance draft state.
export const INVOICE_OPEN_STATUSES = INVOICE_STATUSES.filter(
  (status) => status !== 'draft' && status !== 'paid' && status !== 'void',
);

/** `$1, $2, …` — a bound-parameter list for use inside `IN (…)`. */
export function sqlStatusList(statuses: readonly string[]): SQL {
  return sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  );
}
