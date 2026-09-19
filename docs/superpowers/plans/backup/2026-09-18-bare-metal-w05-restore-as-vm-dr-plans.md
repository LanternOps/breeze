---
tracking_issue: LanternOps/breeze#5493
---

# Wave 05 — Restore-as-VM (Linux guest images) and DR plans on the rebuild engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rebuild engine gains a `vhdx` target (raw image → `qemu-img convert` → dynamic VHDX) so a Linux whole-machine snapshot can be rebuilt into a Hyper-V-ready disk image on any Linux device running the Breeze helper; the server can drive such a rebuild through a new `bare_metal_rebuild` device command; Restore-as-VM offers that path for Linux snapshots; and DR plans get a `BARE_METAL_REBUILD` step whose rehearsal mode rebuilds every device in the group to VHDX images with `identity: new` on a chosen rebuild host, and whose failover mode creates a bare-metal recovery per device, surfaces the code, and waits for `checked_in`.

**Architecture:** Two PRs on one wave issue (#5498). **W05a** (agent + API command + Restore-as-VM): engine `TargetKind` `vhdx` with an explicit eighth phase `convert`; new command type `bare_metal_rebuild` registered in all five command registries; the helper executes it by reusing the W04a token mode (`breeze-backup rebuild --token`) and reporting progress to `/bmr/recover/progress`; a new service `bareMetalRecoveryService.ts` extracts create/mint/cancel/reissue from the W04a route so DR and Restore-as-VM can create recoveries without HTTP; Restore-as-VM's `POST /backup/restore/as-vm` accepts `engine: 'rebuild'` for snapshots that carry a layout manifest and writes both a `bare_metal_recoveries` row and a `restore_jobs` row so existing views see it. **W05b** (DR + web): `bare_metal_recoveries` gains `dr_execution_id`/`dr_group_id`; DR authorization learns the new step (source = each device's latest restorable snapshot, rebuild host = an authorized target device); `dispatchGroup` gets a non-command branch that creates one recovery per device (deduped through a first-class `results.queuedRecoveries[]`), and `computeGroupResults` derives device status from recovery rows; the DR plan editor gains a step-type selector (it has none today, so every UI-created group currently fails at dispatch), and the execution view shows live recovery state with an MFA-gated "reissue code" action instead of storing a code anywhere.

**Tech Stack:** Go (`agent/internal/backup/rebuild`, `agent/cmd/breeze-backup`), Hono + Drizzle + zod + Vitest (`apps/api`), PostgreSQL migration, React + Vitest (`apps/web`), `qemu-utils` on the rebuild host and in CI.

**Spec:** `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §2 decisions 6–7, §3 (Restore-as-VM and DR rows), §4 (targets, fronts), §6 (targets line, identity `new`), §8.1 (`identity: new` completes at `validated`), §8.3, §9 ("Rehearsals cannot resume the production identity"), §11 item 5. Not the Windows-native VHDX target, offline hives or DISM injection (W06); not Instant Boot for Linux guests (needs a differencing VHDX on the Hyper-V host — W06); not WinPE (W07); not docs/UI polish beyond what is needed to reach the new paths (W08).

**Depends on:** W03 (`rebuild.Run`, `Options`, `Result`, `Target`), W04a (`bare_metal_recoveries`, `bmrRecoveries.ts`, token mode in `rebuild_cmd.go`, `bmr.PostRecoveryProgress`), W04b (recovery console — untouched). Independent of the #5412 rebuild-engine gate fix (`fix/5412-rebuild-engine-system-state-gate`); if that lands first, `rebuild.Options.ExpectSystemState` exists and the helper's command handler must set it from the bootstrap exactly as `rebuild_cmd.go` token mode does.

## Global Constraints

- **Engine target kinds after this wave:** `disk`, `image`, `vhdx`. `Target{Kind: "vhdx", Path: "/srv/rebuild/dev-1.vhdx", ImageSizeBytes}`; the engine derives its raw staging file as `<Path>.raw` (sparse, same size rule as `image`), attaches it with the existing `AttachImage`, runs the seven W03 phases against the loop device, then phase 8 `convert` runs `qemu-img convert -f raw -O vhdx -o subformat=dynamic <Path>.raw <Path>` and deletes the raw file. `Result` gains no new fields: `Result.Target` already serialises `Kind`/`Path`, and the raw path is reported as the `convert` phase message.
- **`AllPhases` gains `PhaseConvert = "convert"` as the LAST entry.** It is recorded as skipped (`PhaseResult.Skipped = true`, message `not an image conversion target`) for `disk` and `image` so the phase table stays fixed-length for every caller (CLI progress, console, W06's Windows engine, which will record it skipped too).
- **Preflight for `vhdx`:** refuse (`RefusalError`) when `qemu-img` is not on `PATH` (`qemu-img not installed on this host; install qemu-utils`), and when free space on `dir(Path)` is less than `1.5 × ImageSizeBytes` (`not enough free space for raw image plus VHDX: need N, have M`). Nothing is written before these pass.
- **Engine host:** Linux only in this wave. On other platforms `rebuild.Run` already fails with `ErrUnsupportedHost`; the helper's command handler returns that error text verbatim in the command result so the server can show it.
- **New command type** `CommandTypes.BARE_METAL_REBUILD = 'bare_metal_rebuild'`. It MUST be registered in all five places or Test API reds: `services/commandTypes.ts`; `RESTORE_TIMEOUT_TYPES` in `services/commandTimeouts.ts:92-98`; `LONG_TIMEOUT_TYPES` in `services/commandOfflinePolicy.ts:145-157` (`commandOfflinePolicy.test.ts` asserts every type is classified); the auto-audit set in `services/commandQueue.ts:375-395` and the timed-out restore branch at `:818-819`; `terminalPayloadErasureSet()` in `routes/devices/commands.ts:1028` (the payload carries a recovery token — erase on terminal). Agent side: `agent/cmd/breeze-backup/main.go:761` and `:919` dispatch tables, plus `agent/internal/remote/tools/types.go:182` constant `CmdBareMetalRebuild`.
- **Command payload** (`bare_metal_rebuild`): `{ recoveryId, token, server, target: { kind: 'vhdx'|'image', path, imageSizeBytes? }, identity: 'original'|'new', outputDir? }`. The payload carries a server-minted **recovery token**, never the 9-character code (the exchange route is public and would turn the payload into a bearer credential). `identity` in the payload is informational; the helper takes identity from the bootstrap's `recovery.identity` (server-enforced), exactly as token mode does today.
- **Rehearsal invariant (§9):** any recovery created with `executionType = 'rehearsal'` or `engine = 'rebuild'` for Restore-as-VM is created with `identity: 'new'` server-side. The client cannot override it. `identity: new` recoveries complete at `validated` (W04a).
- **`bare_metal_recoveries` new columns (W05b):** `dr_execution_id uuid NULL REFERENCES dr_executions(id) ON DELETE SET NULL`, `dr_group_id uuid NULL REFERENCES dr_plan_groups(id) ON DELETE SET NULL`, `executing_device_id uuid NULL REFERENCES devices(id) ON DELETE SET NULL` (the rebuild host; NULL for boot-media recoveries). Migration `apps/api/migrations/2026-10-20-150000-bare-metal-recoveries-dr-link.sql` (sorts after the newest committed `2026-10-20-130100-…`; re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing). Export policy: all three → `included`. No cascade-list change (table already registered in all four lists; `bare_metal_recoveries` sorts before `dr_executions`/`dr_plan_groups`, so children-before-parents holds; `executing_device_id` is a second device FK — `CORE_DEVICE_CASCADE_DELETE_TABLES` deletes by `device_id` only, so the migration's `ON DELETE SET NULL` covers host deletion).
- **DR step contract** (`restoreConfig` for `commandType: 'BARE_METAL_REBUILD'`), validated by `drBareMetalRebuildConfigSchema`: `{ commandType: 'BARE_METAL_REBUILD', snapshotSelection: 'latest_restorable', rebuildHostDeviceId?: uuid, outputDir?: string (default '/var/lib/breeze/rebuild/out'), waitTimeoutMinutes: int 5..1440 (default 240) }`. `rebuildHostDeviceId` is REQUIRED when the execution type is `rehearsal`, ignored for `failover`/`failback`. The step is not a device command for failover: no command is queued, one recovery is created per group device, and the operator boots media and types the code.
- **DR authorization for the step:** `resolveDrGroupAuthorizationRefs` adds, for this step type, one `{kind:'snapshot', role:'source'}` ref per group device (that device's latest `bare_metal_restorable = true` snapshot, resolved through a new dependency `resolveLatestRestorableSnapshotId(orgId, deviceId)`; a device with none → `resource_not_found`) and, when present, `{kind:'device', id: rebuildHostDeviceId, role:'target'}`. `manage_dr_plan` in `aiToolsDR.ts:440` adds `rebuildHostDeviceId` to `deviceArgs`. The DR trigger route already has `requireMfa()` (`routes/dr.ts:556`); it additionally requires `PERMISSIONS.BACKUP_WRITE` when any group in the plan uses `BARE_METAL_REBUILD` (same bar as `POST /bmr/recoveries`).
- **DR results shape:** `DrExecutionResults` gains `queuedRecoveries: Array<{ groupId, groupName, deviceId, recoveryId, executingDeviceId: string|null, commandId: string|null, createdAt }>`. `computeGroupResults` derives a device's status from its recovery row when a `queuedRecoveries` entry exists for it: `checked_in|completed → completed`, `failed|refused → failed`, else `running`; and `failed` with reason `timeout` when `now - createdAt > waitTimeoutMinutes`. Dedupe key at dispatch is `(groupId, deviceId)` in `queuedRecoveries`, so reconcile never creates a second recovery.
- **In-flight guard:** the W04a "one non-terminal recovery per device" 409 stays. DR dispatch records that 409 as a `failedDispatches` entry (`recovery_in_progress`) rather than throwing. `POST /bmr/recoveries/:id/cancel` (new, MFA + `BACKUP_WRITE`) moves a non-terminal recovery to `failed` with `failureReason: 'cancelled'` so an operator can clear a stuck rehearsal.
- **Codes are never stored in plaintext anywhere** (not in `dr_executions.results`, not in `restore_jobs`). The execution view reveals a code through `POST /bmr/recoveries/:id/reissue-code` (new, MFA + `BACKUP_WRITE`, audited `bmr.recovery.reissue_code`): allowed while status ∈ {`created`, `media_booted`}; rotates `code_hash`, resets `code_expires_at` (15 min), returns the new code once. Rate limit 5/hour per recovery.
- **Restore-as-VM engine path:** `bmrVmRestoreSchema` gains `engine: z.enum(['hyperv','rebuild']).default('hyperv')`, `rebuildHostDeviceId: uuid` (required when `engine = 'rebuild'`), `outputPath: string` (absolute, `.vhdx`, required when `engine = 'rebuild'`); `hypervisor`/`vmName`/`switchName` stay required only for `hyperv`. `engine = 'rebuild'` requires `backup_snapshots.layout_manifest_key IS NOT NULL` and `bare_metal_restorable = true` (409 `snapshot_not_bare_metal_restorable` otherwise). It creates a recovery (`identity: 'new'`, `executingDeviceId = rebuildHostDeviceId`), mints the token, inserts a `restore_jobs` row (`restoreType: 'full'`, `targetConfig: { mode: 'rebuild_vhdx', outputPath, rebuildHostDeviceId }`, `recoveryTokenId`), queues `bare_metal_rebuild` to the host, and returns `{ jobId, recoveryId, commandId }`. Hyper-V `New-VM` is NOT wired to the produced VHDX in this wave; the wizard says so ("Attach the VHDX to a Hyper-V VM manually; automatic VM creation for Linux guests arrives with the Windows engine").
- **Command result → rows:** `handleBareMetalRebuildResult` (new in `commandResultHandlers.ts`) updates the `restore_jobs` row by `commandId` through the existing `updateRestoreJobByCommandId` and, when the helper's progress posts did not reach the server (offline host), applies the terminal status to the recovery row from the command result (`completed` → `validated` then `completed` for `identity: new`; `refused` → `refused`; `failed` → `failed`). The progress route stays the primary path.
- **Audit actions:** `bmr.recovery.create` (existing, now with `source: 'route'|'dr'|'vm_restore'`), `bmr.recovery.cancel`, `bmr.recovery.reissue_code`, `bmr.rebuild.command` (queue), `dr.step.bare_metal_rebuild.dispatch`.
- **Web i18n:** every new key needs REAL translations in all seven non-English locales (`translationCoverage.test.ts` caps exact-English duplicates); run `cd apps/web && npx vitest run src/lib/i18n`.
- No internal hostnames/IPs in committed files.

## 0. Ground truth (verified 2026-09-18 on main @ `0e38df6b6`)

- `agent/internal/backup/rebuild/types.go:18-35` `TargetKind` (`TargetDisk`, `TargetImage`), `Target{Kind, Path, ImageSizeBytes}`; `:37-43` `IdentityOriginal|IdentityNew`; `:64` `AllPhases`; `:116-142` `Options` (`SnapshotID, Provider, Target, Identity, Marker, Layout, StateDir, StagingRoot, DryRun, ForceReprovision, AllowPartialRestore, RegenerateInitramfs, SkipBoot, System, Progress`); `:146-163` `Result{SnapshotID, Target, Identity, Status, PhaseReached, Phases []PhaseResult, Plan, Refusal, Error, Warnings, FilesRestored, BytesRestored, DurationMs, Resumed}`; `:165` `RefusalError`. `engine.go:71` `Run(ctx, opts) (*Result, error)`; `:76` target-kind validation (`!= TargetDisk && != TargetImage` → error); `:100-105` phase table; `:110-122` resume + `reattach`. `provision.go:258` `(*run).attach`, `:278` `(*run).reattach`; `system.go:18` `System` interface (`Run, Chroot, BlockDeviceSize, AttachImage, PartitionDevice, Exists, Rescan, MountedSources, RootSources, Mount, BindMount, Unmount, Sync, Arch`); `system_linux.go:38` `AttachImage(path, sizeBytes) (string, func() error, error)`; `system_other.go` → `ErrUnsupportedHost` (`system.go:13`). `preflight.go:130-137` system-state probe. `validate.go:31` `validate`. Fake seam `system_fake_test.go` (`fakeSystem`); root-gated `loopback_linux_test.go` `TestRun_LoopbackRealSystem` (`BREEZE_REBUILD_LOOP_TEST=1`).
- `agent/cmd/breeze-backup/rebuild_cmd.go` — flags `:155-169` (`--target "disk:/dev/sdX or image:/path"`, `--image-size`, `--token`, `--server`, `--identity`, `--marker-file`, `--result-json`, `--state-dir`, `--dry-run`, `--force-reprovision`, `--allow-partial`, `--no-initramfs`, `--skip-boot`); token mode `:91-135` (`bmr.AuthenticateRecoverySession` → `bs.Recovery` required → `bmr.NewRecoveryProvider` → identity from `bs.Recovery.Identity` → marker only for `original` → `snapshotID` from `bs.Snapshot.SnapshotID` → `report` posts `bmr.PostRecoveryProgress`); `runRebuildAndReport(ctx, cmd, opts, tokenMode, report, resultJSONPath)` `:183`; `parseTargetFlag` + test `rebuild_cmd_test.go:24` asserts `vhdx:/x` is an error (this test flips). Command dispatch tables `agent/cmd/breeze-backup/main.go:761` (`case "bmr_recover":`) and `:919`; `agent/internal/remote/tools/types.go:182` `CmdBMRRecover = "bmr_recover"`. Hyper-V exec `agent/cmd/breeze-backup/exec_hyperv.go:749` `execVMRestoreFromBackup(parentCtx, payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult` (pattern: unmarshal payload → `fail(...)` / `marshalResult(result, err)`).
- `agent/internal/backup/bmr/progress.go:18` `ProgressUpdate`, `:57` `PostRecoveryProgress(ctx, serverURL, token, u)`; `session.go:194` `AuthenticateRecoverySession(ctx, serverURL, token) (*BootstrapResponse, error)`; `BootstrapResponse.Recovery{ID, Identity, Nonce}`.
- `apps/api/src/db/schema/bareMetalRecoveries.ts:12-18` statuses + terminal set; `:20-53` table (`orgId, deviceId, snapshotId, recoveryTokenId, identity, codeHash (unique), codeExpiresAt, codeUsedAt, nonceHash, status, target, plan, result, failureReason, warnings, createdBy, timestamps`). Migration `2026-10-15-160200-bare-metal-recoveries.sql`. Registered: `tenantCascade.ts:370`, `routes/devices/core.ts:274,497`, `tenantExportPolicyRegistry.ts:153`.
- `apps/api/src/routes/backup/bmrRecoveries.ts` — `POST /bmr/recoveries` `:103-191` (`requireScope`, `BACKUP_WRITE`, `requireMfa`, `bmrRecoveryCreateSchema`; `authorizeRouteResilienceResources(c, orgId, [{kind:'snapshot', id, role:'source'}], 'token')`; snapshot lookup + `bareMetalRestorable !== true` → 409 `snapshot_not_bare_metal_restorable`; in-flight 409 `recovery_in_progress` `:141-155`; insert `:158-176` with `codeHash: hashRecoveryCode(code)`, `codeExpiresAt: now + RECOVERY_CODE_TTL_MS`, placeholder `nonceHash`; audit `bmr.recovery.create`; returns `{...toRecoverySummary(row), code: formatRecoveryCode(code)}` 201). `GET /bmr/recoveries` `:193`, `GET /:id` `:221`. Public `POST /bmr/recover/exchange` `:334-470` (mints `recoveryTokens` row `:379-406` with `restoreType: 'bare_metal'`, links `recoveryTokenId` + status `media_booted` `:422-423`, returns token + bootstrap via `buildAuthenticatedBootstrapPayload` `:280`). Public `POST /bmr/recover/progress` `:491` (`canTransition` `:532`, timestamp map `:483`). `toRecoverySummary`/`isOverdue` `:73-81`. Helpers `services/bareMetalRecoveryCodes.ts` (`generateRecoveryCode`, `hashRecoveryCode`, `formatRecoveryCode`, `normalizeRecoveryCode`, `generateRecoveryNonce`, `hashRecoveryNonce`, `RECOVERY_CODE_TTL_MS`). Schemas `routes/backup/schemas.ts:302-327` (`bmrRecoveryCreateSchema`, `bmrRecoveryListSchema`, `bmrExchangeSchema`, `bmrProgressSchema`). Mounted `routes/backup/index.ts:28,42`.
- `apps/api/src/routes/backup/vmrestore.ts` — `POST /backup/restore/as-vm` `:116` (`BACKUP_READ` + `DEVICES_EXECUTE` + `requireMfa`, `bmrVmRestoreSchema` `schemas.ts:376-389`; `authorizeRouteResilienceResources(c, orgId, [snapshot source, device target], 'restore')` `:132`; `restoreJobs` insert `restoreType: 'full'` `:179`; audit `bmr.vm_restore.create` `:243`); `GET /backup/restore/instant-boot/active` filters `targetConfig ->> 'mode'` `:463`. `db/schema/backup.ts:460-470` `restoreJobs` (`restoreType`, `status`, `targetConfig jsonb`, `recoveryTokenId`). `services/commandResultHandlers.ts:903` maps `vm_instant_boot → handleVmRestoreResult` (`:198`, calls `updateRestoreJobByCommandId`); `services/restoreResultPersistence.ts:80-100` metadata whitelist (`vhdxPath`, `stateApplied`, `validated`, `warnings`, `error`…).
- `apps/api/src/services/drExecutionService.ts` — `DR_ALLOWED_COMMAND_TYPES` `:19-25`; `DrExecutionResults` `:40-103` (`queuedCommands: QueuedDrCommand[]` `:97`, `failedDispatches`, `groupResults`, `dispatchStatus`, `haltReason`); `computeGroupResults(groups, queuedCommands, failedDispatches, commandMap)` `:199-240` (status via `normalizeCommandStatus`, `undefined → 'running'` `:183-188`); `EXPLICIT_SOURCE_FIELDS` `:365-375`; `resolveDrGroupAuthorizationRefs(group, orgId, deps)` `:377-424` (device targets from `group.devices`, sources from explicit fields or `payload.snapshotId`, `sourceKeys.size === 0 → resource_not_found`); `createDrExecutionAndEnqueue` `:444`; `dispatchGroup(execution, group, currentResults)` `:483-598` (`alreadyQueued` from `queuedCommands` `:544`, `queueCommandForExecution(deviceId, commandType, {...}, {userId, expectedOrgId})` `:559`); `pickNextGroup` `:600`; `reconcileDrExecution(executionId)` `:668` (`nextDelayMs: 2_000` `:809-810`). `routes/backup/drResultHandler.ts:61` `handleDrCommandResult`. `routes/dr.ts` trigger `:553-558` (`requireMfa()`, `drExecutionTriggerSchema`); group create `:398`, update `:446`. `routes/backup/schemas.ts:481-497` `drGroupCreateSchema`/`drGroupUpdateSchema` (`restoreConfig: z.record(z.string(), z.any()).optional()`), `:499` `drExecutionTriggerSchema`. `services/aiToolsDR.ts:405` reads, `:561/:604` write `restoreConfig`; `:440` `deviceArgs: ['devices']`. Web: `apps/web/src/components/dr/DRPlanEditor.tsx`, `DRPlanGroupCard.tsx:14-21` (`DRGroupForm = {localId, id?, name, deviceIds, estimatedDurationMinutes, dependsOnGroupKey}` — no `restoreConfig`), `DRDashboard.tsx:98/410`, `DRExecutionView.tsx`.
- Tests to extend: `agent/internal/backup/rebuild/{engine_test,preflight_test,provision_test}.go`, `agent/cmd/breeze-backup/{rebuild_cmd_test,rebuild_cmd_token_test}.go`; `apps/api/src/routes/backup/{bmrRecoveries,vmrestore}.test.ts`, `services/{drExecutionService,commandOfflinePolicy,commandTimeouts,commandResultHandlers}.test.ts`, `routes/dr.test.ts`, `jobs/drExecutionWorker.test.ts`, integration `drExecutionAuthorization.integration.test.ts`, `resilienceRouteCoverage.integration.test.ts` (every new resilience route must be registered), `tenant-export-policy.integration.test.ts`; web `components/dr/*.test.tsx`, `components/backup/VMRestoreWizard.test.tsx`. CI: `.github/workflows/ci.yml:1617-1632` loopback step (add `qemu-utils` to the apt line and a `TestRun_LoopbackVhdxTarget` run).

---

## Part A — W05a (PR 1, "Part of #5498")

### Task 1: Engine `vhdx` target and `convert` phase

**Files:**
- Modify: `agent/internal/backup/rebuild/types.go:18-35` (kind), `:64` (`AllPhases`), `engine.go:76` (validation), `:100-105` (phase table), `preflight.go` (qemu-img + space probes), `provision.go:258/:278` (raw path derivation), `system.go:18` + `system_linux.go` + `system_fake_test.go` (two new seam methods)
- Create: `agent/internal/backup/rebuild/convert.go`
- Modify: `agent/cmd/breeze-backup/rebuild_cmd.go:156` help text + `parseTargetFlag`
- Test: `agent/internal/backup/rebuild/convert_test.go`, `engine_test.go`, `preflight_test.go`, `agent/cmd/breeze-backup/rebuild_cmd_test.go:24`, `loopback_linux_test.go`

**Interfaces:**
- Produces:
```go
const TargetVHDX TargetKind = "vhdx"
const PhaseConvert Phase = "convert"          // appended to AllPhases (last)
// System gains:
//   LookPath(name string) (string, error)            // exec.LookPath
//   FreeSpace(dir string) (int64, error)             // statfs bavail*bsize
// (*Target).RawPath() string  → Path + ".raw" for vhdx, Path for image, "" for disk
```

- [ ] **Step 1: Write the failing tests**

`convert_test.go`:
```go
func TestConvert_VhdxRunsQemuImgAndRemovesRaw(t *testing.T) {
	fs := newFakeSystem(t)               // existing helper in system_fake_test.go
	dir := t.TempDir()
	raw := filepath.Join(dir, "out.vhdx.raw")
	require.NoError(t, os.WriteFile(raw, []byte("x"), 0o600))
	r := &run{opts: Options{Target: Target{Kind: TargetVHDX, Path: filepath.Join(dir, "out.vhdx")}, System: fs}, result: &Result{}}
	require.NoError(t, convert(context.Background(), r))
	require.Equal(t, []string{"qemu-img", "convert", "-f", "raw", "-O", "vhdx", "-o", "subformat=dynamic", raw, filepath.Join(dir, "out.vhdx")}, fs.lastRun)
	_, err := os.Stat(raw)
	require.True(t, os.IsNotExist(err), "raw staging file must be deleted after conversion")
}

func TestConvert_SkippedForDiskAndImage(t *testing.T) {
	for _, kind := range []TargetKind{TargetDisk, TargetImage} {
		r := &run{opts: Options{Target: Target{Kind: kind, Path: "/x"}, System: newFakeSystem(t)}, result: &Result{}}
		require.NoError(t, convert(context.Background(), r))
		last := r.result.Phases[len(r.result.Phases)-1]
		require.Equal(t, PhaseConvert, last.Phase)
		require.True(t, last.Skipped)
	}
}
```
`preflight_test.go`:
```go
func TestPreflight_VhdxRefusesWithoutQemuImg(t *testing.T) {
	fs := newFakeSystem(t); fs.lookPathErr = map[string]error{"qemu-img": exec.ErrNotFound}
	res, err := Run(ctx, vhdxOptions(t, fs))   // helper: seeded snapshot + layout as engine_test does
	require.NoError(t, err)
	require.Equal(t, "refused", res.Status)
	require.Contains(t, res.Refusal, "qemu-img not installed")
}

func TestPreflight_VhdxRefusesWhenFreeSpaceBelowOneAndHalfImage(t *testing.T) {
	fs := newFakeSystem(t); fs.freeSpace = 10 << 30
	opts := vhdxOptions(t, fs); opts.Target.ImageSizeBytes = 8 << 30 // needs 12 GiB
	res, _ := Run(ctx, opts)
	require.Equal(t, "refused", res.Status)
	require.Contains(t, res.Refusal, "not enough free space for raw image plus VHDX")
}
```
`engine_test.go`: `TestRun_VhdxTargetRunsAllEightPhases` — fake system, assert `len(res.Phases) == 8`, `res.Phases[7].Phase == PhaseConvert`, `res.Status == "completed"`, and that `AttachImage` was called with `<Path>.raw`. `TestAllPhases_ConvertIsLast`. `rebuild_cmd_test.go:24`: change the `vhdx:/x` case to expect `Target{Kind: TargetVHDX, Path: "/x"}`.

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/rebuild/ -run 'Convert|Vhdx|AllPhases' 2>&1 | head -5`
Expected: compile errors (`TargetVHDX`, `PhaseConvert` undefined).

- [ ] **Step 3: Implement**

`types.go`: add `TargetVHDX`, `PhaseConvert`, append to `AllPhases`, add `func (t Target) RawPath() string`. `engine.go:76`: accept `TargetVHDX`; phase table gains `{PhaseConvert, convert}` last. `provision.go` `attach`/`reattach`: use `r.opts.Target.RawPath()` for the image file when kind is `image` or `vhdx` (identical size rule). `preflight.go`: after the existing target checks, for `vhdx`: `if _, err := r.opts.System.LookPath("qemu-img"); err != nil { return &RefusalError{Reason: "qemu-img not installed on this host; install qemu-utils"} }`; `free, err := r.opts.System.FreeSpace(filepath.Dir(r.opts.Target.Path))`; `need := r.opts.Target.ImageSizeBytes * 3 / 2`; refuse with `fmt.Sprintf("not enough free space for raw image plus VHDX: need %d, have %d", need, free)`. `convert.go`:
```go
func convert(ctx context.Context, r *run) error {
	if r.opts.Target.Kind != TargetVHDX {
		r.recordSkipped(PhaseConvert, "not an image conversion target")
		return nil
	}
	raw, out := r.opts.Target.RawPath(), r.opts.Target.Path
	r.progress(PhaseConvert, "converting "+raw+" to VHDX", 0, 1)
	if err := r.opts.System.Run(ctx, "qemu-img", "convert", "-f", "raw", "-O", "vhdx", "-o", "subformat=dynamic", raw, out); err != nil {
		return fmt.Errorf("qemu-img convert: %w", err)
	}
	if err := os.Remove(raw); err != nil && !os.IsNotExist(err) {
		r.warn("raw staging image not removed: " + err.Error())
	}
	r.progress(PhaseConvert, "wrote "+out, 1, 1)
	return nil
}
```
(Use the run's existing helpers for recording a skipped phase / warnings; if there is no `recordSkipped`, add one next to the phase-result bookkeeping in `engine.go` and use it for the existing encryption no-op too.) `system_linux.go`: `LookPath` → `exec.LookPath`; `FreeSpace` → `unix.Statfs` `Bavail*Bsize`. Fake: `lookPathErr map[string]error`, `freeSpace int64` (default `1<<50`), `lastRun []string`. `loopback_linux_test.go`: add `TestRun_LoopbackVhdxTarget` (same gate; skips when `qemu-img` absent with a clear message; asserts the `.vhdx` exists and `qemu-img info --output=json` reports `"format": "vhdx"`).

- [ ] **Step 4: Run tests**

Run: `cd agent && go build ./... && GOOS=windows go build ./... && go test -race ./internal/backup/rebuild/ ./cmd/breeze-backup/`
Expected: PASS.

- [ ] **Step 5: CI + commit**

`.github/workflows/ci.yml:1617-1632`: add `qemu-utils` to the apt install line and run `-run 'TestRun_LoopbackRealSystem|TestRun_LoopbackVhdxTarget'`; keep the "fail on SKIP" guard.
```bash
git commit -m "feat(rebuild): vhdx target via raw image + qemu-img convert, explicit convert phase (W05a)"
```

### Task 2: `bare_metal_rebuild` command type (server registries + payload)

**Files:**
- Modify: `apps/api/src/services/commandTypes.ts:173`, `commandTimeouts.ts:92-98`, `commandOfflinePolicy.ts:145-157`, `commandQueue.ts:375-395` and `:818-819`, `routes/devices/commands.ts:1028` (`terminalPayloadErasureSet`), `services/agentCommandResultValidation.ts` (accept `phaseReached`, `refusal`, `stateApplied`, `target` on the result), `services/restoreResultPersistence.ts:80-100` (whitelist `phaseReached`, `refusal`, `target`)
- Create: `apps/api/src/services/bareMetalRebuildCommand.ts`
- Test: `apps/api/src/services/bareMetalRebuildCommand.test.ts`, `commandOfflinePolicy.test.ts`, `commandTimeouts.test.ts`, `routes/devices/commands.test.ts`

**Interfaces:**
- Produces:
```ts
export const bareMetalRebuildPayloadSchema = z.object({
  recoveryId: z.string().guid(),
  token: z.string().min(1),
  server: z.string().url(),
  target: z.object({
    kind: z.enum(['vhdx', 'image']),
    path: z.string().min(1).max(1024).refine(p => p.startsWith('/'), 'absolute path required'),
    imageSizeBytes: z.number().int().positive().optional(),
  }),
  identity: z.enum(['original', 'new']),
});
export type BareMetalRebuildPayload = z.infer<typeof bareMetalRebuildPayloadSchema>;
export async function queueBareMetalRebuild(input: {
  orgId: string; hostDeviceId: string; payload: BareMetalRebuildPayload; userId?: string;
}): Promise<{ command: { id: string; status: string } | null; error: string | null }>;
// wraps queueCommandForExecution(hostDeviceId, CommandTypes.BARE_METAL_REBUILD, payload, { userId, expectedOrgId: orgId })
// and writes audit 'bmr.rebuild.command' with { recoveryId, hostDeviceId, target: payload.target } — never the token.
```

- [ ] **Step 1: Write the failing tests** — `bareMetalRebuildCommand.test.ts`: schema rejects a relative path and a missing token; `queueBareMetalRebuild` calls the queue with the type `'bare_metal_rebuild'` and audits without `token`. Existing `commandOfflinePolicy.test.ts` / `commandTimeouts.test.ts` will fail on their own once the type exists but is unclassified — run them after adding the constant to see the red, then classify.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/bareMetalRebuildCommand src/services/commandOfflinePolicy src/services/commandTimeouts` → expected FAIL (module missing / type unclassified).
- [ ] **Step 3: Implement** the constant, the five registrations, the erasure set entry, the payload schema + `queueBareMetalRebuild`, and the result-validation/persistence whitelist additions.
- [ ] **Step 4: Run** the same command plus `npx vitest run src/routes/devices/commands` → PASS.
- [ ] **Step 5: Commit** `feat(api): bare_metal_rebuild command type registered in all command registries (W05a)`.

### Task 3: Helper executes `bare_metal_rebuild`

**Files:**
- Modify: `agent/internal/remote/tools/types.go:182` (`CmdBareMetalRebuild = "bare_metal_rebuild"`), `agent/cmd/breeze-backup/main.go:761` and `:919` (dispatch), `agent/cmd/breeze-backup/rebuild_cmd.go` (extract the token-mode option builder into a reusable function)
- Create: `agent/cmd/breeze-backup/exec_bare_metal_rebuild.go`
- Test: `agent/cmd/breeze-backup/exec_bare_metal_rebuild_test.go`, `rebuild_cmd_token_test.go`

**Interfaces:**
- Produces:
```go
// rebuild_cmd.go — extracted from the token branch so the command handler and the CLI share it.
func buildTokenModeOptions(ctx context.Context, server, token string, target rebuild.Target, identityOverride string) (rebuild.Options, func(bmr.ProgressUpdate), error)
// exec_bare_metal_rebuild.go
func execBareMetalRebuild(parentCtx context.Context, payload json.RawMessage, rebuildFn func(context.Context, rebuild.Options) (*rebuild.Result, error)) backupipc.BackupCommandResult
```
Result JSON = the engine `Result` verbatim plus `{"recoveryId": ...}`; `ErrUnsupportedHost` → `fail("the rebuild engine runs on Linux only in this release")`.

- [ ] **Step 1: Failing tests** — `execBareMetalRebuild` with a fake `rebuildFn`: (a) passes `Target{Kind: TargetVHDX, Path}` and `Identity` from the bootstrap (use the existing fake authenticate server from `rebuild_cmd_token_test.go`); (b) invalid payload → `fail`; (c) unsupported host error → the exact message above; (d) a `refused` result is returned as a non-error result with `status: refused` (the server maps it). `buildTokenModeOptions` test: identity `original` sets `Marker`, `new` does not.
- [ ] **Step 2: Run** `cd agent && go test ./cmd/breeze-backup/ -run 'BareMetalRebuild|TokenModeOptions' 2>&1 | head -5` → FAIL (undefined).
- [ ] **Step 3: Implement** — extract the token branch at `rebuild_cmd.go:91-135` into `buildTokenModeOptions` (behaviour unchanged; the CLI calls it), then `execBareMetalRebuild`: unmarshal payload (`recoveryId, token, server, target{kind,path,imageSizeBytes}, identity`), `buildTokenModeOptions`, set `RegenerateInitramfs = true`, `StateDir` default, `Progress` → `report`, 4-hour timeout, run, post terminal progress (`validated`/`failed`/`refused`) exactly like `runRebuildAndReport` does in token mode, `marshalResult`. Wire both dispatch tables.
- [ ] **Step 4: Run** `cd agent && go build ./... && GOOS=windows go build ./... && go test -race ./cmd/breeze-backup/ ./internal/backup/...` → PASS.
- [ ] **Step 5: Commit** `feat(helper): execute bare_metal_rebuild commands through the token-mode rebuild path (W05a)`.

### Task 4: `bareMetalRecoveryService.ts` — create, mint, cancel, reissue code

**Files:**
- Create: `apps/api/src/services/bareMetalRecoveryService.ts`
- Modify: `apps/api/src/routes/backup/bmrRecoveries.ts:103-191` (route becomes a thin caller), add `POST /bmr/recoveries/:id/cancel` and `POST /bmr/recoveries/:id/reissue-code`; `routes/backup/schemas.ts` (`bmrRecoveryCreateSchema` unchanged for HTTP); `services/commandResultHandlers.ts:903` (map `bare_metal_rebuild → handleBareMetalRebuildResult`)
- Test: `apps/api/src/services/bareMetalRecoveryService.test.ts`, `routes/backup/bmrRecoveries.test.ts`, `services/commandResultHandlers.test.ts`, integration `resilienceRouteCoverage.integration.test.ts` (register the two routes)

**Interfaces:**
- Produces:
```ts
export class BareMetalRecoveryError extends Error { constructor(public code: 'snapshot_not_found'|'snapshot_not_bare_metal_restorable'|'recovery_in_progress'|'invalid_state', public status: 404|409, public details?: Record<string, unknown>) }
export async function createBareMetalRecovery(input: {
  orgId: string; snapshotId: string; identity: 'original'|'new'; createdBy: string|null;
  source: 'route'|'dr'|'vm_restore'; executingDeviceId?: string|null; drExecutionId?: string|null; drGroupId?: string|null;
  target?: Record<string, unknown>|null; tx?: DrDb;
}): Promise<{ row: BareMetalRecoveryRow; code: string }>;   // code is the formatted one-time code, returned once
export async function mintRecoveryTokenForRecovery(input: { recoveryId: string; orgId: string; createdBy: string|null }): Promise<{ token: string; tokenId: string }>;
// inserts recovery_tokens (restoreType 'bare_metal', 24h, status 'authenticated'), links recovery_token_id, status stays 'created' (the helper's first progress post moves it to 'planned')
export async function cancelBareMetalRecovery(input: { recoveryId: string; orgId: string; userId: string|null; reason?: string }): Promise<BareMetalRecoveryRow>; // non-terminal → 'failed', failureReason 'cancelled'
export async function reissueRecoveryCode(input: { recoveryId: string; orgId: string; userId: string|null }): Promise<{ row: BareMetalRecoveryRow; code: string }>; // status ∈ {created, media_booted}, rotates code_hash + code_expires_at
export async function applyRebuildCommandResult(input: { recoveryId: string; orgId: string; result: Record<string, unknown> }): Promise<void>; // idempotent terminal mapping used by handleBareMetalRebuildResult
```
(`dr_execution_id`/`dr_group_id`/`executing_device_id` are written only when the columns exist — they arrive in W05b Task 6; in W05a the service accepts the fields and the insert includes them behind the schema columns added in Task 6. **Ordering:** implement Task 6's migration + schema column change first if W05b is executed in the same branch; otherwise W05a's service omits the three fields and W05b adds them.)

- [ ] **Step 1: Failing tests** — service: create refuses non-restorable snapshot (409 code), refuses second in-flight (409), inserts with `identity` as given, audit includes `source`; mint links the token; cancel from `restoring` → `failed/cancelled`, cancel from `completed` → `invalid_state`; reissue rotates the hash (old code no longer exchanges), refuses from `planned`. Route tests: `POST /:id/cancel` and `/:id/reissue-code` require MFA + `BACKUP_WRITE`, audit actions `bmr.recovery.cancel` / `bmr.recovery.reissue_code`; the existing create-route tests still pass unchanged. Result handler: a `bare_metal_rebuild` command result with `status: 'completed'` and identity `new` leaves the recovery `completed`; `refused` → `refused` with `failureReason = refusal`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/bareMetalRecoveryService src/routes/backup/bmrRecoveries src/services/commandResultHandlers` → FAIL.
- [ ] **Step 3: Implement** — move the body of `bmrRecoveries.ts:118-176` into `createBareMetalRecovery` (keep `authorizeRouteResilienceResources` in the route; the service takes an already-authorized `orgId`), add the three new functions, the two routes (rate limit reissue 5/hour per recovery with the existing `enforceTokenRateLimit(c, 'reissue', recoveryId, 5, 3600)`), and the result handler.
- [ ] **Step 4: Run** the same + `npx vitest run src/__tests__/integration/resilienceRouteCoverage` (needs DB) → PASS.
- [ ] **Step 5: Commit** `feat(api): bareMetalRecoveryService with cancel + reissue-code routes; bare_metal_rebuild result handler (W05a)`.

### Task 5: Restore-as-VM engine path (API + wizard)

**Files:**
- Modify: `apps/api/src/routes/backup/schemas.ts:376-389` (`bmrVmRestoreSchema`), `routes/backup/vmrestore.ts:116-250` (engine branch), `services/aiToolsBackupVm.ts` + `aiToolSchemasBackup.ts` (expose `engine`, `rebuildHostDeviceId`, `outputPath`; `deviceArgs` gains `rebuildHostDeviceId`)
- Modify: `apps/web/src/components/backup/VMRestoreWizard.tsx`, `VMRestoreSpecsStep.tsx`, `VMRestoreConfirmStep.tsx`, `apps/web/src/locales/*/backup.json`
- Test: `apps/api/src/routes/backup/vmrestore.test.ts`, `services/aiToolsBackupVm*.test.ts`, `apps/web/src/components/backup/VMRestoreWizard.test.tsx`

**Interfaces:**
- Produces: schema
```ts
export const bmrVmRestoreSchema = z.discriminatedUnion('engine', [
  z.object({ engine: z.literal('hyperv').default('hyperv'), snapshotId, targetDeviceId, hypervisor: z.literal('hyperv'), vmName, switchName, vmSpecs }),   // existing fields verbatim
  z.object({ engine: z.literal('rebuild'), snapshotId: z.string().guid(), rebuildHostDeviceId: z.string().guid(),
             outputPath: z.string().min(1).max(1024).refine(p => p.startsWith('/') && p.endsWith('.vhdx'), 'absolute .vhdx path required'),
             imageSizeGb: z.number().int().min(1).optional() }),
]);
```
Response for `engine: 'rebuild'`: `{ jobId, recoveryId, commandId, status: 'queued' }` 202.

- [ ] **Step 1: Failing tests** — route: `engine: 'rebuild'` on a snapshot without `layoutManifestKey` → 409 `snapshot_not_bare_metal_restorable`; happy path creates recovery with `identity: 'new'` (assert the service was called with `identity: 'new'` even if the body tries `identity: 'original'` — the schema must not accept an `identity` field at all), inserts `restoreJobs` with `targetConfig.mode === 'rebuild_vhdx'` and `recoveryTokenId`, queues `bare_metal_rebuild` to `rebuildHostDeviceId` with the token, audits `bmr.vm_restore.create` with `engine: 'rebuild'`; the authorization refs include the host as `device/target`. Wizard: when the selected snapshot has `layoutManifestKey`, the "Rebuild engine (Linux)" option renders a host picker (Linux devices only, `platform === 'linux'`) and an output-path input; submit sends `engine: 'rebuild'`; the confirm step shows the manual-attach note.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/backup/vmrestore src/services/aiToolsBackupVm` and `cd apps/web && npx vitest run src/components/backup/VMRestoreWizard` → FAIL.
- [ ] **Step 3: Implement** the discriminated union, the route branch (`createBareMetalRecovery({source:'vm_restore', identity:'new', executingDeviceId})` → `mintRecoveryTokenForRecovery` → `restoreJobs` insert → `queueBareMetalRebuild({payload:{recoveryId, token, server: getPublicApiUrl(), target:{kind:'vhdx', path: outputPath, imageSizeBytes}, identity:'new'}})` → update `restoreJobs.commandId`), the AI tool schema, the wizard, and translations.
- [ ] **Step 4: Run** both suites + `cd apps/web && npx vitest run src/lib/i18n` → PASS.
- [ ] **Step 5: Commit + PR 1** — `feat(vm-restore): rebuild-engine path producing a VHDX on a Linux host for whole-machine snapshots (W05a)`. Branch `feature/5493-bare-metal-boot-media/wave-5498`, PR body "Part of #5498", one `/review-pr` round, `gh pr merge --squash`.

---

## Part B — W05b (PR 2, "Closes #5498")

### Task 6: Migration + schema + export policy for DR linkage

**Files:**
- Create: `apps/api/migrations/2026-10-20-150000-bare-metal-recoveries-dr-link.sql`
- Modify: `apps/api/src/db/schema/bareMetalRecoveries.ts:20-53`, `services/tenantExportPolicyRegistry.ts:153`
- Test: `apps/api/src/db/autoMigrate.test.ts`, integration `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`

- [ ] **Step 1: Failing test** — the export-policy integration suite fails once the columns exist without entries; run it after the migration to see that red, then add the entries. Unit: `autoMigrate.test.ts` passes on naming.
- [ ] **Step 2: Migration** (idempotent, no inner BEGIN):
```sql
ALTER TABLE bare_metal_recoveries
  ADD COLUMN IF NOT EXISTS dr_execution_id uuid NULL REFERENCES dr_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dr_group_id uuid NULL REFERENCES dr_plan_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS executing_device_id uuid NULL REFERENCES devices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_dr_execution_idx ON bare_metal_recoveries (dr_execution_id) WHERE dr_execution_id IS NOT NULL;
```
- [ ] **Step 3: Schema columns** (`drExecutionId`, `drGroupId`, `executingDeviceId`) + export policy `included` ×3; `toRecoverySummary` exposes all three.
- [ ] **Step 4: Run** `pnpm db:check-drift`, `npx vitest run src/db/autoMigrate`, and the two integration suites (DB required) → PASS.
- [ ] **Step 5: Commit** `feat(db): link bare_metal_recoveries to DR executions and a rebuild host (W05b)`.

### Task 7: DR authorization + step-config validation for `BARE_METAL_REBUILD`

**Files:**
- Modify: `apps/api/src/services/drExecutionService.ts:19-25` (allow-list), `:365-424` (`resolveDrGroupAuthorizationRefs` + new dep `resolveLatestRestorableSnapshotId`), `routes/backup/schemas.ts:481-497` (`drGroupCreateSchema`/`drGroupUpdateSchema` restoreConfig union), `routes/dr.ts:553-558` (BACKUP_WRITE gate), `services/aiToolsDR.ts:440` (`deviceArgs`), `:561/:604` (validate `restoreConfig` through the same schema)
- Create: `apps/api/src/services/drBareMetalRebuildStep.ts` (schema + `resolveLatestRestorableSnapshotId`)
- Test: `services/drExecutionService.test.ts`, `routes/dr.test.ts`, `services/aiToolsDR.test.ts`, integration `drExecutionAuthorization.integration.test.ts`

**Interfaces:**
```ts
export const DR_STEP_BARE_METAL_REBUILD = 'BARE_METAL_REBUILD';
export const drBareMetalRebuildConfigSchema = z.object({
  commandType: z.literal(DR_STEP_BARE_METAL_REBUILD),
  snapshotSelection: z.literal('latest_restorable').default('latest_restorable'),
  rebuildHostDeviceId: z.string().guid().optional(),
  outputDir: z.string().min(1).max(1024).refine(p => p.startsWith('/')).default('/var/lib/breeze/rebuild/out'),
  waitTimeoutMinutes: z.number().int().min(5).max(1440).default(240),
});
export async function resolveLatestRestorableSnapshotId(orgId: string, deviceId: string, tx?: DrDb): Promise<string | null>;
// SELECT id FROM backup_snapshots WHERE org_id=$1 AND device_id=$2 AND bare_metal_restorable = true AND status='completed' ORDER BY created_at DESC LIMIT 1
```
`drGroupCreateSchema.restoreConfig` becomes `z.union([drBareMetalRebuildConfigSchema, z.record(z.string(), z.any())])` — existing step types keep the open record.

- [ ] **Step 1: Failing tests** — `resolveDrGroupAuthorizationRefs` with `restoreConfig.commandType === 'BARE_METAL_REBUILD'` and two devices returns two `snapshot/source` refs + two `device/target` refs + the host as `device/target`; a device with no restorable snapshot → `DrRecoveryAuthorizationDeniedError('resource_not_found')`; the existing "no source → denied" test still passes for other types. `routes/dr.ts` trigger returns 403 for a user without `BACKUP_WRITE` when a plan contains the step, 202 otherwise. `aiToolsDR` `manage_dr_plan` rejects `restoreConfig.rebuildHostDeviceId` outside the caller's device scope (central gate) and rejects `waitTimeoutMinutes: 2`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/drExecutionService src/routes/dr.test src/services/aiToolsDR` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `npx vitest run src/__tests__/integration/drExecutionAuthorization` (DB) → PASS.
- [ ] **Step 5: Commit** `feat(dr): BARE_METAL_REBUILD step config, source resolution and rebuild-host authorization (W05b)`.

### Task 8: Dispatch and reconcile through recovery rows

**Files:**
- Modify: `apps/api/src/services/drExecutionService.ts:40-103` (`DrExecutionResults.queuedRecoveries`, `GroupDeviceStatus.recoveryId/recoveryStatus/executingDeviceId`), `:199-240` (`computeGroupResults` reads a `recoveryMap`), `:483-598` (`dispatchGroup` non-command branch), `:668-810` (`reconcileDrExecution` loads recovery rows by `dr_execution_id`), `routes/backup/drResultHandler.ts` (no change expected — verify `bare_metal_rebuild` results for rehearsal hosts still fold by `commandId`)
- Test: `services/drExecutionService.test.ts`, `jobs/drExecutionWorker.test.ts`

- [ ] **Step 1: Failing tests** (all against the existing mocked-db pattern in `drExecutionService.test.ts`):
  - `dispatchGroup` for a `failover` execution with two devices creates two recoveries (`createBareMetalRecovery` called with `identity:'original'`, `source:'dr'`, `drExecutionId`, `drGroupId`), queues NO command, pushes two `queuedRecoveries` entries, audits `dr.step.bare_metal_rebuild.dispatch`.
  - `dispatchGroup` for a `rehearsal` execution creates recoveries with `identity:'new'`, `executingDeviceId = rebuildHostDeviceId`, mints a token per recovery, queues one `bare_metal_rebuild` per device to the HOST (`target.path = ${outputDir}/${deviceId}-${recoveryId}.vhdx`), and records `commandId` on the entry; rehearsal without `rebuildHostDeviceId` → `failedDispatches` with `rebuild_host_required`.
  - Calling `dispatchGroup` again with the same results creates nothing (dedupe on `queuedRecoveries`).
  - A `recovery_in_progress` service error becomes a `failedDispatches` entry, not a throw.
  - `computeGroupResults`: recovery `checked_in` → device `completed`; `refused` → `failed` with the refusal reason; `restoring` → `running`; `created` older than `waitTimeoutMinutes` → `failed` with `reason: 'timeout'`; group completes when all devices complete; `pickNextGroup` advances (no re-dispatch loop — assert `createBareMetalRecovery` call count stays 2 across three reconcile ticks).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/drExecutionService src/jobs/drExecutionWorker` → FAIL.
- [ ] **Step 3: Implement** — in `dispatchGroup`, before the command loop: `if (commandType === DR_STEP_BARE_METAL_REBUILD) return dispatchBareMetalRebuildGroup(execution, group, config, currentResults)`. That function resolves the snapshot per device (`resolveLatestRestorableSnapshotId`), calls `createBareMetalRecovery` (rehearsal ⇒ `identity:'new'`; failover/failback ⇒ `'original'`), for rehearsal mints + queues through `queueBareMetalRebuild`, and pushes the entry. In `reconcileDrExecution`, after loading commands, load `bareMetalRecoveries` where `drExecutionId = execution.id` into a `Map<recoveryId, row>` and pass it to `computeGroupResults(groups, results.queuedCommands, results.queuedRecoveries, results.failedDispatches, commandMap, recoveryMap, groupConfigs)`. Timeout compares `row.createdAt` with the group's `waitTimeoutMinutes`. When a device times out, call `cancelBareMetalRecovery({reason:'timeout'})` so the row is terminal too.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(dr): dispatch BARE_METAL_REBUILD as recoveries and reconcile from recovery rows (W05b)`.

### Task 9: Web — step type in the DR editor, live recovery state and code reissue in the execution view

**Files:**
- Modify: `apps/web/src/components/dr/DRPlanGroupCard.tsx:14-21` (`DRGroupForm` gains `stepType`, `rebuildHostDeviceId`, `waitTimeoutMinutes`, `outputDir`), `DRPlanEditor.tsx` (serialise to `restoreConfig` on save; read back on load), `DRExecutionView.tsx` (per-device recovery status + "Reissue code" button + code reveal modal), `apps/web/src/locales/*/dr.json` (or the file the DR components use — check `i18n.t` namespaces in those files)
- Test: `DRPlanGroupCard.test.tsx`, `DRPlanEditor.test.tsx`, `DRExecutionView.test.tsx`

- [ ] **Step 1: Failing tests** — group card renders a step-type `<select>` with the six types (`VM_RESTORE_FROM_BACKUP`, `VM_INSTANT_BOOT`, `HYPERV_RESTORE`, `MSSQL_RESTORE`, `BMR_RECOVER`, `BARE_METAL_REBUILD`), defaulting to the group's existing `restoreConfig.commandType` or empty with a validation message ("Choose a step type") on save; choosing `BARE_METAL_REBUILD` reveals host picker (Linux devices), output dir, timeout; editor `PUT`s `restoreConfig: {commandType:'BARE_METAL_REBUILD', snapshotSelection:'latest_restorable', rebuildHostDeviceId, outputDir, waitTimeoutMinutes}`. Execution view: a device with `recoveryStatus: 'media_booted'` shows the status chip and a "Reissue code" button that POSTs `/backup/bmr/recoveries/:id/reissue-code` through `runAction` and shows the returned code once; `checked_in` shows no button.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/dr` → FAIL.
- [ ] **Step 3: Implement** (mutation handlers through `runAction`; add any legitimate exception to `runActionAllowlist.ts`).
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/components/dr src/lib/i18n src/lib/__tests__/no-silent-mutations` → PASS.
- [ ] **Step 5: Commit** `feat(web): DR step type selector with BARE_METAL_REBUILD options; execution view shows recovery state and reissues codes (W05b)`.

### Task 10: Whole-wave verification, lab proof, PR 2

- [ ] **Step 1: Suites** — `cd agent && go build ./... && GOOS=windows go build ./... && go test -race ./internal/backup/... ./cmd/breeze-backup/... && golangci-lint run --new-from-rev=origin/main ./...`; `cd apps/api && npx vitest run src/services/drExecutionService src/routes/dr.test src/routes/backup src/services/bareMetalRecoveryService src/services/commandOfflinePolicy src/services/commandTimeouts src/services/aiToolsDR src/services/aiToolsBackupVm` then the integration configs (`pnpm --filter @breeze/api test:integration` — needs DB): `drExecutionAuthorization`, `resilienceRouteCoverage`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `rls-coverage`; `cd apps/web && npx vitest run src/components/dr src/components/backup src/lib/i18n`.
- [ ] **Step 2: End-to-end on the lab (orchestrator)** — on the KIT `lab-ubuntu-src` VM (helper installed, `qemu-utils` installed): (a) Restore-as-VM with `engine: 'rebuild'` against the latest whole-machine snapshot → command runs, `/bmr/recover/progress` shows `planned → restoring → validated → completed`, `restore_jobs` row `completed` with `vhdxPath`, `qemu-img info` on the host reports `vhdx`; copy the VHDX to the Hyper-V host, attach to a Gen2 VM, boot → hostname `<orig>-restored`, agent unenrolled. (b) DR plan with one `BARE_METAL_REBUILD` group (host = `lab-ubuntu-src`), trigger `rehearsal` → group completes from the recovery row, no re-dispatch (one recovery row per device). (c) Trigger `failover` → execution view shows a code per device; boot the W04b ISO on a scratch VM, type the code, wait for `checked_in` → group completes. Record all three in the PR body and in `docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md` §11 as rows `W05-vm-vhdx`, `W05-dr-rehearsal`, `W05-dr-failover`.
- [ ] **Step 3: PR** — branch `feature/5493-bare-metal-boot-media/wave-5498` (same branch, PR 2 after PR 1 merged), body `Closes #5498`, one `/review-pr` round (Codex medium + Sonnet code-reviewer with the explicit questions: "can reconcile create a second recovery for the same device?", "can a rehearsal ever carry `identity: original`?", "is the token ever written to audit/results/logs?"), `gh pr merge --squash`.

## Self-review notes (plan author)

- §4/§6 targets → Task 1 (`vhdx` = raw + convert; Windows-native attach stays W06). §8.3 "Restore-as-VM call the engine with a vhdx target and gain Linux guests" → Task 5 (honest scope: Linux guest **image** for Hyper-V; automatic `New-VM` and Instant Boot for Linux guests deferred to W06 because the engine cannot run on the Hyper-V host until then). §8.3 `BARE_METAL_REBUILD` step (create recovery, show code, wait for `checked_in`, configurable timeout; rehearsal forces `identity: new` + VHDX on a chosen host) → Tasks 7–9. §8.1 `identity: new` completes at `validated` → relied on, not changed. §9 "Rehearsals cannot resume the production identity" → server-side forcing in Task 8 and Task 5 (no `identity` field accepted from the client on those paths). §11 item 5 "raw image → VHDX conversion for Hyper-V" → Task 1.
- Independent design review (2026-09-18) findings folded in: token not code in the command payload; five-place command registration; source refs for the step (per-device latest restorable snapshot); rebuild host as an authorized device ref + AI `deviceArgs`; first-class `queuedRecoveries` so reconcile cannot mint a recovery every 2 s; `BACKUP_WRITE` on the trigger route; codes never persisted (reissue route instead); cancel route for the in-flight 409; `convert` as an explicit phase with a 1.5× free-space preflight; `restore_jobs` row for the engine path so existing views see it; `aiToolsDR` validates `restoreConfig`.
- Names kept consistent: `TargetVHDX`, `PhaseConvert`, `CommandTypes.BARE_METAL_REBUILD` (`'bare_metal_rebuild'`), `DR_STEP_BARE_METAL_REBUILD` (`'BARE_METAL_REBUILD'` — DR step types are upper-case strings today), `createBareMetalRecovery`, `mintRecoveryTokenForRecovery`, `cancelBareMetalRecovery`, `reissueRecoveryCode`, `queueBareMetalRebuild`, `resolveLatestRestorableSnapshotId`, `queuedRecoveries`, `executingDeviceId`.
- Deliberate deviations: the DR step's snapshot is "latest restorable per device" rather than a pinned id, because a group holds N devices and one `payload.snapshotId` cannot describe N sources; a per-device pin is a W08 refinement. The DR trigger's added `BACKUP_WRITE` requirement is stricter than the spec states, to keep parity with `POST /bmr/recoveries`.
