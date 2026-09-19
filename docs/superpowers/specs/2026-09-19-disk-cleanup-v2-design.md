# Disk Cleanup v2 — Correctness, Multi-Volume, Finished UI, OS-Native Cleaners

- **Date:** 2026-09-19
- **Status:** Approved design (Todd, 2026-09-19); Codex advisor quorum recorded in §12
- **Branch:** `spec/disk-cleanup-v2`
- **Supersedes:** nothing. The 2026-06-15 winapp2 spec (`2026-06-15-disk-cleanup-winapp2-design.md`) was approved but never implemented and has no tracking issue; it stays parked. This spec does not preclude it — §6's rule table is the seam a future ruleset would replace.
- **Tracking issue:** filled in by `writing-plans` (`tracking_issue: LanternOps/breeze#<parent>`)

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
| W01 | Correctness and hardening | none | yes (recycle bin, rule table, `cleanupGuard`, `contentsOnly`) | yes — old agents keep working; new API flags are ignored by old agents except `permanent`, which they already honour |
| W02 | Multi-volume | migration | no | yes |
| W03 | Tab completion and consolidation | none | no | yes |
| W04 | OS-native cleaners | none (uses W02 `kind`) | yes | yes — old agents get "agent update required" |
| W05 | AI parity, docs, lab proof, release | none | no | yes |

W01 is deliberately schema-free so the fixes can land and deploy before the migration. W02 depends on W01 only for the `contentsOnly` bin semantics; W03 depends on W02 (`scan_path`); W04 depends on W02 (`kind`, `running`); W05 depends on W04.

Mixed-version behaviour during W01 rollout: an old agent ignores unknown `file_delete` keys (`GetPayloadBool` defaults), so it performs a `permanent` recursive delete of a bin SID directory (depth 2, allowed) instead of a `contentsOnly` one — Explorer recreates the SID folder and `desktop.ini` on the next delete-to-bin, so the degradation is cosmetic. `cleanupGuard` is likewise absent on old agents; the API-side rule re-filter still applies. The web UI shows the agent version next to the result when it is below the W01 release so the difference is visible.

## 4. Data model (W02)

Migration `apps/api/migrations/2026-10-20-140000-filesystem-multi-volume.sql` (sorts after the newest committed `2026-10-20-130000-…`; idempotent; `SELECT set_config('breeze.scope','system',true)` before any write; backfill counts via `RAISE WARNING`).

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
ALTER TYPE filesystem_cleanup_run_status ADD VALUE IF NOT EXISTS 'running';
```

Rules that apply and how this spec satisfies them:

- **RLS:** all three tables already carry denormalised `org_id NOT NULL` with `breeze_has_org_access(org_id)` policies and `FORCE`. Column adds do not touch policies. No allowlist change in `rls-coverage.integration.test.ts`.
- **Cascade lists:** all three tables are already in `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, and `CORE_DEVICE_ORG_DENORMALIZED_TABLES`. No change.
- **Export policy (fires on new columns):** `scan_path`, `kind`, `command_id` → `included` in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`). Enforced by `tenant-export-policy.integration.test.ts` under Integration Tests.
- **Enum value:** `ADD VALUE IF NOT EXISTS` is legal inside autoMigrate's transaction on the project's Postgres, and the new value is not used in the same file (precedent: `2026-10-17-110400-report-type-endpoint-management-review.sql`).
- **Drizzle:** `schema/filesystem.ts` mirrors the columns; `db:check-drift` must be clean.
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
- `GET /filesystem/cleanup-runs?limit=&cursor=` (W03) → paginated history of both kinds, newest first, without the `plan.candidates` blob (a separate `GET /filesystem/cleanup-runs/:runId` returns the full row).
- Retention (W03): a daily BullMQ repeatable job (`upsertJobScheduler`, template `services/warrantyWorker.ts`) deletes `previewed` runs older than 7 days and trims `plan.candidates` from `executed`/`failed` runs older than 90 days (the summary and `executedActions` stay). Runs under `withSystemDbAccessContext`.

### 5.3 System cleanup (W04)

- `POST /filesystem/system-cleanup/list` → queues `system_cleanup_list` (payload `{}`), returns `202 { commandId }`. The client polls `GET /devices/:id/commands/:commandId`; the completed result is the catalog (§7.3) stored on `deviceCommands.result`. No table.
- `POST /filesystem/system-cleanup/run { actionIds: string[], params?: { journalVacuumBytes?: number } }` → inserts a `device_filesystem_cleanup_runs` row `kind='system', status='running', plan={actionIds, params, catalogVersion}`, queues `system_cleanup_run { runId, actionIds, params }`, returns `202 { cleanupRunId, commandId }`. The agent result handler in `agents/helpers.ts` (new `system_cleanup_run` branch, mirroring the `filesystem_analysis` one) sets `status` (`executed` if ≥1 action succeeded, else `failed`), `executedActions`, `bytesReclaimed` (measured), `approvedAt`, and writes `writeRouteAudit`-equivalent audit `device.filesystem.system_cleanup.run` with action ids, per-action status, and measured bytes. Command timeout `SYSTEM_CLEANUP_RUN_TIMEOUT_MS = 2 h` (DISM can be slow); a timeout marks the run `failed` with `error: 'timed out'`.
- **Old-agent handling:** before queuing either command the route compares `device.agentVersion` (core semver, via the `agentEditionCompat` comparison helper) against `MIN_AGENT_VERSION_SYSTEM_CLEANUP` (the version W04 ships in, set at plan time) and returns `409 { error: 'agent_update_required', minAgentVersion }`. Defensive fallback: a command result whose `error` starts with `unknown command type:` also resolves to the same 409 shape on poll.
- Action-id validation: `actionIds` must be a subset of `SYSTEM_CLEANUP_ACTION_IDS` (shared constant in `packages/shared/src/validators/systemCleanup.ts`, mirrored by the agent catalog); `journalVacuumBytes` bounded `64 MiB … 4 GiB`. Nothing else from the client reaches an argv.

## 6. Agent — file engine (W01, W02)

### 6.1 Rule table replaces the substring classifier

`agent/internal/remote/tools/filesystem_cleanup_rules.go`:

```go
type cleanupRule struct {
    Category    string        // temp_files | browser_cache | package_cache | trash
    OS          []string      // runtime.GOOS values; empty = all
    Anchor      string        // normalised (lower, '/' separators) substring that must appear in the path
    SafeSubdirs []string      // relative to the anchor match; empty = everything under the anchor
    MinAge      time.Duration // 0 = no threshold
    Granularity string        // "file" (default) | "contents" (candidate = dir, delete children only)
}
```

v1 table (each row gets a positive and a negative unit test):

| Category | OS | Anchor | Safe sub-dirs | Min age | Granularity |
|---|---|---|---|---|---|
| temp_files | all | `/tmp/`, `/var/tmp/` | all | 24 h (payload `minAgeHours`, 1–720) | file |
| temp_files | windows | `/windows/temp/`, `/appdata/local/temp/` | all | 24 h | file |
| browser_cache | all | `/google/chrome/user data/`, `/microsoft/edge/user data/`, `/bravesoftware/brave-browser/user data/`, `/chromium/user data/` | `cache/`, `code cache/`, `gpucache/`, `service worker/cachestorage/`, `service worker/scriptcache/`, `dawncache/`, `shadercache/` | 0 | file |
| browser_cache | all | `/mozilla/firefox/` | `cache2/`, `startupcache/`, `shader-cache/` | 0 | file |
| browser_cache | darwin | `/library/caches/` (per-user and system) | all **except** `/library/caches/homebrew/` (package_cache) and `com.apple.bird/` (iCloud) | 0 | file |
| browser_cache | linux | `/.cache/` | all **except** `/.cache/pip/` (package_cache) | 0 | file |
| package_cache | linux | `/var/cache/apt/archives/`, `/var/cache/dnf/`, `/var/cache/yum/` | all | 0 | file |
| package_cache | all | `/.npm/_cacache/`, `/.cache/pip/`, `/appdata/local/pip/cache/`, `/library/caches/homebrew/`, `/programdata/chocolatey/cache/`, `/.nuget/packages/` (`.nupkg` files only) | all | 0 | file |
| package_cache | windows | `/appdata/local/packages/` | `*/ac/inetcache/`, `*/ac/temp/`, `*/tempstate/` | 0 | file |
| trash | windows | `<volume root>/$recycle.bin/<sid>/` | — | 0 | contents (keep `desktop.ini`) |
| trash | darwin | `/users/<name>/.trash/` | — | 0 | contents |
| trash | linux | `/home/<name>/.local/share/trash/`, `/root/.local/share/trash/` | — | 0 | contents |

Removed from the current classifier: bare `/google/chrome/user data/`, `/mozilla/firefox/` (profile roots), `/edge/user data/` (too loose), bare `/appdata/local/packages/`. `Safe` is no longer a constant: it is `true` only when a rule matched and the min-age check passed. The same rule table is compiled into the API as data (`packages/shared/src/utils/cleanupRules.ts`, generated from a JSON file checked in at `packages/shared/src/utils/cleanupRules.json` that the Go side `go:embed`s) so execute-time re-filtering (§5.2) uses identical rules. A test on each side asserts the embedded JSON hash matches.

### 6.2 Trash per volume

`getTrashPaths(scanRoot)` takes the scan root. On Windows, when the root is a volume root, it enumerates `<root>\$Recycle.Bin\S-*` directories and emits one `contents`-granularity candidate per SID dir with the summed size; when the root is not a volume root it emits nothing (bins live at the volume root). macOS/Linux behaviour is unchanged except candidates become `contents`-granular on the `.Trash`/`Trash` directory. The C-drive hardcode is deleted.

### 6.3 `file_delete` additions

- `permanent: true` — already supported; now sent by cleanup.
- `cleanupGuard: true` — `DeleteFile` uses `os.Lstat`; refuses symlinks and Windows reparse points (`FILE_ATTRIBUTE_REPARSE_POINT`) with `status: 'rejected'`; refuses if the path is not under a rule anchor (re-applying the embedded rule table — defence in depth against a forged execute body). Existing containment and boundary checks stay.
- `contentsOnly: true` — target must be a directory; children are `Lstat`ed and removed individually (symlinked children are skipped and reported, never followed); `desktop.ini` is preserved; the directory itself survives. Depth check applies to the directory, so `C:\$Recycle.Bin\S-1-5-21-…` (depth 2) passes while `C:\$Recycle.Bin` (depth 1) still fails.
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

Common runner: absolute binary paths resolved at init (`%SystemRoot%\System32\cleanmgr.exe`, `dism.exe`, `/usr/bin/tmutil`, `/usr/bin/apt-get`, `/usr/bin/dnf`, `/usr/bin/yum`, `/usr/bin/journalctl`), never `$PATH` lookup, never a shell; `exec.CommandContext` with a per-action timeout; stdout/stderr captured and capped at 16 KiB each; process tree killed on timeout (Windows: job object, POSIX: process group). Freed bytes per run = Σ over affected volumes of `disk.Usage(mount).Free` after − before, floored at 0, reported alongside per-action exit status. Argv builders are pure functions with table tests; parsers take fixture strings.

### 7.2 Catalog v1

| ID | OS | What it runs | Estimate | Timeout | Risk flags |
|---|---|---|---|---|---|
| `win_cleanmgr` | windows | For each selected handler sub-id, set `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches\<Handler>\StateFlags5555 = 2` (0 for all others in the allowlist), then `cleanmgr.exe /sagerun:5555`. `/d` is not supported with `/sagerun`, so all volumes are processed. | Per handler where a directory is known: `Update Cleanup` → none (opaque); `Delivery Optimization Files` → `%SystemRoot%\SoftwareDistribution\DeliveryOptimization`; `Previous Installations` → `%SystemDrive%\Windows.old`; `Upgrade Discarded Files` → `%SystemDrive%\$WINDOWS.~BT`, `$WINDOWS.~WS`; `Windows Upgrade Log Files` → `%SystemDrive%\$Windows.~BT\Sources\Panther`, `%SystemRoot%\Panther`; `Setup Log Files` → `%SystemRoot%\Logs`; `System error memory dump files` → `%SystemRoot%\MEMORY.DMP`; `System error minidump files` → `%SystemRoot%\Minidump`; `Windows Defender` → `%ProgramData%\Microsoft\Windows Defender\Scans\History\`; `Temporary Files` → `%SystemRoot%\Temp`; others → unknown | 60 min | `long_running` |
| `win_dism_component_cleanup` | windows | `dism.exe /Online /Cleanup-Image /StartComponentCleanup` (never `/ResetBase`) | `dism.exe /Online /Cleanup-Image /AnalyzeComponentStore` → parse `Backups and Disabled Features` + `Cache and Temporary Data`; `Component Store Cleanup Recommended : No` → estimate 0 | 90 min | `long_running`, `may_require_reboot_free_state` |
| `mac_tm_local_snapshots` | darwin | `tmutil thinlocalsnapshots / 9223372036854775807 4` (thin everything at max urgency) | `tmutil listlocalsnapshots /` → count only; bytes unknown | 10 min | — |
| `mac_brew_cleanup` | darwin | reuse `patching.runBrewCleanup` (per-user account handling included) | `brew cleanup --prune=all -n` parsed "Would remove: … (N files, X MB)" | 10 min | — |
| `linux_pkg_cache_clean` | linux | `apt-get clean` / `dnf clean all` / `yum clean all` (first present) | size of `/var/cache/apt/archives`, `/var/cache/dnf`, `/var/cache/yum` | 5 min | — |
| `linux_pkg_autoremove` | linux | `apt-get -y autoremove` / `dnf -y autoremove` | `apt-get -s autoremove` → "After this operation, X MB disk space will be freed"; `dnf --assumeno autoremove` → "Freed space: X" | 15 min | `removes_packages` (UI shows a warning badge and requires the confirm dialog's second checkbox) |
| `linux_journal_vacuum` | linux | `journalctl --vacuum-size=<bytes>` (param, default 256 MiB, bounded 64 MiB–4 GiB) | `journalctl --disk-usage` − target, floored at 0 | 5 min | — |

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

## 9. AI tools (W05)

- `disk_cleanup` gains `path` (normalised server-side; default OS root); preview stores a run and execute **must** pass that run's `cleanupRunId` (the tool's own state carries it between the two calls); `paths` capped at 200 like the route; empty-snapshot guard added; run-level audit written like the route.
- New `system_cleanup` tool: `action: 'list' | 'run'`, `actionIds`, `params`. `list` is Tier 1; `run` is Tier 3 (approval) with rate limit `2 / 3600 s`. Registered in `aiGuardrails.ts` (tier + rate), `aiToolSchemas.ts`, `aiTools.ts` registry, `aiAgents/agentToolCatalog.ts`, `aiAgents/actManifest.ts` (action ids only, no free-form argv), `packages/shared/src/utils/aiToolLabels.ts`, `helperToolFilter.ts` (denied to the Helper), `toolTimeouts.ts` (2 h). Mobile `toolIndicatorLogic` label added.
- Built-in "Disk Cleanup" playbook (`builtInPlaybooks.ts`) passes `cleanupRunId` through and adds an optional final `system_cleanup list` step for reporting only (no auto-run).

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
- **Lab (W05, before the agent release):** Windows rig `WIN-IMDR2GAIDMV` — scan `C:\` and a second volume, empty its bin, run `Update Cleanup` + DISM, confirm measured free-space delta; KIT `lab-ubuntu-src` — `apt-get clean`, journal vacuum, autoremove estimate matches. Results recorded on the W05 sub-issue.
- **Docs:** `apps/docs/src/content/docs/features/filesystem-analysis.mdx` rewritten for volumes, the finished tab, the native catalog, and the new tables/columns; release notes entry.

## 12. Advisor quorum

Fable position: the design above. Independent reviews and their resolution:

- **Codex `gpt-6-astra` xhigh, read-only** — attempted 2026-09-19 10:20 MDT; the Codex subscription was at its usage limit (resets 11:38 MDT). Re-run before any wave starts implementation; findings appended below.
- **Independent Opus review (stand-in, 2026-09-19)** — findings and resolutions appended below.
