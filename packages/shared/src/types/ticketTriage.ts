/**
 * Phase 2 wave P2-4 (#4191) — the ticket-triage profile's outcome shape.
 * Produced by the model via `submit_ticket_proposal` (a `profile: 'triage'`
 * run's ONLY outcome tool — see `AI_AGENT_RUN_PROFILES` in `aiAgents.ts`) and
 * turned by `finishRun` into Tier-2 `manage_tickets` intents (`update_fields`,
 * `link_device`, `comment`) plus `ticket_drafts` rows — never a public reply
 * and never an auto-close, and never written without a human click unless the
 * agent is `mode: 'act'` with `triggers.ticketAutonomousWrites` set (spec
 * `2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.4 amendment).
 */

export const TICKET_TRIAGE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketTriagePriority = (typeof TICKET_TRIAGE_PRIORITIES)[number];

/**
 * One model-proposed field value plus its own confidence. `finishRun` only
 * turns this into an `update_fields` write when `confidence >=
 * TICKET_TRIAGE_CONFIDENCE_FLOOR` (see that constant's docstring), and never
 * overwrites a value a human already set — checked against the transactional
 * `tickets.field_provenance` at execution time, the revalidation step (spec
 * §4.4 amendment).
 */
export interface TicketTriageFieldProposal<T extends string> {
  value: T;
  /** 0..1. */
  confidence: number;
}

/**
 * The `submit_ticket_proposal` payload. Every string is model-authored TEXT
 * — never a tool call or a raw payload — mirroring the "safe projection"
 * discipline every other outcome DTO in this package follows.
 *
 * `device` carries IDENTIFIERS ONLY (`hostname`/`serial`); resolving them to
 * an actual `devices.id` — including refusing an ambiguous multi-match — is
 * entirely server-side (`link_device`, spec §4.4).
 *
 * `draftReply`/`draftResolutionNote` are never sent or posted by the agent:
 * they become `ticket_drafts` rows a technician must explicitly send ("Send
 * as me") or a resolution-note prefill offered at close. `notes` are
 * proposed talking points folded into the one private note the run posts —
 * display only, never a write on their own.
 */
export interface TicketTriageProposal {
  version: 1;
  /** Private-note body. 1..2000 chars. */
  summary: string;
  fields?: {
    categoryId?: TicketTriageFieldProposal<string>;
    priority?: TicketTriageFieldProposal<TicketTriagePriority>;
  };
  device?: {
    hostname?: string;
    serial?: string;
  };
  /** 1..4000 chars. */
  draftReply?: string;
  /** 1..2000 chars. */
  draftResolutionNote?: string;
  /** At most 5 entries, each at most 500 chars. */
  notes?: string[];
}

/**
 * Minimum per-field confidence `finishRun` requires before turning a
 * `TicketTriageFieldProposal` into an `update_fields` write (spec §4.4
 * amendment: "only when `ticketProposal.confidence ≥ 0.7` per field"). Below
 * this floor the field is simply dropped from the write — never written at a
 * lower tier, never surfaced as a lower-confidence suggestion.
 */
export const TICKET_TRIAGE_CONFIDENCE_FLOOR = 0.7;
