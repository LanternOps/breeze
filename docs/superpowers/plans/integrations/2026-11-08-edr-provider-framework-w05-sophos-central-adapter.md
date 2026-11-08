---
tracking_issue: LanternOps/breeze#8164
wave_issue: LanternOps/breeze#8169
---
# EDR W05 — Sophos Central adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP connects a Sophos Central API credential (partner, organization or single tenant) to Breeze; each Sophos tenant maps to one Breeze org, endpoints link to Breeze devices, threat alerts arrive as EDR detections and close when they are cleared in Sophos Central, and (once the lab proves it) the MSP can isolate, release and scan an endpoint through the existing W03 action path.

**Architecture:** A fourth vendor directory, `services/edrProviders/sophos/{client,normalize,adapter}.ts`, registered in `providerKeys.ts` + `registry.ts` like GravityZone and Emsisoft. Sophos is the first OAuth vendor, the first with a per-tenant API host and the first whose detections carry **no status at all**, so planning against HEAD found four framework gaps. They are fixed vendor-neutrally in a framework PR **first** (W05.1): one live mapping per vendor tenant across connections, an explicit status-only "closed" update in the re-read contract, fresh-host routing, and an opt-in provider-wide rate window. The adapter PR (W05.2) then needs no framework change. The credential's reach is a per-connection fact (`vendor_root_type` = whoami `idType`), not a capability: `capabilities.tenantModel` stays `'partner'` statically, the GravityZone precedent.

**Tech Stack:** Hono, Drizzle (queries only) + one hand-written SQL migration, PostgreSQL RLS, BullMQ, Redis, Vitest.

**Spec:** `docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md` §3.1, §3.2, §4.3 (adapter interface + cursor contract), §4.4, §4.6, §4.9, §4.10, D3, D13. **Read the index first** (`2026-10-01-edr-provider-framework-index.md`: the W05 section, corrections 4, 8, 9). Use the W03 plan (`2026-10-13-…-w03-response-actions.md`) as the action contract and the W04 plan (`2026-10-17-…-w04-emsisoft.md`) for the re-read model (its Task A5). W01–W04 are merged (W04 PR-A #10159; W04 PR-B was never opened, so Emsisoft has no actions); W06.1/W06.2 are merged and W06.3 (lab flip) is open. Written against `origin/main` at `3444fa405d` (2026-11-08).

Epic: #8164 · Wave sub-issue: #8169 · Request: #3135. PR bodies say `Refs #8169 #3135` / `Part of #8164`; only W05.2 carries `Closes #8169`. Never write a closing keyword for #3135 (the orchestrator closes the request once the adapter is live) or #8164. Branches: `feature/8164-edr-provider-framework/wave-8169` (W05.1), `…/wave-8169-sophos` (W05.2, cut from `main` after W05.1 merges; a stacked branch runs **no CI** — `gh workflow run CI --ref <branch>` if you ever stack). W05 and W07 are file-disjoint and can run in parallel (both add a migration — see Global Constraints).

## Vendor API facts (verified 2026-11-08 against developer.sophos.com OpenAPI specs `whoami-v1.yaml`, `partner-v1.yaml`, `endpoint-v1.yaml`, `common-v1.yaml` and the getting-started / rate-limits / errors pages)

Items marked **[U]** are unconfirmed and are settled by the owner lab (Task 2.8). The spec matrix (§3.1) is corrected below where the published API differs.

| Need | Call | Shape (fields this plan uses) |
|---|---|---|
| Token | `POST https://id.sophos.com/api/v2/oauth2/token`, form `grant_type=client_credentials&client_id&client_secret&scope=token` | `access_token` (JWT), `expires_in` 3600, `errorCode`. Bad secret → 401 `oauth.invalid_client_secret` **[U]** (community source). |
| Root | `GET https://api.central.sophos.com/whoami/v1` | `id`, `idType` ∈ `partner \| organization \| distributor \| tenant`, `apiHosts.global`, `apiHosts.dataRegion` (tenant only). |
| Tenants | `GET /partner/v1/tenants` (`X-Partner-ID`) or `GET /organization/v1/tenants` (`X-Organization-ID`) on the global host; `page`/`pageSize`/`pageTotal` | `id, name, showAs?, dataRegion, apiHost` (**required** uri), `status?` (active/canceled/suspended). Regions: eu01 eu02 us01 us02 us03 ca01 au01 jp01 in01 br01 ae01. |
| Tenant calls | the tenant's `apiHost` + `X-Tenant-ID`; a partner/organization token works | — |
| Endpoints | `GET /endpoint/v1/endpoints?pageFromKey&pageSize&view=full` | `id, type (computer\|server\|securityVm), tenant.id, hostname, os{platform windows\|linux\|macOS, isServer, name}, ipv4Addresses, ipv6Addresses, macAddresses, health.overall (good\|suspicious\|bad\|unknown), isolation{status isolated\|notIsolated, adminIsolated, selfIsolated}, online, tamperProtectionEnabled, assignedProducts[{code,version}], group{name}, lastSeenAt, serialNumber` (**Macs only**), `associatedPerson` (not stored). Max `pageSize` undocumented (example `maxSize` 100). |
| Alerts | `GET /common/v1/alerts?from&product&category&ids&sort&pageFromKey&pageSize` | `id, category (40-value enum), description, groupKey, managedAgent{id,type,name}, person, product, raisedAt, severity (high\|medium\|low), tenant{id}, type, allowedActions`. **No `status`, no `updatedAt`.** `from` = "raised on or after" (inclusive). `ids` has no declared max. |
| Alert by id | `GET /common/v1/alerts/{alertId}` | Documented responses: 200 and 500 only. **What it returns for an acknowledged alert is [U]** (Task 2.8 L4). |
| Isolation | `GET` / `PATCH /endpoint/v1/endpoints/{id}/isolation` `{ enabled, comment ≤400 }` | 200 `{ enabled, lastEnabledAt, … }` = the **requested** state, not completion; 404; **409 already in progress**. Bulk `POST …/endpoints/isolation` (≤500, 202) exists — not used. |
| Scan | `POST /endpoint/v1/endpoints/{id}/scans` `{}` | 201 `{ id, status: 'requested', requestedAt }`; **no status read**. |
| Installer | `GET /endpoint/v1/downloads` | Not used in W05 (Open Decision 5). |
| Rate limits | per credential, per account **and per originating IP** for s/min/h; per account + credential for the day | 10/s (recommended), **100/min (enforced, bursts to 300)**, 1,000/h (recommended), **200,000/day (enforced)**. 429 with **no `Retry-After`**; Sophos advises full-jitter exponential backoff (base 1 s, cap 30 s). Whether the token call counts is **[U]**. |
| Errors | body `{ error, message?, correlationId?, requestId?, code? }` | Status for a tenant the partner lost access to, and for a missing role, is **[U]** (likely 403). |
| Roles | Super Admin / Management / Forensics / Read-Only service principals | Permissions used: `endpoint-state:read`, `endpoint-state:update` (isolation, scan), `alerts:read`, partner tenant listing. Role → permission mapping **[U]**. |

## Spec and index corrections (found while planning; quorum-reviewed)

1. **W05 is not "adapter only, 1 PR".** Adding `'sophos'` to `EDR_PROVIDER_KEYS` forces a migration: `builtinProviderCheck.test.ts:25` pins `software_catalog_integration_provider_chk` to every EDR key (latest CHECK: `migrations/2027-01-21-130000-edr-installer-dispatch.sql:18`). And four framework gaps (below) make the interface insufficient as built. Index: "if it does [need a framework change], that is an interface bug to fix in the framework" — hence W05.1.
2. **Duplicate tenant ownership (framework bug, tenancy).** D3 allows many connections per provider per partner, and nothing stops a partner key and a customer's own tenant key (or an organization key) from reaching the **same** Sophos tenant. Each connection then has its own `edr_tenants` row, and the two rows can be mapped to **two different orgs** — one customer's endpoints and detections shown in another customer's org (and portal). W06's installer ambiguity check is per org (`installerTenant.ts:118`), so it does not catch this. GravityZone and Emsisoft have the same hole; Sophos's three credential kinds make it likely. Fixed in W05.1 Task 1.1.
3. **The re-read contract cannot express "closed".** `types.ts:233-237` says a ref the vendor cannot find "is omitted and never closed", and `EdrDetectionStatusUpdate` requires a severity that a closure cannot supply (`applyDetectionStatusUpdates` overwrites it, `persist.ts:681`). Sophos alerts have no status field; the only closure signal is absence. Amended explicitly in W05.1 Task 1.2 (opt-in `closed` update; severity preserved), not by reinterpreting the doc comment.
4. **The inventory job prefers a stale host.** `edrProviderSync.ts:800` builds `apiHost: known?.apiHost ?? t.apiHost`, so a stored host overrides both a region move and a freshly rejected host. Fixed in W05.1 Task 1.3.
5. **No provider-wide budget scope.** §4.4 asks for budgets "at overlapping scopes"; only credential + operation class were built (`rateLimiter.ts`). Sophos meters per originating IP as well, so every Sophos connection on one deployment shares a window. W05.1 Task 1.4 adds an opt-in `providerBudget` (Redis is per region, so a per-deployment key ≈ per egress IP).
6. **`whoami.idType` has a fourth value, `distributor`.** Refused by `testConnection`.
7. **Alerts: no status, no update time; acknowledged-alert behaviour is unproven** (UI docs say acknowledging removes an alert from the list). The index anticipated an `open_set` model; this plan uses the existing `reread_open_on_inventory` model plus the amended `closed` update, with a two-signal closure proven in the lab (Task 2.4).
8. **Serial exists but only Macs report it** → not an `endpointIdentifier` (index correction 9's serial tiebreak stays deferred); the value is stored.
9. **Detections v1 REST is deprecated** (and the classic XDR API deprecation was announced 2026-09-18), so §4.4's "and Detections v1 where licensed" is dropped: Common alerts only.
10. **Isolation `GET` reports the requested state**, and `PATCH` returns 409 while a change is in progress. Containment truth is the endpoint's `isolation.status` in inventory.
11. **§4.3's `tokenCache` on the context was never built** (`context.ts`). W05 caches the token in the per-run `ctx.runCache` (one token per context); no framework cache.
12. **Host allowlist:** spec §4.9's `['.central.sophos.com', 'id.sophos.com']` is right; `api.central.sophos.com` is covered by the suffix, and the adapter adds a strict regional-origin check on every tenant call.

## PR split

- **W05.1 — framework fixes** (vendor-neutral; **high** blast radius: tenancy, the sync job, the limiter; full TDD; one Opus review round). No migration, no vendor code, no AI or route-shape change. GravityZone/Emsisoft suites pass unmodified except where a test pins the new refusal.
- **W05.2 — Sophos adapter** (medium–high: OAuth, per-tenant hosts, remote actions). One migration (CHECK), the vendor directory, registry/labels, contract-test updates, docs. **Held unmerged until the owner lab (Task 2.8) records the read legs.** If the action legs fail, ship with `capabilities.actions = []` and file a follow-up (the read path does not wait for actions). If the closure leg fails, ship with closure disabled (absent alerts stay open) and take Open Decision 2 to Todd.

Why two PRs and not the index's one: W05.1 changes behaviour for every EDR provider (a mapping that used to succeed can now be refused), touches tenancy, and deserves its own review; W05.2 then stays an adapter PR the index intended.

## Global Constraints

- **No vendor name outside the vendor directory, the two registries and the two label maps.** If any framework file needs `provider === 'sophos'`, the interface has a bug: fix it in the framework (W05.1), never as a Sophos special case.
- **No pooled DB connection is held across vendor HTTP** (#1105 / #1896). The adapter and client are DB-free; every vendor call runs in Phase 2 under `runOutsideDbContext`, or on the W03 action path outside the DB context.
- **All-or-nothing per tenant.** A page failure throws and is never returned as a partial list. A list past its page cap throws `too_many_*`, except the detection delta's bounded catch-up (Task 2.4), which never skips an item.
- **A Sophos tenant's data lands only in the org its tenant row is mapped to.** Every endpoint and alert item's `tenant.id` must equal the requested tenant, or the whole tenant fetch throws `tenant_mismatch` (tenant scope) and nothing is persisted for it that run. Request headers are built per call (`X-Tenant-ID` from the ref), never from shared mutable state.
- **Hosts.** `hostAllowlist = ['id.sophos.com', 'api.central.sophos.com', '.central.sophos.com']`. Root calls go only to `https://api.central.sophos.com`; tenant calls only to a host matching `SOPHOS_TENANT_ORIGIN = /^https:\/\/api-[a-z]{2}\d{2}\.central\.sophos\.com$/`, checked in the normalizer **and** before every tenant request (reads, re-reads, actions, reconciliation). `baseUrlPolicy: null`.
- **Credentials and tokens are never logged, echoed or put in an error message.** The client secret goes only in the token form body; the bearer token only in the `Authorization` header. Token responses are never logged or included in errors. Error messages carry method, HTTP status and the path **template** (`/endpoint/v1/endpoints/{id}/isolation`) — never a query, id, tenant name, token or body.
- **Writes are never retried** (W03): `PATCH …/isolation` and `POST …/scans` that may have reached the vendor and got a timeout, 5xx or malformed 2xx throw `code: 'outcome_unknown'` for the reconciler. Reads retry ≤3 times with full-jitter backoff.
- **Fixtures are synthetic** (see "Fixture anonymisation"). Public repo.
- **Tests:** API `cd apps/api && npx vitest run <files>` (no `--` before flags; never `pnpm --filter … test -- --run`; vitest path filters are substring matches); web `cd apps/web && npx vitest run <files>`. Typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?` — read the exit code, never pipe to `tail`. On a loaded host run small batches.
- **Migration slot.** W05.2's migration is `apps/api/migrations/2027-01-23-110000-edr-catalog-provider-chk-sophos.sql`. Newest committed at plan time: `2027-01-22-210300-device-watchdog-edition.sql`; open PRs hold `2027-01-22-210100` (#11295) and `2027-01-22-220000…220300` (#10918); W07 plans `2027-01-23-100000`. Re-check at Task 2.0 and **rename before merge** if a newer migration lands (a merged newer migration poisons the merge queue's Check Migrations).

## Migration & tenancy statement

- **W05.1: no migration.** The single-mapping guard is a transaction-scoped advisory lock plus a check, not a constraint: a unique index would need a denormalized `provider` column on `edr_tenants` (with backfill and a composite FK to keep it honest) and would fail to build on any duplicate that already exists in production. The lock serializes every writer that can set `edr_tenants.org_id` non-null; a contract test pins that there are exactly two such writers and that both take it.
- **W05.2: one migration** (name above): `ALTER TABLE software_catalog DROP CONSTRAINT IF EXISTS software_catalog_integration_provider_chk;` then `ADD CONSTRAINT software_catalog_integration_provider_chk CHECK (integration_provider IS NULL OR integration_provider IN ('huntress','sentinelone','bitdefender','emsisoft','sophos'));`. Idempotent, no inner `BEGIN/COMMIT`, writes no rows (no `set_config`). Never edit the 2027-01-21 file. Then `pnpm db:check-drift`.
- **RLS shapes unchanged:** no new table or column. `edr_tenants` stays shape 3 (partner axis, nullable mapping target); `edr_endpoints`/`edr_detections`/`edr_actions` shape 1.
- **Registration lists** (`docs/agents/tenancy-rls.md`; grep, don't judge): `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`, device/ticket lists — **no change** in either PR. Sophos `details` / endpoint `raw` land in existing `jsonb` columns already `excludedOpen`. The cascade/export/merge suites still run (Integration Tests) because W05.1 touches mapping.
- **Partner-wide first:** no config/policy table. **Settings rule 9:** no setting is added; connections keep their one home, Integrations → Security (places configured: 1 → 1).

## AI tool exposure

**No AI registry change in either PR.** The AI EDR tools take `provider` as a free string (`aiToolsEdr.ts:134`); `edr_endpoint_action` is keyed by normalized action, so Sophos isolate/unisolate/scan need no new tier row, schema or tool. No new route, so `mcp-coverage.test.ts` gains nothing. The incidents feed `source` enum derives from `EDR_PROVIDER_KEYS` (`incidents.validation.ts:49`) and gains `sophos` automatically — its test is updated in Task 2.1. No byte-budget movement (no tool description changes).

## Agent statement

No agent change and no agent release. (Agent-side Sophos detection already exists: `mgmtdetect` "Sophos Endpoint" and `providerFromName` `sophos`.)

## Review Focus

1. **The same Sophos tenant reached by two connections** (partner key + the customer's own tenant key, or an organization key). Expected: whichever is mapped second is refused with 409 `tenant_mapped_elsewhere` naming the other connection, regardless of target org; two concurrent mapping requests → exactly one commits; auto-map skips a claimed tenant. Pinned in Task 1.1 (real Postgres, concurrent) and lab leg L2.
2. **An alert acknowledged in Sophos Central, and a vendor glitch that returns an empty list.** Expected: acknowledged → the detection resolves within one inventory run (severity and `notified_severity` untouched; its Breeze alert auto-resolves); empty-list glitch → nothing closes unless the per-id read also says "gone"; the confirmation calls are capped per tenant per run. Pinned in Tasks 1.2 and 2.4; L4 proves the vendor semantics.
3. **A tenant moved to another data region, or a whoami/tenants response carrying a hostile `apiHost`** (`https://api-eu01.central.sophos.com.evil.test`, `http://…`, an IP literal). Expected: the fresh host is used the next inventory run; a rejected host fails that tenant only, with zero requests to the rejected or the old host. Pinned in Tasks 1.3 and 2.2.
4. **A partner that lost access to one customer tenant, or a credential with a Read-Only role.** Expected: that tenant fails as a tenant (connection stays `connected`, other tenants sync); a Read-Only role can sync but an isolate fails with a clear "role cannot perform this action" (no reauth, no tenant licence denial recorded). Pinned in Tasks 2.2 and 2.5; L5/L6 record the real status codes.
5. **Many Sophos connections on one deployment** (per-IP metering). Expected: calls queue in the provider-wide window instead of tripping 429s; a 429 still backs off without flipping the connection to `reauth_required`. Pinned in Tasks 1.4 and 2.2.

---

# W05.1 — Framework fixes (vendor-neutral)

## File Structure (W05.1)

| File | Change |
|---|---|
| `apps/api/src/services/edrProviders/mappingGuard.ts` (+ test) | Create: `lockAndFindOtherMapping`, `EdrTenantClaimedError` |
| `apps/api/src/services/edrProviders/mapping.ts` | `remapEdrTenant` and `autoMapEdrTenants` take the guard |
| `apps/api/src/routes/edr/tenants.ts` (+ test) | 409 `tenant_mapped_elsewhere` |
| `apps/api/src/services/edrProviders/mapping.writer.contract.test.ts` | Create: only two `org_id` writers, both guarded |
| `apps/api/src/__tests__/integration/edrTenantMappingGuard.integration.test.ts` | Create |
| `apps/api/src/services/edrProviders/types.ts` | `EdrDetectionStatusUpdate` gains a `closed` variant; `capabilities.closesAbsentDetections?`, `providerBudget?`; contract doc amended |
| `apps/api/src/services/edrProviders/persist.ts` (+ test) | `applyDetectionStatusUpdates` handles `closed` (severity preserved) |
| `apps/api/src/jobs/edrProviderSync.ts` (+ test) | Fresh validated host; refuse `closed` updates from adapters that do not declare `closesAbsentDetections` |
| `apps/api/src/services/edrProviders/rateLimiter.ts`, `context.ts` (+ tests) | Provider-wide windows |
| `apps/web/src/components/integrations/…EdrTenant…` mapping table (+ test), `apps/web/src/locales/*/…` ×8 | Render the 409 reason (existing `runAction` toast path; one new string) |

## Execution split and parallelism (W05.1)

- **Order:** 1.0, then **PARALLEL GROUP A** {1.1 mapping guard (`mappingGuard.ts`, `mapping.ts`, `routes/edr/tenants.ts`, web table), 1.2 closed updates (`types.ts` update type, `persist.ts`), 1.4 provider budget (`rateLimiter.ts`, `context.ts`, `types.ts` capability field)} — file-disjoint except `types.ts`, where 1.2 and 1.4 add **different** declarations (merge trivially; 1.2 lands first if run by one agent). Then 1.3 (`edrProviderSync.ts`, consumes 1.2's capability flag), then 1.5.
- **Sonnet-eligible:** the web half of 1.1 (one string × 8 locales). Everything else Opus.

### Task 1.0: Preflight

- [ ] `git fetch origin && git rebase origin/main`; `gh issue view 8169` open; `gh pr list --state open --json number,files` shows nothing touching `edrProviders/**`, `edrProviderSync.ts`, `routes/edr/**`.
- [ ] `get_feature_status` (#8164) → `start_wave` for #8169; branch `feature/8164-edr-provider-framework/wave-8169`.

### Task 1.1: One live mapping per vendor tenant (tenancy — full rigor)

**Interfaces — Produces:**

```ts
// mappingGuard.ts
export class EdrTenantClaimedError extends Error {
  readonly code = 'tenant_mapped_elsewhere';
  constructor(readonly other: { tenantId: string; connectionId: string; connectionName: string });
}
/**
 * Inside the caller's tx, BEFORE org_id is written: takes
 * pg_advisory_xact_lock(hashtextextended('edr_vendor_tenant:' || partnerId || ':' || provider || ':' || vendorTenantId, 0))
 * and returns another edr_tenants row of the same partner + provider (joined through edr_connections) with the
 * same vendor_tenant_id and org_id IS NOT NULL — any connection state, tombstoned or not — else null.
 */
export async function lockAndFindOtherMapping(
  tx: EdrSyncTx,
  o: { partnerId: string; provider: string; vendorTenantId: string; exceptTenantId: string },
): Promise<{ tenantId: string; connectionId: string; connectionName: string } | null>;
```

Rules: `remapEdrTenant` with `orgId !== null` (including same-org confirm) calls it after the tenant `FOR UPDATE` read and throws `EdrTenantClaimedError` on a hit; unmapping (`orgId === null`) never checks. `autoMapEdrTenants` calls it for each decision **in sorted lock-key order** (deadlock-free: no writer holds a vendor-tenant lock while waiting for a connection lock) and drops claimed decisions (returned as `skippedClaimed: number`). The route maps the error to **409** `{ error: 'This vendor tenant is already mapped through the connection "<name>". Unmap it there first.', code: 'tenant_mapped_elsewhere' }`. A tombstoned or inactive-connection mapping still blocks (the operator unmaps it explicitly). Cross-partner and cross-provider duplicates are allowed. Existing duplicates are not repaired: the PR body carries the count from a read-only query the orchestrator runs per region (`SELECT partner_id, provider, vendor_tenant_id, count(*) FROM edr_tenants JOIN edr_connections … WHERE org_id IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1`).

- [ ] **Step 1: failing tests.**
  - `mapping.writer.contract.test.ts`: `git grep -nE "SET org_id|set\(\{[^}]*orgId" -- apps/api/src` (non-test, excluding org-merge/cascade machinery that only moves or nulls `org_id` — list them explicitly in the test with a reason each) finds `edr_tenants` writers only in `mapping.ts`, and both writer functions' bodies reference `lockAndFindOtherMapping`.
  - `edrTenantMappingGuard.integration.test.ts` (real Postgres, seeded under system scope): partner P, provider `bitdefender`, connections A and B, both with a tenant row for vendor id `V`, orgs X and Y. (a) map A/V→X ok; B/V→Y → `EdrTenantClaimedError`, row unchanged; B/V→X → refused too. (b) unmap A/V → B/V→Y ok. (c) concurrency: two transactions on separate pool connections map A/V→X and B/V→Y simultaneously (`Promise.allSettled`) → exactly one fulfilled, the other `EdrTenantClaimedError`. (d) auto-map: both tenants carry an external code matching X; one sync's auto-map maps one, the other run reports `skippedClaimed: 1`. (e) a third partner Q with its own connection and vendor id `V` maps freely; provider `emsisoft` with vendor id `V` under P maps freely. (f) connection A deactivated with V still mapped → B/V still refused.
  - `routes/edr/tenants.test.ts`: the 409 body and code; no audit row claims success.
- [ ] **Step 2:** implement; web: the mapping table's existing `runAction` error toast shows the server `error` (verify; add the `code`-keyed copy `edr.tenants.mappedElsewhere` in all 8 locales only if the table renders codes, not messages).
- [ ] **Step 3:** unit + integration (under `pnpm test-stack up`) → PASS; existing `mapping.test.ts`, `routes/edr/tenants.test.ts`, `edrProviderSync.test.ts` → PASS. Commit `fix(edr): one live mapping per vendor tenant across connections (#8169)`.

### Task 1.2: Explicit `closed` status updates (contract amendment)

**Interfaces — Produces** (`types.ts`):

```ts
export type EdrDetectionStatusUpdate =
  | { kind?: 'full'; vendorDetectionId: string; vendorKind: EdrVendorKind; status: EdrDetectionStatus; vendorStatus: string | null;
      severity: EdrSeverity; vendorSeverity: string | null; resolvedAt: Date | null; lastVendorUpdateAt: Date | null }   // today's shape
  | { kind: 'closed'; vendorDetectionId: string; vendorKind: EdrVendorKind; status: 'resolved'; vendorStatus: string; resolvedAt: Date };
// EdrCapabilities:
/** Opt-in. The adapter may return `kind: 'closed'` from rereadDetectionStatus. Default false: such updates are dropped and logged. */
closesAbsentDetections?: boolean;
```

Amend the `rereadDetectionStatus` doc comment to: "Returns updates only for refs whose current state the adapter can establish: a `full` update from a vendor record, or — only when `capabilities.closesAbsentDetections` — a `closed` update when the adapter has affirmative, adapter-documented evidence the object is no longer open. A ref whose state cannot be established is omitted and never closed."

- [ ] **Step 1: failing tests** (`persist.test.ts` + a real-row case in `edrProviderSync.integration.test.ts`): a `closed` update sets `status='resolved'`, `vendor_status`, `resolved_at`, bumps `updated_at`, recounts `open_detection_count`, and leaves `severity`, `vendor_severity`, `notified_severity`, `last_vendor_update_at` unchanged; it touches only live open rows of that tenant/org (`detached_at IS NULL`, open statuses); an omitted ref still only rotates; a `full` update without `kind` behaves exactly as today (the Emsisoft cases pass unmodified). After a `closed` update, `resolveClosedDetectionAlerts` resolves that detection's Breeze alert (existing behaviour, pinned once).
- [ ] **Step 2:** implement (`closed` rows in their own `UPDATE … FROM (VALUES …)` batch). **Step 3:** PASS; typecheck exit 0. Commit `feat(edr): status-only closed updates in the detection re-read contract (#8169)`.

### Task 1.3: Fresh validated tenant host; gate `closed` updates

**Files:** `jobs/edrProviderSync.ts` (+ `edrProviderSync.test.ts`).

Behaviour: in the inventory run's Phase 2, the per-tenant ref's `apiHost` is the **fresh** `t.apiHost` from `listTenants`, validated with `validateVendorUrl(t.apiHost, adapter.hostAllowlist)`. Fresh host null → `null`. Fresh host rejected → that tenant's result is `{ ok: false, scope: 'tenant', error: 'api_host rejected' }` with **no** adapter call. Never fall back to the stored host. (The stored host is already rewritten by `upsertTenants`, `persist.ts:123-155`, so the detection stream and actions follow within one inventory run.) In Phase 3, re-read results whose updates include `kind: 'closed'` from an adapter without `capabilities.closesAbsentDetections` drop those updates and `console.warn` once per run with counts only.

- [ ] **Step 1: failing tests:** stored host H1, fresh H2 → `listEndpoints` receives H2; fresh host `https://api-eu01.example.test` with a test adapter allowlist that refuses it → tenant failed, no adapter call (spy), other tenants synced; GravityZone/Emsisoft (fresh host null) unchanged; a `closed` update from an adapter without the flag is not applied.
- [ ] **Step 2:** implement. **Step 3:** PASS. Commit `fix(edr): route tenant calls to the fresh validated host (#8169)`.

### Task 1.4: Opt-in provider-wide budget windows

**Interfaces — Produces:** `EdrCapabilities.providerBudget?: { perSecond?: number; perMinute?: number; perHour?: number; perDay?: number }` — windows keyed `edr:provider:<providerKey>:<window>` and shared by every connection of that provider on this deployment (one Redis per region). `createEdrRateLimiter({ …, providerKey?: string, providerBudget? })` checks them in the same atomic acquire as the credential windows; the `actions` reserve applies to them the same way. `buildEdrAdapterContext` passes `adapter.key` and `adapter.capabilities.providerBudget`. `planCadence` is unchanged (it plans per connection; document that provider-wide contention shows up as limiter waits, not longer intervals).

- [ ] **Step 1: failing tests** (`rateLimiter.test.ts`, `context.test.ts`): two limiters with different fingerprints and the same `providerKey` share the provider window (the second blocks/throws `rate_budget_exhausted` past the limit); without `providerBudget` behaviour is byte-identical to today; Redis unavailable still fails closed.
- [ ] **Step 2:** implement. **Step 3:** PASS. Commit `feat(edr): opt-in provider-wide rate windows (#8169)`.

### Task 1.5: W05.1 verification gate + PR

- [ ] API typecheck exit 0; `npx vitest run src/services/edrProviders src/jobs/edrProviderSync src/routes/edr` → PASS (batches).
- [ ] Test stack up: `edrTenantMappingGuard.integration.test.ts`, `edrProviderSync.integration.test.ts`, cascade, both export-policy suites, org-merge registry + merge contract, `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` → PASS; `pnpm test-stack down`.
- [ ] One independent review round (Opus): lock coverage of every `org_id` writer, deadlock order, closure semantics (severity untouched), host fallback removed, limiter unchanged without opt-in.
- [ ] PR (base `main`): `fix(edr): one mapping per vendor tenant, status-only closures, fresh tenant hosts, provider-wide budgets (#8169)`; body `Refs #8169 #3135`, `Part of #8164`, behaviour change for GravityZone/Emsisoft (a duplicate mapping is now refused), the per-region duplicate count, settings rule 9: none, no migration. **No closing keyword.**

---

# W05.2 — Sophos Central adapter

## File Structure (W05.2)

| File | Change |
|---|---|
| `apps/api/migrations/2027-01-23-110000-edr-catalog-provider-chk-sophos.sql` | Create |
| `apps/api/src/services/edrProviders/providerKeys.ts`, `registry.ts` | `'sophos'`, label `'Sophos Central'` |
| `apps/api/src/services/edrProviders/sophos/client.ts` (+ test) | Token, whoami, tenants, endpoints, alerts, isolation, scan; error table |
| `apps/api/src/services/edrProviders/sophos/normalize.ts` (+ test) | Tenant / endpoint / alert mapping; category table |
| `apps/api/src/services/edrProviders/sophos/adapter.ts` (+ test) | `EdrProviderAdapter` |
| `apps/api/src/services/edrProviders/sophos/__fixtures__/*.json` | Synthetic |
| `apps/web/src/lib/edrProviders.ts:422` (+ `__tests__/edrProviders.test.ts`) | `sophos: 'Sophos Central'` |
| Contract/test updates | `registry.test.ts:33`, `capabilities.test.ts`, `guardedFetch.test.ts`, `services/logRedaction.test.ts`, `builtinProviderCheck.test.ts` (passes via the migration), `routes/incidents.validation.test.ts`, `routes/edr/providers.test.ts`, `edrProviderSync.test.ts` |
| `apps/api/src/__tests__/integration/edrProviderSync.integration.test.ts` | Sophos-shaped rows |
| `apps/docs/src/content/docs/features/edr-provider-framework.mdx` | Sophos section |

## Execution split and parallelism (W05.2)

- **Order:** 2.0 → 2.1, then **PARALLEL GROUP B** {2.2 client (`client.ts`), 2.3 normalizer (`normalize.ts`)} — file-disjoint; the seam is the DTO types, which 2.1 creates in `client.ts` (zod schemas + `export type SophosTenant/SophosEndpoint/SophosAlert/SophosWhoami`) so 2.3 can import them. Then 2.4 (adapter read path) → 2.5 (adapter actions, same file) → **PARALLEL GROUP C** {2.6 sync + integration tests, 2.7 docs}. Then 2.8 (lab), 2.9.
- **Sonnet-eligible:** 2.1 (mechanical registrations; Opus reviews the SQL), 2.3 (tables fully specified below), 2.7. Opus: 2.2, 2.4, 2.5, 2.6.

### Task 2.0: Preflight

- [ ] Rebase on `main` with W05.1 merged; re-check the migration slot; branch `…/wave-8169-sophos`. Confirm Sophos lab credentials exist (see "Credentials") — without them W05.2 can be built on fixtures but not merged.

### Task 2.1: Key, labels, migration, DTOs, skeleton, contract tests (Sonnet-eligible)

**Interfaces — Produces:** `EDR_PROVIDER_KEYS = ['bitdefender', 'emsisoft', 'sophos']`; `EDR_PROVIDER_LABELS.sophos = 'Sophos Central'`; `SOPHOS_HOST_ALLOWLIST`, `SOPHOS_TENANT_ORIGIN` (Global Constraints); zod DTOs (`.passthrough()`, only used fields, unknown enum strings tolerated) and their types; `sophosAdapter` skeleton whose methods throw `EdrProviderRequestError{ code: 'not_implemented', scope: 'connection' }` until 2.4, with:

```ts
credentialsSchema = z.object({ clientId: z.string().trim().min(8).max(128), clientSecret: z.string().trim().min(16).max(512) }).strict(); // [U] tighten to the real formats after L1
credentialFields = [{ name: 'clientId', label: 'Client ID', secret: false, required: true },
                    { name: 'clientSecret', label: 'Client secret', secret: true, required: true }];
baseUrlPolicy = null;
```

- [ ] **Step 1: failing tests:** `builtinProviderCheck.test.ts` (unchanged) fails once the key is added → add the migration; `registry.test.ts:33` expects the three keys; `guardedFetch.test.ts` table with `SOPHOS_HOST_ALLOWLIST`: `id.sophos.com` ✓, `xid.sophos.com` ✗, `api.central.sophos.com` ✓, `api-eu01.central.sophos.com` ✓, `central.sophos.com` ✗ (bare suffix), `api-eu01.central.sophos.com.evil.test` ✗, `sophos.com` ✗; `SOPHOS_TENANT_ORIGIN` accepts `https://api-us03.central.sophos.com`, refuses the global host, a trailing path, `http:`, uppercase-injection variants and `https://api-eu01.central.sophos.com:8443`; `logRedaction.test.ts`: `{ clientSecret, client_secret, access_token, authorization: 'Bearer x' }` all redact (expected to pass already — a pin, not a change); `incidents.validation.test.ts` accepts `source=sophos`; web label test.
- [ ] **Step 2:** implement; `capabilities.test.ts` gains the Sophos snapshot after 2.4 (mark it `it.todo` here, remove in 2.4). **Step 3:** PASS; `pnpm db:check-drift` clean on a test stack. Commit `feat(edr): register the sophos provider key + catalog CHECK (#8169)`.

### Task 2.2: Sophos client

**Interfaces — Produces** (`sophos/client.ts`; consumes 2.1 DTOs):

```ts
export interface SophosTenantRef { tenantId: string; apiHost: string } // apiHost re-checked against SOPHOS_TENANT_ORIGIN on every call
export class SophosClient {
  constructor(o: { creds: { clientId: string; clientSecret: string }; fetch: GuardedFetch; limiter: EdrRateLimiter;
    runCache: Map<string, Promise<unknown>>; sleep?: (ms: number) => Promise<void>; now?: () => Date });
  whoami(): Promise<SophosWhoami>;                                        // memoized per run ('sophos:whoami')
  listPartnerTenants(partnerId: string): Promise<SophosTenant[]>;         // all pages, page/pageSize=100
  listOrganizationTenants(organizationId: string): Promise<SophosTenant[]>;
  listEndpoints(t: SophosTenantRef): Promise<SophosEndpoint[]>;           // pageFromKey, pageSize=100, view=full
  countEndpoints(t: SophosTenantRef): Promise<number>;                    // pageSize=1&pageTotal=true -> pages.items
  listAlerts(t: SophosTenantRef, o: { from: Date; maxPages: number }): Promise<{ alerts: SophosAlert[]; complete: boolean }>; // sort=raisedAt:asc [U syntax], product=endpoint,server
  getAlertsByIds(t: SophosTenantRef, ids: string[]): Promise<SophosAlert[]>; // <= 50 ids per call
  getAlert(t: SophosTenantRef, alertId: string): Promise<SophosAlert | 'not_found'>;
  getIsolation(t: SophosTenantRef, endpointId: string): Promise<{ enabled: boolean }>;
  setIsolation(t: SophosTenantRef, endpointId: string, enabled: boolean, comment: string): Promise<{ enabled: boolean }>; // write, never retried
  startScan(t: SophosTenantRef, endpointId: string): Promise<void>;                                                       // write, never retried
}
export const SOPHOS_MAX_PAGES = { tenants: 50, endpoints: 200, alertsDelta: 20, alertsFirstSync: 50 } as const;
```

**Token:** one promise in `runCache` under `'sophos:token'`; concurrent callers await the same promise; a rejected promise is evicted; refreshed when < 5 min of `expires_in` remain. Every call (token included) does `limiter.acquire()` first; isolation/scan use `acquire('actions')`. On a **GET** that returns 401 from an API host, evict the token and retry that GET **once**; never for a write.

**Error table** (`EdrProviderRequestError`; the classification is by *which call* failed, never by message text):

| Call | Response | `code` / `scope` / `reauth` |
|---|---|---|
| token | 400 / 401 | `invalid_credentials` / connection / **true** |
| whoami, tenant list | 401 after one refresh | `unauthorized` / connection / true |
| whoami, tenant list | 403 | `insufficient_role` / connection / true ("The Sophos credential's role cannot list tenants") |
| any tenant call (`X-Tenant-ID`) | 401 after refresh, 403 | `tenant_forbidden` / tenant / false |
| tenant list call | 404 | `tenant_not_found` / tenant / false |
| any | 429 | `rate_limited` / connection / false, `retryAfterMs` = full-jitter `min(30 s, 1 s × 2^attempt)` |
| read | 5xx / timeout / unparseable 2xx | retry ≤3 (full jitter), then `vendor_unavailable` / tenant (tenant call) or connection (root call) / false |
| write | sent, then 5xx / timeout / malformed 2xx | `outcome_unknown` / operation / false (no retry) |
| write | 409 | `action_in_progress` / operation / false |
| write | 404 | `target_not_found` / operation / false |
| write | 403 | `forbidden` / operation / false ("The Sophos credential's role cannot perform this action") |
| write | 400 / 422 | `vendor_rejected` / operation / false |
| tenant call | host fails `SOPHOS_TENANT_ORIGIN` | `api_host_rejected` / tenant / false (no request made) |
| endpoint / alert item | `tenant.id` ≠ requested tenant | `tenant_mismatch` / tenant / false |
| list | page cap exceeded (except `listAlerts`, which returns `complete: false`) | `too_many_tenants` (connection) / `too_many_endpoints` (tenant) |

- [ ] **Step 1: failing tests** (`client.test.ts`, fixture-driven, injected `sleep`): token form body + `scope=token`; token reused across calls in one `runCache`, concurrent first calls mint once, an expiring token refreshes, a rejected mint is not cached; partner vs organization tenant listing headers and paging (two pages); endpoints `pageFromKey` paging and a mid-page 500 → throws after retries (never partial); `getAlertsByIds` chunks 120 ids into 50/50/20; `getAlert` 404 → `'not_found'`; every row of the error table; `X-Tenant-ID` and host come from the ref on every call (two interleaved tenants never cross); an error message never contains the secret, the token, a tenant id, a query string or a body (assert on a fixture whose body echoes the token).
- [ ] **Step 2:** implement. **Step 3:** PASS. Commit `feat(edr): Sophos Central client (#8169)`.

### Task 2.3: Normalizer (Sonnet-eligible)

**Interfaces — Produces** (`sophos/normalize.ts`, pure):

```ts
export function toVendorTenant(t: SophosTenant, parentId: string | null): VendorEdrTenant;
export function toVendorEndpoint(e: SophosEndpoint, vendorTenantId: string): VendorEdrEndpoint;
export const SOPHOS_ALERT_CATEGORY_CLASS: Readonly<Record<SophosAlertCategory, 'threat' | 'operational'>>;
export function alertDisposition(a: SophosAlert): 'detection' | 'skip_operational' | 'skip_product';
export function toVendorDetection(a: SophosAlert, vendorTenantId: string): VendorEdrDetection;
export function toOpenStatusUpdate(a: SophosAlert): EdrDetectionStatusUpdate; // kind 'full', status 'open', severity refreshed
```

**Tenant:** `vendorTenantId = id`; `name = showAs?.trim() || name`; `tenantType = 'tenant'`; `externalCode = null` (mapping is manual / name-suggestion only); `apiHost = SOPHOS_TENANT_ORIGIN.test(apiHost) ? apiHost : null`.

**Endpoint:** `hostname = hostname`; `fqdn = hostname` when it contains a dot, else null; `ipAddresses = [...ipv4Addresses, ...ipv6Addresses]`; `macAddresses` in the canonical form `bitdefender/normalize.ts` emits; `serialNumber = serialNumber ?? null`; `osPlatform`: windows→`windows`, macOS→`macos`, linux→`linux`, else `other`; `osName = os.name`; `endpointType`: `os.isServer` or `type === 'server'` → `server`, `computer` → `workstation`, else `unknown`; `agentVersion` = version of `assignedProducts` code `coreAgent`, else `endpointProtection`, else `interceptX`, else null; `health`: good→`healthy`, suspicious→`degraded`, bad→`unhealthy`, else `unknown`; `online = typeof online === 'boolean' ? online : null`; `isolationState`: isolated→`isolated`, notIsolated→`not_isolated`, else `unknown`; `tamperProtection = tamperProtectionEnabled ?? null`; `policyName = group?.name ?? null`; `lastSeenAt = lastSeenAt`; `raw` = projection `{ type, healthOverall, isolation: { status, adminIsolated, selfIsolated }, products: [{ code, version }], tamperProtectionSupported }` — never `associatedPerson`, `groupHierarchy`, `packages`, `deviceSoftware`.

**Alert category table** (all 40 values from `common-v1.yaml`; a test asserts the table's keys equal a frozen copy of that enum):
- `threat`: `malware`, `pua`, `runtimeDetections`, `criticalAttackWarning`, `mtr`, `downloadReputation`, `appReputation`, `blockListed`.
- `operational`: `adSync`, `applicationControl`, `azure`, `connectivity`, `credentialManager`, `cswitch`, `cwg`, `denc`, `deviceAndPlatformHealth`, `dnsProtectionLocation`, `endpointFirewall`, `fenc`, `forensicSnapshot`, `general`, `integrations`, `isolation`, `mobiles`, `policy`, `protection`, `security`, `smc`, `systemHealth`, `uav`, `uncategorized`, `updating`, `utm`, `virt`, `wireless`, `xgEmail`, `ztnaAuthentication`, `ztnaGateway`, `ztnaResource`.
- `security`, `applicationControl`, `endpointFirewall` and `forensicSnapshot` are the judgement calls; L3 records which categories a real EICAR / PUA / exploit test raises and the table is corrected before merge. Endpoint health and isolation state come from inventory, not alerts, which is why `protection`/`isolation` are operational.
- A category **not in the enum** (future value) → `detection` (fail visible) and counted in the page warning `alerts: N alert(s) with an unrecognised category kept`.
- `alertDisposition`: product not in {`endpoint`, `server`} → `skip_product`; operational → `skip_operational`; else `detection`.

**Detection:** `vendorDetectionId = id`; `vendorKind = 'alert'`; `vendorEndpointId = managedAgent?.type ∈ {computer, server} ? managedAgent.id : null`; `severity`: high→`high`, medium→`medium`, low→`low`, else `unknown`; `vendorSeverity = severity`; `status = 'open'`; `vendorStatus = 'open'`; `title = description` (clipped 500); `category = category`; `threatName`, `filePath`, `processName` = null; `mitreTechniques = []`; `detectedAt = lastVendorUpdateAt = raisedAt`; `resolvedAt = null`; `details = { product, type, allowedActions, vendorGroupKey: groupKey }` (explicit projection — never `person`, never `managedAgent.name`); `vendorRef = null`; **`groupKey = null`** (Sophos's `groupKey` groups *similar* alerts that are separate objects; the framework's `groupKey` means "one vendor object across N devices" and drives incident-group authorization).

- [ ] **Step 1: failing tests** for every mapping above (one fixture row per enum branch, `unknown` fallbacks, the category table's key set, `person`/`associatedPerson` absent from `details`/`raw`, a hostile `apiHost` → null). **Step 2:** implement. **Step 3:** PASS. Commit `feat(edr): Sophos normalizer (#8169)`.

### Task 2.4: Adapter read path

**Interfaces — Consumes:** 2.2, 2.3, W05.1 (`closed` updates, `closesAbsentDetections`, `providerBudget`). **Produces** `sophosAdapter`:

```ts
capabilities = {
  tenantModel: 'partner',                 // static; the connection's reach is vendor_root_type (P1, quorum-agreed)
  perTenantHost: true,
  detectionDelivery: 'poll',              // no push API
  detectionStatusModel: 'reread_open_on_inventory',
  closesAbsentDetections: true,           // two-signal closure below; set false if L4 fails (Open Decision 2)
  actions: ['isolate', 'unisolate', 'scan'],   // Task 2.5; [] if the action legs fail
  endpointIdentifiers: ['hostname', 'fqdn', 'mac', 'ip'],   // serial: Macs only -> not an identifier
  installer: 'none',                      // Open Decision 5
  requestBudget: { perSecond: 10, perMinute: 100, perHour: 1000, perDay: 200000 },
  providerBudget: { perMinute: 100 },     // per egress IP [U]; Open Decision 4
  operationBudgets: { actions: { perMinute: 30 } },          // our ceiling; turns on the limiter's action reserve
  defaultIntervals: { detectionsMinutes: 15, inventoryMinutes: 60 },
  maxActionTargets: 1,
  firstSyncLookbackDays: 30,
  tenantFetchConcurrency: 2,
  // inventory: endpoint page(s) ~1 + ids re-read 1 + <= 5 absence confirmations; detection: alert page(s) ~1;
  // overhead: token + whoami + tenant page(s)
  estimatedCalls: { perTenantDetection: 1, perTenantInventory: 7, perConnectionOverhead: 3 },
  rereadOpenPerRun: 50,
};  // NO operationBudgets.incidents (scheduler.ts:22-27 assumes one connection-wide call per run; registry.test.ts:45 pattern)
```

Methods:
- **`testConnection`**: token → whoami → exhaustive switch on `idType`: `partner` / `organization` → list tenants (count); `tenant` → requires `apiHosts.dataRegion` matching `SOPHOS_TENANT_ORIGIN` (else `ok: false`, "Sophos did not return a data-region host for this tenant"), count 1; `distributor` → `{ ok: false, reauth: false, error: 'Sophos distributor credentials are not supported. Create the API credential in Sophos Central Partner, in the organization, or in the customer tenant.' }`; anything else → `ok: false`. `rootId = whoami.id`, `rootType = idType`, `rootName` = `'Sophos Central partner' | 'Sophos Central organization' | 'Sophos Central tenant'` (whoami returns no name). No write probe (none is side-effect free).
- **`listTenants(ctx, root)`**: fresh `whoami`; if `whoami.id !== root.id || whoami.idType !== root.type` throw `{ code: 'root_changed', scope: 'connection', reauth: true }`; exhaustive switch on `root.type` (null / unknown → same throw); `tenant` → `[{ vendorTenantId: root.id, name: 'Sophos Central tenant', parentId: null, tenantType: 'tenant', externalCode: null, apiHost: <validated dataRegion or null> }]`.
- **`listEndpoints` / `countEndpoints`**: `ref.apiHost` null or failing the origin check → `api_host_rejected` (tenant); map with 2.3.
- **`listDetections(ctx, ref, cursor, now)`**: cursor JSON `{ v: 1, from: ISO }` (anything else → treated as null). **First sync** (cursor null): `from = now − firstSyncLookbackDays`, `maxPages = alertsFirstSync`; `complete: false` → throw `too_many_alerts` (tenant; message names the cap and says to acknowledge stale alerts in Sophos Central) — the framework suppresses notifications only on the tenant's first successful run (`persist.ts:493`), so the backfill must land in one run. **Delta**: `from = cursor.from − 15 min` (inclusive overlap; upserts are idempotent; covers late-indexed alerts), `maxPages = alertsDelta`; `complete: false` → bounded catch-up: return what was read with `cursor.from = max(raisedAt read)`; if that is not later than the incoming `cursor.from`, throw `too_many_alerts` (a cap's worth of alerts share one timestamp). New cursor = `max(raisedAt)` of the batch, else the previous cursor (first sync with no alerts: `now − 15 min`). Keep only `alertDisposition === 'detection'`; dedupe by id; warnings carry the unknown-category count.
- **`rereadDetectionStatus(ctx, ref, refs)`** (refs ≤ 50 by `rereadOpenPerRun`): `getAlertsByIds` → each returned alert → `toOpenStatusUpdate` (refreshes severity); absent refs are **candidates**; confirm at most `SOPHOS_MAX_CLOSURE_CONFIRMATIONS = 5` per call with `getAlert`: `'not_found'` → `{ kind: 'closed', status: 'resolved', vendorStatus: 'no_longer_listed', resolvedAt: now }`; a 200 → omitted (the list and the id read disagree; `console.info('[edr:sophos] alert absent from list but readable by id', { count })` once per run); any other failure throws (tenant fails, nothing closes). Unconfirmed candidates beyond the cap are omitted (they rotate and are checked next run). `vendorStatus` says what was observed (`no_longer_listed`), not why — absence can also mean retention expiry or lost visibility (quorum risk 2; L4/L6 check the latter does not look like a 404).

- [ ] **Step 1: failing tests** (`adapter.test.ts`, fixtures, client mocked at the fetch layer): each `idType` branch of `testConnection` incl. `distributor` and a tenant without `dataRegion`; `listTenants` root-changed and null-type throws, organization path, tenant singleton with validated host; first-sync over-cap throws, delta bounded catch-up advances, stalled catch-up throws, a mid-page failure throws with the cursor unchanged; operational/product-skipped alerts dropped; unknown category kept + warning; re-read: present → `full` open update with new severity; absent + 404 → `closed`; absent + 200 → omitted; 7 absent refs → 5 confirmations, 2 omitted; a 500 on confirmation throws; capability snapshot (`capabilities.test.ts`, `capabilities.ts:10-19` format) `['tenants:partner', 'detections:poll', 'installer:none', 'action:isolate', 'action:unisolate', 'action:scan']`; `registry.test.ts` invariants hold.
- [ ] **Step 2:** implement. **Step 3:** PASS. Commit `feat(edr): Sophos Central adapter read path (#8169)`.

### Task 2.5: Adapter actions (W03 contract)

- **`supportsAction(facts, action)`** (pure, in order): not in `capabilities.actions` → "Not supported by Sophos Central"; `vendorEndpointId === null` → "Endpoint not linked to this vendor"; `facts.tenantUnsupportedActions.includes(action)` → "This tenant's Sophos licence does not include this action"; isolate + `isolated` → "Already isolated"; unisolate + `not_isolated` → "Not isolated"; else ok. No OS rule (the vendor's refusal is classified; L5 records it).
- **`performAction(ctx, tenant, req, traceId)`**: endpoint targets only (else throw `unsupported_action`); isolate/unisolate → `setIsolation(id, enabled, 'Breeze action ' + traceId)` → `{ status: 'succeeded' }` (W03: vendor accepted; containment is the endpoint's `isolation.status` on the next inventory, which the device panel already shows); scan → `startScan` → `{ status: 'succeeded' }`. No `getActionStatus` (nothing returns `submitted`).
- **`reconcileAction(ctx, tenant, req)`** (read-only): isolate/unisolate → `getIsolation(id).enabled === desired ? 'applied' : 'not_applied'` — the question is "did the vendor accept the request", which is exactly what this endpoint reports; scan → `'unknown'`.
- Licence: if L5 shows a licence-specific error (distinct from a role 403), map it to `code: 'licence'` so `classifyVendorActionError` records the tenant denial; until then a 403 stays `forbidden`.

- [ ] **Step 1: failing tests:** each `supportsAction` rule; isolate/unisolate/scan request shapes (method, path template, body, `acquire('actions')`); a timeout after send → `outcome_unknown` and **no second request** (fetch spy count 1); 409 → `action_in_progress`; 403 → `forbidden` (and `classifyVendorActionError` gives `vendor_rejected`, `recordTenantDenial: false`, `markReauth: false`); reconcile applied / not_applied / scan unknown; `edrActions.chokepoint.contract.test.ts` still passes (only `dispatchEdrAction` calls `performAction`).
- [ ] **Step 2:** implement. **Step 3:** PASS. Commit `feat(edr): Sophos isolate, release and scan (#8169)`.

### Task 2.6: Through the real sync job + real-Postgres rows

**Files:** `jobs/edrProviderSync.test.ts` (extend), `__tests__/integration/edrProviderSync.integration.test.ts` (extend). No production code is expected; if any is needed, the interface still has a hole — fix it in the framework and say so in the PR.

- [ ] **Step 1: failing tests:** partner root with two tenants in different regions → each tenant's endpoints persisted under its mapped org with its `api_host`; one tenant 403 → tenant failed, connection `connected`, the other synced; a tenant whose `apiHost` is hostile → stored `api_host` null, tenant failed, **zero** requests to that host (fetch spy); first detection sync stamps `notified_severity` (no Phase-4 alert), a later new alert raises one; an acknowledged alert (fixture: absent from ids list, 404 by id) → detection `resolved`, severity unchanged, its Breeze alert resolved; `tenant_mismatch` fixture → nothing persisted for that tenant; a tenant-root connection (`vendor_root_type = 'tenant'`) syncs its single tenant; `root_changed` → `reauth_required`. Integration (real rows, test stack): the closure and tenant-mismatch cases plus "remap → re-sync creates fresh rows" for a Sophos-shaped tenant.
- [ ] **Step 2:** fix only test plumbing. **Step 3:** PASS (unit + test stack). Commit `test(edr): Sophos through the sync job (#8169)`.

### Task 2.7: Docs (Sonnet-eligible)

- [ ] `apps/docs/src/content/docs/features/edr-provider-framework.mdx`: "Sophos Central" section — creating the API credential (partner: Sophos Central Partner → Settings → API credentials; tenant: in the customer's Sophos Central), roles (Read-Only syncs; isolate/scan need a role with `endpoint-state:update` — name the role after L5), the three credential kinds, one connection per tenant rule (`tenant_mapped_elsewhere`), what becomes a detection (threat categories) and how closure works (acknowledge in Sophos Central → resolved within an inventory run), rate limits and the effective-cadence display, no installer yet. No internal hosts or tenant names.

### Task 2.8: Owner lab gate (blocks merging W05.2) — Todd + an Opus session

Lab stack running the W05.2 branch (`worktree-stack` skill; tear down after), a nested Windows lab VM with the Sophos Endpoint agent from the trial tenant (never a host with an installed Breeze agent). Record each leg PASS/FAIL with evidence in the PR (no tenant names, ids, hostnames or IPs).

- [ ] **L1 Partner read.** Connect a partner credential (Read-Only role): whoami `partner`, tenants listed with their `apiHost` regions, map the trial tenant to a lab org, inventory links the VM by hostname/MAC. Record real field names / page sizes (`pages.maxSize`) and any rate-limit headers; re-synthesize fixtures from the shapes (never commit captured payloads).
- [ ] **L2 Tenant credential + guard.** Create a tenant-level credential in the trial tenant; second connection → whoami `tenant`, one tenant with the `dataRegion` host; mapping it while L1's connection maps the same tenant → 409 `tenant_mapped_elsewhere`; unmap one → the other maps.
- [ ] **L3 Detections.** EICAR (and, if available, a PUA test file) on the VM → detection within one cadence, linked device, expected category and severity; a Breeze alert is raised (not on the first sync). Record every category the tests raised; correct the category table if needed.
- [ ] **L4 Closure.** Acknowledge the alert in Sophos Central. Record (a) whether it disappears from `GET /common/v1/alerts`, and (b) what `GET /common/v1/alerts/{id}` returns (status, and the raw body shape if 200). (a)+(b=404) → after the next inventory the detection is `resolved` and the Breeze alert resolved. **Stop rule:** if (a) or (b) fails, set `closesAbsentDetections: false` (absent alerts are omitted, never closed) and take Open Decision 2 to Todd before merge.
- [ ] **L5 Actions** (credential with `endpoint-state:update`; connection actions enabled by a partner admin with MFA): isolate → endpoint `isolation.status` isolated on the next inventory and the VM loses network except Sophos; unisolate → `notIsolated`; scan → accepted, visible in the console; a second isolate during the first → `action_in_progress`; with the Read-Only credential, isolate → `forbidden`. Record the status codes. **Stop rule:** any action leg fails → ship `actions: []`, file a follow-up.
- [ ] **L6 Lost access.** Remove the partner's access to a tenant (or use a suspended/cancelled trial tenant): that tenant fails as a tenant, connection stays `connected`; record the status code and confirm it is **not** a 200 empty list or a 404 on alerts (closure safety).
- [ ] **L7 Organization credential** — only if an organization (enterprise) estate is obtainable; otherwise the PR states "organization credentials: fixture-tested only".
- [ ] **L8 Second region (optional).** A second trial tenant in another data region syncs through its own host.

### Task 2.9: W05.2 verification gate + PR

- [ ] API typecheck exit 0; web typecheck exit 0 (label map); `npx vitest run src/services/edrProviders src/jobs/edrProviderSync src/routes/edr src/routes/incidents.validation.test.ts src/services/builtinProviderCheck.test.ts src/services/logRedaction.test.ts` (batches) → PASS; web `npx vitest run src/lib/__tests__/edrProviders.test.ts` → PASS.
- [ ] Test stack: `edrProviderSync.integration.test.ts` + RLS coverage → PASS; `pnpm db:check-drift` clean; down.
- [ ] One independent review round (Opus): tenant isolation (`tenant_mismatch`, per-call headers), host checks on every call, no token/secret in any error path, write no-retry, closure only on two signals, capability flags match the lab outcome.
- [ ] PR: `feat(edr): Sophos Central adapter (#8169)`; body `Closes #8169`, `Refs #3135`, `Part of #8164`; migration name; lab leg table; which credential kinds were lab-verified; settings rule 9 line; no AI change. `complete_wave` after merge.

---

## Credentials and lab needs (Todd)

- **Sophos Central Partner trial** (Sophos partner program) with at least one **customer trial tenant** licensed for Sophos Endpoint (Intercept X / "Sophos Endpoint"; whether isolation needs an XDR/EDR tier is [U] — pick a trial that includes on-demand isolation).
- **API credentials:** (1) partner credential, **Read-Only** role (L1, L6); (2) partner credential with a role holding `endpoint-state:update` (Management or Super Admin — the docs say creating credentials itself needs Super Admin) for L5; (3) a **tenant-level** credential created inside the trial tenant (L2); (4) optional organization credential (L7); (5) optional second trial tenant in a different data region (L8). `whoami.idType` coverage required for merge: `partner` and `tenant`; `organization` fixture-only unless (4) exists.
- A nested Windows lab VM on the lab Hyper-V host with the Sophos Endpoint agent installed from the trial tenant; never a host with an installed Breeze agent.
- Credentials live only in the private lab notes / the lab stack's `.env`; never in code, fixtures, PR text or issue comments.

## Fixture anonymisation

Synthetic only: ids `00000000-0000-4000-8000-0000000000NN`; tenant names `Example Customer A/B`; hostnames `ws-01.example.test`, `srv-01`; IPs RFC 5737 (`192.0.2.0/24`, `198.51.100.0/24`) and RFC 3849 (`2001:db8::/32`); MACs from RFC 7042's documentation block `00:00:5E:00:53:xx`; serials `TESTSERIAL01`; person names omitted; alert descriptions like `Malware detected: 'EICAR-AV-Test' at 'C:\Users\user\Downloads\eicar.com'`; `apiHost` values use the real public pattern `https://api-eu01.central.sophos.com` (a public vendor host, not internal infrastructure); tokens `eyJ.fake.token`; client id/secret obviously fake; correlation/request ids zeroed. Lab captures are used only to learn shapes; fixtures are re-typed from those shapes with every identifier replaced.

## CI traps

- `builtinProviderCheck.test.ts` reds the moment `'sophos'` joins `EDR_PROVIDER_KEYS` without the CHECK migration (Test API).
- `registry.test.ts:33` pins the exact key list; `capabilities.test.ts` pins snapshots; `incidents.validation.test.ts` / `routes/edr/providers.test.ts` may enumerate providers.
- **Check Migrations**: rename the W05.2 migration if a newer one merges first.
- The mapping-guard and sync integration tests run only in the **Integration Tests** shards, never Test API — run them locally on the test stack. Stacked branches get no CI.
- `tsc` OOMs below a 12 GB heap and `| tail` hides it — read `exit=`.
- `edrActions.chokepoint.contract.test.ts` forbids AI modules from importing `edrProviders/<vendor>/adapter|client` — keep actions inside `sophos/adapter.ts`.
- W05.1 changes GravityZone/Emsisoft behaviour (duplicate mapping refused): any existing test that maps one vendor tenant through two connections must be updated deliberately, with the reason in the commit.

## Open Decisions (Gate — Todd)

1. **Two PRs instead of the index's one** (W05.1 framework fixes, W05.2 adapter). (a) Two PRs; (b) one PR. **Recommend (a)**: W05.1 changes behaviour for every EDR provider and touches tenancy; the quorum asked for the guard "in W05 or a blocking prerequisite".
2. **Closure when the lab disproves the two-signal check** (L4). (a) Leave absent alerts open (`closesAbsentDetections: false`; an MSP sees stale open detections until a later wave adds a manual dismiss or alert actions); (b) close on list absence alone (one signal; a vendor glitch returning an empty list would resolve real threats' Breeze alerts permanently, since Phase 4 never re-raises); (c) close on list absence only when the tenant's full alert list is non-empty in the same run (weak guard). **Recommend (a)** if L4 fails; the default build is two-signal.
3. **Duplicate mapping rule strength** (W05.1). (a) One live mapping per (partner, provider, vendor tenant), any org; (b) allow the same org twice (duplicates only within one customer). **Recommend (a)**: two rows for one tenant in one org still double-count endpoints and detections, and there is no legitimate need for both.
4. **Provider-wide window value.** Sophos's per-IP metering is documented but its aggregation across many credentials is [U]. (a) `providerBudget: { perMinute: 100 }` now (all Sophos connections in a region share the enforced per-minute limit; ~6,000 calls/h region-wide ≈ several hundred tenants); (b) no provider window until 429 telemetry shows a need. **Recommend (a)**: queueing in our limiter is cheaper than 429 storms that back off every connection; revisit with telemetry.
5. **Sophos installer** (`GET /endpoint/v1/downloads`). (a) Follow-up wave after W06.3, adapter-only (`fetchInstallerMaterial` + `buildInstaller`) with its own lab leg, like W06's Emsisoft deferral; (b) build it in W05.2 dormant. **Recommend (a)**: W05's lab is already long, the download URL's token/host model is [U], and W06.1's contract already admits a third installer vendor without a migration (the CHECK covers every key).
6. **Alert actions** (`acknowledge`, `clearThreat` via `POST /common/v1/alerts/{id}/actions`) as `resolve_detection`. (a) Not in W05 — `edr_detection_action` is still unregistered (W04 PR-B never landed) and the tier work belongs with the first adapter that proves a detection action; (b) include. **Recommend (a).**

## Advisor quorum record

Position formed first (P1–P9: static `tenantModel` + per-connection `root.type`; per-tenant host checks; overlap guard deferred; per-run token; re-read with two-signal closure under the existing contract; threat-category filter; W03 actions; CHECK migration + one PR; budgets). Independent `codex exec` (gpt-6-astra, `xhigh`, read-only, stdin closed, against `3444fa4`):

- **Agreed, folded in:** P1 tenant model (with: exhaustive `idType` switch rejecting distributor/unknown/null; re-check fresh whoami id/type against the stored root before returning the singleton tenant → `root_changed`); P4 token (coalesced mint promise, evict rejected, one bounded refresh on a read 401, never replay a write); P6 (explicit reviewed category table instead of "whatever else"; explicit `details`/`raw` projections rather than copy-and-delete; D14 is about site visibility, so `person` is excluded as minimization, not as D14); P8 (expand lab evidence to tenant credentials, revoked access, a second region; organization fixture-only if unobtainable); P9 (inventory estimate raised from 2 to 7 and the confirmation cap made explicit; `operationBudgets.actions` added because the limiter's action reserve only exists when that class is declared).
- **Codex disagreed; the author verified and changed the plan:** **P3** — the duplicate-tenant gap is not cosmetic: two connections can map one vendor tenant into **two orgs**, and W06's ambiguity check is per org, so nothing catches it (verified `installerTenant.ts:118`, `mapping.ts:85,151`) → W05.1 Task 1.1, serialized by an advisory lock across connections. **P5** — reinterpreting `types.ts:233-237` silently is unacceptable, and a status update cannot carry severity on a 404 while `applyDetectionStatusUpdates` overwrites it (verified `persist.ts:681`) → explicit `closed` variant + opt-in capability (Task 1.2). **P2 detail** — the sync job prefers the stored host (verified `edrProviderSync.ts:800`) → Task 1.3. **Catch-up** — first-sync notification suppression ends after the first successful batch (verified `persist.ts:493`), so the first sync must be all-or-nothing, not bounded catch-up → Task 2.4.
- **Partial disagreement, resolved on the merits:** **P7** — Codex noted that `GET …/isolation` reports the requested state, not completion, and that `succeeded` rows are never re-polled (`actionStatus.ts:157`). The plan keeps `succeeded` = "vendor accepted" (the W03 contract, `types.ts:162`, and the GravityZone precedent) and uses the requested state for reconciliation, because the reconciler's question is "did the request land", while containment truth is the endpoint's `isolation.status`, already shown from inventory. Timeouts, 5xx and malformed 2xx after send are all `outcome_unknown` (Codex's addition, adopted).
- **New risks raised and where they landed:** cross-tenant routing via shared run state (→ per-call headers + `tenant_mismatch`, Global Constraints, Task 2.2); correlated closure failures (→ `vendorStatus: 'no_longer_listed'`, L4/L6); token leakage (→ error-path tests on a body that echoes the token); aggregate throttling (→ `providerBudget`, Decision 4); catch-up notification storms (→ first sync all-or-nothing).
- **Unresolved disagreements:** none. Decisions 1–6 still need Todd because they set scope or depend on lab evidence, not because the reviewers split. **Verdict on the tenant-model question (both):** keep static `tenantModel: 'partner'` with the connection-specific `root.type`; support partner, organization and tenant credentials; the real blockers were duplicate ownership, fresh-host routing and closure semantics, not the flag.

## Self-review notes (for executors)

- **Type consistency:** `EdrTenantClaimedError`, `lockAndFindOtherMapping`, `EdrDetectionStatusUpdate` (`kind: 'closed'`), `closesAbsentDetections`, `providerBudget`, `SophosClient`, `SophosTenantRef`, `SOPHOS_TENANT_ORIGIN`, `SOPHOS_HOST_ALLOWLIST`, `SOPHOS_MAX_PAGES`, `SOPHOS_MAX_CLOSURE_CONFIRMATIONS`, `SOPHOS_ALERT_CATEGORY_CLASS` are defined once and used by name.
- **Spec coverage:** §3.1 Sophos column → facts table + corrections; §4.3 interface (`perTenantHost`, cursor contract, re-read) → 1.2, 2.4; §4.4 budgets → 1.4, 2.4; §4.6 matching → `endpointIdentifiers`; §4.9 hosts/credentials → 1.3, 2.1, 2.2; §4.10 actions → 2.5; D3 → 1.1; D13 remap → 2.6.
- **Not in scope:** installer (Decision 5), alert actions / `resolve_detection` (Decision 6), Detections/XDR GraphQL, push (none exists), Sophos Firewall/Email/Mobile alerts, S1/Huntress port.

## Execution handoff

Plan saved to `docs/superpowers/plans/integrations/2026-11-08-edr-provider-framework-w05-sophos-central-adapter.md`. Recommended execution: **subagent-driven** for W05.1 and W05.2 — W05.1 is tenancy-critical with cross-task interfaces that W05.2 consumes, and a shipped mistake shows one customer's security data in another customer's org; Task 2.8 is an operator session with Todd.
