# Breeze AI for Office — Design Spec

**Date:** 2026-06-12
**Status:** Approved design, pre-implementation
**Product:** Excel add-in delivering a governed AI assistant to MSP *client end-users*, with Breeze as the control plane (auth, tenancy, policy, DLP, audit, metering). Client users never see RMM concepts.

## 1. Positioning & decisions

The pitch: *"MSPs can safely deliver AI inside Excel to their clients, with centralized security, auditing, data controls, and provider flexibility."* The differentiator vs. generic ChatGPT/Copilot add-ins is governance, client separation, supportability, and resale controls.

Decisions locked during brainstorm:

| Decision | Choice |
|---|---|
| v1 capability | Chat + read/write workbook, writes approval-gated by the end user |
| End-user auth | Microsoft SSO (Entra ID) via Office SSO/NAA, tenant → org mapping, auto-provisioning |
| Providers | Anthropic only in v1, but router-shaped: policy stores `allowedProviders`/`allowedModels`; OpenAI/Azure are fast-follows with no schema change |
| Harness | Claude Agent SDK (`streamingSessionManager`) now; thin custom multi-provider harness later. All client-facing contracts (REST + SSE + policy schema) are harness-agnostic so the swap touches nothing outside the loop |
| Billing | Existing partner-level AI-credits billing unchanged; new per-org/per-user metering + budgets + CSV reports so the MSP marks up and invoices clients themselves |
| Governance in v1 | All four pillars: prompt/output logging + MSP audit view, per-org policy controls, DLP/redaction, prompt template library |
| Backend architecture | Shared stack, new surface: reuse `ai_sessions`/`ai_messages`, `streamingSessionManager`, cost tracker, guardrails patterns; add a client principal, `/client-ai` route namespace, workbook-only tool registry, DLP, per-org policy |

## 2. Components

1. **Excel add-in** — new app `apps/excel-addin/` (Office.js + React task pane), built on the shared host-neutral `packages/office-addin-core`. Distribution: M365 **centralized deployment** pushed by the MSP via the client tenant's M365 admin center (the MSP already manages these tenants). Sideload manifest for dev. AppSource listing is post-v1.
2. **Client AI API** — new route namespace `apps/api/src/routes/clientAi/` mounted at `/client-ai/*`. Separate from technician `/ai` routes and portal routes, with its own auth middleware.
3. **MSP admin surface** — new "AI for Office" section in the existing Breeze web dashboard (no separate app).

## 3. Identity & tenancy

- The add-in acquires an Entra ID token silently via Office SSO/NAA (the user is already signed into Excel with their work account). It calls `POST /client-ai/auth/exchange`; Breeze verifies the JWT against Microsoft's JWKS (signature, audience, expiry), extracts `tid` (Entra tenant), `oid`, and email.
- **Interactive fallback:** when silent SSO fails (or for non-centrally-deployed installs), the add-in falls back to an MSAL popup sign-in; first-run user consent lands there too.
- **Tenant mapping:** `client_ai_tenant_mappings` binds Entra tenant ID → Breeze `org_id`. Unique on tenant ID — a tenant maps to exactly one org. This is the tenant-isolation linchpin. No mapping → the add-in shows "not provisioned by your IT provider."
- **User principal:** extend `portal_users` (the established end-user concept) with `entraOid`, `entraTenantId`, `authMethod` (`password` | `entra`); `passwordHash` nullable for SSO rows. Users auto-provision on first exchange, subject to org policy (`all` vs `selected` users). Add-in sessions are Redis-backed bearer tokens (24h TTL), org-bound — same shape as portal sessions.
- **Entra app registration:** one Breeze multi-tenant app; the MSP grants admin consent per client tenant during onboarding.
- **Reuse check (plan-phase task):** the repo already has per-org M365 customer-tenant connections (see `delegantM365ConnectionId` on `ai_sessions` and the M365 integration that established those connections, including its consent flow). Audit it first — best case the onboarding wizard reuses the existing connection's tenant ID and adds one more admin-consent grant for the add-in app, rather than building a parallel consent system.

## 4. AI loop & session model

- Client sessions are `ai_sessions` rows with new `type: 'excel_client'` and a nullable `clientUserId` (FK → `portal_users`) alongside `userId`, with a CHECK that exactly one is set. Cost columns, flagging (`flaggedAt`/`flagReason`), and lifecycle are inherited.
- The loop runs on the existing Claude Agent SDK `streamingSessionManager`. Harness-agnostic seams: the add-in talks only to `/client-ai/sessions/*` REST + SSE; policy stores providers/models as data; the later custom harness swap changes nothing client-facing or schema-side.
- Streaming: SSE on `GET /client-ai/sessions/:id/events` (reusing the `SessionEventBus` pattern).
- Pre-flight per message (existing `checkBudget` pattern): org daily/monthly budget → per-user rate limit → per-org rate limit → partner AI credits (`checkBillingCredits`). Reject upfront with a user-readable reason.

## 5. Workbook tools & client-side execution protocol

**Tool registry:** a separate `CLIENT_TOOL_REGISTRY` of ~9 workbook tools: `get_workbook_overview` (sheet names, used ranges, headers), `read_selection`, `read_range`, `write_range`, `insert_formula`, `create_sheet`, `format_range`, `create_table`, `search_workbook`. The technician tool registry is **not reachable** from client sessions — a hard allowlist, not tier filtering.

**Execution protocol** (Office.js only runs inside Excel, so tools execute in the add-in — the Helper-chat remote-execution pattern transplanted to SSE):

1. Model emits `tool_use` → server tool handler publishes a `tool_request` SSE event and awaits.
2. Add-in executes via Office.js, posts `POST /client-ai/sessions/:id/tool-results`.
3. Handler resolves and the loop continues. Timeouts: 60s for reads, 5min for pending write approvals; timeout fails the tool call gracefully (e.g. user closed Excel) and the model is told.

**Write approval:** read tools auto-execute (Tier-1 equivalent). All mutating tools are approval-gated **by the end user in the task pane**: preview card showing target range and before/after diff (≤200 cells; summary above that) with Apply/Reject. Apply executes then reports; Reject returns a rejection `tool_result` so the model can adjust. Org policy `writeMode: 'readonly'` removes write tools from the model's toolset entirely. Every request/approve/reject/apply lands in `ai_tool_executions` + `audit_logs` with the client user as actor.

## 6. DLP / redaction pipeline

New service `clientAiDlp.ts`, a single chokepoint: **every payload leaving Breeze for the provider** (user prompt, workbook `tool_result` data, template content) passes through it. Nothing reaches the model un-scanned.

- **Built-in detectors:** credit cards (Luhn-validated), SSN/national IDs, IBAN, API-key/token shapes, email/phone (off by default). Per-org **custom regex rules**. The existing `aiInputSanitizer` patterns seed this; workbook-scale scanning (thousands of cells per `read_range`) with cell-level granularity is new code.
- **Per-rule actions:** `redact` (replace with `[REDACTED:type]`; the model sees the redacted form), `block` (refuse the request and tell the user why), `log-only`. Defaults: redact for financial/credential types.
- **Redact before logging:** `ai_messages` stores the redacted form, so the audit trail never retains the sensitive values. Each redaction event (rule, count, location) is recorded in message metadata for the MSP audit view.

v1 is regex/Luhn only; ML-based DLP is out of scope.

## 7. Per-org policy

`client_ai_org_policies` — one row per org, RLS shape 1, separate from technician `aiBudgets` so the two products' knobs never interfere. Partner defaults are **copy-on-create**: when the MSP enables an org, the dashboard pre-fills from the partner's last-used/default values — no live inheritance chain, no NULL-org rows (keeps the table single-axis).

Fields: `enabled`; user access (`all` | `selected` + user list); `allowedModels` / `allowedProviders` (router-ready); `writeMode` (`readwrite` | `readonly`); DLP rule config (jsonb); daily/monthly budget cents; per-user and per-org rate limits; data retention days; branding (MSP display name/logo shown in the add-in footer).

## 8. Metering & billing

- Provider spend keeps flowing through the existing partner-level AI-credits integration (`checkBillingCredits` / `deductBillingCredits`) — Breeze bills the MSP; nothing new there.
- New `client_ai_usage` table mirrors the `ai_cost_usage` daily/monthly bucket pattern **plus a per-user dimension**: `(org_id, client_user_id, period, period_key)` → tokens, cost cents, session/message counts. This enables MSP resale invoicing.
- Dashboard usage report per org/user/month with **CSV export** — the MSP's invoicing artifact. Resale margin is the MSP's business; Breeze does not bill client orgs directly.

## 9. MSP admin surface (Breeze dashboard)

1. **Onboarding wizard per client org** — reuse/verify existing M365 connection for tenant ID; generate the admin-consent URL for the add-in app registration; poll/confirm consent; write the tenant mapping; link to centralized-deployment instructions. Status chip per org (not provisioned / consent pending / active).
2. **Policy editor** — all `client_ai_org_policies` knobs; DLP rules get a toggle list for built-ins plus custom-regex entry with a live test box.
3. **Audit & session viewer** — searchable client-session list (org, user, date, cost, flagged); transcript drill-in including workbook context sent, redaction events, and every tool approval/apply. Reuses existing session-viewer + flag/unflag machinery.
4. **Usage & billing report** — per org/user/month, CSV export.
5. **Template manager** — CRUD for partner- and org-scope templates.

## 10. Prompt templates

`client_ai_prompt_templates`: partner-scope rows (`org_id` NULL → visible to all the partner's orgs) and org-scope rows. Fields: name, description, prompt body, category. Surfaced as a template picker on the add-in's empty-chat state.

> ⚠️ **Dual-axis RLS trap:** this table has partner-wide rows with NULL `org_id` — exactly the `custom_field_definitions` failure mode (fixed 2026-06-11-i). Policies MUST cover both axes (org **and** partner), and the PR MUST include a functional `breeze_app` insert test for the partner-axis write path. The rls-coverage contract test provably does not catch a missing second axis.

## 11. Add-in UX

- Chat thread with streaming responses.
- **Context chip** showing exactly what will be shared ("Selection B2:F40" / "Sheet: Q3 Budget") with an explicit per-message toggle: include selection / include sheet / no workbook data. The user controls data egress.
- Write-preview cards with Apply/Reject (section 5).
- Template picker on empty state.
- "Governed by your IT provider" footer with MSP-brandable name/logo from policy — the white-label hook.
- Sign-in invisible via silent SSO; MSAL popup fallback.

## 12. Schema & RLS summary

All changes ship as idempotent dated migrations with RLS policies in the same migration (per CLAUDE.md tenant-isolation rules), with allowlist updates + contract-test runs in the same PR.

| Table | Change | RLS shape |
|---|---|---|
| `client_ai_tenant_mappings` | new | 1 (direct `org_id`) |
| `client_ai_org_policies` | new | 1 |
| `client_ai_usage` | new | 1 |
| `client_ai_prompt_templates` | new | dual-axis (org + partner) — see §10 warning |
| `portal_users` | + `entraOid`, `entraTenantId`, `authMethod`; `passwordHash` nullable | existing |
| `ai_sessions` | + `clientUserId` FK → portal_users; new `type` value `excel_client`; CHECK exactly one of (`userId`, `clientUserId`) | existing |

## 13. Testing

- Vitest route tests for every `/client-ai` endpoint: auth exchange, session lifecycle, tool-result protocol, policy enforcement, budget rejection paths.
- Token-exchange negative tests: forged signature, expired, wrong audience, unmapped tenant.
- DLP detector unit tests with cell-matrix fixtures (per detector, per action, redact-before-log).
- RLS: contract-test allowlist updates **plus** functional cross-tenant `breeze_app` insert tests for the dual-axis templates table.
- Add-in: Office.js-mocked unit tests for the tool executor and preview rendering; manual test checklist for in-Excel behavior (Playwright cannot drive Excel).

## 14. Delivery phasing

One spec, ~5 implementation plans / PR trains:

1. **Foundation** — schema + RLS, Entra token exchange, tenant mapping, user auto-provisioning, policy table + enforcement middleware. (Includes the M365-connection reuse audit, §3.)
2. **Session loop** — `/client-ai` session routes, SDK wiring with client tool registry, SSE tool round-trip protocol, cost/budget enforcement, audit events.
3. **DLP service** — detectors, per-org rules, redacted logging.
4. **Dashboard** — onboarding wizard, policy editor, audit viewer, usage report, template manager.
5. **Excel add-in** — scaffold, SSO + MSAL fallback, chat UI, tool executor, write-preview, templates. (Parallelizable with 3–4 once the loop API from 2 is stable.)

## 15. Out of scope for v1 (designed-for, deferred)

- OpenAI / Azure OpenAI providers and the custom multi-provider harness (schema + policy are ready; the swap is isolated to the loop).
- External data connectors.
- Word / PowerPoint / Outlook add-ins.
- AppSource listing.
- Password-fallback portal auth inside the add-in.
- ML-based DLP (v1 is regex/Luhn).
