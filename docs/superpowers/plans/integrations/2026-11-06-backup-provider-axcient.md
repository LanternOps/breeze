---
tracking_issue: LanternOps/breeze#11269
---

# Axcient x360Recover Backup Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third backup-provider adapter, `axcient`, that reads x360Recover per-device health for every client under the MSP and shows it wherever Cove status appears, plus a per-device "verified bootable" signal.

**Architecture:** A new `services/backupProviders/axcient/` adapter (client, device projection, adapter), modelled on Cove (endpoint rows) and Dropsuite (per-customer fetch, concurrency 2, `failedCustomerIds`, test seam). Axcient `PARKED` maps to a new canonical status `paused`, which is added to the `external_backup_status` pg enum and the shared tuple, renders `warning`, never counts as covered and never alerts. A second migration adds three nullable `verified_bootable*` columns to `backup_provider_devices`. Persist writes them, the device route and the read model carry them, and three surfaces render them. The web create and rotate forms move to one per-provider descriptor. Cove `not_started` and Dropsuite `not_started` behaviour is unchanged.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only), hand-written SQL migration, Zod, Vitest (API, web, shared), React islands, i18next (8 locales), jsPDF autotable (report PDF), Starlight docs.

**Spec:** `docs/superpowers/specs/integrations/2026-11-06-backup-provider-axcient-design.md` (APPROVED 2026-11-06; Decision 1 blocks W03 only). Builds on the Cove plans `docs/superpowers/plans/integrations/2026-09-15-backup-provider-integration*.md`.

## Global Constraints

- Provider key `axcient`, label exactly `Axcient x360Recover`, `inventoryKind` omitted, `defaultSyncIntervalMinutes: 30`, `rootContinuity: 'root_id'`.
- `defaultBaseUrl = 'https://axapi.axcient.com/x360recover'`. Base URL must be `https:` on `axcient.com` or a subdomain of it, with no userinfo, query or hash. The form shows no base URL field for Axcient.
- Auth is the single header `X-Api-Key`. The client issues only `GET`, never sends a body, and goes through `safeFetch` (`apps/api/src/services/urlSafety.ts:536`). The API key never appears in an error message, `raw`, a log or a fixture.
- Copy (verbatim): 401 → `Axcient rejected the API key.`; 403 `ForbiddenException` → `This key is missing a product scope. Edit it in x360Portal → Settings → API Keys and enable x360Recover and Billing.`
- `raw` drops `jobs`, `volumes`, `excluded_volumes`, `vaults` and both `screenshot_url` / `screenshot_thumbnail_url` (presigned) before persistence.
- `paused` (Decision 8): appended LAST to `EXTERNAL_BACKUP_STATUSES` and to the pg enum (`ADD VALUE` without `BEFORE`/`AFTER` appends, and `backupProviderRls.integration.test.ts:199-202` compares the tuple to `pg_enum` ordered by `enumsortorder`). Severity `25`, between `unknown` (20) and `not_started` (30). `deriveBackupHealth` returns `health: 'warning'` and `covered: false` whatever the recency. It goes in the `other` bucket (`['not_started', 'unknown', 'paused']`). `computeProviderCondition` returns `null` (no `stale`). Only Axcient produces it.
- AutoVerify never changes `status` (Decision 3). Vendor RP thresholds are ignored; staleness is the shared 48 h rule (Decision 4). Inactive clients are listed and fetched (Decision 2). The posture `backups_verified` control is not touched (Decision 7).
- Migration names, in this order: `apps/api/migrations/2027-01-22-205900-external-backup-status-paused.sql` (enum value only) then `apps/api/migrations/2027-01-22-210000-backup-provider-devices-verified-bootable.sql`. The enum file must sort strictly before any file that could use `'paused'`. The newest on `origin/main` at plan time is `2027-01-22-200400-tickets-email-review-permission.sql`. Re-check `git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | grep '\.sql$' | sort | tail -1` before committing, and rename both upward, keeping their order, if main has moved past them. DDL only, idempotent, no `BEGIN;`/`COMMIT;`, then `pnpm db:check-drift`.
- New columns are `included` (open) in `CORE_TENANT_EXPORT_POLICY`. `vendor_raw` stays `excludedOpen`.
- Every new web locale key goes into all eight locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`. A value left identical to English (brand names such as `Axcient x360Recover`) needs its `namespaceDuplicateBaselines` entry in `apps/web/src/lib/i18n/translationCoverage.test.ts` raised by exactly that count, with a comment.
- Web mutations go through `runAction`. Existing `data-testid`s on the Cove and Dropsuite forms do not change.
- Fixtures are synthetic: client names like `Synthetic Client A`, hosts like `SYN-SRV-01`, documentation MACs, the fake key `test-axcient-key-0000`. No real customer data.
- Scoped tests run as `cd apps/<pkg> && npx vitest run <file>`. Never use `pnpm --filter <pkg> test -- --run <path>`. Integration suites need `pnpm test-stack up` first and `pnpm test-stack down` after.
- API typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo "exit $?"`. Read the exit code. Never pipe it to `tail`, which hides an OOM.
- Branches follow `feature/<parent#>-axcient-backup-provider/wave-<sub#>` once `register_feature` has run. Append ` (#<wave>)` to each commit subject below.

## Review Focus

1. **Server ignores `limit`/`offset`** and returns the same full array for every page: the client must stop after the repeated page, keep no duplicates and never spin to the page cap. Pinned in Task 1 (`stops when a page repeats the previous page`).
2. **AutoVerify evidence disappears** on a later sync (the result expires, or the device moves to D2C): the three columns must clear, not keep showing a stale "passed". Pinned in Task 5 (`upsert set clause overwrites all three verified_bootable columns from excluded`).
3. **A `backup_status` report persisted before W02** (rows without the new fields) is re-rendered: it must print `n/a`, not crash and not print `Never run`. Pinned in Task 9 (`renders n/a for rows persisted before verified-bootable existed`).
4. **Rotating an Axcient key** from the connection card must PATCH `{ apiKey }` only, never Cove's three fields. A blank key keeps the stored credential. Pinned in Task 10 (`rotates an Axcient key with apiKey only`).
5. **A fresh trial account with zero clients** (the likely Decision 1 path): `testConnection` must succeed with `customerCount: 0`, and `listDevices` must return an empty list without throwing `all_customers_failed`. Pinned in Task 4 (`zero clients is a healthy empty account`).

---

## W01: adapter, client, registry, credentials, `paused` status, migrations (API, plus the type-forced status label sites)

### Task 1: Axcient HTTP client and fixtures

**Files:**
- Create: `apps/api/src/services/backupProviders/axcient/client.ts`
- Create: `apps/api/src/services/backupProviders/axcient/client.test.ts`
- Create: `apps/api/src/services/backupProviders/axcient/__fixtures__/{organization.json,clients.json,devices-client-101.json,devices-client-102.json,error-unauthorized.json,error-forbidden.json,README.md}`

**Interfaces:**
- Consumes: `ProviderRequestError` (`../types`), `safeFetch` (`../../urlSafety`).
- Produces:
  - `export const AXCIENT_PAGE_SIZE = 100; export const AXCIENT_MAX_PAGES = 200;`
  - `export class AxcientCustomerRequestError extends ProviderRequestError` (always `reauth: false`; only this error may put a customer into `failedCustomerIds`).
  - `export type AxcientFetchImpl`, the same shape as `DropsuiteFetchImpl` (`dropsuite/client.ts:19-30`).
  - `export interface AxcientOrganization { id: number; name: string; active: boolean }`
  - `export type AxcientRecord = Record<string, unknown>`
  - `export class AxcientClient { constructor(o: { baseUrl: string; apiKey: string; fetchImpl?: AxcientFetchImpl; sleepImpl?: (ms: number) => Promise<void>; timeoutMs?: number }); getOrganization(): Promise<AxcientOrganization>; listClients(): Promise<AxcientRecord[]>; listClientDevices(clientId: number): Promise<AxcientRecord[]>; abort(): void }`
  - `export const AXCIENT_UNAUTHORIZED_MESSAGE` and `AXCIENT_SCOPE_MESSAGE` (the two Global Constraints strings).

The fixtures come from the OpenAPI 0.3.1 examples and the WireMock mock, made synthetic. `clients.json` holds three clients: 101 active, 102 `active: false`, 103 with no devices. The device fixtures cover every row of the Task 3 status table, both `d2c` values, all four `type` values, one `latest_autoverify_details` with screenshot URLs, one without it, and a `mac_address` in dash form. `README.md` states the source and that W03 replaces these files with scrubbed captures.

- [ ] **Step 1: Write the failing tests** in `client.test.ts`, using the Dropsuite `setup(bodies, statuses, retryAfter)` fake-fetch harness (`dropsuite/client.test.ts:8-19`):

```ts
it('sends GET with X-Api-Key and Accept only, no body', ...)          // init: { method:'GET', headers:{'X-Api-Key':'test-axcient-key-0000', Accept:'application/json'} }, no 'body' key
it('joins base URL paths: /organization, /client, /client/101/device', ...)
it('pages /client with limit=100&offset=0,100,… until a short page', ...) // 100 rows then 3 rows => 2 calls, 103 rows
it('stops when a page repeats the previous page', ...)               // server ignores offset: same 100 rows twice => 2 calls, 100 rows, no dupes
it('rejects an object envelope where an array is required', ...)      // {data:[…]} from /client => code 'malformed_response'
it('rejects a non-numeric client id before building a device path', ...) // listClientDevices(Number('abc')) => throws malformed_response, fetch not called
it('401 => reauth with the unauthorized message', ...)                // {code:'http_401', reauth:true, message: AXCIENT_UNAUTHORIZED_MESSAGE}
it('403 ForbiddenException => reauth with the scope message', ...)    // error-forbidden.json => reauth:true, message: AXCIENT_SCOPE_MESSAGE
it('403 without ForbiddenException => not reauth', ...)               // '<html>' body => {code:'http_403', reauth:false}
it('retries 429 honouring Retry-After then succeeds', ...)            // statuses [429,200], retryAfter '2' => sleepImpl called with 2000
it('device call 5xx after retries => AxcientCustomerRequestError', ...) // 4x 503 on /client/101/device => name 'AxcientCustomerRequestError', reauth:false
it('device call 404 => AxcientCustomerRequestError', ...)
it('device call 401 => reauth ProviderRequestError, not a customer error', ...)
it('never puts the API key in an error message', ...)                 // fetchImpl throws Error('boom test-axcient-key-0000') => message 'Axcient request failed', no key
it('abort() stops new requests', ...)                                 // code 'aborted'
```

- [ ] **Step 2: Run red.** Run `cd apps/api && npx vitest run src/services/backupProviders/axcient/client.test.ts`. Expected: FAIL, `Cannot find module './client'`.

- [ ] **Step 3: Implement `AxcientClient`** in `axcient/client.ts`. Copy the Dropsuite retry loop (`MAX_RETRIES = 3`, `retryDelay`, the network catch that drops the cause). Admin calls (`/organization`, `/client`) throw `ProviderRequestError`. Device calls throw `AxcientCustomerRequestError` for 404, and for 5xx/429 once retries are spent. 401 is always reauth, whatever the scope. For 403, parse the body and test `type === 'ForbiddenException'`. `listClientDevices` asserts `Number.isSafeInteger(clientId) && clientId > 0` before any request. Pagination: request `limit`/`offset`, require each page to be an array of objects, dedupe by `JSON.stringify(row.id)`, stop on a short page, an empty page or a page that adds no new id, and throw `too_many_pages` past `AXCIENT_MAX_PAGES`. `getOrganization` requires an object with a numeric `id` and a string `name`.

- [ ] **Step 4: Run green.** Run the same command. Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/backupProviders/axcient/client.ts apps/api/src/services/backupProviders/axcient/client.test.ts apps/api/src/services/backupProviders/axcient/__fixtures__
git commit -m "feat(backup-providers): Axcient x360Recover read-only HTTP client"
```

### Task 2: The `paused` canonical status

**Files:**
- Create: `apps/api/migrations/2027-01-22-205900-external-backup-status-paused.sql`
- Modify: `apps/api/src/db/schema/backupProviders.ts:36-47` (`EXTERNAL_BACKUP_STATUS_ENUM_VALUES`, append `'paused'`)
- Modify: `packages/shared/src/types/backupHealth.ts:26-37` (append `'paused'`; update the doc comment)
- Modify: `packages/shared/src/utils/backupHealth.ts:14-39` (severity), `:123-130` (buckets), `:206-235` (`deriveBackupHealth`)
- Test: `packages/shared/src/utils/backupHealth.test.ts`
- Modify: `apps/api/src/services/backupProviders/alerts.ts:81-110` (`computeProviderCondition` and its doc comment)
- Test: `apps/api/src/services/backupProviders/alerts.test.ts`
- Modify: `packages/shared/src/reportPdf/backupStatusReport.ts:194-217` (`STATUS_LABEL`, `statusColor`), `apps/web/src/components/backup/backupHealthBuckets.ts:64-76` (`HISTORY_CELL_CLASS`). Both are `Record<ExternalBackupStatus, …>`, so tsc forces them. They are the only web/shared touches in W01.
- Modify: `apps/web/src/locales/*/backup.json` (`backupHealth.status.paused`, all 8), `apps/web/src/lib/i18n/translationCoverage.test.ts`

**Interfaces:**
- Produces: `ExternalBackupStatus` includes `'paused'` (last tuple member); `EXTERNAL_BACKUP_STATUS_SEVERITY.paused = 25`; `BACKUP_STATUS_BUCKET_MEMBERS.other = ['not_started', 'unknown', 'paused']`; `deriveBackupHealth({ status: 'paused', … })` returns `{ health: 'warning', covered: false, recency: <computed as usual> }`; `computeProviderCondition({ status: 'paused', … })` returns `null`; PDF label `Paused` (colour `C.warning`); history cell `bg-amber-300`; locale `backupHealth.status.paused` = `Paused`.
- `LEDGER_STATUS_SEVERITY` (`persist.ts:74`), `routes/backup/schemas.ts:333` and both AI-tool status enums (`aiToolSchemasBackupRecoveryReads.ts:30`, `aiToolsBackupRecoveryReads.ts:327`) derive from the tuple and need no edit. The AI tool index grows by one enum label.

Migration body. It is in its own file because a label added by `ALTER TYPE` cannot be used in the transaction that adds it. It writes no rows, so it needs no `breeze.scope` election.

```sql
-- Axcient x360Recover PARKED -> canonical `paused` (#11270). Enum add only.
-- The first file that may use the label (2027-01-22-210000-…) sorts after this one. Idempotent.
ALTER TYPE public.external_backup_status ADD VALUE IF NOT EXISTS 'paused';
```

No `-- @no-transaction` directive, following the precedent in `2026-10-26-170000-ticket-checklist-operator-task-source.sql`: `ADD VALUE` is legal inside a transaction on PG ≥ 12; the only rule is that the label is not used in the same transaction, which the separate file guarantees.

- [ ] **Step 1: Write the failing tests:**

```ts
// backupHealth.test.ts
// existing tuple assertion (:21-36): append 'paused' as the 11th label and rename the case "eleven pg enum labels"
// existing worstBackupStatus order (:47): ... > not_started > paused > unknown > in_progress > completed
it('collects not_started, unknown and paused into `other`', ...)
it.each([1, 30, 60, null])('paused is warning and uncovered regardless of recency (lastSuccess %s h ago)', ...)
// existing ':269 covered is true for exactly {under_24h, under_48h} across every status' => every status except paused, plus a paused line asserting covered false
// alerts.test.ts: alerts.test.ts:61 (not_started, 60h => 'stale') stays exactly as-is
['paused, 10-day-old success', { status: 'paused', lastSuccessAt: hoursAgo(240), errorsCount: 0 }, null],
['paused, never succeeded', { status: 'paused', lastSuccessAt: null, errorsCount: 0 }, null],
```

Add `backupHealth.status.paused` to the `backup.json` key loop in `translationCoverage.test.ts:1476`.

- [ ] **Step 2: Run red.** Run `cd packages/shared && npx vitest run src/utils/backupHealth.test.ts`, then `cd apps/api && npx vitest run src/services/backupProviders/alerts.test.ts`. Expected: FAIL. `'paused'` is not in the tuple, and the alert case returns `'stale'`.
- [ ] **Step 3: Implement.** Write the migration, the tuple and enum values, the severity, the bucket and the alert rule (`case 'paused': return null;` ahead of the recency fallthrough; the doc comment says parked means an operator paused protection on purpose). In `deriveBackupHealth`, add a `paused` branch: `health = 'warning'`, and override `covered = false` for `paused` only. Add the PDF label and colour, the history cell class and the eight locale values.
- [ ] **Step 4: Run green.** Run the same commands, plus `cd apps/api && npx vitest run src/services/backupProviders/ src/services/aiToolsBackupRecoveryReads src/services/aiToolSchemasBackupRecoveryReads src/services/backupHealthRows.test.ts`, `cd packages/shared && npx vitest run src/reportPdf/reportPdf.backupStatus.test.ts`, `cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts`, and the API typecheck (`exit 0`). Expected: PASS. Cove and Dropsuite tests are unchanged and green. Then run `pnpm test-stack up && pnpm db:migrate && pnpm db:check-drift` (expected: no drift).
- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2027-01-22-205900-external-backup-status-paused.sql apps/api/src/db/schema/backupProviders.ts packages/shared/src/types/backupHealth.ts packages/shared/src/utils/backupHealth.ts packages/shared/src/utils/backupHealth.test.ts apps/api/src/services/backupProviders/alerts.ts apps/api/src/services/backupProviders/alerts.test.ts packages/shared/src/reportPdf/backupStatusReport.ts apps/web/src/components/backup/backupHealthBuckets.ts apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(backup): add the paused canonical backup status for parked provider devices"
```

### Task 3: Device projection and status map

**Files:**
- Modify: `apps/api/src/services/backupProviders/types.ts:24-49` (add the optional field and the evidence type)
- Create: `apps/api/src/services/backupProviders/axcient/device.ts`
- Create: `apps/api/src/services/backupProviders/axcient/device.test.ts`

**Interfaces:**
- Consumes: `parseCoveMacAddresses` (`../cove/columns.ts:217`; vendor-neutral, drops the all-zero MAC), fixtures from Task 1, `'paused'` in `ExternalBackupStatus` (Task 2).
- Produces:
  - In `types.ts`: `export interface VerifiedBootableEvidence { at: Date | null; healthy: boolean; failedChecks: string[] }`, and `VendorDevice.verifiedBootable?: VerifiedBootableEvidence | null` (Cove and Dropsuite leave it undefined).
  - `export function mapAxcientStatus(device: AxcientRecord): ExternalBackupStatus`
  - `export function mapAxcientOsType(type: unknown): 'workstation' | 'server' | 'unknown'`
  - `export function axcientVerifiedBootable(details: unknown): VerifiedBootableEvidence | null`
  - `export function scrubAxcientRaw(device: AxcientRecord): Record<string, unknown>`
  - `export function axcientDeviceToVendorDevice(device: AxcientRecord): VendorDevice` (throws `ProviderRequestError` `malformed_response` when `id` or `client_id` is missing)

- [ ] **Step 1: Write the failing tests.** The status map is the spec table, verbatim:

```ts
const rp = '2026-11-05T03:00:00Z';
it.each([
  ['NORMAL', 'ANYTHING', { latest_local_rp: rp }, 'completed'],
  ['WARNED', 'ANYTHING', { latest_local_rp: rp }, 'completed_with_errors'],
  ['TROUBLED', 'OFFSITE_NEVER_RUN', { latest_local_rp: rp }, 'no_backups'],
  ['TROUBLED', 'APPLIANCE_OFFLINE', {}, 'no_backups'],          // all three latest_*_rp null
  ['TROUBLED', 'SCHEDULE_DISABLED', { latest_local_rp: rp }, 'no_selection'],
  ['TROUBLED', 'APPLIANCE_OFFLINE', { latest_local_rp: rp }, 'failed'],
  ['TROUBLED', 'APPLIANCE_OFFLINED', { latest_local_rp: rp }, 'failed'], // help-centre spelling
  ['TROUBLED', 'NEVER_SEEN_BEFORE', { latest_local_rp: rp }, 'failed'],  // unrecognised reason
  ['PARKED', 'ANYTHING', {}, 'paused'],
  ['UNPROTECTED', 'ANYTHING', { latest_local_rp: rp }, 'no_backups'],
  ['SOMETHING_NEW', 'X', { latest_local_rp: rp }, 'unknown'],
])('%s / %s => %s', (status, reason, rps, expected) =>
  expect(mapAxcientStatus({ current_health_status: { status, reason }, ...rps })).toBe(expected));
it('missing current_health_status => unknown, never throws', ...)   // {}, {current_health_status:null}, {current_health_status:'x'}
it.each([['SERVER','server'],['WORKSTATION','workstation'],['NAS','unknown'],['ARCHIVE','unknown'],[undefined,'unknown']])('type %s => %s', ...)
it('lastSuccessAt = max of the three RPs, ignoring nulls and junk', ...) // local 11-03, vault 11-05, cloud null => 11-05; lastSessionAt and lastCompletedAt equal it; all null => null
it('appliance device: usedBytes = local_usage, selectedBytes = local_total, dataSources [image]', ...)
it('D2C device: usedBytes = cloud_usage, selectedBytes null when local_total absent, dataSources [image]', ...)
it('maps identity fields', ...)   // vendorDeviceId '501', vendorCustomerId '101', name = computerName = 'SYN-SRV-01', osVersion = os.os_name, clientVersion = agent_version, accountType 'backup_manager', vendorStatusCode null, vendorCreatedAt/ExpiresAt null
it('normalises mac_address to lower-case colon form, [] when absent', ...) // '00-1A-2B-3C-4D-5E' => ['00:1a:2b:3c:4d:5e']
it('errorsCount 0 for NORMAL, 1 otherwise', ...)
it('raw drops jobs, volumes, excluded_volumes, vaults and both screenshot URLs', ...) // keeps current_health_status, latest_autoverify_details.rp, device_details_page_url, local_ps_id; JSON.stringify(raw) has no 'screenshot'
it('verifiedBootable: healthy pass', ...)          // {status:'success', is_healthy:true, end_timestamp: rp} => {at: new Date(rp), healthy:true, failedChecks:[]}
it('verifiedBootable: failed system_boot', ...)    // system_boot:{result:false} => {healthy:false, failedChecks:['system_boot']}
it('verifiedBootable: ran but did not complete', ...) // {status:'failure', is_healthy:true} => healthy:false
it('verifiedBootable: null when details absent or is_healthy not boolean', ...)
it('throws malformed_response when id or client_id is missing', ...)
```

- [ ] **Step 2: Run red.** Run `cd apps/api && npx vitest run src/services/backupProviders/axcient/device.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** the five functions in `axcient/device.ts` and the type change in `types.ts`. `mapAxcientStatus` checks the verdict first, then the reason, then whether any RP exists. `axcientVerifiedBootable`: `healthy = status === 'success' && is_healthy === true`. `failedChecks` holds the keys in fixed order `['system_boot','heartbeat','check_disk','start_vss']` whose value is `false`, or an object whose `result` is `false` or a string in `failure|failed|error` (case-insensitive). Any other value shape is ignored; W03 confirms the real shapes. `at` is `end_timestamp` parsed, or null.

- [ ] **Step 4: Run green.** Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/backupProviders/types.ts apps/api/src/services/backupProviders/axcient/device.ts apps/api/src/services/backupProviders/axcient/device.test.ts
git commit -m "feat(backup-providers): project Axcient devices onto VendorDevice with verified-bootable evidence"
```

### Task 4: Adapter, credentials and registry

**Files:**
- Create: `apps/api/src/services/backupProviders/axcient/adapter.ts`
- Create: `apps/api/src/services/backupProviders/axcient/adapter.test.ts`
- Modify: `apps/api/src/services/backupProviders/registry.ts:1-17`
- Modify: `apps/api/src/services/backupProviders/registry.test.ts:5-7` (plus one new case)
- Modify: `apps/api/src/routes/backup/providers.test.ts:237-259` (registry mock)

**Interfaces:**
- Consumes: `AxcientClient`, `AxcientCustomerRequestError` and the messages (Task 1); `axcientDeviceToVendorDevice` (Task 3).
- Produces:
  - `export const AXCIENT_PROVIDER_KEY = 'axcient'; export const AXCIENT_PROVIDER_LABEL = 'Axcient x360Recover'; export const AXCIENT_DEFAULT_BASE_URL = 'https://axapi.axcient.com/x360recover';`
  - `export const axcientCredentialsSchema = z.object({ apiKey: z.string().trim().min(1) }).strip();`
  - `export function validateAxcientBaseUrl(url: string): string | null`
  - `export function __setAxcientClientFactoryForTests(f: ((baseUrl: string, apiKey: string) => Pick<AxcientClient, 'getOrganization' | 'listClients' | 'listClientDevices' | 'abort'>) | null): void`
  - `export const axcientAdapter: BackupProviderAdapter`
  - `BACKUP_PROVIDER_KEYS = ['cove', 'dropsuite', 'axcient'] as const`

- [ ] **Step 1: Write the failing tests.** In `adapter.test.ts`, use a fake vendor through the factory seam (the `fakeVendor` pattern in `dropsuite/adapter.test.ts:20-33`):

```ts
it('declares endpoint inventory, 30-minute default, root_id continuity and the default URL', ...) // inventoryKind undefined, label 'Axcient x360Recover'
it('trims apiKey and rejects blank/missing', ...)                  // ' k ' => 'k'; '', '  ', {} fail; extra keys stripped
it.each(['https://axapi.axcient.com/x360recover', 'https://eu.axapi.axcient.com/x360recover'])('accepts %s', ...)
it.each(['http://axapi.axcient.com/x360recover', 'https://axcient.com.evil.example/x', 'https://evilaxcient.com/x', 'https://u:p' + '@axapi.axcient.com/x', 'https://axapi.axcient.com/x?a=1', 'bad'])('rejects %s', ...)
it('testConnection: rootId = String(org.id), rootName = org.name, customerCount = clients.length', ...)
it('zero clients is a healthy empty account', ...)                 // testConnection ok, customerCount 0; listDevices => {devices:[], failedCustomerIds:[]}
it('testConnection 401 => {ok:false, reauth:true, error: "Axcient rejected the API key."}', ...)
it('testConnection 403 ForbiddenException => {ok:false, reauth:true, error: scope message}', ...)
it('listCustomers maps id/name/client_code, parentId null, level "0", keeps inactive clients', ...) // client 102 active:false present; externalCode 'SYNA'
it('listDevices fetches every client, inactive included, at concurrency <= 2', ...) // track in-flight max
it('per-customer 5xx keeps going and reports failedCustomerIds', ...) // 102 fails => failedCustomerIds ['102'], devices of 101 present
it('401 on a device call fails the whole run as reauth', ...)
it('every customer failing throws all_customers_failed', ...)
it('device paths are built from numeric ids only', ...)            // all fetched URLs match /\/client\/\d+\/device/
it('throws invalid_credentials (reauth) for a malformed blob', ...)
```

In `registry.test.ts`: change the key assertion to `['cove', 'dropsuite', 'axcient']` and add `it('registers Axcient with its default URL and 30-minute sync', …)`. In `providers.test.ts`: the mock lists `['cove', 'dropsuite', 'axcient']`, gives `axcient` the label `Axcient x360Recover`, the default URL, a 30-minute interval, and `safeParse` accepting `{ apiKey: string }`. Add one route case there: `it('creates an Axcient connection with the default base URL when none is posted', …)`, asserting the stored `baseUrl` equals `AXCIENT_DEFAULT_BASE_URL`.

- [ ] **Step 2: Run red.** Run `cd apps/api && npx vitest run src/services/backupProviders/axcient/adapter.test.ts src/services/backupProviders/registry.test.ts src/routes/backup/providers.test.ts`. Expected: FAIL. The adapter module is missing and the registry key list differs.

- [ ] **Step 3: Implement** `axcient/adapter.ts`: a `connect()` helper like Dropsuite's (`dropsuite/adapter.ts:34-40`); `testConnection` catches and returns `{ ok:false, error, reauth }`. `level` is the string `'0'`, because `VendorCustomer.level` is `string | null`. `listDevices` uses the Dropsuite worker pool (`dropsuite/adapter.ts:178-230`) at `Math.min(2, clients.length)`, catches only `AxcientCustomerRequestError` per customer, and calls `client.abort()` before rethrowing anything else. It throws `all_customers_failed` only when `clients.length > 0` and every client failed. Register in `registry.ts`.

- [ ] **Step 4: Run green.** Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/backupProviders/axcient/adapter.ts apps/api/src/services/backupProviders/axcient/adapter.test.ts apps/api/src/services/backupProviders/registry.ts apps/api/src/services/backupProviders/registry.test.ts apps/api/src/routes/backup/providers.test.ts
git commit -m "feat(backup-providers): register the Axcient x360Recover adapter"
```

### Task 5: `verified_bootable*` columns, export policy and persist

**Files:**
- Create: `apps/api/migrations/2027-01-22-210000-backup-provider-devices-verified-bootable.sql`
- Modify: `apps/api/src/db/schema/backupProviders.ts:187-211` (three columns after `vendorExpiresAt`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:268` (append to `included`)
- Modify: `apps/api/src/services/backupProviders/persist.ts:230-310` (values and `onConflictDoUpdate.set`)
- Test: `apps/api/src/services/backupProviders/persist.test.ts`

**Interfaces:**
- Consumes: `VendorDevice.verifiedBootable` (Task 3).
- Produces: Drizzle columns `backupProviderDevices.verifiedBootableAt: timestamp('verified_bootable_at', { withTimezone: true })`, `.verifiedBootable: boolean('verified_bootable')`, `.verifiedBootableFailedChecks: text('verified_bootable_failed_checks').array()`, all nullable with no default.

Migration body (DDL only, so no `set_config` is needed):

```sql
-- Axcient x360Recover AutoVerify evidence (#11270). Nullable; Cove and Dropsuite rows stay NULL.
ALTER TABLE backup_provider_devices ADD COLUMN IF NOT EXISTS verified_bootable_at timestamptz;
ALTER TABLE backup_provider_devices ADD COLUMN IF NOT EXISTS verified_bootable boolean;
ALTER TABLE backup_provider_devices ADD COLUMN IF NOT EXISTS verified_bootable_failed_checks text[];
```

- [ ] **Step 1: Write the failing tests** in `persist.test.ts`, using the existing `makeTx` / `vendorDevice()` helpers:

```ts
it('writes verified-bootable evidence onto the device row', ...)   // vendorDevice({ verifiedBootable: { at: D, healthy: false, failedChecks: ['system_boot'] } }) => insert payload has verifiedBootableAt: D, verifiedBootable: false, verifiedBootableFailedChecks: ['system_boot']
it('writes NULLs when the adapter supplies no evidence', ...)       // vendorDevice() (Cove shape) => all three null
it('upsert set clause overwrites all three verified_bootable columns from excluded', ...) // the onConflictDoUpdate set has verifiedBootableAt, verifiedBootable, verifiedBootableFailedChecks
```

- [ ] **Step 2: Run red.** Run `cd apps/api && npx vitest run src/services/backupProviders/persist.test.ts`. Expected: FAIL. The payload lacks `verifiedBootableAt`.

- [ ] **Step 3: Implement.** Write the migration and the schema columns. Add `"verified_bootable_at","verified_bootable","verified_bootable_failed_checks"` to the `included` list at `tenantExportPolicyRegistry.ts:268`. In `persist.ts`, set `verifiedBootableAt: device.verifiedBootable?.at ?? null` and the matching `?.healthy ?? null` and `?.failedChecks ?? null`, plus three `sql\`excluded.verified_bootable…\`` entries in `set`.

- [ ] **Step 4: Run green.** Run the same command (PASS). Then run `pnpm test-stack up`, `pnpm db:migrate && pnpm db:check-drift` (expected: no drift reported), and the typecheck from Global Constraints (expected: `exit 0`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2027-01-22-210000-backup-provider-devices-verified-bootable.sql apps/api/src/db/schema/backupProviders.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/backupProviders/persist.ts apps/api/src/services/backupProviders/persist.test.ts
git commit -m "feat(backup-providers): store verified-bootable evidence on provider devices"
```

### Task 6: Integration coverage (sync, RLS, export policy)

**Files:**
- Create: `apps/api/src/__tests__/integration/backupProviderSyncAxcient.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/backupProviderRls.integration.test.ts`
- Verify: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts` (no edit expected)

**Interfaces:**
- Consumes: `axcientDeviceToVendorDevice` (Task 3), the `paused` status and alert rule (Task 2), the columns (Task 5), `syncConnectionById` (`jobs/backupProviderSync`).

The new file copies the setup of `backupProviderSync.integration.test.ts:1-40`. Its registry mock returns `key: 'axcient'`, `label: 'Axcient x360Recover'`, and `listDevices` returns `axcientDeviceToVendorDevice(...)` over Task 1 fixture devices, so the real projection feeds the real persist.

- [ ] **Step 1: Write the failing tests:**

```ts
it('a matched SERVER flips the Breeze device to protected via hostname', ...)  // seed device hostname 'SYN-SRV-01'; after sync row.breezeDeviceId = device.id, deviceMatchSource 'auto_hostname', status 'completed'
it('a TROUBLED device raises a device alert on the second poll', ...)          // poll1 pendingCondition 'failed', 0 alerts; poll2 1 open alert, title contains 'Backup failed on'
it('a PARKED device raises nothing across two polls', ...)                     // status 'paused', pendingCondition null, 0 alerts (lastSuccessAt 10 days old)
it('persists verified-bootable evidence and no screenshot URL', ...)           // verified_bootable true, verified_bootable_at set; vendor_raw::text has no 'screenshot'
```

In `backupProviderRls.integration.test.ts`, add `it('isolates an axcient row and its verified_bootable columns across orgs', …)`. Insert a `provider: 'axcient'` row with `verified_bootable: true` under org A. Org A's context reads all three columns back; org B's context reads zero rows.

- [ ] **Step 2: Run red.** Run `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupProviderSyncAxcient.integration.test.ts src/__tests__/integration/backupProviderRls.integration.test.ts`. Expected: FAIL. On a stack migrated before Task 5 the columns are missing. If Tasks 1–5 are already in, the first-run failure is the new file's mock wiring. Prove each assertion can fail by deleting the `case 'paused'` line from `computeProviderCondition` locally: the PARKED case must go red with a `stale` alert on poll 2.
- [ ] **Step 3: Implement.** Only fix test wiring. No production code is expected here. If any production change is needed, it belongs in the owning task with a unit test.
- [ ] **Step 4: Run green.** Run the same command plus `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/backupProviderSync.integration.test.ts`. Expected: PASS. Then run `pnpm test-stack down`.
- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/backupProviderSyncAxcient.integration.test.ts apps/api/src/__tests__/integration/backupProviderRls.integration.test.ts
git commit -m "test(backup-providers): Axcient sync, parked-device and RLS integration coverage"
```

---

## W02: surfaces

### Task 7: Verified-bootable on the shared row, read model and device route

**Files:**
- Modify: `packages/shared/src/types/backupHealth.ts:70-108` (`BackupHealthRow`)
- Modify: `packages/shared/src/utils/backupHealth.ts` (state helper)
- Test: `packages/shared/src/utils/backupHealth.test.ts`
- Modify: `apps/api/src/services/backupHealthRows.ts:70-98,219-318` (`ProviderLegRow`, `toBreezeHealthRow`, `toProviderHealthRow`)
- Modify: `apps/api/src/services/backupHealthReadModel.ts:324-345` (provider leg select)
- Modify: `apps/api/src/routes/backup/providerDevices.ts:78-101` (select)
- Test: `apps/api/src/services/backupHealthRows.test.ts`, `apps/api/src/routes/backup/providerDevices.test.ts`, `apps/api/src/__tests__/integration/backupHealthReadModel.integration.test.ts`

**Interfaces:**
- Consumes: the Task 5 columns.
- Produces:
  - `BackupHealthRow` gains `verifiedBootableAt: string | null; verifiedBootable: boolean | null; verifiedBootableFailedChecks: string[] | null;` (required; tsc then flags every producer).
  - `export const VERIFIED_BOOTABLE_PROVIDER_KEYS: readonly string[] = ['axcient'];`
  - `export type VerifiedBootableState = 'passed' | 'failed' | 'never_run' | 'not_applicable';`
  - `export function verifiedBootableState(row: { providerKey: string | null; verifiedBootable?: boolean | null }): VerifiedBootableState`
  - The `/backup/providers/devices` rows carry `verifiedBootableAt`, `verifiedBootable` and `verifiedBootableFailedChecks`.

- [ ] **Step 1: Write the failing tests:**

```ts
// shared backupHealth.test.ts
it.each([
  [{ providerKey: 'axcient', verifiedBootable: true }, 'passed'],
  [{ providerKey: 'axcient', verifiedBootable: false }, 'failed'],
  [{ providerKey: 'axcient', verifiedBootable: null }, 'never_run'],
  [{ providerKey: 'cove', verifiedBootable: null }, 'not_applicable'],
  [{ providerKey: null }, 'not_applicable'],                       // first-party row
  [{ providerKey: 'cove' }, 'not_applicable'],                     // field absent (old persisted report row)
])('verifiedBootableState(%j) => %s', ...)
// backupHealthRows.test.ts
it('toBreezeHealthRow sets all three verified-bootable fields to null', ...)
it('toProviderHealthRow carries verified-bootable fields with an ISO timestamp', ...) // Date in => '2026-11-05T03:12:00.000Z' out
// providerDevices.test.ts
it('returns the verified-bootable fields on each row', ...)
// backupHealthReadModel.integration.test.ts
it('verified-bootable fields are null for a Cove row and set for an Axcient row with is_healthy true', ...)
```

- [ ] **Step 2: Run red.** Run `cd packages/shared && npx vitest run src/utils/backupHealth.test.ts`, then `cd apps/api && npx vitest run src/services/backupHealthRows.test.ts src/routes/backup/providerDevices.test.ts`. Expected: FAIL, `verifiedBootableState` not exported and the fields missing.
- [ ] **Step 3: Implement** the type, the constant and the helper (`verifiedBootable === true` gives `passed` and `false` gives `failed`, but only when `providerKey` is in the list), the three selects, and the row mapping (`toIso` for the timestamp). Fix every producer tsc flags: the portal read model and AI tools only pass rows through.
- [ ] **Step 4: Run green.** Run the same commands. Then run the integration file with the test stack up, as in Task 6. Then run the API typecheck (`exit 0`). Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/backupHealth.ts packages/shared/src/utils/backupHealth.ts packages/shared/src/utils/backupHealth.test.ts apps/api/src/services/backupHealthRows.ts apps/api/src/services/backupHealthRows.test.ts apps/api/src/services/backupHealthReadModel.ts apps/api/src/routes/backup/providerDevices.ts apps/api/src/routes/backup/providerDevices.test.ts apps/api/src/__tests__/integration/backupHealthReadModel.integration.test.ts
git commit -m "feat(backup): carry verified-bootable evidence through the device route and health rows"
```

### Task 8: Device Backup tab card shows the last boot check

**Files:**
- Modify: `apps/web/src/components/backup/ExternalBackupCard.tsx:15-34,140-170`
- Test: `apps/web/src/components/backup/ExternalBackupCard.test.tsx`
- Modify: `apps/web/src/locales/*/backup.json` (all 8)

**Interfaces:**
- Consumes: `verifiedBootableState` (Task 7). `ProviderDeviceRow` gains `verifiedBootableAt: string | null; verifiedBootable: boolean | null; verifiedBootableFailedChecks: string[] | null`.
- Produces locale keys under `backupHealth`: `external.bootCheck` = `Last boot check`; `verifiedBootable.passed` = `Passed`; `verifiedBootable.failed` = `Failed`; `verifiedBootable.never_run` = `Never run`; `verifiedBootable.not_applicable` = `n/a`; `dataSource.image` = `Disk image`.

- [ ] **Step 1: Write the failing tests** (`data-testid="external-backup-boot-check"`):

```ts
it('shows a passed boot check with its date', ...)            // provider 'axcient', verifiedBootable true, at '2026-11-05T03:12:00Z' => text contains 'Passed' and the formatted date
it('shows a failed boot check with the failed checks', ...)   // false, ['system_boot'] => 'Failed' and 'system_boot'
it('shows Never run for an Axcient row without evidence', ...)
it('omits the boot-check row for a Cove device', ...)         // queryByTestId => null
it('labels the image data source', ...)                       // dataSources ['image'] => 'Disk image'
```

Add the keys to all eight `backup.json` files. In `translationCoverage.test.ts`, extend the SaaS-labels key loop (`:1476`) into a new `it.each` that asserts `dataSource.image`, `external.bootCheck` and the four `verifiedBootable.*` keys for every locale.

- [ ] **Step 2: Run red.** Run `cd apps/web && npx vitest run src/components/backup/ExternalBackupCard.test.tsx src/lib/i18n/translationCoverage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Call `verifiedBootableState({ providerKey: row.provider, verifiedBootable: row.verifiedBootable })`. The card renders the row only when the state is not `not_applicable`, using `formatDateTime` as for `lastSession`. Failed checks are joined with `, ` in parentheses.
- [ ] **Step 4: Run green.** Run the same command. Expected: PASS. Any identical-to-English value is reflected in the baselines.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/backup/ExternalBackupCard.tsx apps/web/src/components/backup/ExternalBackupCard.test.tsx apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(backup): show the last provider boot check on the device Backup tab"
```

### Task 9: "Verified bootable" column on `/backup` and the backup status report

**Files:**
- Modify: `apps/web/src/components/backup/BackupHealthDeviceTable.tsx:42-56` and the row cells
- Test: `apps/web/src/components/backup/BackupHealthDeviceTable.test.tsx`
- Modify: `packages/shared/src/reportPdf/backupStatusReport.ts:166-238` (`COLUMNS`, `cellText`)
- Test: `packages/shared/src/reportPdf/reportPdf.backupStatus.test.ts`
- Modify: `apps/web/src/locales/*/backup.json` (`backupHealth.table.verifiedBootable` = `Verified bootable`)

**Interfaces:**
- Consumes: `verifiedBootableState`, `BackupHealthRow` fields (Task 7); `backupHealth.verifiedBootable.*` keys (Task 8).
- Produces: the PDF column `{ key: 'verifiedBootable', label: 'Verified bootable', w: 20, halign: 'left' }`, placed after `errors`. Its English cell text: `Passed` / `Failed` / `Never run` / `n/a`.

- [ ] **Step 1: Write the failing tests:**

```ts
// BackupHealthDeviceTable.test.tsx  (cell data-testid `backup-health-verified-${row.key}`)
it('renders the verified-bootable column: Passed for axcient true, n/a for Cove and Breeze rows', ...)
// reportPdf.backupStatus.test.ts
it('prints a Verified bootable column with Passed and n/a', ...)  // rows: axcient verifiedBootable true; breeze row => text contains 'Verified' 'bootable' 'Passed' 'n/a'
it('renders n/a for rows persisted before verified-bootable existed', ...) // row() without the three keys (cast) => no throw, text contains 'n/a', not 'Never run'
```

Update the shared `row()` helper (`reportPdf.backupStatus.test.ts:30-38`) to default the three new fields to `null`, so the existing cases still typecheck.

- [ ] **Step 2: Run red.** Run `cd apps/web && npx vitest run src/components/backup/BackupHealthDeviceTable.test.tsx`, then `cd packages/shared && npx vitest run src/reportPdf/reportPdf.backupStatus.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the column in both renderers through `verifiedBootableState`. The PDF uses an English `Record<VerifiedBootableState, string>` next to `STATUS_LABEL`.
- [ ] **Step 4: Run green.** Run the same commands plus `cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/backup/BackupHealthDeviceTable.tsx apps/web/src/components/backup/BackupHealthDeviceTable.test.tsx packages/shared/src/reportPdf/backupStatusReport.ts packages/shared/src/reportPdf/reportPdf.backupStatus.test.ts apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(backup): Verified bootable column on the backup overview and status report"
```

### Task 10: Per-provider form descriptor (create + rotate), the Axcient form and docs

**Files:**
- Create: `apps/web/src/components/integrations/backupProviderForms.ts`
- Create: `apps/web/src/components/integrations/backupProviderForms.test.ts`
- Modify: `apps/web/src/components/integrations/BackupProvidersIntegration.tsx:15,75-106,139-245,292`
- Modify: `apps/web/src/components/integrations/BackupProviderConnectionCard.tsx:97-110,155-164,189,241-246,272-310`
- Test: `apps/web/src/components/integrations/BackupProvidersIntegration.test.tsx`, `BackupProviderConnectionCard.test.tsx`
- Modify: `apps/web/src/locales/*/integrations.json` (all 8), `apps/web/src/lib/i18n/translationCoverage.test.ts`
- Modify: `apps/docs/src/content/docs/backup/backup-providers.mdx:3,6` and a new section after `## Connecting NinjaOne SaaS Backup (Dropsuite)`

**Interfaces:**
- Consumes: the route's existing POST/PATCH bodies (unchanged for Cove and Dropsuite).
- Produces:

```ts
export type BackupCredentialField = { key: string; labelKey: string; testIdSuffix: string;
  input: 'text' | 'secret' | 'revealable_secret'; trim: boolean; requiredOnCreate: boolean };
export type BackupProviderForm = {
  provider: 'cove' | 'dropsuite' | 'axcient'; labelKey: string; namePlaceholderKey: string;
  inventory: 'endpoint' | 'saas'; fields: BackupCredentialField[];
  baseUrl: { placeholder: string; helpKey: string } | null;    // non-null => required and posted
  helpKey: string; reentryHelpKey: string | null;
  rotation: { requires: string[]; partialIsIncomplete: boolean };
};
export const BACKUP_PROVIDER_FORMS: readonly BackupProviderForm[];   // order: cove, dropsuite, axcient
export function getBackupProviderForm(provider: string): BackupProviderForm; // unknown => cove (current fallthrough)
export function createCredentials(form: BackupProviderForm, values: Record<string, string>): Record<string, string>;
export function canSubmitCreate(form: BackupProviderForm, values: Record<string, string>): boolean;
export function rotationCredentials(form: BackupProviderForm, values: Record<string, string>):
  { credentials: Record<string, string> } | { incomplete: true } | null;  // null = keep stored
```

Descriptor values. **Cove:** fields `partnerName` (text, trim, not required), `username` (text, trim, not required, `autoComplete="off"`), `password` (revealable_secret, no trim, required); rotation `requires ['password']`, partial allowed; help `credentialsHelp`. **Dropsuite:** fields `resellerToken`, `authToken` (secret, trim, required); `baseUrl` `{ placeholder: 'https://dropsuite.us/api/', helpKey: 'baseUrlHelp' }`; rotation requires both, `partialIsIncomplete: true`; `inventory: 'saas'`. **Axcient:** field `apiKey` (secret, trim, required, testIdSuffix `api-key`); `baseUrl: null`; rotation `requires ['apiKey']`; help `axcientCredentialsHelp`, re-entry `axcientReentryHelp`. Test ids: create `backup-add-${suffix}`, rotate `backup-connection-${suffix}`. These preserve every existing id.

New `integrations.json` keys under `backupProviders`: `axcient` = `Axcient x360Recover`; `namePlaceholderAxcient` = `Main Axcient account`; `apiKeyLabel` = `API key`; `axcientCredentialsHelp` = `Create an API key in x360Portal → Settings → API Keys with both x360Recover and Billing ticked. Breeze only reads status; it never changes anything in Axcient.`; `axcientReentryHelp` = `Leave the API key blank to keep the stored key, or enter a new one to replace it.`. Changed: `subtitle` = `Bring third-party backup status into Breeze with Cove Data Protection, NinjaOne SaaS Backup (Dropsuite) and Axcient x360Recover.`

- [ ] **Step 1: Write the failing tests:**

```ts
// backupProviderForms.test.ts
it('declares exactly cove, dropsuite, axcient', ...)
it.each([['cove', ['partner-name','username','password']], ['dropsuite', ['reseller-token','auth-token']], ['axcient', ['api-key']]])('%s renders fields %j', ...)
it('createCredentials trims every field except the Cove password', ...)   // {password:' p '} stays ' p '
it('canSubmitCreate: cove needs only password; dropsuite needs both tokens; axcient needs apiKey', ...)
it('rotationCredentials: dropsuite partial => incomplete; all blank => null; axcient blank => null', ...)
// BackupProvidersIntegration.test.tsx
it('POSTs an Axcient connection with only { apiKey } and no baseUrl', ...) // body: {provider:'axcient', name, showProviderNameInPortal:false, credentials:{apiKey:'test-axcient-key-0000'}}
it('shows the Axcient help text naming both product scopes', ...)
// the existing Cove and Dropsuite POST-body cases stay byte-identical and green
// BackupProviderConnectionCard.test.tsx
it('rotates an Axcient key with apiKey only', ...)          // PATCH body.credentials === {apiKey:'new'}; no partnerName/username/password keys
it('keeps the stored Axcient key when the field is blank', ...) // no credentials key
it('labels an Axcient card with device-link counters (endpoint inventory)', ...) // backup-connection-linked present
```

In `translationCoverage.test.ts`, add `it.each(['en', ...translatedLocales])('%s includes Axcient setup labels', …)`. It asserts `backupProviders.axcient === 'Axcient x360Recover'` and that the other four new keys are truthy. Raise each locale's `integrations.json` baseline by the reported identical-value count (expected +1, the brand label), with a comment.

- [ ] **Step 2: Run red.** Run `cd apps/web && npx vitest run src/components/integrations/backupProviderForms.test.ts src/components/integrations/BackupProvidersIntegration.test.tsx src/components/integrations/BackupProviderConnectionCard.test.tsx src/lib/i18n/translationCoverage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write the descriptor module and render both forms from it. `emptyForm` becomes `{ provider, name, baseUrl, showInPortal, values: {} }`. Replace each `provider === "dropsuite"` / `isDropsuite` in the two files with descriptor reads (`form.inventory === 'saas'` for the counters and the delete copy). Leave `BackupProviderCustomerMapping.tsx` untouched. Add `<option value="axcient">`. Docs: description and sidebar label `Backup Providers (Cove, Dropsuite, Axcient)`. A new `## Connecting Axcient x360Recover` section covers: create the key in x360Portal → Settings → API Keys with x360Recover and Billing ticked; the scope error and its fix; inactive clients listed; parked devices uncovered but silent; the Last boot check / Verified bootable evidence; no base URL field.
- [ ] **Step 4: Run green.** Run the same command, plus `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/integrations/backupProviderForms.ts apps/web/src/components/integrations/backupProviderForms.test.ts apps/web/src/components/integrations/BackupProvidersIntegration.tsx apps/web/src/components/integrations/BackupProvidersIntegration.test.tsx apps/web/src/components/integrations/BackupProviderConnectionCard.tsx apps/web/src/components/integrations/BackupProviderConnectionCard.test.tsx apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts apps/docs/src/content/docs/backup/backup-providers.mdx
git commit -m "feat(integrations): per-provider backup connection forms and the Axcient x360Recover form"
```

---

## W03: live verification (blocked on Decision 1: a live account)

W03 does not start until a live key exists, from an OliveTech Axcient trial or from the design partner's read-only key. Record each answer in the wave issue. Any answer that disagrees with W01/W02 becomes a red test in the owning file before it becomes a fix.

### Task 11: Live smoke against a real x360Recover account

**Files:**
- Modify (only where a check fails): the owning file from Tasks 1–4, with its test

- [ ] **Step 1: Connect.** Bring up a worktree stack (`worktree-stack` skill) and add an Axcient connection through the UI. Expected: Test connection shows the organization name and the client count.
- [ ] **Step 2: Rate limits.** Run three syncs back to back. Record any `429`, its `Retry-After` and the request count per sync from the API log. Pass: no un-retried 429, sync `success`.
- [ ] **Step 3: Scope claim.** Create a key with x360Recover ticked and Billing unticked. Record whether `/client` returns 403 `ForbiddenException`. If it does not, drop "and Billing" from `AXCIENT_SCOPE_MESSAGE` and `axcientCredentialsHelp` (Decision 5), with the test updated first.
- [ ] **Step 4: Shapes.** Record whether `/organization` is an object, whether `/client` and `/client/{id}/device` honour `limit`/`offset` (fetch with `limit=1`), whether RP and `end_timestamp` values carry `Z` or an offset (timestamp timezone), the real shapes of `check_disk` / `heartbeat` / `start_vss` / `system_boot`, and the `device_details_page_url` host.
- [ ] **Step 5: Caps and identity.** Confirm the `/device` 500-per-request cap, for phase 2 only. Compare five device `name` values against the agents' hostnames. If any is an operator label, pull `local_ps_id` matching into W03 as its own task (Decision 9).
- [ ] **Step 6: Commit** any fixes, one per owning file, with the message pattern `fix(backup-providers): <what the live API showed>`.

### Task 12: Scrubbed fixtures and release notes

**Files:**
- Modify: `apps/api/src/services/backupProviders/axcient/__fixtures__/*.json`, `__fixtures__/README.md`
- Modify: `docs/release-notes/next-release-draft.md`

- [ ] **Step 1: Replace the fixtures** with captures from Task 11. Rename every client and device to synthetic values, set MACs to `00:1a:2b:…`, remove screenshot URLs and Manager hosts, and keep key sets and value types exactly. The README records the capture date.
- [ ] **Step 2: Run the suites.** Run `cd apps/api && npx vitest run src/services/backupProviders/axcient/`. Expected: PASS. Any failure means a W01 assumption was wrong: fix it in its owning task's code with the test, not by editing the fixture back.
- [ ] **Step 3: Check for leaks.** Run `grep -rniE 'api[-_]?key|screenshot|x-api-key|@' apps/api/src/services/backupProviders/axcient/__fixtures__`. Expected: no real values. Only `test-axcient-key-0000` may appear, and only in tests.
- [ ] **Step 4: Release notes.** Add an "Axcient x360Recover backup provider" entry and the new `paused` status (parked Axcient devices show as Paused and uncovered, and never alert) to `next-release-draft.md`. That file is a merge-queue hot spot, so rebase it immediately before enqueueing.
- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/backupProviders/axcient/__fixtures__ docs/release-notes/next-release-draft.md
git commit -m "test(backup-providers): replace Axcient fixtures with scrubbed live captures; release notes"
```
