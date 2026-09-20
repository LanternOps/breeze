---
tracking_issue: LanternOps/breeze#5493
---

# Wave 09 — Token-mode recovery follows cross-snapshot object references — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bare-metal recovery (boot media, Restore-as-VM `engine:'rebuild'`, DR `BARE_METAL_REBUILD`) of an *incremental* snapshot succeeds: the recovery token is authorized to download exactly the objects that snapshot's manifest names — including objects that live under OLDER snapshots' prefixes — and a client or server that cannot honour that authorization is refused **before** the target disk is provisioned.

**Architecture:** Two PRs on one wave issue (#6464). **W09a (API):** the server hydrates a *verified-complete* per-file index for any snapshot whose owning job reports `referenced_files > 0` by reading `snapshots/<id>/manifest.json` itself (never trusting the size-capped agent-reported index), records provenance for every origin snapshot the manifest references in a new `backup_snapshot_origins` table (captured while the origin's live row or retirement record still exists, so it survives retention), and authorizes an external download request only when (a) the token negotiated `snapshot-file-membership-v1`, (b) the index is `complete`, (c) the exact key is a member of the token snapshot's index, and (d) the origin's org/device/storage identity equal the token's. Negotiation happens at `POST /bmr/recover/authenticate` and `POST /bmr/recover/exchange`; incompatible clients are refused there, before the code is consumed or the token is flipped. The interim creation-time guard from #6469 becomes a preflight that verifies storage identity and enqueues hydration instead of refusing. **W09b (agent + web + proof):** the agent sends its capabilities, the download provider keeps an *admissible set* (own prefix + exact external keys from its own manifest, preserved across session refresh), the rebuild engine's preflight refuses any manifest entry outside that set before `provision`, failure reports are bounded so a 100k-file failure never exceeds the 1 MiB body limit, the fake server + QEMU e2e gain a three-generation fixture, and the KIT lab re-runs the DR rehearsal that failed on 2026-09-20.

**Tech Stack:** Hono + Drizzle + zod + Vitest + BullMQ (`apps/api`), PostgreSQL migrations, Go (`agent/internal/backup/bmr`, `agent/internal/backup/rebuild`, `agent/cmd/breeze-backup`), React + Vitest (`apps/web`), QEMU e2e (`agent/recovery-media/e2e`).

**Spec:** `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §4 (data flow: "downloads bootstrap + manifests"), §8.1 (codes/tokens), §9 ("Nothing is written before preflight passes"; "tokens keep single-use semantics"), §10 (CI integration, lab). Design source of record: issue **#6403** (lab evidence + Claude/Codex `xhigh` quorum, 2026-09-20) and the design shape recorded on **#6464**. This wave amends the spec (Task 13) with a new §8.5 "Download scope and cross-snapshot references".

**Depends on:** W04a (`recovery_tokens` bootstrap/authenticate/exchange, `bare_metal_recoveries`), W05 (`bareMetalRecoveryService.ts`, `bare_metal_rebuild` command, DR step), interim guard **#6469** (merged `929cf94be2` — replaced here, see Task 5). Independent of W06/W07/W08. Related open issues NOT solved here: #6398 (destination-prefix asymmetry), #6415 (60-min reaper), #6438 (download-session TTL), #6470 (`/bmr/tokens` skips `bare_metal_restorable`); the local-provider `.gz` byte contract in token mode is filed as a follow-up in Task 14.

## Global Constraints

- **Capability string:** `snapshot-file-membership-v1` — one constant on each side: `BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY` (`apps/api/src/services/backupObjectKey.ts`), `bmr.CapabilitySnapshotFileMembershipV1` (`agent/internal/backup/bmr/capabilities.go`). Never spelled inline anywhere else.
- **Exact membership, never prefix widening.** Authorization for an external key is `EXISTS backup_snapshot_files(snapshot_db_id = token.snapshot_id, backup_path = key)` AND a matching `backup_snapshot_origins` row. Never "any snapshot of the same device", never a `parent_snapshot_id` walk (it is `ON DELETE SET NULL` and may never be populated), never `is_incremental` (true for format-v2 snapshots with zero references).
- **The singular `pathPrefix` stays** in the download descriptor (`snapshots/<token-snapshot-id>`); own-prefix downloads keep today's rule. The bootstrap validator (`agent/internal/backup/bmr/bootstrap.go:89-91`) still requires it.
- **Refuse before destructive work.** Every refusal introduced by this wave fires at exchange/authenticate (server) or before `provision` (agent). No new refusal may fire during `PhaseRestore`.
- **`referenced_files` is the trigger signal.** `NULL` and `0` mean self-contained (Go `omitempty` drops a zero; the API only writes the column when present — `backupResultPersistence.ts:955`). Only `> 0` needs the index, the capability, and the origins.
- **One object-key contract, both sides, pinned by one vectors file:** `agent/internal/backup/bmr/testdata/object-key-vectors.json`, read by both the Go test and the Vitest test. No trimming, no case folding, no percent-decoding beyond the transport's single decode, **never add or strip `.gz`** (the writer appends `.gz` even to `x.gz` — `agent/internal/backup/snapshot.go:1765`).
- **Fail closed on NULL/ambiguous provenance:** a token snapshot with `storage_identity IS NULL`, an origin with no live row and no retirement record, a retirement whose `device_id` is NULL, or resolved provider identity ≠ pinned identity → refuse with an actionable code (matrix below). Never fall back to "same config" or "current bucket".
- **Server index only:** membership is checked against rows written by server-side hydration (`file_index_status = 'complete'`), never against agent-reported rows (`hasIndexedFiles` in `backup_snapshots.metadata` is not proof).
- **Public-route DB context:** every new query in the public routes runs inside `runInRecoveryOrgContext(row.orgId)` (`apps/api/src/routes/backup/bmr.ts:307`); only the token/code hash lookup is system-scoped. Hydration runs in `withSystemDbAccessContext` and never inside a request transaction (storage I/O stays outside DB transactions; each 1,000-row batch is its own short transaction; completeness is published in one final transaction).
- **Migrations** must sort after the newest committed file (`2026-10-24-210000-time-entries-billable-minutes.sql` on 2026-09-20 — re-check with `ls apps/api/migrations | tail -1` before creating): slots `2026-10-24-220000-backup-snapshot-file-index.sql` and `2026-10-24-220100-recovery-tokens-negotiated-capabilities.sql`. Idempotent, no inner `BEGIN/COMMIT`, RLS in the same migration that creates a table, `SELECT set_config('breeze.scope','system',true)` before any row mutation.
- **Registries (contract tests, not judgement):** `backup_snapshot_origins` has no `org_id`/`device_id` → mirror `backup_snapshot_files`: RLS = `EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = <table>.snapshot_db_id AND breeze_has_org_access(s.org_id))` for all four commands, FK `ON DELETE CASCADE`, and an entry `['backup_snapshot_origins', ['backup_snapshots']]` in `PARENT_FK_JOIN_POLICY_TABLES` (`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:898`). No org/device cascade entry, no export-policy entry (no `org_id`). New COLUMNS on `backup_snapshots` and `recovery_tokens` MUST be added to `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts:151`, `:497`).
- **Bounded reporting:** agent-side caps mirror the server schema — `warnings` ≤ 64 × 2000 chars, `reason` ≤ 2000 chars, `failedFilesSample` ≤ 50 entries, and the serialized progress body ≤ 768 KiB (server body limit is 1 MiB, `apps/api/src/middleware/bodyLimit.ts:184`). The agent's *internal* failed-file set is never truncated (`rebuild/validate.go:48` consumes it). The server's `bmrProgressSchema` bounds the serialized `result` to the same 768 KiB.
- **Test commands:** API unit `cd apps/api && npx vitest run <path>`; API integration `cd apps/api && DATABASE_URL=… npx vitest run -c vitest.integration.config.ts <path>`; agent `cd agent && go test -race ./internal/backup/... ./cmd/breeze-backup/...`; agent lint `golangci-lint run --new-from-rev=origin/main ./...`; web `cd apps/web && npx vitest run <path>`. Red first, every task.
- **No git in workers.** The controller commits after each task passes with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## 0. Ground truth (verified 2026-09-20 on main @ `929cf94be2`, after #6469)

**Why it fails today.** `referenceEntry` (`agent/internal/backup/incremental.go:237-249`) copies the previous entry's `BackupPath` verbatim, so an unchanged file in generation N points at `snapshots/<gen-1..N-1>/files/...` — N-deep, direct. Token-mode downloads are confined to ONE prefix on both sides: API `recoveryDownloadService.ts:143-147` (`expectedPrefix = snapshots/${resolved.snapshot.snapshotId}` → `normalizeSnapshotPath` returns null → `{unavailable, reason: 'Requested path is outside the allowed snapshot scope.'}`) and agent `download_provider.go:454-457` (`HasPrefix(normalizedRemotePath, normalizedPrefix+"/")`). The rebuild engine's phase order is `preflight, provision, restore, boot, identity, encryption, validate, convert` (`rebuild/engine.go:115-119`), and preflight (`preflight.go:56`, manifest via `fetchManifest` at `:143` → `fetch.go:48`) never inspects `BackupPath`, so the per-file refusal lands in `restore` — after `provision` has partitioned and formatted the target. Lab evidence: 98,411 of 105,953 files refused, DR rehearsal `failed` after provisioning (#6403).

**Why the agent index cannot be the authority.** The helper replaces `snapshot.files` with `[]` when the result exceeds the 5,000,000-byte delivery budget (`agent/cmd/breeze-backup/result_bounds.go:231`, `:538`; `agent/internal/wire/limits.go:50`), so a 106k-file snapshot lands with **zero** `backup_snapshot_files` rows (verified in the lab). Persistence copies `backupPath` verbatim without comparing it to the stored manifest (`backupResultPersistence.ts:1373-1403`); `hasIndexedFiles`/`fileIndexVersion` are keys in `backup_snapshots.metadata` jsonb (`:1303`), not columns. Reconcile (`backupSnapshotReconcile.ts:811-814`) skips snapshots that already have a row, so nothing today re-reads a manifest for an existing snapshot.

**Why provenance must be captured.** Retention writes a `backup_snapshot_retirements` row and deletes the `backup_snapshots` row (`jobs/backupRetention.ts:347-356`); GC keeps referenced objects alive by reading surviving manifests (`markLiveBackupObjects` `:1086-1183`) and marks a retirement `swept` only when a fresh listing has no objects under that prefix (`:1447-1451`), pruning it 30 days later (`:1555-1563`). So a retirement row lives as long as the objects do — but config deletion cascades it and device deletion nulls its `device_id`. A shared bucket across orgs is legal (destination `prefix` exists), so a manifest that names `snapshots/<other-org-snapshot>/files/x` must be refused by provenance, not by bucket.

**Storage identity.** `backup_snapshots.storage_identity` (text, nullable forever on legacy rows; healed by GC by row id — `backupRetention.ts:1533-1551`) = `normalizeStorageIdentity(provider, providerConfig)` (`jobs/backupRetention.ts:831`, exported) = provider + endpoint + bucket (S3) or provider + root (local), deliberately excluding `prefix` (`backupSnapshotStorage.ts:140-156`). `resolveSnapshotProviderConfig(snapshotDbId)` (`recoveryBootstrap.ts:167-251`) prefers the LIVE `backup_configs` row over snapshot-pinned metadata (`:240-244`).

**Code map — API.**
- `apps/api/src/routes/backup/bmr.ts`: local download query schema `:91-94` (`recoveryDownloadQuerySchema`, NOT the exported one in `schemas.ts:296`); `runInRecoveryOrgContext` `:307-311`; `POST /bmr/tokens` `:427-515` (interim guard call `:468`); `POST /bmr/recover/authenticate` `:954-1206` (system token lookup `:1011-1017` → org context `:1031` → `resolveSnapshotProviderConfig` → status flip + `authenticatedAt` `:1196` → `buildAuthenticatedBootstrapPayload`); `GET /bmr/recover/download` `:1276` (system lookup `:1347-1361` → org context `:1375` → `getAuthenticatedRecoveryDownloadTarget`); `POST /bmr/recover/complete` `:1491`. Re-authentication IS the session renewal (no refresh route; comment `:1117-1127`).
- `apps/api/src/routes/backup/bmrRecoveries.ts`: `POST /bmr/recoveries` `:112-153` → `createBareMetalRecovery`; public `POST /bmr/recover/exchange` `:391` (code lookup `:413-419`, guards `:422-429`, org context `:434`, mint + `codeUsedAt`/`mediaBootedAt` `:476-485`); `POST /bmr/recover/progress` `:547`.
- `apps/api/src/services/bareMetalRecoveryService.ts`: `externalReferenceRefusal(referencedFiles, snapshotId)` `:116` (interim guard, #6469), `createBareMetalRecovery(input)` `:91-103` signature, snapshot select with `leftJoin(backupJobs)` + guard call `:168`, `recovery_in_progress` `:127-140`; `mintRecoveryTokenForRecovery` `:195-235` mints an already-`authenticated` token for DR/VM-restore (no exchange — those helpers negotiate at `authenticate`). Callers: route `:137`, `services/vmRestoreRebuildEngine.ts:122`, `services/drExecutionService.ts:729`.
- `apps/api/src/services/recoveryBootstrap.ts`: `RECOVERY_DOWNLOAD_SESSION_TTL_MS` `:20`; `computeRecoveryDownloadExpiry` `:67-83`; `buildRecoveryDownloadDescriptor` `:85-109` (returns `{type:'breeze_proxy', method, url, tokenHeaderName, tokenHeaderFormat, pathQueryParam:'path', requiresAuthentication, pathPrefix, expiresAt}`); `resolveSnapshotProviderConfig` `:167-251`; `buildAuthenticatedBootstrapPayload` `:408-467` (`bootstrap.download`, `bootstrap.snapshot`, optional `bootstrap.recovery`).
- `apps/api/src/services/recoveryDownloadService.ts`: `RecoveryDownloadRow` `:18-21` (`id, orgId, deviceId, snapshotId, status, authenticatedAt, expiresAt`); `normalizeSnapshotPath` `:27-35`; `deriveRemoteStorageKey(normalizedRemotePath, providerConfig, snapshotMetadata)` `:75-97`; lineage re-check `:126-136`; provider resolve `:138`; scope check `:143-147`; S3 presign redirect `:155-188` (expiresIn clamped 1..300 s); local stream `:190-206`.
- `apps/api/src/routes/backup/schemas.ts`: `bmrAuthenticateSchema` `:292-294`, `bmrRecoveryCreateSchema` `:303-306`, `bmrExchangeSchema` `:321-323`, `bmrProgressSchema` `:325-333`, `bmrVmRestoreSchema` `:388-430`.
- `apps/api/src/db/schema/backup.ts`: `backupJobs.referencedFiles` `:273`, `backupSnapshots` `:315-382` (`snapshotId` varchar agent id, `storageIdentity` `:360-364`, `metadata` jsonb, `parentSnapshotId` `:336`, `bareMetalRestorable`), `backupSnapshotFiles` `:384-400` (`id, snapshotDbId FK cascade, sourcePath, backupPath, size, modifiedAt, createdAt`; indexes on `snapshot_db_id` and `(snapshot_db_id, source_path)` — none on `backup_path`), `backupSnapshotRetirements` `:414-442` (`orgId, configId FK cascade, deviceId FK set null, snapshotId, storageIdentity NOT NULL, backupType, reason, retiredAt, sweptAt`; unique `(storage_identity, snapshot_id)`). `apps/api/src/db/schema/recoveryTokens.ts:20-57` (`snapshotId` uuid FK → `backup_snapshots.id`, set null).
- `apps/api/src/services/backupSnapshotStorage.ts`: `backupSnapshotManifestKey(id)` `:161`, `fetchBackupObjectText({provider, providerConfig, key})` `:320-333` (S3 `GetObjectCommand` via `buildS3StorageClient` `:50-73`; local `readFile` under traversal guard), `isBackupObjectNotFound` `:343`.
- `apps/api/src/services/backupSnapshotReconcile.ts`: `reconcileManifestSchema` `:258-280` (`id, timestamp?, size?, formatVersion?, baseSnapshotId?, files?: [{sourcePath, originalPath?, backupPath, size?, modTime?}]`, passthrough); reference rule `:604-611` (`!backupPath.startsWith(`snapshots/${id}/`)`).
- `apps/api/src/services/backupResultPersistence.ts`: `applyBackupCommandResultToJob` `:829`; `referencedFiles` write `:955`; `hasIndexedFiles` metadata `:1303`; `isIncremental` `:1327-1330`; file rows `:1373-1403` (delete + 1,000-row batches when `result.snapshot.files` is PRESENT; untouched when absent).
- Jobs: pattern `apps/api/src/jobs/agentLogRetention.ts` (`getXQueue`/`createXWorker`/`initializeX`/`shutdownX`), registration table `apps/api/src/services/workerRegistry.ts` (`:407-412` example, `backupWorker` `:915-918`).
- Web: `apps/web/src/components/backup/RecoveryBootstrapTab.tsx:718` (`POST /bmr/tokens`), bare-metal recovery section (W04a) renders `details.reasons[]` from 409s.
- Tests: `services/recoveryDownloadService.test.ts:133` ('rejects download paths outside the token snapshot scope' — keep), `services/recoveryBootstrap.test.ts:328`, `routes/backup/bmr.test.ts:448/:568`, `routes/backup/bmrRecoveries.test.ts:374` (exchange) `:519` ('failed stores the reason and the engine result'), `services/bareMetalRecoveryService.test.ts` (guard tests from #6469 — rewrite, not delete), `__tests__/integration/bmrRecoverPublicRoutesRls.integration.test.ts:182` (real PG, local provider under `mkdtemp`, public routes mounted with no auth middleware and no ambient context — the fixture to extend).

**Code map — agent.**
- `agent/internal/backup/bmr/types.go`: `AuthenticatedDownloadDescriptor` `:36-47` (`PathPrefix` `:45`), `BootstrapResponse` `:71` (`Version`, `Download`, `Snapshot`, `Recovery`), `RecoveryConfig.ExpectSystemState` `:27` (precedent: behaviour derived from the bootstrap), `RecoveryResult.FailedFiles int` `:138`, `RefusalError` lives in `rebuild/types.go:204-206`.
- `bmr/bootstrap.go:72-94` `validateBootstrapResponse` (requires `Download.PathPrefix`).
- `bmr/download_provider.go`: `newRecoveryDownloadProvider(ctx, serverURL, token, descriptor)` `:238`; `Download` `:326`; `downloadOnce` `:448` (prefix check `:454-457`, `io.Copy` `:517`); `pathClean` `:539-545` (`filepath.ToSlash(filepath.Clean(p))`, the only normaliser).
- `bmr/download_session.go`: `authenticateAndSwap` `:113-130` (replaces `p.descriptor` wholesale, bumps `generation`); `maybeRefreshBeforeExpiry` `:136`; `refreshAfterUnauthorized` `:173`.
- `bmr/session.go`: `RunRecoveryWithTokenContext` `:30` (provider at `:68`); `ExchangeRecoveryCode` `:144` (POSTs `{"code"}`); `AuthenticateRecoverySession` `:212`; `NewRecoveryProvider(ctx, serverURL, token, bs)` `:222` (the constructor used by `rebuild --token` and `bare_metal_rebuild`); `authenticateRecoverySessionContext` `:247` (POSTs `{"token"}`). **Two constructors — change both.**
- `bmr/bmr.go`: `maxRecoveryWarnings = 50` `:33`; `snapshotManifest` `:214`; `downloadManifest(snapshotID, provider)` `:288`; `restoreFiles` `:813` (`provider.Download` `:927`, retry `:942`).
- `bmr/progress.go`: `ProgressUpdate` `:18` (`Warnings []string` uncapped), `PostRecoveryProgress` `:57`.
- `bmr/fakeserver/fakeserver.go`: `bootstrapFor` `:142-184` (hardcoded `pathPrefix` `:178`), `handleDownload` prefix check `:330-335`, no-gzip note `:309-315`; `handleAuthenticate`/`handleExchange` decode only `{token}`/`{code}`.
- `agent/internal/backup/rebuild`: `Run` `engine.go:79`, phase table `:115-119`, refusal mapping `:138-145`; `preflight` `preflight.go:56` (manifest `:143-147`); `fetchManifest` `fetch.go:48` → `*backup.Snapshot`; `restoreTree` `restore_tree.go:56` (unbounded join `:80`, `r.failedFiles` `:85-88`); `validate.go:48`; `Options.ExpectSystemState` `types.go:171`; `engine_test.go:179` `TestRun_DryRunProducesPlanWithoutWrites`, `:197` `TestRun_PreflightRefusals` (table; `mutate(sys *fakeSystem, p *memProvider, lay *layout.Manifest)`; `memProvider` enforces nothing).
- `agent/cmd/breeze-backup`: `rebuild_cmd.go:181` `buildTokenModeOptions(ctx, server, token, target, identityOverride) (rebuild.Options, func(bmr.ProgressUpdate), error)` (authenticate → `bmr.NewRecoveryProvider` → `ExpectSystemState` `:222`), `:285` `runTokenModeRebuild(ctx, opts, report, runFn)` (DryRun pass, then real run — preflight runs twice); `exec_bare_metal_rebuild.go:75` `execBareMetalRebuild(...)` (calls `runTokenModeRebuild` `:98`); `bmr_recover_cmd.go:16` seam `runBMRRecovery = bmr.RunRecoveryWithTokenContext`.
- `agent/internal/backup`: `Snapshot` `snapshot.go:166-206` (`ID, Files, FormatVersion, BaseSnapshotID, BackupIdentity`), `SnapshotFile` `:231+` (`SourcePath, BackupPath, Size, ModTime, Checksum, Mode, Kind, LinkTarget, ModeBits, Owner, Placeholder`; `HasContent()`), `ensureGzipExtension` `:1765`, upload key `:952-953`; `isReferenceEntry` `incremental.go:260-275`; `providers.BackupProvider` (`interface.go:19-24`: `Upload, Download(remotePath, localPath), List, Delete`); `providers/local.go:80` (gzip on upload when key ends `.gz`) `:121` (gunzip on download); `providers/s3.go:108` (key verbatim).
- e2e: `.github/workflows/ci.yml:2009` job `recovery-media-e2e` (ISO build, `agent/recovery-media/e2e/seed-snapshot.sh` seeds ONE generation `e2e-1` via hidden `breeze-backup snapshot-dir` + hand-written `layout.json`, `run-qemu.sh` boots against `breeze-recovery-fakeserver`).

## 1. Wire contract (both PRs implement exactly this)

**Requests.** `POST /api/v1/backup/bmr/recover/authenticate` body `{ "token": string, "capabilities"?: string[] }`; `POST /api/v1/backup/bmr/recover/exchange` body `{ "code": string, "capabilities"?: string[] }`. Schema: `capabilities: z.array(z.string().min(1).max(64)).max(16).optional()`. Unknown capability strings are ignored (forward compatibility). Absent = legacy client.

**Bootstrap response additions** (inside the existing `bootstrap` object; both `authenticate` and `exchange` share `buildAuthenticatedBootstrapPayload`):
```json
"download": { "...existing fields incl. pathPrefix...", "capabilities": ["snapshot-file-membership-v1"] },
"snapshot": { "...existing...", "fileIndex": { "status": "complete", "manifestSha256": "<64 hex>", "externalCount": 98411, "originSnapshotIds": ["snapshot-20260901T020001Z-…"] } }
```
`download.capabilities` lists what the SERVER granted this token (subset of what the client sent). `snapshot.fileIndex` is present only when the capability was granted AND the snapshot has `referenced_files > 0`; otherwise omitted. Go: `AuthenticatedDownloadDescriptor.Capabilities []string \`json:"capabilities,omitempty"\``; `BootstrapSnapshot.FileIndex *FileIndexInfo \`json:"fileIndex,omitempty"\`` with `FileIndexInfo{Status string; ManifestSHA256 string \`json:"manifestSha256"\`; ExternalCount int \`json:"externalCount"\`; OriginSnapshotIDs []string \`json:"originSnapshotIds"\`}`.

**Server decision at authenticate/exchange** (function `negotiateRecoveryCapabilities`, Task 5), evaluated BEFORE `codeUsedAt` is set / BEFORE the token status flips, inside `runInRecoveryOrgContext`:
```
needs = (job.referenced_files ?? 0) > 0
if !needs: granted = client ∩ {membership}; ok (fileIndex omitted)
else:
  if membership ∉ client            → 409 client_capability_required
  if token.negotiated_capabilities already set and membership ∉ client → 409 capability_downgrade   (re-auth only)
  if snapshot.storage_identity IS NULL → 409 snapshot_storage_identity_unknown
  if resolved provider identity ≠ pinned identity → 409 storage_identity_drift
  if file_index_status ∈ {none, agent} → enqueue hydration; 409 snapshot_index_pending {retryAfterSeconds: 30}
  if file_index_status = hydrating       → 409 snapshot_index_pending {retryAfterSeconds: 30} (no enqueue)
  if file_index_status = failed          → 409 snapshot_index_failed {reason}; enqueue hydration iff the failure is retryable (retryability is derived from the failure code — see §3)
  if complete → granted = {membership}; persist recovery_tokens.negotiated_capabilities; fileIndex = {complete, sha, externalCount, originSnapshotIds}
```
Public 409 body: `{ "error": "<code>", "message": "<human sentence>", "retryAfterSeconds"?: number, "details"?: {...} }`. Human messages (exact copy):
- `client_capability_required`: `This backup references files stored with earlier snapshots. The recovery media you booted is too old to read them — download the current recovery media from Breeze and boot again.`
- `capability_downgrade`: `This recovery session was started with cross-snapshot support and cannot continue without it.`
- `snapshot_storage_identity_unknown`: `Breeze has not yet verified where this snapshot's files are stored. Wait for the next retention run or choose a newer full backup.`
- `storage_identity_drift`: `The backup destination for this device has changed since this snapshot was written. Restore the previous destination settings or choose a snapshot written to the current destination.`
- `snapshot_index_pending`: `Breeze is preparing the file index for this snapshot (N files reference earlier snapshots). Retry in 30 seconds.`
- `snapshot_index_failed`: `Breeze could not verify this snapshot's file index: <reason>. Choose a newer full backup or contact support.`

**Server decision at download** (`getAuthenticatedRecoveryDownloadTarget`, Task 6): parse the key with the shared contract. Own-prefix keys: unchanged. External keys: require `membership ∈ token.negotiated_capabilities`, `file_index_status = 'complete'`, `EXISTS backup_snapshot_files(snapshot_db_id, backup_path)`, and `backup_snapshot_origins(snapshot_db_id, origin_snapshot_id)` with `origin_org_id = token.orgId AND origin_device_id = token.deviceId AND origin_storage_identity = pinned identity`; physical key = `origin_storage_prefix ? '<prefix>/<key>' : '<key>'` (never the token snapshot's `metadata.storagePrefix`). Any miss → `{unavailable: true, reason: 'Requested path references an object this recovery is not authorized to read.'}` (409, before any presign/stream).

**Agent behaviour.** Send `capabilities: [membership]` on every authenticate/exchange. After the manifest is downloaded (and before ANY target write), compute `external = content entries whose key's snapshot segment ≠ own id`. If `len(external) > 0` and `membership ∉ download.capabilities` → refuse (`*bmr.ScopeRefusalError`, posted as progress `refused` with reason `This backup references N file(s) stored with earlier snapshots and the server did not grant cross-snapshot downloads. Upgrade the Breeze server or choose a self-contained (full) snapshot.`). If granted: verify `sha256(manifest bytes) == snapshot.fileIndex.manifestSha256` (mismatch → refuse: `The server's file index does not match this snapshot's manifest; create the recovery again.`), then widen the provider's admissible set with the exact external keys. Session refresh (`authenticateAndSwap`) keeps the admissible set and refuses (`ErrCapabilityDowngrade`) if the fresh descriptor drops the capability. The rebuild engine's preflight independently refuses when any content entry is not admitted by the provider (`ObjectAdmission` interface, Task 10) — the belt to the braces.

**Object-key contract** (`parseBackupObjectKey` / `bmr.ParseObjectKey`): valid iff `key` matches `^snapshots/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/(.+)$` with `$2` non-empty, no `\0`, no `\\`, no segment equal to `` (double slash), `.` or `..`, and `$2` not ending in `/`. Returns `{snapshotId, rest}`; the key itself is served verbatim (identity, no rewriting). `classify(key, ownId)` → `own` when `snapshotId === ownId` (exact, case-sensitive) else `external`. Vectors file (Task 1) pins ≥ 20 cases incl. `x.gz.gz`, mixed case ids, `%2e%2e` literal (valid — no decoding), `snapshots/a/../b/manifest.json` (invalid), `snapshots//a/x` (invalid), `snapshots/a/` (invalid), `/snapshots/a/x` (invalid), `snapshots/a/files/dir with space/f.gz` (valid).

## 2. Data model (Task 2)

`backup_snapshots` new columns: `file_index_status text NOT NULL DEFAULT 'none'` CHECK IN (`none`,`agent`,`hydrating`,`complete`,`failed`); `file_index_manifest_sha256 text`; `file_index_hydrated_at timestamptz`; `file_index_external_count integer`; `file_index_error text`. Backfill in the migration: `UPDATE backup_snapshots SET file_index_status='agent' WHERE (metadata->>'hasIndexedFiles')='true'` (with the `GET DIAGNOSTICS … RAISE WARNING` count pattern). Export policy: all five `included` (`file_index_manifest_sha256` contains no `SUSPICIOUS_NAME_PARTS` token — if the suite disagrees, move it to `reviewedIncluded` with a note).

`backup_snapshot_files`: `CREATE INDEX IF NOT EXISTS backup_snapshot_files_snapshot_backup_path_idx ON backup_snapshot_files (snapshot_db_id, backup_path)` (non-unique; build is not CONCURRENTLY because autoMigrate wraps files in a transaction — note the write lock in the migration header comment).

`backup_snapshot_origins` (new, snapshot-keyed like `backup_snapshot_files`): `id uuid PK default gen_random_uuid()`, `snapshot_db_id uuid NOT NULL REFERENCES backup_snapshots(id) ON DELETE CASCADE`, `origin_snapshot_id varchar(255) NOT NULL`, `origin_org_id uuid NOT NULL`, `origin_device_id uuid NOT NULL`, `origin_storage_identity text NOT NULL`, `origin_storage_prefix text NULL`, `provenance text NOT NULL CHECK IN ('live','retired')`, `object_count integer NOT NULL`, `verified_at timestamptz NOT NULL DEFAULT now()`, UNIQUE `(snapshot_db_id, origin_snapshot_id)`. RLS forced + four EXISTS-join policies (copy from `2026-06-23-sec-review-1-fk-child-rls-backstop.sql:168` for `backup_snapshot_files`). `origin_org_id`/`origin_device_id` are NOT FKs (provenance must not vanish with the origin device row; the referencing snapshot's own FK cascade governs lifetime).

`recovery_tokens`: `negotiated_capabilities text[] NULL` (export policy `included`).

Drizzle: `backupSnapshots` gains `fileIndexStatus`, `fileIndexManifestSha256`, `fileIndexHydratedAt`, `fileIndexExternalCount`, `fileIndexError`; new `backupSnapshotOrigins` export in `db/schema/backup.ts`; `recoveryTokens.negotiatedCapabilities: text('negotiated_capabilities').array()`; `backupSnapshotFiles` gains the index definition. Run `pnpm db:check-drift` after.

## 3. Hydration (Tasks 3–4)

`apps/api/src/services/backupSnapshotFileIndex.ts`:
```ts
export type FileIndexStatus = 'none' | 'agent' | 'hydrating' | 'complete' | 'failed';
export type HydrationFailure = 'storage_identity_unknown' | 'storage_identity_drift' | 'manifest_missing' | 'manifest_invalid' | 'manifest_key_invalid' | 'origin_unverifiable' | 'origin_identity_pending' | 'provider_error';
export const RETRYABLE_HYDRATION_FAILURES: ReadonlySet<HydrationFailure> = new Set(['manifest_missing', 'provider_error', 'origin_identity_pending']); // retryability is a pure function of the failure code; `file_index_error` is stored as `<failure>: <reason>` so readers derive it from the prefix
export type HydrationOutcome = { status: 'complete'; manifestSha256: string; entryCount: number; externalCount: number; originSnapshotIds: string[] } | { status: 'failed'; failure: HydrationFailure; reason: string; retryable: boolean } | { status: 'skipped'; reason: 'not_referenced' | 'already_complete' | 'in_progress' };
export async function hydrateSnapshotFileIndex(snapshotDbId: string, opts?: { force?: boolean; deps?: HydrationDeps }): Promise<HydrationOutcome>;
export type HydrationDeps = { fetchManifestBytes: (args: { provider: string; providerConfig: Record<string, unknown>; key: string }) => Promise<Uint8Array>; now?: () => Date };
```
Algorithm (system context; `runOutsideDbContext` first when called from a request):
1. Load snapshot + owning job (`referencedFiles`, `storageIdentity`) + `configId`. `referencedFiles ?? 0 === 0` → `skipped not_referenced` (and set `file_index_status` to `agent` if rows exist, else leave). `complete` and not `force` → `skipped already_complete`. `hydrating` with `file_index_hydrated_at` newer than 30 min → `skipped in_progress` (older → treat as stale and proceed).
2. CAS to `hydrating` (`UPDATE … WHERE id=$1 AND file_index_status <> 'hydrating'`, 0 rows → `skipped in_progress`).
3. `resolveSnapshotProviderConfig(snapshotDbId)`; `storageIdentity IS NULL` → fail `storage_identity_unknown` (not retryable); `normalizeStorageIdentity(providerType, providerConfig) !== storageIdentity` → fail `storage_identity_drift`.
4. `fetchBackupObjectBytes({provider, providerConfig, key: backupSnapshotManifestKey(snapshot.snapshotId)})` (new in `backupSnapshotStorage.ts`, byte-exact: S3 `transformToByteArray()`, local `readFile` with no encoding) → not found → fail `manifest_missing` (retryable); other error → `provider_error` (retryable). `sha = sha256hex(bytes)`.
5. Parse with `hydrationManifestSchema` = `reconcileManifestSchema` + `.refine(m => m.id === snapshot.snapshotId)`; invalid → `manifest_invalid`. For each file entry with a non-empty `backupPath`: `parseBackupObjectKey` → null → `manifest_key_invalid` (fail closed, name the first bad key); classify own/external; collect `origins: Map<originId, count>`.
6. For each origin id: live row `backup_snapshots WHERE snapshot_id = origin AND org_id = snapshot.orgId AND device_id = snapshot.deviceId AND storage_identity = pinned` (→ `provenance 'live'`, `origin_storage_prefix = row.metadata.storagePrefix ?? null`); else retirement `backup_snapshot_retirements WHERE snapshot_id = origin AND storage_identity = pinned AND org_id = snapshot.orgId AND device_id = snapshot.deviceId` (→ `'retired'`, prefix null); else fail `origin_unverifiable` (`reason: 'origin <id>: no live snapshot or retirement record for this device/destination'`, not retryable). A live row for that origin/org/device whose `storage_identity IS NULL` does not match either — fail closed with the distinct code `origin_identity_pending` (retryable: GC heals identities by row id on its next listing).
7. Write: delete existing `backup_snapshot_files` rows for the snapshot; insert all entries (own AND external; `sourcePath = originalPath ?? sourcePath`, `size`, `modifiedAt`) in 1,000-row batches, each batch in its own `db.transaction`; then ONE final transaction: delete+insert `backup_snapshot_origins`, set `file_index_status='complete'`, `file_index_manifest_sha256`, `file_index_hydrated_at=now()`, `file_index_external_count`, `file_index_error=NULL`, and merge `metadata.hasIndexedFiles=true, fileIndexVersion=2`. On any failure: `file_index_status='failed'`, `file_index_error='<failure>: <reason>'` (rows may be partial — status is the authority, never row presence).

Job: `apps/api/src/jobs/backupSnapshotFileIndexWorker.ts` — queue `backup-snapshot-file-index`, `enqueueSnapshotFileIndexHydration(snapshotDbId, reason: 'result' | 'recovery_create' | 'authenticate' | 'exchange' | 'manual')` with `jobId: \`hydrate:${snapshotDbId}\`` (BullMQ dedupe), attempts 3, exponential backoff 60 s, concurrency 2, registered in `workerRegistry.ts`. Triggers: `applyBackupCommandResultToJob` when `referencedFiles > 0` (after the snapshot upsert commits — enqueue via the existing post-commit hook pattern if one exists, otherwise after the transaction in `backupWorker.ts`), `createBareMetalRecovery` / `POST /bmr/tokens` preflight, exchange/authenticate pending branch. Persistence guard: the delete+reinsert at `backupResultPersistence.ts:1373` is skipped when `file_index_status = 'complete'` (server index is authoritative); otherwise it sets `file_index_status = 'agent'` when it writes rows.

## 4. Refusal / outcome matrix (acceptance criteria — every row has a test)

| # | Situation | Where | Result |
|---|---|---|---|
| R1 | Self-contained snapshot (`referenced_files` NULL/0), any client | authenticate/exchange | granted as today; `fileIndex` omitted; own-prefix downloads unchanged |
| R2 | Referenced snapshot, legacy client (no `capabilities`) | authenticate/exchange | 409 `client_capability_required`; code NOT consumed; token NOT flipped |
| R3 | Referenced snapshot, new client, index `none`/`agent` | exchange | 409 `snapshot_index_pending` + hydration enqueued; code NOT consumed |
| R4 | Referenced snapshot, new client, index `complete` | exchange | 200; `negotiated_capabilities` persisted; `fileIndex` present |
| R5 | Re-authenticate without capability on a token that negotiated it | authenticate | 409 `capability_downgrade` |
| R6 | External key ∈ index ∧ origin verified | download | 200/redirect for the exact physical key |
| R7 | External key ∉ index (sibling file of a referenced origin, ancestor manifest, newer unreferenced snapshot) | download | 409 not authorized, before presign |
| R8 | External key ∈ index but origin row org/device/identity ≠ token's (poisoned manifest in shared bucket) | hydration | `origin_unverifiable` → never reaches download |
| R9 | Origin retired (row deleted, retirement present) | hydration + download | R4 + R6 succeed |
| R10 | Token snapshot `storage_identity` NULL | creation preflight + exchange | 409 `snapshot_storage_identity_unknown` |
| R11 | Resolved provider identity ≠ pinned | exchange | 409 `storage_identity_drift` |
| R12 | Own-prefix key on a token WITHOUT the capability | download | unchanged (allowed) |
| R13 | Cross-org token requests org B's snapshot key | download | 409 (existing integration test stays) |
| R14 | New agent, old server (no `download.capabilities`), manifest has external refs | agent, before provision | progress `refused`, zero target writes |
| R15 | New agent, new server, sha mismatch | agent, before provision | progress `refused` |
| R16 | Session refresh returns a descriptor without the capability | agent | download error `ErrCapabilityDowngrade`; admissible set never shrinks |
| R17 | Engine preflight: manifest entry not admitted by provider | rebuild preflight | `RefusalError`, no `provision` calls (fake system records none) |
| R18 | 98,411 failed files | agent progress + API | body < 1 MiB, `failed` persists with `filesFailed` + 50-sample |
| R19 | 100k-entry manifest, empty agent index | hydration (real PG) | `complete`, 100k rows, one origins row per origin, < 60 s |
| R20 | QEMU e2e, three generations | CI | gen-3 recovery reaches `validated`/reboot; unrelated object refused by fake server |

## 5. Deliberate non-goals (say so in the PR)

No dispatch-time helper-version gate for DR/VM-restore (would need a release-version constant; authenticate-time refusal posts `refused` before provisioning and is exact). No backfill hydration of every existing snapshot (lazy: on result, on recovery creation, on exchange). No change to own-prefix drift behaviour (follow-up filed in Task 14). No console "re-prompt server URL" fix (W08). `#6470` stays open (the `/bmr/tokens` restorable check is a separate defect).

---

## Part A — W09a (PR 1, "Part of #6464") — API

> Ground truth verified against the worktree checkout on 2026-09-20. Where a
> cited line number in Part 0 / the stub drifted by a handful of lines from
> what's actually in the file today, this document cites the CURRENT line
> number and keeps the original as context; every drift is small (post-W05
> code additions) and does not change any interface or file path named in the
> stub. Genuine content deviations from the stub are marked `Deviation:`.

### Task 1: Shared object-key contract + test vectors

**Files:**
- Create: `agent/internal/backup/bmr/testdata/object-key-vectors.json` (new directory — `agent/internal/backup/bmr/testdata/` does not exist yet)
- Create: `apps/api/src/services/backupObjectKey.ts`
- Test: `apps/api/src/services/backupObjectKey.test.ts`

**Interfaces (Produces):**
```ts
export const BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY = 'snapshot-file-membership-v1' as const;
export type ParsedBackupObjectKey = { snapshotId: string; rest: string };
export function parseBackupObjectKey(key: string): ParsedBackupObjectKey | null;
export type BackupObjectKeyScope =
  | { kind: 'own'; key: string }
  | { kind: 'external'; key: string; originSnapshotId: string };
export function classifyBackupObjectKey(key: string, ownSnapshotId: string): BackupObjectKeyScope | null;
export function hasMembershipCapability(list: readonly string[] | null | undefined): boolean;
```

- [ ] **Step 1: Write the vectors file and the failing test**

`agent/internal/backup/bmr/testdata/object-key-vectors.json`:
```json
[
  { "key": "snapshots/a/files/x.gz", "valid": true, "snapshotId": "a", "rest": "files/x.gz", "note": "ordinary content key" },
  { "key": "snapshots/a/manifest.json", "valid": true, "snapshotId": "a", "rest": "manifest.json", "note": "manifest key" },
  { "key": "snapshots/A/files/x.gz", "valid": true, "snapshotId": "A", "rest": "files/x.gz", "note": "uppercase snapshot id — classify is case-sensitive, parse accepts it" },
  { "key": "snapshots/snap-20260901T020001Z-abcdef/files/x.gz", "valid": true, "snapshotId": "snap-20260901T020001Z-abcdef", "rest": "files/x.gz", "note": "realistic agent-generated snapshot id" },
  { "key": "snapshots/a/files/x.gz.gz", "valid": true, "snapshotId": "a", "rest": "files/x.gz.gz", "note": "double .gz preserved verbatim — never trim" },
  { "key": "snapshots/a/files/dir with space/f.gz", "valid": true, "snapshotId": "a", "rest": "files/dir with space/f.gz", "note": "spaces in rest are legal" },
  { "key": "snapshots/a/files/%2e%2e/x", "valid": true, "snapshotId": "a", "rest": "files/%2e%2e/x", "note": "percent-encoded .. is a LITERAL rest segment — no decoding is ever applied" },
  { "key": "snapshots/a/system-state/manifest.json", "valid": true, "snapshotId": "a", "rest": "system-state/manifest.json", "note": "system-state sub-prefix" },
  { "key": "snapshots/a/layout.json", "valid": true, "snapshotId": "a", "rest": "layout.json", "note": "layout manifest key" },
  { "key": "snapshots/a-b_c.1/files/x", "valid": true, "snapshotId": "a-b_c.1", "rest": "files/x", "note": "snapshot id allows dot/underscore/hyphen after the first char" },
  { "key": "snapshots/a/../b/manifest.json", "valid": false, "note": "a .. path segment anywhere in rest is invalid" },
  { "key": "snapshots/a/./manifest.json", "valid": false, "note": "a . path segment anywhere in rest is invalid" },
  { "key": "snapshots//a/x", "valid": false, "note": "empty snapshot id segment (double slash after snapshots/) is invalid" },
  { "key": "snapshots/a/", "valid": false, "note": "empty rest (trailing slash, nothing after) is invalid" },
  { "key": "snapshots/a", "valid": false, "note": "no rest segment at all is invalid" },
  { "key": "/snapshots/a/x", "valid": false, "note": "a leading slash is invalid — the key must start exactly with snapshots/" },
  { "key": "snap/a/x", "valid": false, "note": "wrong root segment (not literally 'snapshots') is invalid" },
  { "key": "snapshots/./files/x", "valid": false, "note": "a . as the snapshot id segment is invalid" },
  { "key": "snapshots/../files/x", "valid": false, "note": "a .. as the snapshot id segment is invalid" },
  { "key": "snapshots/a/files/x\u0000.gz", "valid": false, "note": "an embedded NUL byte anywhere in the key is invalid" },
  { "key": "snapshots/a/files\\x.gz", "valid": false, "note": "a backslash anywhere in the key is invalid — keys are POSIX-style only" },
  { "key": "", "valid": false, "note": "empty key is invalid" },
  { "key": "snapshots/a/files/x/", "valid": false, "note": "rest ending in a trailing slash is invalid" }
]
```

`apps/api/src/services/backupObjectKey.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY,
  classifyBackupObjectKey,
  hasMembershipCapability,
  parseBackupObjectKey,
} from './backupObjectKey';

type Vector = { key: string; valid: boolean; snapshotId?: string; rest?: string; note: string };

const vectors: Vector[] = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../../agent/internal/backup/bmr/testdata/object-key-vectors.json'),
    'utf8',
  ),
);

describe('parseBackupObjectKey', () => {
  it('loaded at least 20 vectors from the shared fixture', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20);
  });

  for (const vector of vectors) {
    it(`${vector.valid ? 'accepts' : 'rejects'} ${JSON.stringify(vector.key)} — ${vector.note}`, () => {
      const parsed = parseBackupObjectKey(vector.key);
      if (!vector.valid) {
        expect(parsed).toBeNull();
        return;
      }
      expect(parsed).not.toBeNull();
      expect(parsed!.snapshotId).toBe(vector.snapshotId);
      expect(parsed!.rest).toBe(vector.rest);
    });
  }

  it('never decodes percent-escapes — %2e%2e is a literal path segment, not ..', () => {
    const parsed = parseBackupObjectKey('snapshots/a/files/%2e%2e/x');
    expect(parsed).toEqual({ snapshotId: 'a', rest: 'files/%2e%2e/x' });
  });

  it('never trims a trailing .gz, even doubled', () => {
    const parsed = parseBackupObjectKey('snapshots/a/files/x.gz.gz');
    expect(parsed!.rest).toBe('files/x.gz.gz');
  });
});

describe('classifyBackupObjectKey', () => {
  it('classifies a key under the caller\'s own snapshot id as own', () => {
    expect(classifyBackupObjectKey('snapshots/a/files/x.gz', 'a')).toEqual({
      kind: 'own',
      key: 'snapshots/a/files/x.gz',
    });
  });

  it('classifies a key under a DIFFERENT snapshot id as external, naming the origin', () => {
    expect(classifyBackupObjectKey('snapshots/older/files/x.gz', 'a')).toEqual({
      kind: 'external',
      key: 'snapshots/older/files/x.gz',
      originSnapshotId: 'older',
    });
  });

  it('is case-sensitive — SNAP-1 is external to snap-1, never own', () => {
    expect(classifyBackupObjectKey('snapshots/SNAP-1/files/x.gz', 'snap-1')).toEqual({
      kind: 'external',
      key: 'snapshots/SNAP-1/files/x.gz',
      originSnapshotId: 'SNAP-1',
    });
  });

  it('returns null for an unparseable key regardless of ownSnapshotId', () => {
    expect(classifyBackupObjectKey('snapshots/a/../b/manifest.json', 'a')).toBeNull();
  });
});

describe('hasMembershipCapability', () => {
  it('is true only when the exact capability string is present', () => {
    expect(hasMembershipCapability([BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY])).toBe(true);
    expect(hasMembershipCapability(['some-other-cap'])).toBe(false);
    expect(hasMembershipCapability([])).toBe(false);
    expect(hasMembershipCapability(null)).toBe(false);
    expect(hasMembershipCapability(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/backupObjectKey.test.ts`
Expected: `Error: Cannot find module './backupObjectKey'` (the module does not exist yet) and/or `ENOENT` on the vectors file if it hadn't been written — since the vectors file is written in this same step, the actual red is the missing `backupObjectKey.ts` module, e.g. `Failed to resolve import "./backupObjectKey"`.

- [ ] **Step 3: Implement**

`apps/api/src/services/backupObjectKey.ts`:
```ts
// Shared object-key contract for token-mode bare-metal recovery downloads
// (W09, #6464). This is ONE half of a two-language contract: the Go mirror is
// bmr.ParseObjectKey / bmr.ClassifyObjectKey in
// agent/internal/backup/bmr/object_key.go (W09b, agent side), and both sides
// are pinned to agent/internal/backup/bmr/testdata/object-key-vectors.json —
// edit that file, not either implementation, when a new case needs covering.
//
// Rules (Part 0 §1 "Object-key contract" — do not relax any of these):
//   - key matches ^snapshots/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/(.+)$
//   - group 2 (rest) is non-empty
//   - no NUL byte anywhere in the key
//   - no backslash anywhere in the key (POSIX-style keys only)
//   - no path segment (split on '/') equal to '' (double slash), '.', or '..'
//     ANYWHERE in the key, not just in rest
//   - rest must not end in '/'
//   - the key is served/compared VERBATIM: no percent-decoding, no case
//     folding, no trimming of a trailing .gz (a writer may legitimately
//     produce x.gz.gz — agent/internal/backup/snapshot.go:1765 — and trimming
//     it here would silently rewrite a caller's requested key to a DIFFERENT
//     object than the one on disk).
export const BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY = 'snapshot-file-membership-v1' as const;

export type ParsedBackupObjectKey = { snapshotId: string; rest: string };

const KEY_PATTERN = /^snapshots\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})\/(.+)$/;

export function parseBackupObjectKey(key: string): ParsedBackupObjectKey | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (key.includes('\0') || key.includes('\\')) return null;

  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, snapshotId, rest] = match;
  if (!snapshotId || !rest) return null;
  if (rest.endsWith('/')) return null;

  // Reject a '.', '..', or empty segment ANYWHERE in the full key — not just
  // in `rest` — so `snapshots/./x` and `snapshots//a/x` are caught even
  // though the id-capture group's own character class already excludes most
  // of these shapes for the snapshot-id segment specifically.
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }

  return { snapshotId, rest };
}

export type BackupObjectKeyScope =
  | { kind: 'own'; key: string }
  | { kind: 'external'; key: string; originSnapshotId: string };

export function classifyBackupObjectKey(key: string, ownSnapshotId: string): BackupObjectKeyScope | null {
  const parsed = parseBackupObjectKey(key);
  if (!parsed) return null;
  if (parsed.snapshotId === ownSnapshotId) return { kind: 'own', key };
  return { kind: 'external', key, originSnapshotId: parsed.snapshotId };
}

export function hasMembershipCapability(list: readonly string[] | null | undefined): boolean {
  return Array.isArray(list) && list.includes(BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY);
}
```

Note on the `snapshots//a/x` vector: the id-capture group `([A-Za-z0-9][A-Za-z0-9._-]{0,254})` already cannot match an empty string (it requires at least one alnum first character), so the regex itself fails that case (no match → null) before the segment loop ever runs — both are still exercised by the test/vectors so the two independent guards (regex shape, segment loop) don't silently drift apart if either is edited later.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/backupObjectKey.test.ts`
Expected: PASS, all vectors + unit assertions green (≥ 26 tests: 22 vector cases + 4 fixed assertions).

Run: `cd apps/api && npx tsc --noEmit -p apps/api` (or the repo's standard `npx tsc --noEmit` from `apps/api`)
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/backup/bmr/testdata/object-key-vectors.json apps/api/src/services/backupObjectKey.ts apps/api/src/services/backupObjectKey.test.ts
git commit -m "feat(backup): shared object-key parse/classify contract + cross-language test vectors (W09a Task 1)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 2: Migrations, Drizzle schema, registries

**Files:**
- Create: `apps/api/migrations/2026-10-24-220000-backup-snapshot-file-index.sql`
- Create: `apps/api/migrations/2026-10-24-220100-recovery-tokens-negotiated-capabilities.sql`
- Modify: `apps/api/src/db/schema/backup.ts` (`backupSnapshots` gains five columns after line 369 `bareMetalReasons`; new `backupSnapshotOrigins` table after `backupSnapshotFiles` at line 401; `backupSnapshotFiles` gains the `(snapshot_db_id, backup_path)` index in its `(table) => ({...})` block at lines 397-400)
- Modify: `apps/api/src/db/schema/recoveryTokens.ts` (`recoveryTokens` gains `negotiatedCapabilities` in the column block, lines 20-47)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:151` (`backup_snapshots` row — add five columns to `included`), `:497` (`recovery_tokens` row — add `negotiated_capabilities` to `included`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (add `['backup_snapshot_origins', ['backup_snapshots']]` to `PARENT_FK_JOIN_POLICY_TABLES`, next to the existing `['backup_snapshot_files', ['backup_snapshots']]` entry at line 898)
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing ordering test, must stay green — no edits expected), `pnpm db:check-drift`, `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces (Produces):**
```ts
// db/schema/backup.ts additions
backupSnapshots: {
  // ...existing columns...
  fileIndexStatus: text('file_index_status').notNull().default('none'), // CHECK IN (none, agent, hydrating, complete, failed)
  fileIndexManifestSha256: text('file_index_manifest_sha256'),
  fileIndexHydratedAt: timestamp('file_index_hydrated_at', { withTimezone: true }),
  fileIndexExternalCount: integer('file_index_external_count'),
  fileIndexError: text('file_index_error'),
}
export const backupSnapshotOrigins = pgTable('backup_snapshot_origins', {
  id: uuid('id').primaryKey().defaultRandom(),
  snapshotDbId: uuid('snapshot_db_id').notNull().references(() => backupSnapshots.id, { onDelete: 'cascade' }),
  originSnapshotId: varchar('origin_snapshot_id', { length: 255 }).notNull(),
  originOrgId: uuid('origin_org_id').notNull(),
  originDeviceId: uuid('origin_device_id').notNull(),
  originStorageIdentity: text('origin_storage_identity').notNull(),
  originStoragePrefix: text('origin_storage_prefix'),
  provenance: text('provenance').notNull(), // CHECK IN ('live','retired')
  objectCount: integer('object_count').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  snapshotOriginUq: uniqueIndex('backup_snapshot_origins_snapshot_origin_uq').on(table.snapshotDbId, table.originSnapshotId),
  snapshotIdx: index('backup_snapshot_origins_snapshot_idx').on(table.snapshotDbId),
}));
// db/schema/recoveryTokens.ts addition
recoveryTokens: {
  // ...existing columns...
  negotiatedCapabilities: text('negotiated_capabilities').array(),
}
```

- [ ] **Step 1: Write the failing tests (red first)**

The ordering/idempotency contract is enforced by an EXISTING test (`autoMigrate.test.ts`) that will simply pass once the new files sort correctly — there is nothing new to author there. The genuinely new coverage is the integration allowlist and export-policy entries, which fail in the opposite direction from the usual TDD flow (they only turn red once the migration exists and the columns are queryable), so the sequence here is: add the allowlist/export-policy entries FIRST (they will fail against the CURRENT schema because the columns/table don't exist yet), confirm that red, then ship the migration + Drizzle schema to turn them green.

Add to `apps/api/src/services/tenantExportPolicyRegistry.ts` line 151 (replace the `backup_snapshots` row):
```ts
  "backup_snapshots": tablePolicy("org_id", {"included":["id","org_id","job_id","device_id","config_id","snapshot_id","label","location","timestamp","size","file_count","is_incremental","parent_snapshot_id","expires_at","storage_tier","is_immutable","immutable_until","legal_hold","legal_hold_reason","immutability_enforcement","requested_immutability_enforcement","immutability_fallback_reason","checksum_sha256","backup_type","storage_identity","bare_metal_restorable","bare_metal_reasons","file_index_status","file_index_manifest_sha256","file_index_hydrated_at","file_index_external_count","file_index_error"],"reviewedIncluded":["encryption_key_id"],"excludedSensitive":[],"excludedOpen":["metadata","gfs_tags","hardware_profile","system_state_manifest","layout_manifest"]}),
```
Add a new row right after the `backup_snapshot_files` row (find it with `grep -n '"backup_snapshot_files":' apps/api/src/services/tenantExportPolicyRegistry.ts` — it has no `org_id` and is registered by `PARENT_FK_JOIN_POLICY_TABLES` alone, so it carries NO `tablePolicy` entry at all; `backup_snapshot_origins` is the same shape and likewise gets no `tablePolicy` entry — the export-policy suite only requires an entry for tables that DO have `org_id`, and `backup_snapshot_origins` deliberately does not).

Line 497 (replace the `recovery_tokens` row):
```ts
  "recovery_tokens": tablePolicy("org_id", {"included":["id","org_id","device_id","snapshot_id","restore_type","status","created_by","created_at","expires_at","authenticated_at","completed_at","used_at","negotiated_capabilities"],"reviewedIncluded":["authorization_principal_kind","authorization_principal_id","authorization_grant_revision","authorization_state","authorization_denial_code","authorization_checked_at"],"excludedSensitive":["token_hash"],"excludedOpen":["target_config"]}),
```

Add to `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, in the `PARENT_FK_JOIN_POLICY_TABLES` map, directly after the existing `['backup_snapshot_files', ['backup_snapshots']]` line (line 898):
```ts
  ['backup_snapshot_origins', ['backup_snapshots']],
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: FAIL — the export-policy suite reads the live `information_schema.columns` for `backup_snapshots` / `recovery_tokens` and diffs it against the registry; the registry now names five/one columns that DON'T EXIST YET on the live table, so the suite fails with something like `backup_snapshots: registry lists columns not present in the database: file_index_status, file_index_manifest_sha256, ...`.

Run: `cd apps/api && DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: FAIL — `PARENT_FK_JOIN_POLICY_TABLES` now names `backup_snapshot_origins`, a table that doesn't exist yet, so the suite fails with something like `relation "backup_snapshot_origins" does not exist` or an explicit "allowlisted table not found" assertion failure.

- [ ] **Step 3: Implement — migrations**

`apps/api/migrations/2026-10-24-220000-backup-snapshot-file-index.sql`:
```sql
-- W09 (#6464) Task 2 — server-side file-index state on backup_snapshots, plus
-- a new backup_snapshot_origins table recording verified provenance for every
-- OLDER snapshot an incremental manifest references. See Part 0 §2/§3 and
-- docs/superpowers/plans/backup/_w09-part0.md for the full contract.
--
-- Idempotent throughout. No inner BEGIN/COMMIT — autoMigrate wraps each file
-- in one transaction. Row-writing (the backfill UPDATE below) elects system
-- scope first, same as 2026-10-24-210000-time-entries-billable-minutes.sql.
-- No per-table GRANT: ensureAppRole.ts grants breeze_app on every public
-- table (plus ALTER DEFAULT PRIVILEGES) at boot — backup_snapshot_files
-- itself carries no explicit GRANT either; mirror that, not an explicit one.

-- ============================================
-- 1. backup_snapshots: file-index state columns
-- ============================================
ALTER TABLE backup_snapshots
  ADD COLUMN IF NOT EXISTS file_index_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS file_index_manifest_sha256 text,
  ADD COLUMN IF NOT EXISTS file_index_hydrated_at timestamptz,
  ADD COLUMN IF NOT EXISTS file_index_external_count integer,
  ADD COLUMN IF NOT EXISTS file_index_error text;

DO $$ BEGIN
  ALTER TABLE backup_snapshots
    ADD CONSTRAINT backup_snapshots_file_index_status_chk
    CHECK (file_index_status IN ('none', 'agent', 'hydrating', 'complete', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN backup_snapshots.file_index_status IS
  'W09 (#6464): none = never assessed; agent = rows came from the (possibly truncated) agent-reported index, not proof of completeness; hydrating = server-side re-index in flight; complete = server verified against the stored manifest, safe to authorize external-reference downloads against; failed = hydration attempted and could not complete (see file_index_error).';

-- Backfill: every snapshot whose backup_snapshot_files rows came from the
-- agent-reported index (persistence's metadata.hasIndexedFiles=true, written
-- at backupResultPersistence.ts:1303) starts life at 'agent', never 'complete'
-- — the agent index is NOT proof of completeness (Part 0 §0 "the helper
-- replaces snapshot.files with [] when the result exceeds the 5MB delivery
-- budget"). Every other row stays 'none', its default.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE backup_snapshots
  SET file_index_status = 'agent'
  WHERE file_index_status = 'none'
    AND (metadata ->> 'hasIndexedFiles') = 'true';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'W09 backup-snapshot-file-index: backfilled file_index_status=agent on % snapshots with a pre-existing agent-reported index', n;
  END IF;
END $$;

-- ============================================
-- 2. backup_snapshot_files: index the column the download-authorization
--    membership check filters on. Not built CONCURRENTLY — autoMigrate
--    wraps this file in a transaction, and CREATE INDEX CONCURRENTLY cannot
--    run inside one. This takes a SHARE lock on backup_snapshot_files for
--    the duration of the build (blocks writers, not readers); the table is
--    written only at backup-result-persistence time and by this wave's own
--    hydration job, both low-frequency compared to request traffic.
-- ============================================
CREATE INDEX IF NOT EXISTS backup_snapshot_files_snapshot_backup_path_idx
  ON backup_snapshot_files (snapshot_db_id, backup_path);

-- ============================================
-- 3. backup_snapshot_origins — verified provenance for every OLDER snapshot
--    an incremental manifest references. Snapshot-keyed like
--    backup_snapshot_files: no org_id/device_id columns of its own (this
--    table records ANOTHER snapshot's identity, and that snapshot may no
--    longer have a live row — see origin_org_id/origin_device_id below), so
--    it reaches its own tenant only through snapshot_db_id -> backup_snapshots
--    — Shape 5 / PARENT_FK_JOIN_POLICY_TABLES, exactly like
--    backup_snapshot_files (2026-06-23-sec-review-1-fk-child-rls-backstop.sql).
-- ============================================
CREATE TABLE IF NOT EXISTS backup_snapshot_origins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_db_id uuid NOT NULL REFERENCES backup_snapshots(id) ON DELETE CASCADE,
  -- origin_snapshot_id is the AGENT id (varchar, matches backup_snapshots.snapshot_id
  -- / backup_snapshot_retirements.snapshot_id), not a FK to backup_snapshots.id:
  -- the origin's own backup_snapshots row may already be gone (retention
  -- deleted it — see origin_org_id/origin_device_id below, captured from
  -- whichever of the live row or the retirement record still existed at
  -- hydration time).
  origin_snapshot_id varchar(255) NOT NULL,
  -- origin_org_id / origin_device_id are DELIBERATELY NOT FKs: provenance
  -- must not vanish (or silently NULL) with the origin device row's own
  -- lifecycle — the referencing snapshot's own snapshot_db_id FK (above)
  -- governs this row's lifetime, cascading when THIS snapshot is deleted,
  -- never when the ORIGIN's device is.
  origin_org_id uuid NOT NULL,
  origin_device_id uuid NOT NULL,
  origin_storage_identity text NOT NULL,
  origin_storage_prefix text,
  provenance text NOT NULL,
  object_count integer NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE backup_snapshot_origins
    ADD CONSTRAINT backup_snapshot_origins_provenance_chk
    CHECK (provenance IN ('live', 'retired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS backup_snapshot_origins_snapshot_origin_uq
  ON backup_snapshot_origins (snapshot_db_id, origin_snapshot_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_origins_snapshot_idx
  ON backup_snapshot_origins (snapshot_db_id);

ALTER TABLE backup_snapshot_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshot_origins FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_snapshot_origins;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_snapshot_origins;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_snapshot_origins;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_snapshot_origins;
CREATE POLICY breeze_org_isolation_select ON backup_snapshot_origins FOR SELECT USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON backup_snapshot_origins FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_update ON backup_snapshot_origins FOR UPDATE USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON backup_snapshot_origins FOR DELETE USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
```

`apps/api/migrations/2026-10-24-220100-recovery-tokens-negotiated-capabilities.sql`:
```sql
-- W09 (#6464) Task 2 — records which recovery-download capabilities the
-- server GRANTED a token at authenticate/exchange time (Part 0 §1). NULL for
-- every token minted before this wave and for any token that never
-- negotiated (self-contained snapshot, R1). No CHECK on array contents: the
-- only capability string that exists today is the membership one
-- (BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY, backupObjectKey.ts), and this
-- column is forward-compatible with future capability strings by design
-- (Part 0 §1 "Unknown capability strings are ignored").
--
-- Idempotent. No inner BEGIN/COMMIT. DDL only — no row is written, so no
-- breeze.scope election is required. No per-table GRANT (ensureAppRole.ts).

ALTER TABLE recovery_tokens
  ADD COLUMN IF NOT EXISTS negotiated_capabilities text[];

COMMENT ON COLUMN recovery_tokens.negotiated_capabilities IS
  'W09 (#6464): capabilities the SERVER granted this token at authenticate/exchange (subset of what the client sent). NULL = legacy token or a negotiation that granted nothing (self-contained snapshot).';
```

- [ ] **Step 4: Implement — Drizzle schema**

`apps/api/src/db/schema/backup.ts` — replace the `backupSnapshots` column block's tail (after `bareMetalReasons: text('bare_metal_reasons').array(),` at line 369, before the closing `},` at line 370):
```ts
    layoutManifest: jsonb('layout_manifest'),
    bareMetalRestorable: boolean('bare_metal_restorable'),
    bareMetalReasons: text('bare_metal_reasons').array(),
    // W09 (#6464): server-verified file index. 'complete' is the ONLY state
    // that authorizes an external-reference download — see
    // services/backupSnapshotFileIndex.ts and services/recoveryDownloadService.ts.
    fileIndexStatus: text('file_index_status').notNull().default('none'),
    fileIndexManifestSha256: text('file_index_manifest_sha256'),
    fileIndexHydratedAt: timestamp('file_index_hydrated_at', { withTimezone: true }),
    fileIndexExternalCount: integer('file_index_external_count'),
    fileIndexError: text('file_index_error'),
  },
```

`backupSnapshotFiles`'s index block (replace lines 397-400):
```ts
  (table) => ({
    snapshotIdx: index('backup_snapshot_files_snapshot_idx').on(table.snapshotDbId),
    snapshotSourceIdx: index('backup_snapshot_files_snapshot_source_idx').on(table.snapshotDbId, table.sourcePath),
    // W09 (#6464): the download-authorization membership check
    // (authorizeExternalReference, Task 6) filters by (snapshot_db_id,
    // backup_path) — index it so a 100k-row snapshot's per-download
    // authorization stays an index lookup, not a sequential scan.
    snapshotBackupPathIdx: index('backup_snapshot_files_snapshot_backup_path_idx').on(table.snapshotDbId, table.backupPath),
  })
```

New table, inserted directly after the `backupSnapshotFiles` block (after its closing `);` at line 401, before `backupSnapshotRetirementReasonEnum`):
```ts
// W09 (#6464): verified provenance for every OLDER snapshot an incremental
// manifest references. Written only by hydrateSnapshotFileIndex
// (services/backupSnapshotFileIndex.ts) once the manifest has been read and
// every referenced origin snapshot verified (live row or retirement record,
// matching org/device/storage identity). Deliberately snapshot-keyed like
// backupSnapshotFiles — no org_id/device_id column of its own — and
// origin_org_id/origin_device_id are plain uuid columns, NOT FKs: provenance
// must survive the origin device's own deletion. See Part 0 §2.
export const backupSnapshotOrigins = pgTable(
  'backup_snapshot_origins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotDbId: uuid('snapshot_db_id')
      .notNull()
      .references(() => backupSnapshots.id, { onDelete: 'cascade' }),
    originSnapshotId: varchar('origin_snapshot_id', { length: BACKUP_SNAPSHOT_ID_MAX_LENGTH }).notNull(),
    originOrgId: uuid('origin_org_id').notNull(),
    originDeviceId: uuid('origin_device_id').notNull(),
    originStorageIdentity: text('origin_storage_identity').notNull(),
    originStoragePrefix: text('origin_storage_prefix'),
    provenance: text('provenance').notNull(),
    objectCount: integer('object_count').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    snapshotOriginUq: uniqueIndex('backup_snapshot_origins_snapshot_origin_uq').on(
      table.snapshotDbId,
      table.originSnapshotId,
    ),
    snapshotIdx: index('backup_snapshot_origins_snapshot_idx').on(table.snapshotDbId),
  })
);
```
(`BACKUP_SNAPSHOT_ID_MAX_LENGTH` is already imported/defined in this file for `backupJobs.snapshotId`/`backupSnapshots.snapshotId` — reuse it, don't hardcode `255` a second time. Confirm with `grep -n "BACKUP_SNAPSHOT_ID_MAX_LENGTH" apps/api/src/db/schema/backup.ts` before writing the edit; if it's a plain `255` constant imported from elsewhere, import the same symbol.)

`apps/api/src/db/schema/recoveryTokens.ts` — add one column to the `recoveryTokens` block (after `usedAt: timestamp('used_at'),` at line 45):
```ts
    usedAt: timestamp('used_at'),
    // W09 (#6464): capabilities the server GRANTED this token at
    // authenticate/exchange (services/recoveryCapabilities.ts). NULL for a
    // legacy token or a negotiation that granted nothing.
    negotiatedCapabilities: text('negotiated_capabilities').array(),
    ...recoveryAuthorizationSubjectColumns(),
```
(`text` must already be imported in this file for `tokenHash`/`restoreType`'s sibling columns via `varchar` — confirm `text` is imported from `drizzle-orm/pg-core`; add it to the existing `import { pgTable, uuid, varchar, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';` line if missing.)

- [ ] **Step 5: Run**

Run: `cd apps/api && pnpm db:check-drift`
Expected: PASS (no drift) once both migrations have applied to the dev DB and the Drizzle schema matches. If drift is reported, the Drizzle column defs don't match the SQL exactly — check types/defaults/nullability side by side.

Run: `cd apps/api && DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS.

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts`
Expected: PASS (naming/ordering assertions unaffected — the two new files sort after `2026-10-24-210000-...` and before nothing, satisfying `localeCompare`).

- [ ] **Step 6: Forge a cross-tenant insert as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
```
```sql
SELECT set_config('breeze.scope', 'organization', true);
SELECT set_config('breeze.org_id', '<org-A-uuid>', true);
-- insert against a snapshot_db_id that belongs to a DIFFERENT org (org B)
INSERT INTO backup_snapshot_origins
  (snapshot_db_id, origin_snapshot_id, origin_org_id, origin_device_id, origin_storage_identity, provenance, object_count)
VALUES
  ('<org-B-snapshot-uuid>', 'snap-x', '<org-B-org-uuid>', '<org-B-device-uuid>', 'local::/tmp/x', 'live', 1);
```
Expected: `ERROR:  new row violates row-level security policy for table "backup_snapshot_origins"` (SQLSTATE `42501`).

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-24-220000-backup-snapshot-file-index.sql apps/api/migrations/2026-10-24-220100-recovery-tokens-negotiated-capabilities.sql apps/api/src/db/schema/backup.ts apps/api/src/db/schema/recoveryTokens.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(db): server file-index state + backup_snapshot_origins provenance table + negotiated-capabilities column (W09a Task 2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 3: Manifest bytes fetch + hydration service

**Files:**
- Modify: `apps/api/src/services/backupSnapshotStorage.ts` (add `fetchBackupObjectBytes` right after `fetchBackupObjectText`, currently lines 320-330; both `fetchS3ObjectText`/`fetchLocalObjectText` siblings live at lines 296-313)
- Create: `apps/api/src/services/backupSnapshotFileIndex.ts`
- Modify: `apps/api/src/services/backupResultPersistence.ts` (guard the delete+reinsert block at lines 1381-1412; set `fileIndexStatus` on the snapshot upsert; enqueue hydration near the `applyBackupCommandResultToJob` return at line ~1560, gated on `result.referencedFiles`)
- Test: `apps/api/src/services/backupSnapshotFileIndex.test.ts`, `apps/api/src/services/backupSnapshotStorage.test.ts` (bytes fetch, both providers), `apps/api/src/services/backupResultPersistence.test.ts` (guard + enqueue)

**Interfaces (Consumes):** Task 1 `parseBackupObjectKey`/`classifyBackupObjectKey`/`BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY`; Task 2 Drizzle schema (`backupSnapshots.fileIndexStatus` etc., `backupSnapshotOrigins`); `resolveSnapshotProviderConfig` (`recoveryBootstrap.ts:167`); `normalizeStorageIdentity` (`jobs/backupRetention.ts:831`, already exported); `backupSnapshotManifestKey` (`backupSnapshotStorage.ts:161`); `reconcileManifestSchema` is NOT exported from `backupSnapshotReconcile.ts` today (it's a private `const` at line 258) — Task 3 duplicates its shape as `hydrationManifestSchema` in the new file rather than exporting a schema out of a reconcile-specific module for one caller (keeps the reconcile module's internals private; a shared schema module would be a bigger refactor than this wave needs).

**Produces:**
```ts
// backupSnapshotStorage.ts addition
export async function fetchBackupObjectBytes(input: {
  provider: string | null | undefined;
  providerConfig: unknown;
  key: string;
}): Promise<Uint8Array>;

// backupSnapshotFileIndex.ts
export type FileIndexStatus = 'none' | 'agent' | 'hydrating' | 'complete' | 'failed';
export type HydrationFailure =
  | 'storage_identity_unknown' | 'storage_identity_drift' | 'manifest_missing'
  | 'manifest_invalid' | 'manifest_key_invalid' | 'origin_unverifiable' | 'origin_identity_pending' | 'provider_error';
export const RETRYABLE_HYDRATION_FAILURES: ReadonlySet<HydrationFailure>;
export function isRetryableHydrationFailure(failure: HydrationFailure): boolean;
export function hydrationFailureFromError(error: string | null): HydrationFailure | null; // parses the `<failure>: ` prefix of file_index_error
export type HydrationOutcome =
  | { status: 'complete'; manifestSha256: string; entryCount: number; externalCount: number; originSnapshotIds: string[] }
  | { status: 'failed'; failure: HydrationFailure; reason: string; retryable: boolean }
  | { status: 'skipped'; reason: 'not_referenced' | 'already_complete' | 'in_progress' };
export type HydrationDeps = {
  fetchManifestBytes: (args: { provider: string; providerConfig: Record<string, unknown>; key: string }) => Promise<Uint8Array>;
  now?: () => Date;
};
export async function hydrateSnapshotFileIndex(
  snapshotDbId: string,
  opts?: { force?: boolean; deps?: HydrationDeps },
): Promise<HydrationOutcome>;
export async function readSnapshotFileIndexState(snapshotDbId: string): Promise<{
  status: FileIndexStatus;
  manifestSha256: string | null;
  externalCount: number | null;
  originSnapshotIds: string[];      // from backup_snapshot_origins, sorted; [] unless status === 'complete'
  error: string | null;
  retryable: boolean;               // hydrationFailureFromError(error) ∈ RETRYABLE_HYDRATION_FAILURES; false when error is null
  referencedFiles: number | null;
  storageIdentity: string | null;
} | null>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/backupSnapshotStorage.test.ts` — add (alongside whatever `fetchBackupObjectText` coverage already exists in this file; run `grep -n "fetchBackupObjectText" apps/api/src/services/backupSnapshotStorage.test.ts` first and mirror its S3/local mock setup exactly for the bytes variant):
```ts
describe('fetchBackupObjectBytes', () => {
  it('fetches S3 object bytes via transformToByteArray, not transformToString', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    s3SendMock.mockResolvedValueOnce({ Body: { transformToByteArray: async () => bytes } });
    const result = await fetchBackupObjectBytes({
      provider: 's3',
      providerConfig: { bucket: 'b', region: 'us-east-1' },
      key: 'snapshots/a/manifest.json',
    });
    expect(result).toEqual(bytes);
  });

  it('reads a local object with no text encoding (raw bytes)', async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from('{"id":"a"}'));
    const result = await fetchBackupObjectBytes({
      provider: 'local',
      providerConfig: { path: '/srv/backups' },
      key: 'snapshots/a/manifest.json',
    });
    expect(Buffer.from(result).toString('utf8')).toBe('{"id":"a"}');
    expect(readFileMock).toHaveBeenCalledWith(expect.stringContaining('snapshots/a/manifest.json')); // no 'utf8' second arg
  });

  it('throws for an unsupported provider, same as fetchBackupObjectText', async () => {
    await expect(fetchBackupObjectBytes({ provider: 'unknown', providerConfig: {}, key: 'x' }))
      .rejects.toThrow(/does not support object fetch/);
  });
});
```

`apps/api/src/services/backupSnapshotFileIndex.test.ts` (new file — Drizzle mock pattern copied from `apps/api/src/services/bareMetalRecoveryService.test.ts:12-42`, the `chainMock`/hoisted-mock shape):
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_DB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const STORAGE_IDENTITY = 'local::/srv/backups';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy', 'leftJoin', 'innerJoin']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const { selectMock, insertMock, updateMock, deleteMock, transactionMock, resolveSnapshotProviderConfigMock } = vi.hoisted(() => ({
  selectMock: vi.fn<(...args: unknown[]) => any>(),
  insertMock: vi.fn<(...args: unknown[]) => any>(),
  updateMock: vi.fn<(...args: unknown[]) => any>(),
  deleteMock: vi.fn<(...args: unknown[]) => any>(),
  transactionMock: vi.fn<(cb: (tx: unknown) => unknown) => unknown>(),
  resolveSnapshotProviderConfigMock: vi.fn<(...args: unknown[]) => any>(),
}));

vi.mock('../db', () => {
  const tx = {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  };
  return {
    db: { ...tx, transaction: (cb: (t: typeof tx) => unknown) => transactionMock(cb) },
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  };
});
vi.mock('./recoveryBootstrap', () => ({
  resolveSnapshotProviderConfig: (...args: unknown[]) => resolveSnapshotProviderConfigMock(...args),
  getStringValue: (record: Record<string, unknown> | null, key: string) =>
    record && typeof record[key] === 'string' ? String(record[key]) : null,
  asRecord: (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
}));

import { hydrateSnapshotFileIndex, readSnapshotFileIndexState } from './backupSnapshotFileIndex';

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_DB_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: 'snap-current',
    jobId: 'job-1', configId: 'config-1', storageIdentity: STORAGE_IDENTITY,
    fileIndexStatus: 'none', fileIndexHydratedAt: null, referencedFiles: 5,
    ...overrides,
  };
}

function manifestBytes(entries: Array<{ sourcePath: string; backupPath: string; size?: number }>) {
  return Buffer.from(JSON.stringify({ id: 'snap-current', files: entries }), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockImplementation(() => chainMock([]));
  insertMock.mockImplementation(() => chainMock([]));
  updateMock.mockImplementation(() => chainMock([snapshotRow({ fileIndexStatus: 'hydrating' })]));
  deleteMock.mockImplementation(() => chainMock([]));
  transactionMock.mockImplementation(async (cb: any) => cb({
    select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock,
  }));
  resolveSnapshotProviderConfigMock.mockResolvedValue({
    snapshot: snapshotRow(),
    config: null,
    providerType: 'local',
    providerConfig: { path: '/srv/backups' },
  });
});

describe('hydrateSnapshotFileIndex', () => {
  it('skips a snapshot with no referenced files (not_referenced)', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ referencedFiles: null })]));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toEqual({ status: 'skipped', reason: 'not_referenced' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('skips an already-complete index unless force is set', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ fileIndexStatus: 'complete' })]));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toEqual({ status: 'skipped', reason: 'already_complete' });
  });

  it('skips a fresh in-progress hydration (CAS 0 rows)', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    updateMock.mockReturnValueOnce(chainMock([])); // CAS matched 0 rows: lost the race
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toEqual({ status: 'skipped', reason: 'in_progress' });
  });

  it('fails not-retryable when storage_identity is NULL', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow({ storageIdentity: null })]));
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toMatchObject({ status: 'failed', failure: 'storage_identity_unknown', retryable: false });
  });

  it('fails not-retryable on storage identity drift', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    resolveSnapshotProviderConfigMock.mockResolvedValueOnce({
      snapshot: snapshotRow(), config: null, providerType: 'local', providerConfig: { path: '/different/root' },
    });
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID);
    expect(outcome).toMatchObject({ status: 'failed', failure: 'storage_identity_drift', retryable: false });
  });

  it('fails retryable when the manifest object is missing', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    const deps = { fetchManifestBytes: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' })) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_missing', retryable: true });
  });

  it('fails closed and names the bad key when a manifest entry has an unparseable backupPath', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-current/../x' }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_key_invalid', retryable: false });
    expect((outcome as { reason: string }).reason).toContain('snapshots/snap-current/../x');
  });

  it('verifies an origin against a LIVE row on the same device/identity (provenance: live)', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()])) // load snapshot
      .mockReturnValueOnce(chainMock([{ // origin live row
        id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY,
        metadata: { storagePrefix: null },
      }]));
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([
          { sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 },
          { sourcePath: '/b', backupPath: 'snapshots/snap-current/files/b.gz', size: 20 },
        ]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', entryCount: 2, externalCount: 1, originSnapshotIds: ['snap-older'] });
  });

  it('verifies an origin against a RETIREMENT record when the live row is gone (provenance: retired)', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([])) // no live row
      .mockReturnValueOnce(chainMock([{ // retirement row
        orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, snapshotId: 'snap-older',
      }]));
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'complete', externalCount: 1, originSnapshotIds: ['snap-older'] });
  });

  it('fails origin_identity_pending (retryable) when a live origin row exists but its storage_identity is NULL', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: null, metadata: {} }]))
      .mockReturnValueOnce(chainMock([])); // and no retirement either
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'origin_identity_pending', retryable: true });
  });

  it('fails origin_unverifiable (not retryable) when the only live row is under a DIFFERENT org', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([])) // the org/device-scoped live-row query returns nothing for THIS org
      .mockReturnValueOnce(chainMock([])); // and no retirement scoped to this org/device either
    const deps = {
      fetchManifestBytes: vi.fn().mockResolvedValue(
        manifestBytes([{ sourcePath: '/a', backupPath: 'snapshots/snap-older/files/a.gz', size: 10 }]),
      ),
    };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'origin_unverifiable', retryable: false });
  });

  it('writes rows in 1,000-row batches then publishes sha/counts/metadata in one final transaction', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([snapshotRow()]))
      .mockReturnValueOnce(chainMock([{ id: 'origin-db-id', orgId: ORG_ID, deviceId: DEVICE_ID, storageIdentity: STORAGE_IDENTITY, metadata: {} }]));
    const entries = Array.from({ length: 1500 }, (_, i) => ({
      sourcePath: `/f${i}`, backupPath: `snapshots/snap-older/files/f${i}.gz`, size: 1,
    }));
    const bytes = manifestBytes(entries);
    const deps = { fetchManifestBytes: vi.fn().mockResolvedValue(bytes) };

    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

    expect(outcome).toMatchObject({ status: 'complete', entryCount: 1500, externalCount: 1500 });
    expect((outcome as { manifestSha256: string }).manifestSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // 2 batches of file rows (1000 + 500) + 1 final publish transaction.
    expect(transactionMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('on any hydration failure sets status failed with the reason, leaving whatever rows already wrote untouched', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    const deps = { fetchManifestBytes: vi.fn().mockResolvedValue(Buffer.from('not json')) };
    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_invalid' });
    // `db.update(table)` is called with the table; the payload goes to `.set()`.
    // Assert the LAST update chain carried the failed status + prefixed error.
    const lastUpdateChain = updateMock.mock.results.at(-1)!.value as { set: ReturnType<typeof vi.fn> };
    expect(lastUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ fileIndexStatus: 'failed', fileIndexError: expect.stringMatching(/^manifest_invalid: /) }),
    );
    expect(outcome).toMatchObject({ retryable: false });
  });
});

describe('readSnapshotFileIndexState', () => {
  it('returns null for an unknown snapshot', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));
    expect(await readSnapshotFileIndexState('missing')).toBeNull();
  });

  it('returns the index state fields for a known snapshot', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      fileIndexStatus: 'complete', fileIndexManifestSha256: 'abc', fileIndexExternalCount: 3,
      fileIndexError: null, referencedFiles: 3, storageIdentity: STORAGE_IDENTITY,
    }]));
    const state = await readSnapshotFileIndexState(SNAPSHOT_DB_ID);
    expect(state).toMatchObject({ status: 'complete', manifestSha256: 'abc', externalCount: 3 });
  });
});
```

`apps/api/src/services/backupResultPersistence.test.ts` — add near the existing "writes file rows" coverage (`grep -n "backupSnapshotFiles\|hasIndexedFiles" apps/api/src/services/backupResultPersistence.test.ts` to find the right `describe` block):
```ts
it('skips the delete+reinsert when the snapshot already carries a complete server file index', async () => {
  // ...arrange an existing snapshot row with fileIndexStatus: 'complete'...
  await applyBackupCommandResultToJob({ /* ...result with result.snapshot.files present... */ } as any);
  expect(deleteMock).not.toHaveBeenCalledWith(expect.anything()); // or assert on the specific backupSnapshotFiles delete call
});

it('stamps fileIndexStatus=agent when it writes rows from the agent-reported index', async () => {
  // ...arrange a NEW snapshot (fileIndexStatus defaults to none) with result.snapshot.files present...
  await applyBackupCommandResultToJob({ /* ... */ } as any);
  const upserted = insertMock.mock.calls.find((c) => /* the backupSnapshots insert */)?.[0];
  expect(upserted).toMatchObject({ fileIndexStatus: 'agent' });
});

it('enqueues file-index hydration when referencedFiles > 0', async () => {
  await applyBackupCommandResultToJob({ /* ...result.referencedFiles: 40... */ } as any);
  expect(enqueueSnapshotFileIndexHydrationMock).toHaveBeenCalledWith(expect.any(String), 'result');
});

it('does not enqueue hydration when referencedFiles is NULL or 0', async () => {
  await applyBackupCommandResultToJob({ /* ...result.referencedFiles: undefined... */ } as any);
  expect(enqueueSnapshotFileIndexHydrationMock).not.toHaveBeenCalled();
});
```
(This file's existing top-of-file mocks must gain `vi.mock('../jobs/backupSnapshotFileIndexWorker', () => ({ enqueueSnapshotFileIndexHydration: enqueueSnapshotFileIndexHydrationMock }))` with `enqueueSnapshotFileIndexHydrationMock` added to the file's existing `vi.hoisted` block — match whatever hoisting pattern the file already uses for its other mocked imports.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/backupSnapshotFileIndex.test.ts src/services/backupSnapshotStorage.test.ts src/services/backupResultPersistence.test.ts`
Expected: FAIL — `backupSnapshotFileIndex.test.ts` fails to resolve `./backupSnapshotFileIndex` (module doesn't exist); `backupSnapshotStorage.test.ts` fails on `fetchBackupObjectBytes is not a function`; `backupResultPersistence.test.ts`'s four new cases fail (no guard exists yet, `enqueueSnapshotFileIndexHydrationMock` is never called, and the mocked module path `../jobs/backupSnapshotFileIndexWorker` doesn't exist yet either — acceptable, since Task 4 creates it; the test file is written now so both fail together and turn green together at the end of Task 4).

- [ ] **Step 3: Implement — `fetchBackupObjectBytes`**

Insert into `apps/api/src/services/backupSnapshotStorage.ts`, directly after `fetchLocalObjectText` (line 313) and before the `fetchBackupObjectText` JSDoc (line 315):
```ts
async function fetchS3ObjectBytes(providerConfig: Record<string, unknown>, key: string): Promise<Uint8Array> {
  const { bucket, client } = buildS3StorageClient(providerConfig);
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`Empty response body for ${key}`);
  }
  return response.Body.transformToByteArray();
}

async function fetchLocalObjectBytes(providerConfig: Record<string, unknown>, key: string): Promise<Uint8Array> {
  const rootPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath');
  if (!rootPath) {
    throw new Error('Local backup storage is misconfigured');
  }
  const normalizedKey = pathPosix.normalize(key).replace(/^\/+/, '');
  const targetPath = ensureContainedLocalPath(rootPath, normalizedKey);
  const buffer = await readFile(targetPath); // no encoding argument — raw bytes
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Byte-exact fetch of one object (used by W09 hydration, which SHA-256-hashes
 * the raw manifest bytes and must match whatever the agent actually wrote —
 * `fetchBackupObjectText`'s UTF-8 string round-trip is not guaranteed
 * byte-identical for every input). Same not-found/error semantics as
 * `fetchBackupObjectText`: throws on any failure, callers classify via
 * `isBackupObjectNotFound`.
 */
export async function fetchBackupObjectBytes(input: {
  provider: string | null | undefined;
  providerConfig: unknown;
  key: string;
}): Promise<Uint8Array> {
  const provider = input.provider ?? null;
  const providerConfig = asRecord(input.providerConfig);
  if (provider === 's3') return fetchS3ObjectBytes(providerConfig, input.key);
  if (provider === 'local') return fetchLocalObjectBytes(providerConfig, input.key);
  throw new Error(`Provider ${provider ?? 'unknown'} does not support object fetch for GC`);
}
```

- [ ] **Step 4: Implement — `backupSnapshotFileIndex.ts`**

```ts
// W09 (#6464) Task 3 — server-side, verified-complete file index for any
// snapshot whose owning job reported referenced_files > 0. Never trusts the
// agent-reported backup_snapshot_files rows (they may be entirely absent —
// the helper drops snapshot.files past a 5MB delivery budget, Part 0 §0) —
// this reads snapshots/<id>/manifest.json itself and verifies every
// referenced OLDER snapshot's provenance before marking the index complete.
// See docs/superpowers/plans/backup/_w09-part0.md §3 for the full algorithm.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  backupSnapshotFiles,
  backupSnapshotOrigins,
  backupSnapshotRetirements,
  backupSnapshots,
} from '../db/schema';
import { asRecord, getStringValue, resolveSnapshotProviderConfig } from './recoveryBootstrap';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { backupSnapshotManifestKey, fetchBackupObjectBytes, isBackupObjectNotFound } from './backupSnapshotStorage';
import { parseBackupObjectKey } from './backupObjectKey';

export type FileIndexStatus = 'none' | 'agent' | 'hydrating' | 'complete' | 'failed';

export type HydrationFailure =
  | 'storage_identity_unknown'
  | 'storage_identity_drift'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'manifest_key_invalid'
  | 'origin_unverifiable'
  | 'origin_identity_pending'
  | 'provider_error';

const HYDRATION_FAILURES: readonly HydrationFailure[] = [
  'storage_identity_unknown', 'storage_identity_drift', 'manifest_missing', 'manifest_invalid',
  'manifest_key_invalid', 'origin_unverifiable', 'origin_identity_pending', 'provider_error',
];

// Retryability is a pure function of the failure code so that the route glue
// (authenticate/exchange) and the BullMQ worker agree without a second column:
// transient storage/network conditions and "GC has not healed this identity
// yet" retry; a malformed manifest or an unprovable origin never will.
export const RETRYABLE_HYDRATION_FAILURES: ReadonlySet<HydrationFailure> = new Set<HydrationFailure>([
  'manifest_missing', 'provider_error', 'origin_identity_pending',
]);
export function isRetryableHydrationFailure(failure: HydrationFailure): boolean {
  return RETRYABLE_HYDRATION_FAILURES.has(failure);
}
export function hydrationFailureFromError(error: string | null): HydrationFailure | null {
  if (!error) return null;
  const prefix = error.split(':', 1)[0];
  return (HYDRATION_FAILURES as readonly string[]).includes(prefix) ? (prefix as HydrationFailure) : null;
}

export type HydrationOutcome =
  | { status: 'complete'; manifestSha256: string; entryCount: number; externalCount: number; originSnapshotIds: string[] }
  | { status: 'failed'; failure: HydrationFailure; reason: string; retryable: boolean }
  | { status: 'skipped'; reason: 'not_referenced' | 'already_complete' | 'in_progress' };

export type HydrationDeps = {
  fetchManifestBytes: (args: { provider: string; providerConfig: Record<string, unknown>; key: string }) => Promise<Uint8Array>;
  now?: () => Date;
};

const HYDRATING_STALE_MS = 30 * 60 * 1000;
const FILE_ROW_BATCH_SIZE = 1000;

// Same field shape as backupSnapshotReconcile.ts's private reconcileManifestSchema
// (lines 258-281) — duplicated deliberately (see Task 3 Interfaces note above)
// plus a refine that the manifest actually belongs to the snapshot being
// hydrated (defense against a corrupted/swapped object at the expected key).
const hydrationManifestSchema = z
  .object({
    id: z.string().min(1),
    timestamp: z.string().optional(),
    size: z.number().nonnegative().optional(),
    formatVersion: z.number().optional(),
    baseSnapshotId: z.string().optional(),
    files: z
      .array(
        z
          .object({
            sourcePath: z.string().min(1),
            originalPath: z.string().min(1).optional(),
            backupPath: z.string().min(1),
            size: z.number().nonnegative().optional(),
            modTime: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

function defaultDeps(): HydrationDeps {
  return {
    fetchManifestBytes: (args) => fetchBackupObjectBytes(args),
  };
}

async function loadSnapshotForHydration(snapshotDbId: string) {
  const [row] = await db
    .select({
      id: backupSnapshots.id,
      orgId: backupSnapshots.orgId,
      deviceId: backupSnapshots.deviceId,
      snapshotId: backupSnapshots.snapshotId,
      storageIdentity: backupSnapshots.storageIdentity,
      jobId: backupSnapshots.jobId, // consumed by loadReferencedFiles below — without it hydration is a permanent no-op (review finding, 2026-09-20)
      fileIndexStatus: backupSnapshots.fileIndexStatus,
      fileIndexHydratedAt: backupSnapshots.fileIndexHydratedAt,
    })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);
  return row ?? null;
}

async function loadReferencedFiles(snapshotDbId: string, jobId: string | null | undefined): Promise<number | null> {
  if (!jobId) return null;
  const { backupJobs } = await import('../db/schema');
  const [job] = await db.select({ referencedFiles: backupJobs.referencedFiles }).from(backupJobs).where(eq(backupJobs.id, jobId)).limit(1);
  return job?.referencedFiles ?? null;
}

async function fail(
  snapshotDbId: string,
  failure: HydrationFailure,
  reason: string,
): Promise<HydrationOutcome> {
  await db
    .update(backupSnapshots)
    .set({ fileIndexStatus: 'failed', fileIndexError: `${failure}: ${reason}` })
    .where(eq(backupSnapshots.id, snapshotDbId));
  return { status: 'failed', failure, reason, retryable: isRetryableHydrationFailure(failure) };
}

export async function hydrateSnapshotFileIndex(
  snapshotDbId: string,
  opts?: { force?: boolean; deps?: HydrationDeps },
): Promise<HydrationOutcome> {
  const deps = opts?.deps ?? defaultDeps();
  const now = deps.now?.() ?? new Date();

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const snapshot = await loadSnapshotForHydration(snapshotDbId);
      if (!snapshot) {
        return { status: 'failed', failure: 'manifest_missing', reason: 'snapshot not found', retryable: false } as const;
      }

      const referencedFiles = await loadReferencedFiles(snapshotDbId, snapshot.jobId);

      if ((referencedFiles ?? 0) === 0) {
        return { status: 'skipped', reason: 'not_referenced' } as const;
      }
      if (snapshot.fileIndexStatus === 'complete' && !opts?.force) {
        return { status: 'skipped', reason: 'already_complete' } as const;
      }
      if (
        snapshot.fileIndexStatus === 'hydrating' &&
        snapshot.fileIndexHydratedAt &&
        now.getTime() - snapshot.fileIndexHydratedAt.getTime() < HYDRATING_STALE_MS
      ) {
        return { status: 'skipped', reason: 'in_progress' } as const;
      }

      // CAS to 'hydrating' — 0 rows means a concurrent caller won the race.
      const [claimed] = await db
        .update(backupSnapshots)
        .set({ fileIndexStatus: 'hydrating', fileIndexHydratedAt: now })
        .where(and(eq(backupSnapshots.id, snapshotDbId), ne(backupSnapshots.fileIndexStatus, 'hydrating')))
        .returning({ id: backupSnapshots.id });
      if (!claimed) {
        return { status: 'skipped', reason: 'in_progress' } as const;
      }

      const resolved = await resolveSnapshotProviderConfig(snapshotDbId);
      const providerType = resolved?.providerType ?? null;
      const providerConfig = asRecord(resolved?.providerConfig);
      if (!snapshot.storageIdentity) {
        return fail(snapshotDbId, 'storage_identity_unknown', 'snapshot has no pinned storage identity');
      }
      if (!providerType) {
        return fail(snapshotDbId, 'storage_identity_unknown', 'could not resolve a provider for this snapshot');
      }
      const resolvedIdentity = normalizeStorageIdentity(providerType, providerConfig);
      if (resolvedIdentity !== snapshot.storageIdentity) {
        return fail(snapshotDbId, 'storage_identity_drift', `resolved identity ${resolvedIdentity} does not match pinned ${snapshot.storageIdentity}`);
      }

      let bytes: Uint8Array;
      try {
        bytes = await deps.fetchManifestBytes({
          provider: providerType,
          providerConfig,
          key: backupSnapshotManifestKey(snapshot.snapshotId),
        });
      } catch (err) {
        if (isBackupObjectNotFound(err)) {
          return fail(snapshotDbId, 'manifest_missing', 'manifest object not found in storage');
        }
        return fail(snapshotDbId, 'provider_error', err instanceof Error ? err.message : String(err), true);
      }

      const manifestSha256 = createHash('sha256').update(bytes).digest('hex');

      let parsed: z.infer<typeof hydrationManifestSchema>;
      try {
        const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
        parsed = hydrationManifestSchema.parse(json);
        if (parsed.id !== snapshot.snapshotId) {
          throw new Error(`manifest id ${parsed.id} does not match snapshot ${snapshot.snapshotId}`);
        }
      } catch (err) {
        return fail(snapshotDbId, 'manifest_invalid', err instanceof Error ? err.message : String(err), false);
      }

      const files = parsed.files ?? [];
      const ownPrefix = `snapshots/${snapshot.snapshotId}/`;
      const originCounts = new Map<string, number>();
      const fileRows: Array<{ snapshotDbId: string; sourcePath: string; backupPath: string; size: number | null; modifiedAt: Date | null }> = [];

      for (const file of files) {
        if (!file.backupPath) continue;
        const parsedKey = parseBackupObjectKey(file.backupPath);
        if (!parsedKey) {
          return fail(snapshotDbId, 'manifest_key_invalid', `unparseable backupPath: ${file.backupPath}`);
        }
        if (!file.backupPath.startsWith(ownPrefix)) {
          originCounts.set(parsedKey.snapshotId, (originCounts.get(parsedKey.snapshotId) ?? 0) + 1);
        }
        fileRows.push({
          snapshotDbId,
          sourcePath: file.originalPath ?? file.sourcePath,
          backupPath: file.backupPath,
          size: file.size ?? null,
          modifiedAt: file.modTime ? new Date(file.modTime) : null,
        });
      }

      type OriginRow = {
        originSnapshotId: string; originOrgId: string; originDeviceId: string;
        originStorageIdentity: string; originStoragePrefix: string | null; provenance: 'live' | 'retired'; objectCount: number;
      };
      const originRows: OriginRow[] = [];
      for (const [originId, objectCount] of originCounts) {
        const [live] = await db
          .select({ id: backupSnapshots.id, orgId: backupSnapshots.orgId, deviceId: backupSnapshots.deviceId, storageIdentity: backupSnapshots.storageIdentity, metadata: backupSnapshots.metadata })
          .from(backupSnapshots)
          .where(and(eq(backupSnapshots.snapshotId, originId), eq(backupSnapshots.orgId, snapshot.orgId), eq(backupSnapshots.deviceId, snapshot.deviceId)))
          .limit(1);
        if (live && live.storageIdentity === snapshot.storageIdentity) {
          originRows.push({
            originSnapshotId: originId, originOrgId: snapshot.orgId, originDeviceId: snapshot.deviceId,
            originStorageIdentity: snapshot.storageIdentity, originStoragePrefix: getStringValue(asRecord(live.metadata), 'storagePrefix'),
            provenance: 'live', objectCount,
          });
          continue;
        }
        const [retired] = await db
          .select({ orgId: backupSnapshotRetirements.orgId, deviceId: backupSnapshotRetirements.deviceId, storageIdentity: backupSnapshotRetirements.storageIdentity })
          .from(backupSnapshotRetirements)
          .where(and(eq(backupSnapshotRetirements.snapshotId, originId), eq(backupSnapshotRetirements.storageIdentity, snapshot.storageIdentity), eq(backupSnapshotRetirements.orgId, snapshot.orgId), eq(backupSnapshotRetirements.deviceId, snapshot.deviceId)))
          .limit(1);
        if (retired) {
          originRows.push({
            originSnapshotId: originId, originOrgId: snapshot.orgId, originDeviceId: snapshot.deviceId,
            originStorageIdentity: snapshot.storageIdentity, originStoragePrefix: null, provenance: 'retired', objectCount,
          });
          continue;
        }
        // A live row existed on this device but with a NULL/mismatched
        // identity (GC heals this eventually) is origin_identity_pending
        // (retryable); genuinely no record anywhere for this org/device is
        // origin_unverifiable (terminal).
        if (live && !live.storageIdentity) {
          return fail(snapshotDbId, 'origin_identity_pending', `origin ${originId}: live snapshot row has no storage identity yet (GC heals it on its next listing)`);
        }
        return fail(snapshotDbId, 'origin_unverifiable', `origin ${originId}: no live snapshot or retirement record for this device/destination`);
      }

      // Write file rows in 1,000-row batches, each its own transaction —
      // storage I/O already happened above, outside any DB transaction.
      // The delete rides in the SAME transaction as the first insert batch so a
      // crash between them cannot leave a snapshot with zero rows; every later
      // batch is its own short transaction. Status stays 'hydrating' until the
      // final publish, so partial rows are never read as an index.
      for (let i = 0; i < Math.max(fileRows.length, 1); i += FILE_ROW_BATCH_SIZE) {
        const batch = fileRows.slice(i, i + FILE_ROW_BATCH_SIZE);
        await db.transaction(async (tx) => {
          if (i === 0) {
            await tx.delete(backupSnapshotFiles).where(eq(backupSnapshotFiles.snapshotDbId, snapshotDbId));
          }
          if (batch.length > 0) {
            await tx.insert(backupSnapshotFiles).values(batch);
          }
        });
      }

      const externalCount = [...originCounts.values()].reduce((a, b) => a + b, 0);
      await db.transaction(async (tx) => {
        await tx.delete(backupSnapshotOrigins).where(eq(backupSnapshotOrigins.snapshotDbId, snapshotDbId));
        if (originRows.length > 0) {
          await tx.insert(backupSnapshotOrigins).values(originRows.map((o) => ({ snapshotDbId, ...o })));
        }
        const [current] = await tx.select({ metadata: backupSnapshots.metadata }).from(backupSnapshots).where(eq(backupSnapshots.id, snapshotDbId)).limit(1);
        await tx
          .update(backupSnapshots)
          .set({
            fileIndexStatus: 'complete',
            fileIndexManifestSha256: manifestSha256,
            fileIndexHydratedAt: new Date(),
            fileIndexExternalCount: externalCount,
            fileIndexError: null,
            metadata: { ...asRecord(current?.metadata), hasIndexedFiles: true, fileIndexVersion: 2 },
          })
          .where(eq(backupSnapshots.id, snapshotDbId));
      });

      return {
        status: 'complete',
        manifestSha256,
        entryCount: fileRows.length,
        externalCount,
        originSnapshotIds: [...originCounts.keys()],
      };
    }),
  );
}

export async function readSnapshotFileIndexState(snapshotDbId: string): Promise<{
  status: FileIndexStatus;
  manifestSha256: string | null;
  externalCount: number | null;
  originSnapshotIds: string[];
  error: string | null;
  retryable: boolean;
  referencedFiles: number | null;
  storageIdentity: string | null;
} | null> {
  const [row] = await db
    .select({
      status: backupSnapshots.fileIndexStatus,
      manifestSha256: backupSnapshots.fileIndexManifestSha256,
      externalCount: backupSnapshots.fileIndexExternalCount,
      error: backupSnapshots.fileIndexError,
      jobId: backupSnapshots.jobId,
      storageIdentity: backupSnapshots.storageIdentity,
    })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);
  if (!row) return null;
  const referencedFiles = await loadReferencedFiles(snapshotDbId, row.jobId);
  const status = row.status as FileIndexStatus;
  const originSnapshotIds =
    status === 'complete'
      ? (
          await db
            .select({ originSnapshotId: backupSnapshotOrigins.originSnapshotId })
            .from(backupSnapshotOrigins)
            .where(eq(backupSnapshotOrigins.snapshotDbId, snapshotDbId))
            .orderBy(backupSnapshotOrigins.originSnapshotId)
        ).map((o) => o.originSnapshotId)
      : [];
  const failure = hydrationFailureFromError(row.error);
  return {
    status,
    manifestSha256: row.manifestSha256,
    externalCount: row.externalCount,
    originSnapshotIds,
    error: row.error,
    retryable: failure ? isRetryableHydrationFailure(failure) : false,
    referencedFiles,
    storageIdentity: row.storageIdentity,
  };
}
```
Note: `loadReferencedFiles` does a dynamic `import('../db/schema')` for `backupJobs` to sidestep a circular-import risk between `backupSnapshotFileIndex.ts` and the schema barrel if one already exists for this module's other imports — check `grep -n "^import" apps/api/src/services/backupSnapshotFileIndex.ts` after writing; if `backupJobs` can be imported statically alongside the other schema symbols with no cycle (most services do this), replace the dynamic import with a static one in the top import block for consistency with the rest of the codebase.

- [ ] **Step 5: Implement — `backupResultPersistence.ts` guard + enqueue**

Replace the file-rows block at lines 1381-1412 (`if (snapshot && result.snapshot?.files) { ... }`):
```ts
  if (snapshot && result.snapshot?.files && snapshot.fileIndexStatus !== 'complete') {
    // W09 (#6464): once the server has hydrated a verified-complete index
    // (fileIndexStatus === 'complete'), that index is authoritative and this
    // delete+reinsert of the agent-reported rows must NOT run — it would
    // silently downgrade a verified index back to an unverified one on the
    // next ordinary backup run's result post for the SAME snapshot
    // (re-adoption / reconcile can revisit an already-hydrated row).
    await db
      .delete(backupSnapshotFiles)
      .where(eq(backupSnapshotFiles.snapshotDbId, snapshot.id));

    if (result.snapshot.files.length > 0) {
      const BATCH_SIZE = 1000;
      const fileRows = result.snapshot.files.map((file) => ({
        snapshotDbId: snapshot.id,
        sourcePath: file.originalPath ?? file.sourcePath,
        backupPath: file.backupPath ?? '',
        size: file.size ?? null,
        modifiedAt: file.modTime ? new Date(file.modTime) : null,
      }));

      for (let i = 0; i < fileRows.length; i += BATCH_SIZE) {
        await db.insert(backupSnapshotFiles).values(fileRows.slice(i, i + BATCH_SIZE));
      }

      // Rows just came from the AGENT-reported index, not server hydration —
      // mark that explicitly rather than leaving 'none' (which would read as
      // "never assessed" even though rows now exist).
      await db.update(backupSnapshots).set({ fileIndexStatus: 'agent' }).where(eq(backupSnapshots.id, snapshot.id));
    }
  }

  if (snapshot && result.referencedFiles !== undefined && result.referencedFiles > 0) {
    // W09 (#6464): a snapshot with references needs a server-verified index
    // before ANY token-mode recovery can be authorized against it — enqueue
    // hydration now so it's usually already 'complete' by the time an
    // operator creates a recovery. Enqueue is dedupe-keyed by snapshot id
    // (Task 4), so a re-adoption/reconcile re-posting the same result is safe
    // to call again.
    const { enqueueSnapshotFileIndexHydration } = await import('../jobs/backupSnapshotFileIndexWorker');
    await enqueueSnapshotFileIndexHydration(snapshot.id, 'result');
  }
```
(The dynamic `import('../jobs/backupSnapshotFileIndexWorker')` avoids a hard top-of-file dependency from a hot result-persistence path onto a BullMQ queue module purely for this one branch — mirrors how other job-enqueue call sites in this codebase that are reached rarely, e.g. `enqueueRecoveryMediaBuild`'s callers, are typically imported statically instead; if `grep -n "^import.*jobs/" apps/api/src/services/backupResultPersistence.ts` shows this file already statically imports sibling job modules elsewhere, prefer a static top-of-file `import { enqueueSnapshotFileIndexHydration } from '../jobs/backupSnapshotFileIndexWorker';` for consistency and drop the dynamic import.)

- [ ] **Step 6: Run**

Run: `cd apps/api && npx vitest run src/services/backupSnapshotFileIndex.test.ts src/services/backupSnapshotStorage.test.ts src/services/backupResultPersistence.test.ts`
Expected: PASS.

Run: `cd apps/api && npx tsc --noEmit -p apps/api`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/backupSnapshotStorage.ts apps/api/src/services/backupSnapshotFileIndex.ts apps/api/src/services/backupSnapshotFileIndex.test.ts apps/api/src/services/backupSnapshotStorage.test.ts apps/api/src/services/backupResultPersistence.ts apps/api/src/services/backupResultPersistence.test.ts
git commit -m "feat(backup): server-side snapshot file-index hydration from the stored manifest, verifying every referenced origin's provenance (W09a Task 3)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 4: Hydration job worker + enqueue

**Files:**
- Create: `apps/api/src/jobs/backupSnapshotFileIndexWorker.ts`
- Modify: `apps/api/src/services/workerRegistry.ts` (add an entry next to the `backupWorker` entry at lines 914-920, same `placement: 'global'`)
- Test: `apps/api/src/jobs/backupSnapshotFileIndexWorker.test.ts`

**Interfaces (Produces):**
```ts
export function enqueueSnapshotFileIndexHydration(
  snapshotDbId: string,
  reason: 'result' | 'recovery_create' | 'authenticate' | 'exchange' | 'manual',
): Promise<string>; // returns the BullMQ job id
export function initializeBackupSnapshotFileIndexWorker(): Promise<void>;
export function shutdownBackupSnapshotFileIndexWorker(): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/jobs/backupSnapshotFileIndexWorker.test.ts` (BullMQ mock pattern copied from `apps/api/src/jobs/recoveryMediaWorker.test.ts` — run `grep -n "vi.mock('bullmq'" apps/api/src/jobs/recoveryMediaWorker.test.ts` first and reuse the exact same fake `Queue`/`Worker`/`UnrecoverableError` shape; if that file doesn't mock BullMQ at the module level and instead relies on a shared test Redis, mirror whichever pattern `recoveryMediaWorker.test.ts` actually uses instead of inventing a third one):
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, hydrateMock, withSystemDbAccessContextMock } = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'job-1' })),
  getJobMock: vi.fn(async () => null),
  hydrateMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => any) => fn()),
}));

class FakeQueue {
  add = addMock;
  getJob = getJobMock;
}
class FakeUnrecoverableError extends Error {}

vi.mock('bullmq', () => ({
  Queue: FakeQueue,
  Worker: class FakeWorker { constructor(public name: string, public processor: any) {} on() {} close = vi.fn(); },
  UnrecoverableError: FakeUnrecoverableError,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../db', () => ({ withSystemDbAccessContext: withSystemDbAccessContextMock }));
vi.mock('../services/backupSnapshotFileIndex', () => ({ hydrateSnapshotFileIndex: hydrateMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import {
  enqueueSnapshotFileIndexHydration,
  initializeBackupSnapshotFileIndexWorker,
} from './backupSnapshotFileIndexWorker';

beforeEach(() => vi.clearAllMocks());

describe('enqueueSnapshotFileIndexHydration', () => {
  it('enqueues with a stable, snapshot-scoped jobId for BullMQ dedupe', async () => {
    await enqueueSnapshotFileIndexHydration('snap-db-1', 'result');
    expect(addMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ snapshotDbId: 'snap-db-1', reason: 'result' }),
      expect.objectContaining({ jobId: 'hydrate:snap-db-1', attempts: 3 }),
    );
  });

  it('does not add a second job when one is already active for the same snapshot', async () => {
    getJobMock.mockResolvedValueOnce({ id: 'existing', getState: async () => 'active' });
    await enqueueSnapshotFileIndexHydration('snap-db-1', 'exchange');
    // BullMQ's own jobId dedupe covers this at the queue level, but the
    // wrapper must not add a SECOND distinct job under a different id either.
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0][2]).toMatchObject({ jobId: 'hydrate:snap-db-1' });
  });
});

describe('worker processor', () => {
  it('a non-retryable failed outcome completes the job (no BullMQ retry)', async () => {
    hydrateMock.mockResolvedValueOnce({ status: 'failed', failure: 'manifest_invalid', reason: 'bad json', retryable: false });
    await initializeBackupSnapshotFileIndexWorker();
    // ...invoke the captured processor with a fake Job { data: { snapshotDbId: 'x' } }...
    // ...assert it resolves (does not throw) and withSystemDbAccessContext wrapped the call...
  });

  it('a retryable failed outcome throws so BullMQ retries', async () => {
    hydrateMock.mockResolvedValueOnce({ status: 'failed', failure: 'manifest_missing', reason: 'not found yet', retryable: true });
    // ...invoke the processor, assert it rejects...
  });

  it('a complete or skipped outcome completes the job', async () => {
    hydrateMock.mockResolvedValueOnce({ status: 'complete', manifestSha256: 'x', entryCount: 1, externalCount: 1, originSnapshotIds: [] });
    // ...invoke the processor, assert it resolves...
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/jobs/backupSnapshotFileIndexWorker.test.ts`
Expected: FAIL — module `./backupSnapshotFileIndexWorker` does not exist.

- [ ] **Step 3: Implement**

```ts
// W09 (#6464) Task 4 — BullMQ worker that runs hydrateSnapshotFileIndex
// (services/backupSnapshotFileIndex.ts) out of band. Enqueued from three
// places: a backup result with referencedFiles > 0
// (backupResultPersistence.ts), a bare-metal recovery creation preflight
// (bareMetalRecoveryService.ts, Task 5), and the exchange/authenticate
// negotiation's 'pending' branch (recoveryCapabilities.ts route glue, Task
// 5). jobId is snapshot-scoped so BullMQ's own dedupe collapses concurrent
// enqueues for the same snapshot into one job. Pattern mirrors
// jobs/recoveryMediaWorker.ts (stable jobId, UnrecoverableError for
// non-retryable failures).
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { withSystemDbAccessContext } from '../db';
import { hydrateSnapshotFileIndex } from '../services/backupSnapshotFileIndex';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'backup-snapshot-file-index';
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
};

type HydrationJobData = {
  snapshotDbId: string;
  reason: 'result' | 'recovery_create' | 'authenticate' | 'exchange' | 'manual';
};

let queue: Queue<HydrationJobData> | null = null;
let worker: Worker<HydrationJobData> | null = null;

function getQueue(): Queue<HydrationJobData> {
  if (!queue) {
    queue = new Queue<HydrationJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return queue;
}

export async function enqueueSnapshotFileIndexHydration(
  snapshotDbId: string,
  reason: HydrationJobData['reason'],
): Promise<string> {
  const q = getQueue();
  const jobId = `hydrate:${snapshotDbId}`;
  const job = await q.add('hydrate', { snapshotDbId, reason }, { jobId, ...JOB_OPTIONS });
  return job.id!;
}

async function processHydrationJob(job: Job<HydrationJobData>): Promise<{ status: string }> {
  const outcome = await withSystemDbAccessContext(() => hydrateSnapshotFileIndex(job.data.snapshotDbId));
  if (outcome.status === 'failed' && !outcome.retryable) {
    // A non-retryable failure (bad manifest, unverifiable provenance, drifted
    // storage identity) will never succeed on retry — completing the job
    // (rather than throwing) stops BullMQ from burning three attempts on a
    // deterministic failure. The snapshot's own file_index_status/_error
    // columns are the permanent record; nothing here needs a job-level retry.
    return { status: 'failed-terminal' };
  }
  if (outcome.status === 'failed' && outcome.retryable) {
    throw new Error(`snapshot file-index hydration failed (retryable): ${outcome.failure}: ${outcome.reason}`);
  }
  return { status: outcome.status };
}

function createWorker(): Worker<HydrationJobData> {
  return new Worker<HydrationJobData>(QUEUE_NAME, processHydrationJob, {
    connection: getBullMQConnection(),
    concurrency: 2,
  });
}

export async function initializeBackupSnapshotFileIndexWorker(): Promise<void> {
  worker = createWorker();
  attachWorkerObservability(worker, 'backupSnapshotFileIndexWorker');
  worker.on('error', (error) => {
    console.error('[BackupSnapshotFileIndexWorker] Worker error:', error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[BackupSnapshotFileIndexWorker] Job ${job?.id} failed:`, error);
  });
  console.log('[BackupSnapshotFileIndexWorker] Worker initialized');
}

export async function shutdownBackupSnapshotFileIndexWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
```
(`UnrecoverableError` is imported but unused above in favor of a plain terminal return for the non-retryable branch — BullMQ treats a resolved processor as success regardless of the returned payload's shape, so there's no need to throw `UnrecoverableError` at all for "don't retry, but also don't mark this job failed in the UI as if it were an infra fault." If code review prefers the job to show as `failed` in BullMQ's own bookkeeping for a non-retryable HYDRATION failure — arguably more honest, since the hydration DID fail — throw `new UnrecoverableError(...)` instead of returning `{status:'failed-terminal'}`; either choice satisfies "a `failed` outcome with `retryable: false` completes the job (no retry)" from the stub, since `UnrecoverableError` also short-circuits BullMQ's attempt loop. This implementation picks the resolve-not-throw form; flag the alternative in the PR description as a deliberate, reversible choice.)

Add to `apps/api/src/services/workerRegistry.ts`, directly after the `backupWorker` entry (currently lines 914-920):
```ts
  {
    name: 'backupSnapshotFileIndexWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/backupSnapshotFileIndexWorker');
      return { init: m.initializeBackupSnapshotFileIndexWorker, shutdown: m.shutdownBackupSnapshotFileIndexWorker };
    },
  },
```

- [ ] **Step 4: Run**

Run: `cd apps/api && npx vitest run src/jobs/backupSnapshotFileIndexWorker.test.ts`
Expected: PASS.

Run: `cd apps/api && npx vitest run src/services/workerRegistry.test.ts` (only if this file enumerates every registered worker by name/placement — check with `grep -n "backupWorker\|placement" apps/api/src/services/workerRegistry.test.ts`; if it does, it will need the new name added to whatever fixed list it asserts against)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/backupSnapshotFileIndexWorker.ts apps/api/src/jobs/backupSnapshotFileIndexWorker.test.ts apps/api/src/services/workerRegistry.ts
git commit -m "feat(backup): BullMQ worker + snapshot-scoped dedupe enqueue for server-side file-index hydration (W09a Task 4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 5: Capability negotiation at authenticate/exchange + creation preflight

**Files:**
- Create: `apps/api/src/services/recoveryCapabilities.ts`
- Modify: `apps/api/src/routes/backup/schemas.ts` (`bmrAuthenticateSchema` at line 292, `bmrExchangeSchema` at line 321 — both gain `capabilities`)
- Modify: `apps/api/src/services/recoveryBootstrap.ts` (`buildRecoveryDownloadDescriptor` at lines 85-109 gains a `capabilities: string[]` arg/field; `buildAuthenticatedBootstrapPayload` at lines 408-467 gains `grantedCapabilities`/`fileIndex` args threaded into `bootstrap.download.capabilities`/`bootstrap.snapshot.fileIndex`)
- Modify: `apps/api/src/routes/backup/bmr.ts` (authenticate handler, lines 971-1224: call `negotiateRecoveryCapabilities` inside `runInRecoveryOrgContext` BEFORE the status-flip `db.update(recoveryTokens)` at lines 1152-1158; `POST /bmr/tokens`, lines 429-520ish: replace the `externalReferenceRefusal` call with `externalReferencePreflight`)
- Modify: `apps/api/src/routes/backup/bmrRecoveries.ts` (exchange route, lines 390-534: negotiate after the code-validity guard at lines 421-432 and BEFORE the code-claiming transaction at lines 452-495; create route, lines 112-153: response gains `fileIndex: { status }`)
- Modify: `apps/api/src/services/bareMetalRecoveryService.ts` (`externalReferenceRefusal` at lines 116-130 → `externalReferencePreflight`, called from `createBareMetalRecovery` at line 168)
- Test: `apps/api/src/services/recoveryCapabilities.test.ts`, `apps/api/src/routes/backup/bmr.test.ts`, `apps/api/src/routes/backup/bmrRecoveries.test.ts`, `apps/api/src/services/bareMetalRecoveryService.test.ts` (rewrite the two `externalReferenceRefusal` tests at lines 86-96 and the `it.each` at lines 102-109), `apps/api/src/services/recoveryBootstrap.test.ts`

**Interfaces (Produces):**
```ts
export type NegotiationInput = {
  clientCapabilities: readonly string[] | undefined;
  previouslyNegotiated: readonly string[] | null;
  referencedFiles: number | null;
  storageIdentity: string | null;
  resolvedProviderIdentity: string | null;
  fileIndex: {
    status: FileIndexStatus;
    manifestSha256: string | null;
    externalCount: number | null;
    originSnapshotIds: string[];
    error: string | null;
    retryable: boolean;
  };
};
export type NegotiationResult =
  | { ok: true; granted: string[]; fileIndex: { status: 'complete'; manifestSha256: string; externalCount: number; originSnapshotIds: string[] } | null; enqueueHydration: boolean }
  | {
      ok: false; status: 409;
      error: 'client_capability_required' | 'capability_downgrade' | 'snapshot_storage_identity_unknown'
        | 'storage_identity_drift' | 'snapshot_index_pending' | 'snapshot_index_failed';
      message: string; retryAfterSeconds?: number; details?: Record<string, unknown>; enqueueHydration: boolean;
    };
export function negotiateRecoveryCapabilities(input: NegotiationInput): NegotiationResult;
export const RECOVERY_REFUSAL_MESSAGES: Record<NegotiationResult['error'], string>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/recoveryCapabilities.test.ts` (pure function — no mocks needed):
```ts
import { describe, expect, it } from 'vitest';
import { BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY } from './backupObjectKey';
import { negotiateRecoveryCapabilities, RECOVERY_REFUSAL_MESSAGES } from './recoveryCapabilities';

const CAP = BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY;
const completeFileIndex = { status: 'complete' as const, manifestSha256: 'a'.repeat(64), externalCount: 3, originSnapshotIds: ['older'], error: null, retryable: false };
const noneFileIndex = { status: 'none' as const, manifestSha256: null, externalCount: null, originSnapshotIds: [], error: null, retryable: false };

function base(overrides: Partial<Parameters<typeof negotiateRecoveryCapabilities>[0]> = {}) {
  return {
    clientCapabilities: undefined,
    previouslyNegotiated: null,
    referencedFiles: null,
    storageIdentity: 's3::endpoint::bucket',
    resolvedProviderIdentity: 's3::endpoint::bucket',
    fileIndex: noneFileIndex,
    ...overrides,
  };
}

describe('negotiateRecoveryCapabilities', () => {
  it('R1: self-contained snapshot grants regardless of client capabilities, no fileIndex', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: null }));
    expect(result).toMatchObject({ ok: true, granted: [], fileIndex: null, enqueueHydration: false });
  });

  it('R1: self-contained snapshot with referencedFiles=0 behaves identically to null', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 0, clientCapabilities: [CAP] }));
    expect(result).toMatchObject({ ok: true, granted: [CAP], fileIndex: null });
  });

  it('R2: referenced snapshot, legacy client (no capabilities array) is refused client_capability_required', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: undefined, fileIndex: completeFileIndex }));
    expect(result).toMatchObject({ ok: false, status: 409, error: 'client_capability_required' });
  });

  it('R2: referenced snapshot, client sends capabilities but not the membership one, is also refused', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: ['some-other-cap'], fileIndex: completeFileIndex }));
    expect(result).toMatchObject({ ok: false, error: 'client_capability_required' });
  });

  it('R3: referenced snapshot, index none/agent enqueues hydration and returns snapshot_index_pending', () => {
    for (const status of ['none', 'agent'] as const) {
      const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: [CAP], fileIndex: { ...noneFileIndex, status } }));
      expect(result).toMatchObject({ ok: false, error: 'snapshot_index_pending', retryAfterSeconds: 30, enqueueHydration: true });
    }
  });

  it('R3: index hydrating also returns snapshot_index_pending but does not re-enqueue', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: [CAP], fileIndex: { ...noneFileIndex, status: 'hydrating' } }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_index_pending', enqueueHydration: false });
  });

  it('a retryable failed index re-enqueues and reports snapshot_index_failed', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 5, clientCapabilities: [CAP],
      fileIndex: { ...noneFileIndex, status: 'failed', error: 'manifest fetch timed out', retryable: true },
    }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_index_failed', enqueueHydration: true });
    expect((result as any).message).toContain('manifest fetch timed out');
  });

  it('a NON-retryable failed index reports snapshot_index_failed without re-enqueueing', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 5, clientCapabilities: [CAP],
      fileIndex: { ...noneFileIndex, status: 'failed', error: 'manifest id mismatch', retryable: false },
    }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_index_failed', enqueueHydration: false });
  });

  it('R4: referenced snapshot, complete index, capability present — grants and returns fileIndex', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: [CAP], fileIndex: completeFileIndex }));
    expect(result).toMatchObject({
      ok: true, granted: [CAP], enqueueHydration: false,
      fileIndex: { status: 'complete', manifestSha256: completeFileIndex.manifestSha256, externalCount: 3, originSnapshotIds: ['older'] },
    });
  });

  it('R5: re-authenticate without the capability on a token that already negotiated it is a downgrade', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 5, previouslyNegotiated: [CAP], clientCapabilities: undefined, fileIndex: completeFileIndex,
    }));
    expect(result).toMatchObject({ ok: false, error: 'capability_downgrade' });
  });

  it('R10: storage_identity NULL on the snapshot is refused before the index is even consulted', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: [CAP], storageIdentity: null, fileIndex: completeFileIndex }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_storage_identity_unknown' });
  });

  it('R11: resolved provider identity drifted from the pinned identity is refused', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 5, clientCapabilities: [CAP], storageIdentity: 's3::e::old-bucket',
      resolvedProviderIdentity: 's3::e::new-bucket', fileIndex: completeFileIndex,
    }));
    expect(result).toMatchObject({ ok: false, error: 'storage_identity_drift' });
  });

  it('unknown client capability strings are ignored, not rejected — forward compatibility', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: null, clientCapabilities: [CAP, 'future-cap-v2'] }));
    expect(result).toMatchObject({ ok: true, granted: [CAP] });
  });

  it('RECOVERY_REFUSAL_MESSAGES has the exact copy for every error code', () => {
    expect(RECOVERY_REFUSAL_MESSAGES.client_capability_required).toContain('too old to read them');
    expect(RECOVERY_REFUSAL_MESSAGES.capability_downgrade).toContain('cannot continue without it');
    expect(RECOVERY_REFUSAL_MESSAGES.snapshot_storage_identity_unknown).toContain('Wait for the next retention run');
    expect(RECOVERY_REFUSAL_MESSAGES.storage_identity_drift).toContain('backup destination');
    expect(RECOVERY_REFUSAL_MESSAGES.snapshot_index_pending).toContain('preparing the file index');
    expect(RECOVERY_REFUSAL_MESSAGES.snapshot_index_failed).toContain('could not verify this snapshot');
  });
});
```

`apps/api/src/routes/backup/bmr.test.ts` additions (find the existing authenticate `describe` block — lines around 448/568 per Part 0's ground truth — and add):
```ts
it('authenticate: legacy client (no capabilities) on a referenced snapshot is refused before the status flips', async () => {
  // ...arrange a token row + snapshot with a job.referencedFiles = 5, fileIndexStatus complete...
  const res = await app.request('/bmr/recover/authenticate', { method: 'POST', body: JSON.stringify({ token: TOKEN }) /* no capabilities */ });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('client_capability_required');
  expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'authenticated' })); // status never flipped
});

it('authenticate: capable client on a complete index is granted and bootstrap.download.capabilities/bootstrap.snapshot.fileIndex are populated', async () => {
  const res = await app.request('/bmr/recover/authenticate', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, capabilities: ['snapshot-file-membership-v1'] }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.bootstrap.download.capabilities).toEqual(['snapshot-file-membership-v1']);
  expect(body.bootstrap.snapshot.fileIndex.status).toBe('complete');
});

it('POST /bmr/tokens bare_metal: referenced snapshot with a known storage identity enqueues hydration and succeeds (replaces the #6469 hard refusal)', async () => {
  // ...arrange snapshot.referencedFiles = 12, storageIdentity present...
  const res = await app.request('/bmr/tokens', { method: 'POST', body: JSON.stringify({ snapshotId: SNAPSHOT_ID, restoreType: 'bare_metal' }) });
  expect(res.status).toBe(201); // no longer 409 — creation succeeds, hydration is enqueued in the background
  expect(enqueueSnapshotFileIndexHydrationMock).toHaveBeenCalledWith(SNAPSHOT_ID, 'recovery_create');
});

it('POST /bmr/tokens bare_metal: referenced snapshot with UNKNOWN storage identity is still refused at creation (409 snapshot_storage_identity_unknown)', async () => {
  // ...arrange snapshot.referencedFiles = 12, storageIdentity = null...
  const res = await app.request('/bmr/tokens', { method: 'POST', body: JSON.stringify({ snapshotId: SNAPSHOT_ID, restoreType: 'bare_metal' }) });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('snapshot_storage_identity_unknown');
});
```

`apps/api/src/routes/backup/bmrRecoveries.test.ts` additions (near the existing exchange coverage — lines around 374/519 per Part 0's ground truth):
```ts
it('exchange R2: referenced snapshot, legacy client — 409, code NOT consumed, no token row inserted', async () => {
  // ...arrange rec.status='created', snapshot job.referencedFiles=8, fileIndexStatus complete...
  const res = await app.request('/bmr/recover/exchange', { method: 'POST', body: JSON.stringify({ code: RAW_CODE }) });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('client_capability_required');
  expect(insertMock).not.toHaveBeenCalled(); // no recoveryTokens row minted
  expect(updateMock.mock.calls.some((c) => c[0]?.codeUsedAt)).toBe(false); // code_used_at still null
});

it('exchange R3: referenced snapshot, index pending — 409 snapshot_index_pending, enqueues hydration, code not consumed', async () => {
  // ...arrange fileIndexStatus='none'...
  const res = await app.request('/bmr/recover/exchange', {
    method: 'POST', body: JSON.stringify({ code: RAW_CODE, capabilities: ['snapshot-file-membership-v1'] }),
  });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toBe('snapshot_index_pending');
  expect(body.retryAfterSeconds).toBe(30);
  expect(enqueueSnapshotFileIndexHydrationMock).toHaveBeenCalledWith(expect.any(String), 'exchange');
});

it('exchange R4: complete index + capability — mints token with negotiatedCapabilities persisted, returns fileIndex', async () => {
  const res = await app.request('/bmr/recover/exchange', {
    method: 'POST', body: JSON.stringify({ code: RAW_CODE, capabilities: ['snapshot-file-membership-v1'] }),
  });
  expect(res.status).toBe(200);
  const inserted = insertMock.mock.results.find((r) => r.value?.values)?.value.values.mock.calls[0]?.[0];
  expect(inserted).toMatchObject({ negotiatedCapabilities: ['snapshot-file-membership-v1'] });
  expect((await res.json()).bootstrap.snapshot.fileIndex.status).toBe('complete');
});
```

`apps/api/src/services/bareMetalRecoveryService.test.ts` — REPLACE the two existing guard tests at lines 86-96 and 102-109 (`'refuses a snapshot whose backup referenced objects from older snapshots'` and the `it.each` `'allows a self-contained snapshot'`) with:
```ts
describe('createBareMetalRecovery — external-reference preflight (W09, replaces the #6469 hard refusal)', () => {
  it('a referenced snapshot with a KNOWN storage identity is allowed and hydration is enqueued', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ ...restorableSnapshot, referencedFiles: 98411, storageIdentity: 'local::/srv/backups' }]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([recoveryRow()]));
    const { row } = await createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' });
    expect(row.id).toBe(RECOVERY_ID);
    expect(enqueueSnapshotFileIndexHydrationMock).toHaveBeenCalledWith(SNAPSHOT_ID, 'recovery_create');
  });

  it('a referenced snapshot with an UNKNOWN storage identity (NULL) is still refused at creation (409), before any write', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ ...restorableSnapshot, referencedFiles: 98411, storageIdentity: null }]));
    const err = await expectRecoveryError(
      createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'dr' }),
      'snapshot_storage_identity_unknown', 409,
    );
    expect(err.details).toMatchObject({ snapshotId: SNAPSHOT_ID });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it.each([[null], [0]])('a self-contained snapshot (referencedFiles=%s) is allowed and does NOT enqueue hydration', async (referencedFiles) => {
    selectMock
      .mockReturnValueOnce(chainMock([{ ...restorableSnapshot, referencedFiles }]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([recoveryRow()]));
    const { row } = await createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' });
    expect(row.id).toBe(RECOVERY_ID);
    expect(enqueueSnapshotFileIndexHydrationMock).not.toHaveBeenCalled();
  });
});
```
(Add `vi.mock('../jobs/backupSnapshotFileIndexWorker', () => ({ enqueueSnapshotFileIndexHydration: enqueueSnapshotFileIndexHydrationMock }))` and `enqueueSnapshotFileIndexHydrationMock` to this file's existing `vi.hoisted` block.)

`apps/api/src/services/recoveryBootstrap.test.ts` addition (near line 328 per Part 0's ground truth):
```ts
it('buildRecoveryDownloadDescriptor carries the granted capabilities list', () => {
  const descriptor = buildRecoveryDownloadDescriptor({
    providerSnapshotId: 'snap-1', authenticatedAt: new Date(), tokenExpiresAt: new Date(Date.now() + 60_000),
    capabilities: ['snapshot-file-membership-v1'],
  });
  expect(descriptor.capabilities).toEqual(['snapshot-file-membership-v1']);
});

it('buildRecoveryDownloadDescriptor omits capabilities entirely when none were granted (legacy shape unchanged)', () => {
  const descriptor = buildRecoveryDownloadDescriptor({
    providerSnapshotId: 'snap-1', authenticatedAt: new Date(), tokenExpiresAt: new Date(Date.now() + 60_000),
    capabilities: [],
  });
  expect(descriptor).not.toHaveProperty('capabilities');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/recoveryCapabilities.test.ts src/routes/backup/bmr.test.ts src/routes/backup/bmrRecoveries.test.ts src/services/bareMetalRecoveryService.test.ts src/services/recoveryBootstrap.test.ts`
Expected: FAIL across the board — `recoveryCapabilities.test.ts` can't resolve the module; the route tests assert on response shapes/fields (`bootstrap.download.capabilities`, `fileIndex`, `negotiatedCapabilities`) that don't exist in the current handlers; `bareMetalRecoveryService.test.ts` fails because `externalReferenceRefusal` still hard-refuses every `referencedFiles > 0` case regardless of `storageIdentity`, and `enqueueSnapshotFileIndexHydrationMock` is never called.

- [ ] **Step 3: Implement — `recoveryCapabilities.ts`**

```ts
// W09 (#6464) Task 5 — the pure decision table from Part 0 §1 "Server
// decision at authenticate/exchange". Deliberately has NO database or HTTP
// dependency: route handlers (bmr.ts authenticate, bmrRecoveries.ts exchange)
// gather NegotiationInput from the DB/provider-config resolution they already
// do, call this, and translate the result into a response. Keeping this pure
// is what makes the R1-R11 table exhaustively unit-testable without a DB.
import type { FileIndexStatus } from './backupSnapshotFileIndex';
import { BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY, hasMembershipCapability } from './backupObjectKey';

export type NegotiationInput = {
  clientCapabilities: readonly string[] | undefined;
  previouslyNegotiated: readonly string[] | null;
  referencedFiles: number | null;
  storageIdentity: string | null;
  resolvedProviderIdentity: string | null;
  fileIndex: {
    status: FileIndexStatus;
    manifestSha256: string | null;
    externalCount: number | null;
    originSnapshotIds: string[];
    error: string | null;
    retryable: boolean;
  };
};

type NegotiationErrorCode =
  | 'client_capability_required'
  | 'capability_downgrade'
  | 'snapshot_storage_identity_unknown'
  | 'storage_identity_drift'
  | 'snapshot_index_pending'
  | 'snapshot_index_failed';

export type NegotiationResult =
  | { ok: true; granted: string[]; fileIndex: { status: 'complete'; manifestSha256: string; externalCount: number; originSnapshotIds: string[] } | null; enqueueHydration: boolean }
  | { ok: false; status: 409; error: NegotiationErrorCode; message: string; retryAfterSeconds?: number; details?: Record<string, unknown>; enqueueHydration: boolean };

export const RECOVERY_REFUSAL_MESSAGES: Record<NegotiationErrorCode, string> = {
  client_capability_required:
    'This backup references files stored with earlier snapshots. The recovery media you booted is too old to read them — download the current recovery media from Breeze and boot again.',
  capability_downgrade:
    'This recovery session was started with cross-snapshot support and cannot continue without it.',
  snapshot_storage_identity_unknown:
    "Breeze has not yet verified where this snapshot's files are stored. Wait for the next retention run or choose a newer full backup.",
  storage_identity_drift:
    'The backup destination for this device has changed since this snapshot was written. Restore the previous destination settings or choose a snapshot written to the current destination.',
  snapshot_index_pending:
    'Breeze is preparing the file index for this snapshot (N files reference earlier snapshots). Retry in 30 seconds.',
  snapshot_index_failed:
    'Breeze could not verify this snapshot\'s file index: <reason>. Choose a newer full backup or contact support.',
};

const CAP = BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY;

function refuse(error: NegotiationErrorCode, opts: { retryAfterSeconds?: number; details?: Record<string, unknown>; message?: string; enqueueHydration?: boolean } = {}): NegotiationResult {
  return {
    ok: false, status: 409, error,
    message: opts.message ?? RECOVERY_REFUSAL_MESSAGES[error],
    ...(opts.retryAfterSeconds !== undefined ? { retryAfterSeconds: opts.retryAfterSeconds } : {}),
    ...(opts.details ? { details: opts.details } : {}),
    enqueueHydration: opts.enqueueHydration ?? false,
  };
}

export function negotiateRecoveryCapabilities(input: NegotiationInput): NegotiationResult {
  const clientHasCap = hasMembershipCapability(input.clientCapabilities);
  const needs = typeof input.referencedFiles === 'number' && input.referencedFiles > 0;

  if (!needs) {
    return { ok: true, granted: clientHasCap ? [CAP] : [], fileIndex: null, enqueueHydration: false };
  }

  const previouslyHadCap = hasMembershipCapability(input.previouslyNegotiated);
  if (previouslyHadCap && !clientHasCap) {
    return refuse('capability_downgrade');
  }
  if (!clientHasCap) {
    return refuse('client_capability_required', { details: { referencedFiles: input.referencedFiles } });
  }

  if (!input.storageIdentity) {
    return refuse('snapshot_storage_identity_unknown');
  }
  if (input.resolvedProviderIdentity !== input.storageIdentity) {
    return refuse('storage_identity_drift');
  }

  if (input.fileIndex.status === 'none' || input.fileIndex.status === 'agent') {
    return refuse('snapshot_index_pending', { retryAfterSeconds: 30, enqueueHydration: true });
  }
  if (input.fileIndex.status === 'hydrating') {
    return refuse('snapshot_index_pending', { retryAfterSeconds: 30, enqueueHydration: false });
  }
  if (input.fileIndex.status === 'failed') {
    return refuse('snapshot_index_failed', {
      message: RECOVERY_REFUSAL_MESSAGES.snapshot_index_failed.replace('<reason>', input.fileIndex.error ?? 'unknown error'),
      enqueueHydration: input.fileIndex.retryable,
    });
  }

  return {
    ok: true,
    granted: [CAP],
    fileIndex: {
      status: 'complete',
      manifestSha256: input.fileIndex.manifestSha256!,
      externalCount: input.fileIndex.externalCount ?? 0,
      originSnapshotIds: input.fileIndex.originSnapshotIds,
    },
    enqueueHydration: false,
  };
}
```
This is the single implementation to ship (an earlier draft with dead R5 branches was removed from this doc after review).

- [ ] **Step 4: Implement — schemas, recoveryBootstrap.ts, route glue**

`apps/api/src/routes/backup/schemas.ts` — add `capabilities` to both:
```ts
export const bmrAuthenticateSchema = z.object({
  token: z.string().min(1),
  capabilities: z.array(z.string().min(1).max(64)).max(16).optional(),
});
```
```ts
export const bmrExchangeSchema = z.object({
  code: z.string().min(1).max(32),
  capabilities: z.array(z.string().min(1).max(64)).max(16).optional(),
});
```

`apps/api/src/services/recoveryBootstrap.ts` — `buildRecoveryDownloadDescriptor` (lines 85-109) gains a `capabilities` arg, added to the returned object ONLY when non-empty (keeps the legacy shape byte-identical when nothing was granted, per Part 0 §1 "otherwise omitted"):
```ts
export function buildRecoveryDownloadDescriptor(args: {
  requestUrl?: string;
  providerSnapshotId: string;
  authenticatedAt?: Date | string | null;
  tokenExpiresAt?: Date | string | null;
  capabilities?: string[];
}) {
  const serverUrl = resolveServerUrl(args.requestUrl);
  const expiresAt = computeRecoveryDownloadExpiry(args.authenticatedAt, args.tokenExpiresAt);
  const advertiseQueryToken =
    process.env.BMR_RECOVERY_ADVERTISE_QUERY_TOKEN === '1' ||
    process.env.BMR_RECOVERY_ADVERTISE_QUERY_TOKEN === 'true';

  return {
    type: 'breeze_proxy',
    method: 'GET',
    url: `${serverUrl}/api/v1/backup/bmr/recover/download`,
    ...(advertiseQueryToken ? { tokenQueryParam: 'token' } : {}),
    tokenHeaderName: 'authorization',
    tokenHeaderFormat: 'Bearer <recovery-token>',
    pathQueryParam: 'path',
    requiresAuthentication: true,
    pathPrefix: `snapshots/${args.providerSnapshotId}`,
    expiresAt: expiresAt?.toISOString() ?? null,
    ...(args.capabilities && args.capabilities.length > 0 ? { capabilities: args.capabilities } : {}),
  };
}
```

`buildAuthenticatedBootstrapPayload` (lines 408-467) gains `grantedCapabilities`/`fileIndex` and threads them into `bootstrap.download`/`bootstrap.snapshot`:
```ts
export function buildAuthenticatedBootstrapPayload(args: {
  tokenId: string;
  deviceId: string;
  snapshotId: string;
  restoreType: string;
  targetConfig: unknown;
  authenticatedAt: Date;
  device: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
  providerType: string | null | undefined;
  config: Record<string, unknown> | null | undefined;
  requestUrl?: string;
  tokenExpiresAt?: Date | string | null;
  recovery?: AuthenticatedBootstrapRecovery | null;
  grantedCapabilities?: string[];
  fileIndex?: { status: 'complete'; manifestSha256: string; externalCount: number; originSnapshotIds: string[] } | null;
}) {
  const providerSnapshotId =
    getStringValue(asNullableRecord(args.snapshot), 'snapshotId') ?? args.snapshotId;
  const download = providerSnapshotId
    ? buildRecoveryDownloadDescriptor({
        requestUrl: args.requestUrl,
        providerSnapshotId,
        authenticatedAt: args.authenticatedAt,
        tokenExpiresAt: args.tokenExpiresAt,
        capabilities: args.grantedCapabilities,
      })
    : null;
  const bootstrap = {
    version: BMR_BOOTSTRAP_VERSION,
    minHelperVersion: BMR_MIN_HELPER_VERSION,
    tokenId: args.tokenId,
    device: args.device,
    snapshot: args.fileIndex && args.snapshot ? { ...args.snapshot, fileIndex: args.fileIndex } : args.snapshot,
    restoreType: args.restoreType,
    targetConfig: args.targetConfig ?? null,
    providerType: args.providerType ?? null,
    backupConfig: args.config
      ? {
          id: args.config.id ?? null,
          name: args.config.name ?? null,
          type: args.config.type ?? null,
          provider: args.config.provider ?? null,
          isActive: args.config.isActive ?? null,
        }
      : null,
    download,
    ...(args.recovery ? { recovery: args.recovery } : {}),
  };

  return {
    version: BMR_BOOTSTRAP_VERSION,
    minHelperVersion: BMR_MIN_HELPER_VERSION,
    tokenId: args.tokenId,
    deviceId: args.deviceId,
    snapshotId: args.snapshotId,
    restoreType: args.restoreType,
    targetConfig: args.targetConfig ?? null,
    device: args.device,
    snapshot: args.snapshot,
    authenticatedAt: args.authenticatedAt.toISOString(),
    bootstrap,
  };
}
```
(Deviation: the stub describes `bootstrap.snapshot.fileIndex` as a sibling addition; the concrete shape chosen here merges it into a COPY of `args.snapshot` inside `bootstrap.snapshot` only — the top-level `snapshot` field returned alongside `bootstrap` is left untouched, matching "inside the existing bootstrap object" from Part 0 §1 precisely.)

`apps/api/src/routes/backup/bmr.ts` authenticate handler — insert the negotiation call inside `runInRecoveryOrgContext`, after the `snapshot`/`device` lookups and BEFORE the `authenticatedAt`/status-flip block (before line 1146 `const authenticatedAt = new Date();`):
```ts
      const { capabilities: clientCapabilities } = c.req.valid('json');
      const [job] = await db
        .select({ referencedFiles: backupJobs.referencedFiles })
        .from(backupJobs)
        .where(eq(backupJobs.id, snapshot.jobId))
        .limit(1);
      const indexState = await readSnapshotFileIndexState(snapshot.id);
      const resolvedIdentity = resolvedSnapshot?.providerType
        ? normalizeStorageIdentity(resolvedSnapshot.providerType, asRecord(config?.providerConfig ?? resolvedSnapshot?.providerConfig))
        : null;
      const negotiation = negotiateRecoveryCapabilities({
        clientCapabilities,
        previouslyNegotiated: row.negotiatedCapabilities ?? null,
        referencedFiles: job?.referencedFiles ?? null,
        storageIdentity: snapshot.storageIdentity ?? null,
        resolvedProviderIdentity: resolvedIdentity,
        fileIndex: {
          status: (indexState?.status ?? 'none'),
          manifestSha256: indexState?.manifestSha256 ?? null,
          externalCount: indexState?.externalCount ?? null,
          originSnapshotIds: indexState?.originSnapshotIds ?? [],
          error: indexState?.error ?? null,
          retryable: indexState?.retryable ?? false,
        },
      });
      if (negotiation.enqueueHydration) {
        await enqueueSnapshotFileIndexHydration(snapshot.id, 'authenticate');
      }
      if (!negotiation.ok) {
        writeAuditEvent(c, {
          orgId: row.orgId, action: 'bmr.recovery.authenticate', resourceType: 'recovery_token', resourceId: row.id,
          details: { snapshotId: row.snapshotId, reason: negotiation.error }, result: 'failure', errorMessage: negotiation.error,
        });
        return c.json(
          { error: negotiation.error, message: negotiation.message, ...(negotiation.retryAfterSeconds !== undefined ? { retryAfterSeconds: negotiation.retryAfterSeconds } : {}), ...(negotiation.details ? { details: negotiation.details } : {}) },
          409,
        );
      }
```
and pass `negotiation.granted`/`negotiation.fileIndex` and, when granted, persist `negotiatedCapabilities` in the same status-flip `db.update(recoveryTokens)` call (lines 1152-1158):
```ts
      await db
        .update(recoveryTokens)
        .set({
          status: nextStatus,
          authenticatedAt,
          ...(negotiation.granted.length > 0 ? { negotiatedCapabilities: negotiation.granted } : {}),
        })
        .where(eq(recoveryTokens.id, row.id));
```
and finally thread `grantedCapabilities: negotiation.granted, fileIndex: negotiation.fileIndex` into the `buildAuthenticatedBootstrapPayload(...)` call near the end of the handler.

`snapshot.jobId` must already be selected by `resolveSnapshotProviderConfig`'s `SELECT` (it is — `jobId: backupSnapshots.jobId` is in that function's column list, verified in `recoveryBootstrap.ts:174`), so `snapshot.jobId` above is valid. Import `readSnapshotFileIndexState` from `../../services/backupSnapshotFileIndex`, `negotiateRecoveryCapabilities` from `../../services/recoveryCapabilities`, `normalizeStorageIdentity` from `../../services/backupRetention`... — wait, `normalizeStorageIdentity` lives in `jobs/backupRetention.ts`, not `services/backupRetention.ts`; import from `../../jobs/backupRetention`. And `enqueueSnapshotFileIndexHydration` from `../../jobs/backupSnapshotFileIndexWorker`.

`POST /bmr/tokens` bare_metal branch (currently the `if (payload.restoreType === 'bare_metal') { const refusal = externalReferenceRefusal(...) ... }` block). First extend that route's own snapshot select (`bmr.ts:448-456`, which today projects only `id`, `deviceId`, `referencedFiles`) with `storageIdentity: backupSnapshots.storageIdentity,` — without it every referenced-snapshot token is refused as identity-unknown (review finding, 2026-09-20). Then replace the block with:
```ts
    if (payload.restoreType === 'bare_metal') {
      const preflight = await externalReferencePreflight({
        referencedFiles: snapshot.referencedFiles, snapshotDbId: snapshot.id,
        storageIdentity: snapshot.storageIdentity ?? null,
      });
      if (preflight) {
        return c.json({ error: preflight.code, ...(preflight.details ?? {}) }, preflight.status);
      }
    }
```
and drop the now-unused `externalReferenceRefusal` import in favor of `externalReferencePreflight`.

`apps/api/src/services/bareMetalRecoveryService.ts` — replace `externalReferenceRefusal` (lines 116-130) with:
```ts
/**
 * W09 (#6464) preflight, replacing the #6469 hard refusal. A referenced
 * snapshot (referenced_files > 0) is no longer refused outright at creation
 * — token-mode recovery CAN follow cross-snapshot references once the server
 * has a verified-complete file index (Task 3/5). The only thing still
 * refused HERE, before any row is written, is a snapshot whose storage
 * identity is unknown (fail closed — Part 0 §0 "storage identity"): without
 * it hydration cannot even verify which physical bucket/path the referenced
 * objects live under. A known identity enqueues hydration (idempotent,
 * dedupe-keyed) and lets creation proceed; the ACTUAL authorization gate is
 * the authenticate/exchange negotiation (recoveryCapabilities.ts) and the
 * per-object download check (recoveryDownloadService.ts, Task 6) — this
 * function only prevents starting a recovery that can NEVER succeed.
 */
export async function externalReferencePreflight(input: {
  referencedFiles: number | null | undefined;
  snapshotDbId: string;
  storageIdentity?: string | null;
}): Promise<BareMetalRecoveryError | null> {
  if (typeof input.referencedFiles !== 'number' || input.referencedFiles <= 0) return null;
  if (!input.storageIdentity) {
    return new BareMetalRecoveryError('snapshot_storage_identity_unknown', 409, {
      referencedFiles: input.referencedFiles,
      snapshotId: input.snapshotDbId,
      reasons: [RECOVERY_REFUSAL_MESSAGES.snapshot_storage_identity_unknown],
    });
  }
  const { enqueueSnapshotFileIndexHydration } = await import('../jobs/backupSnapshotFileIndexWorker');
  await enqueueSnapshotFileIndexHydration(input.snapshotDbId, 'recovery_create');
  return null;
}
```
Add the member to the union in `apps/api/src/services/bareMetalRecoveryService.ts:35-41` (contract: Part 0 §1 names this code; the route tests above assert it):
```ts
export type BareMetalRecoveryErrorCode =
  | 'snapshot_not_found'
  | 'snapshot_not_bare_metal_restorable'
  | 'snapshot_storage_identity_unknown'
  | 'recovery_in_progress'
  | 'recovery_not_found'
  | 'invalid_state';
```
`'snapshot_has_external_references'` (the #6469 interim code) is removed together with `externalReferenceRefusal`; run `grep -rn "snapshot_has_external_references\|externalReferenceRefusal" apps/ packages/ agent/` and update every hit (the web panel renders `details.reasons`, so no UI branch keys on the code). Import `RECOVERY_REFUSAL_MESSAGES` from `./recoveryCapabilities`.

`createBareMetalRecovery` (line 168, the `const externalRefs = externalReferenceRefusal(...)` call) becomes:
```ts
  const preflight = await externalReferencePreflight({
    referencedFiles: snapshot.referencedFiles, snapshotDbId: snapshot.id, storageIdentity: (snapshot as any).storageIdentity ?? null,
  });
  if (preflight) throw preflight;
```
which requires adding `storageIdentity: backupSnapshots.storageIdentity` to the `select({...})` column list at the top of `createBareMetalRecovery` (currently `id, deviceId, bareMetalRestorable, bareMetalReasons, referencedFiles`).

Update the `POST /bmr/recoveries` create-route response (`bmrRecoveries.ts` lines 137-144) to include `fileIndex`:
```ts
      const { row, code } = await createBareMetalRecovery({ /* ...unchanged... */ });
      const indexState = await readSnapshotFileIndexState(row.snapshotId!);
      return c.json({ ...toRecoverySummary(row), code, fileIndex: { status: indexState?.status ?? 'none' } }, 201);
```

`bmrRecoveries.ts` exchange route — insert negotiation between the code-validity guard (ends at line ~432) and the code-claiming transaction (starts at line ~452):
```ts
    const { capabilities: clientCapabilities } = c.req.valid('json');

    return runInRecoveryOrgContext(rec.orgId, async () => {
      const [snapshotJobRow] = await resolveSnapshotProviderConfig(rec.snapshotId) ? [await (async () => {
        const resolved = await resolveSnapshotProviderConfig(rec.snapshotId);
        return resolved;
      })()] : [null];
      // (see implementation note below — this reads awkwardly written out
      // longhand; the actual implementation calls resolveSnapshotProviderConfig
      // ONCE and reuses the result both for negotiation and for
      // buildRecoveryExchangeBootstrap below, it is not called twice.)
```
Rewritten cleanly — this is the version to implement:
```ts
    const { capabilities: clientCapabilities } = c.req.valid('json');

    return runInRecoveryOrgContext(rec.orgId, async () => {
      const resolvedSnapshot = await resolveSnapshotProviderConfig(rec.snapshotId);
      const [job] = rec.snapshotId
        ? await db.select({ referencedFiles: backupJobs.referencedFiles }).from(backupJobs).where(eq(backupJobs.id, resolvedSnapshot?.snapshot.jobId)).limit(1)
        : [];
      const indexState = rec.snapshotId ? await readSnapshotFileIndexState(rec.snapshotId) : null;
      const resolvedIdentity = resolvedSnapshot?.providerType
        ? normalizeStorageIdentity(resolvedSnapshot.providerType, asRecord(resolvedSnapshot.config?.providerConfig ?? resolvedSnapshot.providerConfig))
        : null;
      const negotiation = negotiateRecoveryCapabilities({
        clientCapabilities,
        previouslyNegotiated: null, // exchange always mints a FRESH token — there is nothing to downgrade from
        referencedFiles: job?.referencedFiles ?? null,
        storageIdentity: resolvedSnapshot?.snapshot.storageIdentity ?? null,
        resolvedProviderIdentity: resolvedIdentity,
        fileIndex: {
          status: indexState?.status ?? 'none', manifestSha256: indexState?.manifestSha256 ?? null,
          externalCount: indexState?.externalCount ?? null, originSnapshotIds: indexState?.originSnapshotIds ?? [],
          error: indexState?.error ?? null, retryable: indexState?.retryable ?? false,
        },
      });
      if (negotiation.enqueueHydration && rec.snapshotId) {
        await enqueueSnapshotFileIndexHydration(rec.snapshotId, 'exchange');
      }
      if (!negotiation.ok) {
        writeAuditEvent(c, {
          orgId: rec.orgId, action: 'bmr.recovery.exchange', resourceType: 'bare_metal_recovery', resourceId: rec.id,
          result: 'failure', details: { reason: negotiation.error },
        });
        return c.json(
          { error: negotiation.error, message: negotiation.message, ...(negotiation.retryAfterSeconds !== undefined ? { retryAfterSeconds: negotiation.retryAfterSeconds } : {}) },
          409,
        );
      }

      const plainToken = generateRecoveryToken();
      // ...unchanged from here: tokenHash, nonce, the db.transaction() code
      // claim, EXCEPT the recoveryTokens insert gains
      // negotiatedCapabilities: negotiation.granted.length > 0 ? negotiation.granted : undefined
      // and buildRecoveryExchangeBootstrap(...) gains
      // grantedCapabilities: negotiation.granted, fileIndex: negotiation.fileIndex...
```
This moves the ENTIRE existing transaction body one level deeper (it already runs inside `runInRecoveryOrgContext` today — the negotiation code is inserted as the FIRST statements inside that same callback, before `generateRecoveryToken()`), so no other control flow changes. The negotiation runs BEFORE `codeUsedAt` is written (Part 0's hard requirement) because it happens before the `db.transaction(...)` call that performs the conditional UPDATE claiming the code.

- [ ] **Step 5: Run**

Run: `cd apps/api && npx vitest run src/services/recoveryCapabilities.test.ts src/routes/backup/bmr.test.ts src/routes/backup/bmrRecoveries.test.ts src/services/bareMetalRecoveryService.test.ts src/services/recoveryBootstrap.test.ts`
Expected: PASS.

Run: `cd apps/api && npx tsc --noEmit -p apps/api`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/recoveryCapabilities.ts apps/api/src/services/recoveryCapabilities.test.ts apps/api/src/routes/backup/schemas.ts apps/api/src/services/recoveryBootstrap.ts apps/api/src/services/recoveryBootstrap.test.ts apps/api/src/routes/backup/bmr.ts apps/api/src/routes/backup/bmr.test.ts apps/api/src/routes/backup/bmrRecoveries.ts apps/api/src/routes/backup/bmrRecoveries.test.ts apps/api/src/services/bareMetalRecoveryService.ts apps/api/src/services/bareMetalRecoveryService.test.ts
git commit -m "feat(backup): capability negotiation at recovery authenticate/exchange; creation preflight enqueues hydration instead of hard-refusing (W09a Task 5, replaces #6469)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 6: Download authorization for external references + progress bounds

**Files:**
- Modify: `apps/api/src/services/recoveryDownloadService.ts` (`RecoveryDownloadRow` at lines 18-21 gains `negotiatedCapabilities`; `normalizeSnapshotPath` at lines 27-35 is superseded by `classifyBackupObjectKey` at the call site, lines 143-147; `deriveRemoteStorageKey` at lines 75-97 gains an `originStoragePrefix` argument)
- Modify: `apps/api/src/routes/backup/bmr.ts` (system lookup for the download route, lines ~1361-1373 per current file — select `negotiatedCapabilities` alongside the existing columns)
- Modify: `apps/api/src/routes/backup/schemas.ts` (`bmrProgressSchema` at line 325 — bound `result` and, when present, `failedFilesSample`)
- Test: `apps/api/src/services/recoveryDownloadService.test.ts` (keep the existing test at line 133; add R6/R7/R12/agent-index/prefix cases), `apps/api/src/routes/backup/bmrRecoveries.test.ts` (progress schema bound cases)

**Interfaces (Produces):**
```ts
export async function authorizeExternalReference(
  db: typeof import('../db').db,
  args: { snapshotDbId: string; key: string; originSnapshotId: string; orgId: string; deviceId: string; pinnedStorageIdentity: string },
): Promise<{ ok: true; originStoragePrefix: string | null } | { ok: false; reason: string }>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/recoveryDownloadService.test.ts` additions (keep the existing `'rejects download paths outside the token snapshot scope'` test at line 133 verbatim — it still covers the plain prefix-widening case, R12 below just adds the capability dimension):
```ts
describe('external-reference downloads (W09, #6464)', () => {
  it('R6: an external key that IS a member of the snapshot index, with a verified origin, is authorized — physical key uses the ORIGIN prefix, not the token snapshot\'s', async () => {
    // ...arrange resolveSnapshotProviderConfigMock to resolve the token
    // snapshot (own id 'current'), the token row to carry
    // negotiatedCapabilities: ['snapshot-file-membership-v1'], and
    // authorizeExternalReference's underlying queries (via the mocked db
    // select chain) to return one backup_snapshot_files row and one
    // backup_snapshot_origins row with originStoragePrefix: 'archive-2025'...
    const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow, 'snapshots/older/files/a.gz');
    expect(result.unavailable).toBe(false);
    // the S3/local fetch key must be derived from 'archive-2025', never from
    // the token snapshot's own metadata.storagePrefix
  });

  it('R7 (a): a sibling file of a referenced origin snapshot that is NOT itself in the index is refused', async () => {
    // ...arrange the backup_snapshot_files EXISTS query to return no row for this exact key...
    const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow, 'snapshots/older/files/not-referenced.gz');
    expect(result).toMatchObject({ unavailable: true, reason: 'Requested path references an object this recovery is not authorized to read.' });
  });

  it('R7 (b): a key under an ANCESTOR manifest object itself (not a content file) is refused unless it is also indexed', async () => {
    const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow, 'snapshots/older/manifest.json');
    expect(result).toMatchObject({ unavailable: true });
  });

  it('R7 (c): a key under a newer, UNREFERENCED snapshot is refused', async () => {
    const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow, 'snapshots/newer-unrelated/files/x.gz');
    expect(result).toMatchObject({ unavailable: true });
  });

  it('R12: an own-prefix key is unaffected by capability negotiation — allowed even with no negotiated capabilities', async () => {
    const result = await getAuthenticatedRecoveryDownloadTarget({ ...tokenRow, negotiatedCapabilities: null }, 'snapshots/current/manifest.json');
    expect(result.unavailable).toBe(false);
  });

  it('an external key is refused when the token never negotiated the membership capability, even if the key IS indexed', async () => {
    const result = await getAuthenticatedRecoveryDownloadTarget({ ...tokenRow, negotiatedCapabilities: null }, 'snapshots/older/files/a.gz');
    expect(result).toMatchObject({ unavailable: true, reason: 'Requested path references an object this recovery is not authorized to read.' });
  });

  it('an external key is refused when the snapshot\'s file_index_status is not complete (e.g. agent)', async () => {
    // ...arrange the snapshot's fileIndexStatus as 'agent'...
    const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow, 'snapshots/older/files/a.gz');
    expect(result).toMatchObject({ unavailable: true });
  });
});
```

`apps/api/src/routes/backup/bmrRecoveries.test.ts` additions for the progress schema bound:
```ts
it('progress: a failedFilesSample over 50 entries is rejected by the schema (400), never reaches the handler', async () => {
  const sample = Array.from({ length: 98411 }, (_, i) => `file-${i}.gz`);
  const res = await app.request('/bmr/recover/progress', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, status: 'failed', result: { failedFilesSample: sample } }),
  });
  expect(res.status).toBe(400);
});

it('progress: a 50-entry failedFilesSample is accepted and the failed status persists', async () => {
  const sample = Array.from({ length: 50 }, (_, i) => `file-${i}.gz`);
  const res = await app.request('/bmr/recover/progress', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, status: 'failed', result: { failedFilesSample: sample, error: '98,411 files refused' } }),
  });
  expect(res.status).toBe(200);
});

it('progress: an oversized result payload (>768KB serialized) is rejected by the schema', async () => {
  const huge = { blob: 'x'.repeat(800 * 1024) };
  const res = await app.request('/bmr/recover/progress', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, status: 'restoring', result: huge }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/recoveryDownloadService.test.ts src/routes/backup/bmrRecoveries.test.ts`
Expected: FAIL — the new `recoveryDownloadService.test.ts` cases fail because `getAuthenticatedRecoveryDownloadTarget` still hard-scopes to the single `snapshots/${resolved.snapshot.snapshotId}` prefix (every external-key case returns the OLD "outside the allowed snapshot scope" reason instead of the new authorization path); the progress-schema cases fail because `bmrProgressSchema.result`/`.failedFilesSample` currently accept anything (`z.any()`), so a 98,411-entry sample and a 600KB blob both pass validation today and reach the 400 assertion never triggers (test fails expecting 400, getting 200).

- [ ] **Step 3: Implement — `authorizeExternalReference`**

Insert into `apps/api/src/services/recoveryDownloadService.ts`, after the existing helper functions and before `getAuthenticatedRecoveryDownloadTarget`:
```ts
import { and, eq } from 'drizzle-orm';
import { backupSnapshotFiles, backupSnapshotOrigins, backupSnapshots } from '../db/schema';
import { classifyBackupObjectKey, hasMembershipCapability } from './backupObjectKey';

/**
 * W09 (#6464) Task 6 — the download-time half of the exact-membership
 * contract. First confirms the TOKEN snapshot's file index is fully built
 * (`file_index_status = 'complete'` — a `agent`/`failed` index is
 * incomplete or untrustworthy and must never authorize an external
 * reference), then runs two indexed EXISTS checks: is this exact key a
 * member of the TOKEN snapshot's server-verified file index, and is its
 * origin snapshot verified against the SAME org/device/storage identity as
 * the token. All queries run inside the caller's `runInRecoveryOrgContext`
 * — RLS on both tables (Task 2) additionally enforces the org boundary
 * independent of the explicit `orgId` equality checks here.
 */
export async function authorizeExternalReference(
  dbHandle: typeof import('../db').db,
  args: { snapshotDbId: string; key: string; originSnapshotId: string; orgId: string; deviceId: string; pinnedStorageIdentity: string },
): Promise<{ ok: true; originStoragePrefix: string | null } | { ok: false; reason: string }> {
  const [tokenSnapshot] = await dbHandle
    .select({ fileIndexStatus: backupSnapshots.fileIndexStatus })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, args.snapshotDbId))
    .limit(1);
  if (!tokenSnapshot || tokenSnapshot.fileIndexStatus !== 'complete') {
    return { ok: false, reason: 'file index not complete' };
  }

  const [membership] = await dbHandle
    .select({ id: backupSnapshotFiles.id })
    .from(backupSnapshotFiles)
    .where(and(eq(backupSnapshotFiles.snapshotDbId, args.snapshotDbId), eq(backupSnapshotFiles.backupPath, args.key)))
    .limit(1);
  if (!membership) {
    return { ok: false, reason: 'key is not a member of the snapshot file index' };
  }

  const [origin] = await dbHandle
    .select({ originOrgId: backupSnapshotOrigins.originOrgId, originDeviceId: backupSnapshotOrigins.originDeviceId, originStorageIdentity: backupSnapshotOrigins.originStorageIdentity, originStoragePrefix: backupSnapshotOrigins.originStoragePrefix })
    .from(backupSnapshotOrigins)
    .where(and(eq(backupSnapshotOrigins.snapshotDbId, args.snapshotDbId), eq(backupSnapshotOrigins.originSnapshotId, args.originSnapshotId)))
    .limit(1);
  if (!origin) {
    return { ok: false, reason: 'no verified origin record for this snapshot reference' };
  }
  if (origin.originOrgId !== args.orgId || origin.originDeviceId !== args.deviceId || origin.originStorageIdentity !== args.pinnedStorageIdentity) {
    return { ok: false, reason: 'origin identity does not match the recovery token' };
  }

  return { ok: true, originStoragePrefix: origin.originStoragePrefix };
}
```

`RecoveryDownloadRow` (lines 18-21):
```ts
type RecoveryDownloadRow = Pick<
  typeof recoveryTokens.$inferSelect,
  'id' | 'orgId' | 'deviceId' | 'snapshotId' | 'status' | 'authenticatedAt' | 'expiresAt' | 'negotiatedCapabilities'
>;
```

`deriveRemoteStorageKey` (lines 75-97) gains an `originStoragePrefix` override, used only for the external branch (own-prefix downloads are byte-identical to today — Global Constraints "own-prefix downloads keep today's rule"):
```ts
function deriveRemoteStorageKey(
  normalizedRemotePath: string,
  providerConfig: Record<string, unknown>,
  snapshotMetadata: Record<string, unknown>,
  originStoragePrefixOverride?: string | null,
) {
  if (originStoragePrefixOverride) {
    return `${originStoragePrefixOverride.replace(/^\/+|\/+$/g, '')}/${normalizedRemotePath}`;
  }
  const storagePrefix = getStringValue(snapshotMetadata, 'storagePrefix');
  // ...rest unchanged...
}
```

`getAuthenticatedRecoveryDownloadTarget`'s scope check (lines 143-147) — replace the `normalizeSnapshotPath`/`expectedPrefix` block with a classify-then-branch:
```ts
  const ownSnapshotId = resolved.snapshot.snapshotId;
  const scope = classifyBackupObjectKey(remotePath.replace(/^\/+/, ''), ownSnapshotId);
  if (!scope) {
    return { unavailable: true, reason: 'Requested path is outside the allowed snapshot scope.' } as const;
  }

  let originStoragePrefix: string | null = null;
  if (scope.kind === 'external') {
    if (!hasMembershipCapability(tokenRow.negotiatedCapabilities)) {
      return { unavailable: true, reason: 'Requested path references an object this recovery is not authorized to read.' } as const;
    }
    const authorization = await authorizeExternalReference(db, {
      snapshotDbId: snapshotDbId,
      key: scope.key,
      originSnapshotId: scope.originSnapshotId,
      orgId: tokenRow.orgId,
      deviceId: tokenRow.deviceId,
      pinnedStorageIdentity: resolved.snapshot.storageIdentity ?? '',
    });
    if (!authorization.ok) {
      return { unavailable: true, reason: 'Requested path references an object this recovery is not authorized to read.' } as const;
    }
    originStoragePrefix = authorization.originStoragePrefix;
  }
  const normalizedRemotePath = scope.key;
```
(`normalizeSnapshotPath` is now unused except by whatever legacy callers remain — check `grep -rn "normalizeSnapshotPath" apps/api/src` before deleting the function; if `recoveryDownloadService.test.ts`'s existing test at line 133 calls it directly rather than only through `getAuthenticatedRecoveryDownloadTarget`, keep the function and its own unit coverage, just stop calling it from the scope check above.)

Thread `originStoragePrefix` into both the S3 and local branches (`apps/api/src/services/recoveryDownloadService.ts:190-206`):

S3 branch (line ~159) — replace:
```ts
    const key = deriveRemoteStorageKey(normalizedRemotePath, providerConfig, snapshotMetadata);
```
with:
```ts
    const key = deriveRemoteStorageKey(normalizedRemotePath, providerConfig, snapshotMetadata, originStoragePrefix);
```

Local branch (line ~186) — the local branch doesn't call `deriveRemoteStorageKey` today; it uses `normalizedRemotePath` directly against `rootPath`, so the origin prefix must be joined into `filePath` construction the same way. Replace:
```ts
    const filePath = ensureContainedLocalPath(rootPath, normalizedRemotePath);
```
with:
```ts
    const filePath = ensureContainedLocalPath(rootPath, originStoragePrefix ? `${originStoragePrefix}/${normalizedRemotePath}` : normalizedRemotePath);
```

`bmr.ts` download route's system-scoped token lookup — add `negotiatedCapabilities: recoveryTokens.negotiatedCapabilities` to the `select({...})` column list (the block starting `const [row] = await withSystemDbAccessContext(...)` before the download route's `runInRecoveryOrgContext` call).

- [ ] **Step 4: Implement — progress schema bounds**

`apps/api/src/routes/backup/schemas.ts` — replace `bmrProgressSchema` (line 325):
```ts
const bmrProgressResultSchema = z
  .any()
  .superRefine((value, ctx) => {
    if (JSON.stringify(value ?? null).length > 768 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'result payload too large (max 768KB serialized)' });
    }
  })
  .refine(
    (value) => {
      if (!value || typeof value !== 'object' || !('failedFilesSample' in value)) return true;
      const sample = (value as Record<string, unknown>).failedFilesSample;
      return Array.isArray(sample) && sample.length <= 50 && sample.every((entry) => typeof entry === 'string' && entry.length <= 4096);
    },
    { message: 'failedFilesSample must be at most 50 string entries of at most 4096 characters each' },
  );

export const bmrProgressSchema = z.object({
  token: z.string().min(1),
  status: z.enum(['media_booted', 'planned', 'restoring', 'validated', 'rebooted', 'failed', 'refused']),
  target: z.record(z.string(), z.any()).optional(),
  plan: z.any().optional(),
  result: bmrProgressResultSchema.optional(),
  reason: z.string().max(2000).optional(),
  warnings: z.array(z.string().max(2000)).max(64).optional(),
});
```
(The stub sketches `z.any().superRefine(v => JSON.stringify(v).length <= 768 * 1024)` — a bare `superRefine` predicate returning a boolean does nothing in zod; `superRefine` must call `ctx.addIssue(...)` to actually fail, which is what's implemented above. Similarly the `failedFilesSample` bound is expressed as a second `.refine`, not inline in the same `superRefine`, so each failure gets its own clear message. The 768 KiB cap matches the agent's total-body bound (see Global Constraints → Bounded reporting) so a maximally-sized agent report is never rejected by the server.)

- [ ] **Step 5: Run**

Run: `cd apps/api && npx vitest run src/services/recoveryDownloadService.test.ts src/routes/backup/bmrRecoveries.test.ts`
Expected: PASS.

Run: `cd apps/api && npx tsc --noEmit -p apps/api`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/recoveryDownloadService.ts apps/api/src/services/recoveryDownloadService.test.ts apps/api/src/routes/backup/bmr.ts apps/api/src/routes/backup/schemas.ts apps/api/src/routes/backup/bmrRecoveries.test.ts
git commit -m "feat(backup): exact-membership download authorization for cross-snapshot references; bound progress payload size (W09a Task 6)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 7: Integration proof, suites, PR 1

**Files:**
- Modify: `apps/api/src/__tests__/integration/bmrRecoverPublicRoutesRls.integration.test.ts` (extend the local-provider fixture to three-then-four generations; mount `bmrRecoveryPublicRoutes` from `bmrRecoveries.ts` alongside the existing `bmrPublicRoutes` from `bmr.ts` — the exchange route this task tests lives in the former, not the latter)
- Run: full API unit suites for touched files, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `rls-coverage`, `tenantCascade`, `bmrRecoverPublicRoutesRls` integration suites; `pnpm db:check-drift`; `npx tsc --noEmit -p apps/api`
- PR: branch `feature/5493-bare-metal-boot-media/wave-6464`, title `feat(bare-metal): server-side manifest index + exact-membership authorization for cross-snapshot references (W09a, part of #6464)`, body `Part of #6464`

- [ ] **Step 1: Write the failing integration test extensions**

The existing file mounts only `bmrPublicRoutes` (`makeApp()`, lines 44-48). Add a second app factory that also mounts the exchange/progress routes, since Task 7's coverage spans both route modules:
```ts
import { bmrRecoveryPublicRoutes } from '../../routes/backup/bmrRecoveries';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import { fetchBackupObjectBytes } from '../../services/backupSnapshotStorage';
import { backupSnapshotOrigins, backupSnapshotRetirements, bareMetalRecoveries } from '../../db/schema';
import { generateRecoveryCode, hashRecoveryCode, hashRecoveryNonce, generateRecoveryNonce } from '../../services/bareMetalRecoveryCodes';

function makeExchangeApp(): Hono {
  const app = new Hono();
  app.route('/', bmrRecoveryPublicRoutes);
  return app;
}
```

Extend `seedOrgWithLocalSnapshot` (or add a sibling helper `seedThreeGenerationChain`) to write three generations on disk and three `backup_snapshots` rows, matching Part 0's contract exactly:
```ts
async function seedThreeGenerationChain() {
  const testDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id, name: 'w09 chain site' });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [device] = await testDb.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `w09-agent-${suffix}`, hostname: `w09-host-${suffix}`,
    osType: 'linux', osVersion: '24.04', architecture: 'x86_64', agentVersion: 'test', status: 'offline',
  }).returning({ id: devices.id });
  if (!device) throw new Error('device fixture insert failed');

  const storageRoot = await mkdtemp(join(tmpdir(), 'bmr-w09-chain-'));
  tempDirs.push(storageRoot);
  const storageIdentity = `local::${storageRoot}`;

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: org.id, name: `w09 chain config ${suffix}`, type: 'file', provider: 'local', providerConfig: { path: storageRoot },
  }).returning({ id: backupConfigs.id });
  if (!config) throw new Error('config fixture insert failed');

  async function writeSnapshot(label: string, referencedFiles: number, files: Array<{ sourcePath: string; backupPath: string; size: number }>) {
    const snapshotId = `${label}-${suffix}`;
    const [job] = await testDb.insert(backupJobs).values({
      orgId: org.id, configId: config.id, deviceId: device.id, status: 'completed', referencedFiles, storageIdentity,
    }).returning({ id: backupJobs.id });
    if (!job) throw new Error('job fixture insert failed');
    const [snapshot] = await testDb.insert(backupSnapshots).values({
      orgId: org.id, jobId: job.id, deviceId: device.id, configId: config.id, snapshotId,
      storageIdentity, bareMetalRestorable: true, metadata: {},
    }).returning({ id: backupSnapshots.id });
    if (!snapshot) throw new Error('snapshot fixture insert failed');

    const dir = join(storageRoot, 'snapshots', snapshotId);
    await mkdir(join(dir, 'files'), { recursive: true });
    for (const file of files) {
      const abs = join(storageRoot, file.backupPath);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, `content for ${file.backupPath}`, 'utf8');
    }
    const manifest = { id: snapshotId, files };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    return { snapshotDbId: snapshot.id as string, snapshotId, jobId: job.id as string };
  }

  // g1: full backup, self-contained (own files only).
  const g1 = await writeSnapshot('g1', 0, [
    { sourcePath: '/a', backupPath: `snapshots/g1-${suffix}/files/a.gz`, size: 10 },
    { sourcePath: '/zzz', backupPath: `snapshots/g1-${suffix}/files/zzz.gz`, size: 5 }, // exists on disk, NEVER referenced by g3
  ]);
  // g2: incremental, references g1's a.gz for one file, adds its own b.gz.
  const g2 = await writeSnapshot('g2', 1, [
    { sourcePath: '/a', backupPath: `snapshots/g1-${suffix}/files/a.gz`, size: 10 },
    { sourcePath: '/b', backupPath: `snapshots/g2-${suffix}/files/b.gz`, size: 20 },
  ]);
  // g3: incremental, references g1's a.gz AND g2's b.gz, adds its own c.gz.
  const g3 = await writeSnapshot('g3', 2, [
    { sourcePath: '/a', backupPath: `snapshots/g1-${suffix}/files/a.gz`, size: 10 },
    { sourcePath: '/b', backupPath: `snapshots/g2-${suffix}/files/b.gz`, size: 20 },
    { sourcePath: '/c', backupPath: `snapshots/g3-${suffix}/files/c.gz`, size: 30 },
  ]);

  return { orgId: org.id as string, deviceId: device.id as string, storageRoot, storageIdentity, g1, g2, g3, suffix };
}

async function retireSnapshotRow(fixture: Awaited<ReturnType<typeof seedThreeGenerationChain>>, gen: { snapshotDbId: string; snapshotId: string }) {
  const testDb = getTestDb();
  await testDb.insert(backupSnapshotRetirements).values({
    orgId: fixture.orgId, deviceId: fixture.deviceId, snapshotId: gen.snapshotId,
    storageIdentity: fixture.storageIdentity, reason: 'manual',
  });
  await testDb.delete(backupSnapshots).where(eq(backupSnapshots.id, gen.snapshotDbId));
}
```

Add the test cases:
```ts
runDb('R6/R7/R9/R19: hydrates a three-generation chain, authorizes exact references after the origin row is retired, refuses everything else', async () => {
  const fixture = await seedThreeGenerationChain();
  await retireSnapshotRow(fixture, fixture.g1); // g1 retired BEFORE hydration — provenance must come from the retirement record

  const outcome = await hydrateSnapshotFileIndex(fixture.g3.snapshotDbId, {
    deps: { fetchManifestBytes: (args) => fetchBackupObjectBytes(args) },
  });
  expect(outcome).toMatchObject({ status: 'complete', externalCount: 2, entryCount: 3 });

  // Create a bare-metal recovery + exchange its code, WITH the capability.
  const code = generateRecoveryCode();
  const [rec] = await getTestDb().insert(bareMetalRecoveries).values({
    orgId: fixture.orgId, deviceId: fixture.deviceId, snapshotId: fixture.g3.snapshotDbId, identity: 'original',
    codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 900_000),
    nonceHash: hashRecoveryNonce(generateRecoveryNonce()), status: 'created',
  }).returning();
  if (!rec) throw new Error('recovery fixture insert failed');

  const exchangeApp = makeExchangeApp();
  const withCap = await exchangeApp.request('/bmr/recover/exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: formatRecoveryCode(code), capabilities: ['snapshot-file-membership-v1'] }),
  });
  expect(withCap.status).toBe(200);
  const withCapBody = await withCap.json();
  expect(withCapBody.bootstrap.snapshot.fileIndex.status).toBe('complete');
  const token = withCapBody.token as string;

  const downloadApp = makeApp();
  const authorize = async (path: string) =>
    downloadApp.request(`/bmr/recover/download?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` } });

  const ownFile = await authorize(`snapshots/${fixture.g3.snapshotId}/files/c.gz`);
  expect(ownFile.status).toBe(200);

  const g1Referenced = await authorize(`snapshots/${fixture.g1.snapshotId}/files/a.gz`);
  expect(g1Referenced.status).toBe(200); // R6 + R9: retired origin, still authorized

  const g1SiblingNotReferenced = await authorize(`snapshots/${fixture.g1.snapshotId}/files/zzz.gz`);
  expect(g1SiblingNotReferenced.status).toBe(409); // R7: on disk, not in g3's index

  const g2Manifest = await authorize(`snapshots/${fixture.g2.snapshotId}/manifest.json`);
  expect(g2Manifest.status).toBe(409); // R7: an ancestor's manifest itself is not a content reference
});

runDb('exchange without capabilities on a referenced snapshot is refused before the code is consumed', async () => {
  const fixture = await seedThreeGenerationChain();
  await hydrateSnapshotFileIndex(fixture.g3.snapshotDbId, { deps: { fetchManifestBytes: (args) => fetchBackupObjectBytes(args) } });

  const code = generateRecoveryCode();
  const [rec] = await getTestDb().insert(bareMetalRecoveries).values({
    orgId: fixture.orgId, deviceId: fixture.deviceId, snapshotId: fixture.g3.snapshotDbId, identity: 'original',
    codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 900_000),
    nonceHash: hashRecoveryNonce(generateRecoveryNonce()), status: 'created',
  }).returning();
  if (!rec) throw new Error('recovery fixture insert failed');

  const exchangeApp = makeExchangeApp();
  const res = await exchangeApp.request('/bmr/recover/exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: formatRecoveryCode(code) }), // no capabilities — legacy client
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('client_capability_required');

  const [reread] = await getTestDb().select().from(bareMetalRecoveries).where(eq(bareMetalRecoveries.id, rec.id));
  expect(reread?.codeUsedAt).toBeNull();
  expect(reread?.status).toBe('created');
});

runDb('org B\'s snapshot key is refused through org A\'s token, even for an authorized external reference shape', async () => {
  const fixtureA = await seedThreeGenerationChain();
  const fixtureB = await seedThreeGenerationChain();
  await hydrateSnapshotFileIndex(fixtureA.g3.snapshotDbId, { deps: { fetchManifestBytes: (args) => fetchBackupObjectBytes(args) } });

  const token = generateRecoveryToken();
  await getTestDb().insert(recoveryTokens).values({
    orgId: fixtureA.orgId, deviceId: fixtureA.deviceId, snapshotId: fixtureA.g3.snapshotDbId,
    tokenHash: hashRecoveryToken(token), restoreType: 'bare_metal', status: 'active', expiresAt: new Date(Date.now() + 3_600_000),
  });
  const authApp = makeApp();
  const authRes = await authApp.request('/bmr/recover/authenticate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, capabilities: ['snapshot-file-membership-v1'] }),
  });
  expect(authRes.status).toBe(200);

  const crossOrg = await authApp.request(
    `/bmr/recover/download?path=${encodeURIComponent(`snapshots/${fixtureB.g1.snapshotId}/files/a.gz`)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(crossOrg.status).toBe(409);
});

runDb('R19: a 100,000-entry manifest with an empty agent-reported index hydrates to complete in one pass', async () => {
  const fixture = await seedThreeGenerationChain();
  const testDb = getTestDb();
  const g4Id = `g4-${fixture.suffix}`;
  const [job] = await testDb.insert(backupJobs).values({
    orgId: fixture.orgId, configId: (await testDb.select({ id: backupConfigs.id }).from(backupConfigs).limit(1))[0]!.id,
    deviceId: fixture.deviceId, status: 'completed', referencedFiles: 100_000, storageIdentity: fixture.storageIdentity,
  }).returning({ id: backupJobs.id });
  const [g4] = await testDb.insert(backupSnapshots).values({
    orgId: fixture.orgId, jobId: job!.id, deviceId: fixture.deviceId, snapshotId: g4Id,
    storageIdentity: fixture.storageIdentity, bareMetalRestorable: true, metadata: {},
  }).returning({ id: backupSnapshots.id });

  const dir = join(fixture.storageRoot, 'snapshots', g4Id);
  await mkdir(dir, { recursive: true });
  const files = Array.from({ length: 100_000 }, (_, i) => ({
    sourcePath: `/f${i}`, backupPath: `snapshots/${fixture.g1.snapshotId}/files/f${i}.gz`, size: 1,
  }));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: g4Id, files }), 'utf8');
  // NOTE: this test does NOT physically write 100,000 files to disk — only
  // the manifest. hydrateSnapshotFileIndex never reads the referenced content
  // objects themselves, only the manifest — proven by this test passing
  // without those files existing.

  const start = Date.now();
  const outcome = await hydrateSnapshotFileIndex(g4!.id, { deps: { fetchManifestBytes: (args) => fetchBackupObjectBytes(args) } });
  const elapsedMs = Date.now() - start;

  expect(outcome).toMatchObject({ status: 'complete', entryCount: 100_000, externalCount: 100_000 });
  expect(elapsedMs).toBeLessThan(60_000);
  const [{ count }] = await testDb.execute(sql`SELECT COUNT(*)::int AS count FROM backup_snapshot_files WHERE snapshot_db_id = ${g4!.id}`) as any;
  expect(Number(count)).toBe(100_000);
}, 90_000);
```
(`sql` and `recoveryTokens`/`generateRecoveryToken`/`hashRecoveryToken`/`formatRecoveryCode` need adding to this file's import block; `formatRecoveryCode` and `generateRecoveryCode` come from `bareMetalRecoveryCodes.ts`. The R19 test's 90-second Vitest timeout override accounts for CI variance on top of the < 60s in-code assertion — the assertion is the real acceptance criterion, the outer timeout is slack.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze npx vitest run -c vitest.integration.config.ts src/__tests__/integration/bmrRecoverPublicRoutesRls.integration.test.ts`
Expected: FAIL before Tasks 1-6 land (this task is written last and is the end-to-end proof that the earlier tasks actually compose); if Tasks 1-6 are already committed by the time this step runs, the specific new assertions should already be green from the unit-level coverage and this step becomes a confirmation pass rather than a true red — still run it once BEFORE writing the R6/R7/R9/R19 cases (i.e. run the file as it stood at the end of Task 6) to see it fail on `relation` / `column` errors if any migration ordering slipped, then add the cases and watch them pass.

- [ ] **Step 3: Nothing to implement — Task 7 is proof-only**

No production code changes in this task; if the new integration cases fail against the code shipped in Tasks 1-6, that is a genuine defect in one of those tasks (fix it there, in a follow-up commit on the same branch, not by weakening this test).

- [ ] **Step 4: Run — full suite sweep**

```bash
cd apps/api && npx vitest run \
  src/services/backupObjectKey.test.ts \
  src/services/backupSnapshotFileIndex.test.ts \
  src/services/backupSnapshotStorage.test.ts \
  src/services/backupResultPersistence.test.ts \
  src/jobs/backupSnapshotFileIndexWorker.test.ts \
  src/services/recoveryCapabilities.test.ts \
  src/routes/backup/bmr.test.ts \
  src/routes/backup/bmrRecoveries.test.ts \
  src/services/bareMetalRecoveryService.test.ts \
  src/services/recoveryBootstrap.test.ts \
  src/services/recoveryDownloadService.test.ts
```
Expected: PASS.

```bash
cd apps/api && DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/bmrRecoverPublicRoutesRls.integration.test.ts
```
Expected: PASS. (`tenantCascade` is run even though this wave adds no `org_id` cascade-list entry — `backup_snapshot_origins` and `backup_snapshots`'s new columns don't change cascade membership — as a regression check per CLAUDE.md's "run the separate contract suites... always then if tenancy/cascade code was touched," and this wave touches `backup_snapshots` and RLS.)

```bash
cd apps/api && pnpm db:check-drift
cd apps/api && npx tsc --noEmit -p apps/api
cd apps/api && npx vitest run # full unit suite, final sweep before PR
```
Expected: all PASS, no drift, no new type errors.

- [ ] **Step 5: PR**

```bash
git checkout -b feature/5493-bare-metal-boot-media/wave-6464
git push -u origin feature/5493-bare-metal-boot-media/wave-6464
gh pr create --title "feat(bare-metal): server-side manifest index + exact-membership authorization for cross-snapshot references (W09a, part of #6464)" --body "$(cat <<'EOF'

---

## Part B — W09b (PR 2, "Closes #6464") — agent, web, e2e, lab

> Ground-truth note for this Part: `buildTokenModeOptions`, `runTokenModeRebuild` and `agent/cmd/breeze-backup/exec_bare_metal_rebuild.go` (with `execBareMetalRebuild`) **already exist in this worktree** — they were built in W05a. Task 10 below **modifies** them; it does not create or extract them. Every other Files/Interfaces block below was re-verified against the actual source on 2026-09-20 in this worktree; any place the stub's assumed file/line/name did not match reality is called out inline as **Deviation:**.

### Task 8: Wire types, capabilities, Go object-key parser

**Files:**
- Create: `agent/internal/backup/bmr/capabilities.go`
- Create: `agent/internal/backup/bmr/objectkey.go`
- Consume (no edit): `agent/internal/backup/bmr/testdata/object-key-vectors.json` — shared with the API's Vitest suite per Global Constraint 5, created by Task 1; `objectkey_test.go` loads this file rather than authoring a second copy. **If PR 1 has not merged when this branch starts, cherry-pick Task 1's commit (the vectors file + `backupObjectKey.ts`) onto this branch rather than re-authoring the JSON.**
- Modify: `agent/internal/backup/bmr/types.go:36-47` (`AuthenticatedDownloadDescriptor` gains `Capabilities`), `:49-62` (`AuthenticatedSnapshot` gains `FileIndex`, new `FileIndexInfo` type)
- Modify: `agent/internal/backup/bmr/session.go:144-149` (`ExchangeRecoveryCode` request body), `:247-252` (`authenticateRecoverySessionContext` request body)
- Modify: `agent/internal/backup/bmr/session_test.go:24` — the pre-existing `TestAuthenticateRecoverySession` decodes the request body into `var body map[string]string`; adding a `"capabilities": [...]` array to the request makes `json.Decode` fail against that type, so this line changes to `var body map[string]json.RawMessage` (or a typed struct) before this task's changes can go green
- Test: `agent/internal/backup/bmr/objectkey_test.go`, `agent/internal/backup/bmr/capabilities_test.go`, additions to `agent/internal/backup/bmr/session_test.go`

**Deviation:** Part 0 §1 names the Go snapshot bootstrap type `BootstrapSnapshot`. The real type (verified `types.go:49-62`) is `AuthenticatedSnapshot`. `FileIndex` is added there, not to a nonexistent `BootstrapSnapshot`.

**Deviation:** the stub describes `session.go:144`/`:247` as places to add a `"capabilities"` field to "request bodies." The actual code at those lines is `payload, err := json.Marshal(map[string]string{"code": code})` (`ExchangeRecoveryCode`, line 145) and `payload, err := json.Marshal(map[string]string{"token": token})` (`authenticateRecoverySessionContext`, line 248) — both marshal a raw `map[string]string`, which cannot hold a `[]string` value. Both call sites are changed to marshal a small named request struct instead (the pattern `progress.go:58-61` already uses for "named payload plus one extra field": an anonymous struct wrapping the existing shape).

**Interfaces (Produces):**
```go
// capabilities.go
const CapabilitySnapshotFileMembershipV1 = "snapshot-file-membership-v1"
func ClientCapabilities() []string
func HasCapability(list []string, name string) bool

// objectkey.go
type ParsedObjectKey struct{ SnapshotID, Rest string }
func ParseObjectKey(key string) (ParsedObjectKey, bool)
func IsExternalObjectKey(key, ownSnapshotID string) (external bool, originID string, ok bool)

// types.go additions
type FileIndexInfo struct {
	Status            string   `json:"status"`
	ManifestSHA256    string   `json:"manifestSha256"`
	ExternalCount     int      `json:"externalCount"`
	OriginSnapshotIDs []string `json:"originSnapshotIds"`
}
// AuthenticatedDownloadDescriptor gains: Capabilities []string `json:"capabilities,omitempty"`
// AuthenticatedSnapshot gains:          FileIndex *FileIndexInfo `json:"fileIndex,omitempty"`
```

- [ ] **Step 1: Write the failing tests**

This task does not author `object-key-vectors.json` — see the Files note above: Task 1 creates it, and Task 8 only reads it via `objectkey_test.go`'s `loadObjectKeyVectors` helper below.

`objectkey_test.go`:
```go
package bmr

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

type objectKeyVector struct {
	Key        string `json:"key"`
	Valid      bool   `json:"valid"`
	SnapshotID string `json:"snapshotId,omitempty"`
	Rest       string `json:"rest,omitempty"`
}

func loadObjectKeyVectors(t *testing.T) []objectKeyVector {
	t.Helper()
	data, err := os.ReadFile("testdata/object-key-vectors.json")
	require.NoError(t, err)
	var vectors []objectKeyVector
	require.NoError(t, json.Unmarshal(data, &vectors))
	require.GreaterOrEqual(t, len(vectors), 20, "vectors file must pin at least 20 cases per Part 0 §1")
	return vectors
}

func TestParseObjectKey_MatchesSharedVectors(t *testing.T) {
	for _, v := range loadObjectKeyVectors(t) {
		v := v
		t.Run(v.Key, func(t *testing.T) {
			parsed, ok := ParseObjectKey(v.Key)
			require.Equal(t, v.Valid, ok, "key %q", v.Key)
			if v.Valid {
				require.Equal(t, v.SnapshotID, parsed.SnapshotID)
				require.Equal(t, v.Rest, parsed.Rest)
			}
		})
	}
}

func TestIsExternalObjectKey_ClassifiesOwnVsExternal(t *testing.T) {
	external, origin, ok := IsExternalObjectKey("snapshots/gen-1/files/a.gz", "gen-2")
	require.True(t, ok)
	require.True(t, external)
	require.Equal(t, "gen-1", origin)

	external, origin, ok = IsExternalObjectKey("snapshots/gen-2/files/a.gz", "gen-2")
	require.True(t, ok)
	require.False(t, external)
	require.Equal(t, "gen-2", origin)

	_, _, ok = IsExternalObjectKey("snapshots/gen-2/", "gen-2")
	require.False(t, ok, "an invalid key must never be classified as own")
}
```

`capabilities_test.go`:
```go
package bmr

import "testing"

func TestClientCapabilities_IncludesMembership(t *testing.T) {
	if !HasCapability(ClientCapabilities(), CapabilitySnapshotFileMembershipV1) {
		t.Fatalf("ClientCapabilities() = %v, want to include %q", ClientCapabilities(), CapabilitySnapshotFileMembershipV1)
	}
}

func TestHasCapability(t *testing.T) {
	list := []string{"a", CapabilitySnapshotFileMembershipV1, "b"}
	if !HasCapability(list, CapabilitySnapshotFileMembershipV1) {
		t.Fatal("expected capability present")
	}
	if HasCapability(list, "not-present") {
		t.Fatal("expected capability absent")
	}
	if HasCapability(nil, CapabilitySnapshotFileMembershipV1) {
		t.Fatal("expected false on nil list")
	}
}
```

Additions to `session_test.go` (package `bmr`; the existing file already imports `net/http/httptest`, `encoding/json`, `testing` per the download-provider test pattern used package-wide — add `strings` and `github.com/stretchr/testify/require` if not already imported):
```go
func TestExchangeRecoveryCode_SendsClientCapabilities(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		writeTestBootstrapEnvelope(t, w, "gen-1", true)
	}))
	defer server.Close()

	_, _, err := ExchangeRecoveryCode(context.Background(), server.URL, "ABC-DEF-GHJ")
	require.NoError(t, err)

	caps, ok := gotBody["capabilities"].([]any)
	require.True(t, ok, "request body missing capabilities: %v", gotBody)
	require.Contains(t, caps, CapabilitySnapshotFileMembershipV1)
}

func TestAuthenticateRecoverySession_SendsClientCapabilities(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		writeTestBootstrapEnvelope(t, w, "gen-1", false)
	}))
	defer server.Close()

	_, err := AuthenticateRecoverySession(context.Background(), server.URL, "token-1")
	require.NoError(t, err)

	caps, ok := gotBody["capabilities"].([]any)
	require.True(t, ok, "request body missing capabilities: %v", gotBody)
	require.Contains(t, caps, CapabilitySnapshotFileMembershipV1)
}

func TestBootstrapResponse_RoundTripsFileIndexAndDownloadCapabilities(t *testing.T) {
	raw := []byte(`{
		"version": 1,
		"snapshot": {"id": "s1", "snapshotId": "gen-2", "backupType": "system_image",
			"fileIndex": {"status": "complete", "manifestSha256": "` + strings.Repeat("a", 64) + `",
				"externalCount": 3, "originSnapshotIds": ["gen-1"]}},
		"download": {"type": "breeze_proxy", "url": "https://example.invalid/download",
			"pathQueryParam": "path", "pathPrefix": "snapshots/gen-2",
			"capabilities": ["snapshot-file-membership-v1"]}
	}`)
	var bs BootstrapResponse
	require.NoError(t, json.Unmarshal(raw, &bs))
	require.NotNil(t, bs.Snapshot.FileIndex)
	require.Equal(t, "complete", bs.Snapshot.FileIndex.Status)
	require.Equal(t, []string{"gen-1"}, bs.Snapshot.FileIndex.OriginSnapshotIDs)
	require.Equal(t, []string{CapabilitySnapshotFileMembershipV1}, bs.Download.Capabilities)
}

// writeTestBootstrapEnvelope writes a response body shaped like the server's
// real /bmr/recover/exchange or /bmr/recover/authenticate response. Before
// relying on this in a real PR, grep session.go for the decode target next
// to authenticateRecoverySessionContext (~line 260-288) and ExchangeRecoveryCode
// (~line 180-201) and confirm the envelope field names/nesting match exactly —
// this helper was written from the exchange envelope confirmed in this
// research pass (`struct{ Token string; Bootstrap json.RawMessage }`); the
// authenticate envelope was not independently re-verified byte-for-byte.
func writeTestBootstrapEnvelope(t *testing.T, w http.ResponseWriter, snapshotID string, withToken bool) {
	t.Helper()
	bootstrap := map[string]any{
		"version": 1,
		"snapshot": map[string]any{
			"id": "s1", "snapshotId": snapshotID, "backupType": "file",
		},
		"download": map[string]any{
			"type": "breeze_proxy", "url": "https://example.invalid/download",
			"pathQueryParam": "path", "pathPrefix": "snapshots/" + snapshotID,
		},
	}
	body := map[string]any{"bootstrap": bootstrap}
	if withToken {
		body["token"] = "recv-token-1"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	require.NoError(t, json.NewEncoder(w).Encode(body))
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go build ./internal/backup/bmr/... 2>&1 | head -20`
Expected: compile errors — `CapabilitySnapshotFileMembershipV1 undefined`, `ClientCapabilities undefined`, `ParseObjectKey undefined`, `bs.Snapshot.FileIndex undefined field`, `bs.Download.Capabilities undefined field` — the new test files reference symbols that don't exist yet.

- [ ] **Step 3: Implement**

`capabilities.go`:
```go
package bmr

// CapabilitySnapshotFileMembershipV1 is the wire capability string that
// signals this agent build can restrict cross-snapshot object downloads to
// the server-verified membership index instead of trusting manifest object
// keys implicitly. MUST match
// apps/api/src/services/backupObjectKey.ts's
// BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY constant exactly — never spell
// either side inline (Global Constraint, Part 0).
const CapabilitySnapshotFileMembershipV1 = "snapshot-file-membership-v1"

// ClientCapabilities returns the capability strings this agent build sends
// on every /bmr/recover/authenticate and /bmr/recover/exchange request.
func ClientCapabilities() []string {
	return []string{CapabilitySnapshotFileMembershipV1}
}

// HasCapability reports whether name is present in list.
func HasCapability(list []string, name string) bool {
	for _, c := range list {
		if c == name {
			return true
		}
	}
	return false
}
```

`objectkey.go`:
```go
package bmr

import (
	"regexp"
	"strings"
)

// objectKeyPattern mirrors apps/api/src/services/backupObjectKey.ts's
// parseBackupObjectKey exactly: no trimming, no case folding, no
// percent-decoding beyond the transport's single decode. See
// docs/superpowers/plans/backup/_w09-part0.md §1 and
// testdata/object-key-vectors.json, which pins both sides to identical
// behavior.
var objectKeyPattern = regexp.MustCompile(`^snapshots/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/(.+)$`)

// ParsedObjectKey is the decomposition of a valid backup object key into
// its owning snapshot id and the remainder of the path.
type ParsedObjectKey struct {
	SnapshotID string
	Rest       string
}

// ParseObjectKey validates key against the shared object-key contract and,
// if valid, returns its decomposition. Pure string operations only — no
// filepath.Clean, no case folding, no decoding.
func ParseObjectKey(key string) (ParsedObjectKey, bool) {
	if strings.Contains(key, "\x00") || strings.Contains(key, "\\") {
		return ParsedObjectKey{}, false
	}
	m := objectKeyPattern.FindStringSubmatch(key)
	if m == nil {
		return ParsedObjectKey{}, false
	}
	snapshotID, rest := m[1], m[2]
	if rest == "" || strings.HasSuffix(rest, "/") {
		return ParsedObjectKey{}, false
	}
	for _, seg := range strings.Split(rest, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return ParsedObjectKey{}, false
		}
	}
	return ParsedObjectKey{SnapshotID: snapshotID, Rest: rest}, true
}

// IsExternalObjectKey classifies key relative to ownSnapshotID: external is
// true when key is a valid object key whose snapshot segment differs
// (exact, case-sensitive) from ownSnapshotID. ok is false when key fails
// ParseObjectKey — the caller MUST treat that as a hard refusal, never as
// "own" (fail closed on an unparseable key).
func IsExternalObjectKey(key, ownSnapshotID string) (external bool, originID string, ok bool) {
	parsed, valid := ParseObjectKey(key)
	if !valid {
		return false, "", false
	}
	return parsed.SnapshotID != ownSnapshotID, parsed.SnapshotID, true
}
```

`types.go:36-47` becomes:
```go
type AuthenticatedDownloadDescriptor struct {
	Type                string   `json:"type"`
	Method              string   `json:"method"`
	URL                 string   `json:"url"`
	TokenQueryParam     string   `json:"tokenQueryParam,omitempty"`
	TokenHeaderName     string   `json:"tokenHeaderName,omitempty"`
	TokenHeaderFormat   string   `json:"tokenHeaderFormat,omitempty"`
	PathQueryParam      string   `json:"pathQueryParam"`
	RequiresAuthSession bool     `json:"requiresAuthentication"`
	PathPrefix          string   `json:"pathPrefix"`
	ExpiresAt           string   `json:"expiresAt"`
	Capabilities        []string `json:"capabilities,omitempty"`
}
```

`types.go:49-62` becomes (add `FileIndex` after `BackupType`, add the new `FileIndexInfo` type immediately after):
```go
type AuthenticatedSnapshot struct {
	ID                  string          `json:"id"`
	SnapshotID          string          `json:"snapshotId"`
	Size                int64           `json:"size"`
	FileCount           int             `json:"fileCount"`
	HardwareProfile     json.RawMessage `json:"hardwareProfile"`
	SystemStateManifest json.RawMessage `json:"systemStateManifest"`
	BackupType          string          `json:"backupType"`
	// FileIndex is present only when the client negotiated
	// CapabilitySnapshotFileMembershipV1 AND the snapshot's owning job
	// reports referenced_files > 0 (Part 0 §1). Its Status is always
	// "complete" by the time the agent sees it — the server refuses the
	// authenticate/exchange call itself while hydration is pending
	// (Part 0 §1 negotiateRecoveryCapabilities), so a non-complete
	// FileIndexInfo can never legitimately reach the agent.
	FileIndex *FileIndexInfo `json:"fileIndex,omitempty"`
}

// FileIndexInfo mirrors apps/api/src/services/recoveryBootstrap.ts's
// buildAuthenticatedBootstrapPayload snapshot.fileIndex shape field-for-field.
type FileIndexInfo struct {
	Status            string   `json:"status"`
	ManifestSHA256    string   `json:"manifestSha256"`
	ExternalCount     int      `json:"externalCount"`
	OriginSnapshotIDs []string `json:"originSnapshotIds"`
}
```

`session.go:144-149` (`ExchangeRecoveryCode`) — replace the `map[string]string` marshal with a named request type:
```go
type exchangeCodeRequest struct {
	Code         string   `json:"code"`
	Capabilities []string `json:"capabilities,omitempty"`
}
```
and change the marshal call from `json.Marshal(map[string]string{"code": code})` to `json.Marshal(exchangeCodeRequest{Code: code, Capabilities: ClientCapabilities()})`. No other line in `ExchangeRecoveryCode` changes.

`session.go:247-252` (`authenticateRecoverySessionContext`) — same treatment:
```go
type authenticateRequest struct {
	Token        string   `json:"token"`
	Capabilities []string `json:"capabilities,omitempty"`
}
```
change `json.Marshal(map[string]string{"token": token})` to `json.Marshal(authenticateRequest{Token: token, Capabilities: ClientCapabilities()})`.

`session_test.go:24` — the pre-existing `TestAuthenticateRecoverySession` decodes the outgoing request body to assert on it; its target type cannot hold the new `capabilities` array:
```go
// before:
var body map[string]string
require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
// after:
var body map[string]json.RawMessage
require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
```
(update whatever assertions the test makes against `body["token"]`/etc. accordingly — a `map[string]json.RawMessage` value is raw JSON bytes, e.g. `body["token"]` is now `[]byte(`"token-1"`)`, not `"token-1"`; unmarshal the specific fields the test actually asserts on rather than comparing raw bytes.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go build ./... && GOOS=windows go build ./... && go test -race ./internal/backup/bmr/...`
Expected: PASS (all of `objectkey_test.go`, `capabilities_test.go`, the new `session_test.go` cases, and every pre-existing `bmr` package test — including the pre-existing `TestAuthenticateRecoverySession`, which requires the `session_test.go:24` decode-type fix above; without it, that test fails to compile/decode against the new `capabilities` field and is NOT green "as-is").

- [ ] **Step 5: Commit**

```bash
git add agent/internal/backup/bmr/capabilities.go agent/internal/backup/bmr/objectkey.go \
  agent/internal/backup/bmr/testdata/object-key-vectors.json agent/internal/backup/bmr/types.go \
  agent/internal/backup/bmr/session.go agent/internal/backup/bmr/objectkey_test.go \
  agent/internal/backup/bmr/capabilities_test.go agent/internal/backup/bmr/session_test.go
git commit -m "$(cat <<'EOF'
feat(bmr): snapshot-file-membership-v1 capability, shared object-key parser (W09b)

Adds the client-side capability constant, a pure Go object-key parser
pinned to the same testdata/object-key-vectors.json the API's Vitest
suite reads, and the wire fields (Capabilities, FileIndexInfo) the
server's negotiated-capability bootstrap response will carry.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Admissible set in the download provider; refresh preserves it

**Files:**
- Modify: `agent/internal/backup/bmr/download_provider.go` — struct `recoveryDownloadProvider` (lines 204-236), constructor `newRecoveryDownloadProvider` (238-249), `downloadOnce` (448-526)
- Modify: `agent/internal/backup/bmr/download_session.go:113-130` (`authenticateAndSwap`)
- Test: `agent/internal/backup/bmr/download_provider_test.go`, `agent/internal/backup/bmr/download_session_test.go`

**Deviation:** the stub cites `download_provider.go:448-457` for the prefix check; verified research shows `downloadOnce` spans `448-526` and the prefix check + `io.Copy` are inside that range, not a narrower `448-457`/`:517` split. Treat `448-526` as the function boundary. This plan does not reproduce the untouched parts of `downloadOnce`/`Download` byte-for-byte (they were summarized, not re-quoted, by the research pass) — **before editing, run `sed -n '440,530p' agent/internal/backup/bmr/download_provider.go`** to see the live text, then apply the edits below by locating the described anchors (the prefix-check `if` block, the mutex field list, the constructor body) rather than a blind line-range replace.

**Interfaces (Produces):** `ErrCapabilityDowngrade`, `(*recoveryDownloadProvider) MembershipNegotiated() bool`, `(*recoveryDownloadProvider) ExtendAdmissible(keys []string)`, `(*recoveryDownloadProvider) Admits(key string) bool` — this trio is exactly what Task 10's `scopedProvider` interface names.

- [ ] **Step 1: Write the failing tests**

`download_provider_test.go` additions (package `bmr`; reuses the existing `httptest.NewServer` + `newRecoveryDownloadProvider` pattern already in this file):
```go
func TestRecoveryDownloadProvider_OwnPrefixAlwaysAllowed(t *testing.T) {
	var requested int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requested, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data"))
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
	})
	dest := filepath.Join(t.TempDir(), "out")
	require.NoError(t, p.Download("snapshots/gen-2/files/a.gz", dest))
	require.EqualValues(t, 1, atomic.LoadInt32(&requested))
}

func TestRecoveryDownloadProvider_ExternalKeyRefusedWithoutAdmission(t *testing.T) {
	var requested int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requested, 1)
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
	})
	err := p.Download("snapshots/gen-1/files/a.gz", filepath.Join(t.TempDir(), "out"))
	require.Error(t, err)
	require.EqualValues(t, 0, atomic.LoadInt32(&requested), "no HTTP request for a key outside the admissible set")
}

func TestRecoveryDownloadProvider_ExternalKeyAllowedOnceAdmittedWithMembership(t *testing.T) {
	var requested int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requested, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data"))
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
		Capabilities: []string{CapabilitySnapshotFileMembershipV1},
	})
	require.True(t, p.MembershipNegotiated())
	p.ExtendAdmissible([]string{"snapshots/gen-1/files/a.gz"})
	require.True(t, p.Admits("snapshots/gen-1/files/a.gz"))
	require.NoError(t, p.Download("snapshots/gen-1/files/a.gz", filepath.Join(t.TempDir(), "out")))
	require.EqualValues(t, 1, atomic.LoadInt32(&requested))
}

func TestRecoveryDownloadProvider_ExternalKeyRefusedWithoutMembershipEvenIfListed(t *testing.T) {
	// Belt-and-braces: a key must never be admitted from ExtendAdmissible
	// alone if the descriptor never granted the capability (this defends
	// against a future caller widening the set without checking
	// MembershipNegotiated() first).
	p := newRecoveryDownloadProvider(context.Background(), "http://example.invalid", "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: "http://example.invalid/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
	})
	p.ExtendAdmissible([]string{"snapshots/gen-1/files/a.gz"})
	require.False(t, p.MembershipNegotiated())
	require.False(t, p.Admits("snapshots/gen-1/files/a.gz"))
}
```

`download_session_test.go` additions (package `bmr`):
```go
func TestDownloadSession_RefreshPreservesAdmissibleSet(t *testing.T) {
	authCalls := int32(0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/recover/authenticate"):
			atomic.AddInt32(&authCalls, 1)
			writeTestBootstrapEnvelope(t, w, "gen-2", false)
		case strings.Contains(r.URL.Path, "/download"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("data"))
		}
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
		Capabilities: []string{CapabilitySnapshotFileMembershipV1},
	})
	p.ExtendAdmissible([]string{"snapshots/gen-1/files/a.gz"})

	require.NoError(t, p.authenticateAndSwap())
	require.EqualValues(t, 1, atomic.LoadInt32(&authCalls))
	require.True(t, p.Admits("snapshots/gen-1/files/a.gz"), "admissible set must survive a session refresh")
}

func TestDownloadSession_RefreshWithoutCapabilityReturnsDowngradeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/recover/authenticate") {
			// simulate a server that stops granting the capability on
			// re-authenticate (e.g. downgraded/misconfigured server)
			writeTestBootstrapEnvelope(t, w, "gen-2", false)
		}
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
		Capabilities: []string{CapabilitySnapshotFileMembershipV1},
	})
	beforeGen := p.generation

	err := p.authenticateAndSwap()
	require.ErrorIs(t, err, ErrCapabilityDowngrade)
	require.Equal(t, beforeGen, p.generation, "a rejected swap must not bump the generation")
	require.True(t, p.MembershipNegotiated(), "the previous descriptor's capability must be restored, not dropped")
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/bmr/ -run 'RecoveryDownloadProvider|DownloadSession_Refresh' 2>&1 | head -30`
Expected: compile errors (`MembershipNegotiated`, `ExtendAdmissible`, `Admits`, `ErrCapabilityDowngrade` undefined), then once those compile, behavioral failures (external key currently refused unconditionally by the existing hard prefix check — there is no admission path yet).

- [ ] **Step 3: Implement**

Add to `download_provider.go`, in the `recoveryDownloadProvider` struct (locate the existing `mu sync.RWMutex` field group and add two fields beside `descriptor`/`generation`):
```go
	// admissible holds exact external object keys widened into scope by
	// bmr.ApplyManifestScope (scope.go, Task 10) after the manifest is
	// downloaded. Guarded by mu, same as descriptor/generation. Keys are
	// never removed — only ever added — for the life of the provider.
	admissible map[string]struct{}
	// membership mirrors HasCapability(descriptor.Capabilities,
	// CapabilitySnapshotFileMembershipV1) at construction/last swap time.
	membership bool
```

Update `newRecoveryDownloadProvider` to initialize both:
```go
func newRecoveryDownloadProvider(ctx context.Context, serverURL, token string, descriptor *AuthenticatedDownloadDescriptor) *recoveryDownloadProvider {
	d := rewriteDescriptorOrigin(serverURL, descriptor)
	return &recoveryDownloadProvider{
		ctx:        ctx,
		serverURL:  serverURL,
		token:      token,
		descriptor: d,
		lastAuthAt: time.Now(),
		now:        time.Now,
		admissible: make(map[string]struct{}),
		membership: d != nil && HasCapability(d.Capabilities, CapabilitySnapshotFileMembershipV1),
	}
}
```

Add three new methods (new block, after the constructor):
```go
// ErrCapabilityDowngrade is returned by authenticateAndSwap when a session
// refresh's fresh descriptor no longer grants
// CapabilitySnapshotFileMembershipV1 but the provider had already negotiated
// it — the admissible set built from the old descriptor could then admit
// keys the server no longer authorizes. The previous descriptor is kept in
// place; the caller (bmr.go / rebuild_cmd.go) treats this as a hard refusal.
var ErrCapabilityDowngrade = errors.New("bmr: server dropped snapshot-file-membership-v1 on session refresh")

// MembershipNegotiated reports whether the current descriptor grants
// CapabilitySnapshotFileMembershipV1.
func (p *recoveryDownloadProvider) MembershipNegotiated() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.membership
}

// ExtendAdmissible widens the admissible set with exact external object
// keys. It does not itself check MembershipNegotiated — downloadOnce and
// Admits are the enforcement points, so a caller that widens the set on a
// non-membership provider still cannot download anything through it.
func (p *recoveryDownloadProvider) ExtendAdmissible(keys []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, k := range keys {
		p.admissible[k] = struct{}{}
	}
}

// Admits reports whether key is a member of the admissible set under an
// active membership grant. It is the exact predicate downloadOnce uses for
// external keys and must be called while NOT already holding p.mu (it
// acquires its own read lock).
func (p *recoveryDownloadProvider) Admits(key string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if !p.membership {
		return false
	}
	_, ok := p.admissible[key]
	return ok
}
```

In `downloadOnce`, locate the existing hard prefix-refusal (the real code's exact-match branch: `if normalizedRemotePath != normalizedPrefix && !strings.HasPrefix(normalizedRemotePath, normalizedPrefix+"/") { ... }`, around line 454-457 per the stub / within 448-526 per verification) and replace it with an admission check that allows own-prefix (exact match OR prefix match) OR an admitted external key — preserving the pre-existing exact-match branch, not just the prefix branch:
```go
	ownPrefix := normalizedPrefix + "/"
	if normalizedRemotePath != normalizedPrefix && !strings.HasPrefix(normalizedRemotePath, ownPrefix) {
		if !p.Admits(remotePath) {
			return fmt.Errorf("bmr: requested path %q is not an authorized object of snapshot %q", remotePath, normalizedPrefix)
		}
	}
```
(Use `remotePath`, the original un-normalized argument passed to `downloadOnce`/`Download`, as the admission-check key — `ExtendAdmissible` is populated with the exact keys from the manifest's `BackupPath` entries in Task 10, which are the same string form `Admits` must match against; do not normalize/clean the key before checking `Admits`, only for the prefix-vs-own comparison, to avoid a byte-for-byte mismatch against what was widened.)

In `download_session.go`, `authenticateAndSwap` (113-130) — keep the REAL function body unchanged (re-read it first with `sed -n '113,130p' agent/internal/backup/bmr/download_session.go`; it begins with the `bootstrap.Download == nil` guard, ends with the `p.lastAuthAt`/`p.authNotBefore` reset and `slog.Info` call, and must not be replaced wholesale) and insert only the two marked lines — the `newMembership` computation plus the downgrade guard immediately before the existing descriptor-swap block, and the `p.membership = newMembership` assignment next to `p.generation++`:
```go
func (p *recoveryDownloadProvider) authenticateAndSwap() error {
	bootstrap, err := authenticateRecoverySessionContext(p.ctx, p.serverURL, p.token)
	if err != nil {
		return err
	}
	if bootstrap.Download == nil {
		return errRefreshMissingDescriptor
	}
	descriptor := rewriteDescriptorOrigin(p.serverURL, bootstrap.Download)

	// --- inserted (Task 9): compute the fresh capability and refuse the
	// swap outright if it drops a capability the provider already relies
	// on — keep the previous descriptor and generation, never shrink or
	// drop the admissible set.
	newMembership := descriptor != nil && HasCapability(descriptor.Capabilities, CapabilitySnapshotFileMembershipV1)

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.membership && !newMembership {
		return ErrCapabilityDowngrade
	}
	// --- end inserted block ---

	p.descriptor = descriptor
	p.generation++
	p.membership = newMembership // inserted (Task 9), alongside the existing generation bump
	p.lastAuthAt = p.now()
	p.authNotBefore = time.Time{}
	slog.Info("bmr: recovery session refreshed", "generation", p.generation)
	return nil
}
```
(The exact statement order of the pre-existing `p.lastAuthAt`/`p.authNotBefore`/`slog.Info` lines and any other bookkeeping the real function performs was not independently re-verified in this research pass since `download_session.go` does not exist yet in this worktree — **before implementing Task 9, re-read the live function once it exists and confirm this order; insert only the two marked lines above, do not reorder or drop anything else the real function does.**)

- [ ] **Step 4: Run tests**

Run: `cd agent && go build ./... && GOOS=windows go build ./... && go test -race ./internal/backup/bmr/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/backup/bmr/download_provider.go agent/internal/backup/bmr/download_session.go \
  agent/internal/backup/bmr/download_provider_test.go agent/internal/backup/bmr/download_session_test.go
git commit -m "$(cat <<'EOF'
feat(bmr): admissible external-object set in the download provider (W09b)

The download provider now allows an external object key only when the
negotiated descriptor granted snapshot-file-membership-v1 AND the exact
key was explicitly widened into scope. A session refresh that drops the
capability is refused (ErrCapabilityDowngrade) rather than silently
shrinking the admissible set.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Scope widening from the manifest + refuse-before-provision gates

**Files:**
- Create: `agent/internal/backup/bmr/scope.go`
- Modify: `agent/internal/backup/bmr/bmr.go:288-313` (`downloadManifest` gains a returned sha256 and a caller-side scope check), around lines 813-830 (`restoreFiles`'s caller, `RunRecoveryWithTokenContext`, gets the scope-check call before any restore work)
- Modify: `agent/cmd/breeze-backup/rebuild_cmd.go:181-231` (`buildTokenModeOptions` — **already exists**; add the `WidenScopeFromManifest` call after `bmr.NewRecoveryProvider`)
- Modify: `agent/cmd/breeze-backup/exec_bare_metal_rebuild.go` (**already exists in full**, 120 lines — it calls `buildTokenModeOptions` then `runTokenModeRebuild`; no change needed here beyond what `buildTokenModeOptions` already propagates, since the refusal surfaces through the same error path `execBareMetalRebuild` already handles — verify with `sed -n '75,120p' agent/cmd/breeze-backup/exec_bare_metal_rebuild.go` that a `buildTokenModeOptions` error today is already turned into a `fail(...)` result; if it is, this file needs NO changes for this task)
- Modify: `agent/internal/backup/rebuild/types.go` (add `ObjectAdmission` interface), `agent/internal/backup/rebuild/preflight.go` (after the `fetchManifest` call at line 143, add the admission sweep)
- Test: `agent/internal/backup/bmr/scope_test.go`, additions to `agent/internal/backup/bmr/bmr_test.go`, additions to `agent/cmd/breeze-backup/rebuild_cmd_token_test.go`, additions to `agent/internal/backup/rebuild/engine_test.go`

**Deviation:** the stub's Task 10 assumed `buildTokenModeOptions` needed to be extracted from a token branch inside `rebuild_cmd.go`, and that `exec_bare_metal_rebuild.go` needed to be created. Verified research (W05a is already implemented in this worktree) shows **both already exist**: `buildTokenModeOptions` at `rebuild_cmd.go:181-231`, `runTokenModeRebuild` at `rebuild_cmd.go:285-325`, and `exec_bare_metal_rebuild.go` is a complete 120-line file with `execBareMetalRebuild`. This task modifies `buildTokenModeOptions` in place; it creates nothing in `cmd/breeze-backup`.

**Note (controller-verified 2026-09-20):** `restore_tree.go:80` IS the unbounded join — `msg := fmt.Sprintf("%d file(s) failed to restore: %s", res.FilesFailed, strings.Join(res.FailedFiles, ", "))` — and that `msg` becomes the returned error when `AllowPartialRestore` is false (so it lands in the phase message, `Result.Error` and the CLI's progress `reason`). Task 11 replaces it with the 50-entry sample message. `r.failedFiles` (the map at `:85-88`) is the internal set `validate.go:48` consumes and is never truncated.

**Deviation:** `rebuild.Run` returns `(r.result, err)` on refusal with **`err` non-nil** (verified `engine.go:138-145`) — the refusal is not a "success with a Refusal field," it is also a Go error. Every new call site added by this task must check `res.Status == "refused"` via `errors.As(err, &RefusalError{})`, matching the existing `engine.go` idiom, not `err == nil && res.Refusal != ""`.

**Interfaces (Produces):**
```go
// scope.go
type ScopeRefusalError struct{ Reason string; External int; First string }
func (e *ScopeRefusalError) Error() string
type scopedProvider interface {
	MembershipNegotiated() bool
	ExtendAdmissible(keys []string)
	Admits(key string) bool
}
func ExternalObjectKeys(backupPaths []string, ownSnapshotID string) (external []string, bad []string)
func ApplyManifestScope(provider providers.BackupProvider, ownSnapshotID string, backupPaths []string, manifestSHA256 string, fi *FileIndexInfo) error
func WidenScopeFromManifest(ctx context.Context, provider providers.BackupProvider, bs *BootstrapResponse) error

// rebuild/types.go
type ObjectAdmission interface{ Admits(key string) bool }
```

- [ ] **Step 1: Write the failing tests**

`scope_test.go` (package `bmr`):
```go
package bmr

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/require"
)

type nonScopedProvider struct{ files map[string][]byte }

func (p *nonScopedProvider) Upload(string, string) error   { return nil }
func (p *nonScopedProvider) Download(remote, local string) error {
	return writeTestFile(local, p.files[remote])
}
func (p *nonScopedProvider) List(string) ([]string, error) { return nil, nil }
func (p *nonScopedProvider) Delete(string) error            { return nil }

// scopedTestProvider implements scopedProvider on top of nonScopedProvider
// so ApplyManifestScope's interface-assertion branch can be exercised.
type scopedTestProvider struct {
	nonScopedProvider
	membership bool
	admitted   map[string]struct{}
}

func (p *scopedTestProvider) MembershipNegotiated() bool { return p.membership }
func (p *scopedTestProvider) ExtendAdmissible(keys []string) {
	if p.admitted == nil {
		p.admitted = map[string]struct{}{}
	}
	for _, k := range keys {
		p.admitted[k] = struct{}{}
	}
}
func (p *scopedTestProvider) Admits(key string) bool { _, ok := p.admitted[key]; return ok }

func TestExternalObjectKeys_SplitsOwnFromExternalAndBad(t *testing.T) {
	external, bad := ExternalObjectKeys([]string{
		"snapshots/gen-2/files/own.gz",
		"snapshots/gen-1/files/ext.gz",
		"snapshots/gen-1/files/ext.gz", // duplicate, de-duplicated
		"snapshots/gen-2/", // invalid
	}, "gen-2")
	require.Equal(t, []string{"snapshots/gen-1/files/ext.gz"}, external)
	require.Equal(t, []string{"snapshots/gen-2/"}, bad)
}

func TestApplyManifestScope_NonScopedProviderIsNoConfinement(t *testing.T) {
	p := &nonScopedProvider{}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha", nil)
	require.NoError(t, err)
}

func TestApplyManifestScope_NoExternalEntriesIsFine(t *testing.T) {
	p := &scopedTestProvider{membership: false}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-2/files/a.gz"}, "sha", nil)
	require.NoError(t, err)
}

func TestApplyManifestScope_ExternalWithoutMembershipRefuses(t *testing.T) {
	p := &scopedTestProvider{membership: false}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha", nil)
	var refusal *ScopeRefusalError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, 1, refusal.External)
	require.Contains(t, refusal.Reason, "cross-snapshot")
}

func TestApplyManifestScope_MissingOrIncompleteFileIndexRefuses(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha-actual", nil)
	require.Error(t, err)

	err = ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha-actual",
		&FileIndexInfo{Status: "hydrating", ManifestSHA256: "sha-actual"})
	require.Error(t, err)
}

func TestApplyManifestScope_ShaMismatchRefuses(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha-actual",
		&FileIndexInfo{Status: "complete", ManifestSHA256: "sha-different"})
	require.Error(t, err)
}

func TestApplyManifestScope_GrantedPathExtendsAdmissibleSet(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz", "snapshots/gen-2/files/own.gz"}, "sha-actual",
		&FileIndexInfo{Status: "complete", ManifestSHA256: "sha-actual"})
	require.NoError(t, err)
	require.True(t, p.Admits("snapshots/gen-1/files/a.gz"))
}

func TestApplyManifestScope_BadKeyAlwaysRefusesRegardlessOfMembership(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-2/"}, "sha-actual",
		&FileIndexInfo{Status: "complete", ManifestSHA256: "sha-actual"})
	var refusal *ScopeRefusalError
	require.ErrorAs(t, err, &refusal)
}

func TestWidenScopeFromManifest_DownloadsHashesAndAppliesScope(t *testing.T) {
	manifestJSON := `{"id":"gen-2","files":[{"backupPath":"snapshots/gen-1/files/a.gz","size":1},{"backupPath":"snapshots/gen-2/files/b.gz","size":1}]}`
	sum := sha256.Sum256([]byte(manifestJSON))
	sha := hex.EncodeToString(sum[:])

	files := map[string][]byte{"snapshots/gen-2/manifest.json": []byte(manifestJSON)}
	p := &scopedTestProvider{membership: true, nonScopedProvider: nonScopedProvider{files: files}}
	bs := &BootstrapResponse{Snapshot: &AuthenticatedSnapshot{SnapshotID: "gen-2",
		FileIndex: &FileIndexInfo{Status: "complete", ManifestSHA256: sha}}}

	require.NoError(t, WidenScopeFromManifest(context.Background(), p, bs))
	require.True(t, p.Admits("snapshots/gen-1/files/a.gz"))
}
```
(`writeTestFile` is a small helper — if `bmr_test.go` already has an equivalent temp-file writer for `memProvider`-style fakes, reuse it instead of adding a duplicate; grep `func write.*File` in `agent/internal/backup/bmr/*_test.go` first.)

Additions to `bmr_test.go` — token-mode recovery refuses before any file write:
```go
func TestRunRecoveryWithTokenContext_RefusesBeforeAnyWriteWhenScopeDenied(t *testing.T) {
	// Build a fake provider carrying a two-generation manifest (gen-2
	// references gen-1) and a descriptor WITHOUT the membership
	// capability; assert RunRecoveryWithTokenContext returns a "refused"
	// RecoveryResult with FilesRestored == 0 and never calls
	// provider.Download for any content key other than the manifest
	// itself.
	// ... construct via the existing fakeserver-backed test harness this
	// file already uses for token-mode recovery tests (see the setup in
	// the pre-existing TestRunRecoveryWithTokenContext_* cases in this
	// file) — mirror that setup exactly, seeding SnapshotID "gen-2" with
	// one referenced entry under "gen-1" and NO capability granted by the
	// fake server's bootstrap.
}
```

Additions to `agent/cmd/breeze-backup/rebuild_cmd_token_test.go`:
```go
func TestBuildTokenModeOptions_RefusesWithoutCapabilityWhenManifestHasExternalRefs(t *testing.T) {
	server, statuses := newTokenModeTestServerWithReferencedFiles(t, /* no capability granted */ nil)
	defer server.Close()

	_, _, err := buildTokenModeOptions(context.Background(), server.URL, "tok", rebuild.Target{Kind: rebuild.TargetImage, Path: filepath.Join(t.TempDir(), "out.img")}, "")
	require.Error(t, err)
	require.Equal(t, []string{"refused"}, statuses())
}

func TestBuildTokenModeOptions_ProceedsWithCapabilityAndMatchingSha(t *testing.T) {
	server, statuses := newTokenModeTestServerWithReferencedFiles(t, []string{bmr.CapabilitySnapshotFileMembershipV1})
	defer server.Close()

	_, report, err := buildTokenModeOptions(context.Background(), server.URL, "tok", rebuild.Target{Kind: rebuild.TargetImage, Path: filepath.Join(t.TempDir(), "out.img")}, "")
	require.NoError(t, err)
	require.NotNil(t, report)
	require.Empty(t, statuses(), "no refusal should have been posted yet")
}
```
(`newTokenModeTestServerWithReferencedFiles` is a new test helper, modeled on the existing `newTokenModeTestServer`/`newTokenModeTestServerWithRecovery` in the same file — write it to seed a two-generation manifest and optionally grant the capability in the authenticate response, following the exact envelope shape those existing helpers already use.)

`engine_test.go` addition — preflight refuses when the provider doesn't admit a manifest entry:
```go
type admittingMemProvider struct {
	memProvider
	admitted map[string]struct{}
}

func (p *admittingMemProvider) Admits(key string) bool { _, ok := p.admitted[key]; return ok }

func TestRun_PreflightRefusesWhenManifestEntryNotAdmitted(t *testing.T) {
	sys := newFakeSystem(t)
	prov := &admittingMemProvider{memProvider: *seededMemProvider(t), admitted: map[string]struct{}{}}
	// seededMemProvider's manifest (from the existing test corpus this
	// package already builds for TestRun_PreflightRefusals) must contain
	// at least one content entry whose BackupPath is NOT in
	// prov.admitted — grep TestRun_PreflightRefusals's `mutate` cases for
	// the manifest-seeding helper this suite already uses and reuse it,
	// rather than hand-building a second fixture.
	opts := baseOptions(t, sys, prov) // existing helper used by other engine_test.go cases
	opts.Provider = prov

	res, err := Run(context.Background(), opts)
	var refusal *RefusalError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "refused", res.Status)
	require.False(t, sys.has("sgdisk"), "provision must never run once preflight refuses")
	require.False(t, sys.has("mkfs"))
	require.False(t, sys.has("mount"))
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go build ./internal/backup/bmr/... ./internal/backup/rebuild/... ./cmd/breeze-backup/... 2>&1 | head -40`
Expected: compile errors for `ScopeRefusalError`, `ApplyManifestScope`, `WidenScopeFromManifest`, `ObjectAdmission` undefined; once those are stubbed in, behavioral failures (preflight does not yet refuse, `buildTokenModeOptions` does not yet call `WidenScopeFromManifest`).

- [ ] **Step 3: Implement**

`scope.go`:
```go
package bmr

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"sort"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// ScopeRefusalError is returned by ApplyManifestScope when the manifest
// cannot be honoured safely: an unparseable object key, or external
// references present without a negotiated, verified, matching file index.
type ScopeRefusalError struct {
	Reason   string
	External int
	First    string
}

func (e *ScopeRefusalError) Error() string { return "bmr: " + e.Reason }

// scopedProvider is implemented by *recoveryDownloadProvider (download_provider.go,
// Task 9). A provider that does not implement it (e.g. the local/S3
// providers used outside token-mode recovery) is never confined — see
// ApplyManifestScope's first branch.
type scopedProvider interface {
	MembershipNegotiated() bool
	ExtendAdmissible(keys []string)
	Admits(key string) bool
}

// ExternalObjectKeys returns the sorted, de-duplicated keys of content
// entries whose snapshot segment differs from ownSnapshotID. A key that
// fails ParseObjectKey is returned in bad (also sorted, de-duplicated) —
// callers must treat any non-empty bad as a hard refusal, never silently
// skip it.
func ExternalObjectKeys(backupPaths []string, ownSnapshotID string) (external []string, bad []string) {
	extSet := map[string]struct{}{}
	badSet := map[string]struct{}{}
	for _, key := range backupPaths {
		if key == "" {
			continue
		}
		ext, _, ok := IsExternalObjectKey(key, ownSnapshotID)
		if !ok {
			badSet[key] = struct{}{}
			continue
		}
		if ext {
			extSet[key] = struct{}{}
		}
	}
	for k := range extSet {
		external = append(external, k)
	}
	for k := range badSet {
		bad = append(bad, k)
	}
	sort.Strings(external)
	sort.Strings(bad)
	return external, bad
}

// ApplyManifestScope is called once, after the manifest is downloaded and
// BEFORE any target write. It never performs I/O itself (that is
// WidenScopeFromManifest's job) — it only classifies backupPaths and
// decides whether the provider's admissible set may be widened.
func ApplyManifestScope(provider providers.BackupProvider, ownSnapshotID string, backupPaths []string, manifestSHA256 string, fi *FileIndexInfo) error {
	sp, ok := provider.(scopedProvider)
	if !ok {
		// Not a token-mode recovery provider (e.g. CLI --target against a
		// plain S3/local provider outside the recovery flow) — no
		// confinement applies.
		return nil
	}

	external, bad := ExternalObjectKeys(backupPaths, ownSnapshotID)
	if len(bad) > 0 {
		return &ScopeRefusalError{
			Reason: fmt.Sprintf("manifest contains %d unparseable object key(s) (first: %q); refusing rather than guessing scope", len(bad), bad[0]),
			First:  bad[0],
		}
	}
	if len(external) == 0 {
		return nil
	}
	if !sp.MembershipNegotiated() {
		return &ScopeRefusalError{
			Reason:   fmt.Sprintf("this backup references %d file(s) stored with earlier snapshots and the server did not grant cross-snapshot downloads. Upgrade the Breeze server or choose a self-contained (full) snapshot.", len(external)),
			External: len(external),
			First:    external[0],
		}
	}
	if fi == nil || fi.Status != "complete" {
		return &ScopeRefusalError{
			Reason:   "the server's file index for this snapshot is not ready (fileIndex missing or not complete); the recovery should not have reached this phase",
			External: len(external),
			First:    external[0],
		}
	}
	if fi.ManifestSHA256 != manifestSHA256 {
		return &ScopeRefusalError{
			Reason:   "the server's file index does not match this snapshot's manifest; create the recovery again.",
			External: len(external),
			First:    external[0],
		}
	}
	sp.ExtendAdmissible(external)
	return nil
}

// WidenScopeFromManifest downloads snapshots/<id>/manifest.json through
// provider into a temp file, hashes it, parses the entries, and calls
// ApplyManifestScope. bs.Snapshot must be non-nil (callers already require
// this for every other field they read off it).
func WidenScopeFromManifest(ctx context.Context, provider providers.BackupProvider, bs *BootstrapResponse) error {
	if bs == nil || bs.Snapshot == nil {
		return fmt.Errorf("bmr: WidenScopeFromManifest: bootstrap missing snapshot")
	}
	snapshotID := bs.Snapshot.SnapshotID

	tmp, err := os.CreateTemp("", "bmr-scope-manifest-*.json")
	if err != nil {
		return fmt.Errorf("bmr: create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)

	manifestKey := "snapshots/" + snapshotID + "/manifest.json"
	if err := provider.Download(manifestKey, tmpPath); err != nil {
		return fmt.Errorf("bmr: download manifest for scope check: %w", err)
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return fmt.Errorf("bmr: read manifest for scope check: %w", err)
	}
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])

	var manifest snapshotManifest
	if err := jsonUnmarshalManifest(data, &manifest); err != nil {
		return fmt.Errorf("bmr: decode manifest for scope check: %w", err)
	}
	paths := make([]string, 0, len(manifest.Files))
	for _, f := range manifest.Files {
		if f.BackupPath == "" {
			continue // dirs/symlinks/placeholders carry no BackupPath
		}
		paths = append(paths, f.BackupPath)
	}
	return ApplyManifestScope(provider, snapshotID, paths, sha, bs.Snapshot.FileIndex)
}
```
`jsonUnmarshalManifest` is a one-line wrapper (`func jsonUnmarshalManifest(data []byte, m *snapshotManifest) error { return json.Unmarshal(data, m) }`) — only needed if `bmr.go`'s `downloadManifest` doesn't already expose a reusable unmarshal step; simpler: call `json.Unmarshal(data, &manifest)` directly in `WidenScopeFromManifest` and drop the wrapper (prefer this — one fewer indirection). Import `encoding/json` in `scope.go` instead.

`bmr.go:288-313` (`downloadManifest`) — change its signature to also return the sha256, since `RunRecoveryWithTokenContext`'s restore path needs the same hash `WidenScopeFromManifest` computed (avoid downloading the manifest twice in the same recovery run when both the CLI token-mode path AND the library `RunRecoveryWithTokenContext` path are exercised — but note `buildTokenModeOptions` calls `WidenScopeFromManifest` BEFORE `rebuild.Run` even starts, and `bmr.go`'s `RunRecoveryWithTokenContext` is the *other*, older entry point used by `bmr_recover_cmd.go`'s plain `rebuild --token`-free flow — both must independently gate, since either can be the actual call path depending on which command the operator/DR system invokes):
```go
func downloadManifest(snapshotID string, provider providers.BackupProvider) (*snapshotManifest, string, error) {
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)

	tmpFile, err := os.CreateTemp("", "bmr-manifest-*.json")
	if err != nil {
		return nil, "", fmt.Errorf("bmr: create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := provider.Download(manifestKey, tmpPath); err != nil {
		return nil, "", fmt.Errorf("bmr: download manifest: %w", err)
	}

	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, "", fmt.Errorf("bmr: read manifest: %w", err)
	}
	sum := sha256.Sum256(data)

	var manifest snapshotManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, "", fmt.Errorf("bmr: decode manifest: %w", err)
	}
	return &manifest, hex.EncodeToString(sum[:]), nil
}
```
(add `crypto/sha256` and `encoding/hex` to `bmr.go`'s import block if not already present — verify with `head -20 agent/internal/backup/bmr/bmr.go` first, since `bmr.go` may already import them for other reasons per the ground-truth const block).

Update `downloadManifest`'s call site inside `RunRecoveryWithTokenContext` (`agent/internal/backup/bmr/bmr.go`, currently lines 66-70). The scope check MUST be inserted immediately after the `downloadManifest` / `err != nil` check and BEFORE the `// 2. Download and apply system state` block (the `applySystemState(ctx, cfg, provider)` call at line 81) — that block already performs a destructive target write, so the scope check must run before it, never after:
```go
	manifest, manifestSHA256, err := downloadManifest(cfg.SnapshotID, provider)
	if err != nil {
		result.Error = fmt.Sprintf("failed to download manifest: %s", err.Error())
		return result, err
	}

	paths := make([]string, 0, len(manifest.Files))
	for _, f := range manifest.Files {
		if f.BackupPath != "" {
			paths = append(paths, f.BackupPath)
		}
	}
	bs := currentBootstrap // the *BootstrapResponse this function already has in scope from authentication — reuse it, do not re-authenticate
	if scopeErr := ApplyManifestScope(provider, cfg.SnapshotID, paths, manifestSHA256, bs.Snapshot.FileIndex); scopeErr != nil {
		var refusal *ScopeRefusalError
		if errors.As(scopeErr, &refusal) {
			result.Status = "refused"
			result.Error = refusal.Reason
			return result, nil
		}
		return result, scopeErr
	}

	slog.Info("bmr: manifest downloaded",
		"files", len(manifest.Files),
		"snapshotSize", manifest.Size,
	)

	// 2. Download and apply system state.
	if checkCancelled() {
		return result, ctx.Err()
	}
	stateApplied, driversInjected, stateWarnings, stateErr := applySystemState(ctx, cfg, provider)
```
(The exact local variable name for the in-scope `*BootstrapResponse` inside `RunRecoveryWithTokenContext` was not independently re-verified in this research pass — **grep `RunRecoveryWithTokenContext` in `bmr.go` (around line 30 per Part 0's ground truth) for whatever variable holds the `*BootstrapResponse` returned by its own authenticate call, and substitute that name for `currentBootstrap` above.**)

`rebuild_cmd.go` — add the widen-scope call to the existing `buildTokenModeOptions` (181-231), immediately after the existing `bmr.NewRecoveryProvider(...)` call and before the function returns its `rebuild.Options`:
```go
	provider := bmr.NewRecoveryProvider(ctx, server, token, bs)
	if err := bmr.WidenScopeFromManifest(ctx, provider, bs); err != nil {
		var refusal *bmr.ScopeRefusalError
		if errors.As(err, &refusal) {
			report(bmr.ProgressUpdate{Status: "refused", Reason: refusal.Reason})
		}
		return rebuild.Options{}, nil, err
	}
```
(Insert this directly after the existing provider construction and before whatever the function currently does next — e.g. building `rebuild.Options{Provider: provider, ...}`. `runTokenModeRebuild` and hence `rebuild.Run`/`provision` are never reached on this path, since the caller returns the error immediately: both the CLI's `RunE` and `execBareMetalRebuild` already propagate a `buildTokenModeOptions` error as a `fail(...)`/non-zero-exit result without calling `runTokenModeRebuild` — confirm this by reading the ~15 lines after the `buildTokenModeOptions(...)` call site in both `rebuild_cmd.go`'s `RunE` and `exec_bare_metal_rebuild.go`'s `execBareMetalRebuild`.)

`rebuild/types.go` — add near the other small interfaces (e.g. next to `System`):
```go
// ObjectAdmission is implemented by a token-mode recovery provider
// (bmr.recoveryDownloadProvider) to let preflight refuse a manifest entry
// the provider would refuse to download anyway — the belt to
// bmr.ApplyManifestScope's braces. A provider that does not implement it
// (plain S3/local) is never confined here either.
type ObjectAdmission interface {
	Admits(key string) bool
}
```

`rebuild/preflight.go` — immediately after the existing `fetchManifest` call (line 143), add:
```go
	if admitter, ok := r.opts.Provider.(ObjectAdmission); ok {
		var n int
		var first string
		for _, f := range man.Files {
			if !f.HasContent() {
				continue
			}
			if !admitter.Admits(f.BackupPath) {
				if first == "" {
					first = f.BackupPath
				}
				n++
			}
		}
		if n > 0 {
			return &RefusalError{Reason: fmt.Sprintf("%d file(s) reference objects outside the authorized download scope (first: %s); upgrade the Breeze server or choose a self-contained snapshot", n, first)}
		}
	}
```
(`man` is whatever local variable name `fetchManifest`'s result is already assigned to at that call site — per the ground-truth code map this is likely `man` or `manifest`; confirm with `sed -n '135,155p' agent/internal/backup/rebuild/preflight.go` before inserting.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go build ./... && GOOS=windows go build ./... && go test -race ./internal/backup/bmr/... ./internal/backup/rebuild/... ./cmd/breeze-backup/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/backup/bmr/scope.go agent/internal/backup/bmr/scope_test.go \
  agent/internal/backup/bmr/bmr.go agent/internal/backup/bmr/bmr_test.go \
  agent/cmd/breeze-backup/rebuild_cmd.go agent/cmd/breeze-backup/rebuild_cmd_token_test.go \
  agent/internal/backup/rebuild/types.go agent/internal/backup/rebuild/preflight.go \
  agent/internal/backup/rebuild/engine_test.go
git commit -m "$(cat <<'EOF'
feat(bmr): widen download scope from the manifest before any target write (W09b)

WidenScopeFromManifest downloads and hashes the manifest, verifies it
against the server's negotiated fileIndex, and widens the token-mode
download provider's admissible set before rebuild.Run ever starts.
rebuild's own preflight independently refuses any manifest entry the
provider would not admit, so provision can never run ahead of the
scope check on either the CLI or the RunRecoveryWithTokenContext path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Bounded failure reporting

**Files:**
- Modify: `agent/internal/backup/rebuild/types.go` (`Result` gains `FilesFailed`, `FailedFilesSample`, `FailedFilesOmitted`)
- Modify: `agent/internal/backup/rebuild/restore_tree.go` (bound the failure message to the first 50 of `r.failedFiles`)
- Verify only (no edit): `agent/internal/backup/rebuild/engine.go` — `grep -n 'FailedFiles' agent/internal/backup/rebuild/engine.go` must return nothing; `r.result` is mutated in place by `restoreTree`, so the new fields ride along for free (see Step 3 note below)
- Modify: `agent/internal/backup/bmr/progress.go:18-91` (`BoundProgressUpdate`, applied inside `PostRecoveryProgress`)
- Test: `agent/internal/backup/rebuild/restore_tree_test.go`, additions to `agent/internal/backup/bmr/progress_test.go`

**Hazard:** `rebuild.Result.FilesFailed` (json `filesFailed`) and the pre-existing `bmr.RecoveryResult.FailedFiles` (json `failedFiles`, `bmr/types.go:138`) are different fields on different wire payloads — do not conflate them when reading a progress body.

**Deviation:** `r.failedFiles` is `map[string]bool` (verified `engine.go`/`restore_tree.go:85-88`), keyed by `SourcePath`, not a slice — "the first 50" needs a deterministic order, so the implementation below sorts the keys before truncating (map iteration order is randomized in Go; an unsorted sample would make `restore_tree_test.go` flaky and would make the "first N shown" message non-reproducible between runs).

**Interfaces (Produces):**
```go
// rebuild/types.go — Result gains:
FilesFailed         int      `json:"filesFailed"`
FailedFilesSample   []string `json:"failedFilesSample,omitempty"`
FailedFilesOmitted  int      `json:"failedFilesOmitted,omitempty"`

// bmr/progress.go
func BoundProgressUpdate(u ProgressUpdate) ProgressUpdate
```

- [ ] **Step 1: Write the failing tests**

`restore_tree_test.go` (new file, package `rebuild`):
```go
package rebuild

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRestoreTree_98411FailedFilesBoundsMessageAndCounts(t *testing.T) {
	sys := newFakeSystem(t)
	prov := &memProvider{files: map[string][]byte{}, failKey: map[string]error{}}
	const total = 105953
	const failed = 98411
	files := make([]SnapshotFileForTest, 0, total)
	for i := 0; i < total; i++ {
		key := fmt.Sprintf("snapshots/gen-1/files/%06d.gz", i)
		files = append(files, SnapshotFileForTest{SourcePath: fmt.Sprintf("/src/%06d", i), BackupPath: key})
		if i < failed {
			prov.failKey[key] = fmt.Errorf("simulated download failure")
		} else {
			prov.files[key] = []byte("x")
		}
	}
	r := newRunForRestoreTreeTest(t, sys, prov, files) // existing test helper this package already has for restore_tree tests; if it does not exist, build the run{} struct the same way TestRun_PreflightRefusals does (grep engine_test.go for "r := &run{")

	err := restoreTree(context.Background(), r)
	require.NoError(t, err, "partial restore is a warning, not a hard error, when AllowPartialRestore is set")

	require.Equal(t, failed, r.result.FilesFailed)
	require.Len(t, r.result.FailedFilesSample, 50)
	require.Equal(t, failed-50, r.result.FailedFilesOmitted)
	require.Len(t, r.failedFiles, failed, "the internal failedFiles map is never truncated — validate.go needs every entry")

	// the engine never sets Phases[last].Message on success; the bounded
	// message is appended via r.warn instead.
	found := false
	for _, w := range r.result.Warnings {
		if strings.Contains(w, "98411 file(s) failed to restore (first 50 shown)") {
			found = true
			break
		}
	}
	require.True(t, found, "expected a warning with the bounded failed-files message, got %v", r.result.Warnings)
}
```
(`SnapshotFileForTest`/`newRunForRestoreTreeTest` are placeholders for whatever fixture-building helper `restore_tree.go`'s existing tests already use — **before writing this test for real, run `grep -n 'func newRun\|func seed\|type.*Provider.*struct' agent/internal/backup/rebuild/*_test.go` and use the actual helper names**; do not introduce a second parallel fixture-building convention.)

Additions to `progress_test.go`:
```go
func TestBoundProgressUpdate_TruncatesWarningsAndFailedFilesSample(t *testing.T) {
	sample := make([]string, 200)
	for i := range sample {
		sample[i] = fmt.Sprintf("/src/%d", i)
	}
	warnings := make([]string, 100)
	for i := range warnings {
		warnings[i] = strings.Repeat("w", 3000)
	}
	u := ProgressUpdate{
		Status:   "failed",
		Reason:   strings.Repeat("r", 5000),
		Warnings: warnings,
		Result:   map[string]any{"failedFilesSample": sample, "filesFailed": 98411},
	}
	bounded := BoundProgressUpdate(u)

	require.LessOrEqual(t, len([]rune(bounded.Reason)), 2000)
	require.LessOrEqual(t, len(bounded.Warnings), 64)
	for _, w := range bounded.Warnings {
		require.LessOrEqual(t, len([]rune(w)), 2000)
	}
	body, err := json.Marshal(bounded)
	require.NoError(t, err)
	require.Less(t, len(body), 768*1024)
}

func TestBoundProgressUpdate_ExtremeBodyFallsBackToTruncatedSummary(t *testing.T) {
	// 50 entries of ~20 KiB each — the sample trim to 50 entries runs BEFORE
	// the size check, so a naive huge-count sample never reaches the
	// fallback branch. Making each of the (already-trimmed) 50 entries
	// individually large is what pushes the serialized body over 768 KiB
	// (50 × 20 KiB > 768 KiB) and forces the fallback to fire deterministically.
	sample := make([]string, 50)
	for i := range sample {
		sample[i] = strings.Repeat("x", 20*1024)
	}
	u := ProgressUpdate{Status: "failed", Result: map[string]any{"failedFilesSample": sample, "filesFailed": 200000}}
	bounded := BoundProgressUpdate(u)
	body, err := json.Marshal(bounded)
	require.NoError(t, err)
	require.Less(t, len(body), 768*1024)
	m, ok := bounded.Result.(map[string]any)
	require.True(t, ok)
	require.Equal(t, true, m["truncated"])
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/rebuild/ -run RestoreTree_98411 2>&1 | head -20 && go test ./internal/backup/bmr/ -run BoundProgressUpdate 2>&1 | head -20`
Expected: compile errors (`FilesFailed`, `FailedFilesSample`, `FailedFilesOmitted`, `BoundProgressUpdate` undefined).

- [ ] **Step 3: Implement**

`rebuild/types.go` — add to `Result` (after `Resumed`):
```go
	FilesFailed        int      `json:"filesFailed"`
	FailedFilesSample  []string `json:"failedFilesSample,omitempty"`
	FailedFilesOmitted int      `json:"failedFilesOmitted,omitempty"`
```

`restore_tree.go` — at the point that currently builds `r.failedFiles` (85-88) and the partial-restore message (~76-90), add a deterministic, bounded sample right after the map is populated:
```go
	r.failedFiles = make(map[string]bool, len(res.FailedFiles))
	for _, f := range res.FailedFiles {
		r.failedFiles[f] = true
	}

	const maxFailedFilesSample = 50
	sample := make([]string, 0, len(r.failedFiles))
	for f := range r.failedFiles {
		sample = append(sample, f)
	}
	sort.Strings(sample) // deterministic "first N" — map iteration order is not
	r.result.FilesFailed = len(sample)
	if len(sample) > maxFailedFilesSample {
		r.result.FailedFilesSample = sample[:maxFailedFilesSample]
		r.result.FailedFilesOmitted = len(sample) - maxFailedFilesSample
	} else {
		r.result.FailedFilesSample = sample
	}

	msg := fmt.Sprintf("%d file(s) failed to restore (first %d shown): %s", len(sample), len(r.result.FailedFilesSample), strings.Join(r.result.FailedFilesSample, ", "))
	r.warn(msg)
	if !cfg.AllowPartialRestore {
		return errors.New(msg)
	}
```
(This `msg` — built from the bounded, sorted `sample` (first 50) plus the omitted count — REPLACES the pre-existing unbounded construction `msg := fmt.Sprintf("%d file(s) failed to restore: %s", res.FilesFailed, strings.Join(res.FailedFiles, ", "))`, which joined the FULL unbounded `res.FailedFiles` slice. The same bounded `msg` is used for BOTH the `r.warn(msg)` call and the `errors.New(msg)` fail path when `!cfg.AllowPartialRestore` — do not construct the fail-path error from the unbounded slice while only bounding the warning, or vice versa. Add `"sort"` and `"errors"` to `restore_tree.go`'s imports if not already present; keep the existing `len(r.failedFiles) > 0` gating around this block unchanged — only the message construction and the two new `Result` fields are new).

`engine.go` — no change needed beyond what's already true: `r.result` is the same struct `restoreTree` just populated, and `Run`'s existing "append this phase's `PhaseResult` to `r.result.Phases`" step already happens after `restoreTree` returns, so `FilesFailed`/`FailedFilesSample`/`FailedFilesOmitted` ride along on the final `*Result` for free. (If `engine.go` instead builds a fresh `Result` at the end from scratch rather than mutating `r.result` in place — confirm with `grep -n 'r.result' agent/internal/backup/rebuild/engine.go` — copy the three new fields explicitly at that assembly point.)

`bmr/progress.go` — add after the existing `ProgressUpdate` struct and before `PostRecoveryProgress`:
```go
const (
	maxProgressReasonRunes   = 2000
	maxProgressWarnings      = 64
	maxProgressWarningRunes  = 2000
	maxProgressFailedSample  = 50
	maxProgressBodyBytes     = 768 * 1024
)

// boundedFailures lets BoundProgressUpdate trim a typed Result without bmr
// importing rebuild. Check for an import cycle first: `grep -rn '"…/bmr"'
// agent/internal/backup/rebuild/*.go` must return nothing (rebuild must not
// import bmr) — if it's clean, bmr may import rebuild directly and this
// interface indirection is unnecessary; if a cycle exists, keep this
// interface in bmr and have Task 11 implement it on *rebuild.Result:
//
//	func (r *rebuild.Result) FailedFilesLen() int { return len(r.FailedFilesSample) }
//	func (r *rebuild.Result) CloneWithTrimmedFailedFiles(max int) any {
//		clone := *r
//		clone.FailedFilesOmitted += len(clone.FailedFilesSample) - max
//		clone.FailedFilesSample = append([]string(nil), clone.FailedFilesSample[:max]...)
//		return &clone
//	}
type boundedFailures interface {
	FailedFilesLen() int
	CloneWithTrimmedFailedFiles(max int) any
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// BoundProgressUpdate applies the caps this wave's Global Constraints
// require (warnings ≤ 64 × 2000 chars, reason ≤ 2000 chars,
// failedFilesSample ≤ 50 entries, serialized body ≤ 768 KiB) before a
// ProgressUpdate is posted. It never mutates the caller's u.
func BoundProgressUpdate(u ProgressUpdate) ProgressUpdate {
	bounded := u
	bounded.Reason = truncateRunes(u.Reason, maxProgressReasonRunes)

	if len(u.Warnings) > 0 {
		n := len(u.Warnings)
		if n > maxProgressWarnings {
			n = maxProgressWarnings
		}
		warnings := make([]string, n)
		for i := 0; i < n; i++ {
			warnings[i] = truncateRunes(u.Warnings[i], maxProgressWarningRunes)
		}
		bounded.Warnings = warnings
	}

	// Every real production call site (rebuild_cmd.go:304,314,316,322) passes
	// a typed *rebuild.Result, never a map[string]any — the map branch below
	// only covers the legacy path. Trim on a COPY, never the caller's pointer.
	switch v := u.Result.(type) {
	case boundedFailures:
		if v.FailedFilesLen() > maxProgressFailedSample {
			trimmedCopy := v.CloneWithTrimmedFailedFiles(maxProgressFailedSample)
			bounded.Result = trimmedCopy
		}
	case map[string]any:
		if sample, ok := v["failedFilesSample"].([]string); ok && len(sample) > maxProgressFailedSample {
			trimmed := map[string]any{}
			for k, val := range v {
				trimmed[k] = val
			}
			trimmed["failedFilesSample"] = sample[:maxProgressFailedSample]
			bounded.Result = trimmed
		}
	}

	body, err := json.Marshal(bounded)
	if err != nil || len(body) <= maxProgressBodyBytes {
		return bounded
	}

	// Still too large (e.g. the failedFilesSample entries themselves are
	// individually huge, or Result carries something else bulky) — fall
	// back to a minimal, always-small summary rather than posting an
	// oversized body the 1 MiB server limit would reject outright.
	summary := map[string]any{"status": bounded.Status, "truncated": true}
	if m, ok := u.Result.(map[string]any); ok {
		for _, k := range []string{"status", "error", "refusal", "filesFailed"} {
			if v, present := m[k]; present {
				summary[k] = v
			}
		}
	}
	bounded.Result = summary
	return bounded
}
```
Update `PostRecoveryProgress` to apply it before marshaling — locate the existing `body := struct{ Token string; ProgressUpdate }{Token: token, ProgressUpdate: u}` and change `u` to `BoundProgressUpdate(u)`:
```go
	body := struct {
		Token string `json:"token"`
		ProgressUpdate
	}{Token: token, ProgressUpdate: BoundProgressUpdate(u)}
```
`rebuild_cmd.go`'s validated/failed progress posts need no code change — they already call `bmr.PostRecoveryProgress`, which now applies the bound internally.

- [ ] **Step 4: Run tests**

Run: `cd agent && go build ./... && GOOS=windows go build ./... && go test -race ./internal/backup/rebuild/... ./internal/backup/bmr/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/backup/rebuild/types.go agent/internal/backup/rebuild/restore_tree.go \
  agent/internal/backup/rebuild/restore_tree_test.go agent/internal/backup/bmr/progress.go \
  agent/internal/backup/bmr/progress_test.go
git commit -m "$(cat <<'EOF'
feat(rebuild,bmr): bound failure reporting so a 100k-file failure never exceeds 1 MiB (W09b)

Result.FailedFilesSample caps at 50 entries (sorted for a deterministic
"first N"); the internal failedFiles map stays unbounded for
validate.go. BoundProgressUpdate enforces the same caps plus an overall
768 KiB body ceiling before every progress POST, falling back to a
minimal summary if trimming alone isn't enough.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Fake server, three-generation e2e, console messages

**Files:**
- Modify: `agent/internal/backup/bmr/fakeserver/fakeserver.go` (`Config` gains `Capabilities []string` and `ReferencedSnapshotIDs []string`; `bootstrapFor`, `handleAuthenticate`, `handleExchange`, `handleDownload`)
- Modify: `agent/cmd/breeze-recovery-fakeserver/main.go` (new `--capabilities` and `--referenced-snapshot-ids` flags so `run-qemu.sh` can configure the binary the same way the in-process tests configure `fakeserver.Config` directly)
- Modify: `agent/recovery-media/e2e/seed-snapshot.sh` (seed `e2e-1`, `e2e-2`, `e2e-3` and one unrelated unreferenced object)
- Modify: `agent/recovery-media/e2e/run-qemu.sh` (token snapshot becomes `e2e-3`; assert `validated`; assert a refused download)
- Modify: `.github/workflows/ci.yml` around lines 2001-2099 (comment update only — the job's structure/timeout/toolchain line does not change)
- Modify: `agent/internal/recoveryconsole/console.go` (`promptCodeAndExchange`, 409-aware retry/re-prompt behavior)
- Test: `agent/internal/backup/bmr/fakeserver/fakeserver_test.go`, additions to `agent/internal/recoveryconsole/console_test.go`, e2e job green (CI-only, not locally runnable without QEMU)

**Deviation:** the stub assumed the recovery console lives at `agent/cmd/breeze-backup/recovery_console*.go`. Verified: the actual prompt logic is in `agent/internal/recoveryconsole/console.go` (`Console.promptCodeAndExchange`, lines 424-449 per research), with `console_test.go` alongside it (`fakeIO`, `fakeKey`, `fakeDeps` test helpers). `agent/cmd/breeze-backup/recovery_console_cmd.go` is only a thin Cobra wrapper — do not edit it for this task. The literal string `"Enter recovery code"` does not exist anywhere in the repo; the real prompt is `"Recovery code: "`.

**Deviation:** the existing `promptCodeAndExchange` retry loop is a flat "retry any error up to 3 times" loop with no error-code awareness — there is currently no place in the console that distinguishes `snapshot_index_pending`/`client_capability_required`/etc. This task adds that distinction; it does not modify pre-existing 409-handling (none exists to modify).

**Interfaces (Consumes):** `bmr.ExchangeRecoveryCode`'s error must be inspectable for the new 409 codes. Since `ExchangeRecoveryCode` currently returns a bare `error` (not a typed status error like `authenticateStatusError`/`downloadStatusError`), this task adds an exported typed error `bmr.RecoveryNegotiationError{Code string; Message string; RetryAfterSeconds int}` populated from the 409 JSON body `{error, message, retryAfterSeconds?}` (Part 0 §1's public 409 shape) so the console can `errors.As` against it.

- [ ] **Step 1: Write the failing tests**

Additions to `agent/internal/backup/bmr/fakeserver/fakeserver_test.go`:
```go
func TestFakeServer_BootstrapEchoesGrantedCapabilities(t *testing.T) {
	srv := New(Config{
		Code: "ABCDEFGHJ", SnapshotID: "gen-3", StoreDir: t.TempDir(),
		ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
		Identity: "new", MinHelperVersion: "0.0.0",
		Capabilities:           []string{"snapshot-file-membership-v1"},
		ReferencedSnapshotIDs:  []string{"gen-1", "gen-2"},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := postJSON(t, ts.URL+"/api/v1/backup/bmr/recover/exchange", map[string]any{
		"code": "ABCDEFGHJ", "capabilities": []string{"snapshot-file-membership-v1"},
	})
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	body := decodeJSON(t, resp)
	// handleExchange nests the full bootstrapPayload under
	// body["bootstrap"]["bootstrap"] (double envelope, per the handler's
	// own comment) — not a single "bootstrap" hop.
	download := body["bootstrap"].(map[string]any)["bootstrap"].(map[string]any)["download"].(map[string]any)
	caps := download["capabilities"].([]any)
	require.Contains(t, caps, "snapshot-file-membership-v1")
	fileIndex := body["bootstrap"].(map[string]any)["bootstrap"].(map[string]any)["snapshot"].(map[string]any)["fileIndex"].(map[string]any)
	require.Equal(t, "complete", fileIndex["status"])
	require.ElementsMatch(t, []any{"gen-1", "gen-2"}, fileIndex["originSnapshotIds"])
}

func TestFakeServer_RefusesExchangeWithoutCapabilityWhenReferencesExist(t *testing.T) {
	srv := New(Config{
		Code: "ABCDEFGHJ", SnapshotID: "gen-3", StoreDir: t.TempDir(),
		ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
		Identity: "new", MinHelperVersion: "0.0.0",
		ReferencedSnapshotIDs: []string{"gen-1"},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := postJSON(t, ts.URL+"/api/v1/backup/bmr/recover/exchange", map[string]any{"code": "ABCDEFGHJ"})
	defer resp.Body.Close()
	require.Equal(t, http.StatusConflict, resp.StatusCode)
	body := decodeJSON(t, resp)
	require.Equal(t, "client_capability_required", body["error"])
}

func TestFakeServer_DownloadDeniesUnreferencedObject(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "snapshots", "gen-1", "files"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "snapshots", "gen-1", "files", "not-referenced.gz"), []byte("x"), 0o600))
	srv := New(Config{
		Code: "ABCDEFGHJ", SnapshotID: "gen-3", StoreDir: dir,
		ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
		Identity: "new", MinHelperVersion: "0.0.0",
		Capabilities: []string{"snapshot-file-membership-v1"}, ReferencedSnapshotIDs: []string{"gen-2"},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Obtain a valid token via a real exchange first — handleDownload
	// authenticates via a `token` query parameter checked against
	// s.tokens, not an Authorization header.
	exResp := postJSON(t, ts.URL+"/api/v1/backup/bmr/recover/exchange", map[string]any{
		"code": "ABCDEFGHJ", "capabilities": []string{"snapshot-file-membership-v1"},
	})
	defer exResp.Body.Close()
	require.Equal(t, http.StatusOK, exResp.StatusCode)
	exBody := decodeJSON(t, exResp)
	validToken, ok := exBody["token"].(string)
	require.True(t, ok, "expected the exchange response to carry a top-level token")

	key := "snapshots/gen-1/files/not-referenced.gz"
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/backup/bmr/recover/download?path="+url.QueryEscape(key)+"&token="+url.QueryEscape(validToken), nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusConflict, resp.StatusCode, "an object outside the seeded reference set must be refused even with membership granted")
}
```

Additions to `agent/internal/recoveryconsole/console_test.go`:
```go
func TestConsole_SnapshotIndexPendingAutoRetries(t *testing.T) {
	deps := newFakeDeps(t)
	calls := 0
	deps.Exchange = func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
		calls++
		if calls < 3 {
			return "", nil, &bmr.RecoveryNegotiationError{Code: "snapshot_index_pending", Message: "Breeze is preparing the file index for this snapshot (3 files reference earlier snapshots). Retry in 30 seconds.", RetryAfterSeconds: 0 /* zeroed for the test's fast clock */}
		}
		return "recv-token", &bmr.BootstrapResponse{Snapshot: &bmr.AuthenticatedSnapshot{SnapshotID: "gen-3"}}, nil
	}
	c := newTestConsole(t, deps)
	token, bs, err := c.promptCodeAndExchange(context.Background(), true, Answers{Code: "ABCDEFGHJ"}, "https://example.invalid")
	require.NoError(t, err)
	require.Equal(t, "recv-token", token)
	require.NotNil(t, bs)
	require.Equal(t, 3, calls)
}

func TestConsole_ClientCapabilityRequiredReturnsToCodePromptWithMessage(t *testing.T) {
	deps := newFakeDeps(t)
	deps.Exchange = func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
		return "", nil, &bmr.RecoveryNegotiationError{Code: "client_capability_required", Message: "This backup references files stored with earlier snapshots. The recovery media you booted is too old to read them — download the current recovery media from Breeze and boot again."}
	}
	c := newTestConsole(t, deps)
	_, _, err := c.promptCodeAndExchange(context.Background(), true, Answers{Code: "ABCDEFGHJ"}, "https://example.invalid")
	require.Error(t, err)
	require.Contains(t, err.Error(), "too old to read them")
}

func TestConsole_StorageIdentityDriftShowsMessageVerbatim(t *testing.T) {
	deps := newFakeDeps(t)
	deps.Exchange = func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
		return "", nil, &bmr.RecoveryNegotiationError{Code: "storage_identity_drift", Message: "The backup destination for this device has changed since this snapshot was written. Restore the previous destination settings or choose a snapshot written to the current destination."}
	}
	c := newTestConsole(t, deps)
	_, _, err := c.promptCodeAndExchange(context.Background(), true, Answers{Code: "ABCDEFGHJ"}, "https://example.invalid")
	require.Error(t, err)
	require.Contains(t, err.Error(), "destination for this device has changed")
}
```
(`newFakeDeps`/`newTestConsole`/`Answers`/`fakeDeps.Exchange` field name are inferred from the researched `console_test.go` helper names `fakeIO`, `fakeKey`, `fakeDeps` — **before writing these for real, read `console_test.go` in full to confirm the exact `Deps` struct field name for the exchange function and the exact `Console` constructor signature**, since only the top-level helper names were confirmed, not their exact fields.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/bmr/fakeserver/... ./internal/recoveryconsole/... 2>&1 | head -40`
Expected: compile errors (`Capabilities`/`ReferencedSnapshotIDs` unknown fields on `Config`, `bmr.RecoveryNegotiationError` undefined).

- [ ] **Step 3: Implement**

`fakeserver.go` — extend `Config`:
```go
type Config struct {
	Code, SnapshotID, StoreDir, RecoveryID, Nonce, Identity, MinHelperVersion, ProgressLogPath string
	// Capabilities are the capability strings this fake server GRANTS when
	// the client requests them (subset semantics, mirroring the real
	// server's negotiateRecoveryCapabilities). Empty means "grants
	// nothing" — a client that needs the membership capability (because
	// ReferencedSnapshotIDs is non-empty) is refused.
	Capabilities []string
	// ReferencedSnapshotIDs, when non-empty, makes bootstrapFor emit a
	// "complete" fileIndex computed from the manifest.json this fake
	// server already has on disk for SnapshotID, and makes
	// handleAuthenticate/handleExchange require the membership capability
	// from the client (409 client_capability_required otherwise).
	ReferencedSnapshotIDs []string
}
```
Add a helper that computes the seeded manifest's sha256 and reads its content entries (reuses the on-disk `manifest.json` the fake server already serves for downloads):
```go
func (s *Server) computeFileIndex() (sha string, externalCount int, err error) {
	data, err := os.ReadFile(filepath.Join(s.cfg.StoreDir, "snapshots", s.cfg.SnapshotID, "manifest.json"))
	if err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(data)
	var m struct {
		Files []struct {
			BackupPath string `json:"backupPath"`
		} `json:"files"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return "", 0, err
	}
	own := "snapshots/" + s.cfg.SnapshotID + "/"
	for _, f := range m.Files {
		if f.BackupPath != "" && !strings.HasPrefix(f.BackupPath, own) {
			externalCount++
		}
	}
	return hex.EncodeToString(sum[:]), externalCount, nil
}
```
`bootstrapFor` currently takes no capability information — its real signature is `func (s *Server) bootstrapFor(tokenID string) bootstrapPayload`, so the `clientCapabilities` this step reads does not exist yet. Change the signature to `func (s *Server) bootstrapFor(tokenID string, clientCapabilities []string) bootstrapPayload` and update BOTH call sites: `handleExchange` (~line 226, pass the decoded exchange body's `Capabilities`) and `handleAuthenticate` (~line 299, pass the decoded authenticate body's `Capabilities`).

In `bootstrapFor`, extend the `download` map with `capabilities` (echoing the intersection of what the client sent and `s.cfg.Capabilities`) and, when `len(s.cfg.ReferencedSnapshotIDs) > 0` and the client sent the membership capability, add `snapshot.fileIndex`:
```go
// signature: func (s *Server) bootstrapFor(tokenID string, clientCapabilities []string) bootstrapPayload
	granted := intersectCapabilities(clientCapabilities, s.cfg.Capabilities)
	download := map[string]any{
		// ... existing fields unchanged (type, method, url, pathQueryParam, pathPrefix, expiresAt) ...
		"capabilities": granted,
	}
	snapshot := map[string]any{
		// ... existing fields unchanged (id, snapshotId, backupType, size, fileCount) ...
	}
	if len(s.cfg.ReferencedSnapshotIDs) > 0 && hasCapability(granted, "snapshot-file-membership-v1") {
		sha, externalCount, err := s.computeFileIndex()
		if err == nil {
			snapshot["fileIndex"] = map[string]any{
				"status": "complete", "manifestSha256": sha,
				"externalCount": externalCount, "originSnapshotIds": s.cfg.ReferencedSnapshotIDs,
			}
		}
	}
```
(`intersectCapabilities`/`hasCapability` are small unexported helpers analogous to `bmr.HasCapability` — add them locally rather than importing the `bmr` package into `fakeserver`, to avoid a dependency cycle if one exists; check with `head -15 agent/internal/backup/bmr/fakeserver/fakeserver.go` first — if `fakeserver` already imports `bmr` for other types, reuse `bmr.HasCapability` directly instead of duplicating it.)

In `handleAuthenticate` and `handleExchange`, add `Capabilities []string \`json:"capabilities,omitempty"\`` to both decode-target structs, and before writing the success response, refuse when references exist and the client didn't send the capability:
```go
	if len(s.cfg.ReferencedSnapshotIDs) > 0 && !hasCapability(body.Capabilities, "snapshot-file-membership-v1") {
		writeError(w, http.StatusConflict, "client_capability_required")
		return
	}
```
(insert this check in both handlers, after the existing token/code validity check and before the `writeJSON(w, http.StatusOK, ...)` call — do NOT consume the code / flip token state before this check, matching Part 0 §1's "code NOT consumed" requirement for R2).

`handleDownload` — extend the existing own-prefix check (line ~332) with membership-based admission against the seeded reference set:
```go
	key := r.URL.Query().Get("path")
	ownPrefix := "snapshots/" + s.cfg.SnapshotID + "/"
	if !strings.HasPrefix(key, ownPrefix) {
		if !s.externalKeyReferenced(key) {
			log.Printf("fakeserver: download refused (not_authorized): %s", key)
			writeError(w, http.StatusConflict, "not_authorized")
			return
		}
	}
```
```go
// externalKeyReferenced reports whether key belongs to one of the seeded
// ReferencedSnapshotIDs generations — the fake server's stand-in for the
// real server's backup_snapshot_files/backup_snapshot_origins membership
// check.
func (s *Server) externalKeyReferenced(key string) bool {
	for _, id := range s.cfg.ReferencedSnapshotIDs {
		if strings.HasPrefix(key, "snapshots/"+id+"/") {
			return true
		}
	}
	return false
}
```

`agent/cmd/breeze-recovery-fakeserver/main.go` — add two flags and wire them into `fakeserver.Config`:
```go
	capabilitiesFlag := flag.String("capabilities", "", "comma-separated capability strings this fake server grants (e.g. snapshot-file-membership-v1)")
	referencedFlag := flag.String("referenced-snapshot-ids", "", "comma-separated origin snapshot ids this fake server's manifest references")
	// ... after flag.Parse(), alongside the existing flag validation:
	var capabilities, referenced []string
	if *capabilitiesFlag != "" {
		capabilities = strings.Split(*capabilitiesFlag, ",")
	}
	if *referencedFlag != "" {
		referenced = strings.Split(*referencedFlag, ",")
	}
	cfg := fakeserver.Config{
		Code: *codeFlag, SnapshotID: *snapshotIDFlag, StoreDir: *storeDirFlag,
		ProgressLogPath: *progressLogFlag, Identity: *identityFlag, Nonce: *nonceFlag,
		MinHelperVersion: *minHelperVersionFlag,
		Capabilities: capabilities, ReferencedSnapshotIDs: referenced,
	}
```

`bmr` package — add the typed negotiation error (new file `agent/internal/backup/bmr/negotiation_error.go`, since `session.go`/`progress.go` are both already large and this is a distinct concern):
```go
package bmr

import "fmt"

// RecoveryNegotiationError is the typed form of a 409 returned by
// /bmr/recover/authenticate or /bmr/recover/exchange for the capability
// negotiation codes in Part 0 §1 (client_capability_required,
// capability_downgrade, snapshot_storage_identity_unknown,
// storage_identity_drift, snapshot_index_pending, snapshot_index_failed).
type RecoveryNegotiationError struct {
	Code              string
	Message           string
	RetryAfterSeconds int
}

func (e *RecoveryNegotiationError) Error() string {
	return fmt.Sprintf("bmr: %s: %s", e.Code, e.Message)
}
```
`ExchangeRecoveryCode` and `authenticateRecoverySessionContext` must decode a 409 body into this type instead of the generic `fmt.Errorf` path they use today for non-2xx responses — locate the existing non-2xx branch in both (mirrors `authenticateStatusError`'s construction) and add, before falling back to the generic error:
```go
	if resp.StatusCode == http.StatusConflict {
		var body struct {
			Error             string `json:"error"`
			Message           string `json:"message"`
			RetryAfterSeconds int    `json:"retryAfterSeconds"`
		}
		if json.NewDecoder(resp.Body).Decode(&body) == nil && body.Error != "" {
			return "", nil, &RecoveryNegotiationError{Code: body.Error, Message: body.Message, RetryAfterSeconds: body.RetryAfterSeconds}
		}
	}
```
(exact insertion point: wherever the existing `authenticateStatusError`/generic-error construction happens for non-2xx responses in both functions — grep `resp.StatusCode` in `session.go` to find both spots.)

`agent/internal/recoveryconsole/console.go` — `promptCodeAndExchange`, add 409-code awareness inside the existing retry loop, replacing the flat `c.IO.Print("That code did not work: %v\n", exErr)` branch with a classification:
```go
	for attempt := 1; attempt <= maxCodeAttempts; attempt++ {
		code, err := c.IO.ReadLine("Recovery code: ")
		if err != nil {
			return "", nil, err
		}
		token, bs, exErr := c.Deps.Exchange(ctx, server, strings.TrimSpace(code))
		if exErr == nil {
			return token, bs, nil
		}
		var negErr *bmr.RecoveryNegotiationError
		if errors.As(exErr, &negErr) {
			switch negErr.Code {
			case "snapshot_index_pending":
				c.IO.Print("%s\n", negErr.Message)
				if !c.waitAndRetryPending(ctx, negErr.RetryAfterSeconds) {
					return "", nil, fmt.Errorf("recovery code exchange timed out waiting for the file index: %w", exErr)
				}
				attempt-- // this attempt did not consume one of the three code attempts
				continue
			case "client_capability_required", "capability_downgrade", "storage_identity_drift", "snapshot_storage_identity_unknown", "snapshot_index_failed":
				c.IO.Print("%s\n", negErr.Message)
				return "", nil, fmt.Errorf("recovery refused: %w", exErr)
			}
		}
		c.IO.Print("That code did not work: %v\n", exErr)
		if attempt == maxCodeAttempts {
			return "", nil, fmt.Errorf("too many invalid recovery codes: %w", exErr)
		}
	}
	return "", nil, errors.New("unreachable")
```
Add the retry-loop helper (bounded to 20 minutes per the stub, polling every `retryAfterSeconds`, defaulting to 30 s when the server omits it or sends 0 — CI/test code passes 0 and a zeroed clock so the test doesn't actually sleep):
```go
// waitAndRetryPending sleeps for retryAfterSeconds (or 30s if unset) and
// reports true if the caller should retry the exchange; it gives up after
// 20 minutes of total waiting.
func (c *Console) waitAndRetryPending(ctx context.Context, retryAfterSeconds int) bool {
	const maxWait = 20 * time.Minute
	delay := time.Duration(retryAfterSeconds) * time.Second
	if delay <= 0 {
		delay = 30 * time.Second
	}
	if c.pendingWaitElapsed+delay > maxWait {
		return false
	}
	c.pendingWaitElapsed += delay
	select {
	case <-ctx.Done():
		return false
	case <-c.sleep(delay):
		return true
	}
}
```
(`c.pendingWaitElapsed time.Duration` is a new field on `Console`, zero-initialized; `c.sleep func(time.Duration) <-chan time.Time` is a new seam field defaulting to `time.After` in the real constructor and to an instantly-firing channel in tests — follow whatever existing time-seam convention `console.go` already uses elsewhere for testability, e.g. grep for `time.After` or a `clock`/`now` field already on `Console` before introducing a new one; if one exists, reuse it instead of adding `c.sleep`.)

`agent/recovery-media/e2e/seed-snapshot.sh` — after the existing `e2e-1` seeding (unchanged), append:
```bash
# e2e-2: one changed file (uploaded fresh under e2e-2), everything else
# references e2e-1 verbatim (backupPath unchanged from e2e-1's manifest).
# snapshot-dir has no diffing/"--only-changed" mode (it emits one full
# manifest per invocation) — hand-write e2e-2/manifest.json instead
# (simpler and matches how layout.json is already hand-written by this
# script): copy e2e-1/manifest.json, change "id" to "e2e-2", and for
# exactly one file entry (etc/debian_version — base-files guarantees this
# file in an mmdebstrap minbase chroot, unlike /etc/motd) recompute its
# backupPath under snapshots/e2e-2/files/<sha256 of sourcePath> and
# re-upload that one file's bytes to that key; every other file entry's
# backupPath stays "snapshots/e2e-1/files/...".
python3 - "$OUT" <<'PYEOF'
import json, hashlib, os, sys, shutil

out = sys.argv[1]
with open(f"{out}/snapshots/e2e-1/manifest.json") as f:
    gen1 = json.load(f)

gen2 = json.loads(json.dumps(gen1))
gen2["id"] = "e2e-2"
for entry in gen2["files"]:
    if entry.get("sourcePath") == "/etc/debian_version":
        key = "snapshots/e2e-2/files/" + hashlib.sha256(entry["sourcePath"].encode()).hexdigest()
        entry["backupPath"] = key
        os.makedirs(os.path.dirname(f"{out}/{key}"), exist_ok=True)
        with open(f"{out}/{key}", "wb") as fh:
            fh.write(b"e2e-2-changed-debian-version\n")
        break
else:
    raise SystemExit("expected /etc/debian_version in the e2e-1 manifest to mark as changed in e2e-2")

os.makedirs(f"{out}/snapshots/e2e-2", exist_ok=True)
with open(f"{out}/snapshots/e2e-2/manifest.json", "w") as f:
    json.dump(gen2, f, indent=2)
shutil.copy(f"{out}/layout.json", f"{out}/snapshots/e2e-2/layout.json") if os.path.exists(f"{out}/layout.json") else None
PYEOF

# e2e-3: references into BOTH e2e-1 (unchanged files) and e2e-2 (the
# changed /etc/debian_version), plus its own newly changed file (/etc/hostname).
python3 - "$OUT" <<'PYEOF'
import json, hashlib, os, sys

out = sys.argv[1]
with open(f"{out}/snapshots/e2e-2/manifest.json") as f:
    gen2 = json.load(f)

gen3 = json.loads(json.dumps(gen2))
gen3["id"] = "e2e-3"
for entry in gen3["files"]:
    if entry.get("sourcePath") == "/etc/hostname":
        key = "snapshots/e2e-3/files/" + hashlib.sha256(entry["sourcePath"].encode()).hexdigest()
        entry["backupPath"] = key
        os.makedirs(os.path.dirname(f"{out}/{key}"), exist_ok=True)
        with open(f"{out}/{key}", "wb") as fh:
            fh.write(b"e2e-3-changed-hostname\n")
        break
else:
    raise SystemExit("expected /etc/hostname in the manifest to mark as changed in e2e-3")

os.makedirs(f"{out}/snapshots/e2e-3", exist_ok=True)
with open(f"{out}/snapshots/e2e-3/manifest.json", "w") as f:
    json.dump(gen3, f, indent=2)
PYEOF

# One unrelated, unreferenced object under e2e-1's own prefix, so the fake
# server's refusal path (handleDownload / not_authorized) is exercised by
# a real request during the run — R7/R8 in Part 0 §4.
mkdir -p "$OUT/snapshots/e2e-1/files"
echo "not part of any manifest" > "$OUT/snapshots/e2e-1/files/not-referenced.gz"
```
(the `snapshot-dir` command's real flags do not include `--only-changed` — do **not** add one to `snapshot_dir_cmd.go`; the Python post-processing above, starting from the `python3 - "$OUT" <<'PYEOF'` block, is the actual mechanism and only needs `e2e-1/manifest.json` and `layout.json` to already exist on disk from the unmodified `e2e-1` seeding step above it).

`agent/recovery-media/e2e/run-qemu.sh` — change `snapshot_id="e2e-1"` to `snapshot_id="e2e-3"`. Locate the existing `breeze-recovery-fakeserver` invocation block (~lines 138-145) and add the two new flags Task 12 added to `main.go` so the fake server actually grants the membership capability and knows which snapshot IDs `e2e-3` references:
```bash
breeze-recovery-fakeserver \
  --code "${recovery_code}" \
  --snapshot-id "${snapshot_id}" \
  --store-dir "${store_dir}" \
  --progress-log "${progress_log}" \
  --capabilities snapshot-file-membership-v1 \
  --referenced-snapshot-ids e2e-1,e2e-2 \
  ... # remaining pre-existing flags unchanged
```
(Substitute the actual pre-existing flag names/variables — `--code`/`--snapshot-id`/`--store-dir`/`--progress-log` above are placeholders for whatever `run-qemu.sh` already passes; only the two new `--capabilities`/`--referenced-snapshot-ids` flags are additions. Re-read the live invocation with `sed -n '135,150p' agent/recovery-media/e2e/run-qemu.sh` before editing.)

After the existing `progress.json` assertion, add two post-checks: one against the fake server's log for the refused unrelated object (the fake server already writes structured logs per the ground truth "no-gzip note" at `fakeserver.go:309-315` — reuse that logging, don't add a new log format, and log the refusal per Task 12's `handleDownload` change above), and one asserting the restored `/etc/hostname` matches e2e-3's changed value:
```bash
# Post-check: the fake server must have refused at least one download for
# the unrelated, unreferenced object seeded above (not-referenced.gz),
# proving R7/R8 fire for real over the wire, not just in unit tests.
if ! grep -q "not-referenced.gz" "${fakeserver_log}" 2>/dev/null; then
  echo "expected the fake server log to show a refused request for not-referenced.gz" >&2
  exit 1
fi

# Post-check: the restored /etc/hostname must equal e2e-3's changed value,
# not e2e-1's or e2e-2's, proving the recovery actually pulled the
# newest generation's own content rather than an ancestor's.
restored_hostname="$(cat "${mount_point}/etc/hostname" 2>/dev/null || true)"
if [ "${restored_hostname}" != "e2e-3-changed-hostname" ]; then
  echo "expected restored /etc/hostname to be 'e2e-3-changed-hostname', got '${restored_hostname}'" >&2
  exit 1
fi
```
(`fakeserver_log` — the run-qemu.sh variable name for the fake server's stdout/stderr redirection, confirmed by grepping the script for the `fakeserver` process launch; `mount_point` — substitute whatever variable name `run-qemu.sh` already uses for the mounted restored filesystem root at the point of its post-restore assertions.)

`.github/workflows/ci.yml` — update only the comment near the job (no structural change): replace "seeds one generation" with "seeds three generations (e2e-1, e2e-2, e2e-3) with cross-snapshot references, per W09".

- [ ] **Step 4: Run tests**

Run: `cd agent && go build ./... && GOOS=windows go build ./... && go test -race ./internal/backup/bmr/... ./internal/recoveryconsole/... ./cmd/breeze-recovery-fakeserver/...`
Expected: PASS. The e2e job itself only runs in CI (QEMU); do not attempt to run it locally — verify the shell scripts with `bash -n agent/recovery-media/e2e/seed-snapshot.sh agent/recovery-media/e2e/run-qemu.sh` for syntax only.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/backup/bmr/fakeserver/fakeserver.go agent/internal/backup/bmr/fakeserver/fakeserver_test.go \
  agent/cmd/breeze-recovery-fakeserver/main.go agent/internal/backup/bmr/negotiation_error.go \
  agent/internal/backup/bmr/session.go agent/internal/recoveryconsole/console.go \
  agent/internal/recoveryconsole/console_test.go agent/recovery-media/e2e/seed-snapshot.sh \
  agent/recovery-media/e2e/run-qemu.sh .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(bmr,e2e): fake server capability negotiation; three-generation e2e fixture; console 409 messages (W09b)

fakeserver.Config gains Capabilities/ReferencedSnapshotIDs so unit and
QEMU e2e tests can exercise the same negotiation and membership-authz
paths the real API implements. seed-snapshot.sh now seeds e2e-1/e2e-2/
e2e-3 with real cross-snapshot references plus one unrelated object;
run-qemu.sh recovers from e2e-3 and asserts the fake server refused the
unrelated object. The recovery console shows the server's message
verbatim on every new negotiation refusal and auto-retries
snapshot_index_pending up to 20 minutes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Web status + spec amendment + docs

**Files:**
- Modify: `apps/web/src/components/backup/BareMetalRecoveryPanel.tsx` (status line for `fileIndex.status`, negotiation-refusal reasons)
- Modify: `apps/web/src/locales/en/backup.json` `bareMetalRecovery` section, plus REAL translations in `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/backup.json`
- Modify: `apps/web/src/components/backup/BareMetalRecoveryPanel.test.tsx`
- Modify: `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` (new §8.5, extend §11's wave list)
- Modify: `apps/docs/src/content/docs/backup/bare-metal-recovery.mdx`
- Test: `cd apps/web && npx vitest run src/components/backup/BareMetalRecoveryPanel src/lib/i18n`

**Deviation:** the stub's Files line for Task 13 names `apps/web/src/components/backup/RecoveryBootstrapTab.tsx` and claims "409 `snapshot_storage_identity_unknown` reasons already render through `details.reasons`." Verified research shows the `reasons[]`-on-409 rendering, the 10s-poll status timeline, and the `bareMetalRecovery.*` i18n namespace all live in a **separate component**, `apps/web/src/components/backup/BareMetalRecoveryPanel.tsx` (rendered inside `RecoveryBootstrapTab.tsx` as a child). `RecoveryBootstrapTab.tsx`'s own `/bmr/tokens` flow (line ~718) is the older, unrelated token-bootstrap UI with flat auto-extracted i18n keys and no `reasons[]` handling — it is out of scope for this task. This task modifies `BareMetalRecoveryPanel.tsx`.

**Deviation:** the stub's locale path `apps/web/src/lib/i18n/locales/*` does not exist. The real path is `apps/web/src/locales/<BCP-47 tag>/<namespace>.json`; the relevant file is `backup.json`. The seven non-English locales are `de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR` (confirmed against `apps/web/src/locales/` directory listing and the `translationCoverage.test.ts` `translatedLocales` list).

**Deviation:** `translationCoverage.test.ts` does not fail on any exact-English duplicate outright — it fails when a namespace's exact-English-duplicate count *exceeds a hand-maintained baseline* (`namespaceDuplicateBaselines[locale]['backup.json']`). Real (non-English) translations for every new key avoid touching the baseline at all; only an intentional cognate (e.g. a loanword) needs a baseline bump with a `// +1 ...` comment, following the existing precedent at line ~24-27 of that test file.

- [ ] **Step 1: Write the failing tests**

Additions to `BareMetalRecoveryPanel.test.tsx` (mirrors the file's existing `fetchMock.mockImplementation` + `flush()` fake-timer pattern):
```tsx
  it('shows the file-index preparing status while fileIndex is not complete', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/backup/snapshots?') && method === 'GET') {
        return makeJsonResponse({ data: [{ id: SNAPSHOT_ID, deviceId: 'device-1', label: 'Nightly', createdAt: '2026-03-28T10:00:00Z' }] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'GET' && url.includes('limit=20')) {
        return makeJsonResponse({
          data: [{
            id: RECOVERY_ID, deviceId: 'device-1', snapshotId: SNAPSHOT_ID, identity: 'original',
            status: 'media_booted', overdue: false, codeExpiresAt: '2026-03-28T10:15:00Z',
            failureReason: null, fileIndexStatus: 'hydrating',
          }],
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<BareMetalRecoveryPanel />);
    await flush();

    expect(screen.getByTestId('bare-metal-recovery-file-index-status')).toHaveTextContent(
      'Preparing file index for cross-snapshot references…',
    );
  });

  it('does not show the file-index status once fileIndexStatus is complete', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/backup/snapshots?') && method === 'GET') return makeJsonResponse({ data: [] });
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'GET' && url.includes('limit=20')) {
        return makeJsonResponse({
          data: [{
            id: RECOVERY_ID, deviceId: 'device-1', snapshotId: SNAPSHOT_ID, identity: 'original',
            status: 'restoring', overdue: false, codeExpiresAt: '2026-03-28T10:15:00Z',
            failureReason: null, fileIndexStatus: 'complete',
          }],
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<BareMetalRecoveryPanel />);
    await flush();

    expect(screen.queryByTestId('bare-metal-recovery-file-index-status')).not.toBeInTheDocument();
  });

  it('renders a snapshot_storage_identity_unknown create refusal reason', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/backup/snapshots?') && method === 'GET') {
        return makeJsonResponse({ data: [{ id: SNAPSHOT_ID, deviceId: 'device-1', label: 'Nightly', createdAt: '2026-03-28T10:00:00Z' }] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'GET') return makeJsonResponse({ data: [] });
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'POST') {
        return makeJsonResponse({
          error: 'snapshot_storage_identity_unknown',
          reasons: ["Breeze has not yet verified where this snapshot's files are stored. Wait for the next retention run or choose a newer full backup."],
        }, false, 409);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<BareMetalRecoveryPanel />);
    await flush();
    fireEvent.change(screen.getByLabelText('Snapshot'), { target: { value: SNAPSHOT_ID } });
    fireEvent.click(screen.getByText('Create recovery code'));
    await flush();

    expect(screen.getByText(/has not yet verified where this snapshot's files are stored/)).toBeInTheDocument();
  });
```

`apps/web/src/lib/i18n` translation-coverage: no new test file — the existing `translationCoverage.test.ts` suite runs against the new keys automatically once they're added to `en/backup.json` and the other 7 locales; running it is the "test" for this step.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/backup/BareMetalRecoveryPanel`
Expected: FAIL — `getByTestId('bare-metal-recovery-file-index-status')` not found (component doesn't render it yet); the `snapshot_storage_identity_unknown` case likely already passes today (it's the pre-existing `reasons[]` path) — if it does, that assertion is a **characterization test**, not new red; note this and keep it anyway as a regression guard for this task's changes.

- [ ] **Step 3: Implement**

`BareMetalRecoveryPanel.tsx` — extend `RecoverySummary`'s type and `parseRecoverySummary` to carry `fileIndexStatus` (added alongside the existing `status`/`failureReason` fields the summary already parses):
```tsx
interface RecoverySummary {
  id: string; deviceId: string; snapshotId: string | null;
  identity: RecoveryIdentity; status: RecoveryStatus; overdue: boolean;
  codeExpiresAt: string; failureReason: string | null;
  fileIndexStatus: 'none' | 'agent' | 'hydrating' | 'complete' | 'failed' | null;
}
```
(update `parseRecoverySummary`'s field extraction to read `data.fileIndexStatus` defensively, same pattern as the existing `failureReason` field — `typeof data.fileIndexStatus === 'string' ? data.fileIndexStatus : null`.)

In the status-rendering block (after the existing `active.overdue` notice, before the failed/refused-or-timeline branch), add:
```tsx
          {active.fileIndexStatus && active.fileIndexStatus !== 'complete' && !isFailedOrRefused && (
            <div
              className="flex items-center gap-2 rounded border border-muted bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              data-testid="bare-metal-recovery-file-index-status"
            >
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <span>{t('bareMetalRecovery.fileIndexPreparing')}</span>
            </div>
          )}
```
No change is needed for the `snapshot_storage_identity_unknown`/other negotiation-refusal `reasons[]` rendering — the existing `createErrorReasons` list already renders any string in the 409 body's `reasons[]` array verbatim (Part 0 §1's public 409 body has `message`, not a `reasons[]` array, for the *negotiation* codes at exchange/authenticate time — those happen on the **recovery console**, not this web panel; the **web panel's** `snapshot_storage_identity_unknown` case is the *creation-time preflight* 409, which the existing `bareMetalRecoveryService.ts` interim guard from #6469 already returns as `{error, reasons: [...]}, and this task's test above is a regression characterization of that pre-existing path, not new behavior).

`en/backup.json` — add to the `bareMetalRecovery` object (after `overdueNotice`):
```json
    "fileIndexPreparing": "Preparing file index for cross-snapshot references…",
```

REAL (non-English) translations — add the same key, translated, to each of the seven locale files' `bareMetalRecovery` object at the same nesting position:
- `de-DE/backup.json`: `"fileIndexPreparing": "Dateiindex für snapshot-übergreifende Verweise wird vorbereitet…",`
- `es-419/backup.json`: `"fileIndexPreparing": "Preparando el índice de archivos para referencias entre instantáneas…",`
- `fr-FR/backup.json`: `"fileIndexPreparing": "Préparation de l'index des fichiers pour les références inter-instantanés…",`
- `fr-CA/backup.json`: `"fileIndexPreparing": "Préparation de l'index des fichiers pour les références entre instantanés…",`
- `it-IT/backup.json`: `"fileIndexPreparing": "Preparazione dell'indice dei file per i riferimenti tra snapshot…",`
- `pt-BR/backup.json`: `"fileIndexPreparing": "Preparando o índice de arquivos para referências entre snapshots…",`
- `tr-TR/backup.json`: `"fileIndexPreparing": "Anlık görüntüler arası referanslar için dosya dizini hazırlanıyor…",`

(insert each at the same object position as `en/backup.json`'s `bareMetalRecovery.fileIndexPreparing`, i.e. inside that locale's own `bareMetalRecovery` block, which the research pass confirmed already mirrors the English key set 1:1 in at least `de-DE` — repeat the same insertion point in the other five.)

`docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` — insert new `### 8.5` between the existing `### 8.4 UI and docs` (line 114-116) and `## 9. Safety and failure handling` (line 117):
```markdown
### 8.5 Download scope and cross-snapshot references (W09)
An incremental snapshot's manifest can name objects stored under an OLDER
snapshot's prefix. A recovery token is authorized to download exactly the
objects its snapshot's manifest names — including those under older
prefixes — never a wider "same device" or "same bucket" grant. The client
negotiates `snapshot-file-membership-v1` at `/bmr/recover/authenticate` and
`/bmr/recover/exchange`; the server hydrates a verified-complete per-file
index by reading the snapshot's own `manifest.json` (never trusting the
agent-reported index, which is dropped above a size cap) and records
provenance for every referenced origin snapshot in `backup_snapshot_origins`,
captured while the origin's live row or retirement record still exists.
Authorization for an external key requires the negotiated capability, a
`complete` index, exact membership, and matching origin org/device/storage
identity — fail closed on any NULL or drifted identity. Every refusal this
introduces fires at exchange/authenticate (server) or before the target disk
is provisioned (agent) — never during `PhaseRestore`, and never after
`provision` has run. See `docs/superpowers/plans/backup/_w09-part0.md` for
the full wire contract, data model and refusal matrix.
```
Extend the `## 11. Waves` list (currently ends at "8. Docs, UI polish, recovery readiness fed from real results.") with:
```markdown
9. Token-mode recovery follows cross-snapshot object references (§8.5): server-verified file index, provenance tracking, refuse-before-provision on both client and server.
```

`apps/docs/src/content/docs/backup/bare-metal-recovery.mdx` — add one paragraph after the existing "Keep the media current" `<Steps>` item under "1. Get the media" (or as a new callout right after the "Create a recovery code" `<Steps>` block, matching the file's `<Aside type="note">` convention already used for the "one recovery at a time" note):
```mdx
<Aside type="note">
  **Recovery media too old.** If this snapshot's files reference objects
  stored under an earlier snapshot, the console needs recovery media that
  supports cross-snapshot references. An older ISO is refused with a
  message telling you to download the current recovery media and boot
  again — the target disk is never touched.
</Aside>

<Aside type="note">
  **Preparing file index.** The first time you recover from an incremental
  snapshot, Breeze may need a few seconds to a few minutes to verify which
  older-snapshot objects it references. The console retries automatically
  and shows "Breeze is preparing the file index for this snapshot…" while
  it waits — this is expected and does not consume one of your three code
  attempts.
</Aside>
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && npx vitest run src/components/backup/BareMetalRecoveryPanel src/lib/i18n`
Expected: PASS (including `translationCoverage.test.ts`'s per-locale duplicate-baseline checks — if any locale's translation above happens to collide with an existing baseline-exceeding count, the test output names the exact namespace/locale to fix; do not paper over it by copying English text).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/backup/BareMetalRecoveryPanel.tsx \
  apps/web/src/components/backup/BareMetalRecoveryPanel.test.tsx \
  apps/web/src/locales/en/backup.json apps/web/src/locales/de-DE/backup.json \
  apps/web/src/locales/es-419/backup.json apps/web/src/locales/fr-FR/backup.json \
  apps/web/src/locales/fr-CA/backup.json apps/web/src/locales/it-IT/backup.json \
  apps/web/src/locales/pt-BR/backup.json apps/web/src/locales/tr-TR/backup.json \
  docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md \
  apps/docs/src/content/docs/backup/bare-metal-recovery.mdx
git commit -m "$(cat <<'EOF'
feat(web,docs): file-index preparing status on the bare-metal recovery panel; spec §8.5 (W09b)

BareMetalRecoveryPanel shows "Preparing file index for cross-snapshot
references…" while a recovery's fileIndexStatus is not yet complete,
translated into all 7 non-English locales. Spec gains §8.5 documenting
the download-scope contract and wave 9 in the waves list; the
bare-metal-recovery docs page explains the "recovery media too old"
and "preparing file index" console messages.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Whole-wave verification, lab proof, follow-ups, PR 2

- [ ] **Step 1: Suites**

```bash
cd agent && go build ./... && GOOS=windows go build ./... \
  && go test -race ./internal/backup/... ./cmd/breeze-backup/... ./cmd/breeze-recovery-fakeserver/... ./internal/recoveryconsole/... \
  && golangci-lint run --new-from-rev=origin/main ./...
```
```bash
cd apps/api && npx vitest run \
  src/services/recoveryDownloadService src/services/recoveryCapabilities src/services/backupSnapshotFileIndex \
  src/services/bareMetalRecoveryService src/routes/backup/bmr src/routes/backup/bmrRecoveries \
  src/services/backupResultPersistence
```
plus the RLS/integration suites named in Part A's Task 7 (needs a live Postgres):
```bash
cd apps/api && DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze \
  npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/bmrRecoverPublicRoutesRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```
```bash
cd apps/web && npx vitest run src/components/backup src/lib/i18n
```
The QEMU e2e job runs only in CI on the PR itself (`recovery-media-e2e`) — dispatch it per the repo's stacked-branch CI caveat if PR 2's base is not `main` directly: `gh workflow run CI --ref <branch>`.

- [ ] **Step 2: Lab proof (orchestrator, on KIT)**

Recipe source: `docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md` §11.1 (the existing W05 rows are the format to match — 5 columns: bold **Cell name**, Setup, Stack/version, Result (verdict-first, narrative, evidence values, defect cross-refs), Evidence (paths/PR links)).

Bring up a stack on KIT at the merged W09a branch + this W09b branch. Re-run the DR rehearsal that failed on 2026-09-20 per §11.1's `W05-dr-rehearsal` row (device `lab-ubuntu-src`, DR plan `52bc10b2` / group `9af702eb`, rebuild host `lab-ubuntu-src`, latest scheduled **incremental** snapshot — the same one that hit D27/#6403): the execution must now reach `validated`/`completed` instead of refusing 98,411 of 105,953 files. Record file counts (own vs. external, taken from the recovery's persisted result), elapsed time, and the hydration duration (from the API's `backup-snapshot-file-index` worker log, `enqueueSnapshotFileIndexHydration` → `hydrateSnapshotFileIndex` completion timestamp) as a new row:

```markdown
| **W09-dr-rehearsal-incremental (DR plan, `BARE_METAL_REBUILD`, rehearsal, incremental source)** | KIT `lab-ubuntu-src`, DR plan `52bc10b2` / group `9af702eb`, rebuild host `lab-ubuntu-src`, source = latest scheduled incremental `snapshot-20260920T020001Z-fc01402d` (the same snapshot D27 failed on) | lab stack @ W09a+W09b merge point; agent/helper rebuilt from this branch | **PASS** — hydration completed in `<fill from worker log>`; recovery `<id>` `planned→restoring→validated→completed`; `<own count>` own-prefix files + `<external count>` external files (all under `snapshots/20260901T…/`, the incremental's true base) restored successfully, 0 refused-by-scope. Resolves D27/#6403. | `scratchpad/w09proof/findings.md`, PR 2 link |
| **W09-skew-old-server (old recovery media vs. new server, referenced snapshot)** | scratch VM booting the W04b/W05 ISO (v0.114.x, pre-W09), recovering the same incremental snapshot against the W09-upgraded server | same lab stack | **PASS** — console shows the `client_capability_required` refusal message verbatim; target disk untouched (`lsblk` before/after identical); no partitions written. | `scratchpad/w09proof/findings.md` |
```
(Fill in the literal recovery id, file counts, and elapsed/hydration durations from the actual lab run before appending these rows to §11.1 — do not commit placeholder numbers.)

- [ ] **Step 3: Follow-ups to file before merge**

1. Local-provider `.gz` byte contract in token mode: `providers/local.go`'s `Upload`/`Download` gzip-compress/decompress based on the `.gz` key suffix (verified `local.go:53-121`), but `recoveryDownloadService.ts` streams stored bytes verbatim (per Part 0 §0) — a BMR recovery against a local-provider backend counts compressed bytes as "restored" and may double-(de)compress. File as a GitHub issue referencing this plan and Part 0's Global Constraints ".gz never added or stripped."
2. Own-prefix downloads never verify the resolved provider identity against the pinned identity (`recoveryBootstrap.ts:240-244`, per Part 0 §0) — only external-key downloads get that check under this wave. File as a follow-up.

- [ ] **Step 4: PR**

Same branch, after PR 1 (W09a) has merged. `gh pr create --base main --title "feat(bare-metal): agent follows cross-snapshot references under snapshot-file-membership-v1; refuse before provision (W09b)" --body "$(cat <<'EOF'
Closes #6464

## Part B author notes (Sonnet expansion, 2026-09-20)

- Every task's Files/Interfaces block was re-verified against the live worktree on 2026-09-20 via four parallel research passes (bmr package, rebuild engine/CLI, providers/e2e/console, web/docs/spec), not assumed from the stub. Five **Deviation:** notes were required where the stub's assumed file/line/type/name did not match reality — see the per-task callouts (Task 10 ×2, Task 11 ×1, Task 12 ×2, Task 13 ×2).
- The single biggest structural correction versus the stub: `buildTokenModeOptions`, `runTokenModeRebuild`, and `agent/cmd/breeze-backup/exec_bare_metal_rebuild.go` already exist (built in W05a, which has landed in this worktree) — Task 10 modifies them in place rather than extracting/creating them. This removes an entire "extract the token branch into a function" sub-step the stub implied was still needed.
- The object-key-vectors.json content in Task 8 is authored directly in this plan (24 vectors, ≥20 per Global Constraint 5) rather than deferred to Part A, since Part A's completion status relative to this branch could not be verified from this worktree alone; if Part A already shipped an identical file at the same path, `git add` is a no-op content match, not a conflict.
- Task 9 and parts of Task 10 could not reproduce 100% of the *unchanged* surrounding code in `download_provider.go`'s `downloadOnce`/`Download` and `download_session.go`'s `authenticateAndSwap` byte-for-byte, because the research pass summarized rather than re-quoted those spans in its final report. Per the task rules' rule 2, each such spot names the exact `sed -n` command to re-read the live function before applying the edit, and gives the exact new code to insert relative to a named anchor (an existing `if` condition, an existing field list) rather than a blind line-range overwrite.

## Pre-implementation checks (Part B) — resolve each with the listed grep before starting the task

- **`RunRecoveryWithTokenContext`'s in-scope `*BootstrapResponse` variable name** (Task 10, the `bmr.go` edit): the research pass confirmed the function signature and general shape but not the exact local variable holding its own authenticate result. I named it `currentBootstrap` as a placeholder and added an explicit grep instruction to find and substitute the real name before landing.
- **`console.go`'s existing time/clock seam** (Task 12, `waitAndRetryPending`): I assumed no seam exists yet and added a new `c.sleep` field, but instructed grepping for an existing `time.After`/`clock` field first and reusing it if present, to avoid introducing a second parallel testability mechanism.
- **`Console`'s `Deps.Exchange` field name and the `Answers`/constructor shapes** used in the new `console_test.go` cases (Task 12): only the top-level test-helper names (`fakeIO`, `fakeKey`, `fakeDeps`) were confirmed, not their internal fields — I instructed reading `console_test.go` in full before writing these tests for real, rather than guessing field names that would silently fail to compile-check against the actual struct.
- **`snapshot-dir`'s exact flag set** (Task 12, `seed-snapshot.sh`): confirmed no `--only-changed`-style flag exists (consistent with the researched full-file read showing it emits one full manifest per invocation with no diffing mode); a Python post-processing step against the already-seeded `e2e-1` manifest is used instead — no speculative CLI invocation is left in the script.
- **`e2e-3`'s exact "one changed file" choice** (`/etc/hostname`): chosen because it is a known-present, small, safely-rewritable file in the Debian rootfs `seed-snapshot.sh` already builds; not independently verified against the live `e2e-1` manifest's actual `sourcePath` set in this pass — confirm the path appears in a real `e2e-1/manifest.json` before relying on the Python script's `else: raise SystemExit(...)` guard to fail loudly if it doesn't.
- **`run-qemu.sh`'s fake-server log and mount-point variable names** (Task 12): named `fakeserver_log`/`mount_point` as placeholders with an explicit instruction to grep the real variable names from the script.


## Self-review notes (plan author — controller, 2026-09-20)

**Spec / design coverage.** Spec §4 data flow ("downloads bootstrap + manifests") → §1 wire contract (Task 5 server, Task 8 agent). §9 "Nothing is written before preflight passes" → R14–R17: `ApplyManifestScope`/`WidenScopeFromManifest` run before `runTokenModeRebuild`'s DryRun and before `applySystemState` in `bmr.go` (Task 10), and the engine's `ObjectAdmission` sweep sits in `preflight` ahead of `provision` (Task 10). §9 "tokens keep single-use semantics" → negotiation runs before `codeUsedAt`/token flip (Task 5, R2/R3). §10 CI integration → three-generation QEMU e2e (Task 12); lab → Task 14. §11 gains W09 and §8.5 is added (Task 13). Design points on #6464: (1) exact membership → Task 6 `authorizeExternalReference` (index `complete` + `backup_snapshot_files` + `backup_snapshot_origins`); (2) server-side verified-complete index → Tasks 3–4 (`file_index_status`, sha256 of the fetched manifest bytes); (3) provenance surviving retirement → Task 2 `backup_snapshot_origins` + Task 3 step 6 (live row OR retirement record, fail closed otherwise); (4) capability negotiation in both skew directions, refusal before destructive work → Tasks 5, 8, 9, 10 (R2, R5, R14, R15, R16); (5) one object-key contract, never rewrite `.gz` → Task 1 vectors file shared with Task 8. #6403 "also observed" 413 → Tasks 6 and 11 (R18); the console server-URL re-prompt is a deliberate non-goal (§5).

**Placeholder scan.** `grep -n -i 'TBD\|TODO\|similar to Task\|add appropriate\|fill in'` returns only the Task 14 instruction not to commit placeholder lab numbers.

**Type / name consistency (checked across parts).** TS: `BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY`, `parseBackupObjectKey`, `classifyBackupObjectKey`, `hasMembershipCapability`, `hydrateSnapshotFileIndex`, `readSnapshotFileIndexState` (returns `originSnapshotIds` + `retryable`), `RETRYABLE_HYDRATION_FAILURES`, `hydrationFailureFromError`, `enqueueSnapshotFileIndexHydration(id, reason)`, `negotiateRecoveryCapabilities`, `RECOVERY_REFUSAL_MESSAGES`, `externalReferencePreflight`, `authorizeExternalReference`, `fetchBackupObjectBytes`, `backupSnapshotOrigins`. Go: `CapabilitySnapshotFileMembershipV1`, `ClientCapabilities`, `ParseObjectKey`, `IsExternalObjectKey`, `FileIndexInfo`, `AuthenticatedDownloadDescriptor.Capabilities`, `AuthenticatedSnapshot.FileIndex`, `Admits`/`ExtendAdmissible`/`MembershipNegotiated`, `ErrCapabilityDowngrade`, `ScopeRefusalError`, `ExternalObjectKeys`, `ApplyManifestScope`, `WidenScopeFromManifest`, `rebuild.ObjectAdmission`, `Result.FilesFailed`/`FailedFilesSample`/`FailedFilesOmitted`, `BoundProgressUpdate`. Wire: `capabilities` (request), `download.capabilities`, `snapshot.fileIndex.{status,manifestSha256,externalCount,originSnapshotIds}`, six 409 codes, `failedFilesSample`/`filesFailed`/`failedFilesOmitted`.

**Deliberate deviations from the stubs (all recorded inline).** Hydration retryability is a pure function of the failure code (`origin_identity_pending` split out of `origin_unverifiable`) instead of a second column; the `backup_snapshot_files` delete rides in the first insert batch's transaction; the server's `bmrProgressSchema` result cap equals the agent's 768 KiB body bound; `'authenticate'` added to the hydration reason union; the Go type is `AuthenticatedSnapshot` (not `BootstrapSnapshot`); the console lives in `agent/internal/recoveryconsole/console.go`; the web change lands in `BareMetalRecoveryPanel.tsx`; locales live under `apps/web/src/locales/<tag>/backup.json`.

**Review provenance.** Part 0 (contract, code maps, matrix) written by the controller from three parallel read-only code maps; Tasks 1–14 expanded by two Sonnet workers (Codex was at its usage limit until 2026-09-26); two independent Sonnet consistency reviews returned 8 + 25 findings, all applied — the consequential ones: `authorizeExternalReference` initially skipped the `file_index_status = 'complete'` gate; `loadSnapshotForHydration` omitted `jobId` (hydration would have been a permanent no-op); route glue hard-coded `retryable: true` (unbounded re-enqueue on terminal failures); the `bmr.go` scope check was placed after `applySystemState`; `BoundProgressUpdate` only trimmed `map[string]any` results; run-qemu.sh lacked the fakeserver capability flags; Task 8 re-authored the shared vectors file. The `/pr-review-toolkit:review-pr` round on each PR is still required (Tasks 7 and 14).

**Next after this doc merges.** `start_wave` W09 with branch `feature/5493-bare-metal-boot-media/wave-6464`; implement W09a (Tasks 1–7) and W09b (Tasks 8–14) with Codex drivers once the usage limit resets (2026-09-26), Sonnet drivers before that; the W09b lab proof is the orchestrator's.
