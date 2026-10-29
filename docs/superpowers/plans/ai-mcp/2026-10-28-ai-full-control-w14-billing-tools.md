---
tracking_issue: LanternOps/breeze#6754
wave: W14 (#6784)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W13 PR B (#6783, PR #10352) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6784
---
# AI full control W14: billing lifecycle tools — class review and plan

**Goal:** give chat and MCP the capabilities the W05 triage tagged `W14` (rows #2, #20, #28, #29, #30, #31, #32, #38, #69, #71, #83) as ten tool surfaces, each with a class that survives the spec's class review **before** it is reachable (spec D2). Paths are under `apps/api/src/`.

**Verified against** `origin/main` `5b223e4a5c` (2026-10-28; W13 PR B #10352 merged).

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10352 merged and on `origin/main` | yes (`5b223e4a5c` is main's head) |
| 0.2 | none of the new names (`manage_billing_profiles`, `manage_billing_settings`, `manage_contract_templates`, `manage_contract_documents`, `get_device_billing`, `manage_accounting_sync`) in the registry / `TOOL_TIERS` / `HUMAN_ONLY_TOOLS`; every route module exists | yes / yes (`billingProfiles.ts`, `orgBillingProfile.ts`, `invoices/{settings,evidence}.ts`, `contracts/{templates,documents,generate,periods,reports}.ts`, `devices/billing.ts`, `accounting/index.ts`) |
| 0.3 | no `wave-6784` branch or PR | yes |
| 0.4 | #6784 and #6754 open | yes |

## Split (W14-D1): two PRs, both base `main`, sequential

- **PR A (this branch): eight surfaces** — `manage_billing_profiles` (profiles, work types, org assignment), `manage_billing_settings`, `manage_contract_templates`, `manage_contract_documents`, the three read extensions (`get_contract` period outcome, `list_contracts` currency mismatches, `get_invoice` billed devices) and `get_device_billing`. `Part of #6784`.
- **PR B (next dispatch, branched from `main` after PR A merges): two surfaces** — `manage_contracts:generate_invoice` (creates, may auto-issue and email a real invoice) and `manage_accounting_sync` (pushes invoices and customers to Xero / QuickBooks). `Closes #6784`.

Why: each PR B surface moves money or tenant data out of Breeze, and `generate_invoice` needs an `EFFECT_DIGEST_RESOLVERS` entry that pins the contract, the period and the computed totals — its own review round. PR A is configuration and reads with no egress. Both PRs edit the same class maps and contract files, so B is built on `main` after A merges. The class review below covers all ten.

## Facts the triage did not have

1. **Billing profiles and work types are partner-wide by construction.** `billing_profiles`, `billing_profile_rules`, `billing_profile_ai_rates` and `work_types` carry `partner_id` only (no org row). The routes are `requireScope('partner')` + `billing_profiles:read|write`, and every write also needs MFA and `canManagePartnerWidePolicies` (the service re-checks it, `assertWriter`). So **every** profile / work-type write is a partner-wide write.
2. **A rate card decides what every time entry is billed** (`billingRuleResolver.selectCard`): the org's assigned active card, else the partner's active default in the org currency. Archiving a card makes every org assigned to it fall back to the default; editing rows changes the rate stamped on every later time entry. Stamped entries and issued invoices keep their old rates (no restamp).
3. **Work-type archive has a side effect undo does not restore.** `archiveWorkType` clears the work type as the default of every ticket category that used it (`clearedCategoryCount`); setting the type active again does not put those defaults back.
4. **Org assignment** (`/orgs/organizations/:id/billing-profile`, partner scope, `billing_profiles:read|write`, MFA on writes) picks the card one org is billed by. It refuses the partner's holding org and a suspended org outside the caller's selection (`partnerMemberMayReachOrg`). `assigned_by` is a `users` FK.
5. **Billing settings have no GET in `invoices/settings.ts`.** Partner settings are read through `GET /orgs/partners/me` (`partnerPublicColumns`); org settings through the org row. PATCH partner settings (`invoices:write` + MFA + `canManagePartnerWidePolicies`; the agreement-reminder keys also need `agreements:send`) rewrites partner-wide invoice defaults: currency, tax rate, number prefix, terms, footer, T&Cs, the auto-email-on-quote-accept and notify-on-behalf switches. PATCH org settings (`invoices:write` + MFA; `billingProfileId` also needs `billing_profiles:write`) edits one org's tax id / exemption / rate, payment terms, **billing contact (the address every quote and invoice is emailed to)** and billing address; a `currencyCode` PATCH is a separate, currency-only cut-over (`changeOrgCurrency`, optimistic precondition + snapshot-retention confirmation).
6. **Currency impact** (`GET /orgs/:orgId/billing-settings/currency-impact`) is a read gated on `invoices:write` (it previews a write). **Reporting totals** (`GET /billing/reporting-totals`) is permission-free FX arithmetic over caller-supplied groups.
7. **Agreement templates are legal documents** (`agreements:read|write`; scope partner, organization or system; **no MFA** on any template route). A template is org-owned or partner-wide (XOR); the service gates partner-wide writes on `canManagePartnerWidePolicies`. Draft versions cannot be pinned anywhere (`assertTemplateVersionUsable` requires `published`). **Publish is irreversible** (`VERSION_IMMUTABLE`; a published version can be pinned into quotes and agreement requests sent to customers for signature) and **archive is irreversible** (no unarchive path; blocks new versions and new pins). `created_by` is a `users` FK on templates and versions.
8. **Signed agreements** (`contract_documents`) are executed legal records (signer name / email, acceptance evidence, sha256). `PATCH /contract-documents/:id` links an UNATTACHED document to a same-org contract and **cannot be undone** (`ALREADY_LINKED` 409, no unlink path).
9. **Period outcome / currency mismatches / billed devices / device billing** are pure reads over existing services (`billingEvidence.getPeriodOutcome` — whole-contract site check; `contractCurrencyReportService`; `billingEvidence.listInvoiceLineDevices` — invoice org + site check; `deviceCoverage.contractLinesCoveringDevice`). `GET /devices/:id/billing` needs partner scope, `devices:read` **and** `contracts:read` (contract-line descriptions routinely carry the rate).
10. **The three extended tools are wholly read-only** (`TIER2_READONLY_TOOLS`: base tier 2, never in a per-action tier table; `aiGuardrails.readonly.contract`). An `action` selector would make them multiplexers, so each extension is an optional selector parameter (`periodId`, `view`, `lineId`) on the same read — no class change.
11. **PR B:** generate (`POST /contracts/:id/generate`, `contracts:manage`) creates the due invoice under system scope and, when the contract auto-issues, issues it and **emails it to the customer** post-commit. Accounting routes are `accounting:read|manage` + partner authority + MFA; push / push-bulk / reconcile need the invoice-push grant and send invoice and customer data to Xero / QuickBooks.

## Tools and per-action class review

Q1 reversible within a minute? Q2 leaves the tenant / reaches a person / bills money? Q3 blast radius? Q4 can an agent grant itself authority? t1 = `TIER1_READ_ACTIONS` / tier-1 tool; t2-ro = `TIER2_READONLY_*`; t2 = the user approves unless `auto_approve`; sup = tier-3 supervised; 4e = tier-3 four-eyes.

### PR A

| Tool / action | Q1 | Q2 | Q3 | Q4 | Triage | **W14** | Route twin / floor |
|---|---|---|---|---|---|---|---|
| `manage_billing_profiles:list` / `get` / `list_work_types` | read | none | partner | no | read | **t1** | GET `/billing-profiles[/...]`, `/billing-profiles/work-types`, billing_profiles:read, partner scope |
| `…:create` / `update` / `archive` / `set_rows` / `clone` | yes (edit back; stamped entries unchanged) | **bills money** (fact 2) | **partner-wide** (fact 1) | no | sup | **sup** | POST / PATCH / DELETE `/billing-profiles[/:id]`, PUT `/:id/rows`, POST `/:id/clone`, billing_profiles:write + MFA + `canManagePartnerWidePolicies` |
| `…:create_work_type` / `update_work_type` | yes | money (rate rows key on work types) | partner-wide | no | sup | **sup** | POST / PATCH `/billing-profiles/work-types[/:id]`, same floor |
| `…:get_org_profile` | read | none | one org | no | read | **t1** | GET `/orgs/organizations/:id/billing-profile`, billing_profiles:read |
| `…:set_org_profile` / `clear_org_profile` | yes (assign back) | **bills money** (which card bills the org, fact 2) | one org | no | t2 | **sup** (escalated: the W02 `manage_billing_catalog:set_org_price` precedent — changing what an org is billed is never silent under `auto_approve`) | PUT / DELETE `/orgs/organizations/:id/billing-profile`, billing_profiles:write + MFA |
| `manage_billing_settings:get_partner` / `get_org` | read | none | partner / one org | no | read | **t1** | GET `/orgs/partners/me`, GET `/orgs/organizations/:id` (fact 5), organizations:read (quorum QW6) |
| `…:currency_impact` | read | none | one org | no | read | **t1** (requires invoices:write, as the route) | GET `/orgs/:orgId/billing-settings/currency-impact`, invoices:write |
| `…:reporting_totals` | read | none | none | no | read | **t1** (requires invoices:read; REST has none) | GET `/billing/reporting-totals` |
| `…:update_partner` | yes (edit back) | **bills money; reaches customers** (terms, tax, footer, T&Cs, auto-email switches on every document) | **partner-wide** | no | sup | **sup** | PATCH `/partner/billing-settings`, invoices:write + MFA + `canManagePartnerWidePolicies` |
| `…:update_org` | yes | **bills money** (tax, terms) **and redirects customer email** (billing contact) | one org | no | t2 | **sup** (escalated, fact 5) | PATCH `/orgs/:orgId/billing-settings`, invoices:write + MFA |
| `manage_contract_templates:list` / `get` / `get_version` / `usage` | read | none | org / partner | no | read | **t1** | GET `/contract-templates[/...]`, agreements:read |
| `…:create` / `update` (org-owned) | yes (archive hides a new template; edit back) | none | one org | no | t2 | **t2** | POST / PATCH `/contract-templates[/:id]`, agreements:write |
| same, `ownerScope: 'partner'` | yes | none | **partner-wide** | no | t2 | **sup** (input-aware; the call asserts `ownerScope`, the handler refuses a mismatch — W11-D4 pattern) | same + `canManagePartnerWidePolicies` |
| `…:create_version` (org-owned) | **no** (versions are append-only: no draft edit or delete, quorum QW2) | none (a draft pins nowhere) | one org | no | t2 | **sup** (escalated, QW2) | POST `/:id/versions`, agreements:write |
| `…:create_version` (partner-wide) | **no** | none | **partner-wide** | no | t2 | **not built** (irreversible + partner-wide is four-eyes, QW2) | same |
| `…:publish` / `archive` (org-owned) | **no** (fact 7) | none directly (a published version can then be sent for signature) | one org | no | sup (publish) | **sup** | POST `/:id/versions/:versionId/publish`, POST `/:id/archive`, agreements:write |
| `…:publish` / `archive` (partner-wide) | **no** | none directly | **partner-wide** | no | sup | **not built** (spec rule: irreversible + partner-wide is four-eyes; W14-D5) | same |
| `manage_contract_documents:list` | read | none | org | no | read | **t1** (no signer email, W14-D6) | GET `/contract-documents`, agreements:read |
| `…:link` | **no** (fact 8) | none | one record | no | t2 | **sup** (escalated: irreversible legal-record linkage); the service update now carries `contract_id IS NULL` so a concurrent second link is a 409 (QW5); returns identifiers only (QW4) | PATCH `/contract-documents/:id`, agreements:write |
| `get_contract` + `periodId` (period outcome) | read | none | one contract | no | read | **t2-ro, unchanged** (fact 10) | GET `/contracts/:id/periods/:periodId/outcome`, contracts:read |
| `list_contracts` + `view: 'currency_mismatches'` | read | none | org(s) | no | read | **t2-ro, unchanged** | GET `/contracts/currency-mismatches`, contracts:read |
| `get_invoice` + `lineId` (billed devices) | read | none | one invoice line | no | read | **t2-ro, unchanged** | GET `/invoices/:id/lines/:lineId/devices`, invoices:read |
| `get_device_billing` | read | none | one device | no | read | **t1** | GET `/devices/:id/billing`, devices:read + contracts:read, partner scope |

### PR B (decided here, built next)

| Tool / action | Q1 | Q2 | Q3 | Q4 | Triage | **W14** | Route twin / floor |
|---|---|---|---|---|---|---|---|
| `manage_contracts:generate_invoice` | **no** once issued / emailed (void is not undo) | **bills money; emails the customer** (auto-issue) | one org | no | sup | **four-eyes** (quorum QW1: irreversible + leaves the tenant; escalated from the brief's sup — Todd sign-off) + `EFFECT_DIGEST_RESOLVERS` entry pinning contract id, period, computed totals, currency, auto-issue and the normalized recipients (QW9); a drift refuses at release; **agent-human-only** | POST `/contracts/:id/generate`, contracts:manage |
| `manage_accounting_sync` reads (status, owed operations, customers, mappings, income accounts) | read | none | partner | no | read | **t1** (never a token column; `aiToolOutput.encryptedColumns`) | GET `/accounting/:provider[/...]`, accounting:read + partner authority |
| `…:remote_candidates` with a model-supplied search term | read | **the term reaches the provider** (`searchTerm`, quorum QW8) | partner | no | read | **filter locally, or supervised** for an input-bearing provider search (decided in PR B) | GET `/accounting/:provider/remote-candidates` |
| `…` mapping writes / mapping sync / customer import | remap is local; a `create_new` sync **creates remote customers / items that remap does not reverse** (QW7) | **data leaves the tenant** | partner | no | t2 / sup | **four-eyes** for a creation-capable sync (QW7); local partner-wide catalog mappings **sup** at minimum; cumulative REST grants kept (`accounting:read` + `organizations:write` + `sites:write` for import; entity-specific write grants for mappings, QW6) | PUT `/mappings`, POST `/mappings/sync`, POST `/customers/import`, accounting:manage + MFA |
| `…:push` / `push_bulk` | **no** (the document exists in Xero / QuickBooks) | **data leaves the tenant** | one invoice / many | no | sup | **four-eyes** (QW1; escalated from the brief's sup — Todd sign-off); **agent-human-only**; push-bulk capped | POST `/accounting/:provider/invoices/:id/push`, `/push-bulk`, invoice-push grant + MFA |
| connect / callback / disconnect / settings | — | — | — | — | — | **not built** (vendor console only) | — |

### Agent (headless) exposure (spec D4)

| Tool | Exposure |
|---|---|
| `manage_billing_profiles`, `manage_billing_settings`, `get_device_billing`, the three extensions | **Partner scope only** (the existing billing family's `partnerScopeRefusal`, REST parity). Autonomous agent runs mint `scope: 'organization'`, so they are refused in the handler; the tools stay in the `business` capability for a future partner-scoped runner. Reads would be reachable; writes would be proposals. |
| `manage_contract_templates`, `manage_contract_documents` reads | **reachable** (org scope allowed, as REST). |
| `manage_contract_templates` writes, `manage_contract_documents:link` | **`AGENT_HUMAN_ONLY_ACTIONS`** — agreement templates and signed agreements are the legal documents customers sign; an agent drafting or filing them is the `human_only_legal_evidence` exemption's reasoning (mcpCoverage `contracts/agreementRequests.ts`). It also keeps the `created_by` users FK from failing an agent-principal release (W12-D3). |
| PR B `generate_invoice`, accounting push / push-bulk | **`AGENT_HUMAN_ONLY_ACTIONS`** (money; data leaving the tenant). |

## Decisions

- **W14-D1 two PRs** (above).
- **W14-D2 no route extraction.** Every route here is a thin wrapper over an exported service; the tool calls the same services (`billingProfileService`, `workTypeService`, `invoiceService.updatePartnerBillingSettings` / `updateOrgBillingSettings`, `orgCurrencyService.getOrgCurrencyImpact`, `reportingTotals`, `contractTemplateService`, `contractDocumentService`, `billingEvidence`, `contractCurrencyReportService`, `deviceCoverage`). No route file changes.
- **W14-D3 every billing write is supervised, and is MFA-gated where REST is.** Profiles, work types and partner settings are partner-wide (fact 1); org assignment and org settings change what one org is billed or where its invoices go (W02 precedent). Only org-owned template drafts stay t2. MFA: every profile / work-type / assignment / settings write (REST `requireMfa()`); template and document writes have no MFA at REST and get none.
- **W14-D4 not built (recorded).** Work-type **archive** (fact 3 — irreversible side effect on a partner-wide object would be four-eyes; the tool's `update_work_type` cannot deactivate); profile `save` (the drawer composite — `update` + `set_rows` cover it) and AI price-list edits after create; org **currency change** (`update_org` refuses `currencyCode`; the cut-over keeps its confirmation UI); `billingProfileId` on `update_org` (assignment is `set_org_profile`, with its own permission); the partner settings' agreement-reminder keys (`agreements:send`; edited on Billing → Agreements); template PDF upload and file download; signed-agreement PDF download.
- **W14-D5 partner-wide templates.** Readable by every partner member (REST). Create and update on a partner-wide template are supervised: the call asserts `ownerScope: 'partner'` (`isInputAwareTier3`), the handler refuses a mismatch with the row (ownership is immutable, so the release-time check closes the race, QW10), and the service's `canManagePartnerWidePolicies` gate applies. **Draft versions, publish and archive of a partner-wide template are refused** (each is irreversible; irreversible + partner-wide is four-eyes under the spec rule, QW2; a person maintains the partner library in the web app). Org-owned `create_version`, `publish` and `archive` are supervised.
- **W14-D6 projections (every action result, QW4).** Signed-agreement rows drop `signerEmail` and `acceptanceReference` (personal data / free-form evidence the model does not need; signer name — fenced — and dates stay); `link` returns identifiers only (never the stored bytes or signer forensic fields). Template `list` strips `latestVersion.bodyHtml`, `get` lists versions without `bodyHtml`; `get_version` returns the body clipped. Rate-card, work-type, assignment and settings writes return the previous values (`before`) beside the result, and the audit row carries them (QW3; an org's billing-contact values go to the model only, never into an audit row). `update` refuses an AI-coverage change that would delete the card's AI price list (QW3). Profile and settings reads are explicit projections. Free text (template names / bodies, profile names / notes, work-type names, contract-line descriptions, footers, T&Cs, hostnames) is fenced in `RAW_TEXT_FIELDS_BY_TOOL`.
- **W14-D7 users-FK writes record a verified user or NULL** (W12-D3): `org_billing_profile_assignments.assigned_by`. Template `created_by` is written by the service from `auth.user.id`; template writes are human-only for agents (above), so the id is always a person.
- **W14-D8 scope.** Partner-only tools refuse non-partner scope (REST parity). Org-wide configuration writes (org assignment, org settings, org templates, document link) refuse site- or device-restricted sessions (`canMutateOrgWideGovernance`, the W13-D13 rule); partner-wide writes need `canManagePartnerWidePolicies` (the service gate, re-made at release). Template and document reads refuse device-bound sessions (org-wide records, W13-D16). `get_device_billing` goes through `deviceArgs` (central device + site gate).
- **W14-D9 rate limits.** Billing writes 20 / 300 s per tool (the W13 write limit); reads use the default.
- **W14-D10 MCP surface (Todd signs off in the PR).** Every tool is new except the three additive read selectors; nothing is lost. Supervised actions are denied over MCP by default (`MCP_APPROVAL_REQUIRED`).
- **W14-D11 index.** Every PR A tool joins the `billing` domain (where every contract, invoice and quote tool lives; there is no `contracts` domain). Measured below.

### Existing entries, and whether they change (PR A)

| Map | W14 PR A |
|---|---|
| `TOOL_TIERS` (block after W13) | + 5 (`manage_billing_profiles`, `manage_billing_settings`, `manage_contract_templates`, `manage_contract_documents`: 1; `get_device_billing`: 1) |
| `TIER1_READ_ACTIONS` | profile / work-type / assignment reads, settings reads, template reads, document list |
| `TIER2_ACTIONS` | `manage_contract_templates:create/update` (org-owned; partner-wide escalates input-aware) |
| `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` | every profile / work-type / assignment / settings write, template `create_version` / `publish` / `archive`, document link |
| `TIER3_INPUT_AWARE_ACTIONS` + `TIER_DECIDING_INPUT_KEYS` | template create / update with `ownerScope: 'partner'` |
| `TIER3_FOUR_EYES_*`, `DELIBERATELY_UNPINNED`, `EFFECT_DIGEST_RESOLVERS` | unchanged (no PR A four-eyes surface) |
| `AGENT_HUMAN_ONLY_ACTIONS` | template writes, document link |
| `MFA_GATED_TOOL_ACTIONS` | profile / work-type / assignment / settings writes |
| `TOOL_PERMISSIONS` (+ `TOOL_EXTRA_PERMISSIONS`) | per-action rows from each route; `get_device_billing` contracts:read extra |
| `TIER2_READONLY_TOOLS` | unchanged (the three extended tools stay members) |
| `mcpCoverage.ts` | burned down: `billingProfiles.ts`, `orgBillingProfile.ts`, `invoices/{settings,evidence}.ts`, `contracts/{templates,documents,periods,reports}.ts`, `devices/billing.ts` (PR B: `contracts/generate.ts`, `accounting/index.ts`) |

## Budget (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | main `5b223e4a5c` | PR A branch |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | 2,494 |
| billing block (B2 < 2,048) | 282 | 524 |
| largest block | devices 1,713 | devices 1,713 |
| Worst page turn (B3 < 7,040) | alert 5,257 | alert 5,257 (device 4,648) |

The billing block is not page-expanded (device / alert pages expand devices, scripts and monitoring), so W14 cannot move B3. No ceiling, `DOMAIN_NOTES` or vocabulary change; none is `alwaysLoad`. Registry 338 → 343, so `MCP_TOOL_COUNT_APPROX` 330 → 340 (own commit). Golden prompts g109–g111 (an org's rate card, publish a template version, device billing); the brief's generate-invoice and Xero-push prompts join with PR B, whose tools they name.

## Quorum (codex `exec`, read-only, xhigh): AGREE WITH CHANGES

- **QW1 (blocking, PR B) generate_invoice, push and push-bulk are four-eyes.** ACCEPTED for PR B (spec rule: irreversible + leaves the tenant). This escalates the brief's "sup" — a Todd sign-off box.
- **QW2 (blocking) draft versions are append-only, so irreversible.** ACCEPTED — org `create_version` supervised, partner-wide `create_version` refused.
- **QW3 (blocking) pricing changes must be recoverable.** ACCEPTED — `before` in results and audit; `update` refuses an AI-coverage change that deletes the AI price list.
- **QW4 (blocking) projections on every result.** ACCEPTED — `link` returns ids only; template list strips `latestVersion.bodyHtml`; signer names fenced.
- **QW5 (blocking) link race.** ACCEPTED — `linkContractDocument`'s UPDATE gains `contract_id IS NULL` (REST benefits too); the loser gets 409 `ALREADY_LINKED`; an integration test races two links.
- **QW6 (blocking) cumulative REST permissions.** ACCEPTED — settings reads require `organizations:read` (their read routes' grant); PR B keeps import's and mappings' cumulative grants.
- **QW7, QW8, QW9 (blocking, PR B).** ACCEPTED as PR B requirements (creation-capable mapping sync four-eyes; provider search terms filtered locally or supervised; the generate digest pins auto-issue and recipients).
- **QW10** the split, escalations, agent-human-only legal writes, partner-scope refusals, restricted-session gates and exclusions agreed; the input-aware predicate goes in `isInputAwareTier3`. No loosening.
- **Dissents for Todd:** none (every finding accepted).

## Tasks

T1 (this doc + quorum) → T2 guardrail classes → T3 route bindings + permission parity → T4 schemas + handlers (pre-exposure: projections, scope refusals) → T5 wiring + index measure → T6 agent catalog → T7 contract rows → T8 web `tierConfig.ts` → T9 docs → T10 prompt-size gate → T11 golden prompts → T12 integration suite → T13 merge main, gates, PR.
