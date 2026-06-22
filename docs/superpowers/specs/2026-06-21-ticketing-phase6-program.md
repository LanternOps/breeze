# Ticketing Phase 6 — Program Outline

**Date:** 2026-06-21
**Status:** Program framing. 6a spec'd alongside this doc; 6b–6d get their own spec → plan cycles when reached.

## Background

Native ticketing shipped through Phase 5 (P1a #1196, P1b #1223, P2 SLA #1250, P3 time+parts
#1276/#1285, config #1287, P4 email-to-ticket #1360–62, P5 email routing/domain mapping #1715).
A set of items was deferred without a formal next phase. Phase 6 collects them.

Because the deferred set spans several independent subsystems, it is decomposed into sub-phases.
Each sub-phase is built and reviewed independently; 6a and 6b have no ordering dependency, while
6d (automation) consumes events produced by the others and is sequenced last.

## Sub-phases

| Sub-phase | Scope | Risk | Depends on |
|---|---|---|---|
| **6a — Editing affordances** | Comment edit/delete · wire missing ticket-field edit UI · org reassign | Med (org reassign) | — |
| **6b — Business-hours SLA calendars** | Per-partner business-hours calendars; SLA deadline math honors them (today: 24×7 wall-clock) | Med | — |
| **6c — Configurable status/transition workflow** | Custom transitions + required-fields-on-transition built on #1287 config tables; core six-state machine stays the logic source | Med-High (touches core state machine) | 6a (field edit semantics) helpful, not required |
| **6d — Workflow automation rules** | Rules engine: on event → action (assign/notify/escalate/comment). Subsumes the deferred "escalation-policy wiring" item. Consumes the event bus | High | 6a/6b/6c events |

Deferred items mapped:
- *Ticket field editing / editing & workflow gap* → 6a (+ 6c for transition workflow).
- *Business-hours SLA calendars* → 6b.
- *Escalation-policy wiring* → 6d.
- *Portal-side SLA visibility* → folded into 6b (SLA fields only become meaningful once business-hours
  targets exist) — small read-path + portal UI addition.
- *Ticketing e2e spec additions* → distributed across each sub-phase's own e2e coverage rather than
  a standalone task.

## Conventions for every sub-phase

- New tenant-scoped tables follow the RLS shape rules in `CLAUDE.md` and are added to the relevant
  allowlist + `ORG_CASCADE_DELETE_ORDER` in the same PR; verified by the Integration Tests job.
- Real-DB tests go in `apps/api/src/__tests__/integration/*.integration.test.ts` (BLOCKING job).
- Migrations are idempotent, date-prefixed, never edited after shipping.
- All ticket mutations route through `ticketService`/`timeEntryService` (routes/AI tools/MCP are equal
  consumers) and emit through the single `TicketEvent` dispatch point.
