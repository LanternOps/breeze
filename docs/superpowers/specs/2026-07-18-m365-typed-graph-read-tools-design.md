# M365 Typed Graph Read Tools — Design

**Date:** 2026-07-18
**Status:** Approved design, pre-implementation
**Depends on:** `2026-07-13-breeze-m365-control-plane-design.md` (foundation, PR #2495) and `2026-07-14-breeze-m365-customer-graph-read-consent-design.md` (customer-graph-read consent, PR #2511)

## 1. Purpose

Deliver the first consumer value from the `customer-graph-read` connection: a closed,
typed catalog of Microsoft Graph **read** actions exposed as Breeze AI tools (in-app AI
agent and Breeze MCP server). This is the "typed action catalog / read executors" slice
of the control-plane design (§9 and delivery stage 4 of the 2026-07-13 spec), restricted
to risk-tier T1 (immediate read) so it requires **no intent/approval layer**.

Everything stays inside the existing trust boundary: the `m365-graph-read-executor`
remains the only workload that holds the certificate or Microsoft tokens; the API remains
the control plane that authorizes, rate-limits, and audits; callers (AI sessions) can
never choose a tenant, see a credential, or send an arbitrary Graph URL.

## 2. Scope and non-goals

**In scope**

- A discriminated-union read-action contract in `packages/shared/src/m365/`.
- One new bounded executor operation: `POST /v1/read-action`.
- API-side `readActionService` in `apps/api/src/services/m365ControlPlane/` (state
  gates, rate budgets, audit, metrics).
- AI tool registration in a new `apps/api/src/services/aiToolsM365.ts`
  (`registerM365Tools`), gated and site-scope-excluded.
- Rollout flag `M365_GRAPH_READ_TOOLS_ENABLED` + org allowlist.
- Real-tenant runbook additions.

**Non-goals**

- No mutations, no approval flows, no `customer-graph-actions` profile work.
- No web UI (an org-page M365 tab is a possible fast-follow, consuming the same
  `readActionService`).
- No partner API exposure.
- No manifest bump: every action below is covered by the manifest-v2 grants customers
  have already consented to.
- No caching/sync of tenant data into Postgres. Reads are live. A cache can be added
  later behind the same action interface if Graph quota becomes a real constraint.
- No Delegant work, no legacy-path consolidation (separate phases).

## 3. Architecture

```
AI session (agent / MCP)
  → aiToolsM365.ts tool call                      [tool gating + site-scope exclusion]
  → m365ControlPlane/readActionService.ts          [org resolution, state gate,
                                                    rate budget, audit]
  → m365ControlPlane/graphReadExecutorClient.ts    [existing Ed25519-JWT client]
  → executor POST /v1/read-action                  [internal auth, dispatch table]
  → fixed Graph endpoint template                  [graphClient budgets, projection]
  → typed result / typed failure back up the chain
```

No new deployable, no new table, no migration. The executor gains one route beside
`/v1/complete-consent` and `/v1/retest` in `apps/m365-graph-read-executor/src/app.ts`,
with a matching operation in `operations.ts`.

## 4. Authorization ladder (readActionService)

Order matters; each step fails closed with a typed code (§8).

1. **Org resolution.** The acting org comes from the AI session context only. The tool
   input never contains a tenant or org identifier. Partner-scoped sessions act on the
   session's currently selected org. **Site-scoped sessions are refused** and the tools
   are also hidden from their registry (both layers, matching the device site-scope
   contract pattern in `aiTools.deviceAccessSiteScope.contract.test.ts`).
2. **Connection load.** The org's `m365_connections` row with
   `profile = 'customer-graph-read'`. Absent → `connection_not_ready` with guidance to
   run consent.
3. **State gate.** `active` and `degraded` may execute reads. `degraded` is permitted
   because it typically means grant drift; reads whose grant is still present succeed,
   and a removed grant surfaces per-action as `graph_permission_missing` with a retest
   hint. `pending-consent`, `verifying`, `suspended`, `revoked` → `connection_not_ready`
   naming the state and the operator action (consent / retest / re-consent).
4. **Rate budget.** Per-connection Redis token bucket: 30 actions/minute and 2,000
   actions/day (constants, not env vars). Exceeded → `read_rate_limited` with the
   window. This is the API-side analogue of the executor's cumulative probe budgets.
5. **Execute.** Call the executor with the connection's `tenantId` (verified),
   `vaultRef`, `credentialVersion`, and the validated action — the same envelope shape
   `retest` uses today.
6. **Audit + metrics.** One audit event per action: action id, org, connection id,
   outcome code, item count, truncated flag. **Never response payload contents.**
   Prometheus counter `breeze_m365_graph_read_actions_total{action,outcome}`.

## 5. Action catalog (v1)

All actions call `https://graph.microsoft.com/v1.0` only. `$select` is always set by the
executor from a per-action field allowlist; caller-supplied fields are intersected with
the allowlist, never unioned. Page size and page count are capped per action; results
carry `truncated: true` when a cap ended pagination early.

| Action | Graph endpoint (fixed template) | Grant used | Bounded params |
|---|---|---|---|
| `m365.user.list` | `GET /users` | User.Read.All | `$search`/`$filter` (accountEnabled, department), pageSize ≤ 50, ≤ 4 pages |
| `m365.user.get` | `GET /users/{idOrUpn}` | User.Read.All | id or UPN (validated shape) |
| `m365.signins.list` | `GET /auditLogs/signIns` | AuditLog.Read.All | userId or UPN filter optional, time window ≤ 7 days, pageSize ≤ 50, ≤ 2 pages |
| `m365.intune.device.list` | `GET /deviceManagement/managedDevices` | DeviceManagementManagedDevices.Read.All | compliance/os filters, pageSize ≤ 50, ≤ 4 pages |
| `m365.intune.device.get` | `GET /deviceManagement/managedDevices/{id}` | DeviceManagementManagedDevices.Read.All | GUID id |
| `m365.group.list` | `GET /groups` | Group.Read.All | `$search`/type filter, pageSize ≤ 50, ≤ 4 pages |
| `m365.group.get` | `GET /groups/{id}` | Group.Read.All | GUID id |
| `m365.group.members.list` | `GET /groups/{id}/members` | Group.Read.All + User.Read.All | GUID id, pageSize ≤ 100, ≤ 4 pages |
| `m365.org.get` | `GET /organization` | Organization.Read.All | none |
| `m365.org.skus.list` | `GET /subscribedSkus` | Organization.Read.All | none |
| `m365.sites.list` | `GET /sites?search=` | Sites.Read.All | search term required, pageSize ≤ 25, 1 page |
| `m365.site.get` | `GET /sites/{id}` | Sites.Read.All | site id (validated shape) |

Notes:

- `m365.user.list` `$search` requires the `ConsistencyLevel: eventual` header +
  `$count=true`; the executor sets these, callers cannot set headers.
- `m365.signins.list` requires an Entra ID P1/P2 tenant. Microsoft returns a specific
  403 (`Authentication_RequestFromNonPremiumTenantOrB2CTenant`); the executor maps it to
  `graph_license_required` rather than `graph_permission_missing` so the AI does not
  tell a tech to re-consent over a licensing gap.
- Directory audit logs (`/auditLogs/directoryAudits`) and Entra device objects
  (`/devices`) are consciously deferred; the grants exist, so adding them later is a
  catalog addition, not a consent event.
- `DeviceManagementConfiguration.Read.All` and `Application.Read.All` back no v1 action
  (the latter is used by consent reconciliation only). That asymmetry is acceptable —
  the manifest is the consent contract, the catalog is the capability contract, and the
  catalog may lag.

## 6. Contracts (`packages/shared/src/m365/executorContracts.ts`)

Additions, following the existing schema style:

- `readActionRequestSchema` — `z.discriminatedUnion('action', [...])` of the 12 actions,
  each variant with its bounded params, plus the common envelope fields the existing
  requests carry (tenant id, vault ref, credential version, manifest version).
- `readActionResultSchema` — union of per-action typed payloads (projected fields only)
  `| { outcome: 'failed', code: ExecutorFailureCode, retryAfterSeconds? }`. Every list
  payload includes `items`, `truncated`.
- `executorFailureCodeSchema` — extended with `graph_permission_missing`,
  `graph_not_found`, `graph_throttled`, `graph_license_required` (the existing budget and
  transport codes are reused as-is).
- Per-action **field allowlists** exported as constants so executor projection and API
  tests assert the same source of truth.

API-layer refusal codes (`connection_not_ready`, `read_rate_limited`) live in the API,
not the executor contract — the executor never sees a refused request.

## 7. Executor changes (`apps/m365-graph-read-executor/`)

- `app.ts`: `app.post('/v1/read-action', ...)` — same body-size cap, 404-everything-else
  posture, and internal-auth verification as the existing two ops. The internal JWT
  gains an `op: 'read-action'` claim; `internalAuth.ts` requires the claim to match the
  route (as it does today for consent/retest).
- `operations.ts`: `executeReadAction` — validates against the shared schema, acquires
  an app token via the existing certificate `tokenClient` (client_credentials), builds
  the URL from the dispatch table (URL-encodes path params, validates GUID/UPN shapes
  again server-side), executes through `graphClient` with per-action budget overrides,
  projects fields through the allowlist, returns the typed result.
- `graphClient.ts`: unchanged semantics; per-call budget parameters already exist.
  `429` handling added: map to `graph_throttled` with `Retry-After` passthrough
  (bounded to ≤ 300s).
- No SSRF surface: `@odata.nextLink` continuation reuses the existing next-link origin
  enforcement from `reconcile.ts` (extract into a shared helper if not already).

## 8. Error handling

| Code | Layer | AI-facing meaning |
|---|---|---|
| `connection_not_ready` | API | No usable connection; states the lifecycle state and the operator action (consent / retest / re-consent). |
| `read_rate_limited` | API | Per-connection budget exhausted; retry window included. |
| `graph_permission_missing` | executor | Grant absent in tenant (drift); suggest Retest on the M365 card. |
| `graph_license_required` | executor | Tenant lacks Entra ID P1/P2 (sign-in logs only). Not a consent problem. |
| `graph_not_found` | executor | Target object does not exist. |
| `graph_throttled` | executor | Microsoft 429; retry after N seconds. |
| `graph_response_too_large`, `graph_request_timeout` | executor (existing) | Budget exceeded; narrow the query. |

Every failure renders in the tool result as a short human sentence plus the stable code,
so the model can relay accurate guidance instead of improvising. Failures are audited
with the same event as successes (outcome field differs).

## 9. AI tool surface (`apps/api/src/services/aiToolsM365.ts`)

- `registerM365Tools(...)` imported by the `aiTools.ts` hub, matching the sibling
  `registerC2CTools` / `registerIntegrationTools` pattern.
- Roughly one tool per action group: `m365_query_users` (list+get),
  `m365_query_signins`, `m365_query_intune_devices` (list+get), `m365_query_groups`
  (list+get+members), `m365_query_org` (org+skus), `m365_query_sites` (list+get).
  Tool descriptions state the caps ("returns at most N…") so the model plans queries
  instead of paging forever.
- Registered in **both** tool gate maps (the known dual-map drift trap) and excluded
  from site-scoped sessions in the registry; `readActionService` re-checks scope so the
  service is safe even if a future registration misses the exclusion.
- Tools are only registered when `M365_GRAPH_READ_TOOLS_ENABLED` is on and the org is
  allowlisted; an org without an active connection still sees the tool (so the AI can
  say "connect M365 first") but every call returns `connection_not_ready`.

## 10. Rollout

- New env: `M365_GRAPH_READ_TOOLS_ENABLED` (default `false`) +
  `M365_GRAPH_READ_TOOLS_ORG_ALLOWLIST` (comma-separated org ids, `*` last), parsed in
  `m365ControlPlane/runtimeConfig.ts` beside the onboarding flags. Deliberately separate
  from `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED` so consent rollout and tool rollout
  move independently.
- **No DB migration.** Rate budgets in Redis, audit via existing audit events.
- Executor and API deploy in either order: an old executor returns 404 for
  `/v1/read-action`, which the client maps to `executor_unavailable` (existing code);
  a new executor with an old API simply never receives the op.
- Runbook: extend `docs/runbooks/m365-customer-graph-read-real-tenant.md` with a
  read-action acceptance section (each action once; permission-drift scenario reusing
  the approved appRoleAssignment procedure; sign-ins against a non-premium tenant for
  `graph_license_required`).

## 11. Testing

- **Shared:** schema round-trips for every action variant; bound violations rejected;
  field-allowlist constants match result schemas.
- **Executor:** per-action dispatch tests (exact URL, encoded params, header injection
  for `$search`, projection drops non-allowlisted fields), 403/404/429/license-error
  mapping, budget enforcement, next-link origin enforcement, internal-auth `op` claim
  mismatch → 401. Extends the existing suite/patterns.
- **API:** `readActionService` state-gate matrix (all six lifecycle states), rate-budget
  exhaustion, site-scope refusal, audit emission shape, executor-failure passthrough.
- **aiTools:** registration parity (both gate maps), site-scope exclusion contract test
  alongside the existing device one.
- **Runbook:** real-tenant acceptance additions per §10.

## 12. Future work (explicitly out of this phase)

Org-page M365 UI tab on `readActionService`; directory-audit + Entra-device actions;
result caching; `customer-graph-actions` mutation profile atop the intent/approval
layer; consolidation of legacy Microsoft paths onto the control plane.
