---
tracking_issue: LanternOps/breeze#6754
wave: W02 (#6756)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
depends_on: W01 (#6755) merged to main
branch: feature/6754-ai-full-control/wave-6756
---
# AI full control W02: PSA and billing writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the seven PSA and billing write tools into chat and headless agents, so each is tiered, declared and classified. Fix every classification, permission and scope gap found in the per-action review **before** the tool is exposed (spec D2). Rename `manage_catalog` to `manage_billing_catalog` (spec D3).

The seven tools:
- `manage_tickets`
- `manage_quotes`
- `manage_catalog`, renamed `manage_billing_catalog`
- `manage_saved_filters`
- `manage_tags`
- `manage_notification_channels`
- `test_webhook`

**Architecture:**
- **Per-action class review.** Every write action gets a class, recorded in the table below, then encoded in the existing guardrail maps. There is one new mechanism: three `manage_tickets` input-aware arms on the existing `isInputAwareTier3` predicate. They reuse its generic `supervised` resolution in `resolveApprovalScope`.
- **One new agent registry.** `AGENT_HUMAN_ONLY_ACTIONS` goes in `aiToolExposure.ts` (spec D4, W01 amendment WQ5). It holds a single entry, `manage_tags:add`.
- **Pre-exposure fixes.** Each one lands with a red test in the same PR:
  - two RBAC mismatches;
  - two broken input-schema surfaces;
  - one arbitrary-org create;
  - the triage-note input.
- **Wiring is mechanical** and uses W01's `inputShape()` helper and literal `tool()` declarations.

**Tech stack:** TypeScript (Hono API), Zod, Vitest (unit + real-Postgres integration), `@anthropic-ai/claude-agent-sdk` `tool()`, Astro docs, web `tierConfig.ts`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md`. Relevant sections: W02 row, Tier semantics, Class review rule, "Classification concerns already found", Wiring checklist, D1–D5. Where this plan departs from the spec, it says so under "Spec corrections".

**House style and conventions:** those of the W01 plan (`docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w01-guard-and-reads.md`). W02 depends on everything W01 adds:
- `aiToolExposure.ts`: `HUMAN_ONLY_TOOLS`, `AGENT_DENIED_READ_TOOLS`, and `AGENT_HUMAN_ONLY_TOOLS` moved there;
- `isNeverAgentTool`;
- `TIER1_READ_ACTIONS` and `aiGuardrails.tier1WriteActions.contract.test.ts`;
- `inputShape()`;
- the strict `TOOL_TIERS ⊆ declared` contract.

**Tracking:**
1. W02 **branches from `origin/main` after W01's PR merges.** W01 is PR-pending as of 2026-09-23, and W02 must not stack on the W01 branch: a stacked PR runs no CI (CLAUDE.md).
2. Run `get_feature_status LanternOps/breeze#6754`.
3. Cut `feature/6754-ai-full-control/wave-6756` from `origin/main`.
4. Run `start_wave #6756`.
5. Open one PR with `Closes #6756`.

**Verified against** the W01 worktree (`/Users/toddhebebrand/.herdr/worktrees/breeze/wave-6755`, HEAD `a388371883` = `origin/main` `d1cbf4fe27` + W01 lanes A/B). The evidence comes from:
- reading the code;
- `npx tsx` probes over the real registry;
- four parallel per-handler audits.

Line numbers drift, so re-grep before editing. Paths are under `apps/api/src/` unless stated otherwise.

---

## Measured starting state (2026-09-23, W01 worktree)

| Fact | Value | How |
|---|---|---|
| Registry tier (`getToolTier`) | `manage_tickets` 1, `manage_quotes` 2, `manage_catalog` 2, `manage_saved_filters` 1, `manage_tags` 2, `manage_notification_channels` 1, `test_webhook` 2 | tsx probe |
| In `TOOL_TIERS` | none of the 7. All 7 are in `KNOWN_MISSING_TOOL_TIERS` (`aiAgentSdkTools.registryParity.contract.test.ts:106-146`). After W01 that list holds 46; after W02 it holds 39. | grep |
| Reachable over external MCP today | `manage_catalog`, `manage_quotes`, `manage_tags` and `test_webhook` are tier 2 and listed to `ai:write` keys. The three tier-1 multiplexers are also listed (`routes/mcpServer.ts:1162-1168`). | audit |
| Registry `action` enum vs Zod enum | **one mismatch in the whole registry.** `manage_catalog` registry has `set_price` and `remove_price`; Zod does not (`services/aiToolSchemas.ts:541-555`). | tsx probe over every multiplexer |
| Registry JSON properties vs Zod keys | 9 tools differ. The W02 one is `manage_catalog`: `currencyCode`, `price` and `allocationCurrency` are missing from Zod, so `validateToolInput` strips them and `set_bundle_components` with allocations fails. The other 8 are pre-existing (`apply_configuration_policy`, `manage_configuration_policy`, `manage_patches`, `manage_alert_rules`, `manage_monitors`, `sync_huntress_data`, `manage_peripheral_policy`, `search_catalog`). | tsx probe |
| Zod-derived schema size of the 7 (name + description + JSON schema) | **11,733 bytes**: tickets 5,901, quotes 2,056, catalog 1,197, saved_filters 684, notification_channels 862, tags 630, test_webhook 403 | tsx probe (`z.toJSONSchema`) |
| All tools declared on `buildBreezeSdkTools` today, all flags on | 168 tools, 138,248 bytes, so W02 adds about **+8.5 % bytes** | same probe |
| Existing guardrail entries | see the per-tool tables (`aiGuardrails.ts` `TIER2_ACTIONS:58-150`, `TIER1_ACTIONS:216`, `TIER1_READ_ACTIONS:246-275`, `TIER3_ACTIONS:373-393`, `TIER3_FOUR_EYES_ACTIONS:452-460`, `TOOL_PERMISSIONS:819-944,1238,1363,1386-1400`, `TOOL_ACTION_EXTRA_PERMISSIONS:1646`, `TOOL_RATE_LIMITS:1722,1748,1757-1758`) | read |
| Pre-authorisable agent keys (`POLICY_DECIDABLE_TIER3`, `actionIntents/policyDecidableKeys.ts`) | **none of the 7 tools.** Every W02 tier-3 action an agent calls therefore becomes a proposal for a human, and none is pre-authorisable. W02 keeps it that way. | grep |
| `routeBinding` coverage | only `manage_tickets:move_org` (`aiGuardrails.routeBinding.contract.test.ts:297`) | grep |
| Agent principal | `buildAgentAuthContext` issues `scope: 'organization'` (`aiAgents/agentAuthContext.ts:112`). `manage_quotes` and `manage_catalog` refuse anything but partner or system scope (`aiToolsQuotes.ts:77-84`, `aiToolsCatalog.ts:234-241`, `:512`), so they are **structurally inert for agents**. | read |

Re-measure the counts in Task 0. The W01 plan says 225 registered tools, but a probe here printed 255 from `getAllRegisteredToolNames()`, so trust neither without re-running.

---

## Spec corrections (read before implementing)

1. **`manage_catalog` has two unreachable actions, not zero.**
   - `set_price` and `remove_price` are implemented (`aiToolsCatalog.ts:537-548`) and documented (`apps/docs/.../features/mcp-server.mdx:343`).
   - They are denied twice: Zod rejects the enum value, and `TOOL_PERMISSIONS.manage_catalog` has no entry for them. `resolveToolPermissionRequirements` then fails closed with `Unknown action` (`aiGuardrails.ts:2611-2625`).
   - The spec's concern row names `set_price` as if it were live. W02 **wires** both actions (W02-D5) rather than removing them.
2. **Classification is stricter than the spec's concern table** for `manage_tickets`. `comment` is not the only customer-reaching action:
   - `update_status` to `resolved` emails the requester (`jobs/ticketNotifyWorker.ts:682`).
   - `update_fields` can repoint the requester (`submittedBy`, `submitterName`, `submitterEmail`: `aiToolSchemas.ts:325-327`, `ticketService.ts:1411-1440`). A later public comment or resolve then emails an address the model chose.
   - `edit_comment` and `delete_comment` change or remove customer-visible text with no restore path.
   All four are escalated below.
3. **`manage_notification_channels:create` alone does not leak data.** A new channel receives nothing until something routes to it (`notificationDispatcher.ts:338,510,1244`; `resolveDelivery.ts:99`). Routing is `manage_delivery`, which is already tier 3 and supervised. `update` is the real redirect path, because it changes an already-routed destination.
   - The spec's "supervised" is kept for both: `create` because the destination's owner is unverified, `update` because of the redirect.
   - Four-eyes for `update` was considered and rejected (W02-D1).
4. **`manage_notification_channels:test` sends nothing.** The handler is a stub (`aiToolsAlerts.ts:592`); the REST test sends a real message (`routes/alerts/channels.ts:437`). W02-D9.
5. **Catalog class is not "set_price supervised" alone.** `update_item` also writes `unitPrice`, `taxable` and `isActive` (`routes/catalog/catalog.ts:121,130` validator; `catalogService.ts:458`). Contract renewal billing reads the catalog **live**: `generateDueInvoice` → `materializeContractLineOntoInvoice` → `addContractLine` → `resolvePrice` (`contractService.ts:763`, `invoiceService.ts:377-387,461-476`, `catalogService.ts:1120-1160`). So every price-affecting action is supervised, `update_item` included.
6. **Escalating to tier 3 removes the action from external MCP.** MCP denies every effective tier 3 (`isMcpApprovalRequired`, `routes/mcpServer.ts:1011`) until #6158 ships approval over MCP. The spec does not mention this cost. See W02-D6 for the list. **Todd signs off** on it in the PR.
7. **The D3 alias covers external MCP only.** `resolveDeprecatedToolAlias` runs only in `handleToolsCall` (`routes/mcpServer.ts:1317-1322`). Chat, agents, approvals and intents do not resolve aliases. Stored names must be checked instead (Task 9).

## Global constraints

- **Red first in every task.** Write the assertion, run it, see it fail for the stated reason, then implement. A test written after the code is not accepted.
- **Commands** (same as W01):
  - Single file: `cd apps/api && npx vitest run <path>`. The filter is a substring match, so check the printed file count.
  - Never `pnpm --filter <pkg> test -- --run <path>`.
  - Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"`. **Never pipe tsc into `tail`**. Exit code must be 0.
  - Web: `cd apps/web && npx vitest run <path>` and `cd apps/web && pnpm exec astro check`.
  - Integration: `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`, then `pnpm test-stack down`.
- **No new tiers (D1).** Changes go through the existing maps. The one registry-tier change is `test_webhook` 2 → 3 (W02-D4), made in the registry so `TOOL_TIERS` and `getToolTier` move together.
- **Tool never weaker than route (#6096/#6110).** Every W02 write action gets a `routeBinding` row, or an `UNBOUND` entry with a reason.
- **No migrations and no new env vars.** The D3 rename carries no data migration unless Task 9's production count comes back non-zero.
- **Helper allowlist unchanged** (`helperToolFilter.ts`).
- **Hot-file owners:**
  - lane A owns `aiGuardrails.ts`, `aiToolExposure.ts` and the `aiGuardrails.*.contract.test.ts` files;
  - lane B owns `aiToolSchemas.ts` plus the handler files. Lane B runs **serially**, because every B task touches `aiToolSchemas.ts`;
  - lane C owns `aiAgentSdkTools.ts`, `aiAgentSdkTools.registryParity.contract.test.ts`, `aiToolAliases.ts` and `mcpCoverage.ts`.
- **Commit after every task.** End every commit message with:

  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

## Per-tool class review (spec "Class review rule")

Column meanings:
- **Q1–Q4** are the spec's four questions:
  - Q1: reversible within a minute?
  - Q2: leaves the tenant or reaches a person?
  - Q3: blast radius
  - Q4: can an agent grant itself authority?
- **Today** is the class it resolves to now (MCP only; chat cannot reach any of these).
- **W02** is the new class.
- "t2" means tier 2 (user approves unless `auto_approve`).
- "sup" and "4e" are the tier-3 approval scopes.
- "t1-read" means `TIER1_READ_ACTIONS`.

Evidence citations are to `apps/api/src/`.

### `manage_tickets` (registry tier 1; `TOOL_TIERS` 1)

Facts common to every action:
- **Scope parity (every action):** `findTicketWithAccess` (`aiToolsTicketing.ts:204-214`) applies org, then `deviceInSiteScope` on a device-bound ticket. List uses `ticketSiteScopeCondition` plus a sibling-device guard (`:594-601`).
- **Routes:** `routes/tickets/tickets.ts:415-434` (create), `:720` (status), `:674-705` (fields), `:751` (assign), `:828-843` (comment), `:860-887` (edit/delete), `routes/tickets/moveOrg.ts:18-31`.
- **Agent principal:** the handler refuses `create`, `assign` and `update_status` (`aiToolsTicketing.ts:664,731,746`) and forces every comment private through `addAiTriageNote` (`:713-716`).
- **Ticket events** leave Breeze only through partner-configured webhooks (`eventSubscribers.ts:117-121`), which count as tenant plumbing, and through requester email (below). There is **no PSA outbound sync** for Breeze-native tickets.

| Action | Q1 | Q2 (cite) | Q3 | Q4 | Today | **W02** | Scope parity tool / route | RBAC tool / route |
|---|---|---|---|---|---|---|---|---|
| list, get, list_work_types | read | none | org, site-narrowed | no | t1-read | **t1-read** (unchanged) | `:594-601` / `tickets.ts` list; = | tickets:read = |
| create | soft delete needs `tickets:manage` | `ticket.created` goes to webhooks, automations and helpdesk triage (`ticketService.ts:884,892`). No requester email: the tool cannot set a requester. The assignee (staff) gets one. | one ticket | no | t2 | **t2** | = (`tickets.ts:415-434`) | write = |
| comment, `isPublic:false` | soft delete | internal note; no email | one ticket | no | t2 | **t2** | = (`:828-843`) | write =, no MFA on the route |
| comment, `isPublic` missing or true (default true: `aiToolsTicketing.ts:547,722`; REST `packages/shared/src/validators/tickets.ts:156`) | **no**: the email is sent | **yes**: requester email (`ticketNotifyWorker.ts:657-671`), portal-visible (`routes/portal/tickets.ts:371`), stamps `firstResponseAt` (`ticketService.ts:1730`), `ticket.commented` outbox (`:1778,1786`) | one ticket, reaches a person | no | t2 | **sup (input-aware)** | = | write = |
| assign | yes | staff email and in-app (`ticketNotifyWorker.ts:639`); internal | one ticket | no | t2 | **t2** | = (`:751`) | write = |
| update_status to anything but resolved | yes (reopen) | `ticket.status_changed` to webhooks, automations and deliverables (`eventSubscribers.ts:160`) | one ticket | no | t2 | **t2** | = (`:720`) | write = |
| update_status, `status:'resolved'` or any `statusName` | email is sent | **yes**: requester email on `to === 'resolved'` (`ticketNotifyWorker.ts:682`). A custom `statusName` resolves to a base status only through the DB, and guardrails are DB-free, so it fails safe. | one ticket, reaches a person | no | t2 | **sup (input-aware)** | = | write = |
| update_fields without requester keys | yes | `ticket.updated`, which notifies no one (`ticketNotifyWorker.ts:673`) | one ticket | no | t2 | **t2** | = plus a tool device check (`:808`) | write = |
| update_fields with `submittedBy`, `submitterName` or `submitterEmail` | yes, but it arms the next email | redirects every later requester email to a model-chosen address | one ticket | no | t2 | **sup (input-aware)** | = | write = |
| link_alert, unlink_alert | yes | internal system comment (`ticketService.ts:2380,2414`) | one ticket | no | t2 | **t2** | tool **stricter** (`aiToolsAlerts.ts:68` device allowlist) | write = |
| create_from_alert | soft delete | same as create | one ticket | no | t2 | **t2** | = (`routes/alerts.ts:1409`) | write = |
| edit_comment | **no** (old text only in the audit log, `ticketService.ts:2531`) | a public comment's text changes in the portal at once | one comment | no | t2 | **sup** (static: public or private is DB state) | = (`:860-878`) | write = |
| delete_comment | **no** (soft delete, no restore route, `:2552`) | the comment disappears from the portal | one comment | no | t2 | **sup** (static) | = (`:887`) | write = |
| log_time_entry, start_timer, stop_timer | yes (PATCH/DELETE) | none. Unapproved time reaches invoices only as `isUnapprovedTime`, and invoice `issue` is four-eyes (#2551 boundary). | one entry | no | t2 | **t2** (unchanged, #2551) | tool **stricter** (`:1150`) | time_entries:write = |
| link_device | yes | none (sets a null `deviceId` only, `:1021`) | one ticket | no | t2 | **t2** | org + `deviceIdSiteDenied` (`:1015`); no REST twin | `tickets:update`, granted to no role: agent-only, fails closed for humans (`aiGuardrails.ts:839`) |
| draft | yes | `ticket_drafts` only (`:1087`); sending is human-only (`routes/aiDrafts.ts:103`) | one ticket | no | t2 | **t2** | = | as above |
| move_org | yes (move back) | tenant-shape change | ticket + child rows | no | 4e | **4e** (unchanged) | + target `canAccessOrg` / `moveOrg.ts:18-31` | write + organizations:write extra = (MFA: chat is MFA-gated, MCP denies tier 3; `aiGuardrails.ts:1583-1600`) |

**Agent exposure: reachable.** Tier-1 reads skip the allowlist. A device-bound run sees in-site tickets plus **device-less org tickets** (`:594-597`), which carry requester names, emails and ticket text. That is the W01 note's accepted class ("ticket text already reaches agents"), and ticket triage is a core agent job, so this is not denied. It is **flagged for the Opus stand-in quorum** (Task 0b). Writes need the allowlist. Every escalated action becomes a proposal, since no W02 key is pre-authorisable.

**Triage fix required:** `aiAgents/ticketTriageFindings.ts:333` mints `{ action: 'comment', ticketId, content }` with no `isPublic`. Under the new arm, that would escalate every triage note to supervised. Task 7c adds `isPublic: false`, which is truthful because the handler forces private anyway.

### `manage_quotes` (registry tier 2; `TOOL_TIERS` 2)

**Common facts:**
- Scope matches the routes for every action. The tool refuses anything but partner or system scope (`aiToolsQuotes.ts:77-84`); the routes use `requireScope('partner','system')` (`routes/quotes/quotes.ts:43`, `routes/quotes/lifecycle.ts:26`).
- The actor carries `accessibleOrgIds` and `allowedSiteIds` (`aiToolsQuotes.ts:71-80`). The services enforce org and site (`quoteTypes.ts:176-204`).
- No quote route requires MFA.
- Every edit action refuses a non-draft quote (`quoteService.ts:336,358`, `NOT_A_DRAFT` 409), so no draft edit can touch a customer-visible quote.
- Quote bus events (`quote.viewed`, `quote.accepted`, `quote.declined`) go to a queue with **no worker** (`quoteEvents.ts:5-13`). No PSA or webhook subscriber exists.

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W02** | Parity | RBAC tool / route |
|---|---|---|---|---|---|---|---|---|
| create_draft, update, add_block, update_block, delete_block, reorder_blocks, add_manual_line, add_catalog_line, update_line, remove_line, move_line, reorder_lines | yes (drafts only) | no | one draft | no | t2 | **t2** (#2551 drafting boundary) | = | quotes:write = (`quotes.ts:76,259-320`) |
| delete_draft | hard delete (`quoteService.ts:1301`), never-sent draft only | no | one draft | no | t2 | **t2**, a recorded exception to "irreversible means supervised": same class as `manage_invoices`/`manage_contracts:delete_draft` (#2551) | = | write = (`quotes.ts:263`) |
| send | no | **yes**: emails the billing contact and prior recipients (`quoteLifecycle.ts:967,975`), mints a public accept link, supersedes the parent | one quote, reaches people | no | 4e | **4e** (unchanged) | = | quotes:send = (`lifecycle.ts:29,65`) |
| decline | **no** (no reopen; only revise) | records a customer decision on their behalf. No email for `source='msp'` (`quoteOutcomeNotify.ts:37`); enqueues an unconsumed `quote.declined` | one quote | no | t2 | **sup** | the route pre-checks `sent`/`viewed` with `QUOTE_NOT_DECLINABLE` and writes the `quote.declined_on_behalf` audit row with method and reference (`lifecycle.ts:253-275`); the tool does neither (`aiToolsQuotes.ts:510-511`). **GAP**, fixed in Task 7b. | **GAP**: tool quotes:write; route `decline-on-behalf` requires **quotes:accept** (`lifecycle.ts:30,253-254`). Fixed in Task 6. |
| create_pay_link | partly (the Stripe session expires in about 23 h, `invoiceCheckout.ts:31-33`) | **yes**: Stripe `checkout.sessions.create` (`invoiceCheckout.ts:137`) on the partner's connected account. Only for a converted quote (`quotePay.ts:38-43`); it delegates to `createInvoicePayLink` on the converted invoice. | one invoice | no | t2 | **sup** | no staff REST twin (only portal `routes/portal/quotes.ts:334`). The equivalent staff authority is `POST /invoices/:id/pay-link` (`routes/invoices/stripe.ts:26`). | **GAP**: tool quotes:write; the invoice pay-link route requires **invoices:send** (`stripe.ts:19,26`). Fixed in Task 6: `invoices:send`, plus a `quotes:read` extra. |

**Agent exposure: reachable in the catalog, but structurally inert** (org-scope principal, refused by the handler). Pinned by a test (Task 5), so a future partner-scope agent principal reds and forces a decision (W02-D7).

**Follow-up (out of the W02 tool list):** `manage_invoices:create_pay_link` is already tiered at t2 with `invoices:write`, while its route requires `invoices:send` (`stripe.ts:26`). File an issue; fix it in the owning billing wave.

### `manage_billing_catalog`, renamed from `manage_catalog` (registry tier 2; `TOOL_TIERS` 2)

**Common facts:**
- Every write goes through `requirePartner(actor)`. The price book is partner-wide; only the org-override actions are per-org (`catalogService.ts:534,580`).
- The tool refuses anything but partner or system scope (`aiToolsCatalog.ts:512-513` → `:234-241`), matching `requireScope('partner','system')` (`routes/catalog/catalog.ts:21`, `pricing.ts:20`, `bundles.ts:15`).
- No route requires MFA.
- There is no price history: upserts overwrite (`catalogService.ts:269-280,569-573`).
- Invoice, quote and bundle lines snapshot the price when the line is added (`invoiceService.ts:297,334`; `quoteService.ts:1730`). **Contract renewal reads live** (spec correction 5).

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W02** | Parity | RBAC tool / route |
|---|---|---|---|---|---|---|---|---|
| create_item | yes (archive) | no; inert until referenced | partner (inert) | no | t2 | **t2**, a recorded exception to "partner-wide means supervised": a new unreferenced item changes no document and no price | = | catalog:write = (`catalog.ts:54`) |
| update_item | yes if the old value is known; Task 7a returns it | live for renewals when `unitPrice`/`taxable` change; `isActive` flips archive | partner | no | t2 | **sup** | = | write = (`catalog.ts:68`) |
| archive_item | yes (`update_item {isActive:true}`) | future renewals and new lines | partner | no | t2 | **sup** (spec) | = | **GAP**: tool catalog:write (`aiGuardrails.ts:873`); route **catalog:delete** (`catalog.ts:24,75`). Fixed in Task 6. |
| set_price | yes once Task 7a returns `previous` | live for renewals and new lines | partner, one currency | no | **unreachable** (spec correction 1) | **sup** | = (`pricing.ts:70-74`) | none (denied) / write. Task 6 adds catalog:write. |
| remove_price | same | renewals fall back to the contract's stored price; new lines fail `NO_PRICE_FOR_CURRENCY` | partner | no | unreachable | **sup** | = (`pricing.ts:85`) | none / write. Task 6 adds it. |
| set_org_price, remove_org_price | yes once `previous` is returned | live for that org's renewals | one org | no | t2 | **sup** | = (`pricing.ts:33,41`) | write = |
| set_bundle_components | yes once `previous` is returned | new bundle lines only | partner | no | t2 | **sup** | = (`bundles.ts:45`) | write = |

**Why supervised and not four-eyes** (applying the rule "irreversible and partner-wide means four-eyes"): Task 7a makes each price-affecting action **reversible within a minute**. The tool result and the audit event carry the previous value, and the approval description names the item, currency and new price. With that, Q1 becomes "yes", and supervised is the rule's own answer. Without Task 7a, `set_price`, `remove_price` and `set_bundle_components` would be four-eyes. **Task 7a is therefore a precondition of the class, not a nicety.**

**Agent exposure: reachable in the catalog, structurally inert** (org-scope principal), pinned (W02-D7).

### `manage_saved_filters` (registry tier 1; `TOOL_TIERS` 1)

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W02** | Parity | RBAC |
|---|---|---|---|---|---|---|---|---|
| list, get | read | no | org | no | t1-read | **t1-read** | = | devices:read = |
| create | yes (delete) | no; nothing references a filter by id, and dynamic groups copy conditions (`db/schema/devices.ts:512`) | one org object | no | t2 | **t2** | `resolveWritableToolOrgId` (`aiToolsUI.ts:142`) vs `routes/filters.ts:307-327`, = (the tool refuses a multi-org partner with no org; the route asks for `orgId`, so the tool is narrower) | devices:write = (`filters.ts:21,302`) |
| delete | recreate by hand; hard delete (`aiToolsUI.ts:182`, `filters.ts:439`) | no | one inert object | no | t2 | **t2** | orgCondition vs `ensureOrgAccess` (`filters.ts:92`), = | = |

**Agent exposure: reachable** (writes are allowlist-gated).

### `manage_tags` (registry tier 2; `TOOL_TIERS` 2)

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W02** | Parity | RBAC |
|---|---|---|---|---|---|---|---|---|
| list | read | no | org | no | t1 (`TIER1_ACTIONS`) | **t1** | = | devices:read = |
| add | yes | no, but automation targeting reads tags live (`automationRuntime.ts:948,1025-1031`) | one device | **yes, for agents**: `triggers.deviceTags` admits a device into the agent's own run scope (`aiAgents/runResourceScope.ts:48-49`), so tagging a device extends the agent's future reach | t2 | **t2, and `AGENT_HUMAN_ONLY_ACTIONS`** | `verifyDeviceAccess` (`aiToolsDevice.ts:549` → `aiTools.ts:168-189`) vs `PATCH /devices/:id` (`routes/devices/core.ts:1684-1698`), = | devices:write = (route adds MFA; see follow-ups) |
| remove | yes | can take a device out of tag-targeted automation | one device | no (protected tags are already denied by `touchesProtected` on the `tags` key, `aiGuardrails.ts:2040,2466`) | t2 | **t2** | = | = |

`t2` for `add` is a judgment call, flagged for quorum. It is consistent with `manage_groups:add_devices` (t2, `aiGuardrails.ts:127`), which feeds group-targeted policies the same way. **Follow-up:** `manage_groups:add_devices` has the same agent self-scope path through `triggers.deviceGroupIds` (`runResourceScope.ts:50-55`). File an issue so W04 decides it; W02 does not touch that tool.

### `manage_notification_channels` (registry tier 1; `TOOL_TIERS` 1)

**Common facts:**
- Types: email, slack, teams, webhook, pagerduty, sms (`aiToolSchemas.ts:1750`).
- The URL SSRF check is shared with the route (`routes/alerts/helpers.ts:236` → `validateWebhookUrlSafety`, `webhookSender.ts:88`; re-checked at send, `:307`). Email and SMS have no allowlist on either path.
- The tool applies `canMutateOrgWideGovernance` to every non-list action (`aiToolsAlerts.ts:526`), matching the routes (`channels.ts:185,269,373,413`).
- Partner-wide channels can only be edited or deleted with `canManagePartnerWidePolicies` (`aiToolsAlerts.ts:640-660`).
- `list` returns no secrets (`:557-566`).

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W02** | Parity | RBAC |
|---|---|---|---|---|---|---|---|---|
| list | read | no | org | no | t1-read | **t1-read** | = | alerts:read = |
| test | n/a | **no today**: stub (`aiToolsAlerts.ts:592`) | none | no | t2 | **t2**, pinned by a no-outbound test (W02-D9) | = | alerts:write = (`channels.ts:410`) |
| create | yes (delete) | not until routed (spec correction 3); an unverified destination | one org | no | t2 | **sup** (spec) | **GAP**: the tool picks `auth.orgId ?? accessibleOrgIds[0]` (`aiToolsAlerts.ts:606`), an arbitrary org for a multi-org partner; the route takes an explicit `orgId` + `canAccessOrg` (`channels.ts:199-205`). Fixed in Task 7d. | alerts:write = |
| update | only if the old config is known | **yes**: redirects live, already-routed alert data (URL, email, phone) | one channel, or every org if partner-wide | no | t2 | **sup**, with the new destination named in the approval description (W02-D1) | = (`channels.ts:269,286`) | = |
| delete | **no** | alerting goes silent on linked routes | one channel or partner-wide | no | t2 | **sup** | = (`channels.ts:373,385`) | = |

**Agent exposure: reachable.** Every escalated action is a proposal (no pre-authorisable key), so a human sees the destination before anything is redirected. `AGENT_HUMAN_ONLY_ACTIONS` is not needed here, because proposal-only already puts a human in the loop (W02-D2).

### `test_webhook` (registry tier 2 → **3**; `TOOL_TIERS` 3)

| Q1 | Q2 | Q3 | Q4 | Today | **W02** | Parity | RBAC |
|---|---|---|---|---|---|---|---|
| no (the POST is sent) | **yes**: a real outbound POST to the human-configured URL (`aiToolsIntegrations.ts:336`, fixed payload `{test:true,timestamp}` at `:303`) | one endpoint | no | t2 | **sup** (`TIER3_SUPERVISED_TOOLS`), and registry tier 3 (W02-D4) | `canMutateOrgWideGovernance` (`:277`) + orgCondition vs `webhooks.ts:683-690` (`canAccessOrg` + site ceiling), = | **GAP**: tool devices:write (`aiGuardrails.ts:1363`); route **organizations:write + MFA** (`webhooks.ts:683-684`). Fixed in Task 6. |

**Agent exposure: reachable** as a proposal.

### Existing entries, and whether they change

| Map | Entry today | W02 |
|---|---|---|
| `TIER2_ACTIONS.manage_tickets` | 16 writes | remove `edit_comment`, `delete_comment` (moved to tier 3). `comment`, `update_status` and `update_fields` stay: their base class is t2 and the input-aware arm escalates on top. |
| `TIER3_ACTIONS.manage_tickets` / `TIER3_FOUR_EYES_ACTIONS` | `move_org` / `move_org` | + `edit_comment`, `delete_comment` → `TIER3_SUPERVISED_ACTIONS` |
| `TIER3_INPUT_AWARE_ACTIONS` | 3 pairs | + `manage_tickets:comment`, `manage_tickets:update_status`, `manage_tickets:update_fields` |
| `TIER3_ACTIONS.manage_quotes` | `send` (4e) | + `decline`, `create_pay_link` → supervised |
| `TIER3_ACTIONS.manage_billing_catalog` | none | `update_item`, `archive_item`, `set_price`, `remove_price`, `set_org_price`, `remove_org_price`, `set_bundle_components` → supervised |
| `TIER2_ACTIONS.manage_notification_channels` | test, create, update, delete | keep `test`. Move create/update/delete to `TIER3_ACTIONS` + supervised. |
| `TIER2_ACTIONS.manage_saved_filters` | create, delete | unchanged |
| `TIER1_ACTIONS.manage_tags` | list | unchanged |
| `TIER3_SUPERVISED_TOOLS` | — | + `test_webhook` |
| `TOOL_PERMISSIONS` | see the tables | see Task 6 |
| `TOOL_RATE_LIMITS` | tags 20/300, saved_filters 15/300, notification_channels 10/300, test_webhook 5/300 | unchanged. **None added** for tickets, quotes or catalog (W02-D8). |
| Four-eyes fallback moved to supervised | — | **none.** No W02 action was an unclassified tier 3 falling back to four-eyes; `test_webhook` was tier 2, not tier 3. **No loosening in this wave.** |

---

## Decisions this plan makes (W02-D1 … W02-D11)

These are consequential (a new registry, a public rename, MCP surface loss). **The Opus stand-in quorum (spec Risks) reviews this whole class table before Task 1 starts** (Task 0b). Codex is unavailable until 2026-09-26.

- **W02-D1: classes are exactly the tables above.**
  - `manage_notification_channels:update` is **supervised, not four-eyes.** The approving human sees the new destination: the description renders the URL host, email count or phone count. `manage_delivery` routing, which redirects the same alert data, is supervised today (`aiGuardrails.ts:589`), so four-eyes here alone would be incoherent.
  - The audit agent's four-eyes recommendation is recorded here as rejected, with this reason.
- **W02-D2: `AGENT_HUMAN_ONLY_ACTIONS` (new, `aiToolExposure.ts`) = `{ 'manage_tags:add' }`.**
  - Spec D4 action-level denial for question 4: an allowlisted t2 `add` executes unattended and can widen the agent's own `triggers.deviceTags` scope.
  - Enforced in `checkAgentGuardrails` directly after the `isNeverAgentTool` deny.
  - Excluded from the picker's action keys.
  - `validateAuthorizationKeys` already rejects it, since it is not in `POLICY_DECIDABLE_TIER3`.
  - Notification channel writes are **not** listed: they are proposal-only for agents, and that already puts a human in the loop.
- **W02-D3: rename `manage_catalog` → `manage_billing_catalog` in the registry.**
  - Add `['manage_catalog', 'manage_billing_catalog']` to `DEPRECATED_TOOL_ALIASES` (`services/aiToolAliases.ts:34`) with "remove one release after v0.117 ships".
  - The alias dispatches over MCP only and is never listed (`aiToolAliases.ts` header). Audit rows carry `requestedToolName` and `deprecatedToolAlias` (`mcpServer.ts:1572,1803-1805`).
  - `search_catalog` and `get_catalog_item` keep their names: they are already tiered and in the golden set. Renaming them is a separate decision, noted as a follow-up.
- **W02-D4: `test_webhook` becomes registry tier 3, supervised** (D1: the fix goes in the registry).
  - Its route mutates and requires MFA (`webhooks.ts:683-684`), and the invariant at `aiGuardrails.ts:~1600` says "Tier 3 if the route mutates".
  - It sends a real outbound POST, and "nothing that leaves the tenant may be tier 2".
- **W02-D5: wire `manage_billing_catalog:set_price`/`remove_price`.**
  - They are implemented and documented; only the Zod enum and permission map are missing.
  - Add the enum members plus `currencyCode`, `price` and `allocationCurrency` to Zod (the last also fixes `set_bundle_components`).
  - Class: supervised.
- **W02-D6: accept the MCP surface loss (spec correction 6); Todd signs off in the PR.** These become MCP-denied until #6158:
  - `manage_tickets`: `comment` unless `isPublic:false`, `update_status` to resolved or any `statusName`, `update_fields` with requester keys, `edit_comment`, `delete_comment`;
  - `manage_quotes`: `decline`, `create_pay_link`;
  - `manage_billing_catalog`: everything except `create_item`;
  - `manage_notification_channels`: `create`, `update`, `delete`;
  - `test_webhook`: the whole tool, which MCP `tools/list` then stops advertising (`isToolWhollyGatedOverMcp`).
- **W02-D7: quotes and the billing catalog stay agent-catalog-reachable but inert.** No new deny class. A unit test pins that an `ai_agent` principal (org scope) gets the partner-scope refusal from both handlers.
- **W02-D8: no new rate limits.** Every vendor- or customer-touching action in these tools is now tier 3, so a human approves each one. A per-tool counter on `manage_quotes` would block normal drafting: one quote is dozens of line calls.
- **W02-D9: `manage_notification_channels:test` stays t2 while it is a stub.** A unit test asserts that the handler performs no outbound call (no `sendNotification`/`safeFetch`/email service import reached). Making it real then reds the test and forces reclassification.
- **W02-D10: prompt budget gate (spec D5).** Turn-1 prompt delta must be ≤ **+8,000 tokens** against post-W01 main on `chat` and `agent-full`, measured with the A-W01 harness (Task 14).
  - Offline estimate, **inferred**: +11.7 KB of JSON schema, likely about 3–4k tokens.
  - If it is exceeded, the PR waits for A-W04.
- **W02-D11: every W02 write action gets a `routeBinding` row or an `UNBOUND` reason** (Task 6). Where the tool cannot match route MFA (tier-2 tools over MCP), this is recorded, not fixed. See follow-ups.

---

## Task graph and parallelism

```
Task 0 (branch, baseline) ─► Task 0b (Opus quorum on the class table; fold changes in)
Lane A (aiGuardrails*, aiToolExposure):   T1 ─► T2 ─► T3 ─► T6 ────────────────────► T11
Lane B (aiToolSchemas + handlers, SERIAL):   T7a ─► T7b ─► T7c ─► T7d ─► T7e
Lane C (aiAgentSdkTools*, aliases):          T4 ─► T5 ──────────► (after A+B) T8 ─► T9 ─► T10
Lane D (web / docs; after T8):                                            T12 │ T13
Integration (authored with T7, run after T8):                             T15
Serial tail:                                                              T14 ─► T16
```

- **Round 1 (parallel):**
  - lane A: T1 → T2 → T3 → T6;
  - lane B, serially: T7a–T7e;
  - lane C: T4, T5.
- **Round 2 (serial, lane C):** T8 wiring, only after T3, T6 and every T7 have merged (spec D2). Then T9 (rename and alias) and T10 (catalog snapshot).
- **Round 3 (parallel):** T11, T12, T13, T15.
- **Round 4:** T14, then T16.

---

## Task 0: Branch, baseline, lifecycle

- [ ] Confirm W01's PR is **merged** (`gh pr list --search "6755" --state merged`). If it is not merged, stop. Do not stack.
- [ ] `get_feature_status LanternOps/breeze#6754`, then `git fetch origin && git switch -c feature/6754-ai-full-control/wave-6756 origin/main`, then `start_wave #6756`.
- [ ] Baseline:

  ```bash
  cd apps/api && npx vitest run src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiGuardrails src/services/aiAgents/agentToolCatalog src/services/aiTools.outputBudget.contract.test.ts src/services/llm/toolEval/goldenPrompts.test.ts src/routes/mcpServer.deprecatedAlias.test.ts src/services/aiToolAliases.test.ts
  ```

  Expected: green. Record in the PR body:
  - `KNOWN_MISSING_TOOL_TIERS` size (expect 46);
  - `TOOL_TIERS` size (expect 210);
  - `getAllRegisteredToolNames().length`.

## Task 0b: Opus stand-in quorum on the class table

- [ ] Dispatch one Opus reviewer with:
  - this plan's "Per-tool class review" section;
  - the spec's Class review rule;
  - read access to the cited files.

  Ask for AGREE / AGREE WITH CHANGES / DISAGREE per decision (W02-D1…D11), plus any action it would class differently, with file:line.
- [ ] Fold in accepted changes and record the verdict under a `## Quorum amendments` heading in this plan, as W01 did. **Blocking:** no task that edits a class map (T1–T3, T6) starts before this.

## Task 1: `manage_tickets` input-aware arms (lane A)

**Files:**
- modify `aiGuardrails.ts`: `isInputAwareTier3`, `TIER3_INPUT_AWARE_ACTIONS`, `buildApprovalDescription`
- modify `aiGuardrails.approvalScope.contract.test.ts`

- [ ] **Red.** In `aiGuardrails.approvalScope.contract.test.ts`, add a describe `manage_tickets input-aware escalation (W02, #6756)` with both branches of every arm through `checkGuardrails`:

  ```ts
  const tier = (input: Record<string, unknown>) => checkGuardrails('manage_tickets', input);
  it.each([
    [{ action: 'comment', ticketId: T, content: 'x' }, 3, 'supervised'],              // default isPublic = true
    [{ action: 'comment', ticketId: T, content: 'x', isPublic: true }, 3, 'supervised'],
    [{ action: 'comment', ticketId: T, content: 'x', isPublic: false }, 2, undefined],
    [{ action: 'comment', ticketId: T, content: 'x', isPublic: 'false' }, 3, 'supervised'], // non-boolean fails safe
    [{ action: 'update_status', ticketId: T, status: 'resolved' }, 3, 'supervised'],
    [{ action: 'update_status', ticketId: T, statusName: 'Done' }, 3, 'supervised'],     // custom status: DB-resolved, fail safe
    [{ action: 'update_status', ticketId: T, status: 'in_progress' }, 2, undefined],
    [{ action: 'update_fields', ticketId: T, fields: { submitterEmail: 'a@b.c' } }, 3, 'supervised'],
    [{ action: 'update_fields', ticketId: T, fields: { submittedBy: null } }, 3, 'supervised'],
    [{ action: 'update_fields', ticketId: T, fields: { priority: 'high' } }, 2, undefined],
    [{ action: 'list' , isPublic: true }, 1, undefined],                                  // a read is never escalated
  ])('%j → tier %i (%s)', (input, t, scope) => {
    const r = tier(input);
    expect(r.tier).toBe(t);
    expect((r as { approvalScope?: string }).approvalScope).toBe(scope);
  });
  it('the three pairs are exempt from the static per-action tables', () => {
    for (const a of ['comment', 'update_status', 'update_fields']) {
      expect(TIER3_INPUT_AWARE_ACTIONS.has(`manage_tickets:${a}`)).toBe(true);
      expect(TIER3_SUPERVISED_ACTIONS.manage_tickets ?? []).not.toContain(a);
      expect(TIER3_FOUR_EYES_ACTIONS.manage_tickets ?? []).not.toContain(a);
    }
  });
  it('approval description says PUBLIC for a public comment and internal for a note', () => {
    expect(tier({ action: 'comment', ticketId: T, content: 'x' }).description).toMatch(/public.*emails the requester/i);
    expect(tier({ action: 'comment', ticketId: T, content: 'x', isPublic: false }).description).toMatch(/internal note/i);
  });
  ```

  Run `cd apps/api && npx vitest run src/services/aiGuardrails.approvalScope.contract.test.ts`. Expected: FAIL. The public cases resolve tier 2, and the description reads "Post private AI triage note" (`aiGuardrails.ts:2858`).
- [ ] **Green.**
  - Add a `manage_tickets` arm at the top of `isInputAwareTier3`:

    ```ts
    const TICKET_REQUESTER_FIELD_KEYS = ['submittedBy', 'submitterName', 'submitterEmail'] as const;
    if (toolName === 'manage_tickets') {
      if (action === 'comment') return input.isPublic !== false;       // matches the handler's default (aiToolsTicketing.ts:722)
      if (action === 'update_status') return input.status === 'resolved' || input.statusName !== undefined;
      if (action === 'update_fields') {
        const f = input.fields;
        return typeof f === 'object' && f !== null && TICKET_REQUESTER_FIELD_KEYS.some((k) => Object.hasOwn(f, k));
      }
      return false;
    }
    ```

    Update the function's doc comment to list the new arms with their evidence: requester email `ticketNotifyWorker.ts:657,682`; requester redirect `aiToolSchemas.ts:325-327`.
  - Add the three pairs to `TIER3_INPUT_AWARE_ACTIONS`. `resolveApprovalScope`'s existing `isInputAwareTier3 → 'supervised'` branch then resolves them without a new override. Add one sentence to that comment saying it also covers `manage_tickets`.
  - Fix the `comment` branch of `buildApprovalDescription`:
    - `isPublic === false` → `Post internal note on ticket #…`;
    - otherwise → `Post PUBLIC comment on ticket #… (customer-visible; emails the requester)`.

    Add `update_status` (`→ resolved: emails the requester`) and `update_fields` requester-key wording. Never render comment content (the P2-5 rule at `:2862`).

  Re-run the file plus `aiGuardrails.test.ts` and `aiGuardrails.tier1WriteActions.contract.test.ts`. Expected: PASS.
- [ ] Commit: `feat(ai-guardrails): public ticket comments, resolves and requester edits require approval (#6756)`.

## Task 2: Static class changes (lane A)

**Files:**
- `aiGuardrails.ts`
- `aiGuardrails.approvalScope.contract.test.ts`
- `aiGuardrails.test.ts`

- [ ] **Red.** Add a pinned table test, `W02 static classes (#6756)`, asserting `checkGuardrails(tool, { action })` tier and scope for:
  - `manage_tickets` `edit_comment`, `delete_comment` → 3/supervised; `move_org` → 3/four_eyes; `create`, `assign`, `log_time_entry`, `link_device`, `draft` → 2;
  - `manage_quotes` `decline`, `create_pay_link` → 3/supervised; `send` → 3/four_eyes; `create_draft`, `delete_draft`, `add_catalog_line` → 2;
  - `manage_catalog` (still the old name here; Task 9 renames it) `update_item`, `archive_item`, `set_price`, `remove_price`, `set_org_price`, `remove_org_price`, `set_bundle_components` → 3/supervised; `create_item` → 2;
  - `manage_notification_channels` `create`, `update`, `delete` → 3/supervised; `test` → 2; `list` → 1;
  - `manage_saved_filters` `create`, `delete` → 2; `manage_tags` `add`, `remove` → 2, `list` → 1.

  Run it. Expected: FAIL on every newly escalated row.
- [ ] **Green.** Edit the maps per the "Existing entries" table. Comments must cite the evidence:
  - `edit_comment`/`delete_comment`: "no restore; a public comment's text changes or disappears in the portal (ticketService.ts:2531,2552)";
  - quotes: `decline` "records the customer's decision; route requires quotes:accept", `create_pay_link` "Stripe Checkout session";
  - catalog: "contract renewals read the price book live (contractService.ts:763 → catalogService.ts:1120)";
  - channels: "update redirects live routed alert data; delete silences linked routes".

  Remove `edit_comment`/`delete_comment` from `TIER2_ACTIONS.manage_tickets`. Remove `create`/`update`/`delete` from `TIER2_ACTIONS.manage_notification_channels`. Keep `test`.
- [ ] Run:

  ```bash
  cd apps/api && npx vitest run src/services/aiGuardrails.approvalScope.contract.test.ts src/services/aiGuardrails.tier1WriteActions.contract.test.ts src/services/aiGuardrails.readonly.contract.test.ts src/services/aiGuardrails.test.ts src/routes/mcpServer
  ```

  Expected: PASS. If an `mcpServer` test asserts that one of these actions is callable over MCP, it now reds by design (W02-D6). Update it to expect `MCP_APPROVAL_REQUIRED` and list it in the PR.
- [ ] Commit: `feat(ai-guardrails): classify PSA/billing write actions (W02 class review) (#6756)`.

## Task 3: `AGENT_HUMAN_ONLY_ACTIONS` (lane A)

**Files:**
- `aiToolExposure.ts`
- `aiGuardrails.ts` (`checkAgentGuardrails`, re-export)
- `aiGuardrails.agentPrincipal.contract.test.ts`
- `aiAgents/agentToolCatalog.ts` (picker action keys, if the picker enumerates `tool:action`; grep `toolActionEnum` in `aiAgents/`)

- [ ] **Red.** In `aiGuardrails.agentPrincipal.contract.test.ts`:
  - `AGENT_HUMAN_ONLY_ACTIONS` equals exactly `['manage_tags:add']`, each entry with a reason of at least 20 characters;
  - every key names a real registry action (`toolActionEnum`);
  - no key's tool is already in `isNeverAgentTool`;
  - `checkAgentGuardrails('manage_tags', { action: 'add', deviceId: D, tags: ['x'] }, policy)` with `toolAllowlist: ['manage_tags', 'manage_tags:add']` → `deny`, reason `/never available to agents/`;
  - **control:** the same call with `action: 'remove'` → **not** `deny` for the human-only reason. It is allowlisted, so it resolves to its normal disposition (`allow`/`propose` by mode).

  Run it. Expected: FAIL, import missing.
- [ ] **Green.**
  - In `aiToolExposure.ts` (no imports):

    ```ts
    /** Single ACTIONS of an otherwise agent-reachable tool that a headless agent may never call (spec D4 action-level; question 4). */
    export const AGENT_HUMAN_ONLY_ACTIONS: ReadonlyMap<string, string> = new Map([
      ['manage_tags:add', 'Device tags feed the agent\'s own run scope (triggers.deviceTags, runResourceScope.ts): an allowlisted tier-2 add would let an agent widen its future reach unattended.'],
    ]);
    ```

  - In `checkAgentGuardrails`, after the `isNeverAgentTool` deny and after `action` resolves (before the multiplexed-action deny is fine):

    `if (action !== undefined && AGENT_HUMAN_ONLY_ACTIONS.has(\`${toolName}:${action}\`)) return deny(\`Action "${toolName}:${action}" is human-only and never available to agents\`);`

  - Re-export it from `aiGuardrails.ts`.
  - If the capability picker lists `tool:action` keys, filter these out there too, and add the matching assertion to `agentToolCatalog.contract.test.ts`.
- [ ] Run both files. Expected: PASS.
- [ ] Commit: `feat(ai-agents): AGENT_HUMAN_ONLY_ACTIONS — agents may never add device tags (self-scope) (#6756)`.

## Task 4: Contract, registry and Zod input surfaces agree for every tiered tool (lane C)

**Files:** modify `aiToolsRegistryParity.test.ts`, which already requires a schema per tool.

- [ ] **Red.** Add:

  ```ts
  /** Frozen 2026-09-23: pre-existing registry-vs-Zod key mismatches, each tracked by <issue filed in Task 16>. Only shrinks. */
  const KNOWN_INPUT_SURFACE_DRIFT = new Set(['apply_configuration_policy','manage_configuration_policy','manage_patches','manage_alert_rules','manage_monitors','sync_huntress_data','manage_peripheral_policy','search_catalog']);
  it('registry input_schema properties and action enum equal the Zod shape (what the model sees == what validateToolInput keeps)', () => {
    const drift = getAllRegisteredToolNames().filter((t) => !KNOWN_INPUT_SURFACE_DRIFT.has(t)).flatMap((t) => {
      const props = Object.keys((aiTools.get(t)!.definition.input_schema as any).properties ?? {}).sort();
      const shape = (toolInputSchemas[t] as any)?.shape; if (!shape) return [];
      const keys = Object.keys(shape).sort();
      const regEnum = toolActionEnum(t); const zEnum = shape.action?.options ?? shape.action?.unwrap?.()?.options;
      return [
        ...(JSON.stringify(props) !== JSON.stringify(keys) ? [`${t}: keys registry=${props} zod=${keys}`] : []),
        ...(regEnum && zEnum && JSON.stringify([...regEnum].sort()) !== JSON.stringify([...zEnum].sort()) ? [`${t}: action enum differs`] : []),
      ];
    });
    expect(drift).toEqual([]);
  });
  it('KNOWN_INPUT_SURFACE_DRIFT has no stale entries', () => { /* each entry still drifts */ });
  ```

  Run `cd apps/api && npx vitest run src/services/aiToolsRegistryParity.test.ts`. Expected: FAIL with exactly `manage_catalog` (keys and enum). **That is the control.**
- [ ] Do not fix it here. Task 7a fixes the schema, and this commit lands together with 7a's fix (the same rule as W01 T2/T5: never commit a red suite alone).

## Task 5: Agent-inertness pins for quotes and catalog (lane C, unit)

**Files:**
- `aiToolsQuotes.test.ts`
- `aiToolsCatalog.test.ts`

- [ ] **Red → green (pin).** For each handler, an auth built like `buildAgentAuthContext` (`scope: 'organization'`, an agent run id) gets the partner-scope refusal JSON and never reaches the service mock. It passes on the first run, because it pins existing behavior. So first **invert the scope in the fixture to `'partner'`**, watch the assertion red, then restore. Name the test `agent principals are structurally inert (W02-D7) — a partner-scope agent principal needs a class decision first`.
- [ ] Commit: `test(ai-tools): pin quotes/catalog as inert for org-scoped agent principals (#6756)`.

## Task 6: Permission parity and route bindings (lane A)

**Files:**
- `aiGuardrails.ts` (`TOOL_PERMISSIONS`, `TOOL_ACTION_EXTRA_PERMISSIONS`)
- `aiGuardrails.routeBinding.contract.test.ts`
- `aiGuardrails.routeParity.contract.test.ts`

- [ ] **Red.** Add `Binding` rows (the binder throws on an unknown path, so fix the path from the route file, never drop the row):

  | Tool:action | Route file, method, path | Expect |
  |---|---|---|
  | manage_tickets:create | `tickets/tickets.ts` POST `/` | = |
  | manage_tickets:comment | `tickets/tickets.ts` POST `/:id/comments` | = |
  | manage_tickets:assign / update_status / update_fields | the `:751` / `:720` / `:674` routes | = |
  | manage_tickets:edit_comment / delete_comment | `:860` / `:887` | = |
  | manage_tickets:link_alert / unlink_alert | `:912-954` | = |
  | manage_tickets:create_from_alert | `alerts.ts` (`:1409`) | = |
  | manage_tickets:log_time_entry / start_timer / stop_timer | `timeEntries.ts` `:223` / `:156` / `:167` | = |
  | manage_tickets:draft | `aiDrafts.ts` (`:47`) | `toolOnly` reason: `tickets:update` is deliberately agent-only (`aiGuardrails.ts:831-839`) |
  | manage_tickets:link_device | none | `UNBOUND`: agent-only triage executor, no REST twin |
  | manage_quotes: every draft action | `quotes/quotes.ts` (`:76`, `:259-320`) | = |
  | manage_quotes:send | `quotes/lifecycle.ts` POST `/:id/send` | = |
  | manage_quotes:decline | `quotes/lifecycle.ts` POST `/:id/decline-on-behalf` | **red** (write vs accept) |
  | manage_quotes:create_pay_link | `invoices/stripe.ts` POST `/:id/pay-link` | **red** (quotes:write vs invoices:send) |
  | manage_catalog:create_item / update_item | `catalog/catalog.ts` POST `/`, PATCH `/:id` | = |
  | manage_catalog:archive_item | `catalog/catalog.ts` POST `/:id/archive` | **red** (write vs delete) |
  | manage_catalog:set_price / remove_price | `catalog/pricing.ts` (`:70`, `:85`) | **red** (unmapped action) |
  | manage_catalog:set_org_price / remove_org_price | `catalog/pricing.ts` (`:33`, `:41`) | = |
  | manage_catalog:set_bundle_components | `catalog/bundles.ts` (`:45`) | = |
  | manage_saved_filters:create / delete | `filters.ts` POST `/`, DELETE `/:id` | = |
  | manage_tags:add / remove | `devices/core.ts` PATCH `/:id` | = |
  | manage_notification_channels:create / update / delete / test | `alerts/channels.ts` (`:180`, `:265`, `:370`, `:410`) | = |
  | test_webhook | `webhooks.ts` POST `/:id/test` | **red** (devices:write vs organizations:write) |

  Run `cd apps/api && npx vitest run src/services/aiGuardrails.routeBinding.contract.test.ts`. Expected: FAIL for exactly the five red rows. Any other red is a new gap: add it to the class table, fix it here, and note it in the PR.
- [ ] **Green.** Make these `TOOL_PERMISSIONS` edits, each with a route citation:
  - `manage_quotes.decline` → `{ quotes, accept }` (`lifecycle.ts:30,253`);
  - `manage_quotes.create_pay_link` → `{ invoices, send }` (`stripe.ts:19,26`), plus `TOOL_ACTION_EXTRA_PERMISSIONS.manage_quotes.create_pay_link = [{ quotes, read }]`;
  - `manage_catalog.archive_item` → `{ catalog, delete }` (`catalog.ts:24,75`);
  - add `set_price` and `remove_price` as `{ catalog, write }` (`pricing.ts`);
  - `test_webhook` → `{ organizations, write }` (`webhooks.ts:683`).

  In `routeParity.contract.test.ts`, add one `allows(...)` pair per changed entry, each in both directions (the old grant alone is refused; the route's grant is allowed).

  **The PR must say:**
  - a role with `quotes:write` but not `quotes:accept` loses AI decline;
  - `quotes:write` without `invoices:send` loses AI quote pay links;
  - `catalog:write` without `catalog:delete` loses AI archive;
  - `devices:write` without `organizations:write` loses AI webhook tests.

  All four now match the UI.
- [ ] Update `apps/web/src/components/ai-risk/tierConfig.ts`'s permission map to mirror (`manage_notification_channels` gains `create`/`update`/`delete: 'alerts.write'`; `test_webhook: 'organizations.write'`; add quote and catalog maps).
- [ ] Run:

  ```bash
  cd apps/api && npx vitest run src/services/aiGuardrails.routeBinding.contract.test.ts src/services/aiGuardrails.routeParity.contract.test.ts src/services/aiGuardrails.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts
  ```

  Expected: PASS.
- [ ] Commit: `fix(ai-guardrails): W02 write tools require exactly their route's permission (#6756)`.

## Task 7: Handler fixes before exposure (lane B, serial; one commit each)

Each subtask follows the same shape:
1. Add a co-located unit test using the file's harness (`breeze-testing` skill).
2. Run it red.
3. Fix.
4. Run it green.
5. Commit.

- [ ] **7a `aiToolsCatalog.ts` + `aiToolSchemas.ts` (catalog surfaces and reversibility; W02-D5).**
  - Red, in `aiToolsCatalog.manageCatalog.test.ts`:
    - `toolInputSchemas.manage_catalog.parse({ action: 'set_price', catalogId, currencyCode: 'EUR', price: { unitPrice: 10 } })` keeps all four keys;
    - `set_bundle_components` keeps `allocationCurrency`;
    - `set_price`, `set_org_price`, `remove_price`, `remove_org_price`, `update_item` and `set_bundle_components` results include `previous` (the prior row or `null`), read inside the same service transaction, or immediately before the write with the same actor.
  - Fix:
    - add the two enum members and the three keys to the Zod schema, matching the registry descriptions (`aiToolsCatalog.ts:493-507`);
    - add `previous` to each handler branch's JSON;
    - make the audit event carry `{ previous, next }`.

    Task 4's red goes green in this commit.
  - Commit: `fix(ai-tools): billing catalog — wire set_price/remove_price, keep allocationCurrency, return the previous value (#6756)`.
- [ ] **7b `aiToolsQuotes.ts` + schema (decline parity).**
  - Red, in `aiToolsQuotes.test.ts`:
    - `decline` on a `draft` quote returns `QUOTE_NOT_DECLINABLE` and never calls `declineQuoteByActor`;
    - `decline` without `method`/`reference` returns a validation error;
    - a valid decline writes a `quote.declined_on_behalf` audit event with `{ method, reference, reason }` (assert on the `writeAuditEvent` mock).
  - Fix:
    - add `method` (enum `QUOTE_ACCEPT_ON_BEHALF_METHODS` from `packages/shared/src/validators/quotes.ts`) and `reference` (1–500 characters) to the registry JSON schema and to Zod; `decline` requires both (`MANAGE_QUOTES_REQUIRED`, `aiToolsQuotes.ts:109`);
    - mirror the route's pre-check and message (`lifecycle.ts:259-266`);
    - write `declinedOnBehalfAuditEvent(...)` through `writeAuditEvent(requestLikeFromSnapshot(...))`, exactly as `send` writes its audit (`aiToolsQuotes.ts:465-509`).
  - Commit: `fix(ai-tools): quote decline records method/reference and refuses non-sent quotes like the route (#6756)`.
- [ ] **7c `aiAgents/ticketTriageFindings.ts` (triage note stays tier 2).**
  - Red, in `ticketTriageFindings.test.ts`: the `note` candidate's `toolInput` has `isPublic: false`, and `checkGuardrails('manage_tickets', note.toolInput).tier === 2`. The second half reds after Task 1 lands, which is why lane B runs after lane A's T1.
  - Fix: add `isPublic: false` at `:333`, with the comment "truthful: the handler forces every agent comment private (aiToolsTicketing.ts:713-716); explicit so the W02 public-comment escalation does not apply".
  - Also check `actionIntents/revalidateRelease.ts`. A triage intent minted **before** deploy, with no `isPublic`, re-resolves to tier 3 on release. Decide between accepting that (it then needs a human click; the handler still forces private) and a one-line release shim. Record the choice in the PR, with a test for the chosen behavior.
  - Commit: `fix(ai-agents): triage notes carry isPublic:false so they stay tier 2 (#6756)`.
- [ ] **7d `aiToolsAlerts.ts` + schema (channel create org).**
  - Red: a partner auth with `accessibleOrgIds: [A, B]`, `orgId: null`, and `create` without `orgId` returns `orgId is required`. With `orgId: C` (not accessible) it returns access denied. With `orgId: B` it inserts into B.
  - Fix:
    - add optional `orgId` to the registry schema and Zod;
    - replace `auth.orgId ?? auth.accessibleOrgIds?.[0]` (`:606`) with `resolveWritableToolOrgId(auth, input.orgId)` (`aiTools.ts:257`).
  - Also add the W02-D9 pin: the `test` branch does not import or call any sender. Assert on mocks of `notificationDispatcher`/`webhookSender`/the email service: zero calls.
  - Update `buildApprovalDescription` for channel `create`/`update` to name the type and destination host, or recipient count for email/SMS. That code is in `aiGuardrails.ts`, so hand the one-line change to lane A. Lane B writes the test first.
  - Commit: `fix(ai-tools): notification channel create takes an explicit org like the route (#6756)`.
- [ ] **7e `aiToolsIntegrations.ts` (`test_webhook` registry tier).**
  - Red: `getToolTier('test_webhook') === 3` and `resolveApprovalScope('test_webhook', undefined, {}) === 'supervised'`.
  - Fix: registry `tier: 3`. Lane A adds `test_webhook` to `TIER3_SUPERVISED_TOOLS`; land the two together. Update the stale `RATE_LIMIT_CONFIGS` tier in `tierConfig.ts` (`:367`) to 3.
  - Commit: `feat(ai-tools): test_webhook sends a real outbound POST — tier 3 supervised (#6756)`.

After 7a–7e, run:

```bash
cd apps/api && npx vitest run src/services/aiToolsCatalog src/services/aiToolsQuotes src/services/aiAgents/ticketTriageFindings src/services/aiToolsAlerts src/services/aiToolsIntegrations src/services/aiToolsRegistryParity.test.ts src/services/aiToolsSiteScope.contract.test.ts src/services/aiGuardrails
```

Expected: PASS, with no site-scope baseline widened.

## Task 8: Wire the seven tools (lane C; serial; after T1–T3, T6, T7)

**Files:**
- `aiAgentSdkTools.ts` (`TOOL_TIERS` plus declarations)
- `aiAgentSdkTools.registryParity.contract.test.ts`

- [ ] **Red.** Add:

  ```ts
  /** Spec 2026-09-23 W02 (#6756): PSA and billing writes. Pinned so a later wave cannot silently un-wire one. */
  const W02_WRITE_TOOLS = ['manage_tickets','manage_quotes','manage_catalog','manage_saved_filters','manage_tags','manage_notification_channels','test_webhook'] as const;
  describe('W02 write wiring (#6756)', () => {
    it.each(W02_WRITE_TOOLS)('%s: TOOL_TIERS === getToolTier, declared, SDK shape keys === toolInputSchemas', (name) => {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(getToolTier(name));
      const decl = declaredToolsByName().get(name);
      expect(decl, `${name} not declared`).toBeDefined();
      expect(Object.keys(decl!.inputSchema).sort()).toEqual(Object.keys((toolInputSchemas[name] as any).shape).sort());
    });
  });
  ```

  Task 9 changes `manage_catalog` to `manage_billing_catalog` in this list. Run it. Expected: 7 failures.
- [ ] **Green**, in one commit:
  - `TOOL_TIERS` entries under `// Spec 2026-09-23 W02 (#6756): PSA/billing writes`: `manage_tickets: 1, manage_quotes: 2, manage_catalog: 2, manage_saved_filters: 1, manage_tags: 2, manage_notification_channels: 1, test_webhook: 3`;
  - literal `tool('<name>', registryDescription('<name>'), inputShape('<name>'), makeHandler(...))` declarations next to their siblings (tickets near the time-entry reads, quotes and catalog near `manage_invoices`, and so on);
  - delete the seven names from `KNOWN_MISSING_TOOL_TIERS`, which the stale-entry test forces;
  - update the docstring: "W02 wired 7; 39 remain".
- [ ] Run:

  ```bash
  cd apps/api && npx vitest run src/services/aiAgentSdkTools src/services/aiTools.outputBudget.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiTools.actionClauses.contract.test.ts src/services/aiTools.domainMetadata.contract.test.ts src/services/aiGuardrails.tier1WriteActions.contract.test.ts src/services/aiAgentSystemPrompt.test.ts
  ```

  Expected: PASS. `outputBudget` checks that `manage_tickets:list`'s page keys survive on the derived shape.
- [ ] Commit: `feat(ai-tools): wire PSA and billing write tools into chat and agents (#6756)`.

## Task 9: D3 rename to `manage_billing_catalog` plus a one-release MCP alias (lane C; after T8)

**Files:**
- `aiToolsCatalog.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts` (map keys only), `aiAgentSdkTools.ts`
- `mcpCoverage.ts:187-191`, `aiAgents/agentToolCatalog.ts:336`, `aiToolAliases.ts`
- the tests listed below
- docs (Task 13)

- [ ] **Red.**
  - In `aiToolAliases.test.ts`: `resolveDeprecatedToolAlias('manage_catalog') === 'manage_billing_catalog'`.
  - In `mcpServer.deprecatedAlias.test.ts`, following the `get_fleet_status` cases:
    - a `tools/call` for `manage_catalog` dispatches `manage_billing_catalog`;
    - the audit carries `requestedToolName: 'manage_catalog'` and `deprecatedToolAlias: true`;
    - `tools/list` contains `manage_billing_catalog` and **not** `manage_catalog`.
  - In the registry parity test, `aiTools.has('manage_catalog') === false`.

  Run them. Expected: FAIL.
- [ ] **Green.** Rename every occurrence the audit enumerated (re-grep: `grep -rn "manage_catalog" apps packages e2e-tests --exclude-dir=node_modules`):
  - API code: `aiToolsCatalog.ts:7,45,78,469,475`, `aiToolSchemas.ts:541`, `aiGuardrails.ts` (TOOL_PERMISSIONS, TIER3 maps), `mcpCoverage.ts:187,188,191`, `agentToolCatalog.ts:336`, `catalogService.ts:603` (comment);
  - tests: `aiToolsCatalog.manageCatalog.test.ts`, `aiToolsCatalog.test.ts:523,531`, `aiGuardrails.test.ts:40`, `registryParity`, `agentToolCatalog.categoryParity.test.ts:167`, the `agentToolCatalog` snapshot.

  Leave historical plan and spec docs alone. Add the alias entry with the comment `// W02 D3 (#6756) — renamed in v0.117. Remove one release after v0.117 ships.`

  The description gains one sentence, "Billing price book (not the software catalog).", and must stay within `aiTools.descriptionBudget`.
- [ ] **Stored-name audit (spec correction 7).** The old name was never tiered, so agent allowlists validated against `listAgentReachableTools` should not contain it. Confirm by reading the allowlist writer (`aiAgents/agentService.ts` / `toolAllowlist.ts`). Then **ask Todd to run on EU and US**:

  ```sql
  SELECT 'ai_agents' t, count(*) FROM ai_agents WHERE tool_allowlist::text LIKE '%manage_catalog%'
  UNION ALL SELECT 'pam', count(*) FROM <pam rules table> WHERE match_tool_name = 'manage_catalog'
  UNION ALL SELECT 'approvals_pending', count(*) FROM approval_requests WHERE action_tool_name = 'manage_catalog' AND status = 'pending'
  UNION ALL SELECT 'intents_pending', count(*) FROM action_intents WHERE action_name = 'manage_catalog' AND status IN ('pending','approved');
  ```

  Take the real table and column names from `db/schema/pam.ts:230`, `approvals.ts:39` and `actionIntents.ts:336`. Record the result in the PR.
  - **All zero:** no migration.
  - **Non-zero:** stop and add an idempotent, system-scoped rewrite migration (CLAUDE.md migration rules) before merge.
  - `ai_tool_executions.tool_name` is history only; note in the PR that usage reports must union both names for one release.
- [ ] Run:

  ```bash
  cd apps/api && npx vitest run src/services/aiToolAliases.test.ts src/routes/mcpServer.deprecatedAlias.test.ts src/services/aiToolsCatalog src/services/aiAgentSdkTools src/__tests__/mcp-coverage.test.ts src/services/aiGuardrails
  ```

  Expected: PASS.
- [ ] Commit: `feat(ai-tools): rename manage_catalog → manage_billing_catalog with a one-release MCP alias (spec D3) (#6756)`.

## Task 10: Agent catalog surfaces (lane C; after T9)

- [ ] Run `cd apps/api && npx vitest run src/services/aiAgents/agentToolCatalog.contract.test.ts`. Expected: FAIL on the unreachable snapshot only. The diff must be exactly:
  - removed: `manage_catalog`, `manage_notification_channels`, `manage_quotes`, `manage_saved_filters`, `manage_tags`, `manage_tickets`, `test_webhook`;
  - `manage_billing_catalog` absent from the unreachable set.

  **Read the diff before `-u`.**
- [ ] `-u`, then re-run: PASS.
- [ ] Add pinned assertions:
  - `listAgentReachableTools()` ⊇ the six W02 names plus `manage_billing_catalog`;
  - `TOOL_CAPABILITY.manage_billing_catalog === 'business'`;
  - `manage_tickets` is in the `tickets` capability.
- [ ] Run `cd apps/api && npx vitest run src/services/aiAgents`. Expected: PASS, including `domainRelation` and `categoryParity`.
- [ ] Commit: `test(ai-agents): catalog snapshot for W02 writes (#6756)`.

## Task 11: Class-coverage contract rows (lane A; after T8)

- [ ] **Red.** One table-driven test per spec checklist item 3 ("each class gets one contract-test row"), in `aiGuardrails.approvalScope.contract.test.ts` (`W02 class rows`). Iterate over every `(tool, action)` of the seven tools using `toolActionEnum`, and assert that the resolved `{ tier, approvalScope }` equals a literal `W02_EXPECTED` map copied from this plan's tables.
  - The map must cover **every** enum member, so a new action reds.
  - **Control:** delete one row locally and watch it red.
- [ ] Commit: `test(ai-guardrails): pin every W02 action's class (#6756)`.

## Task 12: Web `tierConfig.ts` and category parity (lane D; after T8)

- [ ] **Red.** Remove `manage_quotes` and `manage_catalog` from `TOOL_CAPABILITY_NOT_YET_IN_TIER_CONFIG` (`agentToolCatalog.categoryParity.test.ts:167,179`). Run it. Expected: FAIL.
- [ ] **Green.** Update the `tierConfig.ts` tier lists. Names must use real action ids; the parity test resolves `checkGuardrails(tool, { action })`, so input-aware actions resolve on **empty input**.
  - **Tier 2 Ticketing:** drop `comment`, `edit_comment`, `delete_comment` from the big entry. Keep `update_status`/`update_fields` with the description "Update tickets (resolving, or changing the requester, needs approval)".
  - **Tier 3 Ticketing:** `manage_tickets (comment)`, "Public comment: customer-visible, emails the requester (internal notes, isPublic:false, are Tier 2)"; `manage_tickets (edit_comment/delete_comment)`.
  - **Tier 2** `manage_quotes (create_draft/update/…/reorder_lines)` and `manage_billing_catalog (create_item)`, category Ticketing (or add a `Billing` `ToolCategory` if `CATEGORY_CAPABILITY_PAIRS` allows; one-line reason).
  - **Tier 3** `manage_quotes (send/decline/create_pay_link)` and `manage_billing_catalog (update_item/archive_item/set_price/remove_price/set_org_price/remove_org_price/set_bundle_components)`.
  - **Tier 3** `manage_notification_channels (create/update/delete)`; move `test_webhook` to Tier 3.
  - `RATE_LIMIT_CONFIGS`: `test_webhook` tier 3.

  Run:

  ```bash
  cd apps/api && npx vitest run src/services/aiAgents/agentToolCatalog.categoryParity.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts
  cd apps/web && npx vitest run src/components/ai-risk && pnpm exec astro check
  ```

  Expected: PASS.
- [ ] Commit: `feat(web): AI risk page shows W02 PSA/billing classes (#6756)`.

## Task 13: Docs (lane D; after T9)

**Files:**
- `apps/docs/src/content/docs/features/ai.mdx`
- `mcp-server.mdx`
- `ai-tools.mdx`
- `aiGuardrailsAiDocs.parity.test.ts`

- [ ] **Red.** Extend the docs parity test so every W02 tool/action pair appears in a recognised `| Tool | Tier | Description |` table. Run it. Expected: FAIL.
- [ ] **Green.**
  - Replace the `Ticketing & Billing AI Tools` table (`ai.mdx:~494-505`) with a tier table.
  - Replace the paragraph claiming these tools are MCP-only (`:507`) with three sentences:
    - they are now available in chat;
    - public ticket comments, resolving a ticket, and requester edits need approval, while internal notes do not;
    - the catalog tool is `manage_billing_catalog` (the old name works over MCP for one release).
  - `mcp-server.mdx:343`: rename, and replace "All actions are Tier 2" with the real split. Add a note that tier-3 actions are not callable over MCP (W02-D6).
  - `ai-tools.mdx:381`: rename.

  Run `cd apps/api && npx vitest run src/services/aiGuardrailsAiDocs.parity.test.ts` and `cd apps/docs && pnpm exec astro check`. Expected: PASS.
- [ ] Commit: `docs(ai): PSA/billing tools in chat, their approval classes, and the billing-catalog rename (#6756)`.

## Task 14: Prompt budget gate (serial; controller; spec D5 / W02-D10)

- [ ] On a detached `origin/main` worktree (post-W01) and on the branch, run the A-W01 harness for `chat`, then `agent-full`:

  ```bash
  cd apps/api && DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=… \
    npx tsx src/services/llm/__scripts__/tool-capture.ts --surface chat --proxy --tool-search off --out "$SCRATCH/capture-<main|w02>.jsonl"
  ```

  - Read the Sonnet `/v1/messages` row from the JSONL, never the console table (baseline doc §1 trap).
  - Turn-1 tokens = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
  - `tools[]` length: expect +7 on chat and agent-full.
- [ ] **Gate:** the delta must be ≤ 8,000 on each surface. If it is exceeded, **do not merge**. Park the PR behind A-W04 and say so on #6754.
- [ ] If no API key is available, record the offline byte proxy (the tsx one-liner from Task 0's probe: `z.toJSONSchema` of the declared set on main and on the branch) and write `not measured: ANTHROPIC_API_KEY absent`. **The gate is then unresolved and the PR cannot merge.** Todd or the controller runs it. Do not estimate tokens.
- [ ] Append `## Full-control W02 (#6756) delta` to `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md`. Commit: `docs(ai): record W02 prompt-size delta (#6756)`.

## Task 15: Scope-parity integration tests (authored in round 1 with T7; run after T8)

Pattern: `src/__tests__/integration/aiToolsAuditDetailsSiteScope.integration.test.ts`, as in W01 Task 13:
- two sites in one org plus a second org;
- seeded as `breeze_app`;
- assert:
  - (i) out-of-site refused or not found;
  - (ii) in-site succeeds (non-vacuous);
  - (iii) cross-org not found;
  - (iv) unrestricted sees both.

**Each file must red if its guard is removed.** Flip the guard locally once and confirm.

- [ ] **15a** `aiToolsTicketWritesSiteScope.integration.test.ts`:
  - `comment` (public and internal), `update_status`, `update_fields`, `edit_comment`, `delete_comment` and `link_alert` on an out-of-site device-bound ticket → not found; cross-org → not found;
  - `list` as a site-restricted caller returns in-site plus device-less tickets only;
  - the agent-principal path: a triage comment is stored `isPublic=false` even with `isPublic: true` input.
- [ ] **15b** `aiToolsQuoteWritesSiteScope.integration.test.ts`:
  - `update`, `add_catalog_line`, `decline` and `create_pay_link` on an out-of-site quote (the quote `siteId`) → refused; cross-org → not found;
  - `decline` on a draft → `QUOTE_NOT_DECLINABLE` and no audit row;
  - `decline` on a sent quote → one `quote.declined_on_behalf` audit row.
  - Stub Stripe; `create_pay_link` asserts refusal before any Stripe call.
- [ ] **15c** `aiToolsPsaAdminWritesScope.integration.test.ts`:
  - `manage_tags:add` on an out-of-site device → denied;
  - `manage_saved_filters:delete` cross-org → not found;
  - `manage_notification_channels`: `update` on another org's channel → not found; partner-wide channel without `canManagePartnerWidePolicies` → refused; site-restricted caller → site-ceiling refusal; `create` with an inaccessible `orgId` → refused;
  - `test_webhook`: cross-org → not found; site-restricted → refused;
  - `manage_billing_catalog`: org-scope caller → refused; partner A caller cannot touch partner B's item.
- [ ] Run:

  ```bash
  pnpm test-stack up
  cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiToolsTicketWritesSiteScope src/__tests__/integration/aiToolsQuoteWritesSiteScope src/__tests__/integration/aiToolsPsaAdminWritesScope src/__tests__/integration/aiAgentTicketTriage src/__tests__/integration/aiTimeEntryProposal src/__tests__/integration/ticket-move-org
  pnpm --filter=@breeze/api test:integration-suite-coverage
  pnpm test-stack down
  ```

  Expected: PASS. The existing triage and time-entry suites are included because Tasks 1 and 7c change their tier inputs.
- [ ] Commit, one per file: `test(ai-tools): <family> writes — site-restricted and cross-org denial against real Postgres (#6756)`.

## Task 16: Golden prompts, final verification, PR (serial; controller)

- [ ] **Golden prompts (red first).** In `goldenPrompts.test.ts`:
  - delete `manage_quotes`, `manage_tags` and `manage_tickets` from `BASELINE_UNDECLARED_TOOLS`;
  - drop `g34`, `g35`, `g36` from the frozen structural-miss list;
  - raise the count from 72 (post-W01) to 78.

  Run it. Expected: FAIL. Then append:

  ```ts
  { id: 'g73', prompt: 'Add an internal note to ticket 1042: waiting on the vendor RMA.', expect: [{ tool: 'manage_tickets', action: 'comment' }] },
  { id: 'g74', prompt: 'Set the USD price of our "Managed Workstation" plan to $65.', expect: [{ tool: 'manage_billing_catalog', action: 'set_price' }, { tool: 'search_catalog' }] },
  { id: 'g75', prompt: 'Save a device filter called "Offline Windows laptops".', expect: [{ tool: 'manage_saved_filters', action: 'create' }] },
  { id: 'g76', prompt: 'Is the Contoso Slack alert channel set up correctly? Test it.', expect: [{ tool: 'manage_notification_channels', action: 'test' }] },
  { id: 'g77', prompt: 'Fire a test delivery at our PSA webhook.', expect: [{ tool: 'test_webhook' }, { tool: 'query_webhooks' }] },
  { id: 'g78', prompt: 'Mark quote Q-2041 declined — the customer said no on the phone today.', expect: [{ tool: 'manage_quotes', action: 'decline' }, { tool: 'list_quotes' }] },
  ```

  Run `cd apps/api && npx vitest run src/services/llm/toolEval`. Expected: PASS. Commit: `test(ai-eval): golden prompts for W02 PSA/billing writes (#6756)`.
- [ ] **Full API unit suite:** `cd apps/api && npx vitest run`. Expected: 0 failures. `mcp-coverage.test.ts`, `aiGuardrailsTierConfig.parity.test.ts` and `workerEntrypointClosure.contract.test.ts` only red here.
- [ ] **Named contract set** (so a filter slip cannot skip one):

  ```bash
  cd apps/api && npx vitest run src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiGuardrails.tier1WriteActions.contract.test.ts src/services/aiGuardrails.approvalScope.contract.test.ts src/services/aiGuardrails.readonly.contract.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/aiGuardrails.routeBinding.contract.test.ts src/services/aiGuardrails.routeParity.contract.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts src/services/aiGuardrailsAiDocs.parity.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiAgents/agentToolCatalog.categoryParity.test.ts src/services/aiAgents/agentToolCatalog.domainRelation.contract.test.ts src/services/aiTools.outputBudget.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiTools.actionClauses.contract.test.ts src/services/aiTools.domainMetadata.contract.test.ts src/services/aiToolsRegistryParity.test.ts src/services/aiToolsSiteScope.contract.test.ts src/__tests__/mcp-coverage.test.ts src/services/aiToolAliases.test.ts src/routes/mcpServer.deprecatedAlias.test.ts
  ```

  Expected: 22 files, all PASS.
- [ ] **Typecheck and front ends:**

  ```bash
  cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
  cd apps/web && npx vitest run src/components/ai-risk && pnpm exec astro check
  cd apps/docs && pnpm exec astro check
  ```

  Expected: tsc exit 0, web green, docs clean. Then run `pnpm lint`.
- [ ] **Integration:** re-run the Task 15 block on a fresh `pnpm test-stack up`, then `test-stack down`.
- [ ] **Golden eval against main** (`ANTHROPIC_API_KEY` or `AI_TOOL_EVAL_KEY`; controller). Run `tool-eval.ts --surface chat` on post-W01 main and on the branch. Gates:
  - no accuracy drop on g01–g72;
  - g34/g35/g36/g37/g32 should now score;
  - g73–g78 each report a first call, and each miss is explained.

  Report the per-case diff.
- [ ] **One review round** (tenancy, billing and agent surfaces warrant it): `/pr-review-toolkit:review-pr`, with Sonnet for precision on `aiGuardrails.ts`, `aiToolExposure.ts`, `aiToolsQuotes.ts` and `aiToolsCatalog.ts`. Act only on confirmed, consequential findings.
- [ ] **File follow-ups**, each one issue linked from the PR and #6754:
  - `manage_invoices:create_pay_link` is t2 with `invoices:write`, while its route requires `invoices:send` (`routes/invoices/stripe.ts:26`);
  - `manage_groups:add_devices` gives an agent self-scope through `triggers.deviceGroupIds` (W04 decides);
  - `manage_notification_channels:test` is a stub, unlike REST (`channels.ts:437`);
  - tier-2 tools mirroring MFA routes are callable over MCP without MFA: `manage_saved_filters` (`filters.ts:302,428`) and `manage_tags` (`devices/core.ts:1686`). Resolve with #6158;
  - the 8 `KNOWN_INPUT_SURFACE_DRIFT` tools (one issue);
  - `ticket.updated` is offered in `WebhookEditor.tsx:20` but never published to the bus (`ticketOutboxPublisher.ts:58-60,187`);
  - the `get_fleet_status` alias is past its "one release after v0.112" removal date (`aiToolAliases.ts:35`);
  - consider `search_catalog`/`get_catalog_item` → `*_billing_catalog` naming (D3 consistency);
  - remove the `manage_catalog` alias one release after v0.117.
- [ ] **PR body:**
  - summary;
  - the class table, collapsed;
  - **W02-D6 MCP surface loss (Todd sign-off line)**;
  - the permission changes (who loses what);
  - `AGENT_HUMAN_ONLY_ACTIONS`;
  - the rename and alias, with the Task 9 production counts;
  - the triage in-flight intent decision (7c);
  - the prompt delta (Task 14, gate result);
  - the eval diff;
  - the follow-ups;
  - `Closes #6756`.

  Push, `gh pr create`, wait for green CI, then `gh pr merge <N>` (merge queue; never `--admin`). Run `complete_wave` on merge.

---

## Self-review checklist

- [ ] Every write action of the seven tools appears in exactly one class row, and Task 11's `W02_EXPECTED` covers every enum member.
- [ ] Every write action has a `routeBinding` row or an `UNBOUND` reason (Task 6).
- [ ] No four-eyes-fallback tool or action moved to supervised (no loosening). If Task 0b changes this, the PR carries an explicit sign-off line.
- [ ] `AGENT_HUMAN_ONLY_ACTIONS` is exactly `manage_tags:add`. `POLICY_DECIDABLE_TIER3` gained no W02 key.
- [ ] `KNOWN_MISSING_TOOL_TIERS` = 39, `TOOL_TIERS` = 217, and main-declared with all flags on = 217.
- [ ] `manage_catalog` appears only in `DEPRECATED_TOOL_ALIASES`, historical docs, and the alias tests.
- [ ] Prompt gate measured, not estimated. If it is unmeasured, the PR is not enqueued.
- [ ] No test in this PR was written after the code it tests.
