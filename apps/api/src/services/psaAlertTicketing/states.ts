/**
 * Which `psa_ticket_mappings` rows are mid-operation (#10499 W2-A).
 *
 * A mapping is "open" while Breeze may have a remote side effect it has not
 * accounted for, or owes the PSA an action right now:
 *
 * - a create that is in flight, whose outcome is unknown, or that a human must
 *   resolve (`needs_attention`: a ticket may exist that Breeze is not tracking);
 * - a created ticket whose close has not completed;
 * - a resolve (close/resolve note) or acknowledgement note that is pending, in
 *   flight, or of unknown outcome.
 *
 * Deleting a connection is refused while any of its mappings is open
 * (`DELETE /psa/connections/:id`): the connection's credentials are the only
 * way to finish or reconcile that work. Everything else is terminal or idle
 * (a closed ticket, a queued `never_attempted` create with no remote effect
 * yet, a skip) and is deleted
 * with the connection.
 */

import { and, inArray, ne, or, type SQL } from 'drizzle-orm';
import { psaTicketMappings } from '../../db/schema';

export const OPEN_CREATE_STATES = ['create_in_flight', 'create_outcome_unknown', 'needs_attention', 'created'] as const;
export const OPEN_OPERATION_STATES = ['pending', 'in_flight', 'outcome_unknown'] as const;

export function openPsaMappingCondition(): SQL {
  return or(
    and(
      inArray(psaTicketMappings.createState, [...OPEN_CREATE_STATES]),
      or(ne(psaTicketMappings.createState, 'created'), ne(psaTicketMappings.closeState, 'closed')),
    ),
    inArray(psaTicketMappings.closeState, [...OPEN_OPERATION_STATES]),
    inArray(psaTicketMappings.noteState, [...OPEN_OPERATION_STATES]),
  )!;
}
