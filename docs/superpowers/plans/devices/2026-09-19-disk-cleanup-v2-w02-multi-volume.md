---
tracking_issue: LanternOps/breeze#TBD-REGISTERED-AFTER-PLANS
---
# Disk Cleanup v2 W02: Multi-Volume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give filesystem analysis a scan-path axis, so a `D:\` or `/data` scan no longer resets the `C:\` baseline, pollutes its `hotDirectories`, or becomes the "latest" snapshot a `C:\` cleanup preview deletes from — and surface every fixed local volume as a first-class thing you can pick, scan and clean.

**Architecture:** Two idempotent migrations add `scan_path` to `device_filesystem_snapshots` / `device_filesystem_scan_state` / `device_filesystem_cleanup_runs`, re-key the scan-state primary key on `(device_id, scan_path)`, add `kind` + `command_id` to cleanup runs, and add the `running` cleanup-run status. One shared, browser-safe `normalizeScanPath(osType, path)` in `packages/shared/src/utils/scanPath.ts` is the single definition of the key, used by the API and the web. A new `services/filesystemVolumes.ts` turns `device_disks` rows into scannable `Volume`s (`isScannableVolume` + `NON_SCANNABLE_FS_TYPES`), which `GET /devices/:id/filesystem/volumes` serves and which the scan route uses for root detection and for the disk-percent delta. The schema and the code ship as ONE API release: `upsertFilesystemScanState`'s `ON CONFLICT` target moves with the primary key, and the two cannot be separated without `42P10`.

**Tech Stack:** TypeScript (Hono API, Drizzle ORM, Postgres 16), hand-written SQL migrations applied by `autoMigrate`, Vitest (unit + integration configs), React 19 + jsdom (`apps/web`), i18next across 8 locales. No Go, no agent release in this wave.

**Spec:** `docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md` — §2 defects 6 and 8, §3 row W02, §4 in full, §5.1 in full, §5.2 (the `path`/`scanPath` pinning only), §8 (the `VolumePicker` + `useFilesystemVolumes` + the mount into the existing tab only), §9 (the `path` parameter on `analyze_disk_usage` and `disk_cleanup` only), §11 (the API/web/docs rows that apply to this wave).

**Branch:** `feature/<parent#>-disk-cleanup-v2/wave-<subissue#>`

---

## Plan amendments

Every spec claim this wave depends on was re-verified against the working tree on 2026-09-19 (`main` at `e4525ea7e8`, branch `spec/disk-cleanup-v2`). Where the spec is wrong or under-specified, the verified fact and the plan's response are recorded here. Nothing below is a silent deviation.

1. **`normalizeScanPath` cannot use `node:path`, so the POSIX rules are implemented over plain strings.** Spec §4 says "POSIX — `path.posix.normalize`". But `packages/shared/src/utils/index.ts` is re-exported from the package root barrel (`packages/shared/src/index.ts:4`), which `apps/web` bundles, and `packages/shared/src/browserSafeBarrel.test.ts:22` fails any module transitively reachable from that barrel which imports a Node builtin — `path` is in its list, and the assertion at `:71` is `expect(offenders).toEqual([])`. Task 1 therefore ships a self-contained segment resolver (`.` / `..` / repeated separators) with no imports at all, and its test pins the cases `path.posix.normalize` would produce.

2. **The OS column is `devices.os_type`, not `devices.os`.** Spec §4 writes "`<os root from devices.os>`". Verified: `apps/api/src/db/schema/devices.ts:63` is `osType: osTypeEnum('os_type')`, and the enum at `:7` is `pgEnum('os_type', ['windows', 'macos', 'linux'])`. (`device.os` in `apps/web/src/components/devices/DeviceDetails.tsx:833` is the web DTO's field name, which is unrelated to the column.) The migration's backfill `CASE` keys on `d.os_type`.

3. **The snapshot backfill must normalise `raw_payload->>'path'`, not copy it — and rows carrying a dot segment are stored verbatim on purpose.** Spec §4 shows a bare `COALESCE(NULLIF(raw_payload->>'path',''), <os root>)`. Verified that today's scans accept any path (`scanFilesystemBodySchema`, `apps/api/src/routes/devices/filesystem.ts:32-42`) and that defect 6 itself names `c:\` (lower case) as a real shape. A verbatim copy would leave every historical row keyed on a form no normalised read ever matches, i.e. the whole existing snapshot history would vanish from the tab on deploy. The migration therefore mirrors §4's normalisation rules in SQL (separator conversion, repeated-separator collapse, drive-letter upper-casing, trailing-separator strip). The one rule it does NOT mirror is `.`/`..` resolution, which is impractical set-based SQL; a row whose recorded path contains a dot segment is stored **verbatim** and counted in a `RAISE WARNING`. Such a row is inert (it matches no normalised read) and the next scan supersedes it. Deliberately not re-keyed to the OS root, which would fold another volume's candidates into the root preview.

4. **The scan-state PK swap is guarded on the actual column list and names the constraint.** Spec §4's `DROP CONSTRAINT IF EXISTS …; ADD PRIMARY KEY (…)` rebuilds the PK index on every re-apply, and `db:check-drift` re-applies the whole set. Verified the baseline names it `device_filesystem_scan_state_pkey` (`apps/api/migrations/0001-baseline.sql:6920`) and that nothing references it — `git grep "REFERENCES.*device_filesystem" -- apps/api/migrations` is empty, and the only code references are `apps/api/src/services/filesystemAnalysis.ts:131` and `:178`. The migration guards on `pg_constraint.conkey` resolving to exactly `{device_id, scan_path}` and re-adds the constraint under its baseline name, so the Drizzle mirror can pin the same name (`primaryKey({ name: 'device_filesystem_scan_state_pkey', … })`, precedent `apps/api/src/db/schema/currency.ts:24`).

5. **`db:check-drift` does not compare the Drizzle mirror to the database.** Spec §4 says "`db:check-drift` must be clean", which is necessary but weaker than it reads: `apps/api/scripts/check-drift.ts:17-34` states in its own header that schema-vs-live-DB comparison is "intentionally NOT checked here" and that the script only applies the migration set to a fresh database and verifies the `breeze_migrations` ledger. The Drizzle mirror's correctness — composite PK, the three new columns, the index swap — is therefore proved by the replay integration suite in Task 5, which reads `pg_constraint` / `pg_indexes` and round-trips an insert through the Drizzle table objects.

6. **The agent result handler has no OS in scope, so it reads one.** Spec §5.1 says the handler "keys on `command.payload.path` (normalised)", but normalisation is OS-dependent and `handleFilesystemAnalysisCommandResult(command, resultData, orgId)` (`apps/api/src/routes/agents/helpers.ts:1593`) is called with `agent.orgId` only (`apps/api/src/routes/agents/commands.ts:525`); `AgentAuthContext` (`apps/api/src/middleware/agentAuth.ts:21-44`) carries `deviceId`, `agentId`, `orgId`, `siteId`, `partnerId`, `role` — no OS. Task 11 adds one indexed `devices.os_type` lookup ahead of the existing `Promise.all`, and returns without writing a snapshot (with a warning) when the device row is absent, rather than guessing POSIX and mis-keying a Windows device.

7. **`saveFilesystemSnapshot`'s argument list gains `scanPath` at index 3, and two live assertions destructure it positionally.** `apps/api/src/routes/agents.test.ts:1333-1336` and `:1376-1379` read `const [sfDeviceId, , sfTrigger, sfPayload] = vi.mocked(saveFilesystemSnapshot).mock.calls[0]!`. The new signature is `(deviceId, orgId, trigger, scanPath, payload)` — all scalars, then the blob. Both destructures are updated in the same task as the signature change (Task 6), so no task leaves the repo red.

8. **`disk_cleanup`'s Zod schema has no `path`; `analyze_disk_usage`'s already does.** Spec §9 says both "gain `path`". Verified `apps/api/src/services/aiToolSchemas.ts:987` already carries `path: safePath.optional()` under `analyze_disk_usage`, while `disk_cleanup` (`:998-1007`) does not. Task 12 adds the schema field to `disk_cleanup` only; both handlers change.

9. **`GET /filesystem` keeps `path` and ADDS `scanPath`.** `readSnapshotPath` (`apps/api/src/routes/devices/filesystem.ts:64-70`) reads `raw_payload.path` and is what the tab renders as "Scan Path" (`deviceFilesystemTab.scanPath`). The plan keeps `path` (the raw string the agent actually walked) and adds `scanPath` (the normalised key). Replacing `path` would silently change an existing panel in a wave whose scope explicitly excludes the panels.

10. **`cleanup-execute` gets no `path` field in W02, so it derives one.** §5.2's execute changes (required `cleanupRunId`, `rejectedPaths`, the budget) belong to W01/W03; this wave's §5.2 scope is the preview pinning plus `scanPath` in responses. The pinned lane therefore reads `device_filesystem_cleanup_runs.scan_path` (falling back to `plan.scanPath`, then the OS root); the unpinned fallback lane resolves to the OS root. That IS a behaviour change on the fallback lane — it used to take the newest snapshot of ANY path — and it is precisely defect 6's fix. W03 makes `cleanupRunId` required and deletes the lane.

11. **Cascade registration: verified unchanged, with the greps.** All three tables are already in `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts:443-445`), `CORE_DEVICE_CASCADE_DELETE_TABLES` (`apps/api/src/routes/devices/core.ts:282-283`) and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`apps/api/src/routes/devices/core.ts:588`). None carries a `ticket_id`, so `TICKET_ORG_DENORMALIZED_TABLES` / `CUSTOM_ORG_REWRITE_TABLES` (`apps/api/src/services/ticketOrgMoveLockOrder.ts`) are untouched — `git grep device_filesystem` in that file returns nothing. None is append-only, so `AUDIT_ADMIN_REQUIRED_TABLES` is untouched. RLS allowlists are untouched: all three are tenancy shape 1 (direct `org_id`), their policies are `breeze_has_org_access(org_id)` (`apps/api/migrations/2026-04-11-bucket-c-phase-3-device-state-rls.sql:81-89` for scan state, `:92-110` for snapshots) and are primary-key-independent, and `git grep device_filesystem -- apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` returns nothing. **The export policy is the one registry that fires**, because it fires on new COLUMNS — Task 4 adds all five.

12. **Locale values must not be bare filesystem paths.** `apps/web/src/lib/i18n/localeParity.test.ts:442` fails any locale leaf that "looks like a route or filesystem path". The volume chip therefore interpolates the mount point (`{{mountPoint}}`) rather than storing `C:\` in a catalog, and every new key is translated for real in all eight locales (`en`, `pt-BR`, `es-419`, `fr-FR`, `fr-CA`, `de-DE`, `it-IT`, `tr-TR` — the exact set asserted at `:422`).

13. **The two migration filenames were re-verified against `origin/main` today and they hold.** `git ls-tree -r --name-only origin/main -- apps/api/migrations | grep '\.sql$' | sort | tail` ends at `2026-10-20-140000-tickets-partner-org-composite-fk.sql`, so `2026-10-20-150000-…` and `2026-10-20-150100-…` both sort strictly after everything shipped under `localeCompare`. Spec §4's assumption is correct as of 2026-09-19. Task 2 Step 1 re-runs `scripts/check-migration-naming.sh --against-ref origin/main` at commit time; if `main` has moved past `150100`, bump the time component on BOTH files and record the new names as an amendment 14 here.

14. **W02 does NOT remove `DeviceFilesystemTab.tsx` from `runActionAllowlist.ts`.** Spec §8 says the tab "leaves `runActionAllowlist.ts`" — that is a W03 item, when the tab's mutations are rewritten. Verified `apps/web/src/lib/runActionAllowlist.ts:17` lists the file today. W02 adds only GET traffic (the volumes hook) and re-points existing request bodies; it introduces no new mutation, so the entry stays and `no-silent-mutations.test.ts` is unaffected.

---

## Global Constraints

- **Schema and code ship in ONE PR.** `upsertFilesystemScanState` currently uses `onConflictDoUpdate({ target: deviceFilesystemScanState.deviceId })` (`apps/api/src/services/filesystemAnalysis.ts:177-180`); after the PK swap that target has no unique index and every upsert fails with `42P10`. Never split this wave into a schema PR and a code PR (spec §4, "Writer contract change").
- **Migration filenames must sort strictly after every committed migration.** `2026-10-20-150000-filesystem-multi-volume.sql` then `2026-10-20-150100-filesystem-cleanup-run-status-running.sql`; re-check with `bash scripts/check-migration-naming.sh --against-ref origin/main` before pushing (CLAUDE.md, "Schema Migration Workflow").
- **The enum add is its own file with no other statements.** A label added by `ALTER TYPE` cannot be used in the transaction that added it, and `autoMigrate` wraps each file in one (spec §4; precedent `apps/api/migrations/2026-10-17-110400-report-type-endpoint-management-review.sql`).
- **Any migration that writes rows elects system scope first.** `PERFORM set_config('breeze.scope', 'system', true);` as the first statement inside every `DO` block that writes, per `apps/api/src/db/migrationRlsScope.test.ts`. Without it the backfill silently matches zero rows and `RAISE WARNING` prints a truthful-looking `0`. **Never add a file to that suite's `UNSCOPED_DML_BASELINE`.**
- **Migrations are idempotent and never edited once shipped.** `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP INDEX IF EXISTS`, `pg_constraint` existence checks, backfills gated on `WHERE scan_path IS NULL`. No inner `BEGIN;`/`COMMIT;` — `autoMigrate` owns the transaction.
- **Cleanup statements report row counts.** Every backfill wraps in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING …; END IF; END $$;`.
- **Test files live alongside their source.** `apps/api/src/services/filesystemVolumes.test.ts`, `apps/web/src/components/devices/filesystem/VolumePicker.test.tsx`, `packages/shared/src/utils/scanPath.test.ts`. The migration replay suite is the exception: it needs a live database, so it goes under `apps/api/src/__tests__/integration/`, which `vitest.integration.config.ts`'s shared glob already covers (no config edit needed — see the comments on `staleBackupReaper.integration.test.ts`).
- **Test commands.** API: `cd apps/api && npx vitest run <path>`. Web: `cd apps/web && npx vitest run <path>`. Shared: `cd packages/shared && npx vitest run <path>`. API integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`. **Never `pnpm --filter <pkg> test -- --run <path>`** — pnpm forwards the literal `--`, vitest swallows `--run` as a positional filter, and the whole suite runs in watch mode (CLAUDE.md, "Two traps"). Vitest path filters are plain substrings, so list sibling files explicitly and check the reported file count.
- **Typecheck commands (what CI's Type Check job runs, from the repo root).** `pnpm exec tsc --noEmit --project apps/api/tsconfig.json`; `pnpm --filter @breeze/shared typecheck`; `cd apps/web && pnpm exec astro check`.
- **Every web mutation goes through `runAction`.** This wave adds no mutation, so `apps/web/src/lib/runActionAllowlist.ts` is untouched (amendment 14).
- **New UI strings exist, translated, in all eight locales** under `apps/web/src/locales/<locale>/devices.json`, with matching interpolation tokens and no bare paths as values (`localeParity.test.ts`).
- **`db:check-drift` must pass** (`DATABASE_URL=… pnpm db:check-drift`) — it proves the migration set applies to a fresh database in filename order, which is what catches an ordering or idempotency bug (amendment 5).
- **File-size guideline.** `apps/web/src/components/devices/DeviceFilesystemTab.tsx` is already 958 lines and this wave adds to it. The full split into `filesystem/` is W03's job (spec §8); W02 puts its NEW code in `apps/web/src/components/devices/filesystem/` (hook + picker) and adds only the composition wiring to the tab, so the tab grows by well under 100 lines and W03 inherits two files it does not have to write.
- **Rigor is HIGH for Tasks 2–6 and 11** (migration, primary-key swap, tenant-export registry, the agent write path) and medium elsewhere. Red first on every task. Run the integration contract suites before the PR, always — this wave touches a cascade-registered table's columns.
- **Branch `feature/<parent#>-disk-cleanup-v2/wave-<subissue#>`; PR body contains `Closes #<subissue#>`. Run `get_feature_status` before starting and `start_wave` when you branch.**
- **Commit after every task**, with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Why this task order.** Tasks 1–5 land the contract (the key function, the schema, the registries, the proof) without changing a single reader. Task 6 moves the whole service onto the `(deviceId, scanPath)` axis and pins every existing caller to `osRootScanPath(device.osType)` — which is *exactly* today's behaviour, because today there is one scan-state row per device and one snapshot stream per device, and keying both on the OS root is the same row and the same stream. The repo compiles and every existing test passes after Task 6. Tasks 7–12 then replace that placeholder with the real per-volume path, one surface at a time. Tasks 13–14 do the UI, with the mount and its page-level test as a task of its own. Task 15 is docs; Task 16 is the verification gate.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/utils/scanPath.ts` (+ `.test.ts`) | `ScanPathOsType`, `osRootScanPath`, `normalizeScanPath` — the single definition of the key (Task 1) |
| `packages/shared/src/utils/index.ts` | barrel export for the above (Task 1) |
| `apps/api/migrations/2026-10-20-150000-filesystem-multi-volume.sql` | DDL + normalising backfills + the PK swap + `kind`/`command_id` (Task 2) |
| `apps/api/migrations/2026-10-20-150100-filesystem-cleanup-run-status-running.sql` | `ALTER TYPE … ADD VALUE 'running'`, alone (Task 3) |
| `apps/api/src/db/schema/filesystem.ts` | Drizzle mirror: `scanPath`, `kind`, `commandId`, the composite PK, the swapped index, the fourth enum label (Task 4) |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:230-232` | the five new columns classified `included` (Task 4) |
| `apps/api/src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts` | backfill correctness, PK/index/constraint shape, replay idempotency (Task 5) |
| `apps/api/src/services/filesystemAnalysis.ts` (+ `.test.ts`) | every reader/writer takes `scanPath`; `readPlanScanPath` (Task 6) |
| `apps/api/src/services/filesystemVolumes.ts` (+ `.test.ts`) | `NON_SCANNABLE_FS_TYPES`, `isScannableVolume`, `FilesystemVolume`, `listFilesystemVolumes` (Task 7) |
| `apps/api/src/routes/devices/filesystem.ts` (+ `.test.ts`) | `GET /filesystem/volumes`; `?path=`; root detection; disk-percent by matching volume; `scanPath` pinning and echo (Tasks 8, 9, 10) |
| `apps/api/src/routes/agents/helpers.ts` (+ `helpers.filesystemAnalysis.test.ts`, `agents.test.ts`) | result handler keyed on the normalised `command.payload.path`; disk-percent delta by matching `device_disks` row (Task 11) |
| `apps/api/src/services/aiToolsFilesystem.ts`, `apps/api/src/services/aiToolSchemas.ts` | `path` on `analyze_disk_usage` and `disk_cleanup` (Task 12) |
| `apps/web/src/components/devices/filesystem/useFilesystemVolumes.ts` (+ `.test.ts`) | abort-safe volumes hook (Task 13) |
| `apps/web/src/components/devices/filesystem/VolumePicker.tsx` (+ `.test.tsx`) | the chips (Task 13) |
| `apps/web/src/locales/*/devices.json` | ten new `deviceFilesystemTab.*` keys × 8 locales (Task 13) |
| `apps/web/src/components/devices/DeviceFilesystemTab.tsx` (+ `DeviceFilesystemTab.volumes.test.tsx`) | **mount**: render the picker, re-key every panel on the selection (Task 14) |
| `apps/docs/src/content/docs/features/filesystem-analysis.mdx`, `apps/api/src/data/docsIndex.json` | the volumes half of the docs (Task 15) |

---

### Task 1: `normalizeScanPath` — the single definition of the scan-path key

**Files:**
- Create: `packages/shared/src/utils/scanPath.ts`
- Create: `packages/shared/src/utils/scanPath.test.ts` (Test)
- Modify: `packages/shared/src/utils/index.ts` (append one export line)

**Interfaces:**
- Consumes: nothing. This module imports nothing at all, by design (amendment 1).
- Produces:
  ```ts
  export type ScanPathOsType = 'windows' | 'macos' | 'linux';
  export function osRootScanPath(osType: unknown): string;
  export function normalizeScanPath(osType: unknown, path: string): string;
  ```

- [ ] **Step 1: Write the failing test** — create `packages/shared/src/utils/scanPath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeScanPath, osRootScanPath } from './scanPath';

describe('osRootScanPath', () => {
  it('is the C: volume root on Windows and / everywhere else', () => {
    expect(osRootScanPath('windows')).toBe('C:\\');
    expect(osRootScanPath('macos')).toBe('/');
    expect(osRootScanPath('linux')).toBe('/');
  });

  it('treats an unknown or missing OS as POSIX rather than guessing Windows', () => {
    expect(osRootScanPath(null)).toBe('/');
    expect(osRootScanPath(undefined)).toBe('/');
    expect(osRootScanPath('freebsd')).toBe('/');
  });
});

describe('normalizeScanPath — Windows', () => {
  it('upper-cases the drive letter and keeps the trailing separator on a volume root', () => {
    expect(normalizeScanPath('windows', 'c:\\')).toBe('C:\\');
    expect(normalizeScanPath('windows', 'C:\\')).toBe('C:\\');
    expect(normalizeScanPath('windows', 'd:/')).toBe('D:\\');
    // A bare drive with no separator is the volume root, not a relative path.
    expect(normalizeScanPath('windows', 'c:')).toBe('C:\\');
  });

  it('converts separators, collapses repeats, and drops a trailing separator below the root', () => {
    expect(normalizeScanPath('windows', 'c:/Users//todd/')).toBe('C:\\Users\\todd');
    expect(normalizeScanPath('windows', 'C:\\\\Windows\\\\Temp\\\\')).toBe('C:\\Windows\\Temp');
  });

  it('preserves the case of everything that is not the drive letter', () => {
    expect(normalizeScanPath('windows', 'c:\\Users\\Todd\\AppData')).toBe('C:\\Users\\Todd\\AppData');
  });

  it('resolves . and .. the way path.win32.normalize would', () => {
    expect(normalizeScanPath('windows', 'C:\\a\\.\\b')).toBe('C:\\a\\b');
    expect(normalizeScanPath('windows', 'C:\\a\\b\\..\\c')).toBe('C:\\a\\c');
    // An absolute path cannot climb above its own volume root.
    expect(normalizeScanPath('windows', 'C:\\a\\..\\..\\..')).toBe('C:\\');
  });

  it('keeps exactly two leading separators on a UNC path so the volume filter can see it', () => {
    expect(normalizeScanPath('windows', '\\\\fileserver\\share\\')).toBe('\\\\fileserver\\share');
    expect(normalizeScanPath('windows', '//fileserver//share')).toBe('\\\\fileserver\\share');
  });

  it('falls back to the OS root for an empty or whitespace-only path', () => {
    expect(normalizeScanPath('windows', '')).toBe('C:\\');
    expect(normalizeScanPath('windows', '   ')).toBe('C:\\');
  });
});

describe('normalizeScanPath — POSIX', () => {
  it('keeps the root as the one path that ends in a separator', () => {
    expect(normalizeScanPath('linux', '/')).toBe('/');
    expect(normalizeScanPath('macos', '///')).toBe('/');
  });

  it('collapses repeated separators and drops the trailing one', () => {
    expect(normalizeScanPath('linux', '//var//tmp/')).toBe('/var/tmp');
    expect(normalizeScanPath('macos', '/Users/todd/')).toBe('/Users/todd');
  });

  it('is case-preserving — macOS volume names are not lower-cased', () => {
    expect(normalizeScanPath('macos', '/Volumes/Backup Drive')).toBe('/Volumes/Backup Drive');
  });

  it('resolves . and .. the way path.posix.normalize would', () => {
    expect(normalizeScanPath('linux', '/opt/./app')).toBe('/opt/app');
    expect(normalizeScanPath('linux', '/opt/app/../data')).toBe('/opt/data');
    expect(normalizeScanPath('linux', '/opt/../..')).toBe('/');
  });

  it('falls back to the OS root for an empty path', () => {
    expect(normalizeScanPath('linux', '')).toBe('/');
    expect(normalizeScanPath('linux', '  ')).toBe('/');
  });
});

describe('normalizeScanPath — the property the database key depends on', () => {
  it('is idempotent: normalising an already-normalised path changes nothing', () => {
    const cases: Array<[string, string]> = [
      ['windows', 'c:/Users//todd/'],
      ['windows', '\\\\fileserver\\share\\'],
      ['windows', 'd:'],
      ['linux', '//var//tmp/'],
      ['macos', '/Volumes/Backup Drive/'],
      ['linux', '/'],
    ];
    for (const [osType, raw] of cases) {
      const once = normalizeScanPath(osType, raw);
      expect(normalizeScanPath(osType, once)).toBe(once);
    }
  });

  it('collapses the case variants that defect 6 is about onto ONE key', () => {
    const keys = new Set([
      normalizeScanPath('windows', 'c:\\'),
      normalizeScanPath('windows', 'C:\\'),
      normalizeScanPath('windows', 'C:/'),
      normalizeScanPath('windows', 'c:'),
    ]);
    expect([...keys]).toEqual(['C:\\']);
  });

  it('keeps two different volumes on two different keys', () => {
    expect(normalizeScanPath('windows', 'd:\\')).not.toBe(normalizeScanPath('windows', 'c:\\'));
    expect(normalizeScanPath('linux', '/data')).not.toBe(normalizeScanPath('linux', '/'));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/shared && npx vitest run src/utils/scanPath.test.ts
```

Expected failure: `Failed to load .../src/utils/scanPath.test.ts` … `Cannot find module './scanPath'`.

- [ ] **Step 3: Implement** — create `packages/shared/src/utils/scanPath.ts`:

```ts
/**
 * Scan-path normalisation for multi-volume filesystem analysis
 * (disk cleanup v2 spec §4).
 *
 * `device_filesystem_snapshots.scan_path` and the `(device_id, scan_path)`
 * primary key of `device_filesystem_scan_state` are keyed on the NORMALISED
 * form, so every producer and every reader has to agree byte for byte. `c:\`
 * and `C:\` are the same volume; keying them separately IS defect 6 — a
 * lower-cased drive never resumes its own checkpoint, and a `D:\` scan lands
 * on top of the `C:\` baseline.
 *
 * THIS MODULE IMPORTS NOTHING, on purpose. It is reachable from
 * `@breeze/shared`'s root barrel, which `apps/web` bundles, and
 * `browserSafeBarrel.test.ts` fails any module in that closure which imports a
 * Node builtin — `node:path` included. The rules below are the subset of
 * `path.win32.normalize` / `path.posix.normalize` that scan paths need,
 * implemented over plain strings.
 *
 * Rules (spec §4):
 *   Windows — separators become `\`, repeats collapse, the drive letter is
 *   upper-cased, and a trailing `\` survives ONLY on a volume root (`C:\`,
 *   `D:\`). A UNC path keeps exactly two leading separators so the volumes
 *   filter can recognise and refuse it.
 *   POSIX  — repeats collapse, `.`/`..` resolve, and a trailing `/` survives
 *   only on `/` itself.
 * Case below the drive letter is PRESERVED on both: `/Users` and `/users` are
 * different directories on a case-sensitive volume, and folding them would
 * silently merge two scans.
 */

export type ScanPathOsType = 'windows' | 'macos' | 'linux';

function isWindowsOs(osType: unknown): boolean {
  return osType === 'windows';
}

/**
 * Resolves `.` and `..` over already-split segments.
 *
 * An ABSOLUTE path cannot climb above its own root, so a leading `..` is
 * dropped — that is what both `path` implementations do, and it is the safe
 * reading for a scan root. A relative path keeps its leading `..` so the
 * caller still sees what was asked for and can refuse it.
 */
function resolveSegments(segments: readonly string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
        continue;
      }
      if (absolute) continue;
      out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** The volume root a device scans when the caller names no path. */
export function osRootScanPath(osType: unknown): string {
  return isWindowsOs(osType) ? 'C:\\' : '/';
}

function normalizePosixScanPath(raw: string): string {
  const absolute = raw.startsWith('/');
  const segments = resolveSegments(raw.split('/'), absolute);
  if (segments.length === 0) return absolute ? '/' : '.';
  return `${absolute ? '/' : ''}${segments.join('/')}`;
}

function normalizeWindowsScanPath(raw: string): string {
  const slashed = raw.replace(/\//g, '\\');

  // UNC (`\\server\share`). The volumes service refuses these outright — they
  // are another machine's disk — so normalising rather than rejecting here
  // keeps that decision in exactly one place.
  if (slashed.startsWith('\\\\')) {
    const segments = resolveSegments(slashed.slice(2).split('\\'), true);
    return `\\\\${segments.join('\\')}`;
  }

  const driveMatch = /^([A-Za-z]):(.*)$/.exec(slashed);
  if (driveMatch) {
    const drive = driveMatch[1]!.toUpperCase();
    const rest = driveMatch[2]!;
    const absolute = rest.startsWith('\\');
    const segments = resolveSegments(rest.split('\\'), absolute);
    // `C:` and `C:\` are both the volume root; a drive-relative path
    // (`C:foo`) cannot be a scan root, so it is normalised absolute.
    if (segments.length === 0) return `${drive}:\\`;
    return `${drive}:\\${segments.join('\\')}`;
  }

  const absolute = slashed.startsWith('\\');
  const segments = resolveSegments(slashed.split('\\'), absolute);
  if (segments.length === 0) return absolute ? '\\' : '.';
  return `${absolute ? '\\' : ''}${segments.join('\\')}`;
}

/**
 * The stored/queried form of a scan path. Always call this before writing
 * `scan_path`, before reading by it, and before putting a path in a
 * `filesystem_analysis` command payload.
 */
export function normalizeScanPath(osType: unknown, path: string): string {
  const raw = typeof path === 'string' ? path.trim() : '';
  if (raw.length === 0) return osRootScanPath(osType);
  return isWindowsOs(osType) ? normalizeWindowsScanPath(raw) : normalizePosixScanPath(raw);
}
```

- [ ] **Step 4: Export it from the utils barrel** — append to `packages/shared/src/utils/index.ts`, after the `export * from './vulnerabilityManagement';` line that ends the file:

```ts
export * from './scanPath';
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd packages/shared && npx vitest run src/utils/scanPath.test.ts src/browserSafeBarrel.test.ts
```

Expected: `Test Files  2 passed (2)`. The barrel guard must be green — it is what proves the no-import rule (amendment 1) actually held.

- [ ] **Step 6: Typecheck the shared package**

```bash
pnpm --filter @breeze/shared typecheck
```

Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/utils/scanPath.ts packages/shared/src/utils/scanPath.test.ts packages/shared/src/utils/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): normalizeScanPath — one definition of the filesystem scan-path key

Spec §4. `c:\` and `C:\` are the same volume; keying them separately is defect
6. This is the function the API, the web tab and the migration backfill all
agree on. No imports at all: the module is reachable from the root barrel that
apps/web bundles, so node:path is not available (browserSafeBarrel.test.ts).

Nothing consumes it yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 1 — the scan-path axis, the PK swap, and the normalising backfills

**Files:**
- Create: `apps/api/migrations/2026-10-20-150000-filesystem-multi-volume.sql`

**Interfaces:**
- Consumes: `public.devices.os_type` (amendment 2), `public.device_filesystem_snapshots.raw_payload`.
- Produces: `device_filesystem_snapshots.scan_path text NOT NULL`; index `idx_device_filesystem_snapshots_device_path_captured`; `device_filesystem_scan_state.scan_path text NOT NULL` and `device_filesystem_scan_state_pkey PRIMARY KEY (device_id, scan_path)`; `device_filesystem_cleanup_runs.scan_path text NULL`, `.kind text NOT NULL DEFAULT 'files'` with `device_filesystem_cleanup_runs_kind_chk`, `.command_id uuid NULL`.

- [ ] **Step 1: Re-verify the filename sorts last (amendment 13)**

```bash
git fetch origin main --quiet
git ls-tree -r --name-only origin/main -- apps/api/migrations | grep -E '\.sql$' | sed 's|.*/||' | sort | tail -3
```

Expected: the last line is `2026-10-20-140000-tickets-partner-org-composite-fk.sql` (or something that still sorts before `2026-10-20-150000-`). If anything sorts at or after `2026-10-20-150000-`, pick later time components for BOTH files in this wave, use them everywhere below, and add the new names to this plan's "Plan amendments" as amendment 15 before continuing.

- [ ] **Step 2: Write the failing test** — this task's test is Task 5's replay suite, which cannot be written before the migration exists. The red step here is the guard that DOES run now: assert the file is absent and that the naming guard is clean once it lands. Run, before creating the file:

```bash
ls apps/api/migrations/2026-10-20-150000-filesystem-multi-volume.sql
```

Expected failure: `ls: apps/api/migrations/2026-10-20-150000-filesystem-multi-volume.sql: No such file or directory`.

- [ ] **Step 3: Implement** — create `apps/api/migrations/2026-10-20-150000-filesystem-multi-volume.sql`:

```sql
-- Disk Cleanup v2 W02 — the scan-path axis for filesystem analysis (spec §4).
--
-- WHAT THIS FIXES (spec §2 defect 6). Scan state is keyed per DEVICE and
-- snapshots record no path, so a `D:\` scan resets the `C:\` baseline,
-- pollutes its hotDirectories, and becomes the "latest" snapshot that a `C:\`
-- cleanup preview then deletes from.
--
-- SHIPS WITH ITS CODE. `upsertFilesystemScanState` uses
-- `onConflictDoUpdate({ target: deviceId })`; after the primary-key swap below
-- that target has no unique index and every upsert raises 42P10. The API
-- release that carries this migration MUST also carry the writer change. On a
-- multi-replica self-host the window between migration and the last old
-- replica draining makes old replicas fail scan-state upserts (the snapshot
-- insert itself still succeeds); a re-run scan repairs the state. Documented
-- in the release notes.
--
-- IDEMPOTENT. Every DDL statement is guarded, both backfills are gated on
-- `scan_path IS NULL`, and the primary-key swap is a no-op once the key
-- already has the right columns. No inner BEGIN/COMMIT: autoMigrate wraps each
-- file in one transaction.

-- ---------------------------------------------------------------------------
-- device_filesystem_snapshots
-- ---------------------------------------------------------------------------

ALTER TABLE public.device_filesystem_snapshots
  ADD COLUMN IF NOT EXISTS scan_path text;

DO $$
DECLARE
  n bigint;
  verbatim_rows bigint;
BEGIN
  -- 425 of 442 public tables are FORCE ROW LEVEL SECURITY, which binds the
  -- table OWNER — the role migrations run as. Without this election the UPDATE
  -- below matches ZERO rows with no error and the RAISE WARNING prints a
  -- truthful-looking 0; the JOIN to `devices` is policy-filtered the same way.
  -- `is_local = true` scopes it to autoMigrate's per-file transaction.
  PERFORM set_config('breeze.scope', 'system', true);

  -- Counted before the UPDATE so the warning can name it. A recorded path
  -- containing a `.` or `..` segment cannot be reproduced by this SQL mirror
  -- of normalizeScanPath (dot resolution is impractical set-based SQL), so
  -- such a row is stored VERBATIM: it matches no normalised read, becomes
  -- inert history, and the next scan of that volume supersedes it.
  -- Deliberately NOT re-keyed to the OS root, which would fold another
  -- volume's cleanup candidates into the root preview.
  SELECT count(*) INTO verbatim_rows
    FROM public.device_filesystem_snapshots
   WHERE scan_path IS NULL
     AND raw_payload->>'path' ~ '(^|[\\/])\.\.?([\\/]|$)';

  WITH src AS (
    SELECT s.id,
           d.os_type::text AS os_type,
           NULLIF(s.raw_payload->>'path', '') AS raw_path
      FROM public.device_filesystem_snapshots s
      JOIN public.devices d ON d.id = s.device_id
     WHERE s.scan_path IS NULL
  ),
  sep AS (
    -- Windows lane: '/' -> '\', then collapse runs of separators. The
    -- replacement '\\' is a SQL literal of TWO backslashes, which
    -- regexp_replace's replacement parser reads as ONE literal backslash; a
    -- lone '\' there would be read as an escape introducer.
    -- POSIX lane: collapse runs of '/'.
    SELECT src.id, src.os_type, src.raw_path, w.w0,
           regexp_replace(COALESCE(src.raw_path, '/'), '/{2,}', '/', 'g') AS p0
      FROM src
      CROSS JOIN LATERAL (
        SELECT regexp_replace(
                 replace(COALESCE(src.raw_path, 'C:\'), '/', '\'),
                 '\\{2,}', '\\', 'g') AS w0
      ) w
  ),
  drive AS (
    SELECT id, os_type, raw_path, p0,
           CASE WHEN w0 ~ '^[A-Za-z]:' THEN upper(left(w0, 1)) || substr(w0, 2)
                ELSE w0 END AS w
      FROM sep
  ),
  norm AS (
    SELECT id,
           CASE
             WHEN raw_path ~ '(^|[\\/])\.\.?([\\/]|$)' THEN raw_path
             WHEN os_type = 'windows' THEN
               CASE WHEN w ~ '^[A-Za-z]:\\$' THEN w
                    WHEN length(w) > 1 AND right(w, 1) = '\' THEN left(w, length(w) - 1)
                    ELSE w END
             ELSE
               CASE WHEN p0 = '/' THEN '/'
                    WHEN length(p0) > 1 AND right(p0, 1) = '/' THEN left(p0, length(p0) - 1)
                    ELSE p0 END
           END AS scan_path
      FROM drive
  )
  UPDATE public.device_filesystem_snapshots s
     SET scan_path = norm.scan_path
    FROM norm
   WHERE s.id = norm.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled % device_filesystem_snapshots.scan_path (% stored verbatim: recorded path carries a dot segment)', n, verbatim_rows;
  END IF;
END $$;

-- device_id FK-references devices(id) with no ON DELETE, so every snapshot has
-- a device row and the JOIN above is total. If that invariant is ever broken
-- this ALTER fails loudly, which is the correct outcome — do NOT add a silent
-- COALESCE repair here.
ALTER TABLE public.device_filesystem_snapshots
  ALTER COLUMN scan_path SET NOT NULL;

-- New index FIRST, old index second: never leave the latest-snapshot lookup
-- without a supporting index, even for the length of one transaction.
CREATE INDEX IF NOT EXISTS idx_device_filesystem_snapshots_device_path_captured
  ON public.device_filesystem_snapshots (device_id, scan_path, captured_at DESC);

DROP INDEX IF EXISTS idx_device_filesystem_snapshots_device_captured;

-- ---------------------------------------------------------------------------
-- device_filesystem_scan_state — composite key
-- ---------------------------------------------------------------------------

ALTER TABLE public.device_filesystem_scan_state
  ADD COLUMN IF NOT EXISTS scan_path text;

DO $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  -- Scan state records no path today, so every existing row IS the OS-root
  -- scan: one row per device, written by whatever scan ran last. Keying it on
  -- the OS root preserves exactly that row.
  UPDATE public.device_filesystem_scan_state st
     SET scan_path = CASE WHEN d.os_type::text = 'windows' THEN 'C:\' ELSE '/' END
    FROM public.devices d
   WHERE d.id = st.device_id
     AND st.scan_path IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled % device_filesystem_scan_state.scan_path to the OS root', n;
  END IF;
END $$;

ALTER TABLE public.device_filesystem_scan_state
  ALTER COLUMN scan_path SET NOT NULL;

DO $$
BEGIN
  -- Guarded on the ACTUAL key columns, not on the constraint's name: an
  -- unguarded DROP/ADD pair rebuilds the primary-key index on every re-apply,
  -- and db:check-drift re-applies the whole migration set. Re-added under the
  -- baseline name (0001-baseline.sql:6920) so the Drizzle mirror can pin it.
  -- Nothing FK-references this table, so the drop has no dependents.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.device_filesystem_scan_state'::regclass
       AND c.contype = 'p'
       AND (
         SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       ) = ARRAY['device_id', 'scan_path']
  ) THEN
    ALTER TABLE public.device_filesystem_scan_state
      DROP CONSTRAINT IF EXISTS device_filesystem_scan_state_pkey;
    ALTER TABLE public.device_filesystem_scan_state
      ADD CONSTRAINT device_filesystem_scan_state_pkey PRIMARY KEY (device_id, scan_path);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- device_filesystem_cleanup_runs
-- ---------------------------------------------------------------------------

-- Nullable on purpose: a W04 `kind='system'` run cleans the machine, not a
-- path, so it is not scan-path scoped.
ALTER TABLE public.device_filesystem_cleanup_runs
  ADD COLUMN IF NOT EXISTS scan_path text;

ALTER TABLE public.device_filesystem_cleanup_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'files';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'device_filesystem_cleanup_runs_kind_chk'
       AND conrelid = 'public.device_filesystem_cleanup_runs'::regclass
  ) THEN
    ALTER TABLE public.device_filesystem_cleanup_runs
      ADD CONSTRAINT device_filesystem_cleanup_runs_kind_chk
      CHECK (kind IN ('files', 'system'));
  END IF;
END $$;

-- The queued system_cleanup_run command (W04). No FK: device_commands rows are
-- pruned on their own schedule, and a pruned command must not delete the run
-- that records what was done.
ALTER TABLE public.device_filesystem_cleanup_runs
  ADD COLUMN IF NOT EXISTS command_id uuid;
```

- [ ] **Step 4: Run the naming guard and watch it pass**

```bash
git add apps/api/migrations/2026-10-20-150000-filesystem-multi-volume.sql
bash scripts/check-migration-naming.sh --staged
bash scripts/check-migration-naming.sh --against-ref origin/main
```

Expected: both exit 0 with no violation lines. If the `--against-ref` run reports that the file does not sort after `origin/main`'s newest, go back to Step 1.

- [ ] **Step 5: Prove the RLS-scope guard is satisfied and no baseline entry was added**

```bash
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts
```

Expected: `Test Files  1 passed (1)`. This is the guard that both backfills' `PERFORM set_config('breeze.scope','system', true)` exists. If it reports the new file as an unscoped offender, fix the migration — **never** add the filename to `UNSCOPED_DML_BASELINE`.

- [ ] **Step 6: Prove the file is discovered and ordered**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
```

Expected: `Test Files  1 passed (1)` — the filename matches the runner's `^\d{4}-.*\.sql$` pattern, adds nothing to the closed `2026-08-06` block, and every migration path referenced from `apps/api/src` still resolves.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-20-150000-filesystem-multi-volume.sql
git commit -m "$(cat <<'EOF'
feat(db): scan-path axis for filesystem analysis (spec §4)

Adds scan_path to device_filesystem_snapshots / _scan_state / _cleanup_runs,
re-keys scan state on (device_id, scan_path), swaps the snapshot index to
(device_id, scan_path, captured_at DESC), and adds kind + command_id for W04.

Both backfills elect breeze.scope=system first and report their row counts. A
snapshot whose recorded path carries a dot segment is stored verbatim — it
matches no normalised read and the next scan supersedes it — rather than being
re-keyed to the OS root, which would fold another volume's cleanup candidates
into the root preview.

The primary-key swap is guarded on the actual key columns so a re-apply is a
true no-op. The writer change ships in the same release: after this,
onConflictDoUpdate({ target: deviceId }) raises 42P10.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 2 — the `running` cleanup-run status, alone in its file

**Files:**
- Create: `apps/api/migrations/2026-10-20-150100-filesystem-cleanup-run-status-running.sql`

**Interfaces:**
- Consumes: the `filesystem_cleanup_run_status` enum (`apps/api/migrations/0006-filesystem-analysis.sql:8`).
- Produces: the label `running` on that enum, sorting after `previewed`, `executed`, `failed`.

- [ ] **Step 1: Write the failing check**

```bash
ls apps/api/migrations/2026-10-20-150100-filesystem-cleanup-run-status-running.sql
```

Expected failure: `ls: apps/api/migrations/2026-10-20-150100-filesystem-cleanup-run-status-running.sql: No such file or directory`.

- [ ] **Step 2: Implement** — create `apps/api/migrations/2026-10-20-150100-filesystem-cleanup-run-status-running.sql`:

```sql
-- Disk Cleanup v2 W02: the `running` cleanup-run status (spec §4). W04's
-- system-cleanup route inserts a row with status='running' before the agent
-- answers, so the label has to exist one release earlier than its first writer.
--
-- ENUM ADD ONLY, in its own file: a label added by ALTER TYPE cannot be USED
-- until the transaction that added it commits, and autoMigrate wraps each file
-- in one transaction. Precedent:
-- 2026-10-17-110400-report-type-endpoint-management-review.sql.
--
-- No rows are written, so no breeze.scope election is required. Idempotent.
ALTER TYPE filesystem_cleanup_run_status ADD VALUE IF NOT EXISTS 'running';
```

- [ ] **Step 3: Run the guards and watch them pass**

```bash
git add apps/api/migrations/2026-10-20-150100-filesystem-cleanup-run-status-running.sql
bash scripts/check-migration-naming.sh --staged
bash scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

Expected: the two guard scripts exit 0; `Test Files  2 passed (2)`.

- [ ] **Step 4: Prove the file contains exactly one statement**

```bash
grep -c ';' apps/api/migrations/2026-10-20-150100-filesystem-cleanup-run-status-running.sql
```

Expected: `1`. More than one statement in an enum-add file is the bug this file's separation exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-20-150100-filesystem-cleanup-run-status-running.sql
git commit -m "$(cat <<'EOF'
feat(db): add the `running` filesystem cleanup-run status

Spec §4. Its own file with a single statement, per the repo convention: a label
added by ALTER TYPE cannot be used in the transaction that adds it, and
autoMigrate wraps each file in one. First writer is W04's system-cleanup route.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Drizzle mirror and the tenant-export policy registry

**Files:**
- Modify: `apps/api/src/db/schema/filesystem.ts:1-72` (the whole file)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:230-232`
- Create: `apps/api/src/db/schema/filesystem.test.ts` (Test)

**Interfaces:**
- Consumes: `primaryKey` from `drizzle-orm/pg-core`.
- Produces:
  ```ts
  export const filesystemCleanupRunStatusEnum: PgEnum<['previewed','executed','failed','running']>;
  // deviceFilesystemSnapshots.scanPath: text NOT NULL
  // deviceFilesystemCleanupRuns.scanPath: text | null; .kind: text; .commandId: string | null
  // deviceFilesystemScanState: composite PK (deviceId, scanPath), named device_filesystem_scan_state_pkey
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/db/schema/filesystem.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  deviceFilesystemCleanupRuns,
  deviceFilesystemScanState,
  deviceFilesystemSnapshots,
  filesystemCleanupRunStatusEnum,
} from './filesystem';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

/**
 * The static half of the W02 schema contract. The LIVE half — that the
 * database actually has this shape — is
 * `__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts`;
 * `db:check-drift` does not compare the Drizzle mirror to a database at all
 * (apps/api/scripts/check-drift.ts:17-34), so neither test substitutes for the
 * other.
 */
describe('filesystem schema — the scan-path axis (spec §4)', () => {
  it('records scan_path on snapshots, NOT NULL', () => {
    const column = getTableConfig(deviceFilesystemSnapshots).columns
      .find((c) => c.name === 'scan_path');
    expect(column).toBeDefined();
    expect(column!.notNull).toBe(true);
  });

  it('indexes snapshots on (device_id, scan_path, captured_at) and drops the old two-column index', () => {
    const indexes = getTableConfig(deviceFilesystemSnapshots).indexes.map((i) => i.config.name);
    expect(indexes).toContain('idx_device_filesystem_snapshots_device_path_captured');
    expect(indexes).not.toContain('idx_device_filesystem_snapshots_device_captured');
  });

  it('keys scan state on (device_id, scan_path) under the baseline constraint name', () => {
    const config = getTableConfig(deviceFilesystemScanState);
    expect(config.primaryKeys).toHaveLength(1);
    const pk = config.primaryKeys[0]!;
    expect(pk.getName()).toBe('device_filesystem_scan_state_pkey');
    expect(pk.columns.map((c) => c.name)).toEqual(['device_id', 'scan_path']);
  });

  it('gives cleanup runs a nullable scan_path, a kind and a command_id', () => {
    const columns = getTableConfig(deviceFilesystemCleanupRuns).columns;
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get('scan_path')?.notNull).toBe(false);
    expect(byName.get('kind')?.notNull).toBe(true);
    expect(byName.get('command_id')).toBeDefined();
    expect(byName.get('command_id')!.notNull).toBe(false);
  });

  it('carries the running status, in the order Postgres sorts the labels', () => {
    expect(filesystemCleanupRunStatusEnum.enumValues).toEqual([
      'previewed',
      'executed',
      'failed',
      'running',
    ]);
  });
});

/**
 * CLAUDE.md: the export-policy row is the ONE registration list that fires on a
 * new COLUMN, not just a new table. Every column of every org-cascade table
 * must be classified, so ADD COLUMN on a long-registered table breaks
 * `tenant-export-policy.integration.test.ts` — which only runs under
 * Integration Tests, so a unit-green PR can still redden main. This unit test
 * moves that failure into Test API for the five columns this wave adds.
 */
describe('tenant export policy — W02 columns', () => {
  const expected: Array<[string, string[]]> = [
    ['device_filesystem_snapshots', ['scan_path']],
    ['device_filesystem_scan_state', ['scan_path']],
    ['device_filesystem_cleanup_runs', ['scan_path', 'kind', 'command_id']],
  ];

  for (const [table, columns] of expected) {
    for (const column of columns) {
      it(`classifies ${table}.${column} as included`, () => {
        const decision = CORE_TENANT_EXPORT_POLICY[table]?.columns[column];
        expect(decision, `${table}.${column} is unclassified`).toBeDefined();
        expect(decision!.decision).toBe('include');
      });
    }
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/db/schema/filesystem.test.ts
```

Expected failure: `expected undefined to be defined` on the first `scan_path` assertion, and `AssertionError: expected [ 'previewed', 'executed', 'failed' ] to deeply equal [ 'previewed', 'executed', 'failed', 'running' ]`.

- [ ] **Step 3: Implement the mirror** — replace the whole of `apps/api/src/db/schema/filesystem.ts` with:

```ts
import {
  pgEnum,
  pgTable,
  uuid,
  timestamp,
  boolean,
  jsonb,
  bigint,
  real,
  text,
  index,
  primaryKey
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

export const filesystemSnapshotTriggerEnum = pgEnum('filesystem_snapshot_trigger', ['on_demand', 'threshold']);
// `running` is last because that is the order ALTER TYPE added it
// (2026-10-20-150100-…), which is the order Postgres sorts the labels in.
export const filesystemCleanupRunStatusEnum = pgEnum('filesystem_cleanup_run_status', ['previewed', 'executed', 'failed', 'running']);

export const deviceFilesystemSnapshots = pgTable('device_filesystem_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /**
   * The NORMALISED volume/path this scan covered (spec §4). Always written
   * through `normalizeScanPath(osType, path)` (`@breeze/shared`) — a snapshot
   * keyed on a raw `c:\` would never be found by a `C:\` read, which is
   * defect 6.
   */
  scanPath: text('scan_path').notNull(),
  capturedAt: timestamp('captured_at').defaultNow().notNull(),
  trigger: filesystemSnapshotTriggerEnum('trigger').notNull().default('on_demand'),
  partial: boolean('partial').notNull().default(false),
  summary: jsonb('summary').notNull().default({}),
  largestFiles: jsonb('largest_files').notNull().default([]),
  largestDirs: jsonb('largest_dirs').notNull().default([]),
  tempAccumulation: jsonb('temp_accumulation').notNull().default([]),
  oldDownloads: jsonb('old_downloads').notNull().default([]),
  unrotatedLogs: jsonb('unrotated_logs').notNull().default([]),
  trashUsage: jsonb('trash_usage').notNull().default([]),
  duplicateCandidates: jsonb('duplicate_candidates').notNull().default([]),
  cleanupCandidates: jsonb('cleanup_candidates').notNull().default([]),
  errors: jsonb('errors').notNull().default([]),
  rawPayload: jsonb('raw_payload').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  devicePathCapturedIdx: index('idx_device_filesystem_snapshots_device_path_captured')
    .on(table.deviceId, table.scanPath, table.capturedAt.desc()),
}));

export const deviceFilesystemCleanupRuns = pgTable('device_filesystem_cleanup_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /** Nullable: a `kind='system'` run cleans the machine, not a path. */
  scanPath: text('scan_path'),
  /** 'files' (the itemized file engine) | 'system' (W04's native cleaners). */
  kind: text('kind').notNull().default('files'),
  /**
   * The queued `system_cleanup_run` command for a system run (W04). No FK:
   * device_commands rows are pruned independently, and a pruned command must
   * not take the record of what was done with it.
   */
  commandId: uuid('command_id'),
  requestedBy: uuid('requested_by').references(() => users.id),
  requestedAt: timestamp('requested_at').defaultNow().notNull(),
  approvedAt: timestamp('approved_at'),
  plan: jsonb('plan').notNull().default({}),
  executedActions: jsonb('executed_actions').notNull().default([]),
  bytesReclaimed: bigint('bytes_reclaimed', { mode: 'number' }).notNull().default(0),
  status: filesystemCleanupRunStatusEnum('status').notNull().default('previewed'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  deviceRequestedIdx: index('idx_device_filesystem_cleanup_runs_device_requested').on(table.deviceId, table.requestedAt),
}));

export const deviceFilesystemScanState = pgTable('device_filesystem_scan_state', {
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  /** Second half of the primary key — one checkpoint/baseline per VOLUME. */
  scanPath: text('scan_path').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  lastRunMode: text('last_run_mode').notNull().default('baseline'),
  lastBaselineCompletedAt: timestamp('last_baseline_completed_at'),
  lastDiskUsedPercent: real('last_disk_used_percent'),
  checkpoint: jsonb('checkpoint').notNull().default({}),
  aggregate: jsonb('aggregate').notNull().default({}),
  hotDirectories: jsonb('hot_directories').notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  // Named explicitly so it matches the constraint the migration re-adds
  // (the baseline's name). Precedent: schema/currency.ts:24.
  pk: primaryKey({
    name: 'device_filesystem_scan_state_pkey',
    columns: [table.deviceId, table.scanPath],
  }),
}));
```

- [ ] **Step 4: Implement the export-policy entries** — in `apps/api/src/services/tenantExportPolicyRegistry.ts`, replace the three lines at `:230-232` with:

```ts
  // W02 multi-volume (spec §4): scan_path is a normalised path string, kind is
  // a closed catalog value ('files'|'system'), command_id is a plain
  // device_commands identifier. All three are ordinary customer-visible
  // operational data — no open container, no SUSPICIOUS_NAME_PARTS hit — so
  // `included`. `plan` and `executed_actions` stay `excludedOpen` (jsonb), so
  // a system run's action list does not appear in a tenant export while kind,
  // status, bytes_reclaimed and requested_at do. Accepted.
  "device_filesystem_cleanup_runs": tablePolicy("org_id", {"included":["id","device_id","org_id","scan_path","kind","command_id","requested_by","requested_at","approved_at","bytes_reclaimed","status","error","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["plan","executed_actions"]}),
  "device_filesystem_scan_state": tablePolicy("org_id", {"included":["device_id","scan_path","org_id","last_run_mode","last_baseline_completed_at","last_disk_used_percent","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["checkpoint","aggregate","hot_directories"]}),
  "device_filesystem_snapshots": tablePolicy("org_id", {"included":["id","device_id","org_id","scan_path","captured_at","trigger","partial","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["summary","largest_files","largest_dirs","temp_accumulation","old_downloads","unrotated_logs","trash_usage","duplicate_candidates","cleanup_candidates","errors","raw_payload"]}),
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/db/schema/filesystem.test.ts
```

Expected: `Test Files  1 passed (1)`, 10 tests passed.

- [ ] **Step 6: Prove the cascade lists genuinely need no change (amendment 11)**

```bash
git grep -n 'device_filesystem' -- apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts
```

Expected: exactly five lines — `tenantCascade.ts:443,444,445` and `routes/devices/core.ts:282,283,588`  (the `core.ts:282-283` pair spans two source lines for three table names). All three tables are already registered in all three device/org cascade lists.

```bash
git grep -n 'device_filesystem' -- apps/api/src/services/ticketOrgMoveLockOrder.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
```

Expected: **no output.** No filesystem table carries a `ticket_id`, so the ticket-move lists do not apply; all three are tenancy shape 1 (direct `org_id`), so no RLS allowlist entry exists or is needed.

- [ ] **Step 7: Typecheck**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no output. `deviceId` losing `.primaryKey()` is not a type change (it stays `notNull`), and nothing switches exhaustively on the cleanup-run status enum — verified: the only consumers are `routes/devices/filesystem.ts:303`, `services/aiToolsFilesystem.ts:290` and `services/aiAgents/actRevalidation.ts:148`, all of which compare against a single literal.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema/filesystem.ts apps/api/src/db/schema/filesystem.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "$(cat <<'EOF'
feat(db): mirror the scan-path axis in Drizzle and classify the new columns

Spec §4. Composite PK on (device_id, scan_path) under the baseline constraint
name, the swapped snapshot index, scan_path/kind/command_id on cleanup runs,
and the fourth cleanup-run status label.

Five new columns classified `included` in CORE_TENANT_EXPORT_POLICY — the one
registration list that fires on a new COLUMN rather than a new table, and the
one that otherwise only reddens under Integration Tests. filesystem.test.ts
moves that failure into Test API.

Cascade lists verified unchanged: all three tables are already in
CORE_ORG_CASCADE_DELETE_ORDER, CORE_DEVICE_CASCADE_DELETE_TABLES and
CORE_DEVICE_ORG_DENORMALIZED_TABLES; none carries a ticket_id; none is
append-only; all three are tenancy shape 1 so no RLS allowlist applies.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The migration replay proof (live Postgres)

**Files:**
- Create: `apps/api/src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts` (Test)

**Interfaces:**
- Consumes: `getTestDb`, `./setup`, `createPartner`, `createOrganization`, `createSite` from `./db-utils`, `replayMigration` from `./replayMigration`, and the Drizzle tables from `../../db/schema/filesystem`.
- Produces: nothing importable. This is the live half of the contract that amendment 5 says `db:check-drift` cannot give.

> **Why this suite exists.** CI migrates schema-fresh in `globalSetup`, so both backfills have only ever run against ZERO rows — a green migration says nothing about whether the normalisation is right. This seeds the shapes production actually has, drops the constraint the migration adds, replays the file, and asserts the results. It also pins the PK/index/CHECK/enum shape, which is the half `db:check-drift` explicitly does not check.
>
> `vitest.integration.config.ts` sets `fileParallelism: false`, so the brief window in which `scan_path` is nullable cannot be observed by another suite. `setup.ts` TRUNCATEs `devices` CASCADE on `beforeEach`, which takes the snapshots with it, so every `it()` seeds its own fixtures. The file lives under `src/__tests__/integration/`, which the config's shared glob already covers — no config edit, and `integration-suite-coverage.integration.test.ts` stays green.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts`:

```ts
/**
 * Live-Postgres proof for 2026-10-20-150000-filesystem-multi-volume.sql and
 * 2026-10-20-150100-filesystem-cleanup-run-status-running.sql (spec §4).
 *
 * Prerequisites:
 *   pnpm test-stack up
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner, createSite } from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const MIGRATION = '2026-10-20-150000-filesystem-multi-volume.sql';
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedDevice(osType: 'windows' | 'linux') {
  const db = getTestDb();
  const partner = await createPartner({});
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const rows = (await db.execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${org!.id}, ${site!.id}, ${randomUUID()}, ${`fs-${osType}-${randomUUID().slice(0, 8)}`},
            ${osType}, '1', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { orgId: org!.id as string, deviceId: rows[0]!.id };
}

/**
 * Inserts a snapshot with scan_path forced back to NULL — the pre-migration
 * shape. The column is NOT NULL on a migrated database, so the constraint is
 * dropped for the duration; the migration's own `SET NOT NULL` restores it,
 * which is also what proves that statement runs.
 */
async function seedPreMigrationSnapshot(
  deviceId: string,
  orgId: string,
  rawPath: string | null,
): Promise<string> {
  const db = getTestDb();
  const rows = (await db.execute(sql`
    INSERT INTO device_filesystem_snapshots (device_id, org_id, scan_path, raw_payload)
    VALUES (${deviceId}, ${orgId}, NULL,
            ${JSON.stringify(rawPath === null ? {} : { path: rawPath })}::jsonb)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

async function scanPathOf(snapshotId: string): Promise<string | null> {
  const rows = (await getTestDb().execute(sql`
    SELECT scan_path FROM device_filesystem_snapshots WHERE id = ${snapshotId}
  `)) as unknown as Array<{ scan_path: string | null }>;
  return rows[0]?.scan_path ?? null;
}

async function dropScanPathNotNull() {
  await getTestDb().execute(sql`
    ALTER TABLE device_filesystem_snapshots ALTER COLUMN scan_path DROP NOT NULL
  `);
  await getTestDb().execute(sql`
    ALTER TABLE device_filesystem_scan_state ALTER COLUMN scan_path DROP NOT NULL
  `);
}

describe('2026-10-20-150000 — snapshot scan_path backfill', () => {
  runDb('normalises a Windows path: lower-case drive, mixed separators, repeats, trailing slash', async () => {
    const { deviceId, orgId } = await seedDevice('windows');
    await dropScanPathNotNull();
    const id = await seedPreMigrationSnapshot(deviceId, orgId, 'c:/Users//Todd/');

    await replayMigration(MIGRATION);

    // Drive letter upper-cased, separators converted and collapsed, trailing
    // separator dropped, and the case BELOW the drive preserved — byte for
    // byte what normalizeScanPath('windows', …) returns.
    expect(await scanPathOf(id)).toBe('C:\\Users\\Todd');
  });

  runDb('keeps the trailing separator on a Windows volume root', async () => {
    const { deviceId, orgId } = await seedDevice('windows');
    await dropScanPathNotNull();
    const root = await seedPreMigrationSnapshot(deviceId, orgId, 'c:\\');
    const second = await seedPreMigrationSnapshot(deviceId, orgId, 'd:/');

    await replayMigration(MIGRATION);

    expect(await scanPathOf(root)).toBe('C:\\');
    expect(await scanPathOf(second)).toBe('D:\\');
  });

  runDb('normalises a POSIX path and keeps / as /', async () => {
    const { deviceId, orgId } = await seedDevice('linux');
    await dropScanPathNotNull();
    const nested = await seedPreMigrationSnapshot(deviceId, orgId, '//var//tmp/');
    const root = await seedPreMigrationSnapshot(deviceId, orgId, '/');

    await replayMigration(MIGRATION);

    expect(await scanPathOf(nested)).toBe('/var/tmp');
    expect(await scanPathOf(root)).toBe('/');
  });

  runDb('falls back to the OS root when the snapshot recorded no path', async () => {
    const windows = await seedDevice('windows');
    const linux = await seedDevice('linux');
    await dropScanPathNotNull();
    const noKey = await seedPreMigrationSnapshot(windows.deviceId, windows.orgId, null);
    const empty = await seedPreMigrationSnapshot(linux.deviceId, linux.orgId, '');

    await replayMigration(MIGRATION);

    expect(await scanPathOf(noKey)).toBe('C:\\');
    expect(await scanPathOf(empty)).toBe('/');
  });

  runDb('stores a dot-segment path VERBATIM rather than re-keying it to the OS root', async () => {
    // Plan amendment 3. Such a row matches no normalised read, so it becomes
    // inert history. Re-keying it to '/' would fold another directory's
    // cleanup candidates into the root preview, which is the bug, not the fix.
    const { deviceId, orgId } = await seedDevice('linux');
    await dropScanPathNotNull();
    const dotted = await seedPreMigrationSnapshot(deviceId, orgId, '/opt/app/../data');

    await replayMigration(MIGRATION);

    expect(await scanPathOf(dotted)).toBe('/opt/app/../data');
    expect(await scanPathOf(dotted)).not.toBe('/');
  });

  runDb('restores NOT NULL on both tables after the backfill', async () => {
    const { deviceId, orgId } = await seedDevice('linux');
    await dropScanPathNotNull();
    await seedPreMigrationSnapshot(deviceId, orgId, '/');

    await replayMigration(MIGRATION);

    const rows = (await getTestDb().execute(sql`
      SELECT table_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = 'scan_path'
         AND table_name IN ('device_filesystem_snapshots', 'device_filesystem_scan_state')
       ORDER BY table_name
    `)) as unknown as Array<{ table_name: string; is_nullable: string }>;
    expect(rows).toEqual([
      { table_name: 'device_filesystem_scan_state', is_nullable: 'NO' },
      { table_name: 'device_filesystem_snapshots', is_nullable: 'NO' },
    ]);
  });
});

describe('2026-10-20-150000 — scan-state key and the rest of the shape', () => {
  runDb('backfills scan state to the OS root of its device', async () => {
    const windows = await seedDevice('windows');
    const linux = await seedDevice('linux');
    const db = getTestDb();
    await dropScanPathNotNull();
    for (const seeded of [windows, linux]) {
      await db.execute(sql`
        INSERT INTO device_filesystem_scan_state (device_id, org_id, scan_path)
        VALUES (${seeded.deviceId}, ${seeded.orgId}, NULL)
      `);
    }

    await replayMigration(MIGRATION);

    const rows = (await db.execute(sql`
      SELECT device_id, scan_path FROM device_filesystem_scan_state
       WHERE device_id IN (${windows.deviceId}, ${linux.deviceId})
    `)) as unknown as Array<{ device_id: string; scan_path: string }>;
    const byDevice = new Map(rows.map((r) => [r.device_id, r.scan_path]));
    expect(byDevice.get(windows.deviceId)).toBe('C:\\');
    expect(byDevice.get(linux.deviceId)).toBe('/');
  });

  runDb('keys scan state on (device_id, scan_path) under the baseline name', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT c.conname,
             (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
               AS cols
        FROM pg_constraint c
       WHERE c.conrelid = 'public.device_filesystem_scan_state'::regclass
         AND c.contype = 'p'
    `)) as unknown as Array<{ conname: string; cols: string[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conname).toBe('device_filesystem_scan_state_pkey');
    expect(rows[0]!.cols).toEqual(['device_id', 'scan_path']);
  });

  runDb('lets one device hold independent state for two volumes', async () => {
    // The whole point of the key swap: this INSERT used to be a PK violation.
    const { deviceId, orgId } = await seedDevice('windows');
    const db = getTestDb();
    // `'C:\\'` in TS source emits the SQL literal `'C:\'`, which with
    // standard_conforming_strings is one backslash. Writing `'C:\'` here would
    // escape the closing quote and break the template.
    await db.execute(sql`
      INSERT INTO device_filesystem_scan_state (device_id, org_id, scan_path, last_run_mode)
      VALUES (${deviceId}, ${orgId}, 'C:\\', 'baseline')
    `);
    await db.execute(sql`
      INSERT INTO device_filesystem_scan_state (device_id, org_id, scan_path, last_run_mode)
      VALUES (${deviceId}, ${orgId}, 'D:\\', 'incremental')
    `);

    const rows = (await db.execute(sql`
      SELECT scan_path, last_run_mode FROM device_filesystem_scan_state
       WHERE device_id = ${deviceId} ORDER BY scan_path
    `)) as unknown as Array<{ scan_path: string; last_run_mode: string }>;
    expect(rows).toEqual([
      { scan_path: 'C:\\', last_run_mode: 'baseline' },
      { scan_path: 'D:\\', last_run_mode: 'incremental' },
    ]);
  });

  runDb('swaps the snapshot index and drops the old one', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'device_filesystem_snapshots'
    `)) as unknown as Array<{ indexname: string }>;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('idx_device_filesystem_snapshots_device_path_captured');
    expect(names).not.toContain('idx_device_filesystem_snapshots_device_captured');
  });

  runDb('enforces the cleanup-run kind CHECK and defaults it to files', async () => {
    const { deviceId, orgId } = await seedDevice('linux');
    const db = getTestDb();
    const inserted = (await db.execute(sql`
      INSERT INTO device_filesystem_cleanup_runs (device_id, org_id)
      VALUES (${deviceId}, ${orgId}) RETURNING kind, scan_path, command_id
    `)) as unknown as Array<{ kind: string; scan_path: string | null; command_id: string | null }>;
    expect(inserted[0]).toEqual({ kind: 'files', scan_path: null, command_id: null });

    await expect(db.execute(sql`
      INSERT INTO device_filesystem_cleanup_runs (device_id, org_id, kind)
      VALUES (${deviceId}, ${orgId}, 'registry')
    `)).rejects.toThrow(/device_filesystem_cleanup_runs_kind_chk/);
  });

  runDb('carries the running cleanup-run status label', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'filesystem_cleanup_run_status'
       ORDER BY e.enumsortorder
    `)) as unknown as Array<{ enumlabel: string }>;
    expect(rows.map((r) => r.enumlabel)).toEqual(['previewed', 'executed', 'failed', 'running']);
  });

  runDb('is a true no-op on re-apply', async () => {
    const { deviceId, orgId } = await seedDevice('windows');
    const db = getTestDb();
    const id = await seedPreMigrationSnapshotOrExisting(deviceId, orgId);

    await replayMigration(MIGRATION);
    const afterFirst = await scanPathOf(id);
    await replayMigration(MIGRATION);
    const afterSecond = await scanPathOf(id);

    expect(afterSecond).toBe(afterFirst);

    const pk = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'public.device_filesystem_scan_state'::regclass AND contype = 'p'
    `)) as unknown as Array<{ n: number }>;
    expect(pk[0]!.n).toBe(1);
  });
});

/** A normal (already-migrated) insert — the replay must leave it untouched. */
async function seedPreMigrationSnapshotOrExisting(deviceId: string, orgId: string): Promise<string> {
  const rows = (await getTestDb().execute(sql`
    INSERT INTO device_filesystem_snapshots (device_id, org_id, scan_path, raw_payload)
    VALUES (${deviceId}, ${orgId}, 'D:\\', '{"path":"D:\\\\"}'::jsonb)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}
```

- [ ] **Step 2: Run it and watch it fail** — with a live database up (`pnpm test-stack up`):

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts
```

Expected failure BEFORE Tasks 2 and 3 are applied to the test database: `column "scan_path" of relation "device_filesystem_snapshots" does not exist`. If Tasks 2 and 3 are already committed, the test database created by `globalSetup` has them, and this run should pass — in that case delete the `scan_path` column by hand first (`ALTER TABLE device_filesystem_snapshots DROP COLUMN scan_path`) to watch it go red, then `pnpm test-stack down && pnpm test-stack up` to get a clean database back.

- [ ] **Step 3: Run it and watch it pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts
```

Expected: `Test Files  1 passed (1)`, 13 tests passed.

- [ ] **Step 4: Prove the integration-suite coverage contract is satisfied**

```bash
cd apps/api && npx vitest run --config vitest.config.integration-suite-coverage.ts
```

Expected: pass. The new file sits under `src/__tests__/integration/**`, which the config's shared glob already covers, so no `vitest.integration.config.ts` edit is required.

- [ ] **Step 5: Run the export-policy and erasure round-trip suites — the two that fire on a new column**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
```

Expected: `Test Files  3 passed (3)`. These are the suites CLAUDE.md records as catching the missed registration 5/5 while code review caught it 0/5 — and they only run under Integration Tests, so a unit-green PR can still redden main.

- [ ] **Step 6: Run the drift check**

```bash
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.test | cut -d= -f2-)" pnpm db:check-drift
```

Expected: the ledger has one row per migration file on disk, no ordering or idempotency error. (This proves the set applies to a fresh database in filename order; it does NOT compare the Drizzle mirror — see amendment 5.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts
git commit -m "$(cat <<'EOF'
test(db): live proof for the filesystem multi-volume migration

CI migrates schema-fresh, so both backfills have only ever run against zero
rows — a green migration says nothing about whether the normalisation is right.
This seeds the production shapes (lower-case drive, mixed separators, repeated
separators, trailing slash, missing path, dot segment), replays the file, and
asserts the result byte for byte against what normalizeScanPath returns.

Also pins the half db:check-drift explicitly does not check: the composite
primary key and its name, the index swap, the kind CHECK, the four enum labels,
and that one device can hold independent state for two volumes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Move `filesystemAnalysis.ts` onto the `(deviceId, scanPath)` axis

**Files:**
- Modify: `apps/api/src/services/filesystemAnalysis.ts:1-7` (imports), `:63-94` (`saveFilesystemSnapshot`), `:96-135` (the three readers), `:137-184` (`upsertFilesystemScanState`), and append `readPlanScanPath`
- Modify: `apps/api/src/services/filesystemAnalysis.test.ts` (append two describes)
- Modify: `apps/api/src/routes/devices/filesystem.ts:117`, `:167`, `:286`, `:378` (pin callers to the OS root)
- Modify: `apps/api/src/routes/agents/helpers.ts:1623`, `:1652`, `:1670` (pin callers to the OS root)
- Modify: `apps/api/src/services/aiToolsFilesystem.ts:164`, `:186`, `:266` (pin callers to the OS root)
- Modify: `apps/api/src/routes/agents.test.ts:1333-1336`, `:1376-1379` (positional destructure, amendment 7)

**Interfaces:**
- Consumes: `normalizeScanPath`, `osRootScanPath` from `@breeze/shared` (Task 1); `and` from `drizzle-orm`.
- Produces:
  ```ts
  export async function saveFilesystemSnapshot(deviceId: string, orgId: string, trigger: FilesystemSnapshotTrigger, scanPath: string, payload: AnyObject);
  export async function getLatestFilesystemSnapshot(deviceId: string, scanPath: string);
  export async function getLatestFilesystemCleanupSnapshot(deviceId: string, scanPath: string);
  //   -> { id, scanPath, capturedAt, partial, cleanupCandidates } | null
  export async function getFilesystemScanState(deviceId: string, scanPath: string);
  export async function upsertFilesystemScanState(deviceId: string, orgId: string, scanPath: string, updates: {...});
  export function readPlanScanPath(plan: unknown): string | null;
  ```

> **This task is behaviour-preserving on purpose.** Every existing caller is pinned to `osRootScanPath(device.osType)`. Today there is exactly one scan-state row per device and one snapshot stream per device; keying both on the OS root is the SAME row and the SAME stream. Tasks 9–12 then replace the pin with the real per-volume path, one surface at a time, so no task leaves the repo red and each is reviewable on its own.

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/services/filesystemAnalysis.test.ts`:

```ts
describe('readPlanScanPath', () => {
  it('reads the scan path a preview pinned into its stored plan', () => {
    expect(readPlanScanPath({ snapshotId: 's', scanPath: 'D:\\', preview: {} })).toBe('D:\\');
  });

  it('returns null for a plan with no pinned path, so the caller can fall back explicitly', () => {
    expect(readPlanScanPath({ snapshotId: 's' })).toBeNull();
    expect(readPlanScanPath(null)).toBeNull();
    expect(readPlanScanPath('not an object')).toBeNull();
    expect(readPlanScanPath({ scanPath: '' })).toBeNull();
    expect(readPlanScanPath({ scanPath: 42 })).toBeNull();
  });
});
```

and append a second describe that pins the conflict target, which is the one thing a mocked unit test CAN see and the one thing that breaks with `42P10` if it regresses:

```ts
describe('upsertFilesystemScanState — conflict target (spec §4 writer contract)', () => {
  it('conflicts on (deviceId, scanPath), not on deviceId alone', async () => {
    const onConflictDoUpdate = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ deviceId: 'device-1', scanPath: 'D:\\' }]),
    });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    vi.mocked(db.insert).mockImplementation(insert as never);

    await upsertFilesystemScanState('device-1', 'org-1', 'D:\\', { lastRunMode: 'baseline' });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-1',
      orgId: 'org-1',
      scanPath: 'D:\\',
    }));
    const target = onConflictDoUpdate.mock.calls[0]![0].target;
    // An array of TWO columns. A single column here is the 42P10 regression:
    // after the primary-key swap, `target: deviceId` names no unique index.
    expect(Array.isArray(target)).toBe(true);
    expect(target).toHaveLength(2);
    expect(target.map((column: { name: string }) => column.name)).toEqual(['device_id', 'scan_path']);
  });
});
```

This second describe needs the module under test to see a mocked `db`, so add at the TOP of `apps/api/src/services/filesystemAnalysis.test.ts`, above the existing imports:

```ts
import { vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));
```

and extend the existing import from `./filesystemAnalysis` with `readPlanScanPath` and `upsertFilesystemScanState`, and add `import { db } from '../db';`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/filesystemAnalysis.test.ts
```

Expected failure: `SyntaxError: The requested module './filesystemAnalysis' does not provide an export named 'readPlanScanPath'`.

- [ ] **Step 3: Implement the service** — in `apps/api/src/services/filesystemAnalysis.ts`, change the import line at `:1` from `import { desc, eq } from 'drizzle-orm';` to:

```ts
import { and, desc, eq } from 'drizzle-orm';
```

Replace `saveFilesystemSnapshot` (`:63-94`) with:

```ts
/**
 * @param scanPath the NORMALISED volume/path this scan covered
 *   (`normalizeScanPath` from `@breeze/shared`). It is the second half of the
 *   key every reader uses — a raw `c:\` here is invisible to a `C:\` read.
 */
export async function saveFilesystemSnapshot(
  deviceId: string,
  orgId: string,
  trigger: FilesystemSnapshotTrigger,
  scanPath: string,
  payload: AnyObject
) {
  const summary = asRecord(payload.summary) ?? {};
  const partial = asBoolean(payload.partial, false);

  const [snapshot] = await db
    .insert(deviceFilesystemSnapshots)
    .values({
      deviceId,
      orgId,
      scanPath,
      trigger,
      partial,
      summary,
      largestFiles: asArray(payload.topLargestFiles),
      largestDirs: asArray(payload.topLargestDirectories),
      tempAccumulation: asArray(payload.tempAccumulation),
      oldDownloads: asArray(payload.oldDownloads),
      unrotatedLogs: asArray(payload.unrotatedLogs),
      trashUsage: asArray(payload.trashUsage),
      duplicateCandidates: asArray(payload.duplicateCandidates),
      cleanupCandidates: asArray(payload.cleanupCandidates),
      errors: asArray(payload.errors),
      rawPayload: payload,
    })
    .returning();

  return snapshot ?? null;
}
```

Replace the three readers (`:96-135`) with:

```ts
export async function getLatestFilesystemSnapshot(deviceId: string, scanPath: string) {
  const [snapshot] = await db
    .select()
    .from(deviceFilesystemSnapshots)
    .where(and(
      eq(deviceFilesystemSnapshots.deviceId, deviceId),
      eq(deviceFilesystemSnapshots.scanPath, scanPath),
    ))
    .orderBy(desc(deviceFilesystemSnapshots.capturedAt))
    .limit(1);

  return snapshot ?? null;
}

/**
 * Slim variant for the cleanup preview/execute paths and the volumes list,
 * which need the snapshot's identity and its cleanup candidates but none of
 * the other large jsonb columns (largest files/dirs, duplicates, the duplicate
 * rawPayload blob). `capturedAt`/`partial` are cheap scalars and are what the
 * volumes list renders next to each chip.
 */
export async function getLatestFilesystemCleanupSnapshot(deviceId: string, scanPath: string) {
  const [snapshot] = await db
    .select({
      id: deviceFilesystemSnapshots.id,
      scanPath: deviceFilesystemSnapshots.scanPath,
      capturedAt: deviceFilesystemSnapshots.capturedAt,
      partial: deviceFilesystemSnapshots.partial,
      cleanupCandidates: deviceFilesystemSnapshots.cleanupCandidates,
    })
    .from(deviceFilesystemSnapshots)
    .where(and(
      eq(deviceFilesystemSnapshots.deviceId, deviceId),
      eq(deviceFilesystemSnapshots.scanPath, scanPath),
    ))
    .orderBy(desc(deviceFilesystemSnapshots.capturedAt))
    .limit(1);

  return snapshot ?? null;
}

export async function getFilesystemScanState(deviceId: string, scanPath: string) {
  const [state] = await db
    .select()
    .from(deviceFilesystemScanState)
    .where(and(
      eq(deviceFilesystemScanState.deviceId, deviceId),
      eq(deviceFilesystemScanState.scanPath, scanPath),
    ))
    .limit(1);

  return state ?? null;
}
```

Replace `upsertFilesystemScanState`'s signature, insert values and conflict target (`:137-184`):

```ts
export async function upsertFilesystemScanState(
  deviceId: string,
  orgId: string,
  scanPath: string,
  updates: {
    lastRunMode?: string;
    lastBaselineCompletedAt?: Date | null;
    lastDiskUsedPercent?: number | null;
    checkpoint?: unknown;
    aggregate?: unknown;
    hotDirectories?: unknown;
  }
) {
  const now = new Date();
  const insertValues: typeof deviceFilesystemScanState.$inferInsert = {
    deviceId,
    orgId,
    scanPath,
    lastRunMode: updates.lastRunMode ?? 'baseline',
    lastBaselineCompletedAt: updates.lastBaselineCompletedAt ?? null,
    lastDiskUsedPercent: updates.lastDiskUsedPercent ?? null,
    checkpoint: updates.checkpoint ?? {},
    aggregate: updates.aggregate ?? {},
    hotDirectories: updates.hotDirectories ?? [],
    createdAt: now,
    updatedAt: now,
  };

  const updateSet: Partial<typeof deviceFilesystemScanState.$inferInsert> = {
    updatedAt: now,
  };

  if (updates.lastRunMode !== undefined) updateSet.lastRunMode = updates.lastRunMode;
  if (updates.lastBaselineCompletedAt !== undefined) updateSet.lastBaselineCompletedAt = updates.lastBaselineCompletedAt;
  if (updates.lastDiskUsedPercent !== undefined) updateSet.lastDiskUsedPercent = updates.lastDiskUsedPercent;
  if (updates.checkpoint !== undefined) updateSet.checkpoint = updates.checkpoint;
  if (updates.aggregate !== undefined) updateSet.aggregate = updates.aggregate;
  if (updates.hotDirectories !== undefined) updateSet.hotDirectories = updates.hotDirectories;

  const [state] = await db
    .insert(deviceFilesystemScanState)
    .values(insertValues)
    .onConflictDoUpdate({
      // The composite primary key (2026-10-20-150000). A single-column target
      // here names no unique index and every upsert raises 42P10 — which is
      // why this change and that migration ship in one release (spec §4).
      target: [deviceFilesystemScanState.deviceId, deviceFilesystemScanState.scanPath],
      set: updateSet,
    })
    .returning();

  return state ?? null;
}
```

Append `readPlanScanPath` at the end of the file, next to `readPlanPreviewCandidates`:

```ts
/**
 * Extracts the scan path a cleanup preview pinned into its stored `plan`
 * (jsonb). Cleanup-execute takes no `path` of its own in W02, so a pinned run
 * is the only place the volume is recorded when the row's `scan_path` column
 * predates this wave. Returns null rather than guessing, so the caller falls
 * back to the OS root explicitly.
 */
export function readPlanScanPath(plan: unknown): string | null {
  const record = asRecord(plan);
  return asString(record?.scanPath);
}
```

- [ ] **Step 4: Pin the four call-site groups to the OS root (behaviour-preserving)**

In `apps/api/src/routes/devices/filesystem.ts`, add to the imports:

```ts
import { osRootScanPath } from '@breeze/shared';
```

then at `:117` `getLatestFilesystemSnapshot(deviceId, osRootScanPath((device as { osType?: unknown }).osType))`; at `:167` `getFilesystemScanState(deviceId, osRootScanPath((device as { osType?: unknown }).osType))`; at `:286` and `:378` `getLatestFilesystemCleanupSnapshot(deviceId, osRootScanPath((device as { osType?: unknown }).osType))`.

In `apps/api/src/routes/agents/helpers.ts`, the handler has no OS in scope until Task 11 adds the `devices.os_type` read, so the pin is a named constant rather than a call. Add it at the top of that file's "Filesystem Analysis" section (above `getFilesystemThresholdScanPath`, `:1516`):

```ts
/**
 * W02 Task 6 transitional pin. The handler has no OS in scope yet (plan
 * amendment 6), and before this wave every snapshot and every scan-state row
 * was device-keyed with no path — which is exactly `'/'` for POSIX devices and
 * `'C:\'` for Windows ones. Task 11 reads `devices.os_type` and replaces this
 * with the normalised `command.payload.path`. Until then the POSIX root
 * preserves today's single-stream behaviour for the majority case and Task 11
 * lands in the same PR, so no deployment ever sees this value.
 */
const W02_TRANSITIONAL_SCAN_PATH = '/';
```

Use `W02_TRANSITIONAL_SCAN_PATH` at `:1623` (the second argument to `getFilesystemScanState`), `:1652` (the new fourth argument to `saveFilesystemSnapshot`) and `:1670` (the new third argument to `upsertFilesystemScanState`). Task 11 deletes the constant, and Task 11's Step 5 greps for it so it cannot survive the wave.

In `apps/api/src/services/aiToolsFilesystem.ts`, add `import { osRootScanPath } from '@breeze/shared';` and pin `:164` / `:186` / `:266` to `osRootScanPath(access.device.osType)`.

- [ ] **Step 5: Fix the two positional destructures (amendment 7)**

In `apps/api/src/routes/agents.test.ts`, replace both occurrences of

```ts
      const [sfDeviceId, , sfTrigger, sfPayload] =
        vi.mocked(saveFilesystemSnapshot).mock.calls[0]!;
```

with

```ts
      // (deviceId, orgId, trigger, scanPath, payload) since W02 — scanPath is
      // index 3, so the payload moved to index 4.
      const [sfDeviceId, , sfTrigger, , sfPayload] =
        vi.mocked(saveFilesystemSnapshot).mock.calls[0]!;
```

- [ ] **Step 6: Run it and watch it pass**

```bash
cd apps/api && npx vitest run \
  src/services/filesystemAnalysis.test.ts \
  src/routes/devices/filesystem.test.ts \
  src/routes/agents/helpers.filesystemAnalysis.test.ts \
  src/routes/agents.test.ts \
  src/services/aiToolsFilesystem.diskCleanupRequestedBy.test.ts \
  src/services/aiToolsFilesystem.fileWriteCap.test.ts
```

Expected: `Test Files  6 passed (6)`. Every path is a full filename — a trailing-slash directory filter would silently skip the dotted siblings (`aiToolsFilesystem.fileWriteCap.test.ts` vs `aiToolsFilesystem/`).

- [ ] **Step 7: Typecheck**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no output. Every caller of the five changed functions now passes a `scanPath`; the compiler is what proves the sweep is complete.

- [ ] **Step 8: Prove no caller was missed**

```bash
git grep -n 'getLatestFilesystemSnapshot(\|getLatestFilesystemCleanupSnapshot(\|getFilesystemScanState(\|upsertFilesystemScanState(\|saveFilesystemSnapshot(' -- apps ee packages | grep -v '\.test\.ts'
```

Expected: matches only in `apps/api/src/services/filesystemAnalysis.ts` (the definitions), `apps/api/src/routes/devices/filesystem.ts`, `apps/api/src/routes/agents/helpers.ts` and `apps/api/src/services/aiToolsFilesystem.ts` — and every one of those call sites has two or more arguments.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/filesystemAnalysis.ts apps/api/src/services/filesystemAnalysis.test.ts \
  apps/api/src/routes/devices/filesystem.ts apps/api/src/routes/agents/helpers.ts \
  apps/api/src/services/aiToolsFilesystem.ts apps/api/src/routes/agents.test.ts
git commit -m "$(cat <<'EOF'
refactor(filesystem): key every snapshot and scan-state read/write on a scan path

Spec §4 writer contract. upsertFilesystemScanState's ON CONFLICT target moves
to (deviceId, scanPath) with the primary key — a single-column target names no
unique index after the migration and raises 42P10, which is why the two ship
together.

Behaviour-preserving: every existing caller is pinned to the OS root, which is
the same single row and the same single stream the device-keyed schema had.
Tasks 9-12 replace the pin with the real per-volume path.

Adds readPlanScanPath so cleanup-execute can recover the volume a preview
pinned, and extends getLatestFilesystemCleanupSnapshot with capturedAt/partial
for the volumes list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `filesystemVolumes.ts` — which disks are scannable, and what we know about each

**Files:**
- Create: `apps/api/src/services/filesystemVolumes.ts`
- Create: `apps/api/src/services/filesystemVolumes.test.ts` (Test)

**Interfaces:**
- Consumes: `normalizeScanPath`, `osRootScanPath` (`@breeze/shared`); `db`, `deviceDisks`; `buildCleanupPreview`, `getFilesystemScanState`, `getLatestFilesystemCleanupSnapshot`, `readCheckpointPendingDirectories` (`./filesystemAnalysis`).
- Produces:
  ```ts
  export const NON_SCANNABLE_FS_TYPES: ReadonlySet<string>;
  export const MAX_VOLUMES_PER_DEVICE = 24;
  export type FilesystemVolume = {
    mountPoint: string; scanPath: string; fsType: string | null;
    totalGb: number | null; usedGb: number | null; freeGb: number | null; usedPercent: number | null;
    isOsRoot: boolean;
    scanState: { lastRunMode: string; lastBaselineCompletedAt: string | null; hasCheckpoint: boolean } | null;
    latestSnapshot: { id: string; capturedAt: string; partial: boolean; cleanupEstimateBytes: number } | null;
  };
  export function isScannableVolume(volume: { mountPoint?: string | null; fsType?: string | null }, osType: unknown): boolean;
  export function listFilesystemVolumes(deviceId: string, osType: unknown): Promise<FilesystemVolume[]>;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/filesystemVolumes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../db/schema', () => ({
  deviceDisks: { deviceId: { name: 'device_id' } },
}));
vi.mock('./filesystemAnalysis', () => ({
  getFilesystemScanState: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(),
  readCheckpointPendingDirectories: vi.fn(() => []),
  buildCleanupPreview: vi.fn(() => ({ estimatedBytes: 0 })),
}));

import { db } from '../db';
import {
  buildCleanupPreview,
  getFilesystemScanState,
  getLatestFilesystemCleanupSnapshot,
  readCheckpointPendingDirectories,
} from './filesystemAnalysis';
import { isScannableVolume, listFilesystemVolumes, NON_SCANNABLE_FS_TYPES } from './filesystemVolumes';

function mockDisks(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
  vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue(null as never);
  vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
  vi.mocked(buildCleanupPreview).mockReturnValue({ estimatedBytes: 0 } as never);
});

describe('isScannableVolume (spec §5.1)', () => {
  it('accepts an ordinary fixed volume on every OS', () => {
    expect(isScannableVolume({ mountPoint: 'C:\\', fsType: 'NTFS' }, 'windows')).toBe(true);
    expect(isScannableVolume({ mountPoint: '/', fsType: 'apfs' }, 'macos')).toBe(true);
    expect(isScannableVolume({ mountPoint: '/data', fsType: 'ext4' }, 'linux')).toBe(true);
  });

  it('refuses every filesystem type in NON_SCANNABLE_FS_TYPES, case-insensitively', () => {
    for (const fsType of NON_SCANNABLE_FS_TYPES) {
      expect(isScannableVolume({ mountPoint: '/mnt/x', fsType }, 'linux')).toBe(false);
      expect(isScannableVolume({ mountPoint: '/mnt/x', fsType: fsType.toUpperCase() }, 'linux')).toBe(false);
    }
  });

  it('refuses every fuse* variant by prefix, not by exact name', () => {
    for (const fsType of ['fuse', 'fuseblk', 'fuse.sshfs', 'fuse.gvfsd-fuse', 'FUSE.rclone']) {
      expect(isScannableVolume({ mountPoint: '/mnt/x', fsType }, 'linux')).toBe(false);
    }
  });

  it('refuses a Windows UNC mount point — that is another machine\u2019s disk', () => {
    expect(isScannableVolume({ mountPoint: '\\\\fileserver\\share', fsType: 'NTFS' }, 'windows')).toBe(false);
    expect(isScannableVolume({ mountPoint: '//fileserver/share', fsType: 'NTFS' }, 'windows')).toBe(false);
  });

  it('refuses an empty or missing mount point', () => {
    expect(isScannableVolume({ mountPoint: '', fsType: 'ext4' }, 'linux')).toBe(false);
    expect(isScannableVolume({ mountPoint: '   ', fsType: 'ext4' }, 'linux')).toBe(false);
    expect(isScannableVolume({ mountPoint: null, fsType: 'ext4' }, 'linux')).toBe(false);
  });

  it('accepts a volume whose filesystem type the agent did not report', () => {
    // The OS told us a mount point exists; refusing on a missing label would
    // hide real fixed volumes on agents that do not populate fsType.
    expect(isScannableVolume({ mountPoint: 'D:\\', fsType: null }, 'windows')).toBe(true);
    expect(isScannableVolume({ mountPoint: 'D:\\', fsType: '' }, 'windows')).toBe(true);
  });
});

describe('listFilesystemVolumes (spec §5.1)', () => {
  it('normalises the mount point into a scan path and flags the OS root', async () => {
    mockDisks([
      { mountPoint: 'c:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80 },
      { mountPoint: 'd:/', fsType: 'NTFS', totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: 5 },
    ]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'windows');

    expect(volumes.map((v) => v.scanPath)).toEqual(['C:\\', 'D:\\']);
    expect(volumes[0]!.isOsRoot).toBe(true);
    expect(volumes[1]!.isOsRoot).toBe(false);
    expect(volumes[0]!.mountPoint).toBe('c:\\');   // the raw string stays visible
    expect(volumes[1]!.usedPercent).toBe(5);
  });

  it('drops non-scannable rows', async () => {
    mockDisks([
      { mountPoint: '/', fsType: 'ext4', totalGb: 100, usedGb: 50, freeGb: 50, usedPercent: 50 },
      { mountPoint: '/run', fsType: 'tmpfs', totalGb: 8, usedGb: 1, freeGb: 7, usedPercent: 12 },
      { mountPoint: '/mnt/nas', fsType: 'nfs4', totalGb: 9000, usedGb: 1, freeGb: 8999, usedPercent: 1 },
      { mountPoint: '/media/cd', fsType: 'iso9660', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 100 },
    ]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'linux');

    expect(volumes.map((v) => v.scanPath)).toEqual(['/']);
  });

  it('always offers the OS root, even when the device reported no disks at all', async () => {
    mockDisks([]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'windows');

    expect(volumes).toHaveLength(1);
    expect(volumes[0]!.scanPath).toBe('C:\\');
    expect(volumes[0]!.isOsRoot).toBe(true);
    // Capacity is genuinely unknown here, and must NOT read as a full disk or
    // an empty one — the scan route's delta check depends on null meaning
    // "no delta available, take a baseline".
    expect(volumes[0]!.totalGb).toBeNull();
    expect(volumes[0]!.usedPercent).toBeNull();
  });

  it('de-duplicates two disk rows that normalise onto the same volume', async () => {
    mockDisks([
      { mountPoint: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80 },
      { mountPoint: 'c:/', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80 },
    ]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'windows');

    expect(volumes).toHaveLength(1);
    expect(volumes[0]!.scanPath).toBe('C:\\');
  });

  it('orders the OS root first and the rest by scan path', async () => {
    mockDisks([
      { mountPoint: '/data', fsType: 'ext4', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 1 },
      { mountPoint: '/backup', fsType: 'ext4', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 1 },
      { mountPoint: '/', fsType: 'ext4', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 1 },
    ]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'linux');

    expect(volumes.map((v) => v.scanPath)).toEqual(['/', '/backup', '/data']);
  });

  it('attaches per-volume scan state and the latest snapshot, keyed on that volume', async () => {
    mockDisks([
      { mountPoint: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80 },
      { mountPoint: 'D:\\', fsType: 'NTFS', totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: 5 },
    ]);
    vi.mocked(getFilesystemScanState).mockImplementation(async (_deviceId, scanPath) =>
      (scanPath === 'C:\\'
        ? { lastRunMode: 'incremental', lastBaselineCompletedAt: new Date('2026-09-18T10:00:00Z'), checkpoint: { pendingDirs: [{ path: 'C:\\x', depth: 1 }] } }
        : null) as never,
    );
    vi.mocked(readCheckpointPendingDirectories).mockImplementation((value) =>
      (value && typeof value === 'object' && 'pendingDirs' in (value as object) ? [{ path: 'C:\\x', depth: 1 }] : []) as never,
    );
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockImplementation(async (_deviceId, scanPath) =>
      (scanPath === 'D:\\'
        ? { id: 'snap-d', scanPath: 'D:\\', capturedAt: new Date('2026-09-19T09:00:00Z'), partial: true, cleanupCandidates: [] }
        : null) as never,
    );
    vi.mocked(buildCleanupPreview).mockReturnValue({ estimatedBytes: 4096 } as never);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'windows');

    expect(volumes[0]!.scanState).toEqual({
      lastRunMode: 'incremental',
      lastBaselineCompletedAt: '2026-09-18T10:00:00.000Z',
      hasCheckpoint: true,
    });
    expect(volumes[0]!.latestSnapshot).toBeNull();
    expect(volumes[1]!.scanState).toBeNull();
    expect(volumes[1]!.latestSnapshot).toEqual({
      id: 'snap-d',
      capturedAt: '2026-09-19T09:00:00.000Z',
      partial: true,
      cleanupEstimateBytes: 4096,
    });
  });

  it('caps the list so a pathological mount table cannot fan out unbounded queries', async () => {
    mockDisks(
      Array.from({ length: 60 }, (_unused, index) => ({
        mountPoint: `/mnt/vol${String(index).padStart(3, '0')}`,
        fsType: 'ext4', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 1,
      })),
    );

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'linux');

    expect(volumes).toHaveLength(24);
    // The OS root is synthesised and sorts first, so it survives the cap.
    expect(volumes[0]!.scanPath).toBe('/');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/filesystemVolumes.test.ts
```

Expected failure: `Failed to load .../filesystemVolumes.test.ts` … `Cannot find module './filesystemVolumes'`.

- [ ] **Step 3: Implement** — create `apps/api/src/services/filesystemVolumes.ts`:

```ts
/**
 * Which of a device's disks can be scanned and cleaned, and what we already
 * know about each (spec §5.1).
 *
 * Source of truth is `device_disks`, the inventory the agent already reports
 * and `GET /devices/:id/disks` already serves. This module adds the two things
 * the disk-cleanup surface needs on top of it: the NORMALISED scan path that
 * keys every snapshot and scan-state row, and the per-volume state that makes
 * a volume chip worth looking at.
 */
import { eq } from 'drizzle-orm';
import { normalizeScanPath, osRootScanPath } from '@breeze/shared';
import { db } from '../db';
import { deviceDisks } from '../db/schema';
import {
  buildCleanupPreview,
  getFilesystemScanState,
  getLatestFilesystemCleanupSnapshot,
  readCheckpointPendingDirectories,
} from './filesystemAnalysis';

/**
 * Filesystem types a disk-cleanup scan must never walk (spec §5.1).
 *
 * Read-only media (`cdfs`, `udf`, `iso9660`, `squashfs`) free nothing. Memory
 * filesystems (`tmpfs`, `devtmpfs`) vanish on reboot and "reclaiming" them is
 * meaningless. Kernel filesystems (`proc`, `sysfs`) are not files. Container
 * and network mounts (`overlay`, `nfs`, `nfs4`, `cifs`, `smbfs`, `9p`,
 * `autofs`, and every `fuse*`) are someone else's storage: deleting through
 * them frees space on a machine that is not the one being cleaned, which is
 * the cross-volume mistake this whole wave exists to stop.
 */
export const NON_SCANNABLE_FS_TYPES: ReadonlySet<string> = new Set([
  'cdfs',
  'udf',
  'iso9660',
  'squashfs',
  'tmpfs',
  'devtmpfs',
  'overlay',
  'nfs',
  'nfs4',
  'cifs',
  'smbfs',
  '9p',
  'autofs',
  'proc',
  'sysfs',
]);

/**
 * `listFilesystemVolumes` issues two queries per volume, so the list is
 * bounded. A real endpoint has one to four fixed volumes; a Linux box with a
 * pathological mount table could otherwise fan one GET into hundreds of
 * round-trips.
 */
export const MAX_VOLUMES_PER_DEVICE = 24;

export type FilesystemVolume = {
  /** Exactly what the agent reported, so the UI can show the operator's own string. */
  mountPoint: string;
  /** The normalised key: what `scan_path` holds and what `POST /scan` sends. */
  scanPath: string;
  fsType: string | null;
  /** Null when the device has reported no disk row for this volume. */
  totalGb: number | null;
  usedGb: number | null;
  freeGb: number | null;
  usedPercent: number | null;
  isOsRoot: boolean;
  scanState: {
    lastRunMode: string;
    lastBaselineCompletedAt: string | null;
    hasCheckpoint: boolean;
  } | null;
  latestSnapshot: {
    id: string;
    capturedAt: string;
    partial: boolean;
    cleanupEstimateBytes: number;
  } | null;
};

export function isScannableVolume(
  volume: { mountPoint?: string | null; fsType?: string | null },
  osType: unknown,
): boolean {
  const mountPoint = typeof volume.mountPoint === 'string' ? volume.mountPoint.trim() : '';
  if (mountPoint.length === 0) return false;

  // A UNC share is another machine's disk. `normalizeScanPath` preserves the
  // two leading separators precisely so this check can see them; POSIX network
  // mounts have no such marker and are caught by fsType below.
  if (normalizeScanPath(osType, mountPoint).startsWith('\\\\')) return false;

  const fsType = typeof volume.fsType === 'string' ? volume.fsType.trim().toLowerCase() : '';
  // An agent that does not populate fsType still reported a real mount point.
  // Refusing on a missing label would hide genuine fixed volumes.
  if (fsType.length === 0) return true;
  if (fsType.startsWith('fuse')) return false;
  return !NON_SCANNABLE_FS_TYPES.has(fsType);
}

type VolumeBase = Omit<FilesystemVolume, 'scanState' | 'latestSnapshot'>;

export async function listFilesystemVolumes(
  deviceId: string,
  osType: unknown,
): Promise<FilesystemVolume[]> {
  const rows = await db
    .select({
      mountPoint: deviceDisks.mountPoint,
      fsType: deviceDisks.fsType,
      totalGb: deviceDisks.totalGb,
      usedGb: deviceDisks.usedGb,
      freeGb: deviceDisks.freeGb,
      usedPercent: deviceDisks.usedPercent,
    })
    .from(deviceDisks)
    .where(eq(deviceDisks.deviceId, deviceId));

  const osRoot = osRootScanPath(osType);
  const byScanPath = new Map<string, VolumeBase>();

  for (const row of rows) {
    if (!isScannableVolume(row, osType)) continue;
    const scanPath = normalizeScanPath(osType, row.mountPoint);
    // Two rows can normalise onto one volume (`C:\` and `c:/`). First wins:
    // they describe the same disk, so the figures are the same either way.
    if (byScanPath.has(scanPath)) continue;
    byScanPath.set(scanPath, {
      mountPoint: row.mountPoint,
      scanPath,
      fsType: row.fsType ?? null,
      totalGb: row.totalGb,
      usedGb: row.usedGb,
      freeGb: row.freeGb,
      usedPercent: row.usedPercent,
      isOsRoot: scanPath === osRoot,
    });
  }

  // The OS root is always offerable, even on a device that has never reported
  // a disk inventory — otherwise the tab has nothing to scan and the operator
  // cannot bootstrap one. Capacity stays NULL rather than zero: the scan
  // route's delta check reads null as "no delta available, take a baseline",
  // and a fabricated 0% would instead read as a huge drop.
  if (!byScanPath.has(osRoot)) {
    byScanPath.set(osRoot, {
      mountPoint: osRoot,
      scanPath: osRoot,
      fsType: null,
      totalGb: null,
      usedGb: null,
      freeGb: null,
      usedPercent: null,
      isOsRoot: true,
    });
  }

  const ordered = Array.from(byScanPath.values())
    .sort((a, b) => {
      if (a.isOsRoot !== b.isOsRoot) return a.isOsRoot ? -1 : 1;
      return a.scanPath.localeCompare(b.scanPath);
    })
    .slice(0, MAX_VOLUMES_PER_DEVICE);

  return Promise.all(ordered.map(async (volume): Promise<FilesystemVolume> => {
    const [state, snapshot] = await Promise.all([
      getFilesystemScanState(deviceId, volume.scanPath),
      getLatestFilesystemCleanupSnapshot(deviceId, volume.scanPath),
    ]);

    return {
      ...volume,
      scanState: state
        ? {
            lastRunMode: state.lastRunMode,
            lastBaselineCompletedAt: state.lastBaselineCompletedAt
              ? state.lastBaselineCompletedAt.toISOString()
              : null,
            hasCheckpoint: readCheckpointPendingDirectories(state.checkpoint, 1).length > 0,
          }
        : null,
      latestSnapshot: snapshot
        ? {
            id: snapshot.id,
            capturedAt: snapshot.capturedAt.toISOString(),
            partial: snapshot.partial,
            cleanupEstimateBytes: buildCleanupPreview(snapshot).estimatedBytes,
          }
        : null,
    };
  }));
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/filesystemVolumes.test.ts
```

Expected: `Test Files  1 passed (1)`, 14 tests passed.

- [ ] **Step 5: Typecheck**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/filesystemVolumes.ts apps/api/src/services/filesystemVolumes.test.ts
git commit -m "$(cat <<'EOF'
feat(filesystem): volumes service — which disks are scannable and their state

Spec §5.1. Turns device_disks rows into scan-path-keyed volumes, refusing
read-only media, memory and kernel filesystems, container/network mounts,
every fuse* variant and Windows UNC mount points — deleting through a network
mount frees space on a machine that is not the one being cleaned.

The OS root is always offered even when the device has reported no disks, so a
fresh endpoint can still be bootstrapped; its capacity stays null rather than
zero so the scan route reads it as "no delta available, take a baseline".

Nothing routes to it yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `GET /devices/:id/filesystem/volumes`

**Files:**
- Modify: `apps/api/src/routes/devices/filesystem.ts` (imports; new route after the `GET /:id/filesystem` handler that ends at `:145`)
- Modify: `apps/api/src/routes/devices/filesystem.test.ts` (mock block at `:57-68`; new describe)

**Interfaces:**
- Consumes: `listFilesystemVolumes` (Task 7); `authMiddleware`, `requireScope`, `requirePermission`, `PERMISSIONS.DEVICES_READ`; `getDeviceWithOrgAndSiteCheck`.
- Produces: `GET /devices/:id/filesystem/volumes` → `200 { data: FilesystemVolume[] }`, `403` on site denial, `404` on unknown device.

- [ ] **Step 1: Write the failing test** — in `apps/api/src/routes/devices/filesystem.test.ts`, add a mock for the new service above the existing imports:

```ts
vi.mock('../../services/filesystemVolumes', () => ({
  listFilesystemVolumes: vi.fn(),
}));
```

extend the import block with `import { listFilesystemVolumes } from '../../services/filesystemVolumes';`, and append this describe:

```ts
describe('GET /devices/:id/filesystem/volumes (spec §5.1)', () => {
  it('returns the scannable volumes for the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'windows',
    } as never);
    vi.mocked(listFilesystemVolumes).mockResolvedValue([
      {
        mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS',
        totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: true,
        scanState: { lastRunMode: 'baseline', lastBaselineCompletedAt: null, hasCheckpoint: false },
        latestSnapshot: null,
      },
      {
        mountPoint: 'D:\\', scanPath: 'D:\\', fsType: 'NTFS',
        totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: 5, isOsRoot: false,
        scanState: null,
        latestSnapshot: { id: 'snap-d', capturedAt: '2026-09-19T09:00:00.000Z', partial: false, cleanupEstimateBytes: 4096 },
      },
    ] as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/volumes`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((v: { scanPath: string }) => v.scanPath)).toEqual(['C:\\', 'D:\\']);
    expect(body.data[0].isOsRoot).toBe(true);
    // The device's OS decides how a mount point normalises, so it must reach
    // the service — a POSIX default would key a Windows device on '/'.
    expect(listFilesystemVolumes).toHaveBeenCalledWith(deviceId, 'windows');
  });

  it('denies the volumes list when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/volumes`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(listFilesystemVolumes).not.toHaveBeenCalled();
  });

  it('404s for an unknown device without touching the service', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/volumes`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(listFilesystemVolumes).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected failure: `expected 404 to be 200` on the first case — the route does not exist, so Hono's fallback answers.

- [ ] **Step 3: Implement** — in `apps/api/src/routes/devices/filesystem.ts`, add to the imports:

```ts
import { listFilesystemVolumes } from '../../services/filesystemVolumes';
```

and add this route immediately after the `GET '/:id/filesystem'` handler:

```ts
/**
 * The volumes a disk-cleanup scan can target (spec §5.1). Sourced from the
 * `device_disks` inventory the agent already reports, filtered to what is
 * actually scannable, and annotated with the per-volume scan state and latest
 * snapshot so the tab can render a chip worth clicking.
 *
 * DEVICES_READ, like every other read here — listing mount points and their
 * capacity reveals nothing a device detail page does not already show.
 */
filesystemRoutes.get(
  '/:id/filesystem/volumes',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const volumes = await listFilesystemVolumes(deviceId, (device as { osType?: unknown }).osType);
    return c.json({ data: volumes });
  }
);
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected: `Test Files  1 passed (1)`, 11 tests passed (the 8 that existed plus the 3 above).

- [ ] **Step 5: Prove the route is reachable under its mount and respects site scope**

```bash
cd apps/api && npx vitest run --config vitest.config.site-scope-coverage.ts
```

Expected: pass. The static scan checks every route under `src/routes/**` calls a site-scope helper; the new handler uses `getDeviceWithOrgAndSiteCheck` like its siblings.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/routes/devices/filesystem.ts apps/api/src/routes/devices/filesystem.test.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /devices/:id/filesystem/volumes

Spec §5.1. Serves the scannable volumes with their per-volume scan state and
latest snapshot, so the Disk Cleanup tab can offer a volume to pick instead of
assuming the OS root. DEVICES_READ, site-scoped like every other read here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Per-volume snapshot reads, real root detection, and the disk-percent delta fix

**Files:**
- Modify: `apps/api/src/routes/devices/filesystem.ts:1-9` (imports), `:80-98` (delete `readCurrentDiskUsedPercent` and `getDefaultScanPathForOs`), `:100-145` (the GET), `:147-264` (the scan route)
- Modify: `apps/api/src/routes/devices/filesystem.test.ts` (extend the scan describes)

**Interfaces:**
- Consumes: `normalizeScanPath`, `osRootScanPath` (`@breeze/shared`); `listFilesystemVolumes` (Task 7).
- Produces: `GET /devices/:id/filesystem?path=` → the latest snapshot **for that scan path**, response gains `scanPath`. `POST /devices/:id/filesystem/scan` normalises `path`, decides `isRootScopedScan` against the volume list, reads scan state by `(deviceId, scanPath)`, and takes the disk percent from the matching volume.

> **Defects closed here.** Defect 6's `=== 'C:\\'` root check (`:178`) — `c:\` never auto-resumed its own checkpoint, and `D:\` was never treated as a root at all. Defect 8's disk-percent comparison (`:80-88`) — `readCurrentDiskUsedPercent` takes `ORDER BY used_percent DESC LIMIT 1`, i.e. the **fullest disk on the device**, and compares it to a baseline recorded from an arbitrary row (`helpers.ts:1622-1628`), so a device with a nearly-full second disk forced a full baseline on every scan of its first.

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/routes/devices/filesystem.test.ts`:

```ts
describe('GET /devices/:id/filesystem — per-volume (spec §5.1)', () => {
  it('reads the snapshot for the requested volume and echoes the normalised key', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'windows',
    } as never);
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({
      id: 'snap-d', deviceId, scanPath: 'D:\\',
      capturedAt: new Date('2026-09-19T09:00:00Z'),
      trigger: 'on_demand', partial: false,
      summary: {}, largestFiles: [], largestDirs: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [],
      duplicateCandidates: [], cleanupCandidates: [], errors: [],
      rawPayload: { path: 'd:/' },
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem?path=${encodeURIComponent('d:/')}`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(getLatestFilesystemSnapshot).toHaveBeenCalledWith(deviceId, 'D:\\');
    expect(body.data.scanPath).toBe('D:\\');
    // `path` is what the agent actually walked and still renders in the tab.
    expect(body.data.path).toBe('d:/');
  });

  it('defaults to the OS root when no path is given', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux',
    } as never);
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null as never);

    const res = await app.request(`/devices/${deviceId}/filesystem`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(getLatestFilesystemSnapshot).toHaveBeenCalledWith(deviceId, '/');
  });
});

describe('POST /devices/:id/filesystem/scan — per-volume (spec §5.1)', () => {
  const windowsDevice = { id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'windows' };

  function twoWindowsVolumes(usedPercentC = 80, usedPercentD = 5) {
    return [
      { mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: usedPercentC, isOsRoot: true, scanState: null, latestSnapshot: null },
      { mountPoint: 'D:\\', scanPath: 'D:\\', fsType: 'NTFS', totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: usedPercentD, isOsRoot: false, scanState: null, latestSnapshot: null },
    ];
  }

  it('normalises the requested path before it reaches the agent or the scan state', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes() as never);
    vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-1', status: 'sent', createdAt: new Date('2026-09-19T09:00:00Z') },
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/scan`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'd:/' }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.scanPath).toBe('D:\\');
    expect(getFilesystemScanState).toHaveBeenCalledWith(deviceId, 'D:\\');
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      deviceId,
      'filesystem_analysis',
      expect.objectContaining({ path: 'D:\\' }),
      expect.objectContaining({ userId: 'user-123' }),
    );
  });

  it('treats ANY volume root as root-scoped, not just C:\\ (defect 6)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes() as never);
    vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-2', status: 'sent', createdAt: new Date() },
    } as never);

    await app.request(`/devices/${deviceId}/filesystem/scan`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'D:\\' }),
    });

    // autoContinue is the observable consequence of isRootScopedScan: a
    // checkpointed baseline resumes itself only on a root-scoped scan.
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      deviceId, 'filesystem_analysis',
      expect.objectContaining({ autoContinue: true }),
      expect.anything(),
    );
  });

  it('does NOT treat a subdirectory as root-scoped', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes() as never);
    vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-3', status: 'sent', createdAt: new Date() },
    } as never);

    await app.request(`/devices/${deviceId}/filesystem/scan`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'D:\\media' }),
    });

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      deviceId, 'filesystem_analysis',
      expect.objectContaining({ autoContinue: false, scanMode: 'baseline' }),
      expect.anything(),
    );
  });

  it('compares the disk percent against the scanned volume, not the fullest disk (defect 8)', async () => {
    // C: is 80% full, D: is 5%. A D:\ incremental must be judged against D:'s
    // own 5% baseline; the old code read `ORDER BY used_percent DESC LIMIT 1`,
    // saw 80, and forced a full baseline on every D:\ scan forever.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes(80, 5) as never);
    vi.mocked(getFilesystemScanState).mockResolvedValue({
      lastRunMode: 'baseline',
      lastBaselineCompletedAt: new Date('2026-09-18T00:00:00Z'),
      lastDiskUsedPercent: 4,
      checkpoint: {},
      hotDirectories: ['D:\\media'],
    } as never);
    vi.mocked(readHotDirectories).mockReturnValue(['D:\\media']);
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-4', status: 'sent', createdAt: new Date() },
    } as never);

    await app.request(`/devices/${deviceId}/filesystem/scan`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'D:\\' }),
    });

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      deviceId, 'filesystem_analysis',
      expect.objectContaining({ scanMode: 'incremental', targetDirectories: ['D:\\media'] }),
      expect.anything(),
    );
  });

  it('falls back to a baseline when the scanned volume reports no disk row', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(listFilesystemVolumes).mockResolvedValue([
      { mountPoint: 'C:\\', scanPath: 'C:\\', fsType: null, totalGb: null, usedGb: null, freeGb: null, usedPercent: null, isOsRoot: true, scanState: null, latestSnapshot: null },
    ] as never);
    vi.mocked(getFilesystemScanState).mockResolvedValue({
      lastRunMode: 'baseline',
      lastBaselineCompletedAt: new Date('2026-09-18T00:00:00Z'),
      lastDiskUsedPercent: 80,
      checkpoint: {},
      hotDirectories: ['C:\\Windows\\Temp'],
    } as never);
    vi.mocked(readHotDirectories).mockReturnValue(['C:\\Windows\\Temp']);
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-5', status: 'sent', createdAt: new Date() },
    } as never);

    await app.request(`/devices/${deviceId}/filesystem/scan`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'C:\\' }),
    });

    // No delta available -> baseline, never a comparison against an unrelated disk.
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      deviceId, 'filesystem_analysis',
      expect.objectContaining({ scanMode: 'baseline' }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected failure: `AssertionError: expected "getLatestFilesystemSnapshot" to have been called with [ '1111…', 'D:\\' ]` — the GET still passes `osRootScanPath(...)` from Task 6's pin, and the scan route still compares `payload.path === getDefaultScanPathForOs(...)`.

- [ ] **Step 3: Implement** — in `apps/api/src/routes/devices/filesystem.ts`:

Change the drizzle import (`:4`) and the schema import (`:6`), and add the shared helper:

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceFilesystemCleanupRuns } from '../../db/schema';
import { normalizeScanPath, osRootScanPath } from '@breeze/shared';
```

(`desc` and `deviceDisks` lose their last consumer when `readCurrentDiskUsedPercent` goes.)

Delete `readCurrentDiskUsedPercent` (`:80-88`) and `getDefaultScanPathForOs` (`:95-98`) entirely. Keep `withinPercentDelta` (`:90-93`) unchanged — its `current === null` branch is exactly the "no delta available → baseline" behaviour the spec asks for, and Task 7 made `usedPercent` nullable so that branch is now reachable for real.

Add the query schema next to the other schemas:

```ts
const filesystemSnapshotQuerySchema = z.object({
  /** Which volume's latest snapshot to read. Defaults to the device's OS root. */
  path: z.string().min(1).max(2048).optional(),
});
```

Rewrite the `GET '/:id/filesystem'` handler's validator list and body:

```ts
filesystemRoutes.get(
  '/:id/filesystem',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', filesystemSnapshotQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { path: requestedPath } = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const osType = (device as { osType?: unknown }).osType;
    const scanPath = normalizeScanPath(osType, requestedPath ?? osRootScanPath(osType));

    const snapshot = await getLatestFilesystemSnapshot(deviceId, scanPath);
    if (!snapshot) {
      return c.json({ error: 'No filesystem analysis available yet', scanPath }, 404);
    }

    return c.json({
      data: {
        id: snapshot.id,
        deviceId: snapshot.deviceId,
        // The normalised key this snapshot is stored under — what the client
        // sends back on the next request. `path` below is the raw string the
        // agent actually walked, which the tab has always displayed.
        scanPath: snapshot.scanPath,
        capturedAt: snapshot.capturedAt,
        trigger: snapshot.trigger,
        partial: snapshot.partial,
        reason: readSnapshotReason(snapshot),
        path: readSnapshotPath(snapshot),
        scanMode: readSnapshotScanMode(snapshot),
        summary: snapshot.summary,
        topLargestFiles: snapshot.largestFiles,
        topLargestDirectories: snapshot.largestDirs,
        tempAccumulation: snapshot.tempAccumulation,
        oldDownloads: snapshot.oldDownloads,
        unrotatedLogs: snapshot.unrotatedLogs,
        trashUsage: snapshot.trashUsage,
        duplicateCandidates: snapshot.duplicateCandidates,
        cleanupCandidates: snapshot.cleanupCandidates,
        errors: snapshot.errors,
      },
    });
  }
);
```

In the scan handler, replace everything from the `const scanState = …` line (`:167`) down to the `const fullRescanDeltaPercent = 3;` line (`:171`) with:

```ts
    const osType = (device as { osType?: unknown }).osType;
    const scanPath = normalizeScanPath(osType, payload.path);

    // One read serves three jobs: root detection, the disk-percent baseline,
    // and the guarantee that we never scan a volume the volumes endpoint would
    // not offer. `listFilesystemVolumes` always includes the OS root, so a
    // device with no disk inventory can still be bootstrapped.
    const volumes = await listFilesystemVolumes(deviceId, osType);
    const scannedVolume = volumes.find((volume) => volume.scanPath === scanPath) ?? null;

    const scanState = await getFilesystemScanState(deviceId, scanPath);
    const hotDirectories = readHotDirectories(scanState?.hotDirectories, 12);
    const checkpointDirs = readCheckpointPendingDirectories(scanState?.checkpoint, 50_000);
    // Defect 8: compare the SCANNED volume against its own baseline. The old
    // code took `ORDER BY used_percent DESC LIMIT 1` — the fullest disk on the
    // device — so a nearly-full second disk forced a full baseline on every
    // scan of the first. Null here means "no delta available", and
    // `withinPercentDelta` reads that as a baseline, which is the safe answer.
    const currentUsedPercent = scannedVolume?.usedPercent ?? null;
    const fullRescanDeltaPercent = 3;
```

and replace the `isRootScopedScan` line (`:178`) with:

```ts
    // Defect 6: root detection used to be `payload.path === 'C:\\'`, so `c:\`
    // never resumed its own checkpoint and `D:\` was never a root at all. A
    // scan is root-scoped when its normalised path IS one of this device's
    // volume roots.
    const isRootScopedScan = scannedVolume !== null;
```

In the command payload (`:208-217`), replace `...payload,` with an explicit spread that carries the normalised path:

```ts
    const commandPayload = {
      ...payload,
      // The agent receives the NORMALISED form, so the result handler can key
      // the snapshot on `command.payload.path` without re-deriving anything.
      path: scanPath,
      timeoutSeconds,
      trigger: 'on_demand',
      scanMode,
      checkpoint: checkpointPayload,
      targetDirectories,
      autoContinue: scanMode === 'baseline' ? autoContinue : false,
      resumeAttempt: 0,
    };
```

Add `scanPath` to the audit details (`:243-249`, replacing `path: payload.path,`):

```ts
        path: scanPath,
        scanPath,
```

and to the 202 response body (`:254-261`):

```ts
      data: {
        commandId: queued.command.id,
        status: queued.command.status,
        createdAt: queued.command.createdAt,
        scanPath,
        scanMode,
        strategy,
      },
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected: `Test Files  1 passed (1)`, 18 tests passed. The pre-existing `runs on-demand scan and persists snapshot` case asserts `expect.objectContaining({ path: '/tmp', scanMode: 'baseline' })` — it uses an `osType`-less device fixture, so `normalizeScanPath(undefined, '/tmp')` is `'/tmp'` and the assertion still holds unchanged. If it fails, the device fixture needs `osType`, not the assertion.

- [ ] **Step 5: Prove nothing still reaches for the deleted helpers**

```bash
git grep -n 'readCurrentDiskUsedPercent\|getDefaultScanPathForOs' -- apps
```

Expected: **no output.**

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/routes/devices/filesystem.ts apps/api/src/routes/devices/filesystem.test.ts
git commit -m "$(cat <<'EOF'
fix(api): read and scan filesystem per volume (defects 6 and 8)

GET /devices/:id/filesystem takes ?path= and answers with that volume's latest
snapshot, echoing the normalised scanPath alongside the raw path the agent
walked.

POST /filesystem/scan normalises the requested path, sends the normalised form
to the agent, and keys scan state on it. Root detection stops being
`=== 'C:\\'` — a scan is root-scoped when its normalised path is one of THIS
device's volume roots, so `c:\` resumes its own checkpoint and `D:\` counts as
a root (defect 6).

The disk-percent baseline now comes from the scanned volume's own row instead
of `ORDER BY used_percent DESC LIMIT 1` — the fullest disk on the device — which
forced a full baseline on every scan of a machine with a nearly-full second
disk (defect 8). No matching row means no delta, which means a baseline.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Pin the volume into the cleanup preview, and thread it through execute

**Files:**
- Modify: `apps/api/src/routes/devices/filesystem.ts:44-46` (`cleanupPreviewBodySchema`), `:266-329` (preview), `:331-471` (execute)
- Modify: `apps/api/src/routes/devices/filesystem.test.ts` (extend the preview/execute describes)

**Interfaces:**
- Consumes: `readPlanScanPath` (Task 6); `normalizeScanPath`, `osRootScanPath`.
- Produces: `POST /filesystem/cleanup-preview { path?, categories? }` → response gains `scanPath`, and the stored run gets `scan_path` plus `plan.scanPath`. `POST /filesystem/cleanup-execute` → response gains `scanPath`, and the stored run gets `scan_path` plus `plan.scanPath`.

> **Scope.** §5.2's other execute changes — required `cleanupRunId`, `rejectedPaths`, per-path `status`, the `CLEANUP_EXECUTE_BUDGET_MS` budget, the `permanent`/`cleanupGuard`/`contentsOnly` dispatch payload — belong to W01 and W03. This task threads the volume and nothing else (amendment 10).

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/routes/devices/filesystem.test.ts`:

```ts
describe('cleanup preview/execute — volume pinning (spec §5.2)', () => {
  const windowsDevice = { id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'windows' };

  function captureInsert() {
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'run-1' }]),
    });
    vi.mocked(db.insert).mockReturnValue({ values } as never);
    return values;
  }

  it('previews the requested volume and pins it into the stored plan and the row', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue({
      id: 'snap-d', scanPath: 'D:\\', capturedAt: new Date(), partial: false, cleanupCandidates: [],
    } as never);
    vi.mocked(buildCleanupPreview).mockReturnValue({
      snapshotId: 'snap-d', estimatedBytes: 4096, candidateCount: 1,
      categories: [{ category: 'temp_files', count: 1, estimatedBytes: 4096 }],
      candidates: [{ path: 'D:\\Temp\\a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true }],
    } as never);
    const values = captureInsert();

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-preview`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'd:/' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(deviceId, 'D:\\');
    expect(body.data.scanPath).toBe('D:\\');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      scanPath: 'D:\\',
      plan: expect.objectContaining({ snapshotId: 'snap-d', scanPath: 'D:\\' }),
    }));
  });

  it('previews the OS root when no path is given', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue(null as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-preview`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(deviceId, 'C:\\');
    expect(body.scanPath).toBe('C:\\');
  });

  it('executes against the volume the pinned run recorded, not the OS root', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ plan: { scanPath: 'D:\\' }, scanPath: 'D:\\' }]),
        }),
      }),
    } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: 'D:\\Temp\\a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed' } as never);
    const values = captureInsert();

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['D:\\Temp\\a.tmp'],
        cleanupRunId: '22222222-2222-2222-2222-222222222222',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.scanPath).toBe('D:\\');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      scanPath: 'D:\\',
      plan: expect.objectContaining({ scanPath: 'D:\\' }),
    }));
    // The pinned lane must never re-derive candidates from a snapshot.
    expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
  });

  it('recovers the volume from the stored plan when the row predates the column', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ plan: { scanPath: 'D:\\' }, scanPath: null }]),
        }),
      }),
    } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: 'D:\\Temp\\a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed' } as never);
    captureInsert();

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['D:\\Temp\\a.tmp'],
        cleanupRunId: '22222222-2222-2222-2222-222222222222',
      }),
    });

    const body = await res.json();
    expect(body.data.scanPath).toBe('D:\\');
  });

  it('falls back to the OS root snapshot on the unpinned lane', async () => {
    // Before W02 this lane took the newest snapshot of ANY path, which is
    // defect 6: a D:\ scan became the snapshot a C:\ execute deleted from.
    // W03 makes cleanupRunId required and deletes this lane entirely.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue({
      id: 'snap-c', scanPath: 'C:\\', capturedAt: new Date(), partial: false, cleanupCandidates: [],
    } as never);
    vi.mocked(buildCleanupPreview).mockReturnValue({
      snapshotId: 'snap-c', estimatedBytes: 4096, candidateCount: 1,
      categories: [], candidates: [{ path: 'C:\\Windows\\Temp\\a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true }],
    } as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed' } as never);
    captureInsert();

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['C:\\Windows\\Temp\\a.tmp'] }),
    });

    expect(res.status).toBe(200);
    expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(deviceId, 'C:\\');
    const body = await res.json();
    expect(body.data.scanPath).toBe('C:\\');
  });
});
```

Add `readPlanScanPath: vi.fn(() => null)` to the `vi.mock('../../services/filesystemAnalysis', …)` factory at `:57-68`, and import it alongside `readPlanPreviewCandidates`. For the two pinned-lane cases above, set `vi.mocked(readPlanScanPath).mockReturnValue('D:\\')`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected failure: `AssertionError: expected undefined to be 'D:\\'` on `body.data.scanPath` — the preview response has no such field yet.

- [ ] **Step 3: Implement** — in `apps/api/src/routes/devices/filesystem.ts`:

Add `readPlanScanPath` to the `../../services/filesystemAnalysis` import, and extend `cleanupPreviewBodySchema` (`:44-46`):

```ts
const cleanupPreviewBodySchema = z.object({
  /** Which volume to preview. Defaults to the device's OS root. */
  path: z.string().min(1).max(2048).optional(),
  categories: z.array(z.enum(['temp_files', 'browser_cache', 'package_cache', 'trash'])).max(10).optional(),
});
```

In the preview handler, replace the destructure and the snapshot read:

```ts
    const { path: requestedPath, categories } = c.req.valid('json');
    // …device checks unchanged…
    const osType = (device as { osType?: unknown }).osType;
    const scanPath = normalizeScanPath(osType, requestedPath ?? osRootScanPath(osType));

    const snapshot = await getLatestFilesystemCleanupSnapshot(deviceId, scanPath);
    if (!snapshot) {
      // Message kept verbatim: the docs troubleshooting section and existing
      // clients match on this string. The scanPath echo is what tells the
      // caller WHICH volume has no snapshot.
      return c.json({ error: 'No filesystem snapshot available. Run a scan first.', scanPath }, 404);
    }
```

then pin the volume on the stored run and echo it:

```ts
      .values({
        deviceId,
        orgId: device.orgId,
        scanPath: snapshot.scanPath,
        requestedBy: auth.user.id,
        plan: {
          snapshotId: snapshot.id,
          // Pinned alongside snapshotId so execute can recover the volume
          // without a `path` field of its own (spec §5.2).
          scanPath: snapshot.scanPath,
          categories: categories ?? safeCleanupCategories,
          preview,
        },
        status: 'previewed',
      })
```

add `scanPath: snapshot.scanPath` to the audit `details`, and to the 200 body:

```ts
    return c.json({
      success: true,
      data: {
        cleanupRunId: cleanupRun?.id ?? null,
        scanPath: snapshot.scanPath,
        ...preview,
      },
    });
```

In the execute handler, resolve the volume in both lanes. Replace the `let candidates … } else { … }` block's declarations and both branches:

```ts
    const osType = (device as { osType?: unknown }).osType;

    let candidates: FilesystemCleanupCandidate[];
    let sourceSnapshotId: string | null = null;
    let scanPath: string;
    if (cleanupRunId) {
      const [run] = await db
        .select({
          plan: deviceFilesystemCleanupRuns.plan,
          scanPath: deviceFilesystemCleanupRuns.scanPath,
        })
        .from(deviceFilesystemCleanupRuns)
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
          eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
        ))
        .limit(1);
      if (!run) {
        return c.json({ error: 'Cleanup run not found' }, 404);
      }
      candidates = readPlanPreviewCandidates(run.plan);
      if (candidates.length === 0) {
        return c.json({
          error: 'Pinned cleanup run has no previewable candidates (it may already be executed or its preview is unavailable). Re-run the cleanup preview.',
        }, 400);
      }
      // The column first, then the plan (rows previewed before this wave have
      // a null column), then the OS root. Never a guess from the candidates.
      scanPath = run.scanPath ?? readPlanScanPath(run.plan) ?? osRootScanPath(osType);
    } else {
      // W02 narrows this lane from "the newest snapshot of ANY path" — which
      // is defect 6 — to the OS root. W03 makes cleanupRunId required and
      // deletes the lane.
      scanPath = osRootScanPath(osType);
      const snapshot = await getLatestFilesystemCleanupSnapshot(deviceId, scanPath);
      if (!snapshot) {
        return c.json({ error: 'No filesystem snapshot available. Run a scan first.', scanPath }, 404);
      }
      sourceSnapshotId = snapshot.id;
      candidates = buildCleanupPreview(snapshot).candidates;
    }
```

then record and echo it — in the run insert:

```ts
      .values({
        deviceId,
        orgId: device.orgId,
        scanPath,
        requestedBy: auth.user.id,
        approvedAt: new Date(),
        plan: {
          snapshotId: sourceSnapshotId,
          scanPath,
          sourceCleanupRunId: cleanupRunId ?? null,
          requestedPaths: requested,
          selectedPaths: selected.map((candidate) => candidate.path),
        },
        executedActions: actions,
        bytesReclaimed,
        status: runStatus,
        error: failedCount > 0 ? `${failedCount} cleanup action(s) failed` : null,
      })
```

add `scanPath` to the audit `details`, and to the response body:

```ts
      data: {
        cleanupRunId: cleanupRun?.id ?? null,
        scanPath,
        status: runStatus,
        bytesReclaimed,
        selectedCount: selected.length,
        failedCount,
        actions,
      },
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected: `Test Files  1 passed (1)`, 23 tests passed.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/routes/devices/filesystem.ts apps/api/src/routes/devices/filesystem.test.ts
git commit -m "$(cat <<'EOF'
feat(api): pin the volume into the cleanup preview and carry it through execute

Spec §5.2. cleanup-preview takes an optional `path`, reads that volume's
snapshot, writes scan_path on the run and scanPath into the pinned plan, and
echoes it. cleanup-execute recovers the volume from the run's column (falling
back to the plan for rows previewed before this wave), records it on the new
run, and echoes it.

The unpinned execute lane narrows from "the newest snapshot of ANY path" to the
OS root — that widening IS defect 6. W03 makes cleanupRunId required and
deletes the lane. Everything else in §5.2 (rejectedPaths, the budget, the
dispatch payload) stays with W01/W03.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The agent result handler keys on the scanned volume

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts:1517-1520` (`getFilesystemThresholdScanPath`), `:1564` (the threshold queue payload), `:1593-1679` (the result handler), and delete `W02_TRANSITIONAL_SCAN_PATH` from Task 6
- Modify: `apps/api/src/routes/agents/helpers.filesystemAnalysis.test.ts` (extend)

**Interfaces:**
- Consumes: `normalizeScanPath`, `osRootScanPath` (`@breeze/shared`); `devices`, `deviceDisks` (already imported in that file).
- Produces: `handleFilesystemAnalysisCommandResult` writes the snapshot and the scan state under `normalizeScanPath(osType, command.payload.path)`; `getFilesystemThresholdScanPath(osType)` returns the normalised OS root.

> **Why the extra query (amendment 6).** Normalisation is OS-dependent and this handler has no OS in scope: it is called with `agent.orgId` only, and `AgentAuthContext` carries no OS. One indexed primary-key lookup on `devices` is the cost; guessing POSIX would silently key every Windows device on `/` and re-create defect 6 inside the fix.

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/routes/agents/helpers.filesystemAnalysis.test.ts`:

```ts
describe('handleFilesystemAnalysisCommandResult — scan-path keying (spec §5.1)', () => {
  function windowsCommand(path: unknown) {
    return {
      id: '00000000-0000-4000-8000-0000000000cc',
      deviceId: DEVICE_ID,
      payload: { scanMode: 'baseline', trigger: 'on_demand', autoContinue: false, resumeAttempt: 0, path },
      createdBy: null,
    } as never;
  }

  it('keys the snapshot and the scan state on the normalised command path', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ osType: 'windows' }]);                       // devices read
    selectQueue.push([{ mountPoint: 'D:\\', usedPercent: 5 }]);      // deviceDisks read

    await handleFilesystemAnalysisCommandResult(windowsCommand('d:/'), result(), ORG_ID);

    expect(saveFilesystemSnapshot).toHaveBeenCalledWith(
      DEVICE_ID, ORG_ID, 'on_demand', 'D:\\', expect.any(Object),
    );
    expect(getFilesystemScanState).toHaveBeenCalledWith(DEVICE_ID, 'D:\\');
    const [dev, org, scanPath] = vi.mocked(upsertFilesystemScanState).mock.calls[0]!;
    expect(dev).toBe(DEVICE_ID);
    expect(org).toBe(ORG_ID);
    expect(scanPath).toBe('D:\\');
  });

  it('falls back to the OS root when the command carried no path', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ osType: 'windows' }]);
    selectQueue.push([{ mountPoint: 'C:\\', usedPercent: 80 }]);

    await handleFilesystemAnalysisCommandResult(windowsCommand(undefined), result(), ORG_ID);

    expect(saveFilesystemSnapshot).toHaveBeenCalledWith(
      DEVICE_ID, ORG_ID, 'on_demand', 'C:\\', expect.any(Object),
    );
  });

  it('takes the disk percent from the disk whose mount point IS the scanned volume (defect 8)', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ osType: 'windows' }]);
    // C: is listed first and is 80% full. The old code took `LIMIT 1` — an
    // arbitrary row — and recorded 80 as D:'s baseline.
    selectQueue.push([
      { mountPoint: 'C:\\', usedPercent: 80 },
      { mountPoint: 'd:/', usedPercent: 5 },
    ]);

    await handleFilesystemAnalysisCommandResult(windowsCommand('D:\\'), result(), ORG_ID);

    const updates = vi.mocked(upsertFilesystemScanState).mock.calls[0]![3];
    expect(updates.lastDiskUsedPercent).toBe(5);
  });

  it('records no disk percent when the scanned volume has no matching disk row', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
    selectQueue.push([{ osType: 'linux' }]);
    selectQueue.push([{ mountPoint: '/', usedPercent: 91 }]);

    await handleFilesystemAnalysisCommandResult(windowsCommand('/data'), result(), ORG_ID);

    const updates = vi.mocked(upsertFilesystemScanState).mock.calls[0]![3];
    // Never inherit an unrelated disk's figure — null means the next scan
    // takes a baseline, which is the safe answer.
    expect(updates.lastDiskUsedPercent).toBeNull();
  });

  it('writes nothing at all when the device row cannot be resolved', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    selectQueue.push([]); // devices read returns nothing

    await handleFilesystemAnalysisCommandResult(windowsCommand('D:\\'), result(), ORG_ID);

    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(upsertFilesystemScanState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/agents/helpers.filesystemAnalysis.test.ts
```

Expected failure: `AssertionError: expected "saveFilesystemSnapshot" to have been called with [ …, 'D:\\', … ]` — Task 6's `W02_TRANSITIONAL_SCAN_PATH` is still `'/'`.

- [ ] **Step 3: Implement** — in `apps/api/src/routes/agents/helpers.ts`:

Add `normalizeScanPath, osRootScanPath` to the `@breeze/shared` import, delete the `W02_TRANSITIONAL_SCAN_PATH` constant Task 6 added, and replace `getFilesystemThresholdScanPath` (`:1517-1520`):

```ts
/**
 * The volume a threshold-triggered scan targets: the device's OS root, in the
 * same normalised form every other producer uses, so the result handler keys
 * its snapshot on the key a `GET /filesystem` with no `?path=` reads back.
 */
export function getFilesystemThresholdScanPath(osType: unknown): string {
  return osRootScanPath(osType);
}
```

(The `:1564` call site is unchanged — it already passes `device.osType` — and the queued payload's `path` is therefore already normalised. The threshold COOLDOWN at `:1530-1562` stays device-wide on purpose: a scan of any volume in the last N minutes is evidence the device is already being looked at, and per-volume cooldowns would let a 6-volume server queue 6 threshold scans at once.)

Replace the body of `handleFilesystemAnalysisCommandResult` from the `// orgId comes from…` comment (`:1617`) through the `currentDiskUsedPercent` assignment (`:1631`):

```ts
  // orgId comes from the caller's agent-auth context, which already resolved
  // the device's org — no need to re-query it here. The OS, however, is not in
  // that context (AgentAuthContext carries no OS), and the scan-path key is
  // OS-dependent: guessing POSIX would key every Windows device on '/' and
  // recreate the very defect this wave closes. One indexed primary-key lookup.
  const [deviceRow] = await db
    .select({ osType: devices.osType })
    .from(devices)
    .where(eq(devices.id, command.deviceId))
    .limit(1);

  if (!deviceRow) {
    console.warn(
      `[agents/helpers] filesystem_analysis command ${command.id} has no devices row for ${command.deviceId}; no snapshot written`
    );
    return;
  }

  const osType = deviceRow.osType;
  // Every producer (the scan route, the AI tool, the threshold queue) already
  // sends the normalised form; normalising again is what makes an in-flight
  // command queued by the PREVIOUS release land on the right key too.
  const scanPath = normalizeScanPath(osType, asString(payload.path) ?? osRootScanPath(osType));

  // The scan-state read and the disk-usage read are independent; run them
  // together. The disk figure is only consumed by the scan-state upsert below.
  const [currentState, diskRows] = await Promise.all([
    getFilesystemScanState(command.deviceId, scanPath),
    db
      .select({
        mountPoint: deviceDisks.mountPoint,
        usedPercent: deviceDisks.usedPercent,
      })
      .from(deviceDisks)
      .where(eq(deviceDisks.deviceId, command.deviceId))
      .limit(64),
  ]);

  // Defect 8: match the SCANNED volume's own disk row. The old code took
  // `LIMIT 1` — an arbitrary row — so a `D:\` scan recorded `C:`'s 80% as D's
  // baseline and every later `D:\` scan read a huge delta and forced a full
  // rescan. No match means no figure, which means the next scan takes a
  // baseline rather than comparing against an unrelated disk.
  const matchedDisk = diskRows.find(
    (disk) => normalizeScanPath(osType, disk.mountPoint) === scanPath
  );
  const currentDiskUsedPercent =
    typeof matchedDisk?.usedPercent === 'number' ? matchedDisk.usedPercent : null;
```

Pass `scanPath` to the two writers — `:1652` becomes:

```ts
  await saveFilesystemSnapshot(command.deviceId, orgId, snapshotTrigger, scanPath, snapshotPayload);
```

and `:1670` becomes:

```ts
  await upsertFilesystemScanState(command.deviceId, orgId, scanPath, {
```

Finally, in the auto-resume block, make the resumed command carry the same normalised key (`:1711-1718`):

```ts
  const nextPayload: Record<string, unknown> = {
    ...(isObject(payload) ? payload : {}),
    // Normalised, so the resumed run's result lands on the SAME scan-state row
    // this one just checkpointed.
    path: scanPath,
    scanMode: 'baseline',
    checkpoint: { pendingDirs },
    autoContinue: true,
    resumeAttempt: resumeAttempt + 1,
  };
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/routes/agents/helpers.filesystemAnalysis.test.ts src/routes/agents.test.ts
```

Expected: `Test Files  2 passed (2)`. The four pre-existing cases in `helpers.filesystemAnalysis.test.ts` each push one `selectQueue` entry for the disks read; they now need a `devices` entry pushed FIRST — add `selectQueue.push([{ osType: 'linux' }]);` ahead of each existing `selectQueue.push([{ usedPercent: … }]);` and change those entries to `[{ mountPoint: '/', usedPercent: … }]`. That is a fixture change, not an assertion change: the cases still assert baseline completion and orgId threading exactly as before.

- [ ] **Step 5: Prove the transitional pin is gone**

```bash
git grep -n 'W02_TRANSITIONAL_SCAN_PATH' -- apps
```

Expected: **no output.**

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/helpers.filesystemAnalysis.test.ts
git commit -m "$(cat <<'EOF'
fix(agents): key filesystem results on the volume that was scanned

Spec §5.1. The result handler resolves the device's OS (AgentAuthContext
carries none — one indexed PK lookup), normalises command.payload.path, and
writes the snapshot and the scan state under that key. A result whose device
row cannot be resolved writes nothing rather than guessing POSIX and keying a
Windows device on '/'.

The disk-percent baseline comes from the disk whose mount point IS the scanned
volume, instead of an arbitrary `LIMIT 1` row: a D:\ scan used to record C:'s
80% as D's baseline, so every later D:\ scan read a huge delta and forced a
full rescan (defect 8). No matching row means no figure, which means a
baseline.

A resumed checkpoint carries the same normalised path, so the resumed run lands
on the row the previous one checkpointed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `path` on the `analyze_disk_usage` and `disk_cleanup` AI tools

**Files:**
- Modify: `apps/api/src/services/aiToolSchemas.ts:998-1007` (`disk_cleanup`)
- Modify: `apps/api/src/services/aiToolsFilesystem.ts:13-27` (imports), `:151-221` (`analyze_disk_usage` handler), `:227-375` (`disk_cleanup` definition + handler)
- Create: `apps/api/src/services/aiToolsFilesystem.scanPath.test.ts` (Test)

**Interfaces:**
- Consumes: `normalizeScanPath`, `osRootScanPath` (`@breeze/shared`); `safePath` (already defined in `aiToolSchemas.ts:79-89`).
- Produces: `disk_cleanup` accepts `path`; both handlers normalise it, read and write per volume, and echo `scanPath` in their JSON.

> **Scope.** Spec §9's other items — the required `cleanupRunId`, the empty-snapshot guard, the run-level audit, the new `system_cleanup` tool, and every tier/registry/label/timeout entry — are W05. This task changes the schema and the two handlers only. No registry file is touched, so `agentToolCatalog.contract.test.ts` and `aiGuardrails.agentPrincipal.contract.test.ts` stay green without edits.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/aiToolsFilesystem.scanPath.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `registerFilesystemTools(aiTools: Map<string, AiTool>)` fills a Map keyed by
 * tool name (aiToolsFilesystem.ts:55-58), so the registry IS the Map — hand it
 * an empty one and drive the handlers off it.
 */
const registered = new Map<string, { handler: (input: Record<string, unknown>, auth: unknown) => Promise<string> }>();

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: 'user-1' }]) })) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'run-1' }]) })),
    })),
  },
}));
vi.mock('../db/schema', () => new Proxy({}, {
  get: (_t, prop: string) => (prop === 'then' ? undefined : { name: prop }),
  has: () => true,
}));
vi.mock('./aiDispatch', () => ({ aiExecuteCommand: vi.fn() }));
vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({
    snapshotId: 'snap-1', estimatedBytes: 0, candidateCount: 0, categories: [], candidates: [],
  })),
  getLatestFilesystemSnapshot: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(() => ({})),
  saveFilesystemSnapshot: vi.fn(),
  safeCleanupCategories: ['temp_files', 'browser_cache', 'package_cache', 'trash'],
}));

import { db } from '../db';
import { aiExecuteCommand } from './aiDispatch';
import {
  getLatestFilesystemCleanupSnapshot,
  getLatestFilesystemSnapshot,
  saveFilesystemSnapshot,
} from './filesystemAnalysis';
import { registerFilesystemTools } from './aiToolsFilesystem';

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';
const AUTH = {
  user: { id: 'user-1' },
  orgCondition: () => undefined,
  allowedDeviceIds: null,
} as never;

beforeEach(() => {
  registered.clear();
  registerFilesystemTools(registered as never);
});

function withDevice(osType: 'windows' | 'linux') {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: 'org-1', osType, status: 'online' }]) })),
    })),
  } as never);
}

describe('analyze_disk_usage — path (spec §9)', () => {
  it('normalises the requested path and reads that volume\u2019s snapshot', async () => {
    withDevice('windows');
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({
      id: 'snap-d', capturedAt: new Date(), trigger: 'on_demand', partial: false,
      summary: {}, largestFiles: [], largestDirs: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [], duplicateCandidates: [],
      cleanupCandidates: [], errors: [],
    } as never);

    const raw = await registered.get('analyze_disk_usage')!.handler({ deviceId: DEVICE_ID, path: 'd:/' }, AUTH);

    expect(getLatestFilesystemSnapshot).toHaveBeenCalledWith(DEVICE_ID, 'D:\\');
    expect(JSON.parse(raw).scanPath).toBe('D:\\');
  });

  it('sends the normalised path to the agent and saves the snapshot under it', async () => {
    withDevice('windows');
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null as never);
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed', stdout: '{}' } as never);
    vi.mocked(saveFilesystemSnapshot).mockResolvedValue({
      id: 'snap-new', capturedAt: new Date(), trigger: 'on_demand', partial: false,
      summary: {}, largestFiles: [], largestDirs: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [], duplicateCandidates: [],
      cleanupCandidates: [], errors: [],
    } as never);

    await registered.get('analyze_disk_usage')!.handler({ deviceId: DEVICE_ID, refresh: true, path: 'd:/' }, AUTH);

    expect(aiExecuteCommand).toHaveBeenCalledWith(
      AUTH, 'analyze_disk_usage', DEVICE_ID, 'filesystem_analysis',
      expect.objectContaining({ path: 'D:\\', autoContinue: false }),
      expect.anything(),
    );
    const [, , , scanPath] = vi.mocked(saveFilesystemSnapshot).mock.calls[0]!;
    expect(scanPath).toBe('D:\\');
  });

  it('defaults to the OS root, which counts as root-scoped', async () => {
    withDevice('linux');
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null as never);
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed', stdout: '{}' } as never);
    vi.mocked(saveFilesystemSnapshot).mockResolvedValue(null as never);

    await registered.get('analyze_disk_usage')!.handler({ deviceId: DEVICE_ID, refresh: true }, AUTH);

    expect(aiExecuteCommand).toHaveBeenCalledWith(
      AUTH, 'analyze_disk_usage', DEVICE_ID, 'filesystem_analysis',
      expect.objectContaining({ path: '/', autoContinue: true }),
      expect.anything(),
    );
  });
});

describe('disk_cleanup — path (spec §9)', () => {
  it('previews the requested volume and pins it into the stored run', async () => {
    withDevice('windows');
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue({
      id: 'snap-d', scanPath: 'D:\\', capturedAt: new Date(), partial: false, cleanupCandidates: [],
    } as never);
    const values = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'run-1' }]) }));
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    const raw = await registered.get('disk_cleanup')!.handler(
      { deviceId: DEVICE_ID, action: 'preview', path: 'd:/' }, AUTH,
    );

    expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(DEVICE_ID, 'D:\\');
    expect(JSON.parse(raw).scanPath).toBe('D:\\');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      scanPath: 'D:\\',
      plan: expect.objectContaining({ scanPath: 'D:\\' }),
    }));
  });

  it('defaults to the OS root', async () => {
    withDevice('linux');
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue(null as never);

    const raw = await registered.get('disk_cleanup')!.handler({ deviceId: DEVICE_ID, action: 'preview' }, AUTH);

    expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(DEVICE_ID, '/');
    expect(JSON.parse(raw).scanPath).toBe('/');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiToolsFilesystem.scanPath.test.ts
```

Expected failure: `AssertionError: expected "getLatestFilesystemSnapshot" to have been called with [ '1111…', 'D:\\' ]` — Task 6's pin still passes `osRootScanPath(access.device.osType)`.

- [ ] **Step 3: Implement the schema** — in `apps/api/src/services/aiToolSchemas.ts`, replace the `disk_cleanup` entry (`:998-1007`):

```ts
  disk_cleanup: z.object({
    deviceId: uuid,
    action: z.enum(['preview', 'execute']),
    // The volume to preview/clean. Normalised server-side; defaults to the
    // device's OS root. `safePath` (not `cleanupPath`) so the blocked-prefix
    // list applies — a scan ROOT is never /proc, /sys or /dev.
    path: safePath.optional(),
    categories: z.array(z.enum(['temp_files', 'browser_cache', 'package_cache', 'trash'])).max(10).optional(),
    paths: z.array(cleanupPath).min(1).max(200).optional(),
    maxCandidates: z.number().int().min(1).max(200).optional(),
  }).refine(
    (data) => data.action === 'preview' || (data.action === 'execute' && Array.isArray(data.paths) && data.paths.length > 0),
    { message: 'paths are required for execute action' }
  ),
```

- [ ] **Step 4: Implement the handlers** — in `apps/api/src/services/aiToolsFilesystem.ts`, add to the imports:

```ts
import { normalizeScanPath, osRootScanPath } from '@breeze/shared';
```

In `analyze_disk_usage`, replace the path derivation (`:158-162`):

```ts
      const osType = access.device.osType;
      const scanPath = normalizeScanPath(
        osType,
        typeof input.path === 'string' && input.path.length > 0 ? input.path : osRootScanPath(osType),
      );
      // Narrower than the route's check on purpose: the tool has no volume
      // list, so only the OS root auto-continues a checkpointed baseline. A
      // second volume's scan simply does not self-resume from the AI lane.
      const isRootScopedScan = scanPath === osRootScanPath(osType);

      let snapshot = await getLatestFilesystemSnapshot(deviceId, scanPath);
```

replace the dispatch `path` (`:170`) with `path: scanPath,`, replace the save (`:186`) with:

```ts
        snapshot = await saveFilesystemSnapshot(deviceId, access.device.orgId, 'on_demand', scanPath, parsed);
```

and add `scanPath` to the returned JSON, as the first key of the object at `:194`:

```ts
      return JSON.stringify({
        scanPath,
        snapshot: {
```

Also update the `path` property description in the tool definition (`:139`):

```ts
          path: { type: 'string', description: 'Volume or directory to analyse (e.g. "C:\\\\", "D:\\\\", "/", "/data"). Defaults to the OS root.' },
```

In `disk_cleanup`, add the `path` property to the definition (after `action`, `:237`):

```ts
          path: { type: 'string', description: 'Volume to preview or clean (e.g. "C:\\\\", "D:\\\\", "/", "/data"). Defaults to the OS root.' },
```

and in the handler, replace the snapshot read (`:266-269`):

```ts
      const osType = access.device.osType;
      const scanPath = normalizeScanPath(
        osType,
        typeof input.path === 'string' && input.path.length > 0 ? input.path : osRootScanPath(osType),
      );

      const snapshot = await getLatestFilesystemCleanupSnapshot(deviceId, scanPath);
      if (!snapshot) {
        return JSON.stringify({
          scanPath,
          message: 'No filesystem analysis snapshot available for this volume. Run analyze_disk_usage with refresh=true first.',
        });
      }
```

In the preview lane, pin the volume on the run and echo it:

```ts
          .values({
            deviceId,
            orgId: access.device.orgId,
            scanPath: snapshot.scanPath,
            requestedBy: safeRequestedBy,
            plan: {
              snapshotId: snapshot.id,
              scanPath: snapshot.scanPath,
              categories: requestedCategories ?? safeCleanupCategories,
              preview,
            },
            status: 'previewed',
          })
```

```ts
        return JSON.stringify({
          cleanupRunId: cleanupRun?.id ?? null,
          scanPath: snapshot.scanPath,
          snapshotId: snapshot.id,
```

and in the execute lane, the same two edits:

```ts
        .values({
          deviceId,
          orgId: access.device.orgId,
          scanPath: snapshot.scanPath,
          requestedBy: safeRequestedBy,
          approvedAt: new Date(),
          plan: {
            snapshotId: snapshot.id,
            scanPath: snapshot.scanPath,
            requestedPaths,
            selectedPaths: selected.map((candidate) => candidate.path),
          },
```

```ts
      return JSON.stringify({
        cleanupRunId: cleanupRun?.id ?? null,
        scanPath: snapshot.scanPath,
        snapshotId: snapshot.id,
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd apps/api && npx vitest run \
  src/services/aiToolsFilesystem.scanPath.test.ts \
  src/services/aiToolsFilesystem.diskCleanupRequestedBy.test.ts \
  src/services/aiToolsFilesystem.fileWriteCap.test.ts \
  src/services/aiToolSchemas.validateToolInput.test.ts
```

Expected: `Test Files  4 passed (4)`. Each path is listed in full — `src/services/aiToolsFilesystem` as a substring would also match unrelated files, and a trailing slash would match none of them. (There is no `aiToolSchemas.test.ts`; `aiToolSchemas.validateToolInput.test.ts` is the suite that drives `toolInputSchemas` end to end.)

- [ ] **Step 6: Prove no AI tool registry needed a change**

```bash
cd apps/api && npx vitest run \
  src/services/aiAgents/agentToolCatalog.contract.test.ts \
  src/services/aiGuardrails.agentPrincipal.contract.test.ts \
  src/services/helperToolFilter.test.ts \
  src/services/toolTimeouts.test.ts
```

Expected: `Test Files  4 passed (4)` with no source edits. This task adds a property to two existing tools; it registers no tool, changes no tier and changes no rate limit, so every registry stays as it is. (W05 adds `system_cleanup`, which does touch all of them.)

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiToolsFilesystem.ts apps/api/src/services/aiToolsFilesystem.scanPath.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): analyze_disk_usage and disk_cleanup take a volume

Spec §9 (the path parameter only — tiers, registries and the system_cleanup
tool are W05). Both tools normalise the requested path server-side, read and
write per volume, pin it into the stored cleanup run, and echo scanPath so the
model can carry it between a preview and an execute.

disk_cleanup's Zod schema gains `path` (analyze_disk_usage's already had one).
No tool is registered and no tier or rate limit changes, so every tool registry
is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Web — `useFilesystemVolumes` and `VolumePicker`

**Files:**
- Create: `apps/web/src/components/devices/filesystem/useFilesystemVolumes.ts`
- Create: `apps/web/src/components/devices/filesystem/useFilesystemVolumes.test.tsx` (Test)
- Create: `apps/web/src/components/devices/filesystem/VolumePicker.tsx`
- Create: `apps/web/src/components/devices/filesystem/VolumePicker.test.tsx` (Test)
- Modify: `apps/web/src/locales/en/devices.json`, `de-DE`, `es-419`, `fr-FR`, `fr-CA`, `it-IT`, `pt-BR`, `tr-TR` (`deviceFilesystemTab` block)

**Interfaces:**
- Consumes: `fetchWithAuth` (`../../../stores/auth`), `useTranslation`, `formatNumber` (`@/lib/i18n/format`), `formatDateTime` (`@/lib/dateTimeFormat`).
- Produces:
  ```ts
  export type FilesystemVolume = { mountPoint: string; scanPath: string; fsType: string | null;
    totalGb: number | null; usedGb: number | null; freeGb: number | null; usedPercent: number | null;
    isOsRoot: boolean;
    scanState: { lastRunMode: string; lastBaselineCompletedAt: string | null; hasCheckpoint: boolean } | null;
    latestSnapshot: { id: string; capturedAt: string; partial: boolean; cleanupEstimateBytes: number } | null; };
  export function useFilesystemVolumes(deviceId: string): { volumes: FilesystemVolume[]; loading: boolean; error?: string; reload: () => Promise<void> };
  export default function VolumePicker(props: { volumes: FilesystemVolume[]; selectedScanPath: string; onSelect: (scanPath: string) => void; loading: boolean; error?: string }): JSX.Element;
  ```

> **New code goes in `filesystem/`, not in the 958-line tab.** W03 splits the tab into that directory (spec §8); putting the hook and the picker there now means W03 inherits two finished files instead of having to extract them.

- [ ] **Step 1: Add the ten locale keys, translated, in all eight catalogs**

In each `apps/web/src/locales/<locale>/devices.json`, add these keys inside the existing `deviceFilesystemTab` object. `localeParity.test.ts` requires identical key sets and identical interpolation tokens across all eight, and refuses any value that looks like a bare filesystem path — which is why the mount point is interpolated rather than baked in.

`en`:
```json
      "volumes": "Volumes",
      "volumesLoading": "Loading volumes...",
      "volumesEmpty": "No scannable volumes reported for this device.",
      "failedToFetchVolumes": "Failed to fetch volumes",
      "volumeOsBadge": "OS",
      "volumeUsedOfTotal": "{{used}} of {{total}} used",
      "volumeCapacityUnknown": "Capacity unknown",
      "volumeNeverScanned": "Never scanned",
      "volumeLastScanned": "Scanned {{when}}",
      "volumeSelectAria": "Select volume {{mountPoint}}",
```

`de-DE`:
```json
      "volumes": "Datenträger",
      "volumesLoading": "Datenträger werden geladen...",
      "volumesEmpty": "Für dieses Gerät wurden keine scanbaren Datenträger gemeldet.",
      "failedToFetchVolumes": "Datenträger konnten nicht abgerufen werden",
      "volumeOsBadge": "OS",
      "volumeUsedOfTotal": "{{used}} von {{total}} belegt",
      "volumeCapacityUnknown": "Kapazität unbekannt",
      "volumeNeverScanned": "Nie gescannt",
      "volumeLastScanned": "Gescannt {{when}}",
      "volumeSelectAria": "Datenträger {{mountPoint}} auswählen",
```

`es-419`:
```json
      "volumes": "Volúmenes",
      "volumesLoading": "Cargando volúmenes...",
      "volumesEmpty": "No se reportaron volúmenes analizables para este dispositivo.",
      "failedToFetchVolumes": "No se pudieron obtener los volúmenes",
      "volumeOsBadge": "SO",
      "volumeUsedOfTotal": "{{used}} de {{total}} en uso",
      "volumeCapacityUnknown": "Capacidad desconocida",
      "volumeNeverScanned": "Nunca analizado",
      "volumeLastScanned": "Analizado {{when}}",
      "volumeSelectAria": "Seleccionar volumen {{mountPoint}}",
```

`fr-FR` and `fr-CA` (identical, as the existing `deviceFilesystemTab` values in those two catalogs already are):
```json
      "volumes": "Volumes",
      "volumesLoading": "Chargement des volumes...",
      "volumesEmpty": "Aucun volume analysable signalé pour cet appareil.",
      "failedToFetchVolumes": "Impossible de récupérer les volumes",
      "volumeOsBadge": "OS",
      "volumeUsedOfTotal": "{{used}} sur {{total}} utilisés",
      "volumeCapacityUnknown": "Capacité inconnue",
      "volumeNeverScanned": "Jamais analysé",
      "volumeLastScanned": "Analysé {{when}}",
      "volumeSelectAria": "Sélectionner le volume {{mountPoint}}",
```

`it-IT`:
```json
      "volumes": "Volumi",
      "volumesLoading": "Caricamento volumi...",
      "volumesEmpty": "Nessun volume analizzabile segnalato per questo dispositivo.",
      "failedToFetchVolumes": "Impossibile recuperare i volumi",
      "volumeOsBadge": "OS",
      "volumeUsedOfTotal": "{{used}} di {{total}} in uso",
      "volumeCapacityUnknown": "Capacità sconosciuta",
      "volumeNeverScanned": "Mai scansionato",
      "volumeLastScanned": "Scansionato {{when}}",
      "volumeSelectAria": "Seleziona il volume {{mountPoint}}",
```

`pt-BR`:
```json
      "volumes": "Volumes",
      "volumesLoading": "Carregando volumes...",
      "volumesEmpty": "Nenhum volume analisável informado para este dispositivo.",
      "failedToFetchVolumes": "Não foi possível obter os volumes",
      "volumeOsBadge": "SO",
      "volumeUsedOfTotal": "{{used}} de {{total}} em uso",
      "volumeCapacityUnknown": "Capacidade desconhecida",
      "volumeNeverScanned": "Nunca verificado",
      "volumeLastScanned": "Verificado {{when}}",
      "volumeSelectAria": "Selecionar volume {{mountPoint}}",
```

`tr-TR`:
```json
      "volumes": "Birimler",
      "volumesLoading": "Birimler yükleniyor...",
      "volumesEmpty": "Bu cihaz için taranabilir birim bildirilmedi.",
      "failedToFetchVolumes": "Birimler alınamadı",
      "volumeOsBadge": "İS",
      "volumeUsedOfTotal": "{{total}} biriminin {{used}} kadarı kullanımda",
      "volumeCapacityUnknown": "Kapasite bilinmiyor",
      "volumeNeverScanned": "Hiç taranmadı",
      "volumeLastScanned": "{{when}} tarihinde tarandı",
      "volumeSelectAria": "{{mountPoint}} birimini seç",
```

- [ ] **Step 2: Write the failing tests** — create `apps/web/src/components/devices/filesystem/useFilesystemVolumes.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithAuth } from '../../../stores/auth';
import { useFilesystemVolumes, type FilesystemVolume } from './useFilesystemVolumes';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const volume = (scanPath: string, isOsRoot: boolean): FilesystemVolume => ({
  mountPoint: scanPath, scanPath, fsType: 'NTFS',
  totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot,
  scanState: null, latestSnapshot: null,
});

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => vi.clearAllMocks());

describe('useFilesystemVolumes', () => {
  it('loads the volumes for the device on mount', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ data: [volume('C:\\', true), volume('D:\\', false)] }));

    const { result } = renderHook(() => useFilesystemVolumes('device-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.volumes.map((v) => v.scanPath)).toEqual(['C:\\', 'D:\\']);
    expect(result.current.error).toBeUndefined();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/devices/device-1/filesystem/volumes',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('surfaces a failure instead of silently rendering an empty picker', async () => {
    fetchWithAuthMock.mockResolvedValue(
      { ok: false, status: 500, json: vi.fn().mockResolvedValue({ error: 'boom' }) } as unknown as Response,
    );

    const { result } = renderHook(() => useFilesystemVolumes('device-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.volumes).toEqual([]);
  });

  it('aborts the in-flight request on unmount so the poll cannot outlive the component (defect 9)', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchWithAuthMock.mockImplementation(async (_url, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return jsonResponse({ data: [] });
    });

    const { unmount, result } = renderHook(() => useFilesystemVolumes('device-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('reload refetches and replaces the list', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: [volume('C:\\', true)] }));
    const { result } = renderHook(() => useFilesystemVolumes('device-1'));
    await waitFor(() => expect(result.current.volumes).toHaveLength(1));

    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: [volume('C:\\', true), volume('D:\\', false)] }));
    await act(async () => { await result.current.reload(); });

    expect(result.current.volumes.map((v) => v.scanPath)).toEqual(['C:\\', 'D:\\']);
  });
});
```

and `apps/web/src/components/devices/filesystem/VolumePicker.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import VolumePicker from './VolumePicker';
import type { FilesystemVolume } from './useFilesystemVolumes';

const volume = (overrides: Partial<FilesystemVolume> & { scanPath: string }): FilesystemVolume => ({
  mountPoint: overrides.scanPath, fsType: 'NTFS',
  totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: false,
  scanState: null, latestSnapshot: null,
  ...overrides,
});

describe('VolumePicker', () => {
  it('renders one chip per volume, keyed on the scan path', () => {
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true }), volume({ scanPath: 'D:\\' })]}
        selectedScanPath="C:\\"
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    const chips = screen.getAllByTestId('volume-chip');
    expect(chips.map((chip) => chip.getAttribute('data-volume'))).toEqual(['C:\\', 'D:\\']);
  });

  it('marks the selected chip with aria-pressed so it is announced, not just coloured', () => {
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true }), volume({ scanPath: 'D:\\' })]}
        selectedScanPath="D:\\"
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    const chips = screen.getAllByTestId('volume-chip');
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('badges the OS volume', () => {
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true }), volume({ scanPath: 'D:\\' })]}
        selectedScanPath="C:\\"
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    expect(screen.getAllByTestId('volume-os-badge')).toHaveLength(1);
  });

  it('hands the scan path back on click', () => {
    const onSelect = vi.fn();
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true }), volume({ scanPath: 'D:\\' })]}
        selectedScanPath="C:\\"
        onSelect={onSelect}
        loading={false}
      />,
    );

    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);

    expect(onSelect).toHaveBeenCalledWith('D:\\');
  });

  it('says the capacity is unknown rather than rendering a fake 0%', () => {
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true, totalGb: null, usedGb: null, freeGb: null, usedPercent: null })]}
        selectedScanPath="C:\\"
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    expect(screen.getByTestId('volume-capacity')).toHaveTextContent('Capacity unknown');
    expect(screen.queryByTestId('volume-usage-bar')).not.toBeInTheDocument();
  });

  it('distinguishes a never-scanned volume from a scanned one', () => {
    render(
      <VolumePicker
        volumes={[
          volume({ scanPath: 'C:\\', isOsRoot: true }),
          volume({ scanPath: 'D:\\', latestSnapshot: { id: 's', capturedAt: '2026-09-19T09:00:00.000Z', partial: false, cleanupEstimateBytes: 4096 } }),
        ]}
        selectedScanPath="C:\\"
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    const chips = screen.getAllByTestId('volume-chip');
    expect(chips[0]!).toHaveTextContent('Never scanned');
    expect(chips[1]!).not.toHaveTextContent('Never scanned');
  });

  it('shows a loading state and an error state instead of an empty row', () => {
    const { rerender } = render(
      <VolumePicker volumes={[]} selectedScanPath="" onSelect={vi.fn()} loading />,
    );
    expect(screen.getByTestId('volume-picker-loading')).toBeInTheDocument();

    rerender(<VolumePicker volumes={[]} selectedScanPath="" onSelect={vi.fn()} loading={false} error="Failed to fetch volumes" />);
    const alert = screen.getByTestId('volume-picker-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Failed to fetch volumes');

    rerender(<VolumePicker volumes={[]} selectedScanPath="" onSelect={vi.fn()} loading={false} />);
    expect(screen.getByTestId('volume-picker-empty')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/useFilesystemVolumes.test.tsx src/components/devices/filesystem/VolumePicker.test.tsx
```

Expected failure: `Failed to resolve import "./useFilesystemVolumes"` and `"./VolumePicker"`.

- [ ] **Step 4: Implement the hook** — create `apps/web/src/components/devices/filesystem/useFilesystemVolumes.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWithAuth } from "../../../stores/auth";
import "../../../lib/i18n";

/** Mirrors `FilesystemVolume` in `apps/api/src/services/filesystemVolumes.ts`. */
export type FilesystemVolume = {
  mountPoint: string;
  /** The normalised key: send this back as `?path=` / `{ path }`. */
  scanPath: string;
  fsType: string | null;
  /** Null when the device has reported no disk row for this volume. */
  totalGb: number | null;
  usedGb: number | null;
  freeGb: number | null;
  usedPercent: number | null;
  isOsRoot: boolean;
  scanState: {
    lastRunMode: string;
    lastBaselineCompletedAt: string | null;
    hasCheckpoint: boolean;
  } | null;
  latestSnapshot: {
    id: string;
    capturedAt: string;
    partial: boolean;
    cleanupEstimateBytes: number;
  } | null;
};

/**
 * The device's scannable volumes.
 *
 * Every request owns an AbortController tied to unmount (spec §8) — the tab's
 * existing poll loop survives unmount today, which is defect 9, and the fix
 * starts with not repeating it here.
 */
export function useFilesystemVolumes(deviceId: string): {
  volumes: FilesystemVolume[];
  loading: boolean;
  error?: string;
  reload: () => Promise<void>;
} {
  const { t } = useTranslation("devices");
  const [volumes, setVolumes] = useState<FilesystemVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const response = await fetchWithAuth(
        `/devices/${deviceId}/filesystem/volumes`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({ error: t("deviceFilesystemTab.failedToFetchVolumes") }));
        throw new Error(body.error || t("deviceFilesystemTab.failedToFetchVolumes"));
      }
      const body = await response.json();
      if (controller.signal.aborted) return;
      setVolumes(Array.isArray(body?.data) ? (body.data as FilesystemVolume[]) : []);
      setError(undefined);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof Error ? err.message : t("deviceFilesystemTab.failedToFetchVolumes"),
      );
      setVolumes([]);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
    // `t` IS a dependency: the callback closes over it, and leaving it out is
    // what leaves a stale English fallback behind after a locale switch
    // (defect 9).
  }, [deviceId, t]);

  useEffect(() => {
    void reload();
    return () => abortRef.current?.abort();
  }, [reload]);

  return { volumes, loading, error, reload };
}
```

- [ ] **Step 5: Implement the picker** — create `apps/web/src/components/devices/filesystem/VolumePicker.tsx`:

```tsx
import { HardDrive, Loader2, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "@/lib/i18n/format";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import type { FilesystemVolume } from "./useFilesystemVolumes";
import "../../../lib/i18n";

type VolumePickerProps = {
  volumes: FilesystemVolume[];
  /** The scan path currently driving every panel below the picker. */
  selectedScanPath: string;
  onSelect: (scanPath: string) => void;
  loading: boolean;
  error?: string;
};

function formatGb(value: number): string {
  return `${formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} GB`;
}

function formatScannedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatUserDateTime(parsed, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The volume selector for the Disk Cleanup tab (spec §8). Selecting a chip
 * re-keys every panel below it; the picker itself owns no data.
 */
export default function VolumePicker({
  volumes,
  selectedScanPath,
  onSelect,
  loading,
  error,
}: VolumePickerProps) {
  const { t } = useTranslation("devices");

  if (loading) {
    return (
      <div
        data-testid="volume-picker-loading"
        className="flex items-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("deviceFilesystemTab.volumesLoading")}
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="volume-picker-error"
        role="alert"
        className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        <AlertCircle className="h-4 w-4" />
        <span>{error}</span>
      </div>
    );
  }

  if (volumes.length === 0) {
    return (
      <div
        data-testid="volume-picker-empty"
        className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
      >
        {t("deviceFilesystemTab.volumesEmpty")}
      </div>
    );
  }

  return (
    <div data-testid="volume-picker" className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {t("deviceFilesystemTab.volumes")}
      </p>
      <div className="flex flex-wrap gap-2">
        {volumes.map((volume) => {
          const selected = volume.scanPath === selectedScanPath;
          const capacityKnown =
            typeof volume.usedGb === "number" &&
            typeof volume.totalGb === "number" &&
            typeof volume.usedPercent === "number";
          return (
            <button
              key={volume.scanPath}
              type="button"
              data-testid="volume-chip"
              data-volume={volume.scanPath}
              aria-pressed={selected}
              aria-label={t("deviceFilesystemTab.volumeSelectAria", {
                mountPoint: volume.mountPoint,
              })}
              onClick={() => onSelect(volume.scanPath)}
              className={`min-w-[12rem] rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                selected
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted"
              }`}
            >
              <span className="flex items-center gap-1.5 font-medium">
                <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                {volume.mountPoint}
                {volume.isOsRoot && (
                  <span
                    data-testid="volume-os-badge"
                    className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground"
                  >
                    {t("deviceFilesystemTab.volumeOsBadge")}
                  </span>
                )}
              </span>

              <span data-testid="volume-capacity" className="mt-1 block text-muted-foreground">
                {capacityKnown
                  ? t("deviceFilesystemTab.volumeUsedOfTotal", {
                      used: formatGb(volume.usedGb as number),
                      total: formatGb(volume.totalGb as number),
                    })
                  : t("deviceFilesystemTab.volumeCapacityUnknown")}
              </span>

              {capacityKnown && (
                <span
                  data-testid="volume-usage-bar"
                  className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${Math.min(100, Math.max(0, volume.usedPercent as number))}%` }}
                  />
                </span>
              )}

              <span className="mt-1 block text-muted-foreground">
                {volume.latestSnapshot
                  ? t("deviceFilesystemTab.volumeLastScanned", {
                      when: formatScannedAt(volume.latestSnapshot.capturedAt),
                    })
                  : t("deviceFilesystemTab.volumeNeverScanned")}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run them and watch them pass**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/useFilesystemVolumes.test.tsx src/components/devices/filesystem/VolumePicker.test.tsx
```

Expected: `Test Files  2 passed (2)`, 11 tests passed.

- [ ] **Step 7: Run the locale parity guard**

```bash
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts
```

Expected: `Test Files  1 passed (1)`. This is what proves all eight catalogs got the ten keys, that `{{used}}` / `{{total}}` / `{{when}}` / `{{mountPoint}}` survive every translation, and that none of the new values reads as a bare path.

- [ ] **Step 8: Astro check and commit**

```bash
cd apps/web && pnpm exec astro check
git add apps/web/src/components/devices/filesystem/ apps/web/src/locales
git commit -m "$(cat <<'EOF'
feat(web): volume picker and volumes hook for the Disk Cleanup tab

Spec §8. The hook owns an AbortController tied to unmount (defect 9's leak
starts by not repeating it) and carries `t` in its dependency list so a locale
switch does not leave an English fallback behind. The picker renders one chip
per volume with an OS badge, a usage bar, and last-scan age — and says
"Capacity unknown" rather than drawing a fake 0% bar for a volume the device
has reported no disk row for.

Ten new strings, really translated in all eight catalogs, with the mount point
interpolated so no locale value is a bare filesystem path.

Both live in components/devices/filesystem/ — the directory W03's tab split
moves into, so W03 inherits them finished. Nothing mounts them yet; Task 14.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: MOUNT — wire the picker into `DeviceFilesystemTab` and re-key every panel

**Files:**
- Modify: `apps/web/src/components/devices/DeviceFilesystemTab.tsx:1-16` (imports), `:228-231` (delete `getDefaultScanPath`), `:265-289` (state), `:290-322` (`fetchSnapshot`), `:324-350` (`loadAll`), `:410-464` (`runAnalyze`), `:466-496` (`runCleanupPreview`), `:543-553` (render the picker)
- Create: `apps/web/src/components/devices/DeviceFilesystemTab.volumes.test.tsx` (Test)

**Interfaces:**
- Consumes: `useFilesystemVolumes`, `VolumePicker` (Task 13); `osRootScanPath` (`@breeze/shared`).
- Produces: no new export. The tab renders `<VolumePicker>` and drives every fetch off `selectedScanPath`.

> **This task exists because components have shipped unmounted before** (memory: "Codex wave plans need an explicit MOUNT task: W05 built 13 green components and never wired the page"). The page-level test below fails if the picker is not rendered inside the tab, and fails if selecting a chip does not re-key the snapshot fetch.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/DeviceFilesystemTab.volumes.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceFilesystemTab from './DeviceFilesystemTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const VOLUMES = [
  {
    mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS',
    totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: true,
    scanState: null, latestSnapshot: null,
  },
  {
    mountPoint: 'D:\\', scanPath: 'D:\\', fsType: 'NTFS',
    totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: 5, isOsRoot: false,
    scanState: null,
    latestSnapshot: { id: 'snap-d', capturedAt: '2026-09-19T09:00:00.000Z', partial: false, cleanupEstimateBytes: 4096 },
  },
];

function snapshotFor(scanPath: string) {
  return {
    data: {
      id: `snap-${scanPath}`, scanPath, capturedAt: '2026-09-19T09:00:00.000Z',
      trigger: 'on_demand', partial: false, reason: null, path: scanPath, scanMode: 'baseline',
      summary: { filesScanned: 10 },
      topLargestFiles: [], topLargestDirectories: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [],
      duplicateCandidates: [], cleanupCandidates: [], errors: [],
    },
  };
}

/** Routes every request the tab makes by URL, so nothing falls through. */
function routeByUrl() {
  fetchWithAuthMock.mockImplementation(async (rawUrl: string) => {
    if (rawUrl.includes('/filesystem/volumes')) return jsonResponse({ data: VOLUMES });
    if (rawUrl.includes('/commands')) return jsonResponse({ data: [] });
    if (rawUrl.includes('/filesystem?')) {
      const path = decodeURIComponent(new URL(rawUrl, 'https://x').searchParams.get('path') ?? '');
      return jsonResponse(snapshotFor(path));
    }
    if (rawUrl.endsWith('/filesystem')) return jsonResponse(snapshotFor('C:\\'));
    return jsonResponse({ data: null }, false, 404);
  });
}

function snapshotRequestPaths(): string[] {
  return fetchWithAuthMock.mock.calls
    .map(([url]) => url as string)
    .filter((url) => url.includes('/filesystem?') || url.endsWith('/filesystem'))
    .map((url) => decodeURIComponent(new URL(url, 'https://x').searchParams.get('path') ?? ''));
}

beforeEach(() => {
  vi.clearAllMocks();
  routeByUrl();
});

describe('DeviceFilesystemTab — volume picker mount (spec §8)', () => {
  it('renders the picker inside the tab with one chip per volume', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);

    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    expect(screen.getAllByTestId('volume-chip').map((c) => c.getAttribute('data-volume')))
      .toEqual(['C:\\', 'D:\\']);
  });

  it('selects the OS volume first and reads its snapshot', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);

    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    await waitFor(() => expect(snapshotRequestPaths()).toContain('C:\\'));
    expect(screen.getAllByTestId('volume-chip')[0]!).toHaveAttribute('aria-pressed', 'true');
  });

  it('re-keys the snapshot fetch when another volume is selected', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    await waitFor(() => expect(snapshotRequestPaths()).toContain('C:\\'));

    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);

    await waitFor(() => expect(snapshotRequestPaths()).toContain('D:\\'));
    expect(screen.getAllByTestId('volume-chip')[1]!).toHaveAttribute('aria-pressed', 'true');
  });

  it('scans the selected volume, not the OS root', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);
    await waitFor(() => expect(snapshotRequestPaths()).toContain('D:\\'));

    fetchWithAuthMock.mockClear();
    fetchWithAuthMock.mockImplementation(async (rawUrl: string) => {
      if (rawUrl.includes('/filesystem/scan')) {
        return jsonResponse({ success: true, data: { commandId: 'cmd-1', scanPath: 'D:\\' } }, true, 202);
      }
      if (rawUrl.includes('/commands/cmd-1')) return jsonResponse({ data: { id: 'cmd-1', status: 'completed' } });
      if (rawUrl.includes('/filesystem/volumes')) return jsonResponse({ data: VOLUMES });
      if (rawUrl.includes('/commands')) return jsonResponse({ data: [] });
      return jsonResponse(snapshotFor('D:\\'));
    });

    fireEvent.click(screen.getByTestId('filesystem-analyze'));

    await waitFor(() => {
      const scan = fetchWithAuthMock.mock.calls.find(([url]) => (url as string).includes('/filesystem/scan'));
      expect(scan).toBeDefined();
      expect(JSON.parse((scan![1] as RequestInit).body as string).path).toBe('D:\\');
    });
  });

  it('previews cleanup for the selected volume', async () => {
    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);
    await waitFor(() => expect(screen.getByTestId('volume-picker')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);
    await waitFor(() => expect(snapshotRequestPaths()).toContain('D:\\'));

    fetchWithAuthMock.mockClear();
    fetchWithAuthMock.mockImplementation(async (rawUrl: string) => {
      if (rawUrl.includes('/cleanup-preview')) {
        return jsonResponse({
          success: true,
          data: { cleanupRunId: 'run-1', scanPath: 'D:\\', estimatedBytes: 4096, candidateCount: 1, categories: [], candidates: [] },
        });
      }
      return jsonResponse({ data: [] });
    });

    fireEvent.click(screen.getByTestId('filesystem-cleanup-preview'));

    await waitFor(() => {
      const preview = fetchWithAuthMock.mock.calls.find(([url]) => (url as string).includes('/cleanup-preview'));
      expect(preview).toBeDefined();
      expect(JSON.parse((preview![1] as RequestInit).body as string).path).toBe('D:\\');
    });
  });

  it('falls back to the OS root when the volumes call fails, so the tab still works', async () => {
    fetchWithAuthMock.mockImplementation(async (rawUrl: string) => {
      if (rawUrl.includes('/filesystem/volumes')) {
        return jsonResponse({ error: 'boom' }, false, 500);
      }
      if (rawUrl.includes('/commands')) return jsonResponse({ data: [] });
      return jsonResponse(snapshotFor('C:\\'));
    });

    render(<DeviceFilesystemTab deviceId="device-1" osType="windows" />);

    await waitFor(() => expect(screen.getByTestId('volume-picker-error')).toBeInTheDocument());
    await waitFor(() => expect(snapshotRequestPaths()).toContain('C:\\'));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceFilesystemTab.volumes.test.tsx
```

Expected failure: `Unable to find an element by: [data-testid="volume-picker"]` — the tab does not render it.

- [ ] **Step 3: Implement the mount** — in `apps/web/src/components/devices/DeviceFilesystemTab.tsx`:

Add to the imports:

```ts
import { osRootScanPath } from "@breeze/shared";
import VolumePicker from "./filesystem/VolumePicker";
import { useFilesystemVolumes } from "./filesystem/useFilesystemVolumes";
```

Delete `getDefaultScanPath` (`:228-231`) — `osRootScanPath` replaces it, and having two definitions of "the default volume" is how the web and the API drift apart.

Add `scanPath` to the `FilesystemSnapshot` type (`:32-69`), next to `path`:

```ts
  /** The normalised key this snapshot is stored under (W02). */
  scanPath?: string | null;
```

and to `FilesystemCleanupPreview` (`:71-81`):

```ts
  scanPath?: string | null;
```

Add the volume state, just under the `useTranslation` line (`:270`):

```ts
  const {
    volumes,
    loading: volumesLoading,
    error: volumesError,
    reload: reloadVolumes,
  } = useFilesystemVolumes(deviceId);
  // Seeded with the OS root so the first render already has a volume to read
  // — the tab must work even when the volumes call fails outright.
  const [selectedScanPath, setSelectedScanPath] = useState<string>(() => osRootScanPath(osType));

  // Correct the selection once the real list arrives: keep it if it is still
  // offered, otherwise fall back to the OS volume, otherwise the first chip.
  useEffect(() => {
    if (volumes.length === 0) return;
    if (volumes.some((volume) => volume.scanPath === selectedScanPath)) return;
    const osVolume = volumes.find((volume) => volume.isOsRoot) ?? volumes[0]!;
    setSelectedScanPath(osVolume.scanPath);
  }, [volumes, selectedScanPath]);
```

Re-key `fetchSnapshot` (`:290-305`):

```ts
  const fetchSnapshot = useCallback(async () => {
    const response = await fetchWithAuth(
      `/devices/${deviceId}/filesystem?path=${encodeURIComponent(selectedScanPath)}`,
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({
          error: t("deviceFilesystemTab.failedToFetchFilesystemStatus"),
        }));
      throw new Error(body.error || t("deviceFilesystemTab.failedToFetchFilesystemStatus"));
    }
    const body = await response.json();
    return (body.data ?? null) as FilesystemSnapshot | null;
  }, [deviceId, selectedScanPath, t]);
```

(`fetchThresholdEvents` and `pollScanCommand` gain `t` in their dependency lists for the same reason — defect 9's third bullet — and are otherwise unchanged.)

Clear the per-volume view when the selection changes, so a `D:\` preview can never render under a `C:\` chip. Add immediately after the correction effect:

```ts
  // Changing volume invalidates everything below the picker. `loadAll` is
  // already keyed on selectedScanPath through fetchSnapshot, so the fetch
  // re-runs on its own; this clears the STALE preview in the same tick rather
  // than leaving another volume's candidates on screen until it returns.
  useEffect(() => {
    setCleanupPreview(null);
    setSnapshot(null);
  }, [selectedScanPath]);
```

Point `runAnalyze`'s body at the selection (`:420-421`) — replace `path: getDefaultScanPath(osType),` with `path: selectedScanPath,` — and change its dependency list to `[deviceId, loadAll, selectedScanPath, pollScanCommand, reloadVolumes, t]`, adding a volumes refresh after a successful scan so the chip's "scanned" age updates:

```ts
      setCleanupPreview(null);
      await Promise.all([loadAll(true), reloadVolumes()]);
      setScanCommand(null);
```

Point `runCleanupPreview`'s body at the selection (`:474`) — replace `body: JSON.stringify({}),` with `body: JSON.stringify({ path: selectedScanPath }),` — and change its dependency list to `[deviceId, selectedScanPath, t]`.

Render the picker. Inside the header card, immediately after the closing `</div>` of the title/actions row (`:604`) and before the `{error && …}` block:

```tsx
        <div className="mt-4">
          <VolumePicker
            volumes={volumes}
            selectedScanPath={selectedScanPath}
            onSelect={setSelectedScanPath}
            loading={volumesLoading}
            error={volumesError}
          />
        </div>
```

Finally give the two action buttons stable test ids — on the Analyze button (`:554-566`) add `data-testid="filesystem-analyze"`, and on the Cleanup Preview button (`:567-579`) add `data-testid="filesystem-cleanup-preview"`.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceFilesystemTab.volumes.test.tsx
```

Expected: `Test Files  1 passed (1)`, 6 tests passed.

- [ ] **Step 5: Prove the tab still belongs on the runAction allowlist and nothing else regressed**

```bash
cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts
```

Expected: `Test Files  2 passed (2)`. This wave adds no mutation, so `apps/web/src/lib/runActionAllowlist.ts:17` stays exactly as it is (amendment 14); W03 is the wave that removes it.

- [ ] **Step 6: Prove the old default-path helper is gone**

```bash
git grep -n 'getDefaultScanPath' -- apps/web
```

Expected: **no output.**

- [ ] **Step 7: Astro check and commit**

```bash
cd apps/web && pnpm exec astro check
git add apps/web/src/components/devices/DeviceFilesystemTab.tsx apps/web/src/components/devices/DeviceFilesystemTab.volumes.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): mount the volume picker in the Disk Cleanup tab

Spec §8. The picker renders above the scan controls and every panel below it
re-keys on the selection: the snapshot read, the scan POST and the cleanup
preview all carry the selected scan path, and switching volume clears the stale
preview in the same tick rather than leaving another volume's candidates on
screen.

Seeded with the OS root so the tab still works when the volumes call fails, and
corrected once the real list arrives. getDefaultScanPath is deleted —
osRootScanPath is the one definition, shared with the API.

The page-level test is the point: it fails if the picker is not rendered inside
the tab, and it fails if selecting a chip does not re-key the fetches.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Docs — the volumes half of `filesystem-analysis.mdx`

**Files:**
- Modify: `apps/docs/src/content/docs/features/filesystem-analysis.mdx` (a new `### Volumes` section under "Deep Filesystem Scan"; the three Database Schema tables at `:434-491`; the API Reference table at `:496-504`)
- Modify: `apps/api/src/data/docsIndex.json` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: docs only. §11's remaining docs work — the finished tab, the native catalog, `agents/commands.mdx`, `features/ai.mdx`, `features/mcp-server.mdx`, `features/playbooks.mdx` — belongs to W05.

- [ ] **Step 1: Write the failing check** — the docs contract this wave can fail is the index: `docsIndex.json` records every heading, so adding one without regenerating leaves the AI docs tool blind to it. Capture the current state first:

```bash
python3 -c "
import json
entries = json.load(open('apps/api/src/data/docsIndex.json'))
entry = next(e for e in entries if e['path'] == '/features/filesystem-analysis/')
print('Volumes' in entry['headings'])
"
```

Expected: `False`.

- [ ] **Step 2: Implement the docs** — in `apps/docs/src/content/docs/features/filesystem-analysis.mdx`, insert this section immediately after the "How Scanning Works" paragraphs and before `### Scan Strategies` (`:39`):

(Four backticks on the outer fence below because the block itself contains a fenced JSON sample — copy the inner three-backtick fences into the `.mdx` verbatim, and drop the four-backtick wrapper.)

````mdx
### Volumes

A scan targets one **volume** at a time. `GET /devices/:id/filesystem/volumes` lists the volumes a device can scan, derived from its reported disk inventory:

```json
{
  "data": [
    {
      "mountPoint": "C:\\",
      "scanPath": "C:\\",
      "fsType": "NTFS",
      "totalGb": 476.9,
      "usedGb": 401.2,
      "freeGb": 75.7,
      "usedPercent": 84.1,
      "isOsRoot": true,
      "scanState": {
        "lastRunMode": "incremental",
        "lastBaselineCompletedAt": "2026-10-18T02:14:00.000Z",
        "hasCheckpoint": false
      },
      "latestSnapshot": {
        "id": "8f2b...",
        "capturedAt": "2026-10-20T09:31:00.000Z",
        "partial": false,
        "cleanupEstimateBytes": 12884901888
      }
    }
  ]
}
```

Volumes that cannot be cleaned are not offered: read-only media (`cdfs`, `udf`, `iso9660`, `squashfs`), memory filesystems (`tmpfs`, `devtmpfs`), kernel filesystems (`proc`, `sysfs`), and container or network mounts (`overlay`, `nfs`, `nfs4`, `cifs`, `smbfs`, `9p`, `autofs`, and every `fuse*` variant), along with Windows UNC paths. Deleting through a network mount frees space on a machine that is not the one being cleaned.

The device's OS volume is always listed, even on a device that has not yet reported a disk inventory, so a fresh endpoint can still be scanned. When no disk row backs it, its capacity fields are `null` rather than `0`.

<Aside type="caution">
  **Every volume keeps its own state.** Scan checkpoints, the incremental baseline, the hot-directory list and the "latest snapshot" a cleanup preview reads are all keyed on `(device, volume)`. A scan of `D:\` neither resets nor is read by anything belonging to `C:\`.
</Aside>

#### Scan paths are normalised

The volume key is a normalised path, and it is what `scan_path` stores, what `?path=` expects and what the agent receives:

- **Windows** -- separators become `\`, repeats collapse, the drive letter is upper-cased, and a trailing `\` survives only on a volume root. `c:/Users//Todd/` and `C:\Users\Todd` are the same volume path; `c:\`, `C:/` and `C:` are all `C:\`.
- **macOS and Linux** -- repeats collapse, `.` and `..` resolve, and a trailing `/` survives only on `/` itself. Case is preserved: `/Users` and `/users` are different directories on a case-sensitive volume.

Requests may send any of these forms. The API normalises before reading or writing, so you never have to.
````

Replace the three Database Schema tables' rows (`:434-491`) so each records the new columns. In **Filesystem Snapshots**, add after the `device_id` row:

```mdx
| `scan_path` | text | The normalised volume/path this scan covered. One snapshot stream per volume. |
```

and replace the index line beneath the table:

```mdx
Indexed on `(device_id, scan_path, captured_at DESC)` for efficient latest-snapshot-per-volume queries.
```

In **Cleanup Runs**, add after the `device_id` row:

```mdx
| `scan_path` | text | The volume this run covers. Null for a system-cleanup run, which cleans the machine rather than a path. |
| `kind` | text | `files` (the itemized file engine) or `system` (OS-native cleaners). |
| `command_id` | UUID | The queued system-cleanup command, for `kind = 'system'` runs. |
```

and change the `status` row to:

```mdx
| `status` | enum | `previewed`, `running`, `executed`, or `failed`. |
```

In **Scan State**, replace the `device_id` row and add `scan_path`:

```mdx
| `device_id` | UUID | Foreign key to `devices`. First half of the primary key. |
| `scan_path` | text | The normalised volume. Second half of the primary key -- one checkpoint and baseline per volume. |
```

In the **API Reference** table (`:500-504`), add the volumes endpoint and note the query parameter:

```mdx
| `GET` | `/devices/:id/filesystem/volumes` | List the volumes this device can scan and clean | `devices.read` |
| `GET` | `/devices/:id/filesystem?path=` | Get the latest snapshot for a volume (defaults to the OS volume) | `devices.read` |
```

replacing the existing `GET /devices/:id/filesystem` row, and add a line under the table:

```mdx
`POST /devices/:id/filesystem/scan` and `POST /devices/:id/filesystem/cleanup-preview` both accept a `path` naming the volume; both default to the device's OS volume. Every response that concerns one volume echoes the normalised `scanPath` it used.
```

- [ ] **Step 3: Regenerate the docs index**

```bash
npx tsx scripts/build-docs-index.ts
```

- [ ] **Step 4: Run it and watch it pass**

```bash
python3 -c "
import json
entries = json.load(open('apps/api/src/data/docsIndex.json'))
entry = next(e for e in entries if e['path'] == '/features/filesystem-analysis/')
assert 'Volumes' in entry['headings'], entry['headings']
assert 'Scan paths are normalised' in entry['headings'], entry['headings']
print('ok')
"
```

Expected: `ok`.

- [ ] **Step 5: Run the docs checks CI runs**

```bash
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
pnpm test:docs-automation
bash scripts/security/check-customer-pii.sh
```

Expected: all four clean. The PII guard runs here because a docs-only change skips `security-audit` and #6187 shipped example addresses that later reddened every code PR on main.

- [ ] **Step 6: Commit**

```bash
git add apps/docs/src/content/docs/features/filesystem-analysis.mdx apps/api/src/data/docsIndex.json
git commit -m "$(cat <<'EOF'
docs(filesystem): volumes, normalised scan paths, and the new columns

Spec §11. Documents the volumes endpoint and its response, which filesystem
types are never offered and why, that the OS volume is always listed, and the
per-OS normalisation rules callers do not have to apply themselves. Records
scan_path on all three tables, kind/command_id and the `running` status on
cleanup runs, the composite scan-state key, and the ?path= parameter.

docsIndex.json regenerated so the AI docs tool can see the new headings.

The finished tab, the native cleaner catalog and the AI/playbook/command pages
are W05's docs pass.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: The verification gate

**Files:** none. Nothing is edited here; this is the run that decides the PR is real.

- [ ] **Step 1: Rebase onto current main and re-run the migration naming guard**

```bash
git fetch origin main --quiet
git merge origin/main --no-edit
bash scripts/check-migration-naming.sh --against-ref origin/main
```

Expected: clean merge, guard exits 0. **Local green is not CI green** — a branch cut before a migration landed on main passes the commit-time guard and fails at push. If the guard now reports that either file no longer sorts last, rename BOTH, sweep every reference (`git grep -n '2026-10-20-1500' -- apps`), and record it as an amendment.

- [ ] **Step 2: Typecheck everything the Type Check job checks**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
pnpm --filter @breeze/shared typecheck
cd apps/web && pnpm exec astro check
```

Expected: all three clean.

- [ ] **Step 3: Run the full shared, API and web unit suites**

```bash
cd packages/shared && npx vitest run
cd apps/api && npx vitest run
cd apps/web && npx vitest run
```

Expected: all green. The API run is the only thing that catches a mock factory elsewhere in the repo whose `saveFilesystemSnapshot` or `getFilesystemScanState` stub asserts the old arity — `git grep` found eight `helpers.*.test.ts` files that stub those functions, and a stub with no assertion on its arguments passes either way, so the compiler plus this run is the real coverage.

- [ ] **Step 4: Run every contract suite this wave can break**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts
cd apps/api && npx vitest run --config vitest.config.site-scope-coverage.ts
cd apps/api && npx vitest run --config vitest.config.integration-suite-coverage.ts
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
```

Expected: every one green. `pnpm test` does NOT run the RLS or integration configs, so skipping this step is how a unit-green PR reddens main. Needs a live database: `pnpm test-stack up` first.

- [ ] **Step 5: Drift check**

```bash
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.test | cut -d= -f2-)" pnpm db:check-drift
```

Expected: one ledger row per migration file, no ordering or idempotency error.

- [ ] **Step 6: Prove the registration lists are exactly as this plan claims (amendment 11)**

```bash
git grep -n 'device_filesystem' -- apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts
git grep -n 'device_filesystem' -- apps/api/src/services/ticketOrgMoveLockOrder.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git diff --stat origin/main...HEAD -- apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/ticketOrgMoveLockOrder.ts
```

Expected: the first grep lists the three tables in all three device/org cascade lists; the second returns **nothing**; the third returns **no output** — this wave changes no cascade list, which is a claim the diff has to back.

- [ ] **Step 7: Prove the scan-path sweep is complete**

```bash
git grep -n "=== 'C:\\\\\\\\'\|'C:\\\\\\\\'" -- apps/api/src apps/web/src | grep -v test | grep -v scanPath.ts
```

Expected: no hard-coded OS root outside `packages/shared/src/utils/scanPath.ts` and test fixtures. Every other site goes through `osRootScanPath`.

```bash
git grep -n 'deviceFilesystemSnapshots\.\|deviceFilesystemScanState\.' -- apps ee packages | grep -v '\.test\.' | grep -v 'db/schema'
```

Expected: matches only inside `apps/api/src/services/filesystemAnalysis.ts` and `apps/api/src/routes/agents/helpers.ts` (the threshold cooldown read). Any other file touching those tables directly would be a reader that bypasses the scan-path key.

- [ ] **Step 8: Lint**

```bash
pnpm --filter @breeze/api lint
pnpm --filter @breeze/web lint
```

Expected: clean.

- [ ] **Step 9: Tear down the local stack**

```bash
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

Expected: the second command lists nothing this session brought up. Nothing reaps a local stack for you.

- [ ] **Step 10: Open the PR**

```bash
gh pr create --base main --title "Disk Cleanup v2 W02: multi-volume filesystem analysis" --body "$(cat <<'EOF'
Closes #<subissue#>

## What

Gives filesystem analysis a scan-path axis. A `D:\` or `/data` scan no longer
resets the `C:\` baseline, pollutes its hot-directory list, or becomes the
"latest" snapshot a `C:\` cleanup preview deletes from (spec §2 defect 6), and
the incremental-vs-baseline decision compares a volume against its own recorded
usage instead of the fullest disk on the device (defect 8).

Spec: `docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md` §4, §5.1,
§5.2 (pinning only), §8 (picker + mount), §9 (`path` only), §11.

## Schema and code ship together

`upsertFilesystemScanState`'s `ON CONFLICT` target moves with the primary key.
A single-column target names no unique index after the migration and raises
`42P10`, so this cannot be split into a schema PR and a code PR.

On a multi-replica self-host, the window between the migration and the last old
replica draining makes old replicas fail scan-state upserts — the snapshot
insert still succeeds, and a re-run scan repairs the state. Release-notes item.

## Migrations

- `2026-10-20-150000-filesystem-multi-volume.sql` — `scan_path` on all three
  tables, the `(device_id, scan_path)` scan-state key, the swapped snapshot
  index, `kind` + `command_id` on cleanup runs. Both backfills elect
  `breeze.scope = 'system'` and report their counts.
- `2026-10-20-150100-filesystem-cleanup-run-status-running.sql` — the enum add,
  alone in its file.

## Registration lists

`CORE_TENANT_EXPORT_POLICY` gains five columns, all `included` — the one list
that fires on a new COLUMN. Every cascade list is verified unchanged and the
diff shows no edit to any of them: all three tables were already registered,
none carries a `ticket_id`, none is append-only, and all three are tenancy
shape 1 so no RLS allowlist applies.

## Agent

No agent change and no agent release. Old agents keep working: the API sends
the normalised path in the command payload and keys the result on it.
EOF
)"
```

- [ ] **Step 11: Watch CI and report**

```bash
gh pr checks --watch
```

Expected: `CI Success` green. `gh pr checks` exits non-zero while checks are pending, so read the output rather than the exit code. If **Integration Tests** is red on a shard this wave does not obviously touch, check the shard's `tenant-export-policy` and `tenantCascade` cases first — those are the two that fire on a new column and the two that a unit-green PR misses.

---

## Self-review

### Spec coverage

| Requirement | Spec | Task |
|---|---|---|
| Two migrations, names sorting after everything shipped, re-checked against `origin/main` | §4 | 2 (Step 1), 3, 16 (Step 1) |
| Enum add alone in its own file | §4 | 3 |
| `scan_path` on snapshots, NOT NULL, backfilled from `raw_payload->>'path'` else the OS root from `devices.os_type` | §4 | 2 (exact SQL `CASE`), 5 (proof) |
| New `(device_id, scan_path, captured_at DESC)` index created before the old one is dropped | §4 | 2, 5 |
| `scan_path` on scan state, composite primary key `(device_id, scan_path)` | §4 | 2, 5 |
| `scan_path` (nullable), `kind` + CHECK, `command_id` (no FK) on cleanup runs | §4 | 2, 5 |
| `running` cleanup-run status | §4 | 3, 4, 5 |
| Idempotent; `set_config('breeze.scope','system',true)` before every write; `RAISE WARNING` row counts | §4, CLAUDE.md | 2, 2 (Step 5) |
| Drizzle mirror incl. composite PK | §4 | 4 |
| Export-policy registry entries for all five new columns | §4 | 4, 5 (Step 5), 16 (Step 4) |
| RLS allowlists and cascade lists unchanged — and proved so | §4 | 4 (Step 6), 16 (Step 6), amendment 11 |
| `upsertFilesystemScanState` conflict target becomes `(deviceId, scanPath)` | §4 | 6 |
| Every scan-state and snapshot reader/writer takes `scanPath` | §4 | 6 (all), 9/10/11/12 (real paths) |
| `normalizeScanPath(osType, path)` in `packages/shared/src/utils/scanPath.ts`, used by API and web | §4 | 1, 6, 9, 10, 11, 12, 14 |
| `GET /filesystem/volumes` with the full `Volume` shape | §5.1 | 7, 8 |
| `isScannableVolume` + `NON_SCANNABLE_FS_TYPES` (incl. `fuse*` and UNC) | §5.1 | 7 |
| OS root always listed even with an empty `device_disks` | §5.1 | 7 |
| `GET /filesystem?path=`, response gains `scanPath` | §5.1 | 9 |
| `isRootScopedScan` = "normalised path equals a `Volume.scanPath`", replacing `=== 'C:\\'` | §5.1 | 9 |
| Agent result handler keys on normalised `command.payload.path`, never merges across paths | §5.1 | 11 |
| Disk-percent delta from the matching `device_disks` row; no match → baseline | §5.1, §2 defect 8 | 9 (route), 11 (handler) |
| `path`/`scanPath` pinned in cleanup-preview; `scanPath` in responses | §5.2 | 10 |
| `VolumePicker` + `useFilesystemVolumes` | §8 | 13 |
| Picker mounted in `DeviceFilesystemTab`, every panel re-keyed, with a page-level test | §8 | 14 |
| `path` on `analyze_disk_usage` and `disk_cleanup` (schema + handler) | §9 | 12 |
| Migration replay test, `db:check-drift`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `migrationRlsScope`, `rls-coverage`, route tests, web tests | §11 | 5, 16 |
| Docs: the volumes part of `filesystem-analysis.mdx` | §11 | 15 |

**Deliberately NOT in this wave** (and where each lives): the `contentsOnly`/`permanent`/`cleanupGuard` dispatch payload, the rooted rule table, the per-volume recycle bin and the accumulator fixes → W01. Required `cleanupRunId`, `rejectedPaths`, the execute budget, the tab split and its finished panels, run history and retention, and removing `DeviceFilesystemTab.tsx` from `runActionAllowlist.ts` → W03. The native cleaner catalog and both `system_cleanup` command types → W04. The `system_cleanup` AI tool, every tier/registry/label/timeout entry, `actRevalidation`/`actVerify`, the built-in playbook, the lab proof and the remaining five docs pages → W05.

### Placeholder scan

`grep -nE 'TBD|TODO|FIXME|similar to Task|handle edge cases|add validation'` over this document returns exactly two lines, both in this section's own quoting of the pattern and in the frontmatter:
- `tracking_issue: LanternOps/breeze#TBD-REGISTERED-AFTER-PLANS`, which the plan contract requires verbatim until registration;
- this paragraph.

Also present and deliberate: `<parent#>` / `<subissue#>` in the **Branch** line, the PR body's `Closes`, and the Global Constraints — the one placeholder pair the contract allows. `amendment 15` in amendment 13 and Task 16 Step 1 is an instruction to ADD an amendment if the migration names stop sorting last, not an unfilled slot.

Every code step carries a complete code block. No step says "similar to" another; the repeated fragments (the device-access preamble, the `values({...})` shapes) are written out in full each time.

### Type-consistency check

- `FilesystemVolume` is declared twice on purpose — `apps/api/src/services/filesystemVolumes.ts` and `apps/web/src/components/devices/filesystem/useFilesystemVolumes.ts` — with identical field names and nullability (`totalGb`/`usedGb`/`freeGb`/`usedPercent` are `number | null` on both sides). The web copy carries a comment naming the API type as its source. They are not shared through `@breeze/shared` because the web copy is a wire-shape mirror, not a contract the API imports; W03's tab split is the place to revisit that if a third consumer appears.
- `normalizeScanPath(osType: unknown, path: string)` takes `unknown` for the OS so every caller can pass `device.osType` (`'windows' | 'macos' | 'linux'`), `(device as { osType?: unknown }).osType` (the route's loosely-typed device), or `deviceRow.osType` without a cast. `ScanPathOsType` is exported for callers that want the narrow type.
- `saveFilesystemSnapshot(deviceId, orgId, trigger, scanPath, payload)` — `scanPath` at index 3, all scalars before the blob. The two positional destructures in `agents.test.ts` are updated in the same task (amendment 7).
- `getLatestFilesystemCleanupSnapshot` now projects `{ id, scanPath, capturedAt, partial, cleanupCandidates }`. `buildCleanupPreview(snapshot)` needs only `{ id, cleanupCandidates }`, so the widened projection satisfies it structurally with no signature change.
- `filesystemCleanupRunStatusEnum.enumValues` widens from three literals to four. Verified no exhaustive switch exists over it: the only consumers are `routes/devices/filesystem.ts:303`, `services/aiToolsFilesystem.ts:290` and `services/aiAgents/actRevalidation.ts:148`, each comparing against a single literal.
- `deviceFilesystemScanState.deviceId` changes from `.primaryKey()` to `.notNull()`; both produce a non-nullable `string` in `$inferSelect`, so no consumer's type changes.

### Open questions for the reviewer

None blocking. One judgement call worth a second opinion: Task 7 issues two queries per volume (capped at 24) rather than one `DISTINCT ON` over all volumes. The Drizzle-native form is far easier to mock and to read, a real endpoint has one to four fixed volumes, and the cap bounds the pathological case — but if a Linux fleet with large mount tables makes `GET /filesystem/volumes` slow in practice, the fix is a single windowed query in `filesystemVolumes.ts` and nothing else moves.
