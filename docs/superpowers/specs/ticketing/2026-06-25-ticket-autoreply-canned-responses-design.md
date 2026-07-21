# Ticket Auto-Reply Customization + Canned Responses — Design

**Date:** 2026-06-25
**Status:** Approved (design), pending implementation plan
**Area:** Native ticketing (Phase 6)

## Summary

Two related ticketing features that share one merge-variable engine:

1. **Customizable incoming-ticket auto-reply** — the auto-acknowledgement email
   sent when a ticket is created from inbound email already ships as a hardcoded
   v1. This makes its subject/body **customizable per partner** with merge
   variables, keeping the existing enable toggle and loop-prevention machinery
   untouched.
2. **Canned ticket responses** — net-new. A partner-wide shared library of saved
   reply templates (with merge variables) that a technician inserts into the
   ticket reply composer, edits, and sends.

Both substitute `{{variable}}` tokens, so the substitution logic is built once in
`packages/shared` and reused by web (client-side insert) and API (server-side
auto-reply render).

## Scope decisions (locked during brainstorming)

- **Auto-reply:** option A — make the existing acknowledgement customizable per
  partner. Not condition-aware (no per-category / business-hours variants), not a
  broader "template every ticket email" system. Those are explicit non-goals for
  v1.
- **Canned responses:** option B — snippets **with** merge variables (not plain
  text, not macros that set status/priority). Macros are a deferred follow-up
  (YAGNI for v1).
- **Canned-response ownership:** option A — partner-wide shared library (no
  personal per-agent snippets, no per-org sets). Mirrors every existing
  template-like table (`alertTemplates`, `ticketCategories`).

## Non-goals (v1)

- Condition-aware auto-replies (per category, business-hours vs after-hours,
  separate "received your reply" vs "opened your ticket" copy).
- Templating other ticket emails (status-change, resolution, SLA-breach).
- Personal per-technician snippets, per-org template sets.
- Macros (a canned response that also sets status/priority or adds a note).
- Server-side rendering endpoint for canned responses.

---

## Architecture

### Storage approach (chosen)

- **Auto-reply template:** lives in `partners.settings.ticketing.inbound` jsonb,
  beside the existing `autoresponderEnabled` and `address`. One template per
  partner — no list semantics — so **no new migration and no new RLS** for
  feature 1; it rides the already-tenant-scoped `partners` row.
- **Canned responses:** a **list** (many per partner), so a proper
  `ticket_response_templates` table with partner-axis RLS, mirroring
  `ticketCategories`.

Rejected alternative: putting the auto-reply in its own
`ticket_autoresponse_templates` table too. That's a single-row-per-partner table
carrying RLS overhead for no list semantics, and it orphans the existing
`autoresponderEnabled` jsonb flag (split-brain across two stores).

---

## Section 1 — Shared merge-variable engine

A single pure function in `packages/shared/src/utils/` so web and API substitute
identically:

```ts
renderTemplate(template: string, vars: Record<string, string>): string
// Replaces {{key}} tokens. Unknown tokens → empty string
// (no raw {{foo}} leaks to a customer-facing email).
```

Plus a **variable registry** declaring the canonical tokens + human labels (drives
the editor's "insert variable" menu and validation):

| Variable | Auto-reply | Canned response |
|---|---|---|
| `{{ticket_number}}` (T-YYYY-NNNN) | ✓ | ✓ |
| `{{ticket_subject}}` | ✓ | ✓ |
| `{{requester_name}}` | ✓ | ✓ |
| `{{requester_email}}` | ✓ | ✓ |
| `{{org_name}}` | ✓ | ✓ |
| `{{partner_name}}` | ✓ | ✓ |
| `{{agent_name}}` | — | ✓ |
| `{{current_status}}` | — | ✓ |
| `{{current_priority}}` | — | ✓ |

The engine is **context-agnostic** (pure token replacement). **HTML escaping is
the caller's responsibility:**

- Auto-reply path escapes values before passing (renders into `renderLayout`
  HTML).
- Canned-response path inserts into the plain-text composer textarea — no
  escaping.

This keeps one engine without baking an output format into it.

---

## Section 2 — Auto-reply customization (feature 1)

**Storage** — extend `partners.settings.ticketing.inbound`:

```jsonc
"inbound": {
  "autoresponderEnabled": true,        // existing
  "address": "...",                    // existing
  "autoresponseSubject": null,         // new — null = built-in default
  "autoresponseBody": null             // new — null = built-in default
}
```

`null`/absent ⇒ fall back to the current hardcoded `buildAutoresponseEmail` text.
Existing partners see **zero behavior change** until they explicitly customize. No
backfill, no migration.

**Render path** — `autoresponseTemplate.ts:buildAutoresponseEmail()` receives the
partner's custom subject/body. If present, it runs them through `renderTemplate()`
with **HTML-escaped** values, wrapped in the existing `renderLayout()` shell
(branding/footer/threading headers stay consistent). If absent, it emits today's
default string. The caller (`autoresponder.ts` /
`ticketNotifyWorker.ts:collectAutoresponse()`) already loads partner settings for
the enable-gate, so **no new query**.

**Untouched:** enable toggle, 1-per-sender-per-24h Redis cap,
`Auto-Submitted: auto-replied` header, loop-prevention rules, Message-ID
threading. This is purely "swap the body-text source."

**Validation:** subject/body length caps; body validated so unknown tokens warn
(don't hard-fail — they render empty).

---

## Section 3 — Canned responses: schema + API (feature 2 backend)

**New table** `ticket_response_templates` — partner-axis RLS (tenancy shape #3,
`breeze_has_partner_access(partner_id)`), policies added in the same migration that
creates the table, allowlisted in `rls-coverage.integration.test.ts` in the same
PR. Mirrors `ticketCategories`.

```ts
ticketResponseTemplates {
  id          uuid pk
  partnerId   uuid not null → partners(id)   // RLS axis
  name        text not null                   // shown in picker
  body        text not null                   // with {{variables}}
  category    text                            // optional free-text group/folder
  sortOrder   integer default 0
  isActive    boolean default true
  createdBy   uuid → users(id)                // audit only — NOT a scope axis in v1
  createdAt / updatedAt
}
```

`createdBy` is audit-only, leaving room to later add personal snippets via an
`isPersonal` flag without a migration rewrite.

**Routes** — new `apps/api/src/routes/tickets/ticketResponseTemplates.ts`,
partner-scoped via `requireScope`:

- `GET /ticket-response-templates` — list active, ordered by category then
  sortOrder (loaded by the composer)
- `POST /ticket-response-templates` — create (admin)
- `PATCH /ticket-response-templates/:id` — update
- `DELETE /ticket-response-templates/:id` — hard delete (no FK references, no audit
  trail need)

**No server-side rendering endpoint** — substitution happens client-side in the
composer via shared `renderTemplate()`; the browser already holds the full ticket
context. The API stores/serves raw template bodies.

Mirrors the `alertTemplates` service/route pattern.

---

## Section 4 — Web UI (feature 1 + 2 frontend)

**Composer insert (feature 2 — everyday surface):** `TicketComposer.tsx` gets a
**"Canned response" picker** (dropdown/popover next to the reply/internal-note
toggle). The workbench loads `GET /ticket-response-templates` once and passes them
down. Selecting one:

1. Builds the variable map from the already-loaded ticket (`ticket_number`,
   `requester_name`, `agent_name` from current user, `current_status`, etc.).
2. Runs shared `renderTemplate(body, vars)`.
3. **Inserts at the cursor** (append if no selection) — agent can stack snippets
   and edit before sending. Never auto-sends.

Templates grouped by `category` in the picker. Button hidden when the partner has
no templates.

**Settings management (both features) — partner settings hub, `#ticketing`
(per issue #1327):**

- **Auto-reply card:** existing enable toggle + subject input + body textarea with
  an "insert variable" menu (auto-reply subset) and a **live preview** against
  sample values. Empty = "using default" hint showing the built-in text.
- **Canned responses card:** CRUD list — name, category, body (insert-variable
  menu, full set), active toggle, reorder. Inline form/modal matching existing
  `ticketCategories` / `alertTemplates` admin UIs.

All mutations wrapped in `runAction` (web mutation-handler rule). Match existing
settings-hub card styling.

**Workflow note:** frontend work — build it but **hold the PR for Todd's review**
rather than auto-merging.

---

## Section 5 — Testing & error handling

**Shared engine** (Vitest): `renderTemplate` — known substitution, unknown→empty,
repeated/adjacent tokens, empty template, no-token passthrough, malformed `{{`.
Variable-registry tests asserting auto-reply subset vs full set.

**API** (Vitest + Drizzle mocks):

- `ticketResponseTemplates` route — CRUD happy paths, partner-scoping (can't
  read/write another partner's templates), validation (name/body required, length
  caps).
- **RLS integration** — add `ticket_response_templates` to the partner-axis
  allowlist in `rls-coverage.integration.test.ts`, plus a functional cross-tenant
  forge as `breeze_app` (contract test catches missing RLS; only a functional
  insert catches a missing axis).
- Auto-reply: `autoresponseTemplate` test — custom subject/body renders with
  escaped variables; `null` settings fall through to the exact current default
  (regression guard); `<script>` in `requester_name` is HTML-escaped in the email.

**Web** (Vitest + jsdom): composer insert-at-cursor, picker hidden when no
templates, `runAction` wraps mutations, settings cards render/save.

**Error handling:** unknown variables render empty (no hard fail); auto-reply send
failures flow through existing `ticketNotifyWorker` retry (unchanged); template
CRUD failures surface via `runAction` toasts.

---

## Key file touchpoints

- `packages/shared/src/utils/` — new `renderTemplate` + variable registry (+ tests)
- `apps/api/src/services/inboundEmail/autoresponseTemplate.ts` — accept custom
  subject/body
- `apps/api/src/services/inboundEmail/autoresponder.ts` /
  `apps/api/src/jobs/ticketNotifyWorker.ts` — pass partner custom template through
- `apps/api/src/db/schema/` — new `ticket_response_templates` table
- `apps/api/migrations/` — new table + partner-axis RLS policies (idempotent)
- `apps/api/src/routes/tickets/ticketResponseTemplates.ts` — new CRUD routes
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist
- `apps/web/src/components/tickets/TicketComposer.tsx` /
  `TicketWorkbench.tsx` — canned-response picker + insert
- partner settings hub (`#ticketing`) — auto-reply card + canned-responses CRUD card
