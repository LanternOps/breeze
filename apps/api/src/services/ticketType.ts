/**
 * #7900 (feature #8592): the default ITIL type for a new ticket when the caller
 * names none (Open Decision 3). Every source opens an `incident` (staff
 * reclassify with one edit); planned work (a deliverable occurrence or project
 * task, i.e. a non-'support' work kind) is a `service_request`.
 *
 * createTicket applies this only when no explicit type is given, so a
 * defaulted type never carries field provenance: provenance records a
 * caller's decision, and nobody decided this one.
 */
import type { TicketType } from '@breeze/shared';
import type { ticketSourceEnum } from '../db/schema';

type TicketSource = (typeof ticketSourceEnum.enumValues)[number];

export function defaultTicketTypeForSource(
  _source: TicketSource,
  opts: { plannedWork?: boolean } = {}
): TicketType {
  if (opts.plannedWork) return 'service_request';
  // portal | email | alert | manual | api | ai: intake cannot tell an outage
  // from a request without NLP (out of scope), so the honest default is the
  // reactive one. A later `default_ticket_type` on intake forms / catalog
  // items plugs in at the caller, as an explicit type.
  return 'incident';
}
