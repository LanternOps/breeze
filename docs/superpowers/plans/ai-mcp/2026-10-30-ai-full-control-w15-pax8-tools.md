---
tracking_issue: LanternOps/breeze#6754
wave: W15 (#6785)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W14 PR B (#6784, PR #10709) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6785 (PR A), feature/6754-ai-full-control/wave-6785-b (PR B)
---
# AI full control W15: Pax8 tools — class review and plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give chat and MCP the capabilities the W05 triage tagged `W15` (rows #105 `pax8.ts`, #106 `pax8Orders.ts`). Each tool gets a class that survives the spec's class review **before** it is reachable (spec D2). The Pax8 order **submit** is four-eyes, and its approval is bound to exactly the company, SKUs, quantities, commitments and billing inputs that are sent. Costs are approved as live-rate estimates that are re-checked seconds before the write (Pax8 takes no price on an order; Open Decision OD-2). Paths are under `apps/api/src/`.

**Architecture:** these are thin tool handlers over the existing Pax8 services (`pax8SyncService`, `pax8OrderService`, `pax8OrderSubmit`, `pax8Drift`). Two pieces are new: a read-only order preview (`pax8OrderPreview.ts`, PR A) and a pinned submit digest (`actionIntents/pax8OrderDigest.ts`, PR B). PR B also adds one hook to the money-critical claim transaction, so that an approval drift refuses the submit before anything is sent.

**Tech Stack:** Hono services, Drizzle, Vitest (unit + `pnpm test-stack` integration), the action-intent / effect-digest machinery.

**Verified against** `origin/main` `3888074c03` (2026-10-30; W14 PR B #10709 merged 10-29).

## Global Constraints

- **No migration.** Every table (`pax8_integrations`, `pax8_company_mappings`, `pax8_subscription_snapshots`, `pax8_contract_line_links`, `pax8_product_mappings`, `pax8_orders`, `pax8_order_lines`) already exists, and no column is added. Nothing under `apps/api/migrations` is touched.
- **Never blind-retry a Pax8 write.** `POST /v1/orders` has no idempotency key, and `DELETE /v1/subscriptions/{id}` is terminal (Pax8 has no reactivate) — see `pax8Client.ts` at `createOrder` / `cancelSubscription`. A timeout means `needs_reconcile`, never "try again".
- **`PUT /v1/subscriptions/{id}` sends `quantity` only.** The tool never builds a Pax8 body itself. It calls `submitOrder`.
- **REST parity of gates:**
  - every route needs `requireScope('partner','system')` and `billing:manage`;
  - every write needs `requireMfa()`, preflight included;
  - every `pax8.ts` route also needs `canManagePartnerWidePolicies` (its router-level gate);
  - order routes need `canAccessOrg(order.orgId)`.
- **Secrets never reach the model.** No `*_encrypted` column, access token, `raw` jsonb or `metadata` jsonb is ever selected into tool output.
- **Raw Pax8 error bodies are clipped and fenced.** `routeError` returns a raw Pax8 body to REST callers, but a tool returns the body clipped to 2 KB and fenced as raw text.

## Review Focus

1. **A line is edited after approval but before release** (for example `update_line` on provisioning details, or a sync that moves a subscription's quantity). The release refuses and nothing reaches Pax8 → T8 `verifyClaim refuses a drift inside the claim transaction` + T10 integration case.
2. **A release is re-delivered after a crash in the middle of the HTTP call.** The second delivery finds `status: 'submitting'`, the claim returns 409, and no second order is created → T9 `a re-delivered release is refused by the claim, never re-sent`.
3. **The Pax8 price changes between preview and release.** The release refuses with `PRICE_CHANGED` and the order stays `draft` → T9.
4. **The isMock preflight fails at release** (for example a quote-staged `awaiting_details` order with missing provisioning details). The tool refuses with `PREFLIGHT_FAILED` and the provably-unsent order goes back to its pre-claim status. Note that REST's `submitOrder` would mark it `failed` → T8 / T9.
5. **The model passes another partner's order id, or an order in an org outside the caller's selection.** The result is `NOT_FOUND` or `FORBIDDEN`, with no Pax8 HTTP and no row written → T5 / T10.

---

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10709 merged, on `origin/main` | yes (merged 2026-10-29T20:28Z; main head `3888074c03`) |
| 0.2 | none of `get_pax8_status`, `search_pax8_products`, `manage_pax8_subscriptions`, `manage_pax8_orders` exist in the registry, `TOOL_TIERS`, `HUMAN_ONLY_TOOLS` or schemas; both route modules exist | yes (only hits: `mcpCoverage.ts:633-634`, `{ gap: '#6785' }`) / yes |
| 0.3 | no `wave-6785` branch or PR | yes |
| 0.4 | #6785 and #6754 open | yes |

## Split (W15-D1): two PRs, both base `main`, sequential

- **PR A: every surface except submit and reconcile.** That is `get_pax8_status`, `search_pax8_products` and `manage_pax8_subscriptions` (list, drift, sync, link, unlink). On `manage_pax8_orders` it is the reads, the draft and line writes, `preview` and `preflight`. `Part of #6785`.
- **PR B (next dispatch, branched from `main` after A merges): `manage_pax8_orders:submit` (four-eyes) and `:reconcile` (supervised).** The submit digest module, the claim hook and the mandatory pin all land here. `Closes #6785`.

**Why split.** PR A sends nothing billable. Its only Pax8 calls are authenticated reads plus the isMock dry run. PR B changes `pax8OrderSubmitRepository.claimOrder`, the transaction the ordering plan calls money-critical, and adds a four-eyes surface with a mandatory digest. W14 gave its money surface a separate quorum round, and that round found eight blocking issues (QB1–QB8). The same should happen here. Both PRs edit the same class maps, so B is built on `main` after A. The class review below covers both.

## Split (W15-D2): four tools, not the triage's five

`get_pax8_drift` becomes `manage_pax8_subscriptions:drift`, a tier-1 read action. Drift rows are linked subscriptions whose Pax8 quantity disagrees with the contract line, so they sit naturally beside `list`. The action takes the same `integrationId`. Merging also saves one index entry in the billing block.

## Facts the triage did not have

1. **`pax8.ts` puts `canManagePartnerWidePolicies` on every route, reads included** (the router `use('*')` gate). Members with a restricted org selection cannot read Pax8 status, companies or subscriptions at all. **`pax8Orders.ts` has no such gate.** It refuses org scope and then checks `canAccessOrg` per order.
2. **Reads are `billing:manage`, deliberately.** There is no billing-read permission, and snapshots carry `unitCost` / `unitPrice` (vendor cost and margin). The tools keep `billing:manage` on reads.
3. **Sync moves no money.** `POST /sync` enqueues `pax8SyncWorker`, which reads companies and subscriptions from Pax8 into local snapshots. It records `lastObservedQuantity` on links and **does not** overwrite contract quantities. Breeze is the billing source of truth, and Pax8 is only a drift detector (`recordPax8SubscriptionObservations`).
4. **A link decides where a later order writes billing quantity.** `linkPax8SubscriptionToContractLine` ties a subscription to a *manual* contract line in the same org. `persistSubmitResults` then writes each succeeded line's quantity onto that line's `manual_quantity` (`0` for a cancel), and that is the quantity the customer is billed. **Unlink** deletes the link row, losing `syncEnabled` and the observation history. A staged change or cancel on that subscription is then refused at submit (`staged contract line no longer matches`).
5. **Order states.** `draft` / `awaiting_details` (quote-staged) / `ready` are submittable. `submitting` is set by the claim, a CAS on `xmin` that takes the parent row lock every line mutation needs. The claim is also the idempotency guard: a second submit loses with 409. Lines move `pending → in_flight → succeeded | failed | needs_reconcile`. On quote-staged lines, `add_line` / `remove_line` are refused, but `updateOrderLine` still edits a new-subscription line's `commitmentTermId` and `provisioningDetails` (`pax8OrderService.ts:826-836`, quorum Q11). `loadResolvedOrder`, which `preflightOrder` uses, **writes**: it persists the resolved company and `updatedAt` (`pax8OrderSubmitRepository.ts:271`).
6. **The preflight result carries no money.** `preflightOrder` returns `{ ok: true }` or `{ ok: false, errorBody }`. It sends only the **new-subscription** lines to `POST /orders?isMock=true`; quantity changes and cancels are not checked. **`submitOrder` re-runs the same preflight after the claim, and a failure there marks every line `failed` and the order `failed`** (terminal, not resubmittable).
7. **Order lines carry no price.**
   - The partner's cost is Pax8's. For a new subscription it comes from `GET /products/{id}/pricing`, live, where `partnerBuyRate` is matched by billing term and commitment term. For a change or cancel it comes from the synced snapshot's `unitCost`.
   - The customer's price is Breeze's. It is resolved the way invoicing resolves it: the catalog price in the **contract** currency, falling back to the contract line's `unit_price` (`contractInvoicePreview.ts:144`, quorum Q5). Quote-created **new** subscriptions also carry a `contractLineId` (`quoteToPax8Order.ts:242`), so any line can have a billed contract line, not only changes and cancels.
   - **Pax8 takes no price on `createOrder`.** It bills its current rate, so a live rate is the only evidence of what will be charged. A re-check detects drift but cannot cap the rate (quorum Q8).
   - A snapshot's `unitCost` is nullable.
8. **Commitment rules are vendor-side.** `getProductDependencies` returns `allowForQuantityDecrease / Increase / EarlyCancellation` and `cancellationFeeApplied`. For a change or cancel, the commitment that applies is the subscription's **active** one, derived from the snapshot `raw` (`activeCommitment`, `pax8OrderService.ts:256-298`). `addOrderLine` refuses what the commitment forbids, and the web org tab warns on a cancellation fee (`Pax8OrgTab.tsx:247`). Chat and the approval card have no equivalent today.
9. **Self-managed DB context.** Line add, preflight, submit, reconcile, provision-details and dependencies are on the `selfManagedDbContextRoutes.ts` list, because their Pax8 HTTP runs between short DB contexts. The tool must declare `selfManagedDbContext` for the same actions.
10. **`users` FKs.** `pax8_orders.created_by` and `submitted_by` reference `users`, and both are nullable. An agent principal's `auth.user.id` is the agent id, not a `users` row (`agentAuthContext.ts`). `getOrCreateDraftOrder`'s `actorUserId` is typed `string` (`pax8OrderService.ts:540`).
12. **Integration generation.** `pax8SyncService` already defines an ABA-safe integration generation: id, partner, both URLs, both credential ciphertexts and `isActive` (`integrationGenerationPredicate`, `:45`). `createClient` re-reads the integration *after* the claim commits (`pax8OrderSubmitRepository.ts:385`).
13. **Persistence overwrites billing quantity unconditionally.** `updateManualContractQuantity` sets `manual_quantity` matching only id, org and type (`pax8OrderSubmitRepository.ts:207`). A billing edit made during the Pax8 HTTP call is silently overwritten. This is true for REST today as well (quorum Q6).
14. **Agents cannot reach any Pax8 write, even with a grant.** `checkAgentGuardrails` denies a mutation from a run that is not device-bound (`aiGuardrails.ts:3785`), and every W15 handler refuses device-bound sessions.
11. **Pax8 catalog search is a different surface.** The live Pax8 catalog search and import live in `catalog/distributors.ts` (catalog:read; mcpCoverage says `lookup_distributor_product`, which is TD SYNNEX only). Out of scope here: ordering needs a **mapped** product (`pax8_product_mappings` → active catalog item), which `listPax8Products` lists locally.

## Tools and per-action class review

Legend:
- Q1: reversible within a minute?
- Q2: does it leave the tenant, reach a person, or bill money?
- Q3: blast radius?
- Q4: can an agent grant itself authority?
- Classes:
  - t1 = `TIER1_READ_ACTIONS` / a tier-1 tool;
  - t2 = the user approves unless `auto_approve`;
  - sup = tier-3 supervised;
  - 4e = tier-3 four-eyes.

Every tool here has base tier 1 in `TOOL_TIERS` and per-action escalations, which is the W14 `manage_billing_profiles` shape.

### PR A

| Tool / action | Q1 | Q2 | Q3 | Q4 | Triage | **W15** | Route twin / floor |
|---|---|---|---|---|---|---|---|
| `get_pax8_status` (`view: 'summary' \| 'companies'`) | read | none | partner | no | read | **t1** | GET `/pax8/integration`, `/pax8/companies`; billing:manage + partner-wide gate |
| `search_pax8_products:search` | read | none (local filter, fact 11) | partner | no | read | **t1** | GET `/pax8/products`; billing:manage |
| `…:provision_details` / `dependencies` / `pricing` | read | Pax8 product id only (a catalog identifier, no tenant data) | partner | no | read | **t1** | GET `/pax8/products/:id/{provision-details,dependencies}`; `pricing` = `getPax8ProductPricing` (REST twin `catalog/distributors /pax8/pricing` is catalog:read; the tool requires billing:manage because it is vendor cost) |
| `manage_pax8_subscriptions:list` / `drift` | read | none | partner / org | no | read | **t1** | GET `/pax8/subscriptions` (org filter as REST: `orgCondition` unless `unmappedOnly`), GET `/pax8/drift`; billing:manage + partner-wide gate (a tightening for `drift`, W15-D4) |
| `…:sync` | yes (the next scheduled sync rewrites the same snapshots) | **calls the vendor** with the partner's credentials (Pax8 → Breeze, fact 3) | **partner-wide** (every org's snapshots) | no | t2 | **sup** (escalated, quorum Q1: the spec says nothing that calls a vendor or is partner-wide may be tier 2) | POST `/pax8/sync`; MFA |
| `…:link` | yes (link back; upsert) | **decides which contract line a later order bills** (fact 4) | one org | no | sup | **sup** | POST `/pax8/subscriptions/link`; MFA; `canAccessOrg(line.orgId)` |
| `…:unlink` | partly (relinking loses observation history) | stops drift detection; strands staged lines | one org | no | sup | **sup** | DELETE `/pax8/subscriptions/link`; MFA; `canAccessOrg(snapshot.orgId)` |
| `manage_pax8_orders:list` / `get` | read | none | partner / one order | no | read | **t1** | GET `/pax8/orders[/:id]` |
| `…:create_draft` | yes (an empty draft submits nothing; it returns the existing mutable draft if there is one) | none | one org | no | t2 | **t2** | POST `/pax8/orders`; MFA |
| `…:add_line` / `update_line` / `remove_line` | yes (remove / edit; nothing is sent until submit) | change and cancel staging reads the commitment from Pax8 (product id only) | one order | no | t2 | **t2** (a staged cancel is still only a draft line) | POST / PATCH / DELETE `/pax8/orders/:id/lines[/:lineId]`; MFA |
| `…:preview` | read | live price and commitment reads (product id only) | one order | no | — | **t1** (new; W15-D6) | no REST twin; billing:manage |
| `…:preflight` | yes (isMock creates nothing) | **the staged order content reaches Pax8** (company, products, quantities, provisioning details the model may have authored) | one order | no | t2 | **sup** (escalated, quorum Q1; the W14 QW8 reasoning: content reaching a provider is supervised at minimum) | POST `/pax8/orders/:id/preflight`; MFA |

### PR B (decided here, built next)

| Tool / action | Q1 | Q2 | Q3 | Q4 | Triage | **W15** | Route twin / floor |
|---|---|---|---|---|---|---|---|
| `manage_pax8_orders:submit` | **no** (a real, billable Pax8 order; a cancel is terminal) | **money leaves the tenant** | one org, ≤ 20 lines | no | 4e | **four-eyes** + mandatory `EFFECT_DIGEST_RESOLVERS` pin (W15-D6); **agent-human-only** | POST `/pax8/orders/:id/submit`; MFA |
| `…:reconcile` | no (it records what Pax8 already did, writes `manual_quantity`, and may reopen a provably-unsent order) | Pax8 read; **writes billing quantity** | one order | no | — | **sup**, not four-eyes: it sends nothing to Pax8. It records an attempt that was already approved, from vendor evidence, and leaves ambiguous lines unknown rather than guessing (`pax8OrderSubmit.ts:367`, quorum Q9) | POST `/pax8/orders/:id/reconcile`; MFA |

### Not built (W15-D8)

| Surface | Why |
|---|---|
| POST `/pax8/integration` (credential save, origin change, activate / deactivate), POST `/pax8/integration/test` | Credential custody: the `vendor_console_admin` reasoning (`backup/providers.ts`, `edr/connections.ts`). |
| POST `/pax8/companies/map` (company ↔ org mapping) | Triage product judgment #4. Mapping decides **which customer a Pax8 company's orders and subscriptions bill to**, and every order resolves its company through it. A person decides it. |
| product mapping and catalog import (`catalog/distributors.ts`) | Out of wave (fact 11). |
| discard / cancel a draft order | No REST route. |

**How "human-only" is recorded.** `HUMAN_ONLY_TOOLS` cannot hold these: `registryParity` requires every entry to be a *registered*, untiered tool. Instead they get no action in any schema. That is stronger than `AGENT_HUMAN_ONLY_ACTIONS`, because chat and MCP cannot reach them either. Three things pin it:
- the exact `action` enums asserted in T5 (`map_company`, `save_integration` and `test_connection` must never appear);
- a code comment on the `pax8.ts` mcpCoverage entry naming the three routes;
- the `aiToolExposure.ts` header comment block, so a later wave cannot add them by accident.

### Agent (headless) exposure (spec D4) — W15-D15

| Surface | Exposure |
|---|---|
| All four tools | Capability `business` in `agentToolCatalog.ts`, beside the billing family. **Every handler refuses non-partner scope** (REST parity). Autonomous runs mint `scope: 'organization'` (`agentAuthContext.ts:112`), so **today no agent can reach any Pax8 surface**. The rows below are the rule a future partner-scoped runner inherits. |
| reads (t1) | **Reachable.** Tier-1 reads skip the allowlist. |
| t2 / sup writes (sync, link, unlink, draft and line edits, preflight, reconcile) | **Only with an explicit allowlist grant, and a grant is necessary but not sufficient.** The device-less mutation deny (fact 14) also applies, and W15 refuses device-bound sessions, so a partner-scoped runner alone would still not reach these writes (quorum Q10). These are pre-authorised action keys (the D4 default), and none is self-granting (Q4 is no everywhere). They are **not** agent-human-only, unlike W14's accounting mappings (`aiToolExposure.ts:225`). An accounting link or sync **overwrites a record in the provider's books**, which leaves the tenant. A Pax8 link and unlink are local rows, and Pax8 preflight / reconcile create nothing remotely. |
| `manage_pax8_orders:submit` | **`AGENT_HUMAN_ONLY_ACTIONS`: never, not even as a proposal.** D4 would normally let a four-eyes call become a proposal. Two facts rule that out: Pax8 has no idempotency key, and a cancel is terminal. A person asks and two people approve (the W14 PR B `generate_invoice` / `push` precedent). |

Also: `canManagePartnerWidePolicies` fails for every agent auth (`partnerOrgAccess: null`). The `pax8.ts` surfaces are therefore closed to agents twice over.

## Decisions

- **W15-D1 / D2:** the split and the four tools (above).
- **W15-D3 no route extraction.** Every route is a thin wrapper over an exported service, and the tools call the same functions:
  - `pax8SyncService`: `linkPax8SubscriptionToContractLine`, `unlinkPax8Subscription`, `createPax8ClientForIntegration`;
  - `enqueuePax8Sync`;
  - `pax8OrderService`: `getOrCreateDraftOrder`, `addOrderLine`, `updateOrderLine`, `removeOrderLine`, `getOrderWithLines`, `listPax8Orders`, `listPax8Products`;
  - `pax8OrderSubmit`: `preflightOrder`, `submitOrder`, `reconcileOrder`;
  - `detectPax8Drift`, `pax8CompanyOrderReadiness`, `snapshotActiveCommitmentEvidence`, `getPax8ProductPricing`.

  The integration and company reads are copied as explicit projections. They are not imported from the route files, which export nothing reusable. No route file changes.
- **W15-D4 gates.** Every handler:
  - refuses `organization` scope;
  - resolves the partner as `resolvePartnerId` does (system scope must pass `partnerId`);
  - refuses device-bound sessions (these are partner and org-wide records, W13-D16).

  `get_pax8_status` and every `manage_pax8_subscriptions` action also require `canManagePartnerWidePolicies`. That is `pax8.ts` parity, extended to `drift` for one rule per tool; the tightening is recorded. Every `manage_pax8_orders` action requires `canAccessOrg(order.orgId)`, and every order write also requires `canMutateOrgWideGovernance` (the W14 `generate_invoice` rule). Writes re-make every gate at release, because the handler runs then.
- **W15-D5 MFA** on every write action, from `MFA_GATED_TOOL_ACTIONS`:
  - `manage_pax8_subscriptions`: `sync`, `link`, `unlink`;
  - `manage_pax8_orders`: `create_draft`, `add_line`, `update_line`, `remove_line`, `preflight`, and in PR B `submit`, `reconcile`.

  Reads get no MFA gate; agents are exempt, as always.
- **W15-D6 the four-eyes submit** (revised after quorum Q2–Q8).
  - *Preview (PR A, t1).* `previewPax8Order({ partnerId, orderId })` in `pax8OrderPreview.ts` returns `{ order, company, lines[], totals, blocked[] }`. It is read-only and never calls `loadResolvedOrder` (fact 5).
    - **Each new line:** product name, vendor SKU, quantity, billing and commitment term, the live `partnerBuyRate` × quantity in its currency, and the customer price resolved as invoicing resolves it (fact 7).
    - **Each change:** from-quantity (`authorizedBaselineQuantity`) → to-quantity, with the snapshot `unitCost` / `currency` and the contract line's billed price.
    - **Each cancel:** current quantity → 0.
    - **Each change or cancel** also shows the active commitment's term, its `allowFor*` flags and `cancellationFeeApplied` (fact 8).
    - `blocked[]` names what an AI submit will refuse: `COST_UNKNOWN` (a new line with no unique live price row, **or** a quantity increase whose snapshot `unitCost` is null), `TOO_MANY_LINES` (> 20), `NOT_PENDING`, `COMPANY_UNRESOLVED`, and `COMMITMENT_AMBIGUOUS`.
    - PR B adds `previewDigest` (sha256 of `pax8OrderDigestMaterial`) and `submitWith`.
    - Pax8 HTTP runs outside any DB context, so preview is in `selfManagedDbContext`.
  - *Submit arguments (PR B).* `orderId`, `previewDigest`, `expectedCompany: { pax8CompanyId, name }`, and `expectedLines[]`. Each expected line is `{ lineId, action, pax8ProductId, productName, quantity, fromQuantity?, unitCost, currency, billingTerm, commitmentTerm, cancellationFeeApplied? }`. All of these are copied from `submitWith`, and the approval card is built from them.
  - *Digest (PR B).* `pax8OrderDigestMaterial(database, orderId)` in `actionIntents/pax8OrderDigest.ts` pins every **local** input of what is sent and billed. Absent rows pin as null.
    - **The order:** `id`, `partner`, `org`, `source`, `sourceQuoteId`, and `pax8CompanyId` resolved through the mapping exactly as the claim does. `status` is pinned only as `submittable: status ∈ SUBMITTABLE_STATUSES`, because the claim itself flips it to `submitting` (quorum Q2). `updatedAt` and `submittedAt` are not pinned.
    - **The company mapping row:** `pax8CompanyId`, `name`, `status`, `ignored`, `orgId`.
    - **The integration generation:** `id`, `isActive`, `apiBaseUrl`, `tokenUrl`, and an opaque `credentialGeneration`, the sha256 of the two credential **ciphertexts**. This is the existing ABA-safe generation (fact 12). The access-token columns are excluded, because they churn on refresh (quorum Q4).
    - **Every line, in `sortOrder, id` order:** `id`, `sortOrder` (it becomes the outbound `lineItemNumber`), `action`, `submitState`, `pax8ProductId`, `catalogItemId`, `billingTerm`, `commitmentTermId`, `quantity`, `authorizedBaselineQuantity`, `targetSubscriptionId`, `cancelDate`, `contractLineId`, and canonical `provisioningDetails` (quorum Q5).
    - **Every line with a `contractLineId`, new lines included:** the contract line (`manualQuantity`, `unitPrice`, `lineType`, `catalogItemId`), its contract's currency, and the catalog price rows in that currency (quorum Q5).
    - **New lines:** the product-mapping row and the catalog item.
    - **Change and cancel lines:** the snapshot (`quantity`, `quantityKnown`, `unitCost`, `unitPrice`, `currencyCode`, `status`, `orgId`, `productId`), the link row (`contractLineId`, `syncEnabled`), and the **derived active-commitment ids** from `raw`. The derived ids are pinned rather than `raw` itself (quorum Q7).
    - It deliberately does **not** pin `lastSeenAt` / `updatedAt`, which churn with every scheduled sync.
    - Mandatory per action (`PINNED_EFFECT_DIGEST_REQUIRED_ACTIONS += 'manage_pax8_orders:submit'`).
    - The **live Pax8 price and commitment rules are not pinnable** (they are not local). They are assertions that the handler re-checks (step 2 below).
  - *Release sequence (PR B, handler, `selfManagedDbContext`).*
    1. Re-make the W15-D4 gates on the release auth. Refuse more than 20 lines.
    2. Outside any DB context, re-fetch live pricing for the new lines and dependencies for **every** line. Refuse `PRICE_CHANGED` / `COMMITMENT_CHANGED` unless each `unitCost`, `currency`, `commitmentTerm` and `cancellationFeeApplied` equals the assertion. Nothing is written.
    3. Call `submitOrder({ partnerId, orderId, actorUserId, verifyClaim, onPreflightFailure: 'reopen' })`.
       - Inside the claim transaction, after the parent row is claimed (the lock every line mutation needs) and the lines are read and validated, `verifyClaim(bundle, tx)` recomputes `pax8OrderDigestMaterial` on that transaction.
       - It throws `PREVIEW_MISMATCH` unless the sha256 equals `previewDigest` **and** every `expectedLines` / `expectedCompany` field equals the recompute.
       - The throw rolls the claim back: the order keeps its pre-claim status and nothing is sent.
       - **No pre-claim preflight runs.** It would send unverified content to Pax8 and write through `loadResolvedOrder` (quorum Q3).
    4. `createClient` builds the client only if the integration still matches the claimed generation. It uses the `integrationGenerationPredicate` pattern and refuses `INTEGRATION_CHANGED` otherwise. The verified client is carried through execution, so the destination cannot move between verification and the write (quorum Q4). A refusal after the claim but before any HTTP reopens the order, exactly like `onPreflightFailure`.
    5. The post-claim isMock preflight runs on the **claimed, verified** bundle. With `onPreflightFailure: 'reopen'`, a failure does not call `persistPreflightFailure`, which is terminal (fact 6). Instead a CAS (`status = 'submitting'`, every line `pending`, the same `submittedAt`) returns the order to its pre-claim status, with the clipped error → `PREFLIGHT_FAILED`. REST keeps today's behavior when the option is omitted.
    6. Carry on the existing path: `claimLines`, then `executeWrites` (never retried). Persistence of `manual_quantity` follows Open Decision OD-1.
    7. Return the per-line outcome. `needs_reconcile` lines are named with the `reconcile` hint.
  - *Why both a digest and `previewDigest`.* The effect digest binds intent creation to release. `previewDigest` plus `verifyClaim` binds release to the row lock under which the claim commits, and the generation check binds the claim to the destination. Together they close every local window up to the write. The assertions make the card truthful: the handler refuses if the model's card text disagrees with the recompute.
  - *Residual (quorum Q8, Open Decision OD-2).* Cost is an **estimate at Pax8's current rate**, checked seconds before the write. `POST /orders` carries no price, so Breeze cannot cap what Pax8 charges. The card says "estimated", never "exactly".
- **W15-D7 refusals specific to the AI.** An AI submit refuses in these cases; a person submits them in the web app:
  - a new line with no unique live price row, or a quantity increase whose snapshot `unitCost` is null (`COST_UNKNOWN`, quorum Q8);
  - a change or cancel whose active commitment cannot be derived uniquely (`COMMITMENT_AMBIGUOUS`);
  - more than 20 lines;
  - an order not in a submittable status;
  - an unmapped or ambiguous company.

  Quote-staged orders are allowed. Their line set is fixed; `update_line` still edits a new line's commitment term and provisioning details, and both are pinned.
- **W15-D8 not built** (table above).
- **W15-D9 projections and fences (every result).**
  - The integration view: `id`, `name`, `apiBaseUrl`, `tokenUrl`, `isActive`, sync status, the three `has*` booleans, and `lastSyncError`, clipped.
  - Companies: never `metadata`; readiness fields only.
  - Subscriptions: never `raw`; the active-commitment evidence fields only.
  - Orders and lines: Pax8 error text clipped to 2 KB.
  - `RAW_TEXT_FIELDS_BY_TOOL` fences everything vendor- or person-authored: `pax8CompanyName`, `mappedOrgName`, `productName`, `vendorName`, `catalogName`, `catalogDescription`, `lastSyncError`, `error`, the provision-detail `label` / `description` / `possibleValues`, and the `provisioningDetails` values.
  - `aiToolOutput.encryptedColumns` asserts that no `pax8_integrations` `*_encrypted` column appears in any projection.
- **W15-D10 `users` FKs.** `create_draft` passes `verifiedUserIdOrNull(auth)` as `actorUserId` (W12-D3). That needs `getOrCreateDraftOrder`'s `actorUserId` widened to `string | null`; the column is nullable, and the REST caller is unchanged (quorum Q11). `submit` is agent-human-only, and its release auth is the requesting person, so `submittedBy` is always a `users` row. No action joins `USER_OWNED_RELEASE_ACTIONS`.
- **W15-D11 rate limits.**
  - `manage_pax8_orders`: 30 / 300 s, tool-wide. A five-line order is about nine calls. This mirrors the `manage_contracts` limit Todd signed off on #10709, and it is a sign-off box in PR A.
  - `manage_pax8_subscriptions`: 10 / 300 s.
  - Reads use the default.
- **W15-D12 MCP surface (Todd signs off in the PR).** Every tool is new and nothing is lost. Supervised actions are denied over MCP by default (`MCP_APPROVAL_REQUIRED`). Over MCP, `submit` files a four-eyes intent (24 h), and the price re-check at release covers the long wait.
- **W15-D13 index.** The four tools join the `billing` domain. Its vocabulary gains `, Pax8 orders` (+13 B always-on), so a "Pax8" request finds the domain. This reverses W14-D11's "no vocabulary change" for a measured cost (Budget).
- **W15-D14 idempotency.** The tool never retries a submit. A re-delivered release is refused by the claim CAS (409 "Another submit won the order claim"). Nothing is re-sent, and the result tells the person to `reconcile`.
- **W15-D16 no migration** (Global Constraints).

### Existing entries, and whether they change

| Map | PR A | PR B |
|---|---|---|
| `TOOL_TIERS` (`aiAgentSdkTools.ts:242`, after the W14 block) | + 4, all `1` | — |
| `TIER1_READ_ACTIONS` (`aiGuardrails.ts:391`) | `search_pax8_products` (all four), `manage_pax8_subscriptions: list, drift`, `manage_pax8_orders: list, get, preview` | — |
| `TIER2_ACTIONS` | `manage_pax8_orders: create_draft, add_line, update_line, remove_line` | — |
| `TIER2_READONLY_ACTIONS` | unchanged | — |
| `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` | `manage_pax8_subscriptions: sync, link, unlink`; `manage_pax8_orders: preflight` (quorum Q1) | `manage_pax8_orders: reconcile` (+ `submit` in `TIER3_ACTIONS`) |
| `TIER3_FOUR_EYES_ACTIONS` (`:766`) | — | `manage_pax8_orders: submit` |
| `TIER3_INPUT_AWARE_ACTIONS`, `TIER_DECIDING_INPUT_KEYS` | unchanged (no input-aware class) | unchanged |
| `HUMAN_ONLY_TOOLS` (`aiToolExposure.ts:15`) | unchanged (cannot hold unbuilt routes, see "Not built"); a header comment names the three human-only routes | — |
| `AGENT_HUMAN_ONLY_ACTIONS` (`:195`) | — | `manage_pax8_orders:submit` |
| `MFA_GATED_TOOL_ACTIONS` (`aiToolMfaGate.ts:22`) | the W15-D5 PR A writes | + `submit`, `reconcile` |
| `TOOL_PERMISSIONS` | `billing:manage` on every action of all four tools | — |
| `RAW_TEXT_FIELDS_BY_TOOL` (`aiToolOutput.ts:1045`) | W15-D9 sets for all four | — |
| `EFFECT_DIGEST_RESOLVERS` (`effectDigest.ts:173`), `PINNED_EFFECT_DIGEST_REQUIRED_ACTIONS` | — | `'manage_pax8_orders:submit'` (both) |
| `DELIBERATELY_UNPINNED` | unchanged | unchanged (submit is pinned) |
| `aiToolRateLimits.ts` | W15-D11 | — |
| `agentToolCatalog.ts` | 4 × `business` | — |
| `mcpCoverage.ts:633-634` | both entries burned down: `pax8.ts` → `{ tools: ['get_pax8_status', 'manage_pax8_subscriptions'] }` (with the human-only comment); `pax8Orders.ts` → `{ tools: ['manage_pax8_orders', 'search_pax8_products', 'manage_pax8_subscriptions'] }`; `FROZEN_GAPS` shrinks by 2 | — |
| `buildApprovalDescription` (`aiGuardrails.ts:4316`), `intentService.ts` description map, `actionLabel.ts` | link / unlink / sync / preflight / draft lines | submit (company, line count by action, CANCEL is terminal, estimated cost, "places a real, billable Pax8 order that cannot be undone"), reconcile |

## Budget (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | main at W14 PR B (#10709) | PR A (expected; measured in T6) |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | ≈ 2,507 (vocabulary +13) |
| billing block (B2 < 2,048) | 561 | ≈ 680–720 (+4 entries) |
| largest block | devices 1,713 | devices 1,713 |
| Worst page turn (B3 < 7,040) | alert 5,257 | unchanged (billing is not page-expanded) |

None of the tools is `alwaysLoad`, and no ceiling changes. The +128 B-per-wave rule (cap 7,680 B) applies only when a bound is exceeded, and none is. The registry goes from 344 to 348, within `MCP_TOOL_COUNT_APPROX` 340 ± 10, so no bump. If T6 measures B1 ≥ 2,550, drop the vocabulary change and record it.

Golden prompts:
- **PR A g114:** "Which Pax8 seat counts don't match what we bill?" → `manage_pax8_subscriptions:drift`.
- **PR A g115:** "Stage 5 more Microsoft 365 Business Premium seats for Contoso in Pax8." → `search_pax8_products:search`, `manage_pax8_orders:create_draft` / `add_line`.
- **PR B g116:** "Submit Contoso's Pax8 order." → `manage_pax8_orders:preview` then `submit`.

## Quorum (codex `exec`, read-only, xhigh, gpt-6-astra): AGREE WITH CHANGES

Codex verified the plan against the code. It returned eight blocking and four non-blocking findings. Every finding is **accepted**; the plan text above already carries each change. Two findings change shared REST code or accept a residual, and so are Open Decisions for Todd. None is a disagreement left unresolved.

- **Q1 (blocking) sync and preflight are supervised, not t2. ACCEPTED.**
  - Spec class rule (`2026-09-23-ai-full-control-design.md:86-88`): "Nothing that leaves the tenant may be tier 2", and calling a vendor counts.
  - Sync calls Pax8 and rewrites every org's snapshots (partner-wide). Preflight sends staged content to Pax8.
  - This escalates the triage's t2 (Open Decision OD-3).
- **Q2 (blocking) the digest must not pin raw `status`. ACCEPTED.** The claim flips it to `submitting` before `verifyClaim` runs (`pax8OrderSubmitRepository.ts:299`), so pinning it would refuse every unchanged order. The material pins `submittable`, and T8 tests unchanged orders from `draft`, `awaiting_details` and `ready`.
- **Q3 (blocking) no pre-claim preflight. ACCEPTED.**
  - `preflightOrder` reloads mutable content and writes via `loadResolvedOrder`, so a pre-claim preflight would send unapproved edits.
  - The verified, claimed bundle is preflighted instead. A failure **reopens** the provably-unsent order (`onPreflightFailure: 'reopen'`) rather than marking it terminally `failed`.
- **Q4 (blocking) the destination is bound. ACCEPTED.** The material pins the integration generation (URLs, `isActive`, sha256 of the credential ciphertexts; never the token). `createClient` refuses if the row moved after the claim.
- **Q5 (blocking) the material covers every billing input. ACCEPTED.**
  - Contract inputs are pinned for every linked line, including quote-created new lines.
  - The customer price uses invoicing's contract-currency resolution; fact 7 is corrected.
  - Line `id` and `sortOrder` are pinned, because `sortOrder` becomes `lineItemNumber`.
- **Q6 (blocking) billing can drift during Pax8 HTTP. ACCEPTED, scope is OD-1.** Persistence overwrites `manual_quantity` with no baseline check (`:207`). The fix is an approved-baseline CAS in submit and reconcile persistence, which keeps the remote outcome and flags `billing_conflict`. It changes REST behavior too.
- **Q7 (blocking) commitment evidence. ACCEPTED.** The derived **active** commitment is pinned for change and cancel lines, dependencies are re-fetched for every line at release, and the commitment term is in the assertions and on the card.
- **Q8 (blocking) cost is an estimate, not a guarantee. ACCEPTED, residual is OD-2.**
  - `POST /orders` carries no price. The card says "estimated at Pax8's current rate", and the re-check seconds before the write is the only control.
  - `COST_UNKNOWN` now also covers a quantity increase with a null snapshot `unitCost`.
  - The 20-line cap is kept.
- **Q9 (non-blocking) remaining classes agreed.** t1 reads; t2 draft and line edits, including a staged cancel; link and unlink supervised; submit four-eyes; reconcile supervised, with the reason now stated; the drift merge.
- **Q10 (non-blocking) headless reachability clarified. ACCEPTED.** A grant is necessary but not sufficient: the device-less mutation deny (fact 14) means no agent reaches a Pax8 write. The local-link vs W14 accounting-mapping distinction is now written down.
- **Q11 (non-blocking) facts corrected. ACCEPTED.**
  - Quote lines allow commitment-term edits (fact 5).
  - The web UI already warns on a cancellation fee (fact 8).
  - `getOrCreateDraftOrder` `actorUserId` widens to `string | null` (W15-D10).
- **Q12 (non-blocking) exclusions and the A/B split agreed.** Unbuilt human-only routes stay out of `HUMAN_ONLY_TOOLS`. The PR B execution-binding tests are required before B merges.

### Open Decisions (for Todd)

1. **OD-1: fix the billing-quantity overwrite (Q6) in PR B, for REST too?**
   - **A, include in PR B:** an approved-baseline CAS in `persistSubmitResults` and `persistReconcileResults`. A conflict keeps the Pax8 outcome and flags `billing_conflict` instead of overwriting.
   - **B, AI path only:** REST keeps today's unconditional overwrite.
   - **C, separate issue:** PR B blocks on it.
   - **Recommend A.** It is the same CAS for both paths, and REST has the same silent-overwrite bug (the W14 QW5 "REST benefits" precedent).
2. **OD-2: accept that an AI-submitted order's cost is an estimate?**
   - Pax8 takes no price on `POST /orders`. Breeze can only re-check the live rate seconds before the write and refuse on any change.
   - **Recommend accept**, with the card wording "estimated at Pax8's current rate". The alternative, "AI never submits a new subscription, only changes and cancels", removes most of the wave's value.
3. **OD-3: sign off the escalations from the triage.**
   - `manage_pax8_subscriptions:sync` and `manage_pax8_orders:preflight` go from t2 to **supervised** (Q1).
   - `reconcile` is newly classed **supervised**.
   - **Recommend accept**: the spec's class rule leaves no tier-2 option for a vendor call.

Sign-off boxes carried into the PRs: the W15-D11 rate limits (`manage_pax8_orders` 30 / 300 s tool-wide, the #10709 precedent) and the W15-D12 MCP surface.

## Tasks

Order: T1 → PR A (T2–T7) → merge → PR B (T8–T11). Each task commits on green. Test commands follow `docs/agents/testing.md`. Never use `pnpm --filter <pkg> test -- --run <path>`. Run from `apps/api`: `pnpm exec vitest run <file>`.

### Task 1: plan, quorum, sign-off

- [ ] Step 1: commit this doc on `plan/6754-w15-pax8-tools`.
- [ ] Step 2: run the codex quorum and record it below. Disagreements become Open Decisions; they are not resolved silently.
- [ ] Step 3: docs-only PR to main. Label `plan-drafted` on #6785, and comment with the tools, the four-eyes design and the Open Decisions.

### Task 2 (PR A): order preview service

**Files:** Create `services/pax8OrderPreview.ts`, `services/pax8OrderPreview.test.ts`.

**Interfaces — Produces:**
- `previewPax8Order(input: { partnerId: string; orderId: string; client?: Pax8Client }): Promise<Pax8OrderPreview>`.
- `Pax8OrderPreview = { order: {id, orgId, source, status}, company: {pax8CompanyId, name} | null, lines: Pax8PreviewLine[], totals: Array<{currency, billingTerm, partnerCost}>, blocked: Array<{lineId?: string, code: 'COST_UNKNOWN'|'COMMITMENT_AMBIGUOUS'|'TOO_MANY_LINES'|'NOT_PENDING'|'COMPANY_UNRESOLVED'}> }`.
- `Pax8PreviewLine = { lineId, action, pax8ProductId, productName, vendorSkuId, quantity, fromQuantity: string|null, billingTerm, commitmentTerm: string|null, unitCost: string|null, currency: string|null, sellUnitPrice: string|null, sellCurrency: string|null, contractLineId: string|null, allowForQuantityIncrease: boolean|null, allowForQuantityDecrease: boolean|null, allowForEarlyCancellation: boolean|null, cancellationFeeApplied: boolean|null }`.
- The customer price is resolved with the contract-currency logic that invoicing uses (`resolvePrice` in the contract currency, falling back to the contract line's `unit_price`). It is not reimplemented.

- [ ] Step 1: write the failing tests:
  - `new line priced from the live pricing row matching billing + commitment term`;
  - `no unique pricing row → unitCost null and blocked COST_UNKNOWN`;
  - `change line: fromQuantity is authorizedBaselineQuantity, unitCost from the snapshot`;
  - `cancel line carries the ACTIVE commitment's flags (derived from snapshot raw), not the product's first commitment`;
  - `quantity increase with a null snapshot unitCost → blocked COST_UNKNOWN`;
  - `quote-created new line with a contractLineId reports the contract-currency customer price`;
  - `never calls loadResolvedOrder / writes nothing on a not-yet-resolved company`;
  - `> 20 lines → blocked TOO_MANY_LINES`;
  - `Pax8 HTTP runs outside the DB context` (assert `runOutsideDbContext` wraps every client call);
  - `writes nothing` (no insert / update on the mocked db).
- [ ] Step 2: run `pnpm exec vitest run src/services/pax8OrderPreview.test.ts`. Expect FAIL (module missing).
- [ ] Step 3: implement. Read the bundle via `getOrderWithLines` under a partner `withDbAccessContext`, then make the Pax8 calls outside it. Match the commitment term through `getProductDependencies` (commitment id → term).
- [ ] Step 4: re-run and expect PASS. Commit `feat(pax8): read-only order preview with live cost evidence (#6785)`.

### Task 3 (PR A): guardrail classes, permissions, MFA, exposure

**Files:**
- Modify: `services/aiAgentSdkTools.ts` (`TOOL_TIERS`), `services/aiGuardrails.ts` (the maps in the "Existing entries" PR A column and `TOOL_PERMISSIONS`), `services/aiToolMfaGate.ts`, `services/aiToolRateLimits.ts`, `services/aiToolExposure.ts` (header comment only), `services/aiAgents/agentToolCatalog.ts`.
- Test: `services/aiGuardrails.pax8.test.ts` (new).

- [ ] Step 1: write the failing tests:
  - `every manage_pax8_* action resolves to its W15 class` (a table-driven `checkGuardrails` over the PR A column);
  - `sync, link, unlink and preflight are supervised, never auto-approved` (quorum Q1);
  - `preflight is not read-only` (`isReadOnlyResolution` false);
  - `every write is MFA-gated`;
  - `billing:manage on every action`.
- [ ] Step 2: run it and expect FAIL. Then run the contract sweep: `aiGuardrails.tier1WriteActions`, `aiAgentSdkTools.registryParity`, `aiToolPermissionsCatalogParity`, `aiGuardrails.routeParity`, `aiGuardrails.approvalScope`, `aiGuardrails.agentPrincipal`, `aiGuardrails.mcpTier3ActionDowngrades`, `aiGuardrails.tierDecidingKeys`. Expect red where they enumerate the registry.
- [ ] Step 3: add the entries. Then run both and expect PASS (T4 supplies the schemas the registry contracts need, so commit T3 and T4 together if the registry contracts stay red).
- [ ] Step 4: commit `feat(ai-tools): W15 Pax8 guard classes (#6785)`.

### Task 4 (PR A): schemas and handlers (pre-exposure projections and gates)

**Files:**
- Create: `services/aiToolSchemasPax8.ts`, `services/aiToolsPax8.ts` (`get_pax8_status`, `search_pax8_products`, `manage_pax8_subscriptions`), `services/aiToolsPax8Orders.ts` (`manage_pax8_orders`), `services/aiToolsPax8.handlers.test.ts`, `services/aiToolsPax8Orders.handlers.test.ts`.
- Modify: `services/aiToolSchemas.ts` (spread `pax8ToolSchemas`), `services/aiTools.ts` (`registerPax8Tools`, `registerPax8OrderTools`), `services/aiAgentSdkTools.ts` (SDK registrations), `services/aiToolOutput.ts` (`RAW_TEXT_FIELDS_BY_TOOL`).

**Interfaces — Produces:**
- `manage_pax8_orders` action enum is exactly `['list','get','create_draft','add_line','update_line','remove_line','preview','preflight']` (PR B appends `submit` and `reconcile`).
- `manage_pax8_subscriptions` is `['list','drift','sync','link','unlink']`.
- `search_pax8_products` is `['search','provision_details','dependencies','pricing']`.
- `get_pax8_status` takes `view?: 'summary'|'companies'` and `partnerId?` (system scope only).
- `selfManagedDbContext: ['add_line','preview','preflight']` on `manage_pax8_orders`, and `['provision_details','dependencies','pricing']` on `search_pax8_products`.
- Line inputs mirror `addLineSchema` / `updateLineSchema` in `routes/pax8Orders.ts` exactly (`.strict()`).

- [ ] Step 1: write the failing tests:
  - `organization scope refused on every tool`;
  - `restricted partner member refused by get_pax8_status and manage_pax8_subscriptions` (`partnerOrgAccess !== 'all'`);
  - `order in an org outside canAccessOrg → FORBIDDEN, service never called`;
  - `site-ceiling session refused on order writes`;
  - `status projection never contains an *_encrypted key or accessToken`;
  - `subscriptions never return raw; companies never return metadata`;
  - `Pax8ApiError body clipped to 2 KB`;
  - `create_draft passes verifiedUserIdOrNull`;
  - `action enums are exact (no map_company / save_integration / test_connection)`;
  - `MFA-less session refused on each write`.
- [ ] Step 2: run both files and expect FAIL.
- [ ] Step 3: implement the handlers through the W15-D3 services, with gates per W15-D4 and projections per W15-D9. Writes call `auditToolWrite` with the route's action names (`pax8.subscription.link_contract_line`, `pax8.order.line.create`, …).
- [ ] Step 4: run both files plus `aiTools.deviceTextFence`, `aiAgentSdkTools.handlerCoverage`, `aiTools.descriptionBudget`, `aiTools.outputBudget`, `aiTools.domainMetadata`, `mcpToolPresentation.guardrailParity`, `aiToolOutput.deviceTextFence`. Expect PASS. Commit `feat(ai-tools): W15 Pax8 tools — status, products, subscriptions, order drafts (#6785)`.

### Task 5 (PR A): approval copy, coverage burn-down, web tier config, docs

**Files:**
- Modify: `services/aiGuardrails.ts` (`buildApprovalDescription` cases), `services/actionIntents/intentService.ts` (description map), `services/actionIntents/actionLabel.ts`, `services/mcpCoverage.ts`, `__tests__/mcp-coverage.test.ts` (`FROZEN_GAPS` −2), `apps/web/src/components/ai-risk/tierConfig.ts`, `apps/docs/src/content/docs/features/ai.mdx`, `apps/docs/src/content/docs/features/mcp-server.mdx`.
- Tests: `aiGuardrailsTierConfig.parity`, `aiGuardrailsAiDocs.parity`, `mcp-coverage`, `approvalLabels.contract`, `agentToolCatalog.contract` (unreachable-set snapshot).

- [ ] Step 1: run the listed tests and expect red on the new names.
- [ ] Step 2: add the entries. The link card says "decides which contract line later Pax8 orders bill"; the unlink card says "staged changes on this subscription will be refused".
- [ ] Step 3: run them and expect PASS. Commit.

### Task 6 (PR A): index, golden prompts, prompt-size gate

**Files:** Modify `services/aiToolIndex.ts` (billing vocabulary), `services/llm/toolEval/goldenPrompts.ts` (g114, g115). Test: `aiToolIndex.test.ts`, `aiAgent.toolIndexPrompt.test.ts`.

- [ ] Step 1: measure B1, B2 and B3 on the branch and on main. Fill the Budget table with the measured values.
- [ ] Step 2: run the two index tests and the golden-prompt count test. Expect PASS. Commit.

### Task 7 (PR A): integration suite, merge main, PR

**Files:** Create `__tests__/integration/aiToolsPax8Scope.integration.test.ts`.

Cases:
- the classes;
- partner B cannot read partner A's integration, subscriptions or orders (`NOT_FOUND`, zero rows);
- a restricted member is refused by `get_pax8_status`;
- link / unlink round-trip within one org;
- a cross-org contract line is refused;
- `create_draft` returns the existing mutable draft;
- `add_line` change / cancel against a mocked Pax8 dependency fetch;
- `preview` writes nothing;
- no `*_encrypted` value appears in any output.

- [ ] Step 1: write the suite. Guard-flip one gate, see red, then restore it.
- [ ] Step 2: run `pnpm test-stack up`, run the suite, then `pnpm test-stack down`.
- [ ] Step 3: merge `origin/main` (never rebase), typecheck with `NODE_OPTIONS=--max-old-space-size=20480 pnpm exec tsc --build apps/api/tsconfig.tests.json` (check the exit code, never pipe to tail), run the contract sweep, and open PR A. The sign-off boxes are W15-D11 and W15-D12.

### Task 8 (PR B): claim hook in the money-critical transaction

**Files:** Modify `services/pax8OrderSubmit.ts`, `services/pax8OrderSubmitRepository.ts`, `services/pax8OrderService.ts` (`getOrCreateDraftOrder` `actorUserId: string | null`; lands in PR A with T4 if A needs it first). Test `services/pax8OrderSubmit.test.ts`, `services/pax8OrderSubmitRepository.test.ts`.

**Interfaces — Produces:**
- `submitOrder(input: { partnerId; orderId; actorUserId; verifyClaim?: (bundle: SubmitBundle, database: Database) => Promise<void>; onPreflightFailure?: 'terminal' | 'reopen' })`. The default is `'terminal'`, today's REST behavior.
- `Pax8OrderSubmitRepository.claimOrder(input: { …; verifyClaim? })`. The returned bundle carries the claimed integration generation (fact 12).
- `Pax8OrderSubmitRepository.createClient(bundle)` refuses `Pax8IntegrationGenerationChangedError` when the live row no longer matches the bundle's generation.
- `Pax8OrderSubmitRepository.reopenUnsentOrder(bundle, error: string): Promise<SubmitResult>`. It is a CAS on `status = 'submitting'`, the claimed `submittedAt`, and every line `pending`. The order goes back to its pre-claim status and `submittedBy` / `submittedAt` are cleared.
- The hook runs inside the claim transaction, after `validateDirectOrderLinesForSubmit` and the duplicate-target check, and before the transaction returns. A throw propagates and rolls the claim back.
- **OD-1 (if accepted as recommended):** `updateManualContractQuantity` gains an approved-baseline CAS, in `persistSubmitResults` and in `persistReconcileResults`. A change matches `manual_quantity = authorizedBaselineQuantity`; a quote-created new line matches the quantity the material pinned. On a conflict the remote outcome is recorded (`succeeded`) and the line carries a `billing_conflict` error. It is never thrown away, and `manual_quantity` is not overwritten.

- [ ] Step 1: write the failing tests:
  - `verifyClaim refuses a drift inside the claim transaction` (the order keeps its pre-claim status, no `claimLines`, no client call);
  - `verifyClaim sees the lines read after the parent-row claim, not a pre-claim read` (every line mutation takes that parent lock first, fact 5);
  - `an unchanged order verifies and submits from draft, awaiting_details and ready` (the material never pins raw `status`, quorum Q2);
  - `onPreflightFailure reopen: a failed post-claim isMock returns the order to its pre-claim status, lines pending, nothing sent` (quorum Q3);
  - `createClient refuses when the integration URL or credential ciphertext changed after the claim` (quorum Q4);
  - OD-1: `a billing edit during mocked Pax8 HTTP is not overwritten; the succeeded line is recorded with billing_conflict`, in both submit and reconcile (quorum Q6);
  - `omitted options leave REST behavior unchanged` (the existing suite stays green).
- [ ] Step 2: run them and expect FAIL. Step 3: implement. Step 4: run them and expect PASS. Commit `feat(pax8): optional claim-time verification hook for approved submits (#6785)`.

### Task 9 (PR B): digest, four-eyes submit, reconcile

**Files:**
- Create: `services/actionIntents/pax8OrderDigest.ts`, `services/actionIntents/effectDigest.w15b.test.ts`, `services/aiToolsPax8OrderSubmit.test.ts`.
- Modify: `effectDigest.ts` (resolver, loaded on demand like the accounting one), `pinnedEffectPolicy.ts`, `pax8OrderPreview.ts` (`previewDigest`, `submitWith`), `aiToolsPax8Orders.ts`, `aiToolSchemasPax8.ts`, `aiGuardrails.ts` (four-eyes, supervised, card), `aiToolExposure.ts` (`AGENT_HUMAN_ONLY_ACTIONS`), `aiToolMfaGate.ts`.

**Interfaces — Produces:**
- `pax8OrderDigestMaterial(database: Database, orderId: string): Promise<Record<string, unknown> | null>`.
- The resolver returns `material(canonicalJson({ v: 1, order: … }))`, `TARGET_ABSENT` for an unknown id, and `MISSING_ARG` without `orderId`.

- [ ] Step 1: write the failing tests.
  - `effectDigest.w15b`:
    - `digest changes when a line quantity, sortOrder, provisioning detail, commitmentTermId, snapshot unitCost, derived active commitment, contract-line manualQuantity or unitPrice (new lines included), contract-currency catalog price, company mapping, integration apiBaseUrl or credential ciphertext changes`;
    - `digest does NOT change on a snapshot lastSeenAt bump, an access-token refresh, or the claim's own draft → submitting transition`;
    - `submit requires a pinned digest`.
  - `aiToolsPax8OrderSubmit`:
    - `PRICE_CHANGED / COMMITMENT_CHANGED refuse before any DB write` (dependencies re-fetched for change and cancel lines too, quorum Q7);
    - `no isMock call happens before verifyClaim passes` (quorum Q3);
    - `PREFLIGHT_FAILED reopens the order; it is not marked failed`;
    - `the approval card says "estimated" and names every CANCEL as terminal with its commitment term` (quorum Q7 / Q8);
    - `PREVIEW_MISMATCH when an expectedLines field disagrees with the recompute`;
    - `COST_UNKNOWN (incl. an increase with null snapshot unitCost), COMMITMENT_AMBIGUOUS and > 20 lines refused`;
    - `a re-delivered release is refused by the claim, never re-sent`;
    - `submit is agent-human-only`;
    - `reconcile is supervised and MFA-gated`.
- [ ] Step 2: run them and expect FAIL. Then run `effectDigestCoverage.contract` and expect red for the new four-eyes surface until the resolver exists.
- [ ] Step 3: implement the W15-D6 release sequence.
- [ ] Step 4: run all of them plus the T3 contract sweep. Expect PASS. Commit.

### Task 10 (PR B): integration suite

**Files:** Create `__tests__/integration/aiToolsPax8OrderSubmitScope.integration.test.ts`. The Pax8 client is mocked at `createPax8ClientForIntegration`.

Cases:
- partner B cannot submit partner A's order (nothing written, no client call);
- an edit between intent creation and release → `content_changed`;
- an edit between the release digest check and the claim (injected in `verifyClaim`) → `PREVIEW_MISMATCH`, order still `draft`;
- an approved submit with a mocked success writes `manual_quantity` on the linked line;
- a mocked timeout → `needs_reconcile`, and `reconcile` resolves it from the mocked `listOrders`.

- [ ] Step 1: write it, guard-flip `verifyClaim`, and see red. Step 2: run it on the test stack, then tear down.

### Task 11 (PR B): copy, docs, golden prompt, PR

- [ ] Step 1: update the submit and reconcile approval copy, `tierConfig.ts`, the docs pages and g116. Run the T5 parity tests.
- [ ] Step 2: merge main, typecheck, run the sweep, and open PR B with `Closes #6785` and the W19 table. Chat smoke g116 with a live key is a "Needs Todd" box.
