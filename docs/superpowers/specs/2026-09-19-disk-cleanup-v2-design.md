---
tracking_issue: LanternOps/breeze#6326
---
# Disk Cleanup v2 — Correctness, Multi-Volume, Finished UI, OS-Native Cleaners

- **Date:** 2026-09-19
- **Status:** Approved design (Todd, 2026-09-19); advisor quorum recorded in §13
- **Branch:** `spec/disk-cleanup-v2`
- **Supersedes:** nothing. The 2026-06-15 winapp2 spec (`2026-06-15-disk-cleanup-winapp2-design.md`) was approved but never implemented and has no tracking issue; it stays parked. This spec does not preclude it — §6's rule table is the seam a future ruleset would replace.
- **Tracking issue:** LanternOps/breeze#6326 (waves #6327–#6331); plan index `docs/superpowers/plans/devices/2026-09-19-disk-cleanup-v2.md`

## 1. Product intent

Breeze already ships "Filesystem Analysis & Disk Cleanup" (agent scanner → snapshot → preview → execute). A 2026-09-19 code review found it does not do the one thing a disk cleanup tool must do — free disk space — and that its UI stops at the preview. This spec:

1. **Fixes every verified defect** in the existing engine (§3) so the tool is trustworthy.
2. **Adds multi-volume support** — scan and clean any fixed local volume (`D:\`, `/data`), not only the OS root, without one volume's state clobbering another's.
3. **Finishes the UI** — select → execute → result inside the Disk Cleanup tab, one home for the concept.
4. **Adds OS-native cleaners** — a fixed, vetted catalog of platform maintenance actions (Windows `cleanmgr` handlers and DISM component cleanup, macOS local snapshots and Homebrew, Linux package caches and journal) that reclaim space the file scanner structurally cannot see.

Approach chosen: **two engines, one surface**. The itemized file engine and the opaque native-action engine stay separate command types with separate safety models, feed the same tab, and record into the same run table. Rejected: a single winapp2-style rules engine (native handlers cannot produce itemized previews, so the abstraction leaks and delays every fix), and "fix and bolt on" (leaves the per-device scan-state clobber).

### Out of scope

- Scheduled / policy-driven cleanup, fleet fan-out (needs the snapshot-first model to change; separate spec).
- winapp2 ruleset engine and registry cleaning (parked spec).
- App uninstall / leftover removal.
- Docker prune, Windows `/ResetBase`, Storage Sense configuration, `snap` revision pruning (deferred; listed so nobody adds them ad hoc).

## 2. Current state (verified 2026-09-19 against `main` e4525ea7e8)

Line numbers are for orientation; the plan re-verifies before editing.

| # | Defect | Where | Effect |
|---|---|---|---|
| 1 | cleanup-execute dispatches `file_delete` as `{ path, recursive: true }` with no `permanent` | `apps/api/src/routes/devices/filesystem.ts:400-405`; agent default is trash-move `fileops.go:606,728` | Files are *moved* to `~/.breeze-trash` on the same volume for 30 days. Zero bytes freed; cross-volume falls back to copy+remove, so cleaning `D:\` grows `C:\`. `bytesReclaimed` sums snapshot sizes regardless. |
| 2 | Only trash path on Windows is the literal `C:\$Recycle.Bin` | `filesystem_analysis.go:1164` | Other volumes' bins never detected. The `C:` candidate is depth 1 so `isRecursiveDeleteBoundary` refuses it (`fileops_delete_boundary.go:96-100`) — Windows bin reclaim is dead on arrival. |
| 3 | `Safe: true` hardcoded; classifier is substring-on-profile-root | `filesystem_analysis.go:426, 1000-1025` | `/google/chrome/user data/` and `/mozilla/firefox/` mark Bookmarks, History, Cookies, extensions as `browser_cache`. `/appdata/local/packages/` (UWP `LocalState`) labelled `package_cache`. No age threshold on `temp_files`. |
| 4 | Tab has preview only; execute lives in File Manager, which omits `cleanupRunId` | `DeviceFilesystemTab.tsx:466-496`; `FileManager.tsx:1009-1011` | Dead-end tab; File Manager re-derives candidates from whatever snapshot is newest (the race the API's pinning exists to prevent). Partial failure renders in a green box; all-fail returns 500 with no `error`. |
| 5 | AI lane stores an empty snapshot on unparseable stdout | `aiToolsFilesystem.ts:185-186` vs guarded agent lane `agents/helpers.ts:1608-1615` | A blank snapshot becomes "latest" and zeroes later previews. |
| 6 | Scan state keyed per device; snapshots don't record path; root check is `=== 'C:\\'` | `schema/filesystem.ts:62`; `filesystem.ts:95-98,178`; `helpers.ts:1620-1677` | A `D:\` scan resets `C:\` baseline, pollutes `hotDirectories`, and becomes the "latest" snapshot a `C:\` preview deletes from. `c:\` (lower case) never auto-resumes its checkpoint. |
| 7 | `addDuplicateCandidate` unbounded; `addCleanupCandidate` caps by insertion order | `filesystem_analysis.go:1076-1094, 1121-1124` | Memory growth on 10M-file scans; a late 40 GB candidate can't displace a 1 KB one while the UI presents "biggest wins". |
| 8 | Disk-percent delta compares different disks | `filesystem.ts:80-88` (max `usedPercent`) vs `helpers.ts:1622-1628` (arbitrary row) | Spurious full baselines on multi-disk devices. |
| 9 | Web: poll loop survives unmount; bare `fetchWithAuth` (on the `runActionAllowlist` backlog); `t` missing from hook deps; no `role=alert`; `BE-1:` ticket label in UI; no tests | `DeviceFilesystemTab.tsx:352-404, 416, 470, 550, 606-625` | Leaks, silent failures, unlocalised fallbacks, internal jargon. |
| 10 | Non-candidate paths silently dropped on execute; sequential deletes with no wall-clock cap; preview rows never pruned; response shapes drift | `filesystem.ts:386-390, 399-418, 292-305, 459-469` | Opaque partial execution; 200 × 30 s worst case; unbounded table. |

What already exists and is reused: `device_disks` (`mountPoint, fsType, totalGb, usedGb, freeGb, usedPercent`) via `GET /devices/:id/disks`; the async scan pattern (`queueCommandForExecution` + client poll); `requireMfa` + `DEVICES_EXECUTE` gating; `writeRouteAudit`; the `isRecursiveDeleteBoundaryFor(path, windows)` testable seam; `runBrewCleanup` in `agent/internal/patching/homebrew.go`.

## 3. Wave plan

| Wave | Title | Schema | Agent release | Ships independently |
|---|---|---|---|---|
| W01 | Correctness and hardening | none | yes (recycle bin, rule table, `cleanupGuard`, `contentsOnly`) | yes — old agents keep working (degradations below) |
| W02 | Multi-volume | two migrations | no | as one API release: schema and code change together (see §4 rolling-deploy note) |
| W03 | Tab completion and consolidation | none | no | yes |
| W04 | OS-native cleaners | none (uses W02 `kind`, `running`) | yes | yes — old agents get "agent update required" |
| W05 | AI parity, docs, lab proof | none | no | release wave: gates the agent release on the W04 lab proof; not independent |

W01 is deliberately schema-free so the fixes can land and deploy before the migration. W02 depends on W01 only for the `contentsOnly` bin semantics; W03 depends on W02 (`scan_path`); W04 depends on W02 (`kind`, `running`); W05 depends on W04.

Mixed-version behaviour during W01 rollout (new API, old agent): old agents ignore unknown `file_delete` keys (`GetPayloadBool` defaults). On Windows an old agent's scanner only ever emits `C:\$Recycle.Bin` (depth 1), which the boundary guard refuses, so the bin candidate fails with the existing "recursive delete denied" error and is reported `failed` — the same behaviour as today, now visible. On macOS/Linux an old agent performs a `permanent` recursive delete of the `.Trash` / `Trash` directory itself (depth ≥ 3, allowed) instead of a `contentsOnly` one; the OS recreates the directory on the next trash operation, so that degradation is cosmetic. `cleanupGuard` is absent on old agents; the API-side rule re-filter still applies. The web UI shows the agent version next to the result when it is below the W01 release so the difference is visible.

## 4. Data model (W02)

Two migrations (both idempotent; the first elects `SELECT set_config('breeze.scope','system',true)` before any write and reports backfill counts via `RAISE WARNING`). Names below sort after the newest files on `origin/main` as of 2026-09-19 12:10 MDT (two `2026-10-20-150000-*` files; the original `150000`/`150100` choice was bumped when they landed); the plan re-checks with `scripts/check-migration-naming.sh --against-ref origin/main` at commit time and bumps the time component if main has moved — the files must sort strictly after everything shipped.

- `2026-10-21-110000-filesystem-multi-volume.sql` — DDL + backfill.
- `2026-10-21-110100-filesystem-cleanup-run-status-running.sql` — `ALTER TYPE filesystem_cleanup_run_status ADD VALUE IF NOT EXISTS 'running';` **alone**, per the repo convention (an added label cannot be used in the transaction that adds it, and autoMigrate wraps each file in one; precedent `2026-10-17-110400-report-type-endpoint-management-review.sql`).

```sql
-- device_filesystem_snapshots
ALTER TABLE device_filesystem_snapshots ADD COLUMN IF NOT EXISTS scan_path text;
UPDATE ... SET scan_path = COALESCE(NULLIF(raw_payload->>'path',''), <os root from devices.os>) WHERE scan_path IS NULL;
ALTER TABLE device_filesystem_snapshots ALTER COLUMN scan_path SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_device_filesystem_snapshots_device_path_captured
  ON device_filesystem_snapshots (device_id, scan_path, captured_at DESC);
DROP INDEX IF EXISTS idx_device_filesystem_snapshots_device_captured;

-- device_filesystem_scan_state: composite key
ALTER TABLE device_filesystem_scan_state ADD COLUMN IF NOT EXISTS scan_path text;
UPDATE ... SET scan_path = <os root from devices.os> WHERE scan_path IS NULL;
ALTER TABLE device_filesystem_scan_state ALTER COLUMN scan_path SET NOT NULL;
ALTER TABLE device_filesystem_scan_state DROP CONSTRAINT IF EXISTS device_filesystem_scan_state_pkey;
ALTER TABLE device_filesystem_scan_state ADD PRIMARY KEY (device_id, scan_path);

-- device_filesystem_cleanup_runs
ALTER TABLE device_filesystem_cleanup_runs ADD COLUMN IF NOT EXISTS scan_path text;   -- nullable: system runs are not path-scoped
ALTER TABLE device_filesystem_cleanup_runs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'files';
ALTER TABLE device_filesystem_cleanup_runs ADD CONSTRAINT device_filesystem_cleanup_runs_kind_chk CHECK (kind IN ('files','system'));  -- via DO $$ guard
ALTER TABLE device_filesystem_cleanup_runs ADD COLUMN IF NOT EXISTS command_id uuid;  -- system runs: the queued system_cleanup_run command; no FK (device_commands rows are pruned independently)
```

Rules that apply and how this spec satisfies them:

- **RLS:** all three tables already carry denormalised `org_id NOT NULL` with `breeze_has_org_access(org_id)` policies and `FORCE`. Column adds do not touch policies; the scan-state PK swap has no FK referrers and the policy is PK-independent. No allowlist change in `rls-coverage.integration.test.ts`.
- **Cascade lists:** all three tables are already in `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, and `CORE_DEVICE_ORG_DENORMALIZED_TABLES`. No change.
- **Export policy (fires on new columns):** `scan_path`, `kind`, `command_id` → `included` in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`). Enforced by `tenant-export-policy.integration.test.ts` under Integration Tests. Note that `plan` and `executed_actions` are already `excludedOpen` (jsonb), so a system run's action list does not appear in a tenant export; `kind`, `status`, `bytes_reclaimed`, `requested_at` do. Accepted.
- **Writer contract change:** `upsertFilesystemScanState` (`filesystemAnalysis.ts:177`) currently uses `onConflictDoUpdate({ target: deviceId })`; after the PK swap that target has no unique index and every upsert fails with `42P10`. The conflict target becomes `(deviceId, scanPath)` and every reader/writer of scan state (`getFilesystemScanState`, the route, the agent result handler, the AI tool) takes `scanPath`. This is why W02 is one coordinated API release, not a schema-then-code pair.
- **Rolling-deploy window:** Breeze production replaces the single API container (`docker compose up -d api`), so old and new API code never run against the new schema at once. On multi-replica self-hosts the window between migration and the last old replica draining makes old replicas fail scan-state upserts with `42P10` (the snapshot insert itself still succeeds); a scan re-run repairs state. Documented in the release notes.
- **Drizzle:** `schema/filesystem.ts` mirrors the columns and the composite primary key; `db:check-drift` must be clean.
- **Scan-path key normalisation** (shared helper `normalizeScanPath(osType, path)` in `packages/shared/src/utils/scanPath.ts`, used by API and web): Windows — upper-case drive letter, backslashes, trailing `\` only on a volume root (`C:\`, `D:\`), else no trailing separator; POSIX — `path.posix.normalize`, no trailing `/` except `/`. The stored `scan_path` is always the normalised form; the agent receives the normalised form too.

## 5. API (W01–W04)

All routes stay under `/devices/:id/filesystem`. Gating unchanged: `authMiddleware` + `requireScope('organization','partner','system')` + `requirePermission(DEVICES_EXECUTE)` + `requireMfa()` on every mutation; `DEVICES_READ` on reads.

### 5.1 Volumes and snapshots (W02)

- `GET /filesystem/volumes` → `{ data: Volume[] }` where `Volume = { mountPoint, scanPath, fsType, totalGb, usedGb, freeGb, usedPercent, scanState: { lastRunMode, lastBaselineCompletedAt, hasCheckpoint } | null, latestSnapshot: { id, capturedAt, partial, cleanupEstimateBytes } | null, isOsRoot }`. Source: `device_disks` filtered by `isScannableVolume` — excludes `fsType` in `NON_SCANNABLE_FS_TYPES` (`cdfs, udf, iso9660, squashfs, tmpfs, devtmpfs, overlay, nfs, nfs4, cifs, smbfs, fuse*, 9p, autofs, proc, sysfs`) and UNC mount points. The OS root is always listed even if `device_disks` is empty.
- `GET /filesystem?path=` → latest snapshot **for that scan path** (default: OS root). Response gains `scanPath`.
- `POST /filesystem/scan` — `path` is normalised; `isRootScopedScan` becomes "normalised path equals a `Volume.scanPath`" (case-insensitive drive letter), replacing `=== 'C:\\'`. Scan state is read/written by `(deviceId, scanPath)`. The agent result handler (`agents/helpers.ts`) keys on `command.payload.path` (normalised) and never merges across paths. Disk-percent delta (defect 8) reads the `device_disks` row whose normalised `mountPoint` equals the scan path; falls back to "no delta available → baseline" rather than comparing unrelated disks.

### 5.2 Preview / execute (W01 + W02)

- `POST /filesystem/cleanup-preview { path?, categories? }` → pins `snapshotId` **and** `scanPath` in `plan`. Response unchanged plus `scanPath`.
- `POST /filesystem/cleanup-execute { cleanupRunId (required), paths }` — `cleanupRunId` becomes **required** (W03 UI always has one; the AI tool passes the id from its own preview). Candidates are re-filtered through the rule table (§6.1) at execute time. Response adds `rejectedPaths: string[]` (paths not in the pinned plan) and per-path `status` ∈ `completed | failed | skipped_locked | rejected`. Dispatch payload per path:

  ```json
  { "path": "<candidate>", "recursive": true, "permanent": true, "cleanupGuard": true, "contentsOnly": <true for bin/trash roots> }
  ```

  Execution is bounded by an overall `CLEANUP_EXECUTE_BUDGET_MS = 240_000`; paths not reached are reported `status: 'skipped_budget'` and the run is `executed` with `partial: true` in `executedActions`. `bytesReclaimed` stays snapshot-size based for file runs (the agent returns the pre-delete size in `file_delete`'s result already; if it differs, the agent's value wins).
- Response shape unified: every 2xx is `{ success: true, data }`; failures are `{ success: false, error, data? }` with 4xx/5xx. All-fail is `500` with `error: 'all cleanup actions failed'` and the `actions[]` detail in `data`.
- **Run lifecycle (W03, adopted from the plan):** execute **claims the pinned run in place** — `UPDATE … SET status='running' WHERE id=$1 AND status='previewed'` — and finalises the same row to `executed`/`failed`, rather than inserting a second row. This gives replay protection (a second execute on the same run returns `409`), makes the 90-day candidate trim meaningful (the candidates blob is stored once, on the run that executed), and matches the system-run lifecycle in §5.3. Retention ages a `kind='files'` run stuck in `running` for more than 24 h to `failed`.
- `GET /filesystem/cleanup-runs?limit=&cursor=` (W03) → paginated history of both kinds, newest first, without the `plan.candidates` blob (a separate `GET /filesystem/cleanup-runs/:runId` returns the full row).
- Retention (W03): a daily BullMQ repeatable job (`upsertJobScheduler`, template `services/warrantyWorker.ts`) deletes `previewed` runs older than 7 days and trims `plan.candidates` from `executed`/`failed` runs older than 90 days (the summary and `executedActions` stay). Runs under `withSystemDbAccessContext`.

### 5.3 System cleanup (W04)

- `POST /filesystem/system-cleanup/list` → queues `system_cleanup_list` (payload `{}`), returns `202 { commandId }`. The client polls `GET /devices/:id/commands/:commandId`; the completed result is the catalog (§7.3) stored on `deviceCommands.result`. No table.
- `POST /filesystem/system-cleanup/run { actionIds: string[], params?: { journalVacuumBytes?: number } }` → inserts a `device_filesystem_cleanup_runs` row `kind='system', status='running', plan={actionIds, params, catalogVersion}`, queues `system_cleanup_run { runId, actionIds, params }`, returns `202 { cleanupRunId, commandId }`. The agent result handler in `agents/helpers.ts` (new `system_cleanup_run` branch, mirroring the `filesystem_analysis` one) sets `status` (`executed` if ≥1 action succeeded, else `failed`), `executedActions`, `bytesReclaimed` (measured), `approvedAt`, and writes `writeRouteAudit`-equivalent audit `device.filesystem.system_cleanup.run` with action ids, per-action status, and measured bytes. Command timeout `SYSTEM_CLEANUP_RUN_TIMEOUT_MS = 2 h` (DISM can be slow); a timeout marks the run `failed` with `error: 'timed out'`.
- **Old-agent handling:** before queuing either command the route compares `device.agentVersion` (core semver, via `compareAgentVersions` in `services/agentEditionCompat.ts`) against `MIN_AGENT_VERSION_SYSTEM_CLEANUP` (the version W04 ships in, set at plan time) and returns `409 { error: 'agent_update_required', minAgentVersion }`. Defensive fallback: a command result whose `error` starts with `unknown command type:` also resolves to the same 409 shape on poll.
- Action-id validation: `actionIds` must be a subset of `SYSTEM_CLEANUP_ACTION_IDS` (shared constant in `packages/shared/src/validators/systemCleanup.ts`, mirrored by the agent catalog); `journalVacuumBytes` bounded `64 MiB … 4 GiB`. Nothing else from the client reaches an argv.
- **Command-type registries** (dispatch throws or denies without them): `COMMAND_OFFLINE_POLICY_REGISTRY` (`services/commandOfflinePolicy.ts`) — `system_cleanup_list` in the same TTL class as `filesystem_analysis`, `system_cleanup_run` in the long class used by patch/backup jobs (an unregistered type raises `UnregisteredCommandTypeError` on first dispatch); the per-command partner-trust allowlist (`services/partnerTrust.ts`, next to `filesystem_analysis`); `CommandTypes` in `services/commandQueue.ts`; `toolTimeouts.ts` if the AI tool (W05) dispatches it.

## 6. Agent — file engine (W01, W02)

### 6.1 Rooted rule table replaces the substring classifier

The current classifier is a floating substring match (`strings.Contains(n, "/tmp/")`), so any directory that happens to be named `tmp`, `.cache` or `Library/Caches` anywhere on disk — including `/System/Library/Caches` on macOS and `/opt/<app>/tmp` on Linux — is in scope. The replacement matches **rooted patterns on path components**, never substrings.

`agent/internal/remote/tools/filesystem_cleanup_rules.go`:

```go
type cleanupRule struct {
    Category    string        // temp_files | browser_cache | package_cache | trash
    OS          string        // runtime.GOOS value
    Pattern     string        // rooted, lower-cased, '/'-separated; components matched exactly; '*' = exactly one
                              // component; '**' = the file subtree. Windows patterns start at the scanned
                              // volume root ("<vol>/…"), POSIX patterns at "/".
    Exclude     []string      // rooted sub-patterns removed from the match set
    MinAge      time.Duration // 0 = no threshold
    Granularity string        // "file" (default) | "contents" (candidate = the matched dir; delete its children only)
}
```

Matching normalises the path (`\`→`/`, lower-case, volume root replaced by `<vol>`), splits into components, and walks the pattern component-by-component. A rule never matches across a symlink or reparse point encountered during the scan (the scanner already skips them unless `followSymlinks`). `Safe` is `true` only when a rule matched, no `Exclude` matched, and the min-age check passed.

v1 table (every row gets a positive and a negative unit test; negatives include `Bookmarks`, `History`, `Cookies`, `Login Data`, `places.sqlite`, `/system/library/caches/**`, `/opt/app/tmp/**`, `/var/lib/*/.cache/**`):

| Category | OS | Patterns | Exclude | Min age | Granularity |
|---|---|---|---|---|---|
| temp_files | windows | `<vol>/windows/temp/**`, `<vol>/users/*/appdata/local/temp/**` | — | 24 h (payload `minAgeHours`, 1–720) | file |
| temp_files | darwin | `/tmp/**`, `/private/tmp/**`, `/private/var/tmp/**`, `/private/var/folders/*/*/t/**` | — | 24 h | file |
| temp_files | linux | `/tmp/**`, `/var/tmp/**` | `/tmp/.x11-unix/**`, `/tmp/.ice-unix/**`, `/tmp/systemd-private-*/**` | 24 h | file |
| browser_cache | windows | `<vol>/users/*/appdata/local/{google/chrome,microsoft/edge,bravesoftware/brave-browser,chromium}/user data/*/{cache,code cache,gpucache,dawncache,graphitedawncache,shadercache}/**`, `…/user data/*/service worker/{cachestorage,scriptcache}/**`, `<vol>/users/*/appdata/local/mozilla/firefox/profiles/*/{cache2,startupcache,shader-cache}/**` | — | 0 | file |
| browser_cache | darwin | `/users/*/library/caches/**`, `/library/caches/**` | `/users/*/library/caches/homebrew/**` (→ package_cache), `/users/*/library/caches/com.apple.bird/**`, `/users/*/library/caches/cloudkit/**`, `/users/*/library/caches/com.apple.icloud*/**` | 0 | file |
| browser_cache | linux | `/home/*/.cache/**`, `/root/.cache/**` | `/home/*/.cache/pip/**`, `/root/.cache/pip/**` (→ package_cache) | 0 | file |
| package_cache | linux | `/var/cache/apt/archives/**`, `/var/cache/dnf/**`, `/var/cache/yum/**`, `/home/*/.cache/pip/**`, `/root/.cache/pip/**`, `/home/*/.npm/_cacache/**`, `/root/.npm/_cacache/**` | `/var/cache/apt/archives/lock`, `/var/cache/apt/archives/partial/**` | 0 | file |
| package_cache | darwin | `/users/*/library/caches/homebrew/**`, `/users/*/.npm/_cacache/**`, `/users/*/.cache/pip/**`, `/users/*/.nuget/packages/**/*.nupkg` | — | 0 | file |
| package_cache | windows | `<vol>/users/*/appdata/local/pip/cache/**`, `<vol>/users/*/appdata/local/npm-cache/_cacache/**`, `<vol>/programdata/chocolatey/cache/**`, `<vol>/users/*/.nuget/packages/**/*.nupkg`, `<vol>/users/*/appdata/local/packages/*/{ac/inetcache,ac/temp,tempstate}/**` | — | 0 | file |
| trash | windows | `<vol>/$recycle.bin/*` (each SID dir; only when the scan root is the volume root) | — | 0 | contents (keep `desktop.ini`) |
| trash | darwin | `/users/*/.trash` | — | 0 | contents |
| trash | linux | `/home/*/.local/share/trash`, `/root/.local/share/trash` | — | 0 | contents |

Cleanup-time denied roots (checked by `cleanupGuard`, §6.3, in addition to the rules): `<vol>/windows/system32/**`, `<vol>/windows/winsxs/**`, `<vol>/program files/**`, `<vol>/program files (x86)/**`, `/system/**`, `/usr/**`, `/bin/**`, `/sbin/**`, `/etc/**`, `/private/var/db/**`, `/library/apple/**`. A path under these is rejected even if a rule matched.

The same rule table is data: `packages/shared/src/utils/cleanupRules.json` is `go:embed`ded by the agent and imported by the API and web, so execute-time re-filtering (§5.2) uses identical rules. A test on each side asserts the embedded JSON's SHA-256 matches, and a shared fixture file (`cleanupRules.fixtures.json`, path → expected category or null) is run by both the Go and TypeScript matchers.

### 6.2 Trash per volume

`getTrashPaths(scanRoot)` takes the scan root. On Windows, when the root is a volume root, it enumerates `<root>\$Recycle.Bin\S-*` directories and emits one `contents`-granularity candidate per SID dir with the summed size; when the root is not a volume root it emits nothing (bins live at the volume root). macOS/Linux behaviour is unchanged except candidates become `contents`-granular on the `.Trash`/`Trash` directory. The C-drive hardcode is deleted.

### 6.3 `file_delete` additions

- `permanent: true` — already supported; now sent by cleanup.
- `cleanupGuard: true` — **new behaviour**: `DeleteFile` today calls `os.Stat` (`fileops.go:645`), which follows links. Under `cleanupGuard` it calls `os.Lstat`, refuses symlinks and Windows reparse points (`FILE_ATTRIBUTE_REPARSE_POINT`) with `status: 'rejected'`, and refuses paths that do not match an embedded rule (§6.1) or that fall under a cleanup-denied root — defence in depth against a forged execute body. Existing containment and boundary checks stay.
- `contentsOnly: true` — target must be a real directory (`Lstat`); immediate children are `Lstat`ed: symlinked or reparse-point children are skipped and reported, `desktop.ini` is preserved, everything else is removed with `os.RemoveAll`, which unlinks rather than follows links at any depth (Go's `RemoveAll` never traverses a symlink or reparse point). A test plants a symlink two levels deep pointing outside the tree and asserts the target survives. The directory itself survives. Depth check applies to the directory, so `C:\$Recycle.Bin\S-1-5-21-…` (depth 2) passes while `C:\$Recycle.Bin` (depth 1) still fails.
- Result gains `bytesFreed` (sum of `Lstat` sizes actually removed) and `skippedLocked: []string` (Windows sharing violations → `skipped_locked`, never forced).

### 6.4 Accumulator fixes

- `addDuplicateCandidate`: bounded map (`maxFSDuplicateGroups = 50_000`); when full, new keys are dropped and `summary.duplicateTrackingTruncated = true`.
- `addCleanupCandidate`: cap keeps **top-by-size** — a min-heap keyed on `SizeBytes`; a larger newcomer evicts the smallest.
- `estimateDirectorySize` counts permission errors into `permissionDeniedCount`; `getTrashPaths` `ReadDir` errors go to `errors[]`.
- Unit tests for `classifyCleanupCategory` (via the rule table), `isOldDownload`, `isUnrotatedLog`, `getTrashPaths(root)`, checkpoint resume, `maxEntries`/timeout partial paths, `collapseAncestorDirectories`' estimated ratio. The `[]map[string]any` assertion in `TestBuildCheckpointPayloadMarksTruncation` is replaced by a JSON round-trip.

## 7. Agent — native cleaner engine (W04)

New package `agent/internal/syscleanup/`, command types `system_cleanup_list` and `system_cleanup_run` registered in `heartbeat/handlers.go`; consts in `remote/tools/types.go`.

### 7.1 Action contract

```go
type Action interface {
    ID() string                                  // stable, matches shared SYSTEM_CLEANUP_ACTION_IDS
    Describe() ActionInfo                        // label, description, riskFlags, affectsVolumes
    Available(ctx) (ok bool, reason string)      // binary present, OS match, sandbox permits
    Estimate(ctx) (bytes int64, known bool, detail string)
    Run(ctx, params) ActionResult                // exitCode, truncated output, durationMs, error
}
```

Common runner: absolute binary paths resolved at init (`%SystemRoot%\System32\cleanmgr.exe`, `dism.exe`, `/usr/bin/tmutil`, `/usr/bin/apt-get`, `/usr/bin/dnf`, `/usr/bin/yum`, `/usr/bin/journalctl`), never `$PATH` lookup, never a shell; `exec.CommandContext` with a per-action timeout; stdout/stderr captured and capped at 16 KiB each; process tree killed on timeout (Windows: job object, POSIX: process group). **Output locale is pinned**: DISM is invoked with `/English`; apt, dnf, yum and journalctl run with `LC_ALL=C LANG=C` in the environment, otherwise parsers fail on non-English endpoints and would report an estimate of 0 with `estimateKnown: true`. A parser that cannot match its fixture shape returns `estimateKnown: false`, never 0. Freed bytes per run = Σ over affected volumes of `disk.Usage(mount).Free` after − before, floored at 0, reported alongside per-action exit status. Every estimate is an **upper bound** and the UI labels it "up to": DISM's two fields exceed what `StartComponentCleanup` reclaims (30-day grace, last backup retained), `journalctl --vacuum-size` removes archived files only, and Time Machine thinning is opportunistic. Argv builders are pure functions with table tests; parsers take fixture strings.

### 7.2 Catalog v1

| ID | OS | What it runs | Estimate | Timeout | Risk flags |
|---|---|---|---|---|---|
| `win_cleanmgr` | windows | For each selected handler sub-id, set `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches\<Handler>\StateFlags5555 = 2` (0 for all others in the allowlist), then `cleanmgr.exe /sagerun:5555`. `/d` is not supported with `/sagerun`, so all volumes are processed. **Session-0 caveat:** under the SYSTEM account cleanmgr renders a hidden progress UI and is known to return before its work finishes or to hang; the runner therefore waits for the job object (whole process tree) to exit, treats the exit code as informational only, reports `timed_out` with partial status when the 60-minute cap hits, and the acceptance criterion is the lab run in §11, not a unit test. | Per handler where a directory is known: `Update Cleanup` → none (opaque); `Delivery Optimization Files` → `%SystemRoot%\SoftwareDistribution\DeliveryOptimization`; `Previous Installations` → `%SystemDrive%\Windows.old`; `Upgrade Discarded Files` → `%SystemDrive%\$WINDOWS.~BT`, `$WINDOWS.~WS`; `Windows Upgrade Log Files` → `%SystemDrive%\$Windows.~BT\Sources\Panther`, `%SystemRoot%\Panther`; `Setup Log Files` → `%SystemRoot%\Logs`; `System error memory dump files` → `%SystemRoot%\MEMORY.DMP`; `System error minidump files` → `%SystemRoot%\Minidump`; `Windows Defender` → `%ProgramData%\Microsoft\Windows Defender\Scans\History\`; `Temporary Files` → `%SystemRoot%\Temp`; others → unknown | 60 min | `long_running`; per handler: `Update Cleanup` → `may_require_reboot` (space is released after restart), `Device Driver Packages` → `removes_driver_rollback` |
| `win_dism_component_cleanup` | windows | `dism.exe /English /Online /Cleanup-Image /StartComponentCleanup` (never `/ResetBase`) | `dism.exe /English /Online /Cleanup-Image /AnalyzeComponentStore` → parse `Backups and Disabled Features` + `Cache and Temporary Data`; `Component Store Cleanup Recommended : No` → estimate 0 | 90 min | `long_running`, `may_require_reboot_free_state` |
| `mac_tm_local_snapshots` | darwin | `tmutil listlocalsnapshots /` then `tmutil deletelocalsnapshots <date>` for each listed snapshot (deterministic; `thinlocalsnapshots` is opportunistic and may delete nothing) | snapshot count; bytes unknown | 10 min | — |
| `mac_brew_cleanup` | darwin | new exported `patching.BrewCleanup(ctx, dryRun bool) (output string, err error)` extracted from the unexported, error-swallowing, debounced `(*HomebrewProvider).runBrewCleanup` (`homebrew.go:319`); keeps the console-user `sudo -n -H -u` handling; the patch-job caller keeps its swallow-and-log wrapper | `brew cleanup --prune=all -n` → trailing `==> This operation would free approximately X of disk space.` line | 10 min | — |
| `linux_pkg_cache_clean` | linux | `apt-get clean` / `dnf clean all` / `yum clean all` (first present) | size of `/var/cache/apt/archives`, `/var/cache/dnf`, `/var/cache/yum` | 5 min | — |
| `linux_pkg_autoremove` | linux | `apt-get -y autoremove` / `dnf -y autoremove` | `apt-get -s autoremove` → "After this operation, X MB disk space will be freed"; `dnf --assumeno autoremove` → "Freed space: X" — dnf exits non-zero when it aborts under `--assumeno`, so the estimator accepts exit 1 when the summary parses; dnf5 (Fedora 41+) changed the summary format and yields `estimateKnown: false` until a fixture is added | 15 min | `removes_packages` (UI shows a warning badge and requires the confirm dialog's second checkbox) |
| `linux_journal_vacuum` | linux | `journalctl --vacuum-size=<bytes>` (param, default 256 MiB, bounded 64 MiB–4 GiB) | `journalctl --disk-usage` − target, floored at 0 (upper bound: only archived journals are vacuumed) | 5 min | — |

**Windows handler allowlist** for `win_cleanmgr` sub-actions (registry key names; anything else under `VolumeCaches` is never offered): `Update Cleanup`, `Delivery Optimization Files`, `Device Driver Packages`, `Previous Installations`, `Upgrade Discarded Files`, `Windows Upgrade Log Files`, `Setup Log Files`, `Temporary Setup Files`, `Service Pack Cleanup`, `System error memory dump files`, `System error minidump files`, `Windows Error Reporting Files`, `Windows Error Reporting System Archive Files`, `Windows Error Reporting System Queue Files`, `Temporary Files` (under the SYSTEM account this is `%SystemRoot%\Temp`, which is the machine-scoped temp we want), `Windows Defender`, `Old ChkDsk Files`, `Diagnostic Data Viewer database files`, `BranchCache`, `Content Indexer Cleaner`. Handler key names vary by Windows build (the WER handlers were consolidated in Windows 10 1809+), so the allowlist is matched against whatever subset exists on the device; missing names are simply not offered. Explicitly excluded: `DownloadsFolder` (user data), `Windows ESD installation files` (breaks Reset this PC), `Language Pack` (removes installed languages), and every per-user handler (`Recycle Bin`, `Thumbnail Cache`, `Temporary Internet Files`, `Internet Cache Files`, `Active Setup Temp Folders`, `GameNewsFiles`, `GameStatisticsFiles`, `GameUpdateFiles`) — under the SYSTEM service account these operate on the SYSTEM profile, not the logged-in user, and the file engine (§6.2) already covers user bins. Labels: the key name mapped through a fixed friendly-name table; the registry `Display` resource string is resolved with `SHLoadIndirectString` when available, else the key name is shown. `Available()` is false with reason `cleanmgr.exe not present` on Server Core.

Linux `Available()` also probes write access to `/var/cache/apt` (or dnf/yum) and `/var/log/journal` and reports `sandbox denies write to <path>` otherwise. Verified 2026-09-19: the agent unit (`agent/internal/agentapp/systemd_unit.go`, `agent/service/systemd/breeze-agent.service`) carries no `ProtectSystem`/`ReadWritePaths` directives — only the watchdog unit is `ProtectSystem=strict` — so the probe is defence in depth for self-hosters who harden the unit themselves, not a known blocker.

### 7.3 Command payloads

- `system_cleanup_list {}` → `{ catalogVersion, actions: [{ id, subActions?: [{ id, label, estimateBytes?, estimateKnown }], label, description, os, available, unavailableReason?, estimateBytes?, estimateKnown, estimateDetail?, riskFlags: [], affectsVolumes: [] }], volumesBefore: [{ mount, freeBytes }] }`. Estimation runs concurrently per action with a 3-minute overall cap; an action whose estimate times out reports `estimateKnown: false`.
- `system_cleanup_run { runId, actionIds, params }` → `{ runId, actions: [{ id, subActions?, status: completed|failed|timed_out|unavailable, exitCode, durationMs, outputTail, error? }], volumes: [{ mount, freeBefore, freeAfter }], freedBytes }`. Actions run **sequentially** in catalog order (cleanmgr and DISM must not overlap). One action failing does not stop the next.

## 8. Web (W01, W02, W03, W04)

Component split (the 958-line tab exceeds the 500-line guideline and duplicates File Manager code):

- `apps/web/src/components/devices/filesystem/filesystemTabUtils.ts` — `formatBytes`, `normalizeHierarchyPath`, `isDescendantPath`, `collapseAncestorDirectories` (memoised at the call site), `readThresholdEvents`, types. Unit-tested.
- `useFilesystemVolumes.ts`, `useFilesystemSnapshot.ts`, `useCommandPoll.ts` — data hooks; every poll owns an `AbortController` tied to unmount.
- `VolumePicker.tsx`, `SnapshotPanels.tsx`, `CleanupPanel.tsx`, `SystemCleanupPanel.tsx`, `CleanupRunHistory.tsx`; `DeviceFilesystemTab.tsx` composes them.

Layout, top to bottom: **Volume chips** (fixed volumes with used/free bar, last-scan age, "OS" badge; selecting a chip switches every panel below) → **scan controls** (Analyze, Refresh; both disabled while either runs; progress banner `role="status"`, error banner `role="alert"`) → **snapshot panels** (unchanged content, `tempAccumulation` now rendered) → **Cleanup panel**: category cards with checkboxes and byte totals, candidate table sorted by size with per-row checkboxes and "select all in category", Execute button → `ConfirmDialog variant="destructive"` listing volume, count, bytes, and the first 10 paths → result panel: reclaimed bytes, `completed / skipped_locked / rejected / skipped_budget` counts, failures in an amber list (never a green box) → **System cleanup panel**: "Check available actions" runs the list command; rows show label, estimate or "unknown", risk badges, unavailable reason greyed; Run → destructive confirm (extra checkbox when any selected action has `removes_packages`) → running state with elapsed time → result with measured freed bytes per volume → **Run history** (both kinds, paginated).

Rules honoured: every mutation goes through `runAction` (`DeviceFilesystemTab.tsx` leaves `runActionAllowlist.ts`); state uses `window.location.hash` (`#filesystem` already; volume selection is component state, not URL); all new strings in all 8 locales (`web_locale_keys_need_real_translations_coverage_test`); `deviceFilesystemTab.scanRunning` is rebuilt as a single interpolated key; `be1DiskCleanupIntelligence` and the `>=` key are removed; `key=` props use a stable id, not optional `path`.

File Manager: the disk-cleanup preview/execute section (`FileManager.tsx` ~`:860-1031`, `:1363-1385`, `:1725-1734`) is removed; a "Disk Cleanup" button navigates to `/devices/:id#filesystem`. One concept, one home.

Agent-update-required: a `409 agent_update_required` on either system-cleanup call renders a banner with the minimum version and a link to the agent update action; the panel's Run button is disabled.

## 9. AI and MCP tools (W05)

One registry feeds three surfaces. `apps/api/src/services/aiTools.ts` is the core tool registry; the in-app AI chat, the AI agents/schedules/playbooks, and the **Breeze MCP server** (`routes/mcpServer.ts` builds `tools/list` from `getToolDefinitions()` and tiers from `getToolTier` + `TIER3_ACTIONS`) all read it. A second, SDK-side registry (`aiAgentSdkTools.ts`: `TOOL_TIERS` + a `tool(...)` declaration per tool) must mirror it and is contract-tested against it. There is no separate MCP tool list, no MCP name registry (`mcpToolNames.ts` is only prefix-stripping and the session allowlist), and no tool-search index to update (verified 2026-09-19).

### 9.1 Tool changes

- **`analyze_disk_usage`** gains `path` (normalised server-side via `normalizeScanPath`; default OS root). `refresh` scans that path; the returned snapshot is the latest **for that path**.
- **`disk_cleanup`** gains `path`; `preview` returns `cleanupRunId` and the tool's own state carries it, so `execute` **must** pass `cleanupRunId` (the same requirement as the route after W03). `paths` capped at 200 like the route. Empty-snapshot guard (W01) and a run-level audit written like the route's. Tiering unchanged: `preview` Tier 1, `execute` Tier 3.
- **New `system_cleanup`**: `{ deviceId, action: 'list' | 'run', actionIds?, params? }`. `list` is Tier 1 and returns the §7.3 catalog; `run` is Tier 3 with rate limit `2 / 3600 s` and requires `actionIds ⊆ SYSTEM_CLEANUP_ACTION_IDS`. The handler queues the same commands as the routes (§5.3) and polls to completion within `toolTimeouts` (2 h), so the AI, the route and MCP share one code path. Denied to the Helper.

### 9.2 Behaviour over MCP (verified against `routes/mcpServer.ts`)

- **Tier 3 is a hard deny over MCP, not an approval flow.** `tools/call` computes `max(baseTier, guardrailTier)` and returns `MCP_APPROVAL_REQUIRED` before scope checks, RBAC, ledger or execution. So `disk_cleanup execute` is already unavailable to MCP clients today, and `system_cleanup run` will be too. Both tools stay listed because they are mixed multiplexers: `tools/list` appends "Actions "execute"/"run" require interactive approval" via `gatedActionsForTool`; a wholly Tier 3 tool would be hidden. MCP clients therefore get `analyze_disk_usage`, `disk_cleanup preview`, and `system_cleanup list` — read-only diagnosis — and hand off the destructive step to a tech in the web UI or the in-app chat with approval. This is the intended contract and is stated in `mcp-server.mdx`.
- **Org resolution** for device-scoped tools comes from the `deviceArgs` array declared in `aiTools.ts` (`resolveMcpExecutionContext` → `collectSuppliedDeviceIds` → `verifyDeviceAccess`). `system_cleanup` must declare `deviceArgs: ['deviceId']`. Omitting it **fails open**, not closed: `collectSuppliedDeviceIds` returns `[]` and the ledger and audit attribute the call to the caller's first accessible org instead of the device's org. `aiTools.deviceArgsCoverage.contract.test.ts` is the guard.
- **Rate limits** are the same per-tool sliding windows as in-app (`checkToolRateLimit` at the MCP call site) plus the transport limits (`MCP_SSE_RATE_LIMIT_PER_MINUTE`, `MCP_MESSAGE_RATE_LIMIT_PER_MINUTE`); no MCP-specific limit is added.
- No MCP prompt references disk cleanup today (`mcpGuidance.ts` prompts are fleet-triage, device-investigate, patch-remediate, incident-kickoff, turnkey-setup), so no prompt changes; `MCP_TOOL_COUNT_APPROX` stays within its tolerance test after adding one tool.

### 9.3 Registration checklist (each item is a plan step; the test in parentheses goes red if it is skipped)

1. `aiToolsFilesystem.ts` — `system_cleanup` definition + handler; `disk_cleanup`/`analyze_disk_usage` schema changes. Register the module in `aiTools.ts`.
2. `aiTools.ts` device-arg / helper-scoping maps — `system_cleanup: 'deviceId'` (`aiTools.deviceArgsCoverage.contract.test.ts`, `aiToolsDeviceScope.contract.test.ts`, `aiToolsDeviceGuard.contract.test.ts`).
3. `aiToolSchemas.ts` — Zod entries matching `input_schema.properties` exactly, incl. `path` and `cleanupRunId` (`aiToolsRegistryParity.test.ts`, `aiAgentSdkTools.mcpCoverage.test.ts` key parity).
4. `aiGuardrails.ts` — `TIER3_ACTIONS.system_cleanup = ['run']` (both tables), `TOOL_PERMISSIONS`, `RATE_LIMIT_CONFIGS` (`aiToolPermissionsCatalogParity.contract.test.ts`, `aiGuardrails.agentPrincipal.contract.test.ts`).
5. `aiAgentSdkTools.ts` — `TOOL_TIERS` entry + `tool('system_cleanup', …, makeHandler(...))` (`aiAgentSdkTools.registryParity.contract.test.ts`, `aiAgentSdkTools.handlerCoverage.contract.test.ts`, `aiAgentSdkTools.mcpCoverage.test.ts`).
6. `toolTimeouts.ts` (2 h), `aiToolOutput.ts` (compaction branch for the catalog/run result), `aiAgentSystemPrompt.ts` "Files & Disk" tool list.
7. `aiAgents/agentToolCatalog.ts` — capability `files_disk` (`agentToolCatalog.contract.test.ts`: every registered headless tool maps to a capability); not added to any `AGENT_KIND_PRESETS` default.
8. `aiAgents/actManifest.ts` — **no** `ActOperation` for `system_cleanup` (it is never unattended-eligible; the contract test's `unreachableTools`/`actEligible` derivation is updated accordingly). `disk_cleanup`'s existing `ActOperation`, `actRevalidation.ts`, `actVerify.ts` and `playbookActExecutor.ts` are updated for the required `cleanupRunId` and the `path` field.
9. `impactFixTools.ts` — `system_cleanup` is **not** an impact-fix tool (measured freed bytes are reported on the run, not attributed as a fix) — recorded as a decision, not an omission.
10. `helperToolFilter.ts` — omitted from `BASIC_/STANDARD_/EXTENDED_TOOLS` (denied to the Helper); `helperAiAgent.ts` prompt hint unchanged.
11. `builtInPlaybooks.ts` — the built-in "Disk Cleanup" playbook passes `cleanupRunId` through and gains an optional final `system_cleanup list` step (reporting only, no auto-run); `playbookActExecutor.ts` classification updated.
12. Web `components/ai-risk/tierConfig.ts` rows + `RATE_LIMIT_CONFIGS` + permission maps, `ApprovalHistoryFeed.tsx` label, and the three action-label keys in all 8 `apps/web/src/locales/*/settings.json` (`aiGuardrailsTierConfig.parity.test.ts`).
13. Docs — `features/ai.mdx` tier and rate tables (**test-enforced** by `aiGuardrailsAiDocs.parity.test.ts`), `features/mcp-server.mdx` "File and disk tools" table + per-tool rate-limit table + a sentence on the Tier 3 hard-deny contract, `apps/api/src/data/docsIndex.json` regenerated.
14. Mobile — nothing: tool labels are derived by verb (`packages/shared/src/utils/aiToolLabels.ts`) and `toolIndicatorLogic` is status-only (verified; `system_cleanup` derives to a sensible label, asserted by one added case in `aiToolLabels.test.ts`).

## 10. Safety model

1. **Nothing is deleted that was not previewed.** Execute requires a pinned `cleanupRunId`; paths outside the pinned plan are `rejected`, reported, and audited.
2. **Rules are enforced twice.** API re-filters through the shared rule table at execute; the agent re-checks anchor membership under `cleanupGuard` before deleting.
3. **Permanent by construction.** Cleanup bypasses the recoverable trash because every candidate is cache, temp, or already-trash. The File Manager's own delete keeps the recoverable behaviour.
4. **No symlink following.** `Lstat` everywhere in the cleanup path; symlinks and reparse points are rejected, children of `contentsOnly` targets that are links are skipped.
5. **Never force locked files.** Sharing violations → `skipped_locked`.
6. **Boundary guard unchanged.** Volume roots and top-level directories remain undeletable; bin contents are reached one level down.
7. **Native actions are a closed catalog.** Client input is action ids and one bounded integer. Argv is built from constants; binaries are absolute; no shell; timeouts and output caps on every process; `/ResetBase`, `DownloadsFolder`, ESD, and language-pack handlers are excluded in code, not config.
8. **Human in the loop.** Every destructive step is behind `requireMfa` + a destructive confirm (UI) or Tier 3 approval (AI). No scheduled mode in this spec.
9. **Audited.** `device.filesystem.cleanup.execute` (existing) and `device.filesystem.system_cleanup.run` (new) carry action ids, per-item status, and bytes.

## 11. Testing and verification

- **Go (`go test -race ./...`)**: rule-table positives/negatives per row (Chrome `Bookmarks` is never a candidate; `Cache/f_000001` is); min-age gate; per-volume bin fixture (temp tree with `$Recycle.Bin/S-1-5-21-x/` and `desktop.ini` survives); `contentsOnly` skips a symlinked child; `cleanupGuard` rejects a symlink; top-by-size eviction; duplicate-map cap; JSON round-trip of the checkpoint payload; syscleanup argv builders and output parsers on fixtures (DISM analyze, `apt-get -s autoremove`, `dnf --assumeno autoremove`, `journalctl --disk-usage`, `brew cleanup -n`, `tmutil listlocalsnapshots`); handler allowlist excludes `DownloadsFolder`; `isRecursiveDeleteBoundaryFor` cases for `C:\$Recycle.Bin` (refused) and `C:\$Recycle.Bin\S-1-5-21-1` (allowed). No test executes a real cleaner.
- **API (Vitest)**: route tests for volumes, path-keyed snapshot, required `cleanupRunId`, `rejectedPaths`, budget cut-off, 409 agent gate, system-cleanup list/run; migration replay + `db:check-drift`; `tenant-export-policy` and `tenantExportErasureRoundtrip` integration suites (new columns); `rls-coverage` unchanged but run; `migrationRlsScope.test.ts` passes (system scope set before the backfill).
- **Web (Vitest + jsdom)**: utils; volume switch re-keys panels; select → execute payload carries `cleanupRunId` and only checked paths; partial failure renders amber; 409 renders the update banner; `no-silent-mutations` passes with the tab removed from the allowlist.
- **Lab (W05, before the agent release; acceptance gate for W04):** Windows rig `WIN-IMDR2GAIDMV` — scan `C:\` and a second volume, empty its bin, run `Update Cleanup` + DISM as the SYSTEM service and confirm (a) the runner observes the whole cleanmgr process tree exiting in session 0 without hanging, (b) the measured free-space delta is non-zero after the flagged reboot; KIT `lab-ubuntu-src` — `apt-get clean`, journal vacuum, autoremove estimate matches the simulated output. Results recorded on the W05 sub-issue.
- **Docs:** `apps/docs/src/content/docs/features/filesystem-analysis.mdx` rewritten for volumes, the finished tab, the native catalog, and the new tables/columns; `agents/commands.mdx` (two new command types), `features/ai.mdx`, `features/mcp-server.mdx`, `features/playbooks.mdx` (tool and playbook changes); `apps/api/src/data/docsIndex.json` regenerated; release notes entry including the W02 rolling-deploy note.

## 12. Plan amendments

The five wave plans (`docs/superpowers/plans/devices/2026-09-19-disk-cleanup-v2*.md`) verified every claim above against the code and recorded their deviations in each plan's "Plan amendments" section; the plan index summarises them. Where a plan and this document disagree, **the plan wins** — it was checked later and against the tree. The two amendments that changed a safety statement were folded back into §5.2 (run lifecycle) and §9.2 (`deviceArgs` fails open) above.

## 13. Advisor quorum

Fable position: the design above. Independent reviews and their resolution:

- **Independent Opus review (adversarial, no shared context, 2026-09-19 10:30 MDT)** — 20 verdicts; all incorporated (migration name collision, PK swap vs `onConflictDoUpdate`, missing command-type registries, substring anchors → rooted patterns, native-catalog facts, wave mixed-version story, second tool registry). Details in the commit history of this file.
- **Codex `gpt-6-astra` xhigh, read-only (2026-09-19 11:45 MDT, on this spec + the plan index)** — AGREE on the structure ("two engines, one surface", `(device_id, scan_path)` key, tenancy/cascade/export registrations, depth boundary, UI consolidation, MCP hard deny). DISAGREE/MISSING on 16 safety and rollout contracts. Each was weighed on the merits; **all 16 are adopted** — none changes the approach, every one tightens a contract the spec stated too loosely. They supersede the corresponding text above and are applied by the wave plans:

| # | Codex finding | Resolution (owning wave) |
|---|---|---|
| 1 | Leaf `Lstat` + literal path match does not confine deletion: preview `~/.cache/sub/x`, replace `sub` with a symlink to `/etc`, execute deletes `/etc/x`. | **Delete through directory handles, not pathnames.** `cleanupGuard` opens the matched rule's anchor directory with `os.OpenRoot` (Go ≥ 1.24) and performs `Lstat`/`Remove` relative to that root, which refuses any symlink or reparse point in the traversal; the anchor's real path (`EvalSymlinks`) must sit on the scanned volume. Tests plant an ancestor symlink and a Windows junction and assert the target survives. (W01) |
| 2 | Pinning a path does not pin identity, type, age or contents. | File-granularity rules dispatch `recursive: false` and the agent requires a regular file at execute; min-age is re-checked at execute against the rule table; a candidate whose `mtime` is newer than the preview is `rejected`; previews expire (`CLEANUP_PREVIEW_TTL_HOURS = 24`, 409 after). `contentsOnly` is explicitly documented as "current contents at execution" and shown so in the confirm dialog. (W01, W03) |
| 3 | New API + old agent = unguarded permanent recursive delete. | `permanent` file cleanup is gated on `MIN_AGENT_VERSION_CLEANUP_GUARD` (the W01 agent release) exactly like the native cleaners; older agents get `409 agent_update_required`, never a permanent delete. The §3 "cosmetic degradation" paragraph is withdrawn. (W01) |
| 4 | `/sagerun` executes every handler whose `StateFlags5555 = 2`, including excluded or third-party handlers that already carry it; concurrent runs overwrite selections. | Before each run the agent enumerates **all** `VolumeCaches` subkeys and writes `StateFlags5555 = 0` on every non-selected one (fail the action if any write fails); a process-wide `maintenance.Lock` serialises `system_cleanup_run`, Homebrew cleanup and DISM; the API refuses a second `system_cleanup_run` while one is `running` for the device. HKLM is trusted as admin-only; handler names are not treated as authenticity. (W04) |
| 5 | Run claim and command insert happen inside the ambient request transaction: not visible to concurrent requests, rolled back on crash after deletion, WS push before commit. | `cleanup-execute` and `system-cleanup/run` become self-managed-context routes (`db/index.ts` registry): claim in a short committed tenant transaction → dispatch → finalise in a separate transaction. Two-connection visibility test and a crash-boundary test are required. (W03, W04) |
| 6 | `STANDARD_REVIEWED` delivers for 168 h; a run the UI marked failed at 2 h can still execute days later. | Destructive cleanup commands are **live-only**: shortest offline TTL class (or a new `LIVE_ONLY` class if none is ≤ 15 min), and marking a run failed/timed-out cancels its command atomically. (W01 for `file_delete` under `cleanupGuard`, W04) |
| 7 | `scan_path NOT NULL` without default breaks old snapshot writers on multi-replica upgrades. | Expand/contract: W02 adds `scan_path` nullable + backfill and new code writes it; W03 ships the `SET NOT NULL` migration after W02 is deployed. (W02, W03) |
| 8 | Relabelling every legacy scan-state row as the OS root can resume a `D:\` checkpoint into `C:\`. | The backfill sets `scan_path` from the device's newest snapshot `raw_payload->>'path'` when present and matching a volume; otherwise it keeps `last_baseline_completed_at`/`last_disk_used_percent` and **clears** `checkpoint`, `aggregate`, `hot_directories` (cost: one re-scan). (W02) |
| 9 | `filesystem_analysis` results delivered over WebSocket are never persisted — the handler exists only on the HTTP leg. | Existing bug; register `filesystem_analysis` in `services/commandResultHandlers` in W01 with a WS-leg test. (W01) |
| 10 | Lower-casing and `\`→`/` on POSIX changes path identity (`/TMP/x` matches `/tmp/**`; a file literally named `.cache\v` becomes a descendant of `.cache`). | Normalisation is per OS: Windows folds case and separators; darwin folds case only (default APFS is case-insensitive) and keeps backslashes; linux is exact. The shared fixture file carries cases for each. (W01) |
| 11 | POSIX trash enumeration ignores the scan root; `tmutil deletelocalsnapshots <date>` deletes on all mounted disks. | Trash candidates are emitted only when the trash directory's real path is under the scanned root; `mac_tm_local_snapshots` uses the mount-point form `tmutil deletelocalsnapshots <mount_point>` and lists with the same mount point. (W01, W04) |
| 12 | Native maintenance is not serialised across runs or with patch operations. | See #4: `maintenance.Lock` shared by syscleanup and `patching` (brew cleanup, DISM); API-side single-run-per-device rule. (W04) |
| 13 | Cancellation, expiry, timeout, late results and partial child failures are unreconciled. | Cleanup runs get a branch in `commandCancelPropagation` (device org-move cancels the run); the reaper that times a run out cancels its command; a late result for a finalised run is recorded as `late_result` on the row without flipping status; a `contentsOnly` action with any failed child is `partial`, never `completed`, and `failedChildren` stays in the response. (W01, W03, W04) |
| 14 | Estimates: `apt-get -s autoremove` prints no "After this operation" line; DISM fields are overhead not reclaimable and direct `/StartComponentCleanup` has no 30-day grace; `brew cleanup -n` prints no summary when nothing to remove; journal usage-minus-target is not an upper bound; Delivery Optimization cache lives under the NetworkService profile and is policy-overridable; the `Temporary Files` handler covers more than `%SystemRoot%\Temp`. | apt estimate = Σ `dpkg-query -W -f='${Installed-Size}'` over the simulated `Remv` packages; DISM and journal estimates labelled "heuristic"; brew: no `Would remove` lines → 0, summary missing otherwise → unknown; DO path read from policy/registry with the NetworkService default; `Temporary Files` estimate marked unknown. Aggregate run budget = Σ selected action timeouts + 10 min, capped at 3 h, with `not_started` outcomes for actions the budget never reached. (W04) |
| 15 | Lost rollback and recovery points are not disclosed. | Risk flags `removes_os_rollback` (`Previous Installations`, `Upgrade Discarded Files`) and `removes_recovery_points` (`mac_tm_local_snapshots`) with explicit confirm-dialog copy. (W04) |
| 16 | Requiring `cleanupRunId` in W03 breaks the AI executor and act-mode pinning until W05. | The AI `disk_cleanup` schema change, `pinDiskCleanup`, and playbook variable ordering move from W05 into W03 so the requirement and its consumers land together. (W03) |
| 18 | Same-path concurrent scans still race. | `device_filesystem_scan_state.scan_generation uuid` = the command id; result application is idempotent and drops results from a superseded generation. (W02) |

Also adopted from the Codex narrative: the Homebrew action uses the new bounded runner (absolute binary, context cancellation, tail-preserving output cap) with the existing console-user `sudo -n -H -u` execution rather than the patching wrapper; existing `file_delete` results carry no byte count, so `bytesFreed` is the agent's `Lstat` sum and is labelled "logical bytes", with the volume free-space delta as the measured figure on every run.
