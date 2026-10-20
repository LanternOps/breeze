---
tracking_issue: TBD        # #7324 feature parent — set by register_feature (waves 7324-W1, 7324-W2)
tracking_issue_8834: TBD   # #8834 feature parent — set by register_feature (waves 8834-W1, 8834-W2, 8834-W3)
specs:
  - docs/superpowers/specs/reports/2026-10-15-custom-fields-reports-and-device-export-spec.md
  - docs/superpowers/specs/devices/2026-10-15-device-form-factor-spec.md
verified_against: origin/main 0ef0aec17b (2026-10-17)
---

# Custom-field reports + device-list export (#7324), then device form factor (#8834): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read both specs and this whole plan before executing a wave; execute **one wave per PR**.

**Goal:** Give the `/devices` list a WYSIWYG CSV export and make the Devices report's columns, custom fields and advanced filter real on the server. Then add a first-class, derived device form factor (laptop / desktop / tablet / server / VM) that plugs into those column contracts as one more catalog entry.

**Architecture:** Five waves, five PRs, landed in this order: **7324-W1 → 7324-W2 → 8834-W1 → 8834-W2 → 8834-W3**.

- **7324-W1** puts an exhaustive per-column `exportValue` binding on every device-list `ColumnId` and generates the CSV in the browser from `sortedDevices`. A best-effort `device.list.export` audit call never blocks the download.
- **7324-W2** adds a shared static report-column catalog with an exhaustive API binding and gates it behind `columnsVersion: 2`. It also adds:
  - one correlated jsonb subquery for custom fields;
  - a self-describing `result.columns` descriptor that every renderer honours;
  - a persisted, validated, time-bounded `deviceFilter`.
  There is no migration.
- **8834-W1** stores the raw SMBIOS chassis codes and the Mac model identifier on `device_hardware`. It derives `devices.form_factor` server-side through one pure shared function, using a row-lock + SQL-predicate recompute protocol, plus a versioned BullMQ reconcile job.
- **8834-W2** exposes form factor on every read surface: filter, list column with `exportValue`, Info tab, both reports, AI and the Partner API.
- **8834-W3** fixes the Go collector: batched CIM `Win32_SystemEnclosure` instead of `wmic`, every code, the Mac identifier, and an enrollment payload.

**Tech Stack:** Hono + Drizzle + postgres.js, hand-written idempotent SQL, BullMQ, Astro + React islands, `@breeze/shared` (zod), Vitest (unit, integration, RLS), Playwright (`data-testid`), Go `testing`.

**Specs (approved 2026-10-17, every decision as recommended):**
- `docs/superpowers/specs/reports/2026-10-15-custom-fields-reports-and-device-export-spec.md`, cited as **R-§n** and **R-Dn** (its §8 decisions).
- `docs/superpowers/specs/devices/2026-10-15-device-form-factor-spec.md`, cited as **F-§n**, **F-Dn** (its §3 table) and **F-OD-n** (its §13).

## Why one plan, and why this order

#7324 has no migration. It establishes the two exhaustive column contracts every later device column must satisfy:
- the device list's `Record<ColumnId, DeviceListColumnExport>` (7324-W1);
- the report's `Record<DeviceInventoryColumnId, DeviceInventoryColumnBinding>` (7324-W2).

Once both exist, #8834's user-facing surface (8834-W2) is one list column, one catalog id and the compiler naming each binding to fill. Landing #8834 first would mean building its list and report columns twice.

- **Hard dependency:** 8834-W2 needs both 7324 waves merged.
- **No code dependency:** 8834-W1 and 8834-W3 do not depend on #7324. If the orchestrator needs throughput, either can be *developed* in parallel, but it **merges** in the order above.

## Cross-plan rules (other open plans touch the same surfaces)

1. **`breeze_partner_export_devices_update` is redefined by 8834-W1, #8835 W4 and #8836 W4.** Land them sequentially. Each replays the **then-latest** body from the newest migration that defines it, keeps every earlier wave's columns in all six `ROW(...)` tuples, and adds only its own. Today the only definition is `apps/api/migrations/2026-07-18-partner-export-org-locks.sql:310` (3 comparisons, 6 tuples, 16 columns each). Before writing the replay, re-grep `CREATE OR REPLACE FUNCTION breeze_partner_export_devices_update` across `apps/api/migrations/`.
2. **`breeze_partner_export_device_child_update`** is replayed by 8834-W1 (its latest body is `2026-11-01-110000-device-memory-modules.sql:105`). The same rule applies: re-grep and replay the newest body verbatim.
3. **DeviceList waves land one at a time.** 7324-W1, 8834-W2, #8835 and #8836 each edit `DeviceList.tsx`, `columnVisibility.ts` and `deviceListColumnExport.ts`. They do not run concurrently. Rebase on the previous DeviceList wave before opening a PR.
4. **Catalog unification is deferred** (R-D7). Keep two exhaustive catalogs until #8834, #8835 **and** #8836 have all landed. This plan does not create `DEVICE_FIELD_CATALOG`.
5. **Migration slots** for this plan are `apps/api/migrations/2026-12-31-11HH00-<slug>.sql` (orchestrator-assigned). The newest committed migration is `2026-12-30-120900-trust-page-templates.sql`, and no `2026-12-31-11*` file exists. If `scripts/check-migration-naming.sh` rejects a slot, take the next free `HHMMSS` inside `2026-12-31-11` and say so in the PR.

## Global Constraints

- **Every spec decision stands.** Do not reopen R-D1–R-D8 or F-D1–F-D9 / F-OD-1–F-OD-10 in a PR. Where this plan refines a spec mechanism (the quorum changes Q1–Q9 below), the plan wins and the PR cites the Q number. In particular, Q1 and Q2 supersede the *mechanism* text of F-D8 / F-§5.8 (chunk-level transactions, `pg_try_advisory_lock`). F-D8's intent is kept unchanged: one implementation, versioned, one org per transaction, single-runner.
- **No internal infrastructure or customer names** in code, fixtures, test names or PR text.
- **i18n:** every new `en` key is added, translated, to all 7 other locales (`de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`) under `apps/web/src/locales/<loc>/`. This is required by `src/lib/i18n/localeParity.test.ts`, and `translationCoverage.test.ts` caps exact-English duplicates. Dynamic `t()` keys carry `/* i18n-dynamic */` (`keyUsage.test.ts`).
- **Web mutations:**
  - User-initiated PATCH/POST goes through `runAction` (`apps/web/src/lib/runAction.ts:91`).
  - The one best-effort audit POST (7324-W1) instead carries `// runaction-exempt: best-effort export audit, never blocks or toasts`, which is the marker `no-silent-mutations.test.ts` accepts.
- **Playwright** selects by `data-testid` only. Every new control gets one.
- **Files under ~500 lines.** `DeviceList.tsx` (3747 lines) and `ReportBuilder.tsx` (2765 lines) do not grow by more than wiring. New logic goes in new focused files.
- **DB context:** request code uses `withDbAccessContext`. Background code uses `runOutsideDbContext(() => withSystemDbAccessContext(...))`. A bare pool in request code is forbidden.
- **Typecheck:** use `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p <pkg>` and **read the exit code**. Never pipe it to `tail`.
- **Scoped tests:** run `cd apps/api && npx vitest run <path>`. Never use `pnpm --filter … test -- --run <path>`. Vitest path filters are substring matches.
- **Contract suites** (`tenant-export-policy`, `tenantExportErasureRoundtrip`, partner-export, org-cascade) fail only under **Integration Tests**, never under Test API. Any wave touching `devices`/`device_hardware` columns runs them locally on a per-worktree stack. Copy the root `.env` with the AI keys blanked, set `BREEZE_WORKSPACE_ENABLED=false`, and use a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24`. Run `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration -- <files>`, then `pnpm test-stack down`. Tear it down and say so.
- **Migrations** (8834-W1 only):
  - hand-written and idempotent;
  - no inner `BEGIN/COMMIT`;
  - never edit a shipped file;
  - **writes no rows**, so no `breeze.scope` election and no partner-export pre-lock sequence;
  - then run `pnpm db:check-drift`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Each wave PR body carries `Closes #<wave sub-issue>` and `Refs #7324` or `Refs #8834`. Write no closing keyword for anything you do not mean to close.
- **Release notes** (7324-W2): changing a Devices report's columns in the builder makes its column selection authoritative. **Self-host note** (8834-W1): migrations only, no env vars, and a boot reconcile job that logs progress.

## Quorum record (plan level, 2026-10-17)

Claude formed the position. Codex `gpt-6-astra` reviewed it at `xhigh` (read-only, one round) against `0ef0aec17b`. It covered:
- the catalog / `exportValue` contract;
- the form-factor precedence, recompute and reconcile design.

**Agreed:**
- the separate exhaustive list-export module (P1);
- machine values for enum columns (P2);
- the report catalog and API binding (P3);
- keeping `formFactor` out of the legacy 13 columns (P4);
- no catalog unification yet (P5);
- the F-§5.3 precedence (P6);
- value-**or-version** write predicate (P7);
- the trigger replays (P10);
- heartbeat recompute on accepted changes (P11).

**Changes adopted from the review** (cited in tasks as Q1–Q8):
- **Q1 (P8, disagreed with my lock-order claim).** One-org chunks do not prevent deadlock. Here is why:
  - The `devices` UPDATE trigger takes the partner-export org lock *after* the row lock (`2026-07-18-partner-export-org-locks.sql:339`).
  - A multi-device transaction can therefore hold device A plus the org lock while waiting for device B. Meanwhile B's heartbeat holds B and waits for the org lock.
  - Membership triggers and org merge already take the locks org → devices (`:402`, `orgMerge.ts:1189`).
  - **Resolution:** the reconcile job reads candidates in keyset chunks outside any transaction. It recomputes **each device in its own top-level transaction**, so a transaction holds at most one `devices` row plus that org's lock, the same shape as one heartbeat. It retries `40P01` and `40001` up to 3 times with jitter. This **replaces** F-§5.8's "each chunk is its own top-level transaction".
  - Also from Q1: the hardware PUT currently upserts `device_hardware` **before** touching `devices` (`inventoryChildSync.ts:384`). 8834-W1 adds the `devices … FOR UPDATE` lock *before* that upsert.
- **Q2 (P9, disagreed with a bare fixed jobId).** A retained completed or failed job under a fixed id silently swallows later boot enqueues (`services/bullmqUtils.ts:42`). Resolution:
  - Enqueue through `enqueueOrReplaceStale` (`bullmqUtils.ts:66`), copying `enqueuePlatformModelSync('boot')` in `jobs/aiModelDiscoveryWorker.ts:190,248`.
  - Make the jobId include the rules version (`bullmqJobId('form-factor-reconcile', 'v' + N)` → `form-factor-reconcile-v1`; BullMQ rejects `:` in custom ids, `bullmqUtils.ts:3-16`, `bullmqUtils.noColonJobIds.test.ts`), so a new rules version is never absorbed by an old replica's active job.
  - Copy the candidate-read and per-unit transaction shape from `jobs/topologyBootstrapPass.ts:95`, not `patchScheduleBackfill.ts`.
  - This **replaces** F-§5.8's `pg_try_advisory_lock`. Exclusivity is only an efficiency property: correctness comes from Q1 plus the P7 predicate.
- **Q3 (missed risk 3, version fencing).** During a rolling deploy, an old replica must never downgrade a newer stamp. Both selection and write therefore fence on version: selection is `form_factor_rules_version IS NULL OR form_factor_rules_version < $current`; the write adds `AND (form_factor_rules_version IS NULL OR form_factor_rules_version <= $ver)`.
- **Q4 (missed risk 4, lost group notification).** `requestDeviceGroupReevaluation` turns an enqueue failure into `null` (`jobs/deviceGroupJobs.ts:246`). The reconcile job therefore calls it directly and awaits it after each per-device commit (the after-commit variant returns `void`). It collects the ids that returned `null` and retries them once at the end of the run. It logs the remainder as `notifyFailed` in its `{ scanned, changed, failed, notifyFailed }` line. Other callers keep today's semantics. The general no-sweep gap stays a follow-up (F-§9).
- **Q5 (P11, presence vs change).** `isVirtual` enters `deviceUpdates` on **every** report that carries it (`routes/agents/heartbeat.ts:1323`). The heartbeat therefore compares against the loaded `device.isVirtual` before treating it as changed. Without that comparison, adding it to `filterableChangedFields` would enqueue group re-evaluation on every beat.
- **Q6 (missed risk 1).** Catalog-id validation of `columns` applies only to **`device_inventory` configs with `columnsVersion: 2`**. `legacyReportConfigSchema` serves other report types and legacy alias ids. `device_inventory` gets its own `deviceInventoryReportConfigSchema` in the registry (`services/reportRegistry.ts:144`).
- **Q7 (missed risk 2).** The 12-column PDF cap (R-D8) validates the **effective merged** format + config on create, on update (including format-only updates, `routes/reports/core.ts:821` only checks when `config` is sent) and on series routes. Legacy (non-v2) configs are grandfathered, because they deliver 13 columns today.
- **Q8 (P2 and P4 refinements):**
  - **Network and manual rows** carry placeholder OS/CPU/RAM values (`DevicesPage.tsx:730`). For a column that does not apply to a row's class, `exportValue` returns `null`, never `0`.
  - **Null rendering is unchanged.** Store `null`. The generic PDF already prints `—` (`reportPdf.ts:1960`), the preview prints `-` and CSV prints empty. F-§7's "manual-asset rows show —" is therefore satisfied without changing global null rendering.
  - **Legacy order.** The legacy order starts with `deviceId` (`reportGenerationService.ts:395`), and the fixture pins actual generator output, including the manual branch.

**Plan-level refinement (no quorum needed, flagged for review):**
- **Q9.** `withFilterStatementTimeout` hard-codes the evaluator's 500 ms (`filterEngine.ts:866`). A 10k-device report would time out. The function is exported with an optional `{ timeoutMs }`. The report path uses `REPORT_DEVICE_FILTER_TIMEOUT_MS = 30_000`. The wrapper already turns a `57014` into `FilterQueryTimeoutError` (`filterEngine.ts:877,941`, exported with it). The generator catches that error and fails the run with `device_filter_timeout`.

## Review Focus

The input classes the specs imply that no spec test exercises, most likely first. Each has a test in its owning task.

1. **A mixed-class list** (agent, network and manual rows) exported with OS, RAM and CPU columns visible. Non-agent rows must export empty cells, not `0` or a placeholder string (Q8).
   → 7324-W1 Task 1, test `non-agent rows export null for agent-only columns`.
2. **A rolling deploy in which an old API replica recomputes a row already stamped by newer rules.** The stamp and value must survive (Q3).
   → 8834-W1 Task 4, test `a stale-rules caller never downgrades a newer stamp`.
3. **A heartbeat that re-reports the same `isVirtual` every beat.** It must enqueue no group re-evaluation and must not recompute form factor (Q5).
   → 8834-W1 Task 4, test `unchanged isVirtual on every beat enqueues nothing`.
4. **An existing PDF-format legacy Devices report edited for its schedule only.** It must save: legacy configs are grandfathered from the 12-column cap. A v2 25-column CSV report switched to PDF with a format-only update must be refused (Q7).
   → 7324-W2 Task 3, tests `legacy pdf report saves without column change` and `format-only switch to pdf over 12 v2 columns is refused`.
5. **A 10k-device org report with a `deviceFilter` and 25 custom columns.** It must not hit the evaluator's 500 ms timeout, and a pathological filter must fail the run cleanly (Q9).
   → 7324-W2 Task 4, test `report filter runs under the report timeout, not the evaluator's`; the integration plan gate in Task 10 measures the real query.

Also pinned, lower likelihood:
- **The same custom `fieldKey` defined in two orgs, viewed under "All organizations".** The export's custom headers equal the rendered custom headers, duplicates included. This mirrors the screen; deduplication is a follow-up.
  → 7324-W1 Task 1, test `custom export columns equal the rendered custom headers`.

---

# Wave 7324-W1: device-list CSV export (R-§5, Part B)

Branch `feature/<7324-parent#>-device-export/wave-<sub#>` off fresh `origin/main`. No migration and no shared-catalog work (that is 7324-W2).

## File structure

| File | Responsibility |
|---|---|
| Create `apps/web/src/components/devices/deviceListColumnExport.ts` | `DEVICE_LIST_COLUMN_EXPORT: Record<ColumnId, DeviceListColumnExport>`, `buildDeviceListCsv`, `deviceExportFilename` |
| Create `apps/web/src/components/devices/deviceListColumnExport.test.ts` | value, order, header, class, type-level tests |
| Create `apps/web/src/components/devices/DeviceListExportControls.tsx` | toolbar button + bulk-menu item, disabled states, audit call |
| Create `apps/web/src/components/devices/DeviceListExportControls.test.tsx` | disabled-state and wiring tests |
| Create `apps/web/src/lib/deviceListExportAudit.ts` | `recordDeviceListExport()` best-effort POST |
| Modify `apps/web/src/components/devices/columnVisibility.ts` | export the class-applicability sets moved from `DeviceList.tsx` |
| Modify `apps/web/src/components/devices/DeviceList.tsx` | render controls in the toolbar (`:2804` area) and bulk menu (`:2946`); pass `renderedColumns`, `visibleCustomFieldDefs`, `sortedDevices`, completeness |
| Modify `apps/web/src/components/devices/DevicesPage.tsx` | per-arm completeness (`:678-697` catches, MAX_PAGES), pass to `DeviceList` |
| Modify `apps/web/src/lib/devicesFetch.ts` | `truncated: boolean` on each walker's response |
| Modify `apps/web/src/locales/*/devices.json` | export strings (8 files) |
| Create `apps/api/src/routes/devices/exportEvents.ts` (+ `.test.ts`) | `POST /devices/export-events` |
| Modify `apps/api/src/routes/devices/index.ts` | mount **before** `coreRoutes` (`:143`) |

### Task 1: Exhaustive export binding and the CSV builder

**Interfaces:**
- Consumes: `ColumnId`, `COLUMN_IDS` (`columnVisibility.ts:9`); `Device` (`DeviceList.tsx:157`); `toCsv` (`@breeze/shared` via `apps/web/src/lib/csvExport.ts`).
- Produces:
  ```ts
  export type ExportCell = string | number | boolean | null;
  export interface DeviceListColumnExport {
    exportValue: (d: Device) => ExportCell;
    exportHeaderSuffix?: string; // e.g. ' (GB)'
  }
  export const DEVICE_LIST_COLUMN_EXPORT: Record<ColumnId, DeviceListColumnExport>;
  export interface CustomExportColumn { fieldKey: string; name: string }
  export function buildDeviceListCsv(input: {
    devices: readonly Device[];              // already in screen order
    columns: readonly ColumnId[];            // DeviceList `renderedColumns`, in order
    customColumns: readonly CustomExportColumn[]; // `visibleCustomFieldDefs`, in rendered order
    headerFor: (id: ColumnId) => string;     // the localized title the header shows
    deviceIdHeader: string;                  // localized "Breeze device ID"
  }): string;
  export function deviceExportFilename(orgSlug: string | null, now: Date, timeZone: string): string;
  ```
  8834-W2 adds `formFactor` to this `Record`. #8835 and #8836 do the same.

- [ ] **Step 1: Write the failing tests** in `deviceListColumnExport.test.ts`:
  - `every ColumnId has an export binding`: `expect(Object.keys(DEVICE_LIST_COLUMN_EXPORT).sort()).toEqual([...COLUMN_IDS].sort())`.
  - `a Record missing a ColumnId fails typecheck`: in the same file, `// @ts-expect-error missing key` on `const _x: Record<ColumnId, DeviceListColumnExport> = { hostname: DEVICE_LIST_COLUMN_EXPORT.hostname };`. `apps/web/tsconfig.json` includes `src/**/*`, so `tsc` checks it.
  - `timestamps export ISO 8601 UTC`: a `lastSeen` value of `2026-10-17T08:09:10.000Z` round-trips exactly, and `enrolled` likewise.
  - `RAM exports GB with the unit in the header`: `ramTotalMb: 16384` → `16`. The suffix is `' (GB)'`, and the header becomes `RAM (GB)` with `headerFor('ramTotal') === 'RAM'`. `diskTotal` gets the same treatment with `' (GB)'`.
  - `booleans export true/false and multi-values join with "; "`: `isHeadless` → `true`, and `tags: ['a','b']` → `'a; b'`.
  - `enum columns export machine values`: `status: 'online'` → `'online'`, and `role: 'workstation'` → `'workstation'` (Q8 / P2).
  - `non-agent rows export null for agent-only columns` (Review Focus 1): build one network row and one manual row the way `DevicesPage.tsx:~730` adapts them. Every column in `AGENT_ONLY_COLUMNS`, plus `os`, `cpuModel`, `ramTotal` and `diskTotal`, exports `null` for those rows. The CSV cell is empty, never `0`.
  - `custom export columns equal the rendered custom headers`: two defs with the same `fieldKey` and names `"Owner"`/`"Asset owner"` both appear as headers, each with `device.customFields[fieldKey]` (pre-existing list behaviour, mirrored).
  - `columns follow rendered order then custom then device id`: the header row is exactly `[...columns.map(headerFor+suffix), ...custom names, deviceIdHeader]`, and the last cell of each row is `device.id`.
  - `formula neutralization covers headers and cells`: a custom name `=SUM(A1)` and a hostname `+cmd` are both neutralized (shared `neutralizeSpreadsheetFormula`).
  - `filename`: `deviceExportFilename('Acme Corp!', new Date('2026-10-17T23:30:00Z'), 'America/Chicago') === 'devices-acme-corp-2026-10-17.csv'`, and `deviceExportFilename(null, …)` starts with `devices-all-organizations-`.

- [ ] **Step 2: Run them and watch them fail.** Run: `cd apps/web && npx vitest run src/components/devices/deviceListColumnExport.test.ts`. Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `deviceListColumnExport.ts`.**
  - Each `exportValue` reads the same source field its `columnDefs` cell renders (`DeviceList.tsx:1599`). It also reuses the cell's applicability check (`AGENT_ONLY_COLUMNS` / `NON_AGENT_COLUMNS` / `MANUAL_ONLY_COLUMNS`, `deviceClass`) to return `null`.
  - Those sets are module-private consts in `DeviceList.tsx` (`:451` onward). **Move** them, unchanged, to `columnVisibility.ts` as exports and import them back into `DeviceList.tsx`, so that the two files cannot drift.
  - `toCsv` only accepts `string|number|null|undefined` (`packages/shared/src/utils/csvExport.ts:66`). Map booleans to `'true'`/`'false'` inside `buildDeviceListCsv`. Do not widen the shared signature in this wave.
  - Filename date: use `Intl.DateTimeFormat('en-CA', { timeZone })`. The slug is lowercased, with `[^a-z0-9]+` collapsed to `-` and trimmed.

- [ ] **Step 4: Run the tests and watch them pass.** Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit** `feat(web/devices): exhaustive per-column export binding + CSV builder (#7324)`.

### Task 2: Per-arm completeness

**Interfaces:**
- Produces: `export type ArmCompleteness = 'complete' | 'degraded' | 'truncated';`, `export interface DeviceListCompleteness { agents: ArmCompleteness; network: ArmCompleteness; manual: ArmCompleteness }`, exported from `apps/web/src/lib/devicesFetch.ts`. The three walkers' responses gain `truncated: boolean`.

- [ ] **Step 1: Write the failing tests.**
  - In `apps/web/src/lib/devicesFetch.test.ts`: `fetchAllDevices sets truncated when MAX_PAGES is hit with a next cursor` (mock 200 pages, each returning a `nextCursor`), and `truncated is false on a natural end`. Add the same pair for the network walker (`:206`) and the manual walker (`:265`).
  - In `DevicesPage` tests (find the existing `DevicesPage*.test.tsx`; if none covers the arms, create `DevicesPage.completeness.test.tsx`): `a network-arm fetch failure marks network degraded` and `a manual-arm failure marks manual degraded`. Today the catches at `DevicesPage.tsx:678-697` return `[]`. They keep returning `[]` for the list, but now also set the arm to `degraded`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** `truncated` = the loop exited because `pages === MAX_PAGES` while a cursor remained. `DevicesPage` holds `DeviceListCompleteness` state and passes it to `DeviceList` as `completeness`. AbortError and 401 rethrows are unchanged.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(web/devices): report per-arm list completeness (#7324)`.

### Task 3: Audit route `POST /devices/export-events`

**Interfaces:**
- Produces: `exportEventsRoutes` (Hono), mounted in `routes/devices/index.ts` before `coreRoutes`.
- Body: `deviceListExportEventSchema = z.object({ rowCount: z.number().int().min(0).max(1_000_000), columnIds: z.array(z.string().max(120)).max(200), hasAdvancedFilter: z.boolean(), selectionOnly: z.boolean(), orgId: z.string().uuid().nullable() })`.
- Response: `204`.

- [ ] **Step 1: Write the failing tests** in `apps/api/src/routes/devices/exportEvents.test.ts` (Vitest + Drizzle mocks, `breeze-testing` conventions):
  - `writes device.list.export with server-derived scope`: `writeRouteAudit` is called with `action: 'device.list.export'` and `resourceType: 'device_list'`. Its `details` carry `{ scope: auth.scope, orgId, allowedSiteIds: <from auth or null>, clientReported: { rowCount, columnIds, hasAdvancedFilter, selectionOnly } }`.
  - `org-scope caller: orgId is the token org, body orgId ignored`.
  - `partner caller with an orgId it cannot access → 403`: use the `auth.canAccessOrg` pattern in the router.
  - `partner caller with orgId null → audit row on the partner axis`: `orgId: null, partnerId: auth.partnerId`.
  - `requires devices:read`: a caller without it gets 403.
  - `rate limited`: the 61st call in the window gets 429. Use `userRateLimit('device-list-export', 60, 3600)`, `middleware/userRateLimit.ts:11`.
  - `invalid body → 400`.
  - Mount-order guard: create `routes/devices/exportEvents.mountorder.test.ts`, following `bulkLifecycle.mountorder.test.ts`. It asserts `POST /devices/export-events` resolves to this router, not core's `/:id`.
- [ ] **Step 2: Run them and watch them fail.** Run: `cd apps/api && npx vitest run src/routes/devices/exportEvents.test.ts`.
- [ ] **Step 3: Implement.**
  - Middleware chain: `authMiddleware, requireScope('organization','partner','system'), requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action), userRateLimit(...), zValidator('json', …)`.
  - No `requireMfa()`. The list itself needs none, and an audit write must not be harder to make than the read it records.
  - Use `writeRouteAudit` (`services/auditEvents.ts:225`). **Do not** widen `auditSensitiveRead`: its closed unions are for server-served downloads.
- [ ] **Step 4: Run them and watch them pass.** Then confirm `routes/devices/*.mountorder.test.ts` still passes.
- [ ] **Step 5: Commit** `feat(api/devices): POST /devices/export-events audit (device.list.export) (#7324)`.

### Task 4: Export controls in the toolbar and bulk menu

**Interfaces:**
- Consumes: Task 1 `buildDeviceListCsv`, `deviceExportFilename`; Task 2 `DeviceListCompleteness`; Task 3 route.
- Produces:
  - `recordDeviceListExport(details): void` in `apps/web/src/lib/deviceListExportAudit.ts`. It is fire-and-forget: `fetchWithAuth('/devices/export-events', { method: 'POST', keepalive: true, … })` with the runaction-exempt marker, and it swallows errors with `console.warn`.
  - `<DeviceListExportControls>` props: `{ devices: readonly Device[]; selectedIds: ReadonlySet<string>; columns; customColumns; completeness; filterBlocked: boolean; orgSlug: string | null; orgId: string | null; hasAdvancedFilter: boolean }`.

- [ ] **Step 1: Write the failing tests** in `DeviceListExportControls.test.tsx`:
  - `button label carries the count`: "Export 1,284 devices", localized number.
  - `disabled while filterBlocked`: pass `DeviceList`'s `filterBlocked` (`DeviceList.tsx:1073`, `serverFilterLoading || serverFilterError`). It is the list-side view of the page's advanced-filter loading/error state, so an in-flight filter never exports the unfiltered fleet.
  - `disabled with a tooltip naming the incomplete arm` when any arm is `degraded` or `truncated`.
  - `"Export selected (N)" stays enabled when an arm is degraded`.
  - `selected export keeps screen order`: the selected subset is `sortedDevices.filter(d => selectedIds.has(d.id))`, not the unsorted `selectedDevices`.
  - `download is not blocked on the audit call`: `recordDeviceListExport` rejects, yet the Blob download (spy on `URL.createObjectURL`) still happens, and no error toast appears.
  - `audit receives clientReported fields` (`rowCount`, `columnIds` incl. `custom.<key>`, `hasAdvancedFilter`, `selectionOnly`).
  - `data-testid`s: `device-list-export-button`, `device-list-export-selected`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** the component and wire it into `DeviceList.tsx`. Use the toolbar beside the column picker and the bulk menu after Compare. `headerFor` uses the same `t()` lookup the column header uses.
  - Add locale keys `deviceList.export.button`, `.selected`, `.incomplete.{agents,network,manual}`, `.deviceIdHeader` to `en/devices.json` and all 7 other locales, translated.
- [ ] **Step 4: Run them and watch them pass**, plus `src/lib/i18n/*.test.ts` and `src/lib/__tests__/no-silent-mutations.test.ts`.
- [ ] **Step 5: Commit** `feat(web/devices): Export CSV and Export selected (#7324)`.

### Task 5: Wave verification

- [ ] Web: `cd apps/web && npx vitest run src/components/devices src/lib/devicesFetch src/lib/i18n src/lib/__tests__/no-silent-mutations` → PASS.
- [ ] API: `cd apps/api && npx vitest run src/routes/devices` → PASS.
- [ ] Typecheck web, api and shared with the 12 GB heap. Every exit code is 0.
- [ ] Playwright (`worktree-stack` skill, `data-testid` only): populate a custom field, show it as a list column, export, and assert that the header has the definition name and the cell has the value. Tear the stack down.
- [ ] Open the PR (`Closes #<sub>`, `Refs #7324`). Run one review round.

---

# Wave 7324-W2: custom-field columns and filters in the Devices report (R-§4, Part A)

Branch `feature/<7324-parent#>-device-export/wave-<sub#>` after 7324-W1 merges. No migration.

## File structure

| File | Responsibility |
|---|---|
| Create `packages/shared/src/reports/deviceInventoryColumns.ts` (+ `index.ts`, export from `packages/shared/src/index.ts`) | static catalog, legacy list, limits |
| Create `packages/shared/src/types/reportColumns.ts` | `ReportColumnDescriptor` |
| Modify `packages/shared/src/utils/csvExport.ts` (+ test) | `rowsToCsv(rows, columns?)`, `rowsToTsv(rows, columns?)` |
| Modify `packages/shared/src/reportPdf/reportPdf.ts` | generic table uses `columns` (`:1995-1996`) |
| Modify `apps/api/src/services/reportConfigSchemas.ts`, `services/reportRegistry.ts:144`, `routes/reports/schemas.configParity.test.ts` | `deviceInventoryReportConfigSchema` (Q6) |
| Modify `apps/api/src/routes/reports/core.ts` (+ series routes) | effective-format PDF cap (Q7) |
| Modify `apps/api/src/services/filterEngine.ts` | export `compileDeviceFilterPredicate`, `withFilterStatementTimeout(run, opts)` (Q9) |
| Create `apps/api/src/services/reports/deviceInventoryColumnBindings.ts` | exhaustive API binding + custom column plan |
| Modify `apps/api/src/services/reportGenerationService.ts` | `readDeviceInventoryRows` plan/executor, generator v2 path |
| Modify `routes/reports/runs.ts`, `services/reportDelivery.ts`, `jobs/reportScheduleWorker.ts:1031`, `services/reportNarrativeDelivery.ts:290` | forward `columns`/`warnings`; header-only zero-row file |
| Modify `apps/web/src/components/reports/{reportExport.ts,ReportPreview.tsx}` | honour `columns` |
| Modify `apps/api/src/routes/customFields.ts:221-290` | honour `orgId` |
| Modify `apps/api/src/services/aiToolsExportDatasets.ts:140,313` (+ tool description) | `filters.columns` |
| Create `apps/web/src/components/reports/deviceReportColumns.ts` (+ test); modify `ReportBuilder.tsx` | catalog-driven Devices fields, legacy state, v2 switch |
| Modify `apps/web/src/locales/*/reports.json` | new field labels |

### Task 1: Shared catalog and descriptor type

**Interfaces — Produces** (verbatim names; later tasks and 8834-W2 rely on them):
```ts
// packages/shared/src/reports/deviceInventoryColumns.ts
export const DEVICE_INVENTORY_COLUMN_IDS = [
  'deviceId', 'hostname', 'displayName', 'osType', 'osVersion', 'agentVersion', 'status',
  'lastSeenAt', 'enrolledAt', 'cpuModel', 'ramTotalMb', 'diskTotalGb', 'serialNumber',
  'siteName', 'manufacturer', 'model', 'lastUser',
] as const;
export type DeviceInventoryColumnId = (typeof DEVICE_INVENTORY_COLUMN_IDS)[number];
export type ReportColumnType = 'string' | 'number' | 'date' | 'boolean';
export interface DeviceInventoryColumnMeta { labelKey: string; label: string; type: ReportColumnType; defaultSelected: boolean }
export const DEVICE_INVENTORY_COLUMNS: Record<DeviceInventoryColumnId, DeviceInventoryColumnMeta>;
export const LEGACY_DEVICE_INVENTORY_COLUMNS: readonly DeviceInventoryColumnId[]; // the first 13, in that order
export const CUSTOM_COLUMN_PREFIX = 'custom.';
export const CUSTOM_COLUMN_KEY_PATTERN = /^[a-z][a-z0-9_]*$/; // must equal filterEngine CUSTOM_FIELD_KEY_PATTERN
export const MAX_REPORT_CUSTOM_COLUMNS = 25;
export const MAX_PDF_REPORT_COLUMNS = 12;
export function isDeviceInventoryColumnId(id: string): id is DeviceInventoryColumnId;
export function parseCustomColumnId(id: string): string | null; // fieldKey or null
// packages/shared/src/types/reportColumns.ts
export interface ReportColumnDescriptor {
  id: string; label: string; labelKey?: string; type: ReportColumnType;
  kind: 'static' | 'custom'; missing?: true;
}
```
`labelKey` = `reports.reportBuilder.fields.devices.<id>`. `defaultSelected` is true for `hostname, osType, status, siteName, lastSeenAt` (the builder default's intent) and false otherwise.

- [ ] **Step 1: Write the failing tests** (`packages/shared/src/reports/deviceInventoryColumns.test.ts`):
  - `legacy columns are the first 13 ids in generator order`: equal to `['deviceId','hostname',…,'serialNumber']`.
  - `catalog covers every id`.
  - `custom key pattern equals filterEngine's`: assert the regex source equals `'^[a-z][a-z0-9_]*$'`. The API test in Task 4 asserts the same against `filterEngine`.
  - `parseCustomColumnId('custom.asset_owner') === 'asset_owner'`, `parseCustomColumnId('custom.Bad') === null`, `parseCustomColumnId('hostname') === null`.
- [ ] **Step 2: Run them and watch them fail.** Run: `cd packages/shared && npx vitest run src/reports`.
- [ ] **Step 3: Implement** the module and export it from the package index.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(shared/reports): device inventory column catalog (#7324)`.

### Task 2: Renderers honour the descriptor

**Interfaces:**
- Produces: `rowsToCsv(rows: unknown[], columns?: readonly ReportColumnDescriptor[]): string` and `rowsToTsv(...)` with the same signature.
- `renderGenericReport(doc, rows, opts)` reads `opts.columns?: readonly ReportColumnDescriptor[]`.
- `exportReport(rows, opts)`'s `opts` gains `columns?`.
- `ReportPreview` reads `result.columns`.

- [ ] **Step 1: Write the failing tests.**
  - In `packages/shared/src/utils/csvExport.test.ts`: `with columns: header uses labels in descriptor order`; `with columns: missing row keys render empty`; `custom label "=HYPERLINK(…)" is neutralized`; `without columns: byte-identical to today` (fixture string captured from the current implementation before editing); `with columns and zero rows: header-only line`.
  - The same set for `rowsToTsv`.
  - In `packages/shared/src/reportPdf` tests: `generic table uses descriptor labels and order`; `without columns, humanizeHeader(Object.keys(rows[0])) unchanged`.
  - In a new `apps/web/src/components/reports/ReportPreview.columns.test.tsx` (copy the harness from `ReportPreview.backupStatus.test.tsx`): `descriptor drives header order and labels; static columns translate via labelKey`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Keep the no-`columns` path untouched. `rowsToCsv([])` without `columns` still returns `''`.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(reports): renderers honour result.columns labels and order (#7324)`.

### Task 3: `device_inventory` config schema and the PDF cap

**Interfaces:**
- Produces: `deviceInventoryReportConfigSchema` in `reportConfigSchemas.ts`. It is `legacyReportConfigSchema` extended with:
  - `columnsVersion: z.literal(2).optional()`;
  - `customColumnBindings: z.record(z.string(), z.object({ definitionId: z.string().uuid() })).optional()`;
  - `filters` gaining `deviceFilter: filterConditionGroupSchema.optional()` (and `includeManualAssets: z.boolean().optional()`, so the existing live-only knob persists; see the explorer note at `reportConfigSchemas.ts:44`).
  - It is plus a `superRefine` that, **only when `columnsVersion === 2`**, requires each `columns` entry to be a catalog id or a pattern-valid `custom.<key>`, with no duplicates, at most `MAX_REPORT_CUSTOM_COLUMNS` custom entries, and `deviceFilter` passing `compileDeviceFilterPredicate` (Task 4).
- Registry: `device_inventory.configSchema = deviceInventoryReportConfigSchema` (`reportRegistry.ts:144`).
- Produces: `assertPdfColumnCap(format: string, config: unknown): { ok: true } | { ok: false; error: 'pdf_too_many_columns'; max: 12 }`, called on the **effective merged** format + config.

- [ ] **Step 1: Write the failing tests.**
  - In `apps/api/src/services/reportConfigSchemas.test.ts`: `legacy alias columns still parse without columnsVersion`; `v2 rejects an unknown static id`; `v2 rejects custom.Bad`; `v2 rejects 26 custom columns`; `v2 rejects duplicates`; `deviceFilter survives parse` (today `filters` strips it); `deviceFilter failing validateFilter is refused`; `deviceFilter depth 5 or 51 conditions is refused`; `software_inventory still uses the legacy schema` (Q6).
  - In a new `apps/api/src/routes/reports/core.pdfColumnCap.test.ts` (copy the harness from `core.partnerOwned.test.ts`):
    - `legacy pdf report saves without column change` (Review Focus 4);
    - `format-only switch to pdf over 12 v2 columns is refused`;
    - `v2 pdf create with 13 columns → 400 pdf_too_many_columns`;
    - `v2 csv with 30 columns saves`;
    - the same refusal on the report-series create and update routes.
  - Update the `schemas.configParity.test.ts` fixture so that it covers the new `device_inventory` schema and keeps `LEGACY_LOOSE` for the others.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** In `core.ts:821` and the series routes, compute `effectiveFormat = data.format ?? locked.format` and `effectiveConfig = data.config ?? locked.config`, and call `assertPdfColumnCap` even when only `format` changed.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(api/reports): device_inventory config schema, v2 column validation, PDF cap (#7324)`.

### Task 4: Validated, bounded device-filter compilation

**Interfaces:**
- Produces (exported from `services/filterEngine.ts`):
  ```ts
  export const MAX_PERSISTED_FILTER_DEPTH = 4;
  export const MAX_PERSISTED_FILTER_CONDITIONS = 50;
  export function compileDeviceFilterPredicate(group: FilterConditionGroup):
    { ok: true; predicate: SQL } | { ok: false; errors: string[] };
  export function withFilterStatementTimeout<T>(run: (tx: FilterQueryTx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>;
  ```
- `REPORT_DEVICE_FILTER_TIMEOUT_MS = 30_000` lives in `reportGenerationService.ts`.

- [ ] **Step 1: Write the failing tests** (`services/filterEngine.compile.test.ts`):
  - `unknown field refused`; `operator illegal for type refused`; `custom.Bad refused`; `depth 5 refused`; `51 conditions refused`; `valid custom.asset_owner equals "x" compiles`.
  - `CUSTOM_COLUMN_KEY_PATTERN equals CUSTOM_FIELD_KEY_PATTERN`.
  - `report filter runs under the report timeout, not the evaluator's` (Review Focus 5): spy on the `set_config('statement_timeout', …)` value. It is `30000ms` with `{ timeoutMs: 30_000 }` and `500ms` by default.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** `compileDeviceFilterPredicate` runs `validateFilter` (`:1085`), then the depth and count walk, then `buildGroupSQL` (`:790`). Existing callers of `withFilterStatementTimeout` keep the default.
- [ ] **Step 4: Run them and watch them pass**, plus the existing `filterEngine*.test.ts`.
- [ ] **Step 5: Commit** `feat(api/filters): validated, capped device-filter compilation for persisted filters (#7324)`.

### Task 5: API column binding and generator v2 path

**Interfaces:**
- Consumes: Task 1 catalog, Task 4 compile and timeout.
- Produces:
  ```ts
  // services/reports/deviceInventoryColumnBindings.ts
  export interface DeviceInventoryColumnBinding {
    select: SQL | AnyPgColumn;              // agent-device branch
    manualAsset: (a: ManualAssetRow) => unknown; // null where no projection
  }
  export const DEVICE_INVENTORY_COLUMN_BINDINGS: Record<DeviceInventoryColumnId, DeviceInventoryColumnBinding>;
  export interface CustomColumnPlanEntry { columnId: string; fieldKey: string; definitionId: string | null; label: string; type: ReportColumnType; missing: boolean; rebound: boolean }
  export interface DeviceInventoryColumnPlan { staticIds: DeviceInventoryColumnId[]; custom: CustomColumnPlanEntry[]; order: string[] }
  export async function resolveDeviceInventoryColumnPlan(input: {
    orgId: string; columns: readonly string[]; bindings?: Record<string, { definitionId: string }>;
  }): Promise<{ plan: DeviceInventoryColumnPlan; warnings: string[] }>;
  export function describeColumns(plan: DeviceInventoryColumnPlan): ReportColumnDescriptor[];
  // reportGenerationService.ts
  export async function readDeviceInventoryRows(orgId: string, conditions: SQL[], opts?: { plan?: DeviceInventoryColumnPlan; executor?: DbExecutor }): Promise<Record<string, unknown>[]>;
  ```
  - With no `plan`, `readDeviceInventoryRows` returns exactly today's 13 keys in today's order.
  - `ReportResult` (`:77`) gains `columns?: ReportColumnDescriptor[]`. `summary.warnings?: string[]` carries drift lines.

- [ ] **Step 1: Write the failing tests** (`services/reportGenerationService.deviceInventory.test.ts`; mock-db conventions):
  - `no columnsVersion → exactly the legacy 13 keys, byte-identical fixture`. Capture the fixture **before** editing, from the current generator run on a fixture with one agent device and one manual asset. It includes the manual branch's `deviceId: null, status: 'unknown'` and the hostname sort (Q8).
  - `alias columns without columnsVersion are ignored`: a `['hostname','os','owner']` config still yields 13 keys.
  - `v2 honours columns order and emits result.columns`.
  - `every row carries every column key, nulls included`.
  - `manual-asset rows carry null custom cells and null for static ids without projection`.
  - `definition resolution is explicit`: the resolver query predicate is `org_id = $org OR partner_id = $orgPartner`. Assert the SQL text. It must not depend on RLS.
  - `deleted definition → missing descriptor "<key> (field removed)" + one warning` (R-D5).
  - `recreated definition → rebinds to the live id + warning naming the field` (R-D5).
  - `renamed definition → new name as label`.
  - `deviceFilter drops the manual branch and is ANDed with site authority`.
  - `deviceFilter run uses the report timeout; FilterQueryTimeoutError → run fails with device_filter_timeout` (mock the 57014 *below* the wrapper so the wrapper's translation is exercised).
  - `a legacy report edited without touching columns stays legacy`: covered at the route level in Task 9; here assert the generator decision only on `columnsVersion`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - The bindings use the R-§4.3 correlated jsonb subquery, keyed by `definition_id`, as the default. Task 10's plan gate may swap it for the aggregate join; both produce `custom_values`.
  - `siteName` joins `sites`. `lastUser` is `devices.lastUser`. `manufacturer`/`model` come from `deviceHardware`.
  - Wrap the read in `withFilterStatementTimeout(…, { timeoutMs: REPORT_DEVICE_FILTER_TIMEOUT_MS })`, passing `executor: tx`, **if and only if `deviceFilter` is present**, whether or not custom columns are selected. Without a filter the read runs as it does today.
- [ ] **Step 4: Run them and watch them pass**, plus the existing report-generation tests (`reportGenerationService*.test.ts`, `reportRegistry*.test.ts`).
- [ ] **Step 5: Commit** `feat(api/reports): device inventory column plan, custom-field values, persisted device filter (#7324)`.

### Task 6: Propagate `columns` and `warnings` through every consumer

- [ ] **Step 1: Write the failing tests:**
  - `runs.ts` download: `v2 zero-row csv → 200 header-only` and `excel` the same; `result without columns and zero rows → 409 unchanged` (`:551`); `csv uses descriptor labels`.
  - `reportScheduleWorker`: `emailReportRun receives columns and warnings` (`:1031`). `reportNarrativeDelivery.ts:290` forwards `columns` when present.
  - `reportDelivery`: `attachment csv uses descriptor`.
  - web `reportExport.ts`: `csv with columns and zero rows downloads header-only` (today it throws at `:73`).
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Forward `result.columns` explicitly at each site; `emailReportRun` does not take the whole result.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(reports): forward result.columns to download, email and browser export (#7324)`.

### Task 7: `GET /custom-fields?orgId`

- [ ] **Step 1: Write the failing tests** in the existing `routes/customFields_list_get.test.ts` (partner cases go in `customFields.partnerWide.test.ts`):
  - `partner caller with orgId → partner-wide + that org's only` (two orgs, same key in org B, not returned for org A);
  - `partner caller with an inaccessible orgId → 403`;
  - `org caller: orgId other than token org → 403`;
  - `no orgId → today's union, unchanged`.
- [ ] **Step 2: Run them and watch them fail.** **Step 3:** Read `query.orgId` in the handler (`:221-290`) using the existing `getOrgIdsForAuth` access check. **Step 4: Run them and watch them pass.** **Step 5: Commit** `fix(api/custom-fields): honour orgId on list (#7324)`.

### Task 8: `export_dataset` columns

- [ ] **Step 1: Write the failing tests** in `services/aiToolsExportDatasets.test.ts`:
  - `human principal: filters.columns forwarded as columns + columnsVersion 2`;
  - `agent principal: agentInventoryPager passes the plan to readDeviceInventoryRows; inArray(devices.id, frame) and allowedSiteIds unchanged`;
  - `no filters.columns → legacy 13 keys` (MCP callers unchanged);
  - `invalid columns → tool error, not a 500`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Validate `filters.columns` with the Task 3 v2 rules; the tool's `filters` is `z.record`, `aiToolSchemas.ts:1652`. Do not introduce `z.undefined()`. Add one sentence to the tool description naming `custom.<fieldKey>` and `query_custom_fields`.
- [ ] **Step 4: Run them and watch them pass**, plus `src/services/aiToolIndex.test.ts` (6.5 KB index cap, 400-char domain notes) and `aiAgentSdkTools.registryParity.contract.test.ts`.
- [ ] **Step 5: Commit** `feat(ai): export_dataset device_inventory accepts columns (#7324)`.

### Task 9: Builder rewrite for Devices

**Interfaces:**
- Produces, in `apps/web/src/components/reports/deviceReportColumns.ts`:
  - `LEGACY_DEVICE_ALIAS_TO_COLUMN: Record<string, DeviceInventoryColumnId | null>`. The entries are `hostname→hostname`, `os→osType`, `status→status`, `site→siteName`, `owner→null`, `serial→serialNumber`, `last_seen→lastSeenAt`, `cpu→null`, `memory→ramTotalMb`, `disk_usage→diskTotalGb` and `patch_level→agentVersion`.
  - `deviceColumnState(config): { mode: 'legacy' } | { mode: 'v2'; columns: string[] }`.
  - `nextDeviceConfig(prev, { columnsTouched: boolean; selection: string[]; bindings })`.

- [ ] **Step 1: Write the failing tests** (`deviceReportColumns.test.ts` and `ReportBuilder.devices.test.tsx`):
  - `legacy report shows "Standard columns (all 13)"`.
  - `rename or schedule edit saves without columnsVersion` (stays legacy).
  - `first column change pre-fills the 13 legacy columns, then switches to v2`.
  - `pre-save summary lists the resulting columns`.
  - `custom fields come from GET /custom-fields?orgId=<target>`.
  - `customColumnBindings records the picked definition id`.
  - `stale (missing) custom column is flagged`.
  - `preview sends deviceFilter, columns and columnsVersion to POST /reports/generate`.
  - `no hostname intersection with useFilterPreview remains` (assert the hook is not called for Devices).
  - `PDF format over 12 columns shows the cap error before save`.
  - `the other four builder types are unchanged`: keep the existing tests green.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - Delete `fieldDefinitionsByType.devices` (`:550`) and the Devices branch of `normalizePreviewRow` (`:642`). The Devices field list comes from `DEVICE_INVENTORY_COLUMNS` plus the org's definitions.
  - Add `reports.reportBuilder.fields.devices.<id>` for every new catalog id to all 8 `reports.json`, translated. Keep the old alias keys while any legacy display mapping reads them, and remove the ones that become unused (`keyUsage.test.ts`).
- [ ] **Step 4: Run them and watch them pass**, plus `src/lib/i18n/*.test.ts`.
- [ ] **Step 5: Commit** `feat(web/reports): catalog-driven Devices columns, legacy-safe v2 switch, persisted filter (#7324)`.

### Task 10: Integration tests and the fetch-strategy plan gate

- [ ] **Step 1: Write** `apps/api/src/services/reports/deviceInventoryCustomColumns.integration.test.ts` (real Postgres, `breeze_app`):
  - `org-A report selecting a partner-wide field returns only org-A values`;
  - `org B's same-key field is never resolved for org A`;
  - `site-restricted authority plus deviceFilter cannot widen`;
  - `scheduled-worker path under system context returns only the report org's values`;
  - `agent-principal export_dataset with columns stays inside its run frame`.
- [ ] **Step 2: Run on the per-worktree test stack.** Run: `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration -- deviceInventoryCustomColumns`. Expected: PASS.
- [ ] **Step 3: Plan gate (R-§4.3).** Seed a 10k-device org with 25 selected fields. Capture `EXPLAIN (ANALYZE, BUFFERS)` under `breeze_app` for the correlated subquery and the aggregate-join alternative, at sparse (5%) and dense (100%) population. Ship the faster one; switching only touches the binding's custom select. **Attach all four plans to the PR body.**
- [ ] **Step 4:** Run `pnpm test-stack down`.
- [ ] **Step 5: Commit** `test(api/reports): custom-column tenancy integration + fetch plan gate (#7324)`.

### Task 11: Wave verification

- [ ] Shared, API and web scoped suites for every file touched → PASS. Typecheck all three with the 12 GB heap, exit codes 0.
- [ ] Playwright: build a Devices report with a custom column plus a `custom.` filter, generate it, download the CSV, and assert the column header and the value.
- [ ] Open the PR, with the release-note line (Global Constraints) and the plan-gate evidence. Run one review round.

---

# Wave 8834-W1: schema, derivation, ingest, recompute, reconcile (F-§5, F-§8)

Branch `feature/<8834-parent#>-form-factor/wave-<sub#>` after 7324-W2 merges (rule: merge order). **High blast radius** (migration on `devices`, concurrency): full TDD, contract suites locally, one review round.

## File structure

| File | Responsibility |
|---|---|
| Create `packages/shared/src/validators/formFactor.ts` (+ test, export from index) | `FORM_FACTORS`, `FORM_FACTOR_RULES_VERSION`, `deriveFormFactor`, chassis table |
| Create `apps/api/migrations/2026-12-31-110000-device-form-factor.sql` | Migration A |
| Create `apps/api/migrations/2026-12-31-111000-device-form-factor-validate.sql` | Migration B |
| Modify `apps/api/src/db/schema/devices.ts` | Drizzle columns |
| Modify `apps/api/src/services/tenantExportPolicyRegistry.ts:385,438` | classifications |
| Create `apps/api/src/services/formFactor.ts` (+ tests) | `normalizeChassisReport`, `recomputeFormFactor` |
| Modify `apps/api/src/routes/agents/{schemas.ts:47-61,943, inventory.ts:70-85, enrollment.ts:928-962, heartbeat.ts:1250-1327,1705}` | ingest + callers |
| Modify `apps/api/src/services/inventoryChildSync.ts:369` | device row lock before the upsert (Q1) |
| Modify `apps/api/src/routes/devices/{schemas.ts:217, core.ts:2244}` | PATCH override and reset |
| Create `apps/api/src/jobs/formFactorReconcileWorker.ts` (+ tests) | reconcile queue/worker |
| Modify `apps/api/src/services/workerRegistry.ts`, `apps/api/src/jobs/workerReadinessManifest.ts` | registration |
| Modify `apps/api/src/routes/devices/helpers.ts:20`, `core.ts:1272,1555` | read surfaces |

### Task 1: `deriveFormFactor` (pure, shared)

**Interfaces — Produces** (consumed by Task 4, the reconcile job and the web basis line in 8834-W2):
```ts
export const FORM_FACTORS = ['laptop','desktop','tablet','server','virtual_machine','other','unknown'] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];
export const FORM_FACTOR_SOURCES = ['auto','manual'] as const;
export const FORM_FACTOR_RULES_VERSION = 1;
export type FormFactorBasis =
  | { kind: 'virtual'; detail: 'isVirtual' | 'apple_guest_model' }
  | { kind: 'chassis' | 'chassis_conflict'; codes: number[] }
  | { kind: 'mac_model'; detail: 'name' | 'identifier' }
  | { kind: 'server_role'; codes?: number[] }
  | { kind: 'none' };
export interface FormFactorInput {
  chassisTypes: readonly number[] | null; osType: string | null; model: string | null;
  modelIdentifier: string | null; isVirtual: boolean; deviceRole: string | null;
}
export function deriveFormFactor(input: FormFactorInput): { formFactor: FormFactor; basis: FormFactorBasis };
export function chassisClass(code: number): Exclude<FormFactor,'virtual_machine'|'unknown'> | null; // null = ignored
```

- [ ] **Step 1: Write the failing table test** (`formFactor.test.ts`), with exact expectations from F-§5.3:
  - **Every code 0–40** maps per the F-§5.3 table. `{1,2,12,18,19,20,21,22,0,37..40}` → `null`.
  - **Unrecognized before recognized:** `[0,10]`, `[255,10]` and `[12,10]` → `laptop`, `chassis`.
  - **Conflicts:** `[3,10]` → `laptop`, `chassis_conflict`; `[23,3]` → `server`, `chassis_conflict`; `[30,10]` → `tablet`.
  - **Server refinement (F-OD-2, inside chassis resolution):** `[7]` + role server → `server`, `server_role`; `[13]` + role server → `desktop`; `[3,10]` + role server → `laptop`, because refinement never overrides a winning laptop or tablet class.
  - **Mac:** name `MacBook Air` + identifier `Mac14,2` → `laptop`, `mac_model`/`name`; name null + `Mac14,2` → `unknown`; name null + `MacBookAir10,1` → `laptop`/`identifier`; name `Mac mini` + identifier `MacBookPro16,1` → `desktop` (name wins); `MacBookPro16,1` alone → `laptop`.
  - **Apple guest:** model `Apple Virtual Machine 1` → `virtual_machine` even with `isVirtual:false`; identifier `VirtualMac2,1` → `virtual_machine`.
  - **`isVirtual: true`** with chassis `[3]` → `virtual_machine`.
  - **No chassis:** role server → `server`, `server_role`. Otherwise → `unknown`, `none`.
  - `FORM_FACTOR_RULES_VERSION === 1`.
- [ ] **Step 2: Run it and watch it fail.** Run: `cd packages/shared && npx vitest run src/validators/formFactor`.
- [ ] **Step 3: Implement.** Use first-match-wins as in F-§5.3. Within the chassis step, take the highest class by precedence `tablet > laptop > server > desktop > other`. Apply the 3/6/7 server-role refinement only when the winning class is `desktop` and a code in {3,6,7} is present.
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit** `feat(shared): deriveFormFactor + chassis table (#8834)`.

### Task 2: Migrations, Drizzle and tenant-export classification

**Migration A**, `2026-12-31-110000-device-form-factor.sql`. It must be idempotent, contain no `BEGIN/COMMIT`, and write no rows.
1. Add two columns to `device_hardware`, both `ADD COLUMN IF NOT EXISTS`: `chassis_types smallint[]` and `model_identifier varchar(64)`.
2. Add three columns to `devices`:
   - `form_factor varchar(20) NOT NULL DEFAULT 'unknown'`;
   - `form_factor_source varchar(10) NOT NULL DEFAULT 'auto'`;
   - `form_factor_rules_version smallint`.
3. Add two CHECK constraints, `NOT VALID`, each inside a `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)` guard:
   - `devices_form_factor_chk CHECK (form_factor IN (<FORM_FACTORS>))`;
   - `devices_form_factor_source_chk CHECK (form_factor_source IN ('auto','manual'))`.
4. Run `CREATE OR REPLACE FUNCTION breeze_partner_export_devices_update` (Cross-plan rule 1).
   - Copy it from `2026-07-18-partner-export-org-locks.sql:310`, re-grepped at implementation time.
   - Add `form_factor` to **all six** `ROW(...)` tuples. **Do not** add `form_factor_source` or `form_factor_rules_version`.
   - Keep every other line verbatim.
5. Run `CREATE OR REPLACE FUNCTION breeze_partner_export_device_child_update`, copied verbatim from the newest definition (`2026-11-01-110000-device-memory-modules.sql:105`, excluded map at `:117`). Re-grep it first.
   - Add `chassis_types` and `model_identifier` to the `device_hardware` excluded array.
   - Preserve the owner validation, the other exclusions and the lock-on-change order.

**Migration B**, `2026-12-31-111000-device-form-factor-validate.sql`: `ALTER TABLE devices VALIDATE CONSTRAINT …` for both checks. This takes `SHARE UPDATE EXCLUSIVE`.

**Tenant export.** Both tables are already org-cascaded, merged and RLS'd (F-§8), so only `CORE_TENANT_EXPORT_POLICY` changes. These are the entries to add:

| Table | Column | List |
|---|---|---|
| `device_hardware` | `chassis_types` | `included` |
| `device_hardware` | `model_identifier` | `included` |
| `devices` | `form_factor` | `included` |
| `devices` | `form_factor_source` | `included` |
| `devices` | `form_factor_rules_version` | `included` |

`chassis_types` is a typed array, so it is not `excludedOpen`. No jsonb is added.

**Drizzle**, in `schema/devices.ts`:
- `chassisTypes: smallint('chassis_types').array()`;
- `modelIdentifier: varchar('model_identifier', { length: 64 })`;
- `formFactor: varchar('form_factor', { length: 20 }).notNull().default('unknown').$type<FormFactor>()`;
- `formFactorSource: varchar('form_factor_source', { length: 10 }).notNull().default('auto').$type<'auto'|'manual'>()`;
- `formFactorRulesVersion: smallint('form_factor_rules_version')`.

- [ ] **Step 1: Write the failing assertions.**
  - Extend `apps/api/src/services/tenantExportPolicy*.test.ts` / `tenantExportPolicyRegistry.*.test.ts` so that every new column is classified.
  - Write a migration-shape unit test, `apps/api/src/db/migrations.formFactor.test.ts`. It reads Migration A and asserts:
    - the devices_update body has exactly 6 `ROW(` tuples, and each contains `form_factor` as a whole token (`/\bform_factor\b(?!_)/`; a plain substring match would also hit `form_factor_source` and `form_factor_rules_version`);
    - `form_factor_source` and `form_factor_rules_version` appear in none of them;
    - the child excluded array contains `chassis_types` and `model_identifier`;
    - there is no `BEGIN;`/`COMMIT;`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Write the migrations, Drizzle and registry entries.** Run `scripts/check-migration-naming.sh`, then `pnpm db:migrate` on the test stack twice (idempotency), then `pnpm db:check-drift`. Expected: clean.
- [ ] **Step 4: Run them and watch them pass.** Also run `src/db/migrationRlsScope.test.ts` and `src/db/migrationPartnerExportLocks.test.ts`.
- [ ] **Step 5: Commit** `feat(db): device form factor columns + partner-export trigger replays (#8834)`.

### Task 3: Ingest and normalization

**Interfaces:**
- Produces, in `services/formFactor.ts`: `normalizeChassisReport(input: { chassisTypes?: number[] | null; chassisType?: string }): number[] | undefined`. The return is `undefined` when the stored value should be left untouched, and `[]` when it should clear.
- Schema additions, in **both** `updateHardwareSchema` (`schemas.ts:943`) and the enrollment `hardwareInfo` (`:47-61`): the three F-§5.1 keys, each with `.catch(undefined)`.

- [ ] **Step 1: Write the failing tests** (`services/formFactor.normalize.test.ts`, `routes/agents/inventory.test.ts`, `routes/agents/enrollment.test.ts`):
  - **Normalization:** `[10,12]` → `[10,12]`; `null` → `undefined`; `chassisType: "10"` → `[10]`; `"{3, 10}"` → `[3,10]`; `"10garbage"` → `undefined`; `"1000"` → `undefined`; `"300"` → `undefined` (above 255); `[]` → `[]`.
  - **Schema:** garbage `chassisTypes: "x"` → no 400, and the rest of the hardware saves; a 17-element array is discarded.
  - **Hardware PUT:** `null keeps the stored value` (the key is absent from the upsert `set`); `[] clears to '{}'`; `modelIdentifier persists`; the legacy `chassisType` key is never spread into the upsert.
  - **Enrollment:** `persists chassis_types and model_identifier on insert and on conflict update` (`enrollment.ts:928-962` writes both branches).
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - In `inventory.ts:70`, destructure `{ memory, chassisType, chassisTypes, modelIdentifier, ...hardware }`, normalize, and pass the result into `HardwareReportColumns`. When normalization returns `undefined`, omit the key.
  - Do the same in enrollment.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(api/agents): ingest chassis codes and model identifier (#8834)`.

### Task 4: `recomputeFormFactor` and its callers

**Interfaces:**
```ts
// services/formFactor.ts
export async function recomputeFormFactor(tx: DbTx, deviceId: string, opts?: { rulesVersion?: number; derive?: typeof deriveFormFactor }):
  Promise<{ formFactor: FormFactor; valueChanged: boolean; stamped: boolean; source: 'auto' | 'manual' }>;
export function notifyFormFactorChanged(device: { id: string; orgId: string }, reason: string): void; // after-commit
```
`opts` exists for the stale-caller test only. Production passes nothing.

**Protocol (F-§5.4 + Q1 + Q3):**
1. `SELECT id, org_id, form_factor, form_factor_source, form_factor_rules_version, os_type, is_virtual, device_role FROM devices WHERE id = $1 FOR UPDATE`.
2. Read `device_hardware.{chassis_types, model, model_identifier}`.
3. If the source is `manual`, return the stored value with `{ valueChanged: false, stamped: false }`.
4. Otherwise run `UPDATE devices SET form_factor=$v, form_factor_rules_version=$ver WHERE id=$1 AND form_factor_source='auto' AND (form_factor_rules_version IS NULL OR form_factor_rules_version <= $ver) AND (form_factor IS DISTINCT FROM $v OR form_factor_rules_version IS DISTINCT FROM $ver)`.
5. `valueChanged` = the update applied and the locked prior value ≠ `$v`.
6. `notifyFormFactorChanged` uses `requestDeviceGroupReevaluationAfterCommit` (`deviceGroupJobs.ts:292`) with `{ eventType: 'device.updated', reason, changedFields: ['formFactor'] }`. It is called **only** when `valueChanged`.

**Callers:**
- **Hardware PUT:**
  - `writeHardwareReport` (`inventoryChildSync.ts:369`) first runs `SELECT 1 FROM devices WHERE id=$1 FOR UPDATE` (Q1 order), then the upsert.
  - `inventory.ts` calls `recomputeFormFactor` in the same transaction whenever, after normalization, the `chassisTypes`, `modelIdentifier` or `model` key is present. `model` is in nearly every report, so this is about one recompute per device per day. That is accepted (F-§11: one `devices` row lock per device per day). The predicate makes a no-change recompute a no-op write.
  - It calls `notifyFormFactorChanged(..., 'hardware_report')`.
- **Enrollment:** recompute in the enrollment transaction after both rows exist, with reason `enrollment`.
- **Heartbeat:**
  - `roleChanged` = the existing auto-apply branch (`:1250-1264`) actually set `deviceUpdates.deviceRole`.
  - `virtualChanged` = `data.isVirtual !== undefined && data.isVirtual !== device.isVirtual` (Q5).
  - If either is true, call `recomputeFormFactor` after the `devices` update in the same transaction.
  - `filterableChangedFields` (`:1705`) keeps the existing presence list. It adds `'isVirtual'` only when `virtualChanged`, and `'formFactor'` only when `valueChanged`.
- **PATCH** (`routes/devices/schemas.ts:217`):
  - Add `formFactor: z.enum(FORM_FACTORS).nullable().optional()`.
  - In `core.ts` (near `:2244`), a value sets the value, `source='manual'` and `rules_version=NULL`.
  - `null` sets `source='auto'`, then calls `recomputeFormFactor`.
  - It uses the same permission as the role edit. The audit details carry `{ before: { formFactor, formFactorSource }, after: {...} }`.
  - It calls `notifyFormFactorChanged` when the effective value changed.
  - A `deviceRole` PATCH also recomputes.

- [ ] **Step 1: Write the failing tests** (`services/formFactor.recompute.test.ts` plus the route tests):
  - `writes only when source is auto`;
  - `a pinned value is never overwritten, even by a stale caller` (call with a pre-read snapshot after a manual PATCH; the SQL predicate holds);
  - `a stale-rules caller never downgrades a newer stamp` (Review Focus 2): row stamped v2, call with `rulesVersion: 1` → no write;
  - `version-only change stamps without notifying`;
  - `value change notifies after commit, not on rollback` (mock `runAfterDbContextCommit`; throw after recompute → no enqueue);
  - **PATCH:** `value → manual, rules_version null, audit before/after`; `null → auto + recompute`;
  - **Heartbeat:** `recomputes on accepted role change`; `recomputes on isVirtual flip`; `unchanged isVirtual on every beat enqueues nothing` (Review Focus 3); `isVirtual flip notifies even when form factor is pinned`; `privileged role flip blocked → no recompute`;
  - **Hardware PUT:** `locks devices before the device_hardware upsert` (assert statement order on the mock tx).
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass.** Also run the existing `routes/agents/heartbeat*.test.ts`, `inventory*.test.ts`, `enrollment*.test.ts` and `routes/devices/core*.test.ts`.
- [ ] **Step 5: Commit** `feat(api): form factor recompute protocol + override/reset (#8834)`.

### Task 5: Reconcile job

**Interfaces:**
```ts
// jobs/formFactorReconcileWorker.ts
export const FORM_FACTOR_RECONCILE_QUEUE = 'form-factor-reconcile';
export function formFactorReconcileJobId(version = FORM_FACTOR_RULES_VERSION): string; // bullmqJobId('form-factor-reconcile', `v${version}`) === 'form-factor-reconcile-v1'
export async function enqueueFormFactorReconcile(trigger: 'boot' | 'manual'): Promise<{ id: string }>; // enqueueOrReplaceStale
export async function runFormFactorReconcile(opts?: { chunkSize?: number }): Promise<{ scanned: number; changed: number; failed: number; notifyFailed: number }>;
export async function initializeFormFactorReconcileWorker(): Promise<void>; // also enqueues 'boot'
export async function shutdownFormFactorReconcileWorker(): Promise<void>;
```

**Algorithm (Q1–Q4):**
1. In a loop, read the next ≤500 candidates **outside any transaction**: `runOutsideDbContext(() => withSystemDbAccessContext(() => SELECT id, org_id FROM devices WHERE form_factor_source='auto' AND (form_factor_rules_version IS NULL OR form_factor_rules_version < $current) AND (org_id, id) > ($lastOrg, $lastId) ORDER BY org_id, id LIMIT 500))`.
2. For each candidate, open its **own** context: `runOutsideDbContext(() => withSystemDbAccessContext((tx) => recomputeFormFactor(tx, id)))`. `withSystemDbAccessContext` *is* the top-level transaction (`db/index.ts:894-925`), so a `db.transaction` inside it would only be a savepoint. No context may wrap the loop. Retry `40P01`/`40001` up to 3 times with 50–250 ms jitter. Count a remaining failure in `failed` and continue.
3. Notifications: the reconcile job does **not** use the after-commit hook, because `requestDeviceGroupReevaluationAfterCommit` returns `void` (`deviceGroupJobs.ts:292`).
   - After each per-device context has returned, and only when `valueChanged`, the job `await`s `requestDeviceGroupReevaluation({ deviceId, orgId, eventType: 'device.updated', reason: 'form_factor_reconcile', changedFields: ['formFactor'] })` (`:246`).
   - It collects the ids whose call returned `null`, retries them once at the end of the run, and reports the remainder as `notifyFailed` (Q4).
4. Log `[formFactorReconcile] { scanned, changed, failed, notifyFailed }`.

Day-one effect (F-§5.8): VMs and Macs classify, everything else stamps `unknown` at v1, and there is no Windows/Linux model-string guessing.

The worker is `concurrency: 1`. The boot enqueue uses `{ attempts: 3, backoff: exponential 60s, removeOnComplete: {count: 10}, removeOnFail: {count: 25}, delay: 60_000 }`, copying `aiModelDiscoveryWorker.ts:190`.

- [ ] **Step 1: Write the failing tests** (`jobs/formFactorReconcileWorker.test.ts`):
  - `second run changes 0`;
  - `rule-version bump re-derives auto rows, leaves manual rows`;
  - `each device gets its own system context` (assert `withSystemDbAccessContext` is entered once per candidate, the candidate read runs in a separate context, and no context is active around the loop; spy on the db-context helpers, not on `db.transaction`);
  - `deadlock 40P01 retried then counted as failed`;
  - `a stale completed boot job is replaced, not absorbed` (`enqueueOrReplaceStale` path);
  - `jobId carries the rules version and no colon` (`=== 'form-factor-reconcile-v1'`; `bullmqUtils.noColonJobIds.test.ts` stays green);
  - `null notify is retried once and reported as notifyFailed`;
  - `selection never matches a newer stamp` (row stamped v2, current v1 → not scanned).
  - Readiness and closure: add `consumers('formFactorReconcileWorker')` to `WORKER_READINESS_MANIFEST` and a `{ name: 'formFactorReconcileWorker', placement: 'global', load }` entry to `WORKER_REGISTRY` (`services/workerRegistry.ts`, after `aiModelDiscoveryWorker` at `:1845`). Then `jobs/workerReadinessManifest.test.ts`, `jobs/workerReadinessCoverage.test.ts`, `src/worker.boot.test.ts` and `services/workerEntrypointClosure.contract.test.ts` must pass. The closure must not reach `routes/agentWs.ts` or `services/agentCommandAwait.ts`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(jobs): versioned form factor reconcile worker (#8834)`.

### Task 6: API read surfaces

- [ ] **Step 1: Write the failing tests.**
  - `PUBLIC_DEVICE_FIELDS includes formFactor, formFactorSource, formFactorRulesVersion` (`helpers.ts:20`, `satisfies` keeps it typed).
  - `device list rows carry formFactor and formFactorSource`: add them to the select (`core.ts:~1272`) **and** the mapper (`:~1555`), because a field missing from either is silently dropped.
  - `device detail hardware exposes chassisTypes and modelIdentifier` (`select *` at `:1630` already carries them; assert it).
- [ ] **Step 2: Run them and watch them fail.** **Step 3: Implement.** **Step 4: Run them and watch them pass.** **Step 5: Commit** `feat(api/devices): expose form factor on device reads (#8834)`.

### Task 7: Contract suites and concurrency on a real stack

- [ ] **Step 1: Write** `apps/api/src/services/formFactor.integration.test.ts` (two real connections):
  - `manual PATCH racing hardware PUT: pinned value survives`;
  - `reset racing reconcile: ends auto at current version`;
  - `two devices in one org: reconcile vs heartbeat on device B does not deadlock` (Q1);
  - `form-factor change advances partner_export_updated_at; chassis-only, source-only and rules-version-only changes do not`.
- [ ] **Step 2: Run on the test stack.** Run `pnpm test-stack up` (subnet per Global Constraints), then `pnpm --filter @breeze/api test:integration -- formFactor tenant-export-policy tenantExportErasureRoundtrip partnerExport`, then `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Expected: PASS. Record the counts in the PR.
- [ ] **Step 3:** Run `pnpm test-stack down` and state it in the PR.
- [ ] **Step 4: Commit** `test(api): form factor concurrency + partner-export integration (#8834)`.
- [ ] **Step 5:** Typecheck api and shared (12 GB, exit 0). Open the PR with the self-host note. Run one review round.

---

# Wave 8834-W2: filter, list column, Info tab, reports, AI, Partner API (F-§5.7, F-§6, F-§7)

Branch after 8834-W1 merges. This is the first wave that consumes the 7324 contracts.

### Task 1: Filter fields

- [ ] **Step 1: Write the failing tests:**
  - **filterEngine:** `formFactor equals/in/notIn SQL on devices.form_factor`; `isVirtual equals true/false`; `formFactor is execution-refused` (F-D9, added to `EXECUTION_REFUSED_AGENT_FIELDS` at `filterEngine.ts:249`); `isVirtual is allowed` (F-OD-6); the tier comment block (`:176-230`) gains both lines.
  - **Web parity:** `filterFields.apiParity.test.ts` and `executionRefusedFields.test.ts` fail until `apps/web/src/components/filters/filterFields.ts` and `apps/web/src/lib/executionRefusedFields.ts` gain the same entries.
- [ ] **Step 2: Run them and watch them fail.** **Step 3: Implement** in the API and both web mirrors. **Step 4: Run them and watch them pass.** **Step 5: Commit** `feat(filters): formFactor (execution-refused) and isVirtual filter fields (#8834)`.

### Task 2: Web: labels, list column, Info tab

**Interfaces:**
- Produces, in `apps/web/src/lib/formFactors.ts`:
  - `formFactorLabelKey(f: FormFactor): string`;
  - `formFactorBasisText(t, device): string | null`. It returns null when `formFactorRulesVersion !== FORM_FACTOR_RULES_VERSION` or the source is manual, and recomputes via the shared `deriveFormFactor`.

- [ ] **Step 1: Write the failing tests.**
  - **List column:**
    - `formFactor is a ColumnId and not in DEFAULT_VISIBLE_COLUMNS` (F-OD-10);
    - `export binding exports the machine value; null for network/manual rows`. The 7324-W1 `every ColumnId has an export binding` test fails until it is added.
    - `sortValue handles formFactor`.
  - **Info tab:**
    - `shows value and Auto/Manual badge`;
    - `basis line for current-version auto values` (e.g. "Chassis type 10 (Notebook)", "Conflicting chassis codes 3, 10");
    - `no basis line when versions differ`;
    - `Edit PATCHes { formFactor } through runAction`;
    - `Reset to automatic PATCHes { formFactor: null } through runAction`;
    - testids `device-form-factor-value`, `device-form-factor-edit`, `device-form-factor-reset`.
  - **Guards:** `no-silent-mutations.test.ts` stays green (`DeviceInfoTab.tsx` is in `TARGET_GLOBS`). Locale keys exist in all 8 locales.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Touch `columnVisibility.ts` (`COLUMN_IDS`, `COLUMN_LABELS`), `DeviceList.tsx` (`Device` type, `columnDefs`, `sortValue`) and `deviceListColumnExport.ts`. In `DeviceInfoTab.tsx`, add the row beside Device Role (`:949-1037`).
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(web/devices): form factor column, Info tab row, override and reset (#8834)`.

### Task 3: Reports

- [ ] **Step 1: Write the failing tests.**
  - **Shared catalog:** `formFactor is a catalog id, defaultSelected false, not in LEGACY_DEVICE_INVENTORY_COLUMNS` (Q8/P4).
  - **API binding:** `DEVICE_INVENTORY_COLUMN_BINDINGS.formFactor` exists; `manualAsset → null`. The exhaustive `Record` fails typecheck until it is added.
  - **Generator:** `v2 columns ['hostname','formFactor'] emit formFactor`; `legacy config emits exactly the 13 keys` (the 7324-W2 fixture is unchanged).
  - **export_dataset:** `filters.columns: ['formFactor'] returns it for both principals`; `no columns → no formFactor key` (this replaces F-§7's "picks it up through the shared row type", see Q8/P4).
  - **hardware_lifecycle:**
    - `Subject` and `HardwareLifecycleDeviceRow` carry `formFactor`;
    - `form_factor = 'virtual_machine' devices are excluded` alongside `is_virtual = false` (`hardwareLifecycleReport.ts:174`);
    - the summary gains a count-by-form-factor breakdown;
    - the curated PDF (`hardwareLifecyclePdf.ts:406`) renders a Form factor column.
  - **Builder:** label key `reports.reportBuilder.fields.devices.formFactor` in all 8 locales.
- [ ] **Step 2: Run them and watch them fail.** **Step 3: Implement.** **Step 4: Run them and watch them pass**, plus `reportGenerationService*`, `hardwareLifecycleReport*` and `reportPdf` tests.
- [ ] **Step 5: Commit** `feat(reports): form factor in Devices catalog and hardware lifecycle (#8834)`.

### Task 4: AI and Partner API

- [ ] **Step 1: Write the failing tests:**
  - **`query_devices`:**
    - `formFactor` enum filter in all three schemas: `aiToolSchemas.ts:205` (zod enum, never `z.undefined()`), the JSON `input_schema` in `aiToolsDevice.ts:167`, and the SDK tool `aiAgentSdkTools.ts:1712`;
    - the handler applies the condition, and the summary row carries `formFactor`;
    - `aiAgentSdkTools.registryParity.contract.test.ts`, `aiToolsDeviceScope.contract.test.ts` and `aiToolIndex.test.ts` (6.5 KB cap) pass;
    - if `aiToolsDevice.ts` lines shift, re-key the line-keyed `SAFE_WRITE_SITES` in `aiTools.userOwnedRelease.contract.test.ts:145`.
  - **MCP:** `SAFE_DEVICE_RESOURCE_FIELDS` (`mcpServer.ts:2550`) gains `formFactor` and `formFactorSource`.
  - **Partner API:**
    - `type.formFactor` is present and parses. Add `formFactor: devices.formFactor` to the explicit select and `normalizeSourceRow` (`routes/partnerApi/devices.ts:61-90`), as well as the DTO (`:113`). The result parses under the **strict** `partnerDeviceExportRecordSchema.type` (`schemas.ts:144-149`);
    - `form_factor_source` is not published;
    - there is no new query filter (F-OD-9).
- [ ] **Step 2: Run them and watch them fail.** **Step 3: Implement.** **Step 4: Run them and watch them pass.** **Step 5: Commit** `feat(ai,partner-api): form factor on query_devices, MCP resources, Partner API (#8834)`.

### Task 5: Wave verification

- [ ] Run the scoped web and API suites for every touched file, plus `src/lib/i18n/*.test.ts` and `routeScope.test.ts` (this wave adds no page, so it should be unchanged).
- [ ] Typecheck web, api and shared (12 GB, exit 0).
- [ ] Playwright: set a device's form factor manually, filter the list by it, show the column, export, and assert the cell. Then reset it to automatic.
- [ ] Open the PR and run one review round.

---

# Wave 8834-W3: Go agent collector (F-§4) — agent-shipped, full rigor

Branch after 8834-W2 merges. It is wire-independent (F-§4.4), so it is safe against any API version. Write a table-driven `go test`. Mock Windows CIM through the fixture-JSON decode path, without shelling out in tests.

### Task 1: Windows: CIM `Win32_SystemEnclosure`, drop `wmic`

**Interfaces:**
- `HardwareInfo` (`agent/internal/collectors/hardware.go:15-30`) gains `ChassisTypes []int \`json:"chassisTypes"\`` (**no** `omitempty`) and `ModelIdentifier string \`json:"modelIdentifier,omitempty"\``.
- `ChassisType string` stays as the first code (F-D5).
- `intList` is a `[]int` with `UnmarshalJSON` accepting an array, a scalar number, `null` or `""`. A malformed value yields a `nil` slice and never an error that aborts the batch. It lives in `hardware_wmi_parse.go` as the twin of `gpuNameList` (`:16`).

- [ ] **Step 1: Write the failing tests** (create `hardware_wmi_parse_test.go`; extend `hardware_test.go`):
  - **`intList` decode table:** `9` → `[9]`; `[10,12]` → `[10,12]`; `null` → `nil`; `""` → `nil`; `"garbage"` → `nil` and the decode does not fail.
  - `windows batch fixture with ChassisTypes: serial and model still populate; ChassisType == "10"`.
  - `windows batch fixture without ChassisTypes: ChassisTypes nil, other fields populate`.
  - `marshal: nil → "chassisTypes":null; []int{} → "chassisTypes":[]`.
- [ ] **Step 2: Run them and watch them fail.** Run: `cd agent && go test ./internal/collectors/ -run 'IntList|WindowsHardware|Marshal'`.
- [ ] **Step 3: Implement.**
  - Add the F-§4.1 `ChassisTypes = @(...)` line to the batched script (`hardware_windows.go:86-120`) using `Get-WmiSafe 'Win32_SystemEnclosure'`, and add the field to `windowsHardwareJSON` (`hardware_wmi_parse.go:44`).
  - In `collectPlatformHardware`, set `hw.ChassisTypes` and `hw.ChassisType = strconv.Itoa(ChassisTypes[0])` when the slice is non-empty.
  - Replace the body of the Windows `getChassisType()` in `classify_windows.go:11` with `return ""`. This removes the `wmic` exec while keeping the per-platform function, which `hardware.go:238` calls unconditionally. Deleting the definition would break the Windows build.
  - Keep `hw.ChassisType = getChassisType()` (`hardware.go:238`) **before** `collectPlatformHardware(hw)`. `collectPlatformHardware` overwrites it only when `ChassisTypes` is non-empty. On Windows the empty generic value is replaced; on Linux and macOS it stands.
  - Add the test `windows getChassisType no longer spawns wmic` (assert the function returns `""` without an exec; the build tag keeps it Windows-only).
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** `feat(agent): Windows chassis via batched CIM, all codes, no wmic (#8834)`.

### Task 2: Linux and macOS

- [ ] **Step 1: Write the failing tests:**
  - **Linux:** `chassis_type "10" → ChassisTypes [10]`; `missing file → []` (not nil); `"300" → nil` (out of range = not collected).
  - **macOS** (new `hardware_darwin_test.go` with `SPHardwareDataType` JSON fixtures):
    - MacBook Air M2 (`MacBook Air` / `Mac14,2`), Mac mini M2, `MacBookAir10,1` and Intel `MacBookPro16,1`: `ModelIdentifier` is parsed from `machine_model`, `Model` stays the marketing name and `ChassisTypes == []`;
    - an empty `machine_model` falls back to `sysctl hw.model` (inject the runner);
    - the tart VM fixture uses the model strings recorded during the lab step. Until then, use a placeholder fixture `Apple Virtual Machine 1` / `VirtualMac2,1`, marked to update.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - **Linux:** add `collectChassisTypes() []int` in `classify_linux.go`. It reads `/sys/class/dmi/id/chassis_type` and returns `[]int{}` on `os.IsNotExist`, `nil` on any other read error or an unparseable or out-of-range (0–255) value, and `[]int{n}` otherwise. The Linux `collectPlatformHardware` path sets `hw.ChassisTypes`. `getChassisType()` is unchanged (legacy string, F-D5).
  - **macOS:** add a new `MachineModel string \`json:"machine_model"\`` on `spHardwareEntry` (`hardware_darwin.go:11-25`), fill `hw.ModelIdentifier` from it, and set `hw.ChassisTypes = []int{}`. **Step 4: Run them and watch them pass.** **Step 5: Commit** `feat(agent): Linux chassis slice, macOS model identifier (#8834)`.

### Task 3: Enrollment payload

- [ ] **Step 1: Write the failing test:** `enrollment HardwareInfo carries chassisTypes and modelIdentifier` (`agent/pkg/api/client.go:56` struct marshal; `internal/agentapp/main.go:1827-1841` copy).
- [ ] **Step 2: Run it and watch it fail.** **Step 3: Implement.** **Step 4: Run it and watch it pass.** **Step 5: Commit** `feat(agent): send chassis codes and model identifier at enrollment (#8834)`.

### Task 4: Role regression, cross-compiles, lab

- [ ] **Step 1: Write and run the tests.** In `classify_test.go`, every existing `ClassifyDeviceRole` case must stay unchanged. Pin `[12,23]` behaviour: the first code is `12` and the role is unchanged. Pin `a rack chassis on a client OS now reports server` (F-§4.5; the API blocks and audits the flip, `heartbeat.ts:1250-1264`).
- [ ] **Step 2: Run the full agent checks.** Run: `cd agent && go test -race ./...`, then `GOOS=windows go build ./...`, `GOOS=darwin go build ./...` and `GOOS=linux go build ./...`. Expected: PASS, and all three builds succeed.
- [ ] **Step 3: Lab verification (required before merge, F-§10).** Cover these devices:
  - a Windows 11 24H2 laptop with `wmic` absent;
  - a desktop;
  - the Hyper-V lab VM (expect `virtual_machine`);
  - a Linux laptop or desktop;
  - an Apple Silicon MacBook;
  - the Sequoia tart VM (#8390 recipe);
  - an **old agent against the new API**.

  For each, record raw `chassis_types` / `model_identifier`, the derived value and basis, and a filter and dynamic-group hit. Put the table in the PR, using generic device descriptions and no hostnames or IPs. Then update the tart fixture from Task 2.
- [ ] **Step 4:** Open the PR. The agent release-notes line says that a rack chassis on a client OS may now self-report `server`, and that the API blocks and audits it. Run one review round.
- [ ] **Step 5: Rollout note.** This reaches devices only after an agent release **and fleet promote** (the `release` skill: a tag alone does not update agents).

---

## Follow-ups to file (orchestrator, not part of these waves)

- macOS-guest virtualization-axis repair (`apple` platform, marker before the Hyper-V needle) — F-OD-7 (b).
- PATCH-path dynamic-group re-evaluation for `deviceRole`, `tags` and custom fields, plus a periodic re-evaluation sweep (F-§9, Q4).
- Device-list custom columns that share a `fieldKey` across orgs render twice under "All organizations"; this is pre-existing and the export mirrors it.
- Battery as evidence (F-OD-4 (c)), only if 24H2+ Windows `unknown`s stay common after 8834-W3.
- `hardware_lifecycle` CSV-only custom columns (R-D6 (b)), if asked.
- Unify the list and report catalogs into `DEVICE_FIELD_CATALOG` after #8835 and #8836 land (R-D7).
- Builder simple `filterConditions` remain preview-only (R-§7).

## Self-review record

- **Spec coverage:**
  - Every R-§4/§5 requirement maps to 7324-W1 T1–T4 or 7324-W2 T1–T10.
  - Every F-§4–§8 requirement maps to 8834-W1 T1–T7, 8834-W2 T1–T4 or 8834-W3 T1–T4.
  - F-§10 lab items are in 8834-W3 T4.
  - **Intentional deviations, each with a Q number:** reconcile transaction granularity and lock primitive (Q1, Q2); `formFactor` absent from legacy and default `export_dataset` output (Q8/P4); a report-sized filter timeout (Q9).
- **Type consistency:** these names are used identically everywhere they appear: `DeviceListColumnExport`, `DEVICE_LIST_COLUMN_EXPORT`, `DeviceInventoryColumnId`, `DEVICE_INVENTORY_COLUMN_BINDINGS`, `ReportColumnDescriptor`, `deriveFormFactor`, `recomputeFormFactor`, `FORM_FACTOR_RULES_VERSION`.
