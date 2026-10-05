/**
 * `tickets.field_provenance` stamps that count as a HUMAN decision: the AI
 * triage CAS (`ticketService.applyAiFieldUpdates`), the AI triage admission
 * gate (`aiAgents/ticketTriageFindings.ts`) and the SLA restamp never
 * overwrite them.
 *
 * A partner service principal (Partner API tickets surface) is an external
 * system of record — a PSA/ITSM — so a category/priority it set is as
 * authoritative as a technician's. Every provenance guard must go through
 * this module; `ticketProvenance.test.ts` fails on a bare `'user'` comparison
 * elsewhere.
 */
export const HUMAN_AUTHORITATIVE_PROVENANCE = ['user', 'service_principal'] as const;

export type HumanAuthoritativeProvenance = (typeof HUMAN_AUTHORITATIVE_PROVENANCE)[number];

export function isHumanAuthoritativeProvenance(value: string | undefined | null): boolean {
  return value != null && (HUMAN_AUTHORITATIVE_PROVENANCE as readonly string[]).includes(value);
}

/** The SQL list literal for `NOT IN (...)` / `IN (...)` guards, kept in one place. */
export const HUMAN_AUTHORITATIVE_PROVENANCE_SQL_LIST = "('user', 'service_principal')";
