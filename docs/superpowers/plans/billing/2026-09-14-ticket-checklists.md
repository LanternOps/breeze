---
# tracking_issue is added by `register_feature` at Stage 4 registration — do not
# hand-write it here.
spec: docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md
issue: LanternOps/breeze#5783
parent_feature: LanternOps/breeze#5573
tracking_issue: LanternOps/breeze#5808
---
# Ticket checklists + internal instructions on deliverable templates — Plan Index

**Spec:** `docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md`
(approved 2026-09-14; Gate A resolved every Open Decision "as recommended", with
OD-3 settled as **A** — a live `checklist_template_id` pointer plus a 409
`CHECKLIST_TEMPLATE_IN_USE` delete guard).

**Parent feature:** #5573 service deliverables, spec
`docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md`,
plans `docs/superpowers/plans/billing/2026-09-10-service-deliverables*.md`.

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-ticket-checklists/wave-<sub-issue#>` with `Closes #<sub-issue#>`
in the PR body, **targeting `main`** — never a sibling branch (`ci.yml` triggers on
`pull_request: branches: [main]`, so a stacked PR runs no CI at all and
`gh pr checks` reads green on nothing). State lives on GitHub (feature-lifecycle);
the wave issue is the source of truth for status, never this index.

| Wave | Plan | Depends on |
|---|---|---|
| W01 | [Checklist primitive, registrations, REST and the ticket card](2026-09-14-ticket-checklists-w01-primitive.md) | — |
| W02 | [Checklist template library, partner-wide ownership, apply-template, settings](2026-09-14-ticket-checklists-w02-templates.md) | W01 |
| W03 | [Deliverable instructions, sweep seeding, occurrence drawer, AI, portal no-leak](2026-09-14-ticket-checklists-w03-deliverables.md) | W01, W02 |

The waves are strictly sequential: W02's `apply-template` route hangs off W01's
checklist router and service, and W03's FK columns reference W02's tables. Each is
independently shippable — W01 alone gives a technician ad-hoc steps on any ticket,
W02 alone gives a reusable library, W03 wires the deliverable sweep.

## Migration slots reserved

| File | Wave |
|---|---|
| `apps/api/migrations/2026-10-16-190000-ticket-checklist-items.sql` | W01 |
| `apps/api/migrations/2026-10-16-190100-ticket-checklist-templates.sql` | W02 |
| `apps/api/migrations/2026-10-16-190200-deliverable-checklist-wiring.sql` | W03 |

Verified 2026-09-14: the newest migration on `origin/main` is
`2026-10-16-182600-ticket-comment-proposal-note-uq.sql`, and
`'2026-10-16-190000-…' > '2026-10-16-182600-…'` under `localeCompare`, so all three
slots still sort last. **Re-check before every commit and again before every push**:

```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```

The pre-push hook runs `scripts/check-migration-naming.sh --against-ref origin/main`,
so a filename that sorted fine at commit time still fails at push time if `origin/main`
gained a later one meanwhile. Rename upward (and re-`git add`) if it does — an
unmerged migration is freely renameable; a shipped one never is.

`2026-10-16` is **not** a closed date block (the closed one is `2026-08-06`), so the
`-1900NN-` time component is the correct ordering mechanism here — no `-a-`/`-b-`
infix is needed or wanted.

## Cross-wave names that must not drift

Defined in W01 and consumed verbatim by W02 and W03:

- Tables / enums: `ticket_checklist_items`, `ticketChecklistItems`,
  `ticket_checklist_item_source`, `ticketChecklistItemSourceEnum`.
- Constraint name: `ticket_checklist_items_ticket_org_fk` (named individually in
  both movers' `SET CONSTRAINTS … DEFERRED` lists — `ALL` is forbidden there).
- Service module `apps/api/src/services/ticketChecklistService.ts` exporting
  `ChecklistActor`, `ChecklistServiceError`, `ChecklistItemView`,
  `ChecklistSummary`, `listChecklist`, `addChecklistItem`, `patchChecklistItem`,
  `reorderChecklist`, `deleteChecklistItem`, `checklistCountsForTickets`.
- Router `apps/api/src/routes/tickets/checklist.ts` exporting
  `ticketChecklistRoutes`, mounted in `apps/api/src/routes/tickets/index.ts`
  **before** the hub's `/:id` routes.
- Error codes: `CHECKLIST_REORDER_MISMATCH` (400),
  `CHECKLIST_TICK_REQUIRES_USER` (403), `NOT_FOUND` (404).
- Web component `apps/web/src/components/tickets/TicketChecklistCard.tsx` with
  props `{ ticketId: string; mode?: 'full' | 'compact'; onCountsChange?: (c: { done: number; total: number }) => void }`.
  It resolves the org from the ticket server-side, so no `orgId` prop.
- i18n namespace `checklists.json` in all eight locales.

Defined in W02 and consumed by W03:

- Tables: `ticket_checklist_templates`, `ticket_checklist_template_items`;
  Drizzle `ticketChecklistTemplates`, `ticketChecklistTemplateItems`.
- Service `apps/api/src/services/ticketChecklistTemplateService.ts` exporting
  `ChecklistTemplateView`, `ChecklistTemplateItemView`,
  `loadChecklistTemplateOr404`, `visibleChecklistTemplateCondition`,
  `applyChecklistTemplateToTicket`.
- Error codes: `CHECKLIST_TEMPLATE_IN_USE` (409, **the referencing query lands in
  W03**, when the two `checklist_template_id` columns exist),
  `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG` (409, W03),
  `PARTNER_WIDE_WRITE_DENIED` (403).
- `ownerScope: 'organization' | 'partner'` — create-only, spelled identically in
  the validator, the service, the web client and the UI.

## What this plan will not do

Restated from spec §8 so an executor does not "helpfully" add it: no portal
exposure of steps, instructions or progress; no auto-resolve or auto-deliver on
completion (permanently rejected, not deferred); no blocking `checklist_required`
guard (deferred, OD-4 C); no AI tick-off (deferred, OD-7); no mobile app; no
per-step assignee, due date or dependencies; no nested checklists; no backfill onto
already-`open` occurrences; no `n / m` badge in the ticket list.
