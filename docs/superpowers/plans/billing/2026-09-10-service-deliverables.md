---
tracking_issue: LanternOps/breeze#5573
---
# Service Deliverables, Org Documents and Key Dates — Plan Index

**Spec:** `docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md` (approved 2026-09-10).

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-service-deliverables/wave-<sub-issue#>` with `Closes #<sub-issue#>`
in the PR body. State lives on GitHub (feature-lifecycle); the wave issue is the
source of truth for status, never this index.

| Wave | Plan | Depends on |
|---|---|---|
| W01 | [Schema, core services, contract and org record surfaces](2026-09-10-service-deliverables-w01-schema-core.md) | — |
| W02 | [Sweep worker, ticket integration, key-date reminders, auto-evidence, MCP tools](2026-09-10-service-deliverables-w02-sweep-and-tickets.md) | W01 |
| W03 | [Org documents library, blob storage extraction, document evidence, Documents tab](2026-09-10-service-deliverables-w03-org-documents.md) | W01 |
| W04 | [Customer portal Service and Documents surfaces](2026-09-10-service-deliverables-w04-portal.md) | W02, W03 |
| W05 | [Deliverable template sets, apply-to-org/contract, settings page, first-customer backfill](2026-09-10-service-deliverables-w05-templates-and-backfill.md) | W01 |

W03 and W05 run in parallel with W02. W04 starts once both W02 and W03 have merged.

## Migration slots reserved

| File | Wave |
|---|---|
| `2026-10-15-170000-service-deliverables.sql` | W01 |
| `2026-10-15-170100-tickets-work-kind.sql` | W01 |
| `2026-10-15-170200-organization-key-dates.sql` | W01 |
| `2026-10-15-170300-org-documents.sql` | W03 |
| `2026-10-15-170400-documents-permissions.sql` (DML: seeds `documents:*` permission rows; elects `breeze.scope=system` first) | W03 |
| `2026-10-16-110100-deliverable-templates.sql` | W05 |
| `2026-10-16-110000-portal-branding-service-documents-flags.sql` | W04 |

Every executor re-checks `ls apps/api/migrations | sort | tail -1` before committing
and renames upward if main has moved past these names. Slots are independent
(no wave's migration depends on a later slot), so waves may land in any order
that respects the dependency column above.

## Cross-wave names that must not drift

Defined in W01 and consumed verbatim by W02–W05: `serviceDeliverables`,
`serviceDeliverableOccurrences`, `serviceDeliverableEvidence`,
`organizationKeyDates`, `ticketWorkKindEnum`; `DeliverableActor`,
`DeliverableServiceError`, `DeliverableSummary`, `OccurrenceView`, `KeyDateView`,
`EvidenceRef`; `transition` (`serviceDeliverableState.ts`); `planOccurrences`,
`coveredPeriod`, `nthDueDate`, `isInLeadWindow`, `isPastGrace` (`recurrence.ts`);
the four W02 stubs `materializeOccurrences`, `openOccurrence`,
`markOccurrenceMissed`, `applyTicketStatusChange`; routes under
`/orgs/:orgId/deliverables…` and `/orgs/:orgId/key-dates…`.
