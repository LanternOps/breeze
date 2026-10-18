---
tracking_issue: LanternOps/breeze#8164
---
# EDR W04 — Emsisoft cloud EMC adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect an Emsisoft Management Console (cloud EMC) API key to Breeze. Each EMC workspace maps to a Breeze org, devices link to Breeze devices by name, and incidents arrive as EDR detections. If the lab key proves they work, the MSP can also start a scan and mark an incident a false positive, from the UI and through approval-gated AI tools.

**Architecture:** A third vendor directory, `services/edrProviders/emsisoft/{client,adapter,normalize}.ts`, follows the GravityZone pattern exactly. It registers in `providerKeys.ts` + `registry.ts`, and nothing else in the framework names a vendor. Emsisoft is the first adapter with a thin device list, no MAC, no change cursor on incidents, and incidents that span several devices. So PR-A also builds the framework extension points it is the first to exercise. Each is opt-in, and GravityZone's behaviour does not change:
1. detail-owned endpoint fields;
2. per-adapter call estimates;
3. strict name matching for identifier-poor vendors;
4. the spec'd-but-unbuilt `reread_open_on_inventory` status model;
5. a trusted vendor locator plus group key on detections.

PR-B adds the actions. `scan` runs through the existing `edr_endpoint_action`. `mark_false_positive` registers `edr_detection_action` in every place W03 deliberately left it out, and it gets an incident-group authorization rule.

**Tech Stack:** Hono, Drizzle (queries only), PostgreSQL RLS, BullMQ, Redis, Vitest, Astro + React islands, `runAction`.

**Spec:** `docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md` §3.1, §4.3 (cursor contract), §4.6, §4.9, §4.10, §4.11, D3, D9, D10, D14. **Read the index first** (`2026-10-01-edr-provider-framework-index.md`: the W04 section and corrections 2, 5, 8, 9). Use the W03 plan (`2026-10-13-edr-provider-framework-w03-response-actions.md`) as the action contract. W01–W03 are merged (W03 PR-A #8757, PR-B #8937). This plan was written against `origin/main` at `aada1584cc` (2026-10-17).

Epic: #8164 · Wave sub-issue: #8168 · Request: #7436. PR bodies say `Refs #8168 #7436` / `Part of #8164`. Only the **last** PR of the wave carries `Closes #8168`. Never write a closing keyword for #7436: the orchestrator closes the request once the adapter is live. Branches: `feature/8164-edr-provider-framework/wave-8168` (PR-A) and `…/wave-8168-actions` (PR-B). PR-B is cut from `main` after PR-A merges. If PR-B is stacked instead, it gets no CI: see the index's stacked-PR CI trap.

**Numbering.** The index calls this wave **W04**, and so does the spec §9 resolution box. The 2026-10-01 comment on #7436 called it "W05". That comment predates the re-sequencing, and **the index wins**. The owner's 2026-10-17 comment on #7436 already says W04 (#8168). No code or doc should say "W05" for Emsisoft.

**Gate cleared.** The index gated W04 on the #7436 requester confirming cloud EMC. The owner confirmed on 2026-10-17 that the scope is cloud EMC only, that on-prem Enterprise Console is out, and that the adapter order is Emsisoft → CrowdStrike (#7653) → ThreatDown (#7654).

## Vendor API facts (verified against the published OpenAPI, 2026-10-17)

Source: `https://api.emsisoft.com/swagger/v1.0/swagger.json` (OpenAPI 3.0.1, "Emsisoft public API" v1.0). There is one host, `api.emsisoft.com`, and one security scheme, `ApiKey`: header `Api-Key`. Paging is `Skip`/`Take` with `{ data, totalCount }`. Items marked **[U]** are unconfirmed and are settled by the lab key (Task A11). Where the published API differs from the spec matrix (§3.1), this plan follows the API and lists the difference under *Spec corrections* below.

| Need | Call | Shape (fields this plan uses) |
|---|---|---|
| Key check + root | `GET /v1/account` | `partners[]: { guid, id, roles[] }`, `email`. There is **no account id**. |
| Tenants | `GET /v1/workspaces?Skip&Take` | `data[]: { guid, name, devices, isExpired, … }`. Doc note: a *licence manager* sees only name, GUID and licence info. |
| Endpoints (list) | `GET /v1/workspaces/{ws}/devices?Skip&Take` | `guid, name, status (Undefined/Idle/Updating/Scanning), lastUpdate, lastScan, lastAlert, protectionPolicyGroup(+Guid), lastUser`. The list has **no domain, OS, online or protection state**. |
| Endpoint detail | `GET /v1/devices/{dv}/details` | `name, domain, protectionStatus (Offline/Protected/PartiallyProtected/NotProtected/RebootRequired/NotManaged/UnusedSeat/Connecting/NewlyDiscovered), os, version, updateStatus.online (Undefined/Online/Offline), networkAdapters[]: { iPv4Addresses[], iPv6Addresses[] }, settings.networkLockdown { value, enabledOnGroupLevel, groupGuid }`. The detail has **no MAC and no serial**. |
| Detections | `GET /v1/workspaces/{ws}/incidents?DateFrom&DateTo&Skip&Take` | `DateFrom`/`DateTo` filter on **last detection**. Item: `guid, type (Unknown/File/Host/Payload/ThreatHuntingSnapshot), verdict (New/InInvestigation/ConfirmedMalicious/ConfirmedBenign/Unknown), actionTaken + actionsTaken[] (None/Reported/Remediated/Deleted/Blocked/Allowed/Isolated/PartlyRemediated/RollbackCompleted), highestSeverity (None/FalseAlert/Unwanted/Notable/Suspicious/LikelyMalicious/Malicious), lastDetectionAt, detectionComponent, involvedDevices: string[], involvedDeviceUsers: string[], sha1/md5/sha256, knownFileNames[], hostAddress, detailsPageLink`. There is **no closed/resolved state**. |
| Incident detail / verdict | `GET` / `PUT /v1/workspaces/{ws}/incidents/{incidentId}(/verdict)` | `incidentId` is documented as "file SHA1 hash, or web host, or IP", **not the guid**. The detail has `verdict, actionTaken(s), severity, detections[]` but **no `involvedDevices`**. The verdict body is `{ verdict }`. **No 404 is documented**: a missing incident is a 400 LogicError (`IncidentNotFound` on the PUT, `WorkspaceThreatIncorrectTarget` on the GET). |
| Scan | `POST /v1/devices/{dv}/scans/start-quick` | Body `{ detectPups, performanceMode, onScanCompletion (ReportOnly/ReportAndComputerShutdown/QuarantineDetections/QuarantineAndComputerShutdown), detectRegistryPoliciesSettings }`, response `{ scanGuid }`. There is **no scan-status read**. |
| Quarantine | `GET /v1/devices/{dv}/quarantine/info`, `POST …/quarantine/{restore,delete,false-detected-file}` | Lists are **per device**. Items are keyed by a `quarantineFile` string, with no id. |
| Installer (W06) | `GET /v1/workspaces/{ws}/install?groupGuid` | `installToken (uuid), tokenExpiration, downloadUrl, downloadUrlFull, downloadUrlDirect, downloadUrlDirectFull`. |
| Lockdown | `PUT /v1/workspaces/{ws}/protection-groups/{pg}/network-lockdown` (group); `PUT /v1/workspaces/{ws}/devices/{dv}/protection-settings` `{ networkLockdownEnabled: { value, modified } }` (device override) | Not used in W04 (Open Decision 5). |

The API publishes **no webhooks**, **no 429 response** and **no rate-limit documentation**. Every endpoint documents `401` as "Unauthorized. Insufficient permissions **or** API-key not provided". A 401 alone therefore cannot tell a dead key from a missing permission.

## Spec corrections (found while checking §3.1 against the OpenAPI)

1. **Device details carry IP addresses** (`networkAdapters[].iPv4Addresses/iPv6Addresses`), so §3.1's "no IP/MAC/serial" is wrong about IPs. They are stored for display only. Matching never uses IP (§4.6), so the matching rule does not change.
2. **A per-device network-lockdown override exists** (`protection-settings.networkLockdownEnabled`). §3.1 and D9 say lockdown is per policy group only. What it does is **[U]**: it might isolate the device now, or it might arm an "isolate when attacked" policy. Per the owner decision, W04 ships **no isolation**. See Open Decision 5.
3. **The device list has no domain.** Domain, OS, online state and protection state come only from the per-device detail call. That is why Task A2 adds detail-owned fields.
4. **Incidents name devices by string, and one incident can span devices** (`involvedDevices: string[]`; the incident filter is `DeviceExact`, "exact device names"). Whether the strings are names or guids is **[U]** and must be proven on a live fixture, never inferred. Task A7 defines the attribution rule.
5. **Incidents have no change cursor and no closed state.** Verdict changes do not move `lastDetectionAt` **[U]**, so `delta_with_updates` would be a false claim. Emsisoft is the first consumer of the spec's `reread_open_on_inventory` path (§4.3 cursor contract; typed at `types.ts:36` and never built). See Task A5 and Open Decision 2.
6. **A 401 means "dead key *or* insufficient permission".** Scope comes from **which call failed, and what succeeded before it** (Task A6), not from the status code alone.
7. **Verdicts are per incident, not per device.** An action on one Breeze detection row can change what other devices' rows say. PR-B authorizes against the whole incident group (Task B3).

## PR split

- **PR-A — read-only adapter + the framework extension points it exercises** (medium–high blast radius: it touches `persist.ts`, the sync job and the shared matcher; full TDD, one Sonnet review round). Contents: the Emsisoft client, normalizer and adapter (`testConnection`, `listTenants`, `listEndpoints`, `countEndpoints`, `enrichEndpoints`, `listDetections`, `rereadDetectionStatus`); synthetic fixtures; the registry key and labels; extension points A2–A5; contract-test updates; and docs. `capabilities.actions = []`. **No AI registration, no route, no migration.** **PR-A is held unmerged until the lab run (A11) is recorded.** Registering is harmless without a connection, but synthetic fixtures do not prove the vendor shapes.
- **PR-B — actions** (high blast radius: remote actions and AI guardrails; full rigor, Sonnet/Opus review). Contents: `scan` + `mark_false_positive` on the adapter; incident-group authorization in `dispatchEdrAction`; `edr_detection_action` in a **new module** with its own single write site, registered everywhere W03 deferred; the web detection-action button; and the action lab run. Each action ships **only if** the lab proves it (Task B7). If neither is proven, PR-B is not opened and PR-A carries `Closes #8168` (Open Decision 4).

Why two PRs: the read path and the action path differ in blast radius and gate. That is W03's reason too, and it keeps AI-contract churn out of PR-A: line-keyed `ACTION_GUARD_ALIASES`, the `aiToolIndex` byte budget, golden prompts. Why `edr_detection_action` waits for PR-B: `aiToolsEdr.actions.test.ts:122-125` and the `mcpCoverage.ts:335-338` comment pin it **absent** until an adapter implements a detection action. The approvalScope contract also forbids tier rows for actions outside a tool's real enum (`aiToolsEdr.actions.test.ts:139-141`). If a reviewer wants PR-A smaller, A2–A5 can split into their own framework PR ahead of the adapter. All five stay opt-in and dormant until Emsisoft declares them. The plan does not require that split.

## Global Constraints

- **No vendor name outside the vendor directory, the two registries and the two label maps.** If any other framework file needs `provider === 'emsisoft'`, the interface has a bug. Fix it in the framework.
- **Every extension point is opt-in and defaults to today's behaviour.** GravityZone's capabilities and sync output stay unchanged: the `bitdefender/` suites and existing `edrProviderSync.test.ts` cases pass **unmodified**. The one deliberate exception is A4's sticky detection attribution, which applies to all adapters and is a no-op for GravityZone (its incident→endpoint id never changes). A4 pins that with a GravityZone case.
- **Host allowlist is the exact host** `['api.emsisoft.com']` (index correction 8: no leading dot, so `xapi.emsisoft.com` / `api.emsisoft.com.evil.test` are refused). `baseUrlPolicy: null`.
- **No pooled DB connection is held across vendor HTTP** (#1105 / #1896). The adapter is DB-free. Phase 2 of every job runs under `runOutsideDbContext`, and A5's re-read lives in Phase 2.
- **All-or-nothing per tenant.** A page failure throws and is never returned as a partial list. A list longer than its page cap throws `too_many_*` and is never truncated.
- **Never match or attribute across workspaces or orgs, and never guess.** Device matching is same-org and, for Emsisoft, strict-unique (A3). Incident attribution is same-workspace exact-name (A7). A vendor endpoint, once attributed, is never re-bound (A4).
- **A detection row never carries another device's identity.** `details` holds this row's own device string and the involved-device **count** only: never the sibling names and never `involvedDeviceUsers` (D14; site-restricted readers).
- **The API key is never logged, echoed or put in an error message.** It goes only in the `Api-Key` header. Error messages carry the method, the HTTP status and the path *template* (`/v1/workspaces/{ws}/devices`): never the query, a guid, a workspace name or the body.
- **Fixtures are synthetic.** No customer names, hostnames, IPs, emails or key material in fixtures, code or PR text (public repo). Use the `example.test` domain, RFC 5737 / 3849 documentation IPs and `00000000-0000-4000-8000-…` guids.
- **Tests:** API `cd apps/api && npx vitest run <files>` (no `--` before flags); web `cd apps/web && npx vitest run <files>`. Typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?`, and read the exit code (never pipe to `tail`). On a loaded host, run in small batches.
- **PR-B only:** tier tables are literals (contracts parse `aiGuardrails.ts` as text); no `z.undefined()`; description budget 300/160; `ACTION_GUARD_ALIASES` is keyed by `file:line`; the user-owned-release contract demands **exactly one** `requestedBy: auth.user.id` per EDR tool file (`aiTools.userOwnedRelease.contract.test.ts:346-351`); every new `en` key goes into all **8** locale dirs; the `aiToolIndex` byte budget is **paid for by trimming, never by raising the ceiling** (`aiToolIndex.test.ts:136-146`).

## Migration & tenancy statement

**No migration in either PR.** `edr_connections.provider` is `varchar(30)` with **no CHECK** (`2026-12-16-100000-edr-provider-framework.sql:119`; a grep finds no migration that lists EDR provider keys), so `'emsisoft'` needs only `EDR_PROVIDER_KEYS`. The `security_provider` pg enum value `emsisoft` already exists (`2026-11-12-120000-security-provider-emsisoft-webroot-withsecure.sql:7`), but it belongs to agent-side detection and W04 does not touch it. Every value W04 writes (`vendor_kind 'incident'`, statuses, severities, health, `os_platform`) is already in the W01 CHECK sets (`…edr-provider-framework.sql:337-353, 480-492`).

**CHECK escape hatch.** If a later wave adds a CHECK that lists provider keys (W06 replaces `software_catalog_integration_provider_chk`), it must include `'emsisoft'`. Use a new idempotent drop-and-re-add migration, never an edit of a shipped one. W06's registry ↔ CHECK exhaustiveness test catches a miss.

**No new table, column or registration.** The A5 locator / group key live in `edr_detections.details` under a framework-reserved `_breeze` key. `details` is jsonb and already `excludedOpen` in `CORE_TENANT_EXPORT_POLICY`, so there is no export-policy change. The portal never projects `details`, and the PR states the grep that proves it. Nothing changes in the cascade, merge, RLS-coverage or device lists. Settings rule 9: **no setting is added**. Connections stay in their one home, Integrations → Security.

## Review Focus

1. **Two machines in one org with the same short name, or one machine listed twice in EMC** (re-imaged, or `PC01` in two AD domains). Expected: no auto-link at all for that name, including after one of them is linked by hand. The matcher must not pick "the one left over". Both are listed for manual linking. Pinned in A3 (pure) and A10 (real rows).
2. **A licence-manager-only or partially scoped key.** `/v1/workspaces` lists workspaces, but `…/devices` or `…/incidents` returns 401/403 for some of them. Expected: those workspaces fail **as tenants**, the connection stays `connected`, the others sync, and the test result carries a note. A 401 on a workspace path never flips the connection to `reauth_required`. Pinned in A6 and A9.
3. **A verdict changed in the EMC console weeks after the incident** (New → ConfirmedBenign at day 45). Expected: within one inventory cadence of reaching the front of the re-read rotation, Breeze shows `false_positive`. A vendor "not found" on re-read leaves the row open (never auto-closed). Pinned in A5 and A9.
4. **A network-discovered or unused-seat device that runs no Emsisoft agent.** Expected: it is never reported as a protected endpoint. Detail `protectionStatus` NotManaged / NewlyDiscovered / NotProtected → health `unhealthy`; first-sight list rows store `health: 'unknown'`, never `healthy`. Pinned in A7.
5. **A site-restricted technician (PR-B) marks benign an incident that also involves a device in a site they cannot see.** Expected: refused (`site_denied`) with no row and no vendor call, because the verdict would change what other sites' rows say. Pinned in B3 and B6.

---

# PR-A — read-only adapter + framework extension points

## File Structure (PR-A)

| File | Change |
|---|---|
| `apps/api/src/services/edrProviders/types.ts` | Capabilities `detailOwnedFields?`, `estimatedCalls?`, `rereadOpenPerRun?`; `VendorEdrEndpointDetail` += `fqdn`, `ipAddresses`, `osPlatform`, `endpointType`; `VendorEdrDetection` += `vendorRef?`, `groupKey?`; `EdrDetectionRef`, `EdrDetectionStatusUpdate`; adapter `rereadDetectionStatus?` |
| `apps/api/src/services/edrProviders/persist.ts` | List upsert skips `detailOwnedFields`; detail update writes 4 more fields; detection upsert writes `details._breeze` and makes the vendor endpoint sticky; `applyDetectionStatusUpdates` |
| `apps/api/src/services/externalDeviceMatching/resolve.ts` | `resolveDeviceMatches(rows, candidates, { strictUnique?: boolean })` |
| `apps/api/src/services/edrProviders/deviceMatching.ts` | Passes `strictUnique` for adapters whose `endpointIdentifiers` lack `mac` and `serial` |
| `apps/api/src/jobs/edrProviderSync.ts` | `planCadence` uses `capabilities.estimatedCalls ?? DEFAULT_ESTIMATED_CALLS`; the inventory run loads + re-reads open detections for `reread_open_on_inventory` adapters |
| `apps/api/src/services/edrProviders/emsisoft/{client,normalize,adapter}.ts` + tests + `__fixtures__/` | Create |
| `providerKeys.ts`, `registry.ts`, `apps/web/src/lib/edrProviders.ts:419` | `'emsisoft'` key, label `'Emsisoft'` |
| Contract/test updates | `registry.test.ts`, `capabilities.test.ts`, `guardedFetch.test.ts`, `services/logRedaction.test.ts`, `edrActions.chokepoint.contract.test.ts:77`, `persist.test.ts`, `edrProviderSync.test.ts`, `scheduler.test.ts`, `externalDeviceMatching` tests, web `edrProviders.test.ts` |
| `apps/api/src/__tests__/integration/edrProviderSync.integration.test.ts` | Emsisoft-shaped matching + re-read on real rows |
| `apps/docs/src/content/docs/features/edr-provider-framework.mdx` | Emsisoft section |

---

### Task A1: Registry key, labels, adapter skeleton, vendor-neutrality contracts

**Files:**
- Modify: `providerKeys.ts`, `registry.ts`, `registry.test.ts`, `capabilities.test.ts`, `guardedFetch.test.ts`, `edrActions.chokepoint.contract.test.ts:77`, `apps/web/src/lib/edrProviders.ts:419`, `apps/web/src/lib/__tests__/edrProviders.test.ts`, `apps/api/src/services/logRedaction.test.ts` (next to the case at :288)
- Create: `emsisoft/client.ts` (only `EMSISOFT_HOST_ALLOWLIST` for now), `emsisoft/adapter.ts` (skeleton; methods throw `EdrProviderRequestError{ code: 'not_implemented', scope: 'connection' }` until A8)

**Interfaces:**
- Produces: `EDR_PROVIDER_KEYS = ['bitdefender', 'emsisoft']`; `EDR_PROVIDER_LABELS.emsisoft = 'Emsisoft'`; `EMSISOFT_HOST_ALLOWLIST = ['api.emsisoft.com'] as const`; `emsisoftAdapter`:
  ```ts
  credentialsSchema = z.object({ apiKey: z.string().trim().min(16).max(512) }).strict();   // [U] align min with a real key
  credentialFields = [{ name: 'apiKey', label: 'API key', secret: true, required: true }];
  baseUrlPolicy = null;
  capabilities = {
    tenantModel: 'partner',                          // Open Decision 1
    perTenantHost: false,
    detectionDelivery: 'poll',                       // the vendor has no webhooks
    detectionStatusModel: 'reread_open_on_inventory',// Open Decision 2; built in A5
    actions: [],                                     // PR-B
    endpointIdentifiers: ['hostname', 'fqdn'],       // no mac / serial -> strict matching (A3); ip is never an identifier
    installer: 'none',                               // W06 (Open Decision 6)
    requestBudget: { perSecond: 2, perMinute: 60 },  // undocumented vendor limit: conservative, revisit after A11
    defaultIntervals: { detectionsMinutes: 15, inventoryMinutes: 60 },
    maxActionTargets: 1,
    firstSyncLookbackDays: 30,
    tenantFetchConcurrency: 1,
    detailOwnedFields: ['fqdn', 'ipAddresses', 'osPlatform', 'osName', 'endpointType', 'online', 'health', 'agentVersion'],
    // inventory: device pages (~2) + up to DETAIL_ENRICH_PER_RUN (50) details + re-read (<= 20)
    // detection: incident pages (~1) + device-name pages for attribution (~2)
    estimatedCalls: { perTenantDetection: 3, perTenantInventory: 72, perConnectionOverhead: 2 },
    rereadOpenPerRun: 20,
  };
  ```
  The fields from `detailOwnedFields` onward are typed in A2–A5. Until those tasks land, keep them commented in the skeleton, and uncomment each in its own task.

- [ ] **Step 1: Failing tests**
  - `registry.test.ts`: pinned set `['bitdefender', 'emsisoft']`. The existing self-consistency loop covers emsisoft (empty `actions`, so no `performAction`; `poll`, so no `verifyWebhook`; `installer: 'none'`, so no `getInstaller`). Add `it('emsisoft declares no connection-wide incidents budget (its incidents are per workspace; scheduler.ts:22-27 assumes one call per run)')`, asserting `operationBudgets?.incidents` is undefined.
  - `capabilities.test.ts`: `capabilitySnapshot(emsisoftAdapter, [])` → `['tenants:partner', 'detections:poll', 'installer:none']`.
  - `guardedFetch.test.ts`: `hostAllowed('api.emsisoft.com', EMSISOFT_HOST_ALLOWLIST)` true; `'xapi.emsisoft.com'`, `'api.emsisoft.com.evil.test'`, `'emsisoft.com'` false.
  - `logRedaction.test.ts`: `redactLogFields({ 'Api-Key': 'k', apiKey: 'k' })` → both `'[REDACTED]'`. `SECRET_KEY_PATTERN` (`logRedaction.ts:8`, `api.*key`) already matches: this pins the header name (index correction 7), and no code change is expected.
  - `edrActions.chokepoint.contract.test.ts:77`: generalize the vendor alternation from `bitdefender` to any vendor directory: `/edrProviders\/(?:registry|actionStatus|[a-z0-9]+\/(?:adapter|client))\b/`. **Prove it can fail:** add a scratch `services/aiToolsScratch.ts` importing `./edrProviders/emsisoft/adapter`, run it, see red, then delete the file.
  - Web: `edrProviderLabel('emsisoft')` → `'Emsisoft'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/edrProviders/registry.test.ts src/services/edrProviders/capabilities.test.ts src/services/edrProviders/guardedFetch.test.ts src/services/logRedaction.test.ts src/services/edrProviders/edrActions.chokepoint.contract.test.ts` → FAIL (the redaction case may already pass; that is expected).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same suites plus `src/routes/incidents.validation.test.ts` (its key loop, `:52`), the web test and `tsc` → PASS / exit 0.
- [ ] **Step 5: Commit** `feat(edr): register the Emsisoft provider key and labels (#8168)`

---

### Task A2: Detail-owned endpoint fields + per-adapter call estimates

**Files:**
- Modify: `types.ts`, `persist.ts` (list upsert set ~:302-322; detail update ~:328-346), `apps/api/src/jobs/edrProviderSync.ts` (`planCadence` call :754, `estimatedCalls` literal :762)
- Test: `persist.test.ts`, `edrProviderSync.test.ts`, `scheduler.test.ts`

**Interfaces:**
```ts
export type EdrDetailOwnedField = 'fqdn' | 'ipAddresses' | 'osPlatform' | 'osName' | 'endpointType'
  | 'online' | 'health' | 'agentVersion' | 'lastSeenAt' | 'serialNumber';
// EdrCapabilities:
/** Columns only the per-endpoint detail call knows. On conflict the list upsert keeps the stored value. */
detailOwnedFields?: readonly EdrDetailOwnedField[];                    // default []
estimatedCalls?: { perTenantDetection: number; perTenantInventory: number; perConnectionOverhead: number };
// VendorEdrEndpointDetail (all optional, like the existing fields):
fqdn?: string | null; ipAddresses?: string[]; osPlatform?: EdrOsPlatform; endpointType?: EdrEndpointType;
// edrProviderSync.ts — today's literal, moved, not changed:
export const DEFAULT_ESTIMATED_CALLS = { perTenantDetection: 1, perTenantInventory: 3, perConnectionOverhead: 2 } as const;
```
Persist rule: every key in `getEdrProvider(conn.provider).capabilities.detailOwnedFields` is **omitted** from the `onConflictDoUpdate.set`. A first insert still takes the list values (for Emsisoft: `health 'unknown'`, `online null`, `osPlatform 'other'`, `endpointType 'unknown'`, `fqdn null`, `ipAddresses []`). The detail update distinguishes **"not fetched" from "fetched as null/empty"**: a field is written iff it is `!== undefined`. So an explicit `fqdn: null` (the device left its domain) clears the stored value, and an absent key leaves it. Both enrichment selectors already honour `DETAIL_ENRICH_PER_RUN` (`edrProviderSync.ts:138, :426, :472`), so no cap change is needed.

- [ ] **Step 1: Failing tests**
  - `persist.test.ts` `'detail-owned fields survive the list upsert across consecutive runs'`: a fake adapter with `detailOwnedFields: ['osName', 'online', 'fqdn']`. Run 1 inserts list values, then details set `osName 'Windows 11 Pro'`, `online true`, `fqdn 'pc01.corp.example.test'`. Run 2 is list-only with nulls, and the row keeps all three while `hostname` / `policyName` update. Run 3 has details with `fqdn: null` and **no** `osName` key: `fqdn` clears and `osName` stays.
  - `'no detailOwnedFields → every column overwrites as before'` with `bitdefenderAdapter` (regression guard).
  - `'detail update writes fqdn, ipAddresses, osPlatform, endpointType'`.
  - `edrProviderSync.test.ts`: `planCadence` receives `capabilities.estimatedCalls` when declared and `DEFAULT_ESTIMATED_CALLS` otherwise (spy).
  - `scheduler.test.ts`: Emsisoft capabilities, 60 tenants, all mapped → `lengthened: true`; inventory > 60 min; detections ≥ 15.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/edrProviders/persist.test.ts src/jobs/edrProviderSync.test.ts src/services/edrProviders/scheduler.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those three plus `src/services/edrProviders/bitdefender/` → PASS; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(edr): opt-in detail-owned endpoint fields and per-adapter call estimates (#8168)`

---

### Task A3: Strict-unique name matching for identifier-poor vendors

**Why (quorum finding, verified at `externalDeviceMatching/resolve.ts:79-108`):** the shared resolver excludes claimed devices, then links the sole **free** candidate, even when the name matched several devices. It also lets the lowest-id vendor row win a contested device. With MACs that is a reasonable tiebreak. Without them (Emsisoft) it is a guess: a stale duplicate EMC record can take the link, and a manual link on one twin auto-links the other by elimination. Spec §4.6 rule 3 forbids both: "a same-org hostname collision stays ambiguous".

**Files:**
- Modify: `apps/api/src/services/externalDeviceMatching/resolve.ts`, `apps/api/src/services/edrProviders/deviceMatching.ts` (`matchEdrEndpoints` gains the adapter's identifiers)
- Test: `apps/api/src/services/externalDeviceMatching/resolve.test.ts`, `edrProviders/deviceMatching.test.ts`

**Interfaces:**
```ts
export function resolveDeviceMatches(rows: MatchRow[], candidates: MatchCandidate[],
  opts?: { strictUnique?: boolean }): { links: MatchLink[]; ambiguous: string[] };
/** strictUnique: link a row ONLY when (a) exactly one candidate device (claimed or not) in the row's org has
 *  the name AND it is free, and (b) exactly one row in this batch+org has that match name. Otherwise ambiguous.
 *  No MAC step. Default false = today's rules, byte-for-byte. */
export function strictMatchingFor(identifiers: readonly string[]): boolean;   // !mac && !serial
```
`matchEdrEndpoints(tx, connectionId)` (`deviceMatching.ts:43`) has no provider in scope today; its only caller (`edrProviderSync.ts:745`) already holds `adapter`, so the signature becomes `matchEdrEndpoints(tx, connectionId, { strictUnique })` and the caller passes `strictUnique: strictMatchingFor(adapter.capabilities.endpointIdentifiers)`. The "unlinked rows" batch must contain **every** row of the connection that has that name, linked or not, for rule (b). A row already linked by hand counts toward the name's row count. The stale-link pass (`deviceMatching.ts:51-71`) is unchanged: an existing unique link is not undone just because a second Breeze device later takes the name. It is surfaced by the ambiguity count instead, so links do not flap.

- [ ] **Step 1: Failing tests** (pure resolver, `strictUnique: true`):
  - 2 Breeze devices `PC04`, 1 row → ambiguous;
  - 2 devices, one **claimed**, 1 row → ambiguous (today it links the free one; pin the difference);
  - 1 device, 2 rows `pc04` → both ambiguous (today the lower id links);
  - 1 device, 1 row → `auto_hostname`;
  - a row with MACs is still never `auto_mac` under strict;
  - and the same five cases **without** the option equal today's outputs (regression table).
  - `deviceMatching.test.ts`: a GravityZone connection passes `strictUnique: false`, an Emsisoft one `true`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** plus the backup-provider matching tests (`backupProviders/deviceMatching.test.ts` stays green, unchanged) → PASS.
- [ ] **Step 5: Commit** `feat(edr): strict-unique name matching for vendors without MAC/serial (#8168)`

---

### Task A4: Detection locator, group key, sticky attribution, sibling-free details

**Files:**
- Modify: `types.ts`, `persist.ts` (`persistDetections` ~:394-530)
- Test: `persist.test.ts`

**Interfaces:**
```ts
// VendorEdrDetection additions:
/** Adapter-owned vendor locator for later reads/actions on this object (Emsisoft: the incident's sha1 / host / IP).
 *  Written by sync from vendor data only; never from a request. ≤ 255 chars. */
vendorRef?: string | null;
/** Rows sharing a groupKey are ONE vendor object (one Emsisoft incident across N devices). ≤ 128 chars. */
groupKey?: string | null;
```
Persist writes them into `details._breeze = { vendorRef, groupKey }`. Adapter `details` may not contain a top-level `_breeze`: persist overwrites it, and a test pins that. **Sticky attribution:** change `vendorEndpointId` to `COALESCE(edr_detections.vendor_endpoint_id, excluded.vendor_endpoint_id)` and `endpointId` to `COALESCE(edr_detections.endpoint_id, excluded.endpoint_id)` (`persist.ts:522-523`). A detection's vendor endpoint is fixed at its first non-null attribution. A later rename or name reuse can never re-bind it to another machine, and a later null (the name became ambiguous) keeps the earlier link, as today. `breezeDeviceId` keeps its current rule (`:525`). For GravityZone this is a no-op: an incident's endpoint id never changes.

- [ ] **Step 1: Failing tests:**
  - `vendorRef` / `groupKey` land in `details._breeze`;
  - an adapter-supplied `details._breeze` is overwritten;
  - first sync `vendorEndpointId: 'A'`, second `'B'` → stays `'A'` (and `endpoint_id` too);
  - first null then `'A'` → `'A'`;
  - first `'A'` then null → `'A'`;
  - a GravityZone fixture round-trip is unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `persist.test.ts` + `bitdefender/` → PASS.
- [ ] **Step 5: Commit** `feat(edr): detection locator + group key; first attribution is sticky (#8168)`

---

### Task A5: Build `reread_open_on_inventory` (spec §4.3 cursor contract)

**Interfaces:**
```ts
// types.ts
export interface EdrDetectionRef { vendorDetectionId: string; vendorKind: EdrVendorKind; vendorRef: string | null; groupKey: string | null }
export interface EdrDetectionStatusUpdate {
  vendorDetectionId: string; vendorKind: EdrVendorKind;
  status: EdrDetectionStatus; vendorStatus: string | null; severity: EdrSeverity; vendorSeverity: string | null;
  resolvedAt: Date | null; lastVendorUpdateAt: Date | null;
}
// EdrCapabilities: rereadOpenPerRun?: number   // default 20; only read when detectionStatusModel === 'reread_open_on_inventory'
// EdrProviderAdapter:
/** Present iff detectionStatusModel === 'reread_open_on_inventory'. Read-only vendor calls. Returns updates ONLY for refs the
 *  vendor still knows; a ref it cannot find is omitted (never closed). ALL-OR-NOTHING per tenant like listEndpoints. */
rereadDetectionStatus?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, refs: EdrDetectionRef[]): Promise<EdrDetectionStatusUpdate[]>;
// persist.ts
export async function applyDetectionStatusUpdates(tx: EdrSyncTx, o: { connectionId: string; tenantId: string; orgId: string; updates: EdrDetectionStatusUpdate[] }): Promise<number>;
```
Framework flow, in the **inventory** job of `edrProviderSync.ts`:
- **Phase 1 (load):** for mapped tenants, load at most `rereadOpenPerRun` live open rows per tenant: `status IN EDR_OPEN_DETECTION_STATUSES AND detached_at IS NULL AND tenant_id = $t`, `ORDER BY updated_at ASC, id ASC` (rotation: each applied update bumps `updated_at`), with `details->'_breeze'`.
- **Phase 2 (no DB):** call `rereadDetectionStatus` alongside `listEndpoints`. A throw fails **that tenant's inventory**, with the same skip semantics as an endpoint failure.
- **Phase 3:** `applyDetectionStatusUpdates` does a narrow `UPDATE … SET status, vendor_status, severity, vendor_severity, resolved_at, last_vendor_update_at, updated_at = now() WHERE connection_id AND tenant_id AND org_id AND vendor_kind AND vendor_detection_id AND detached_at IS NULL`. It never touches `notified_severity`, so Phase 4 alerts still see an escalation. Rows the adapter omitted get **only** `updated_at = now()` (they rotate to the back). Their status is unchanged.

Registry self-consistency (`registry.test.ts`): `detectionStatusModel === 'reread_open_on_inventory'` ⇒ `typeof rereadDetectionStatus === 'function'`.

- [ ] **Step 1: Failing tests:**
  - `registry.test.ts`: the rule above.
  - `edrProviderSync.test.ts`, with a fake adapter declaring the model:
    - open rows are passed (not closed/detached ones), ≤ the cap, in `updated_at` order;
    - an update `open → false_positive` is applied;
    - an omitted ref keeps `open` but its `updated_at` advances;
    - a throw marks the tenant's inventory failed and leaves rows untouched;
    - a GravityZone (`delta_with_updates`) connection makes **no** call.
  - `persist.test.ts`: `applyDetectionStatusUpdates` never moves `org_id` / `tenant_id`, never touches a tombstone, and leaves `notified_severity` alone.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** plus the existing `edrProviderSync.test.ts` cases unchanged → PASS; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(edr): reread_open_on_inventory — rotate open detections through a read-only status re-read (#8168)`

---

### Task A6: Emsisoft client (read calls, paging, error scope, observed rate-limit headers)

**Files:**
- Create: `emsisoft/client.ts`, `emsisoft/client.test.ts`, `emsisoft/__fixtures__/{account-partner, account-two-partners, account-no-partner, workspaces-page1, workspaces-page2, devices-page1, device-details, device-details-workgroup, incidents-page, incidents-empty, incident-detail}.json`

**Interfaces:**
```ts
export const EMSI_PAGE_SIZE = 100;
export const EMSI_MAX_PAGES = { workspaces: 50, devices: 100, incidents: 20 } as const;   // 5,000 / 10,000 / 2,000 items
export type EmsiPathKind = 'account' | 'workspaces' | 'workspace' | 'device';
export class EmsisoftClient {
  constructor(o: { creds: { apiKey: string }; fetch: GuardedFetch; limiter: EdrRateLimiter;
    sleep?: (ms: number) => Promise<void>; onRateHeaders?: (h: Record<string, string>) => void });
  getAccount(): Promise<EmsiAccount>;
  listWorkspacesAll(): Promise<EmsiWorkspace[]>;
  listDevicesAll(wsGuid: string): Promise<EmsiDevice[]>;
  getDeviceDetails(dvGuid: string): Promise<EmsiDeviceDetails>;
  listIncidentsAll(wsGuid: string, from: Date, to: Date): Promise<EmsiIncident[]>;
  /** Not found -> null: a 404, OR a 400 whose body code is `IncidentNotFound` / `WorkspaceThreatIncorrectTarget`
   *  (the OpenAPI documents no 404 for incidents — only these 400 LogicError codes). */
  getIncident(wsGuid: string, incidentRef: string): Promise<EmsiIncidentDetail | null>;
}
```
DTO types (`EmsiAccount`, `EmsiWorkspace`, `EmsiDevice`, `EmsiDeviceDetails`, `EmsiIncident`, `EmsiIncidentDetail`) carry exactly the fields in the API table, all optional except the guids. Zod-parse each item with `.passthrough()`. An item failing the parse throws `malformed_response` (scope `tenant`).

Request rules:
- `GET https://api.emsisoft.com<path>` with `{ 'Api-Key': apiKey, Accept: 'application/json' }`. `limiter.acquire()` runs before **every** request, pages included.
- Workspace/device guids are validated as uuids **before** path interpolation; `incidentRef` must match `/^[0-9a-f]{40}$|^[0-9a-f]{64}$|^[0-9a-f-]{36}$|^[a-z0-9.:-]{1,253}$/i` and is `encodeURIComponent`-ed. Anything else throws `invalid_vendor_id` with no fetch.
- Paging uses `Skip`/`Take=100` until `skip >= totalCount` or an empty page, deduped by `guid`. Past `EMSI_MAX_PAGES` it throws `too_many_<kind>`: scope `connection` for workspaces, `tenant` otherwise. A page that is not `{ data: [], totalCount: number }` throws `malformed_response`.

Error classification. The **path kind** sets the scope, and `/account` is the only proof of a dead key:

| Response | `account` | `workspaces` (after `/account` succeeded in this context) | `workspace` | `device` |
|---|---|---|---|---|
| 401 / 403 | `auth`, **reauth**, `connection` | `forbidden`, not reauth, `connection` ("key's user cannot list workspaces") | `forbidden`, `tenant` | `forbidden`, `operation` |
| 404 | `not_found`, `connection` | `not_found`, `connection` | `not_found`, `tenant` | `not_found`, `operation` |
| 400 | `invalid_params`, `operation` | same | same | same |
| 429 | `rate_limited` with `retryAfterMs` (`Retry-After` seconds or HTTP-date, cap 120 s); reads sleep + retry ×3, then throw scope `connection` | same | same | same |
| 5xx / network / non-JSON 2xx | reads retry ×3 with backoff, then `vendor_error`, `connection` | `connection` | `tenant` | `operation` |

How "`/account` succeeded in this context" is tracked: the client records a successful `getAccount()` on itself, and the adapter memoizes the client per run in `ctx.runCache`. If a `/workspaces` 401 arrives with no successful `/account` in the run, the client calls `getAccount()` once to tell the two cases apart. Error `message` = `` `Emsisoft ${method} ${pathTemplate}: HTTP ${status}` `` only.

Observed rate-limit headers: per response, collect headers whose name matches `/^(x-)?(rate-?limit|ratelimit)[-a-z]*$|^retry-after$/i` and whose value matches `/^[0-9a-zA-Z.:, -]{1,64}$/`. Hand them to `onRateHeaders` only when the set differs from the last one handed over.

- [ ] **Step 1: Failing tests** (copy the `fx` / `makeFetch` helpers from `bitdefender/client.test.ts:10-40`):
  - `Api-Key` is sent and the key never appears in the URL; one `acquire` per page;
  - workspaces paging 1→2 with a dedupe; `devices` over the cap → `too_many_devices` (tenant) and no partial list;
  - one test per cell of the classification table, including **`/account` OK + `/workspaces` 401 → not reauth** and **workspace `/devices` 401 → tenant, not reauth**;
  - 429 `Retry-After: 2` → sleeps ~2 s, retries, and after ×3 throws `rate_limited`;
  - a bad guid / bad `incidentRef` → `invalid_vendor_id` with **zero** fetches;
  - error messages exclude the key, guids and a body containing `SECRET-SENTINEL`;
  - `onRateHeaders` deduped, and a `<script>` value dropped;
  - non-JSON 200 → retried, then `vendor_error`;
  - `getIncident`: 404 → `null`; 400 with body code `IncidentNotFound` → `null`; 400 `WorkspaceThreatIncorrectTarget` → `null`; any other 400 → `invalid_params` (fixtures `error-400-incident-not-found.json`, `error-400-incorrect-target.json`).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/edrProviders/emsisoft/client.test.ts` → FAIL.
- [ ] **Step 3: Implement**, mirroring `bitdefender/client.ts` structure (fail helper, injected sleep, page-cap constants) over REST + JSON.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(edr): Emsisoft read client — paging, path-scoped error classes, observed rate headers (#8168)`

---

### Task A7: Emsisoft normalizer + incident → device attribution

**Files:**
- Create: `emsisoft/normalize.ts`, `emsisoft/normalize.test.ts`

**Interfaces:**
```ts
export const EMSI_MITIGATING_ACTIONS: ReadonlySet<string>;      // Remediated, Deleted, Blocked, Isolated, RollbackCompleted
export const EMSI_NON_MITIGATING_ACTIONS: ReadonlySet<string>;  // Allowed, PartlyRemediated
export const EMSI_SEVERITY: Readonly<Record<string, EdrSeverity>>;
export const EMSI_PROTECTION_HEALTH: Readonly<Record<string, EdrEndpointHealth>>;
/** Attribution key: trim, strip one trailing '.', lower-case. FULL name — NOT first label. '' -> null. */
export function deviceNameKey(name: string | null | undefined): string | null;
export function incidentStatus(i: Pick<EmsiIncident | EmsiIncidentDetail, 'verdict' | 'actionTaken' | 'actionsTaken'>): EdrDetectionStatus;
export function toVendorEndpoint(d: EmsiDevice, vendorTenantId: string): VendorEdrEndpoint;
export function toEndpointDetail(vendorEndpointId: string, d: EmsiDeviceDetails): VendorEdrEndpointDetail;
/** One row per distinct involved device. deviceIndex: deviceNameKey -> device guid, or null when 2+ devices share the key. */
export function toIncidentDetections(i: EmsiIncident, vendorTenantId: string,
  deviceIndex: ReadonlyMap<string, string | null>): VendorEdrDetection[];
export function detectionIdFor(incidentGuid: string, nameKey: string | null): string;   // ≤ 255, deterministic, no truncation
export function toStatusUpdate(ref: EdrDetectionRef, d: EmsiIncidentDetail): EdrDetectionStatusUpdate;
```

**Status (`incidentStatus`).** Emsisoft has no closed state, so it **never returns `resolved` or `dismissed`**. Every table is **[U]** until the lab aligns it with the console:

| verdict | actions | → |
|---|---|---|
| `ConfirmedBenign` | any | `false_positive` |
| `InInvestigation` | any | `in_progress` |
| `New` / `ConfirmedMalicious` | `actionTaken ∈ MITIGATING` **and** no entry of `actionsTaken` is in `NON_MITIGATING` or `None` / `Reported` | `mitigated` |
| `New` / `ConfirmedMalicious` | otherwise (`None`, `Reported`, `Allowed`, `PartlyRemediated`, mixed, missing) | `open` |
| `Unknown` / missing / unrecognised | — | `unknown` |

A confirmed-malicious verdict is not a remediation. Incident-level actions also do not prove that **every** involved device was cleaned, so any mixed signal stays `open` (quorum finding). Retention: `false_positive` and `mitigated` are already prunable after 180 days (`jobs/edrDetectionRetention.ts:49`). `open` / `unknown` never are.

**Severity:** `Malicious` → `critical`; `LikelyMalicious` → `high`; `Suspicious` → `medium`; `Notable`, `Unwanted` → `low`; `FalseAlert`, `None` → `info`; else `unknown`.
**Health** (detail `protectionStatus`): `Protected` → `healthy`; `PartiallyProtected`, `RebootRequired`, `Connecting` → `degraded`; `NotProtected`, `NotManaged`, `NewlyDiscovered` → `unhealthy`; `Offline`, `UnusedSeat`, else → `unknown`.

**`toVendorEndpoint`** (list item):
- identity and name: `vendorEndpointId = guid`; `hostname` = the trimmed `name` with any trailing dot removed and cut at the first `.` (display casing kept); `fqdn = name` when it contains a `.` (already qualified), else `null`;
- empty because the list does not carry them: `macAddresses = []`, `ipAddresses = []`, `serialNumber = null`;
- placeholders until the detail call fills them: `osPlatform 'other'`, `osName null`, `endpointType 'unknown'`, `agentVersion null`, `health 'unknown'`, `online null`;
- never known: `isolationState 'unknown'` (always; Open Decision 5), `tamperProtection null`;
- `policyName = protectionPolicyGroup`;
- `lastSeenAt null` **[U]**: `lastUpdate` may be the signature update time, so it is kept in `raw` only until the lab says otherwise;
- `raw` = the list item.

**`toEndpointDetail`:**
- `fqdn`: when `domain` contains a `.`, `` `${firstLabel(name)}.${domain}`.toLowerCase() ``; when `domain` is empty or a NetBIOS workgroup such as `WORKGROUP` (no dot), **explicit `null`**; when the detail has no `domain` key, `undefined` (A2: not fetched ≠ null);
- `ipAddresses`: IPv4 then IPv6, across adapters, deduped, at most 16;
- `osName = os`; `osPlatform = osPlatformFromName(os)`; `endpointType`: `server` if `/server/i` matches the OS, else `workstation` (when `os` is present);
- `online`: `Online` → true, `Offline` → false, else null;
- `health`: per the table above; `agentVersion = version`.

**Attribution rule** (Open Decision 3; quorum-reviewed):
1. `deviceIndex` is built from the **same workspace's** `listDevicesAll` list, keyed by `deviceNameKey(name)` on the **full** name. A key seen once maps to that device's guid. A key seen twice or more maps to `null`.
2. Distinct involved-device keys yield one row each. Duplicate and empty entries collapse; if none remain, one row with `nameKey = null`. Each row gets `vendorEndpointId = deviceIndex.get(key) ?? null`.
3. `detectionIdFor(guid, key)` is `guid` when the key is null. It is `` `${guid}:${key}` `` when that is ≤ 255 chars, else `` `${guid}:h:${sha256hex(key).slice(0, 40)}` ``. That is deterministic, collision-safe and never truncated (persist clips at 255, `persist.ts:477`).
4. Each row gets `vendorKind 'incident'`, `vendorRef = sha1 ?? hostAddress ?? null`, and `groupKey = guid`.
5. Content fields:
   - `severity = EMSI_SEVERITY[highestSeverity]`; `vendorStatus = \`${verdict}/${actionTaken}\``;
   - `title = knownFileNames[0] ?? hostAddress ?? type`; `category = detectionComponent`; `filePath = knownFileNames[0] ?? null`;
   - `threatName null`, `processName null`, `mitreTechniques []` (the per-incident detail is not fetched on discovery);
   - `detectedAt = lastDetectionAt` **[U]**: the list has only the last detection time;
   - `resolvedAt = lastDetectionAt` when the status is `false_positive` or `mitigated`, else null; `lastVendorUpdateAt = lastDetectionAt`.
6. `details = { incidentGuid, type, verdict, actionTaken, actionsTaken, involvedDeviceName: <this row's original string>, deviceNameAmbiguous, involvedDeviceCount, sha256, detailsPageLink }`. **No sibling names and no `involvedDeviceUsers`** (Global Constraints). `detailsPageLink` is a vendor console URL, shown only to MSP users. The portal never projects `details`.
7. Renames: the stored attribution is sticky (A4), so name reuse cannot re-bind an old incident to the new holder of the name. A first sight after a rename can still attribute to the current holder. That residual risk is documented, and the UI shows `involvedDeviceName` next to the link.
8. If the lab shows `involvedDevices` holds **guids**, step 1 becomes a membership check of the guid against the same workspace's device list. A guid not in that list gives `null`. The test names stay the same, and the fixture changes.

`toStatusUpdate(ref, detail)` recomputes `status` / `vendorStatus` / `severity` (`detail.severity`) / `resolvedAt` from the detail. `lastVendorUpdateAt` is the max `detections[].dateTime`, or null.

- [ ] **Step 1: Failing tests** (table-driven):
  - every status row, including `ConfirmedMalicious + None → open`, `New + Remediated` with `actionsTaken ['Remediated', 'Allowed'] → open`, an unrecognised verdict → `unknown`, and a cartesian guard that `resolved` / `dismissed` are never produced;
  - every severity and health row;
  - `toEndpointDetail`: domain `corp.example.test` / `WORKGROUP` / missing key → fqdn string / `null` / `undefined`; IPs flattened, deduped and capped;
  - attribution:
    - `PC01` and `pc01.corp.example.test` in one workspace are **two different keys** (full-name rule), so an incident on `PC01` resolves;
    - two devices both named `PC01` → null plus `deviceNameAmbiguous`;
    - duplicate and empty involved entries collapse;
    - zero devices → one bare-guid row;
    - a 300-char name → `guid:h:<40 hex>`, stable across calls;
    - two incidents with the same device give distinct ids;
    - `details` never contains a sibling's name or any `involvedDeviceUsers` value (assert on `JSON.stringify`);
    - a trailing-dot name equals its dotless twin;
  - `toStatusUpdate` maps a ConfirmedBenign detail → `false_positive`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/edrProviders/emsisoft/normalize.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(edr): Emsisoft normalizer — status/severity/health tables, per-device incident rows (#8168)`

---

### Task A8: Emsisoft adapter

**Files:**
- Modify: `emsisoft/adapter.ts`
- Test: `emsisoft/adapter.test.ts`

**Interfaces:** `EdrProviderAdapter` (`types.ts:146-213`) plus A5's `rereadDetectionStatus`. `clientFor(ctx)` memoizes one `EmsisoftClient` per `ctx` in `ctx.runCache` (`emsi:client`). Its `onRateHeaders` logs `console.info('[edr:emsisoft] observed rate-limit headers', h)` the first time per run. The first response of a run with none logs `{ none: true }` once, so the lab can see that the vendor sends nothing.

`testConnection(ctx)`:
1. `getAccount()`. An `auth` error gives `{ ok: false, error, reauth: true }`.
2. Root:
   - **one partner**: `rootType 'partner'`, `rootId = partners[0].guid`, `rootName = partners[0].id ?? 'Emsisoft partner'`;
   - **several partners**: `{ ok: false, reauth: false, error: 'This API key belongs to a user in several Emsisoft partner accounts; create the key as a user of one partner' }`, because `vendorRootMismatch` (`routes/edr/connections.ts:339`) needs one stable root;
   - **no partner**: `rootType 'workspace_user'`, `rootId = 'user:' + sha256hex(email.trim().toLowerCase()).slice(0, 32)`, `rootName 'Emsisoft workspace user'`. The email is never stored, logged or returned. No email gives `{ ok: false, reauth: false, error: 'Emsisoft did not return an account identity for this key' }`.
3. `listWorkspacesAll()` gives `tenantCount`. A `forbidden` (connection, not reauth) gives `{ ok: false, reauth: false, error: 'The key's user cannot list workspaces' }`.
4. One probe, `GET /v1/workspaces/{first}/devices?Take=1`. On `forbidden`, add the note `'workspaces: device access denied for at least one workspace (licence-manager role?)'`; the test stays `ok: true`.

`listTenants(ctx, root)`: `listWorkspacesAll()` → `{ vendorTenantId: guid, name, parentId: null, tenantType: 'workspace', externalCode: null, apiHost: null }`. No Emsisoft field can carry an external code, so mapping is name-suggestion-only (§4.5). An expired workspace is still a tenant.

`listEndpoints`: `listDevicesAll(ws).map(toVendorEndpoint)`. `countEndpoints`: the same list's length.

`enrichEndpoints(ctx, tenant, ids)`: `getDeviceDetails` per id → `toEndpointDetail`. `not_found` / `invalid_params` → skip the id. `forbidden` (operation) → stop and return what was gathered. A `connection` scope → rethrow. This mirrors `bitdefender/adapter.ts:243-260`.

`listDetections(ctx, tenant, cursor, now)`:
1. **Discovery window:** `from = now − firstSyncLookbackDays`, `to = now`, every run. The cursor is written as `{ v: 1, windowEnd }` for observability and never read for the window. Status changes on older rows arrive through the re-read (A5).
2. If any incident names a device, build the device index from `listDevicesAll(ws)`, memoized per run as `emsi:devices:<ws>`. `ctx.runCache` is per job run (`context.ts`), so this saves calls within one detection run only. Do not build a cross-job cache.
3. A `forbidden` on `/incidents` **throws** (tenant failure, D10 keep-and-mark-stale). It is not swallowed into `warnings`: a workspace has only one detection source, and an empty success would read as "no threats".

`rereadDetectionStatus(ctx, tenant, refs)`: group refs by `groupKey`, then make **one** `getIncident(ws, vendorRef)` per group. A ref with a null `vendorRef` is omitted. A `null` (404) result omits the group's refs (never closed). Each fetched detail maps through `toStatusUpdate` to **every** ref in the group. Errors per group: a connection-scope error rethrows; `forbidden` (tenant) → tenant failure; **any `operation`-scope error (`invalid_params`, a device-path `not_found`) omits that group's refs and continues**, so the framework still rotates them (A5 bumps `updated_at` on omitted refs). One dead or purged incident must never block a tenant's inventory or the rotation.

- [ ] **Step 1: Failing tests:**
  - `testConnection`:
    - one partner → partner root;
    - two partners → refused, not reauth;
    - no partner → a 32-hex root, equal for `' A@Example.Test '` and `'a@example.test'`, with the email absent from `JSON.stringify(result)`;
    - `/account` 401 → reauth;
    - `/workspaces` 401 after an OK `/account` → `ok: false`, not reauth;
    - a probe 401 → a note, `ok: true`.
  - `listTenants`: paging; an expired workspace is kept.
  - `listEndpoints`: first-sight values.
  - `enrichEndpoints`: skip on 404, stop on `forbidden`, rethrow on connection.
  - `listDetections`:
    - the window is `[now−30d, now]` whatever the cursor holds;
    - the device list is fetched once for three incidents and zero times when none names a device;
    - a same-name device in **another workspace** never resolves (two tenants, one shared `runCache`);
    - `forbidden` throws tenant scope.
  - `rereadDetectionStatus`:
    - one vendor call for three sibling refs, applied to all three;
    - a 404 omits them;
    - a null-`vendorRef` ref is omitted with no call;
    - a 400 `IncidentNotFound` and an unrelated 400 on one group omit that group only, the other groups still update, and the call resolves (no tenant failure).
  - Rate-header log fires once per run.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/edrProviders/emsisoft/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(edr): Emsisoft adapter — test, workspaces, devices, incidents, status re-read (#8168)`

---

### Task A9: Through the real sync job

**Files:** `apps/api/src/jobs/edrProviderSync.test.ts` (extend). No production code is expected. If any is needed, the interface has a hole: fix it in the framework and say so in the PR.

- [ ] **Step 1: Failing tests** with the real `emsisoftAdapter` and a fixture `fetch`:
  - two workspaces with one mapped: endpoints are stored for the mapped one and only counted for the other (D5);
  - a second run without details for an endpoint keeps `osName` / `online` / `health` / `fqdn` (the A2 detail-owned guarantee, end-to-end);
  - a workspace `/devices` 401 → that tenant's inventory fails, the connection stays `connected`, and the other tenant syncs (Review Focus 2);
  - `/account` 401 → connection `reauth_required` + `UnrecoverableError`;
  - a detection run writes per-device rows, and a second run with a changed verdict updates the same rows with no duplicates;
  - an inventory run re-reads an open row older than the window and flips it to `false_positive` (Review Focus 3).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/jobs/edrProviderSync.test.ts` → FAIL → wire fixtures → PASS.
- [ ] **Step 3: Commit** `test(edr): Emsisoft through the real sync job (#8168)`

### Task A10: Real-Postgres cases + docs

**Files:** `apps/api/src/__tests__/integration/edrProviderSync.integration.test.ts` (extend), `apps/docs/src/content/docs/features/edr-provider-framework.mdx`

- [ ] **Step 1: Integration cases**, as `breeze_app` with the suite's existing harness:
  - **(a) strict matching:** org A has devices `PC01`, `PC04`, `PC04`; org B has `PC03`. Emsisoft endpoints under org A: `pc01`, `pc03`, `pc04`. Expected: `pc01` links `auto_hostname`; `pc03` stays unlinked (org B is never a candidate); `pc04` stays ambiguous. Link one `PC04` by hand to `pc04`: a second `pc04` endpoint stays ambiguous and is **not** linked to the other twin.
  - **(b) sticky attribution:** persist a detection attributed to endpoint E1, then the same id attributed to E2. It stays on E1.
  - **(c) re-read rotation on real rows:** two open rows; the cap is 1; two inventory runs re-read each once.
  - **Red first:** for (a), first assert the pre-A3 behaviour (the twin links) against a stack without A3, record the red, then apply A3.
- [ ] **Step 2: Docs.** An "Emsisoft (cloud EMC)" section:
  - key setup: a dedicated EMC user in the partner account with access to every workspace Breeze should see; the key is created in that user's profile;
  - what syncs; matching by device name only, with duplicates left for manual linking;
  - no isolation;
  - detections re-read for 30 days, and older open ones re-checked about 20 per workspace per hour;
  - cadence 15/60 min, lengthened for large partners.
  - Mention actions only after PR-B merges.
- [ ] **Step 3: Run** on `pnpm test-stack up`, then `pnpm test-stack down`.
- [ ] **Step 4: Commit** `test(edr): Emsisoft-shaped matching, attribution and re-read on real rows; docs (#8168)`

### Task A11: Owner lab gate (blocks merging PR-A)

Needs an Emsisoft **partner** account (or trial) with at least two customer workspaces, one lab VM protected in one of them, and an API key. Todd provides the key (Open Decision 7). Use it from a local wt-stack only, never commit or print it, and keep it in the gitignored `.env` or memory. The Emsisoft agent goes on a **nested brzlab VM, never a host with an installed Breeze agent**.

Record in the PR body (no customer names, hostnames or key material):
- [ ] **Tenant model (D3):** what a partner-user key sees on `/v1/account` (partner count) and `/v1/workspaces` (all customer workspaces, or only invited ones?), and whether `/devices` and `/incidents` are readable in each. Repeat with a key from a workspace-only user. This settles Open Decision 1.
- [ ] **Permission shape:** which paths return 401 versus 403 for a licence-manager key. Confirm the A6 table, or change it and its tests.
- [ ] **Rate limits:** the `observed rate-limit headers` log line from a full sync, or `none`. If headers exist, set `requestBudget` from them with 20% headroom, as its own commit.
- [ ] **Shapes [U]:** `involvedDevices` names versus guids (decides A7 step 8); whether the list `name` is short or qualified; what `lastUpdate` means; whether a verdict change moves `lastDetectionAt`; whether the list includes NotManaged / NewlyDiscovered / UnusedSeat devices; whether `GET /incidents/{sha1}` and `/{guid}` both work (decides the PR-B locator). Replace the synthetic fixtures with **scrubbed** real shapes: same keys, synthetic values.
- [ ] **Installer shape (W06 input only):** call `GET /v1/workspaces/{ws}/install` once by hand. Record the **field names** and whether `installToken` rotates per call. Never record the values.
- [ ] **End-to-end:**
  - connect → the lab workspaces appear → map one to a lab org;
  - inventory links the lab VM to its Breeze device, or lists it ambiguous with the reason;
  - drop the EICAR test file on the VM → the next detection run shows the row under source `emsisoft` in Security → EDR and the incidents feed;
  - mark it benign in the EMC console → Breeze shows `false_positive` within one detection run;
  - set an older incident benign → the inventory re-read flips it.
- [ ] Tear down: delete the lab connection, `pnpm wt-stack down`, and say what was left running.

### Task A12: PR-A verification gate

- [ ] `tsc` (api, shared, web) exit 0, read from the exit code.
- [ ] Targeted suites: `src/services/edrProviders/` (whole directory), `src/services/externalDeviceMatching/`, `src/services/backupProviders/deviceMatching.test.ts`, `src/jobs/edrProviderSync.test.ts`, `src/routes/incidents.validation.test.ts`, `src/services/logRedaction.test.ts`, `src/__tests__/mcp-coverage.test.ts` (unchanged: no new route); web `src/lib/__tests__/edrProviders.test.ts`.
- [ ] Full API unit run `cd apps/api && npx vitest run`.
- [ ] Test stack (per worktree: copy the root `.env`, blank the AI keys, `BREEZE_WORKSPACE_ENABLED=false`, a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24`): `edrProviderSync.integration`, `edrProviderRls.integration`, `edrReadModel.integration`, `portalEdrVisibility.integration` (proves `details` is still not projected), then `pnpm test-stack down`. Tenancy registrations are unchanged, so the cascade/export suites are not required.
- [ ] One independent review round (Sonnet). Act only on confirmed findings.

---

# PR-B — actions (only what the lab proves)

Branch from `main` after PR-A merges. Re-read the merged `emsisoft/adapter.ts`, `actions.ts`, `actionTargets.ts`, `actionAvailability.ts` and `aiToolsEdr.ts`. Do not trust this plan's line numbers over merged code.

## File Structure (PR-B)

| File | Change |
|---|---|
| `emsisoft/client.ts` | `startQuickScan`, `setIncidentVerdict` (writes: no retry) |
| `emsisoft/adapter.ts` | `actions`, `operationBudgets.actions`, `supportsAction`, `performAction`, `reconcileAction` |
| `services/edrProviders/types.ts` | `EdrActionRequest` detection target `+ vendorRef: string \| null`; capabilities `groupScopedActions?` |
| `services/edrProviders/actionTargets.ts`, `actions.ts` | Fill `vendorRef` from `details._breeze`; incident-group authorization + group in-flight check |
| `services/edrProviders/actionAvailability.ts`, `routes/edr/detections.ts` | `describeDetectionActions`; detection rows carry `actions` |
| `services/aiToolsEdrDetection.ts` (new) + every registry | `edr_detection_action` |
| `apps/web/src/lib/edrProviders.ts`, `components/security/OtherEdrDetectionList.tsx`, `packages/shared/src/types/edr.ts` (`EdrDetectionDto.actions`), `locales/*` ×8 | "Mark false positive" through `runAction` |

### Task B1: Client write calls

```ts
startQuickScan(dvGuid: string): Promise<{ scanGuid: string | null }>;
setIncidentVerdict(wsGuid: string, incidentRef: string, verdict: 'ConfirmedBenign'): Promise<void>;
```
Both follow the W03 A3 write contract. A network error, 5xx or unparseable 2xx throws `outcome_unknown` at once, with no sleep and no loop. A 429 throws `rate_limited` without sleeping. A 401/403 on these device/workspace paths throws `forbidden` with scope `operation` (`recordTenantDenial` then applies, W03). The scan body is pinned: `{ detectPups: false, performanceMode: 'ReducedPriority', onScanCompletion: 'QuarantineDetections', detectRegistryPoliciesSettings: false }` (Open Decision 8).

- [ ] **Tests first:**
  - a write is never retried (502 → `outcome_unknown`, fetch called once);
  - a 429 on a write does not sleep;
  - **no write body ever contains `Shutdown`** (asserted across every write method);
  - the scan path is exactly `/v1/devices/{guid}/scans/start-quick`;
  - the verdict body is `{ verdict: 'ConfirmedBenign' }`;
  - a bad ref → no fetch.

  Then FAIL → implement → PASS → commit `feat(edr): Emsisoft write calls — no retry, no shutdown modes (#8168)`.

### Task B2: Adapter actions + the trusted locator

**Interfaces:**
- `capabilities.actions = ['scan', 'mark_false_positive']` (only what B7 proves); `operationBudgets: { actions: { perMinute: 10 } }`. This activates the W03 action reserve (`rateLimiter.ts`).
- `capabilities.groupScopedActions = ['mark_false_positive']`, a new optional capability (`readonly EdrDetectionActionKey[]`): "an action on one row changes every row sharing its `groupKey`".
- `EdrActionRequest` detection target becomes `{ kind: 'detection'; vendorDetectionId; vendorKind; vendorRef: string | null }`. `actionTargets.ts` fills `vendorRef` from the authorized row's `details->'_breeze'->>'vendorRef'`, which sync wrote from vendor data (A4). It never comes from request input. GravityZone ignores it.

`supportsAction(facts, action)`, in order:
1. not declared → `'Not supported by Emsisoft'`;
2. `isolate` / `unisolate` → `'Emsisoft has no per-device isolation through its API'`;
3. `scan` with `vendorEndpointId === null` → `'Endpoint not linked to this vendor'`;
4. a tenant denial → `"This workspace's Emsisoft key or licence does not allow this action"`;
5. ok.

Offline devices are allowed **[U]**. If B7 shows EMC does not queue commands for an offline device, add `online === false → 'Device is offline'` with its test. A missing `vendorRef` for `mark_false_positive` is refused in `performAction`, before any fetch, as `unsupported_action`. Dispatch has already refused it as `unsupported` at capability time via a new fact, `EdrActionTargetFacts.detectionVendorRefPresent: boolean | null`, filled by dispatch for detection targets.

`performAction`:
- `scan` → `startQuickScan` → `{ status: 'succeeded' }`. The vendor accepted the command and there is no status read. UI and AI copy say "scan requested".
- `mark_false_positive` → `setIncidentVerdict(ws, vendorRef, 'ConfirmedBenign')` → `{ status: 'succeeded' }`.
- Any other request throws `unsupported_action`.

`reconcileAction`: scan → `'unknown'` (settles `failed` for a human to re-issue, as GravityZone scan does). `mark_false_positive` → `getIncident(ws, vendorRef)`: verdict `ConfirmedBenign` → `'applied'`; another verdict → `'not_applied'`; a null result (incl. a 400 `IncidentNotFound`) or a read failure → `'unknown'`.

- [ ] **Tests first:**
  - the `supportsAction` table and its order;
  - `performAction` per action, plus the unsupported guard and the missing-ref guard (zero fetches);
  - the `reconcileAction` table;
  - `actionTargets` reads `vendorRef` from `details._breeze` and ignores any request field;
  - `capabilities.test.ts` snapshot gains `action:scan`, `action:mark_false_positive`;
  - the `registry.test.ts` loop holds: `actions` non-empty, so `performAction` exists.

  Commit `feat(edr): Emsisoft scan + mark-false-positive actions (#8168)`.

### Task B3: Incident-group authorization in `dispatchEdrAction` (quorum finding — blocker if missing)

A verdict applies to the whole Emsisoft incident, but W03 dispatch authorizes only the selected row and its device (`actions.ts` site check; `actionTargets.ts:78` in-flight key). For an action in `adapter.capabilities.groupScopedActions`, dispatch adds three steps after target resolution and before the insert:

1. **Load the group under the caller's RLS context:** every live row with the same `connection_id` and `tenant_id` whose `details->'_breeze'->>'groupKey'` **or** `details->'_breeze'->>'vendorRef'` equals the target's. The verdict is written to `vendorRef` (sha1 / host / IP), and two incident guids can share one sha1, so authorizing by guid alone would miss rows the write changes. Then count the same set under `withSystemDbAccessContext`, keyed by the authorized row's ids only. **If the counts differ, refuse `site_denied` 403**: some sibling is invisible to the caller.
2. **Site rule:** for a site-restricted caller, **every** sibling's `breeze_device_id` must be non-null **and** in `restriction.allowedDeviceIds`. A null (unknown attribution) or an out-of-site device → `site_denied` 403. An unrestricted caller passes step 2.
3. **Group in-flight / cooldown:** refuse `action_in_progress` 409 if any sibling has a `queued` / `submitted` row for the same action, and `action_recently_requested` 409 if any sibling succeeded inside the W03 60-second cooldown. The re-check inside the insert transaction takes the advisory lock on `(vendorRef, action)` (the write target) instead of `(target, action)`.

The ledger row and audit name the acted-on row and add `details.groupSize` and `groupKey` to the audit `details`. Reconciliation is by group: once one sibling's action is settled `succeeded`, any other in-flight row for the same group+action is reconciled `applied` by the next status poll (the reconciler's existing `reconcileAction` already reads the incident verdict). No new code path calls `performAction` (`edrActions.chokepoint.contract`).

- [ ] **Tests first** (`actions.test.ts`):
  - unrestricted caller, group of 3 → dispatched once;
  - restricted caller with all siblings in-site → dispatched;
  - one sibling out of site → `site_denied`, **no insert, no vendor call**;
  - one sibling with a null device → `site_denied`;
  - an RLS-visible count lower than the system count → `site_denied`;
  - a sibling in flight → 409;
  - a sibling succeeded 30 s ago → 409;
  - a non-group action (scan) is unaffected;
  - a GravityZone connection (no `groupScopedActions`) is unaffected;
  - two incident guids sharing one sha1, with one guid's device out of site → `site_denied` (the group is the union by `vendorRef`).

  Plus an `edrActions.integration.test.ts` case on real RLS with a site-restricted technician. Commit `feat(edr): group-scoped EDR actions require authority over every affected device (#8168)`.

### Task B4: Register `edr_detection_action` everywhere W03 deferred

The tool lives in a **new module**, `services/aiToolsEdrDetection.ts`, registered from the same place `registerEdrTools` is wired. The user-owned-release contract pins **exactly one** `requestedBy: auth.user.id` in `aiToolsEdr.ts` (`aiTools.userOwnedRelease.contract.test.ts:346-351`, line-keyed at `:239`), so a second write site there would break it. The new file gets its own single write site and its own contract block. `aiToolsEdr.ts:239` and its alias stay untouched. **The enum is `['mark_false_positive']` only** (approvalScope contract, `aiToolsEdr.actions.test.ts:139-141`).

| File | Entry |
|---|---|
| `services/aiToolsEdrDetection.ts` (new) | Tool spec: base tier 3, `selfManagedDbContext: true`, **no `deviceArgs`** (the target is a detection; site, org and group authorization run inside dispatch, B3). Schema `{ detectionId: uuid, action: enum(['mark_false_positive']), reason?: string ≤ 500 }`. Description ≤ 300/160: `"Mark an EDR detection as a false positive in its vendor console. Applies to the whole vendor incident. Requires approval."`. Handler copies `edr_endpoint_action`'s order: approver mismatch → MFA → tier-3 without `actionIntentId` → `approval_required` → `dispatchEdrAction({ …, requestedBy: auth.user.id, … }, { kind: 'detection', detectionId, action })`. One literal write line. `const EDR_AI_DETECTION_ACTIONS = ['mark_false_positive'] as const;`. No `if (action === …)`. |
| `aiToolSchemas.ts` (~:902) | zod twin; no `z.undefined()` |
| `aiGuardrails.ts` | `TIER3_ACTIONS.edr_detection_action = ['mark_false_positive']` (~:463 block); `TIER3_FOUR_EYES_ACTIONS.edr_detection_action = ['mark_false_positive']` (~:531); `TIER3_FOUR_EYES_TOOLS` += `'edr_detection_action'` (~:585); `TOOL_PERMISSIONS` `{ resource: 'devices', action: 'execute' }` (~:934). No Tier-2 or supervised row. |
| `aiGuardrails.approvalScope.contract.test.ts:158-159` | Add to the whole-tool four-eyes backstop list |
| `aiToolRateLimits.ts` (~:159) | `edr_detection_action: { limit: 10, windowSeconds: 600 }` |
| `aiAgentSdkTools.ts` (`TOOL_TIERS` ~:220; handler block ~:1945) | tier 3 + `makeHandler` |
| `aiAgents/agentToolCatalog.ts` (~:198) | `'security_response'`; check `agentToolCatalog.categoryParity.test.ts:115` |
| `mcpCoverage.ts:335-338` | `'edr/actions.ts': { tools: ['edr_endpoint_action', 'edr_detection_action'] }`; delete the "not registered yet" comment |
| `jobs/intentReleaseWorker.ts` (~:903-911) | `'edr_detection_action:mark_false_positive'`, and **only** that key (extend the existing comment) |
| `actionIntents/effectDigestCoverage.contract.test.ts` (~:91-94) | `sharedReason(['edr_detection_action', 'edr_detection_action:mark_false_positive'], 'EXTERNAL: the verdict lives in the EDR vendor console; edr_detections rows are rewritten by every detection sync and inventory re-read, so pinning one would fail closed on routine syncs. Release re-resolves the detection and its whole incident group under live RLS and the site rule (#8168).')` |
| `aiTools.userOwnedRelease.contract.test.ts` | New `ACTION_GUARD_ALIASES` entry `['services/aiToolsEdrDetection.ts:<line>', ['mark_false_positive']]` (**line-keyed**: compute it after the final edit); a parallel assertion block for the new file (that line matches the literal, exactly one write site, the enum literal, no `if (action ===`) |
| `services/aiToolIndex.ts` (index text; budget comment in `aiToolIndex.test.ts`) | `edr_detection_action (mark_false_positive)` on the Integrations line. **Pay for the bytes by tightening another note**, and record the measured size in the `aiToolIndex.test.ts:136-146` comment. Never raise the ceiling. |
| `llm/toolEval/goldenPrompts.ts` (~:88) | `"The Emsisoft detection on FRONTDESK-02 is a known-good updater — mark it as a false positive."` → `{ tool: 'edr_detection_action', action: 'mark_false_positive' }` |
| `apps/web/src/components/ai-risk/tierConfig.ts` (~:229/317/483) + `locales/*/settings.json` (~:3479) ×8 | Tier row `{ toolName: 'edr_detection_action', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' }`, display row, 8 locale strings |
| `aiToolsEdr.actions.test.ts:122-125` | **Invert** the "NOT registered" test: now registered at tier 3, a `TIER3_FOUR_EYES_TOOLS` member, enum exactly `['mark_false_positive']`; `checkGuardrails('edr_detection_action', { action: 'mark_false_positive', detectionId })` → tier 3 `four_eyes`; `'rollback'` (outside the enum) → fails closed to tier 3 `four_eyes` |

Not added to `HELPER_TOOL_SCOPING` or the helper whitelists: Breeze Helper never changes vendor verdicts.

- [ ] **Step 1: Failing tests** in `aiToolsEdr.actions.test.ts` (or a sibling `aiToolsEdrDetection.test.ts`):
  - registration;
  - MFA and approver mismatch;
  - no intent → `approval_required` and **no dispatch**;
  - with an intent → dispatch with `requestedVia 'ai'`, `approvalId`, `aiSessionId` and `{ kind: 'detection' }`;
  - an agent-release context → `requestedBy` is the approver;
  - `site_denied` from dispatch maps to `{ error: 'site_denied' }`;
  - the output carries no vendor text.
- [ ] **Step 2: Run** → FAIL. **Step 3: Register** every row in the table.
- [ ] **Step 4: Run** the new suite and the known traps. Each must pass by fixing registrations, never the contracts:
  - `aiTools` contracts: `aiTools.userOwnedRelease.contract`, `aiToolsActorParity.contract`, `aiTools.descriptionBudget.contract`, `aiTools.deviceArgsCoverage.contract`, `aiToolsDeviceScope.contract`, `aiToolsSiteScope.contract`, `aiToolsRegistryParity`, `aiToolIndex`;
  - `aiGuardrails` contracts: `aiGuardrails.approvalScope.contract`, `aiGuardrails.agentPrincipal.contract`, `aiGuardrails.readonly.contract`, `aiGuardrails.tier1WriteActions.contract`, `aiGuardrailsTierConfig.parity`, `aiGuardrailsAiDocs.parity`, `aiGuardrails.routeParity.contract`, `aiGuardrails.routeBinding.contract`;
  - the rest of the API: `aiAgentSdkTools.mcpCoverage`, `__tests__/mcp-coverage`, `edrActions.chokepoint.contract`, `actionIntents/effectDigestCoverage.contract`, `aiAgents/agentToolCatalog.categoryParity`, `llm/toolEval/goldenPrompts` (and its harness `goldenPrompts.test.ts`), `jobs/intentReleaseWorker`, `secretBearingTools.contract` (confirm that no entry is demanded);
  - web: `apps/web/src/lib/i18n/localeParity.test.ts`, `components/ai-risk/tierConfig.systemCleanup.test.ts` (the only tierConfig test; add a `tierConfig` row assertion there or in a new `tierConfig.edr.test.ts`).
- [ ] **Step 5: Commit** `feat(edr): edr_detection_action (mark false positive) with four-eyes approval (#8168)`

### Task B5: Detection action availability + web button

`describeDetectionActions(detection, endpoint | null, tenant, connection): EdrEndpointActionAvailability[]` lives in `actionAvailability.ts`. It is the pure twin of the endpoint version, over `EDR_DETECTION_ACTIONS`. A tombstoned detection gets `'Detection is detached (history only)'`; a missing locator gets `'This detection cannot be addressed in the vendor console'`. `GET /edr/detections` rows gain `actions` (add `actions?: EdrEndpointActionAvailability[]` to `EdrDetectionDto`, `packages/shared/src/types/edr.ts:111`). Group authorization (B3) is a dispatch-time check: availability does not pre-compute it. A refused click returns `site_denied`, which the toast shows. Web: `postEdrDetectionAction(detectionId, action, reason?)` through `runAction`. The button lives in `apps/web/src/components/security/OtherEdrDetectionList.tsx` (already imports `ActionError`). It renders only when `actions` lists it; disabled, it shows its reason. Its confirm says *"This marks the whole Emsisoft incident as benign for every device involved (N)"* (`N = details.involvedDeviceCount`). All 8 locales.

- [ ] Tests first:
  - the availability table (detached, no locator, connection actions off, kill switch, unsupported, ok);
  - route rows carry `actions`;
  - web: one POST through `runAction`, a silent 401, the confirm copy includes N, and `site_denied` is toasted.

  Commit `feat(edr): detection action availability + mark-false-positive button (#8168)`.

### Task B6: PR-B verification

- [ ] `tsc` (api, shared, web) exit 0.
- [ ] The B4 trap list, plus `src/services/edrProviders/`.
- [ ] `edrActions.integration.test.ts` on the test stack, extended with the B3 group cases on real RLS and a tombstoned detection → `target_detached`. Then `pnpm test-stack down`.
- [ ] Full API unit run.
- [ ] One independent review round, **Sonnet or Opus** (high blast radius). Act on confirmed findings only.

### Task B7: Action lab gate (blocks *enabling* actions, as in W03)

Actions ship dark: `edr_connections.actions_enabled` defaults false (W03). Before Todd enables a production connection, record in the PR:
- [ ] `start-quick` → 200 + `scanGuid`. Whether EMC queues the command for an offline device (decides the B2 offline rule). Whether the `QuarantineDetections` completion quarantines the EICAR file.
- [ ] `PUT …/incidents/{sha1}/verdict` works (and whether `{guid}` does). Whether incident guid ↔ sha1 is 1:1 in a workspace (B3 groups by both either way). After a Breeze mark-FP, the console shows the incident benign, and every sibling row flips on the next detection run.
- [ ] If the lab can produce a key without the permission: `forbidden` → 422, the tenant denial is recorded, and the button is disabled with its reason.
- [ ] Before merge, remove any action the lab did not prove. For `mark_false_positive`, that means backing out B3–B5 and B4's registrations.

---

## Open Decisions (Gate B — Todd)

1. **Tenant model (D3).** One code path serves both cases: `listTenants` returns whatever `/v1/workspaces` returns. The decision is only the declared `tenantModel` and the setup copy. **(a) `'partner'`:** a partner user's key enumerates every customer workspace, with one connection per MSP. **(b) `'single'`:** each key sees one workspace, and the MSP adds a connection per customer (D3 allows many). **Recommend (a)**, with per-workspace permission failures shown as tenant errors plus a test note. Switch to (b) only if the lab shows a partner key cannot read devices/incidents in customer workspaces. No code path changes either way.
2. **Status-change / "resolved" model.** Emsisoft has no closed state, and verdict changes do not move the only date filter **[U]**.
   - **(a)** Re-list 30 days by last detection, every detection run, and nothing else. Cheapest, but verdicts changed after day 30 are never seen, so stuck-open rows accumulate.
   - **(b)** The framework's spec'd `reread_open_on_inventory` alone. Exact, but discovery still needs a window.
   - **(c)** The 30-day discovery window plus the `reread_open_on_inventory` rotation (≤ 20 incident reads per workspace per inventory run, one per incident group, never auto-closing on "not found").

   **Recommend (c).** My first draft recommended (a), and Codex disagreed. On review, the stuck-open rows are cumulative and customer-visible: open counts reach the portal. (c) builds the path the spec's cursor contract already names, instead of inventing a third model. Status mapping: never `resolved`; `ConfirmedBenign → false_positive`; mitigated only on an unambiguous mitigating action set; everything else `open`.
3. **Matching + attribution rule** (quorum-reviewed).
   - **Device ↔ Breeze device:** the same-org name matcher in **strict-unique** mode for vendors without MAC/serial. It links only when exactly one device and exactly one vendor row share the name. It never elects a device by elimination or by row order. IPs are stored and never used.
   - **Incident ↔ vendor device:** one row per involved device. The device is resolved by **full** name inside the same workspace. An ambiguous name gives a null endpoint, and first attribution is sticky.

   **Recommend accept.** The alternative, one row per incident attributed to its first device, breaks site restriction and D14 for multi-device incidents.
4. **PR-B split and conditionality.** PR-A is the read adapter + extension points: no AI, no actions, merged only after A11. PR-B is actions, group authorization and `edr_detection_action`, and **each action ships only if B7 proves it**. If none is proven, PR-B is not opened, PR-A carries `Closes #8168`, and actions become a follow-up issue. **Quarantine restore/delete are out of W04.** They need per-device `quarantine/info` polling to create `quarantine_item` rows, at one call per device per run against an undocumented budget. **Recommend accept**; the orchestrator files the quarantine follow-up.
5. **Isolation.** Owner decision: none. The OpenAPI shows a per-device `networkLockdownEnabled` override (spec correction 2), and whether it isolates immediately is unknown. **Recommend:** W04 keeps `isolate` out of `capabilities.actions` and `isolationState: 'unknown'`. A11 records what the override does. If it truly isolates, the orchestrator files a follow-up to evaluate `isolate`/`unisolate` through it. That follow-up needs its own reconcile design: reverting to the group value can leave a device locked when its group is locked.
6. **Installer.** **Recommend `installer: 'none'` until W06**, the GravityZone precedent (`bitdefender/adapter.ts:97`). `registry.test.ts:18` requires `getInstaller` whenever `installer !== 'none'`, and the install token is a secret that belongs in W06's `installer_secret_encrypted` path. A11 records the response field names. W06 implements `getInstaller` as `'api_generated_link'` from `GET /v1/workspaces/{ws}/install`.
7. **Key issuance.** Keys come from "user profile settings" (OpenAPI), so a key carries **that user's** workspace access. **Recommend** the setup doc tell the MSP to create a dedicated EMC user in the partner account, give it access to every customer workspace Breeze should see, and create the key as that user. Breeze refuses a key whose user sits in several partner accounts (A8). Todd provides the lab partner key. Breeze never asks for a password.
8. **Scan semantics.** `start-quick`, `onScanCompletion: 'QuarantineDetections'`, `ReducedPriority`. Shutdown modes are never sent (pinned). `ReportOnly` would leave found malware in place after an MSP asked for a scan. **Recommend `QuarantineDetections`**, with scan staying Tier 2: quarantining a *detected* file is the vendor's normal protective response. Malware/custom scans are out of scope.

## Advisor quorum record

Independent review by Codex (`codex exec -s read-only`, `gpt-6-astra`, `model_reasoning_effort=xhigh`, 2026-10-17) of the PR split and the matching rule. It read the cited code and the OpenAPI. The author re-checked every point at file:line before accepting it.

**Agreed:**
- two PRs with read-only capabilities and the live-lab merge gate;
- no isolation, and quarantine deferred;
- `installer: 'none'` until W06;
- same-org matching with IPs excluded;
- detail-owned fields and per-adapter estimates in PR-A;
- "never `resolved`";
- scoped denials never disable the connection;
- the conservative budget, labelled as provisional.

**Codex disagreed; the author verified and changed the plan:**
1. *Status model.* The first draft invented a `window_reread` model with no re-read. That misses verdict changes after 30 days. The plan now builds `reread_open_on_inventory` (A5); see Open Decision 2.
2. *"Unchanged matcher keeps collisions ambiguous" was false.* `resolve.ts:79-108` links the sole free candidate after excluding claimed ones, and lets the lowest row id win. The plan now has strict-unique mode (A3).
3. *Attribution:* use the full name, not the first label. Do not re-bind on rename (sticky attribution, `persist.ts:522-523` → A4). Do not leak sibling devices or users through replicated `details`. Use collision-safe ids instead of a 255-char clip.
4. *Status:* `ConfirmedMalicious` without remediation is `open`. Mixed `actionsTaken` does not prove every device was mitigated.
5. *Root denial:* `/account` OK + `/workspaces` denied is a permission problem, not reauth (A6 table).
6. *Budget:* estimates must include paging, attribution and re-reads (A1). PR-B needs an `actions` operation budget to activate the W03 reserve (B2).
7. *PR-B blocker:* a verdict changes the whole incident, so authorize against every affected device and fail closed on unknown attribution (B3). Carry a trusted vendor locator: a synthetic `guid:name` id cannot address the verdict API (A4, B2).
8. *Contract trap:* `aiTools.userOwnedRelease.contract.test.ts:346-351` pins one write site in `aiToolsEdr.ts`, so the new tool gets its own module (B4).

**Unresolved disagreements:** none. Decisions 1, 2 and 4–8 still need Todd because they set product scope or depend on the lab key, not because the reviewers split.

## Self-review notes (for executors)

- Run A2–A5 before A8. Otherwise A9's assertions fail for the wrong reason.
- The capability additions are **optional**, and GravityZone declares none of them. If an existing GravityZone test needs editing, you changed a default (A4's sticky COALESCE is the one intended all-adapter change, and it is a no-op for GravityZone).
- `details._breeze` is framework-owned. Adapters never write it, and nothing reads it from request input.
- Attribution keys are **full** names (`deviceNameKey`). Device *matching* keys stay first-label (`normalizeMatchName`). They are different functions on purpose.
- PR-B's `edr_detection_action` enum is `['mark_false_positive']` only, even though the shared `EDR_DETECTION_ACTIONS` lists five.

## Execution handoff

Recommended: **subagent-driven**. PR-A has twelve tasks, four of which change shared framework code (`persist.ts`, the sync job, the shared matcher). There, a fresh per-task reviewer catches a changed GravityZone or backup default, which the contract suites only partly cover. PR-B is high blast radius (group authorization, AI guardrails, line-keyed contracts) and ends with a Sonnet/Opus whole-branch review. Gate B approval (`plan-approved` label, added by Todd) is required before execution starts.
