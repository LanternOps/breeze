---
tracking_issue: LanternOps/breeze#6754
wave: W06 (#6776)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W04 (#6758, PR #10130) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6776
---
# AI full control W06: PSA configuration and ticket operations — class review and plan

**Goal:** build the seven PSA tools the W05 triage assigned to W06 (`manage_ticket_config`, `manage_ticket_checklist_templates`, `manage_ticket_inbox`, `manage_ticket_attachments`, `manage_ticket_forms`, `manage_ticket_response_templates`, `manage_time_suggestions`), add `bulk_update` to `manage_tickets`, and land the three REMAPs, each with a class that survives the spec's class review rule **before** the tool is reachable (spec D2). Unlike W04 these are new tools: Zod schema, registry entry, handler, tier, permission, rate limit, coverage mapping, tests.

**Verified against** `origin/main` `70c16781cd` (2026-10-25: W04 #10130 merged; `KNOWN_MISSING_TOOL_TIERS` gone; `FIXTURE_W03_W04` empty). Evidence: the nine REST route files read in full, their services, and these precedents:
- `manage_ticket_routing_rules` (#8883 W5) — a ticket-config tool whose every write is **supervised** (registry tier 3).
- `manage_backup_profiles` (W03) — a registry-tier-1 multiplexer: reads in `TIER1_READ_ACTIONS`, org create at t2 through `TIER3_INPUT_AWARE_ACTIONS`, partner-wide create and update/delete supervised.
- `manage_ticket_checklist` (#6930) — same services as the checklist-template tool; refuses an `ai_agent` principal on writes.

Paths are under `apps/api/src/`; line numbers drift.

## Premises (all hold)

| # | Check | Result |
|---|---|---|
| 0.1 | #10130 merged on `origin/main`; `KNOWN_MISSING_TOOL_TIERS` absent | yes (`70c16781cd`; only comments mention it) |
| 0.2 | none of the seven names exists in registry, `TOOL_TIERS`, `HUMAN_ONLY_TOOLS` | yes (only the W05 triage doc names them) |
| 0.3 | no `wave-6776` branch or PR | yes |
| 0.4 | #6776 and #6754 open | yes |

## What the routes actually do (facts the triage did not have)

1. **Almost all of this is partner-wide config.** `ticket_categories`, `ticket_statuses`, priority settings, `customer_email_domains` and `ticket_response_templates` key on `partner_id` alone: one write changes every org under the partner. Only org ticket settings (SLA override map) is one org. Forms and checklist templates have **both** axes (org-owned or partner-wide) and gate partner-wide writes on `canManagePartnerWidePolicies`.
2. **Three write families carry `requireMfa()`** on the REST route: `PATCH /organizations/:id/ticket-settings`, the `/ticket-forms` writes and the `/ticket-response-templates` writes. The invariant written in `aiGuardrails.ts` (MFA note beside `TOOL_EXTRA_PERMISSIONS`): *a tool mirroring a `requireMfa()` route must be at least Tier 2, and Tier 3 if the route mutates.* Chat is MFA-gated at the session; MCP is not, and tier 3 is denied over MCP.
3. **`ticketConfig.ts` mutations and the email-inbound queue are admin-only** (`adminMiddleware`: full partner access **and** platform admin or wildcard `*:*` role). `tickets:write` alone is not enough. The tool must apply the same check.
4. **`bulk` has no priority action today.** `bulkTicketActionSchema` is `assign | status | delete`; `status` refuses `resolved`. The triage row says "assign/status/priority". Priority bulk is therefore **new behaviour**, built from the per-ticket `updateTicketFields` path that `manage_tickets update_fields` already uses (same service, same audit), not a route twin.
5. **Attachments land PENDING** (`comment_id` null) and are claimed by a later comment. `manage_tickets comment` takes no attachment ids, so an AI-attached file is staged for a human to post; it is reaped after 24 h. The AI has no way to list attachment ids today (`manage_tickets get` omits them), so the tool needs a `list` action (derived from the feed query in `routes/tickets/tickets.ts`).
6. **Inbound email is attacker-authored text.** The quarantine queue exists *because* the sender is unknown; its `subject`, `fromAddress`, `toAddress` and `error` are fenced in `RAW_TEXT_FIELDS_BY_TOOL`.
7. **`attachments` write paths stamp `uploaded_by_user_id`** (users FK) — an `ai_agent` principal id is not a users row (same reason `manage_ticket_checklist` refuses agents).

## Per-tool class review (spec "Class review rule")

**Q1** reversible within a minute? **Q2** leaves the tenant or reaches a person? **Q3** blast radius. **Q4** can an agent grant itself authority? t1 = `TIER1_READ_ACTIONS`; t2 = user approves unless `auto_approve`; sup = tier 3 supervised. **Triage** = the class the W05 triage proposed.

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W06** | Why it differs from the triage |
|---|---|---|---|---|---|---|---|
| `manage_ticket_config:get_config` / `list_categories` | read | none | partner | no | read | **t1** | — (partner-global read gate mirrored) |
| `…:get_org_settings` | read | none | one org | no | read | **t1** | — |
| `…:list_inbound_domains` | read | none | partner | no | read | **t1** | admin-only like the route |
| `…:update_org_settings` | yes (patch back) | none (SLA targets; breach alerts are internal) | one org | no | t2 | **sup** | route has `requireMfa()` and mutates → invariant ⇒ tier 3 |
| `…:create_category` / `update_category` / `delete_category` (soft) / `reorder_categories` | yes | none | **partner-wide** | no | t2 | **sup** | spec: partner-wide ⇒ supervised at minimum. Precedent `manage_ticket_routing_rules` |
| `…:create_status` / `update_status` / `reorder_statuses` | partly (a status in use cannot be freely retired) | none | partner-wide | no | t2 | **sup** | partner-wide |
| `…:set_priorities` | yes | none (SLA clocks recompute) | partner-wide | no | t2 | **sup** | partner-wide |
| `…:create_inbound_domain` / `update_inbound_domain` | yes | **changes where a sender's mail lands** (org routing + auto-create) | partner-wide | no | t2 | **sup** | partner-wide; misroute puts customer A's mail on customer B's ticket list |
| `…:delete_inbound_domain` | no (hard delete) | same | partner-wide | no | t2 | **4e** | spec: irreversible **and** partner-wide ⇒ four-eyes (quorum QW2) |
| `manage_ticket_checklist_templates:list` / `get` | read | none | org + partner rows visible to caller | no | read | **t1** | — |
| `…:create` | yes | none | org **or** partner-wide, by input | no | t2 | **input-aware:** `ownerScope:'partner'` → **sup**, else **t2** | precedent `manage_backup_profiles:create` |
| `…:update` / `add_item` / `update_item` / `remove_item` / `reorder_items` | yes (an item or label is re-addable) | none | org **or** partner-wide, decided by DB state | no | t2 | **sup** | ownership is not in the input ⇒ static supervised (precedent `manage_backup_profiles:update`) |
| `…:delete` | **no** (hard delete; a referenced template is refused) | none | org **or** partner-wide, DB state | no | t2 | **4e** | irreversible and, for a partner row, partner-wide; ownership is DB state ⇒ static four-eyes (quorum QW2) |
| `manage_ticket_inbox:list` | read | none | partner | no | read | **t2** | attacker-authored text by construction. Plain t2, **not** t2-ro: a read-only resolution skips the agent allowlist (quorum QW1); fenced |
| `…:convert` | no (no un-convert; the row is terminal) | **sets an external requester** on the ticket, so every later public comment / resolve email goes to the sender; `manage_tickets:create` sets none | one org, **model-chosen** | no | t2 | **sup** | quorum QW3: requester repoint is already supervised (`update_fields`); convert is the same effect plus cross-org placement |
| `…:dismiss` | **no** (terminal `ignored`, cannot be processed again) | none | one row | no | t2 | **sup** | irreversible ⇒ supervised at minimum (quorum QW3) |
| `manage_ticket_attachments:list` | read | none | one ticket | no | — | **t1** | new action (no REST twin; mirrors the comment feed + own pending rows) |
| `…:read_content` | read | none | one attachment | no | read | **t2** | returns decoded file text; plain t2 (t2-ro would skip the agent allowlist, quorum QW1); binary never returned; fenced |
| `…:attach_from_artifact` | yes (delete) | none (pending row, invisible until a comment posts it) | one ticket | no | t2 | **t2** | — |
| `…:delete` | **no** (object + row hard-deleted) | none | one attachment | no | t2 | **sup** | spec: irreversible ⇒ supervised at minimum |
| `manage_ticket_forms:list` / `available` | read | none | org + partner | no | read | **t1** | — |
| `…:create` / `update` | yes | **customer-visible portal form** | org or partner-wide | no | sup | **sup** | — (also `requireMfa()`) |
| `…:delete` | **no** (hard delete) | customer-visible form disappears from the portal | org or partner-wide, DB state | no | sup | **4e** | irreversible, partner-wide possible, ownership is DB state ⇒ static four-eyes (quorum QW2) |
| `manage_ticket_response_templates:list` | read | none | partner | no | read | **t1** | — |
| `…:create` / `update` | yes | none (canned text staff insert into replies) | partner-wide | no | t2 | **sup** | partner-wide **and** `requireMfa()` |
| `…:delete` | **no** (hard delete) | none | partner-wide | no | t2 | **4e** | irreversible **and** partner-wide (quorum QW2) |
| `manage_time_suggestions:list` | read | none | own suggestions | no | read | **t1** | own user only (`manageAll` is false for AI) |
| `…:confirm` | yes (edit/delete the entry) | none (bookkeeping; billable entries reach invoices only through the normal billing run) | one entry | no | t2 | **t2** | — (precedent `manage_tickets:log_time_entry`) |
| `…:dismiss` / `undo` | yes (inverse pair) | none | own suggestion | no | t2 | **t2** | — |
| `manage_tickets:bulk_update` | assign/priority yes; status mostly | assign notifies the assignee (internal); status ≠ resolved reaches nobody | **≤ 50 tickets, ONE org** | no | t2 | **t2** with a single-org rule | quorum QW4: the handler refuses a batch spanning orgs, so "single-org" holds (route: 100 tickets, any orgs) |

**Net effect of the review.** The triage proposed t2 for every write except forms. The spec's own rule (partner-wide, irreversible, the MFA-route invariant) puts every PSA config write at supervised or above, and the five hard deletes of partner-keyed or ownership-by-DB-state config at **four-eyes**. That is a deliberate disagreement with the triage (a first-pass gap list, not a class review), recorded here and for Todd in the PR. Only `manage_ticket_checklist_templates:create` (org-owned), the ticket-ops writes (`attach_from_artifact`, `bulk_update`) and the time-suggestion writes stay t2.

### Final per-action classes (T7's `W06_EXPECTED` copies this)

| Tool | t1 (read) | t2 | supervised | four-eyes |
|---|---|---|---|---|
| `manage_ticket_config` | get_config, get_org_settings, list_categories, list_inbound_domains | — | update_org_settings, create/update/delete/reorder category, create/update status, reorder_statuses, set_priorities, create/update inbound domain | delete_inbound_domain |
| `manage_ticket_checklist_templates` | list, get | create (org-owned) | create (`ownerScope:'partner'`, input-aware), update, add_item, update_item, remove_item, reorder_items | delete |
| `manage_ticket_inbox` | — | list | convert, dismiss | — |
| `manage_ticket_attachments` | list | read_content, attach_from_artifact | delete | — |
| `manage_ticket_forms` | list, available | — | create, update | delete |
| `manage_ticket_response_templates` | list | — | create, update | delete |
| `manage_time_suggestions` | list | confirm, dismiss, undo | — | — |
| `manage_tickets` (+1) | — | bulk_update | — | — |

Four-eyes applies only to the five irreversible deletes; no identity change, no money, nothing that leaves the tenant. No four-eyes → supervised move, so no loosening of an existing gate. Org-owned form / checklist-template deletes are four-eyes too because ownership is DB state and guardrails are DB-free; Todd may split them by ownership if a solo operator needs chat deletes (follow-up).

## Wiring (spec checklist 1–11), per tool

- **Registry tier** 1 for all seven (precedent `manage_backup_profiles`); the per-action maps carry the real classes. `TOOL_TIERS` gets a `// Spec 2026-09-23 W06 (#6776): PSA configuration + ticket ops.` block directly after W04's.
- **Maps:** `TIER1_READ_ACTIONS`, `TIER2_ACTIONS`, `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` / `TIER3_FOUR_EYES_ACTIONS`, `TIER3_INPUT_AWARE_ACTIONS` (+ `isInputAwareTier3` arm and `TIER_DECIDING_INPUT_KEYS` for `checklist_templates:create`), `TOOL_ACTION_INPUT_KEYS` not needed (`action` is the default key).
- **RBAC** (`TOOL_PERMISSIONS`, per-action): tickets:read/write for everything routed through `ticketCategories`, `ticketConfig`, forms, templates, checklist templates, attachments, bulk; `organizations:read|write` for org settings (route `ORGS_READ`/`ORGS_WRITE`); `time_entries:read|write` for suggestions. Route parity contract rows for every action that has a REST twin (T3).
- **Admin check** for the `ticketConfig.ts` surface (statuses, priorities, inbound domains, email-inbound): the handler applies `canManagePartnerWidePolicies` **and** (`isPlatformAdmin` or wildcard permission), the same predicate as `adminMiddleware`. Documented as handler-level, because `TOOL_PERMISSIONS` cannot express it.
- **Scope** mirrors each route. Partner/system only: ticket config (except `list_categories`), org settings, inbound domains, inbox, response templates, checklist templates, time suggestions. **Org scope allowed** (as the route does): `list_categories` (active categories only, the route's restricted projection, partner derived from the caller's org, never from input), forms (`list`, `available`, and org-owned writes with the route's ownership checks), attachments and `bulk_update` (org context required). Org-scoped callers elsewhere get `PARTNER_SCOPE_REQUIRED`.
- **Agents:** write actions that stamp a users FK refuse an `ai_agent` principal (checklist templates writes, attachments attach/delete, time suggestions, bulk_update). Config writes are partner-admin acts and also refuse an agent principal: an agent must never reconfigure its own ticket queue (Q4 answer is "no" only because the handler refuses; recorded).
- **Rate limits** (`TOOL_RATE_LIMITS`): config writes 20/300 s, attachments 30/60 s (route: 30/60), bulk 10/300 s, forms 20/300 s, templates 20/300 s, suggestions 30/300 s, inbox 20/300 s. Pure-read tools none.
- **Output:** list actions use `aiToolPagination` (`limit`/`offset`/`cursor`, default 50, max 200) and the budget contract; the inbox uses the service's own page/limit; `read_content` is capped at 20,000 characters.
- **Fencing:** `RAW_TEXT_FIELDS_BY_TOOL` entries — `manage_ticket_inbox: subject, fromAddress, toAddress, error`; `manage_ticket_attachments: originalFilename, text`; `manage_time_suggestions: subject, hostname`.
- **Attachment content (text-safe):** only `text/*`, `application/json`, `application/xml` and CSV artifact-backed rows are decoded; everything else (JPEG/PNG/WebP/PDF uploads and unknown types) returns metadata plus `contentReturned:false`. Decoded text goes through the same fence as device file reads and the 20,000-character cap; an invalid-UTF-8 payload is refused rather than lossily decoded. No binary byte ever reaches the model.
- **Helper:** out of scope (single-device). **Agent catalog:** all seven land in the `tickets` capability with sup/t2 classes as above.
- **`mcpCoverage.ts`:** the eight triage rows move from gap to `{ tools: [...] }`; REMAPs #41, #42, #44 point at the existing tools (no code).
- **No migration. No new route. No new `services/*.ts` file** unless the parked-fanout contract demands a classification (handler files are `aiTools*.ts`, which the contract treats as registry modules).

## W19 index measurement (bounds, not the old whole-index budget)

Measured in T5 on the branch: always-on < 2,560 B (main 2,494), every domain block < 2,048 B (the `tickets` block is the only one that grows), worst page turn < 7,040 B. No ceiling change, no `DOMAIN_NOTES` or vocabulary edit. If the `tickets` block would exceed 2,048 B the wave **stops and reports**; labels are not trimmed and tools are not dropped. Results are recorded in the PR body.

## Decisions

- **W06-D1: supervised, not t2, for partner-wide and MFA-route writes** (see the review table). Disagrees with the triage; Todd signs the delta in the PR.
- **W06-D2: `manage_ticket_checklist_templates:create` is input-aware** (`ownerScope:'partner'` ⇒ supervised). Every other template write is static supervised: ownership is DB state.
- **W06-D3: `bulk_update` is a new capability for `priority`**, implemented per ticket through `updateTicketFields`; assign and status mirror `POST /tickets/bulk`. `delete` is **not** in the AI enum (triage: "bulk delete excluded"), and the Zod enum cannot express it. `resolved` is refused (route parity: resolution needs a per-ticket note).
- **W06-D4: `bulk_update` is single-org and capped at 50 tickets** (route: 100, any orgs). A t2 write runs unprompted in `auto_approve`, and the spec's t2 condition is *single-org*; the handler resolves every id through the caller's scope first and refuses the whole call (nothing written) when the batch spans organizations (quorum QW4).
- **W06-D5: admin predicate in the handler** for the `ticketConfig.ts` surface and the inbox (route parity the permission map cannot express).
- **W06-D6: `manage_ticket_attachments:list` added** (no REST twin) so the model can find ids; mirrors the comment feed's visibility: posted attachments of non-deleted comments, plus the caller's own pending rows.
- **W06-D7: text-safe attachment reads** (see Wiring); `read_content` is plain t2 (not t1, because it returns file content; not t2-ro, because a read-only resolution skips the agent allowlist, quorum QW1).
- **W06-D10: five hard deletes are four-eyes** (`delete_inbound_domain`, response-template `delete`, forms `delete`, checklist-template `delete`; spec: irreversible and partner-wide). `categories delete` is a soft deactivate and stays supervised. Each new four-eyes key follows the `effectDigestCoverage` contract (resolver or a recorded `DELIBERATELY_UNPINNED` reason).
- **W06-D11: inbox `convert` and `dismiss` are supervised** (terminal, and convert sets an external requester, quorum QW3). `list` is plain t2.
- **W06-D12: `duplicate` stays on `manage_ticket_checklist`** (already wired in #6930, route-bound); the new templates tool does not repeat it (quorum QW5: classified there as supervised-by-ownership is a follow-up, its existing class is t2).
- **W06-D8: agent principals are refused on every W06 write** (users-FK and "agent must not reconfigure its queue"). Reads follow the class (t1 reads are agent-reachable; t2-ro reads need an allowlist entry).
- **W06-D9: tool handlers mirror the route logic; the routes are not refactored.** Categories, forms and response templates have inline route logic; extracting shared services would touch three routes and their suites in a wave about tool exposure. Parity is pinned by route-binding rows and handler tests instead. Recorded as a follow-up.

## Quorum (codex `exec`, read-only, xhigh)

**Codex verdict: AGREE WITH CHANGES** (QW1–QW6; xhigh, read-only, 2026-10-25). It agreed with the supervised minimum for reversible partner-wide writes and MFA-route mutations (spec Class rule, MFA invariant), the checklist-create split, the attachment staging/deletion classes, the time-suggestion classes and the blanket agent-write refusal. Each requested change, resolved on the merits:

- **QW1 inbox `list` / attachment `read_content`: t2-ro skips the agent allowlist. Accepted** — both are plain t2 (W06-D7, table).
- **QW2 partner-wide hard deletes → four-eyes. Accepted** (W06-D10). The W03 QW4 rejection ("static 4e moves no risk because a supervised sibling writes the same rows") does not apply: no sibling tool exists for these rows. *Cost, for Todd:* org-owned form and checklist-template deletes need a second approver too (ownership is DB state; guardrails are DB-free), and a solo operator cannot approve their own four-eyes call, so they delete in the UI. `remove_item` stays supervised: a step's label is re-addable. **Dissent risk:** if Todd wants org-owned deletes at supervised, that needs a pre-handler ownership lookup (follow-up).
- **QW3 inbox `convert` / `dismiss` → supervised. Accepted** (W06-D11). The `manage_tickets:create` analogy fails: AI `create` sets no requester, `convert` does.
- **QW4 `bulk_update` single-org. Accepted** (W06-D4).
- **QW5 checklist-template `duplicate`. Not a W06 gap:** it is already `manage_ticket_checklist:duplicate_template` (#6930, route-bound). Recorded (W06-D12).
- **QW6 org-scope category reads / org-owned form writes. Accepted** (Wiring › Scope).
- Preserved as codex asked: artifact org must equal the ticket's org; attachment delete is owner-or-`tickets:manage`.

## Tasks

T1 (this doc + quorum) → T2 guardrail classes → T3 route bindings + permissions → T4 handlers (7 tools + bulk) → T5 wiring (schemas, registry, SDK declarations, `TOOL_TIERS`, rate limits, fencing) + W19 measure → T6 agent catalog → T7 `W06_EXPECTED` class-coverage rows → T8 web `tierConfig.ts` → T9 docs (ai.mdx, mcp-server.mdx) + REMAPs → T10 prompt-size gate → T11 golden prompts (+3) → T12 integration suites (config scope, ticket-ops site scope, guard-flip controls) → T13 merge main, gates, PR, review. Red test first in each task; one commit per task.

## Follow-ups (not filed)

- Extract shared services for categories / forms / response templates so route and tool cannot drift (W06-D9).
- `manage_tickets comment` has no `attachmentIds`; an AI-attached file stays pending until a human posts it.
- Route-style audit rows (`writeRouteAudit`) are not written on the tool paths; the central tool-call audit row is.
- Tier-2 W06 tools over MCP skip the routes' `requireMfa()` where the route has it (inbox convert has none; no t2 W06 action mirrors an MFA route after D1) — recorded for completeness, W02-D11 class.
