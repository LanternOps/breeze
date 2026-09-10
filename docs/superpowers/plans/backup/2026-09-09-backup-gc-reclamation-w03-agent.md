# Wave 03 — Agent/helper: server-owned dedupe base, leases, never delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent consume a server-selected incremental-dedupe base, refuse to publish a manifest past its lease/journal-age fence, and stop performing any remote deletion of its own.

**Architecture:** `agent/cmd/breeze-backup/exec_backup.go` decodes two new `backup_run` payload fields (`baseSnapshotId`, `publishLeaseExpiresAt`) into `backup.BackupConfig`; `agent/internal/backup/backup.go`'s run path switches between the new server-owned base fetch (`fetchServerOwnedBase`, `incremental.go`) and the unchanged legacy `previousManifest` bucket-listing path purely on whether `BaseSnapshotID` is nil. A new `leaseGate` provider wrapper (`snapshot.go`) intercepts only `manifest.json` uploads and fails closed once the lease (plus a 1h margin) or, for a resumed run, the checkpoint journal's age has expired — no signature change to the widely-called `createSnapshotWithProgress` is needed. Agent-side deletion of OTHER, already-published snapshots is removed outright (the retention-prune branch, `DeleteSnapshot`/`DeleteSnapshotContext`, and the stale-journal remote cleanup call) — the two narrower own-run-prefix cleanups (`abortStopped`/`abortSourceGone` in `snapshot.go`, which can only ever delete the CURRENT, never-published run's own objects) are explicit, spec-confirmed exceptions and are kept as-is. `provider.Delete` is otherwise used only for the new `upload.lease` heartbeat object's post-publish removal.

**Tech Stack:** Go 1.25 (agent), `go test -race`, TypeScript/Vitest for the one cross-boundary contract-test addition.

**Spec:** `docs/superpowers/specs/backup/2026-09-09-backup-gc-reclamation-design.md` §3.1 (agent bullets), §3.4 (upload.lease), §3.5 (agent never deletes), §6 (Agent verification) — v3.

**Depends on:** None at the code level. Protocol switch is presence of `baseSnapshotId` in the `backup_run` payload; an older/unmodified server (or W01 not yet merged) omits both new fields, and every payload-parsing change below defaults to nil/zero in that case, which routes to the unchanged legacy path. Task 8's contract test is written to stay green either way (see its `skipIf`).

## Global Constraints

- Payload fields (consumed, not produced by this wave): `payload.baseSnapshotId: string` (`""` = full run; absent = legacy mode) and `payload.publishLeaseExpiresAt: RFC3339 string` (set for **every** dispatched file/system_image run, base or not — spec §3.1).
- Publish margin: `publishMargin = 1 * time.Hour`, declared as a constant in `agent/internal/backup/snapshot.go`. Fence condition: refuse to publish `manifest.json` when `time.Now().Add(publishMargin).After(publishLeaseExpiresAt)`.
- New sentinel errors in `agent/internal/backup/backup.go`: `ErrPublishLeaseExpired`, `ErrJournalExpiredAtPublish`.
- `journalMaxAge = 7 * 24 * time.Hour` (`agent/internal/backup/journal.go:34`) — unchanged, reused as the resumed-journal-age fence.
- `uploadLeaseInterval = 15 * time.Minute`, constant in `agent/internal/backup/snapshot.go`, comment must state it stays well under the API's 9-day (`journalMaxAge` + 48h grace) manifest-less window.
- No lease renewal exists anywhere in this wave: the helper enforces exactly the payload's `publishLeaseExpiresAt` value with no extension. A run that legitimately takes longer than the lease fails to publish by design — this mirrors the existing `journalMaxAge` non-resumable-after-7-days envelope, not a new limitation class.
- **Gate-installation rule (P1 fix):** a present `baseSnapshotId` field (server-owned mode is ON — including an explicit full run, `baseSnapshotId: ""`) REQUIRES a non-zero `publishLeaseExpiresAt`; a payload violating this is rejected outright by `managerFromBackupRunPayload` (Task 1) before any manager is built. The `leaseGate` (Task 4) installs whenever `BackupConfig.BaseSnapshotID != nil` — never keyed off the lease value alone — so a legacy server (nil `BaseSnapshotID`) skips the gate entirely, and a server-owned-mode run always gets it. Inside the gate, a zero lease is treated as a fail-CLOSED bug condition (refuse to publish), never as "no lease configured, go ahead."
- `DeleteSnapshot`, `DeleteSnapshotContext` are removed from `agent/internal/backup/snapshot.go` (ground truth below confirms no other caller exists). `cleanupSnapshotPrefix`/`listSnapshotPrefixItems` are KEPT — spec §3.5 names the own-run-prefix abort cleanups (`snapshot.go:499`, `:544`) as explicit exceptions.

## 0. Ground truth (re-verified 2026-09-09 against this worktree)

- `agent/cmd/breeze-backup/exec_backup.go:101-178` `managerFromBackupRunPayload` — decodes `provider`/`providerConfig`/`paths`/`systemImage`/`vss` from the `backup_run` payload; builds `backup.BackupConfig` twice (system_image branch `:154-163`, file-mode branch `:171-177`). No `baseSnapshotId`/lease field exists yet.
- `agent/internal/backup/backup.go:56-109` `BackupConfig` struct. `:220-224` `GetRetention` doc comment currently says "0 makes `DeleteSnapshotContext` a no-op" — stale after Task 5, needs rewording.
- `agent/internal/backup/backup.go:665-691` — `runIdentity := m.runBackupIdentity()` then the `previousManifest` call gated by `incrementalDedupeActive`. This is the one and only mode-switch point for Task 2.
- `agent/internal/backup/backup.go:717-756` — journal open (`:723-736`), `journal.StaleSnapshotID()` check that calls `cleanupSnapshotPrefix(m.config.Provider, staleID)` at `:748` (spec's "backup.go:738" is off by ~10 lines in this worktree; re-verified).
- `agent/internal/backup/backup.go:758` — `createSnapshotWithProgress(runCtx, m.config.Provider, files, progressFn, journal, prevSnapshot, sourceLiveness, runIdentity)`. This is the one call site inside `RunBackupContext` where the lease-gated provider must be substituted.
- `agent/internal/backup/backup.go:780-806` — the retention-prune branch (`if snapshot != nil && m.config.Retention > 0 && !incrementalDedupeActive { retentionErr = DeleteSnapshotContext(...) }`). Matches spec's `backup.go:780-806` exactly.
- Two more agent-side remote-delete call sites exist beyond the retention branch and stale-journal cleanup — both are the spec's explicit exceptions (§3.5, re-read after coordinator review), NOT bugs to remove:
  - `agent/internal/backup/snapshot.go:499` — `abortStopped()`'s `if journal == nil { cleanupSnapshotPrefix(provider, snapshot.ID) }` (fires when a job is stopped/cancelled mid-run with no checkpoint journal). Deletes only the current run's OWN, never-published prefix.
  - `agent/internal/backup/snapshot.go:544` — `abortSourceGone()`'s `if len(snapshot.Files) == 0 { cleanupSnapshotPrefix(provider, snapshot.ID) }` (fires when the source volume disappears mid-run, no journal, and zero files landed). Same own-prefix-only property.
  Both are safe by construction: until a manifest publishes an id, nothing else can reference it, so deleting it deletes nothing anyone else depends on. This is categorically different from the retention branch and `DeleteSnapshotContext`, which delete an OTHER, already-published (and possibly cross-referenced) snapshot's entire prefix — that is the actually dangerous case §3.5 removes. Task 5 keeps both call sites and the `cleanupSnapshotPrefix`/`listSnapshotPrefixItems` functions they use.
- `agent/internal/backup/snapshot.go:884-892` `cleanupSnapshotPrefix` (KEPT), `:1025-1032` `listSnapshotPrefixItems` (KEPT), `:972-1023` `DeleteSnapshot`/`DeleteSnapshotContext` (REMOVED). Confirmed via `grep -rn "DeleteSnapshotContext(\|DeleteSnapshot(" agent/ apps/` that `backup.go:799` is the ONLY caller of `DeleteSnapshotContext`, and `DeleteSnapshot` (non-context) has ZERO callers outside its own file and tests — both remove cleanly with no orphaned caller elsewhere in `agent/` or `apps/helper/`. `listSnapshotPrefixItems` has a second caller (`cleanupSnapshotPrefix`, `:885`) beyond the removed `DeleteSnapshotContext` (`:1002`), so it stays.
- `agent/cmd/breeze-backup/exec_backup.go:363-372` `execBackupCleanup` (the `backup_cleanup` command) calls `backup.CleanupRestoreDir`, a **local** staging-directory cleanup — it never calls `DeleteSnapshot`/`DeleteSnapshotContext`. Confirms spec §3.5's "removed (`backup_cleanup` is local-only)" clause: no command handler needs those two kept.
- `agent/internal/backup/incremental.go:54-92` `previousManifest` (spec says `:53-100`, off by one; logic identical) — scans `ListSnapshots` results newest-first for `candidate.BackupIdentity == identity`; empty `identity` short-circuits to full-run.
- `agent/internal/backup/snapshot.go:52-91` `Snapshot` struct (`ID`, `Timestamp`, `Files`, `Size`, `FormatVersion`, `BaseSnapshotID`, `BackupIdentity`, `UploadFailures`). `:898-956` `ListSnapshots` downloads and decodes every `snapshots/*/manifest.json`. `:1099-1126` `backupIdentity`/`runBackupIdentity`.
- `agent/internal/backup/snapshot.go:343` `createSnapshotWithProgress(ctx, provider, files, onProgress, journal, prevSnapshot, sourceLiveness, runIdentity ...string) (*Snapshot, error)` — called from ~30 sites across `backup.go` and 5 test files with a bare `providers.BackupProvider`. Deliberately left with this exact signature (no new parameter) — see Task 4's design note.
- `agent/internal/backup/snapshot.go:812-834` `publishSnapshotManifest` — writes the manifest to a temp file, then `uploadSnapshotFile(attemptCtx, provider, manifestPath, manifestKey)`. Both the normal-completion call (`:784`) and the `abortSourceGone` partial-manifest call (`:544-561`, specifically the `publishSnapshotManifest` at `:548`) go through this same function, so gating at the `provider.Upload`/`UploadContext` boundary via `isManifestPath` covers both without duplicating the check.
- `agent/internal/backup/snapshot.go:151` `contextUploader` interface (`UploadContext(ctx, localPath, remotePath) error`), checked via type assertion in `uploadSnapshotFile` (`:869`).
- `agent/internal/backup/snapshot.go:1054-1057` `isManifestPath(item string) bool` — already matches `.../manifest.json` or a bare `manifest.json` basename; reused as-is by the new lease gate, no change needed.
- `agent/internal/backup/journal.go:34` `journalMaxAge`. `:60-68` `snapshotJournal` struct has no `createdAt` field today — `header.CreatedAt` is read at `:155` inside `openSnapshotJournal` but never stored on the struct, so nothing today can ask "how old is my journal" after open. `:268-292` `createFreshJournal` builds `header.CreatedAt = time.Now().UTC()` but likewise drops it. `:88` `resumed bool` field already exists and is exactly the flag Task 4 needs ("if the run was resumed from a journal").
- `agent/internal/backup/snapshot_test.go:18-111` `mockProvider` — the fake `providers.BackupProvider` used across the package (`uploadCalls`/`deleteCalls`/`downloadCalls` tracking, `listResult` override, `uploadErr`/`downloadErr`/`listErr`/`deleteErr` injection). This is the fake every new test in this wave uses; no new fake needed.
- `agent/internal/backup/snapshot_lifecycle_test.go:108-208` (`TestDeleteSnapshot_NothingToDelete`, `_ZeroRetention`, `_NegativeRetention`, `_PrunesOldSnapshots`, `_RetentionExceedsCount`, `_DeleteError`) and `agent/internal/backup/snapshot_test.go:198-230` (`TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix`) are the seven tests directly exercising the functions Task 5 removes.
- `agent/internal/backup/backup_test.go:924-985` `TestRunBackup_IncrementalRetentionDoesNotStrandReferencedObjects` already asserts the agent performs **no** pruning in the incremental path (its comment describes the bug this wave permanently forecloses) — it needs no behavior change, only a comment update (the branch it describes is now gone, not merely gated).
- `apps/api/src/services/backupAgentContract.test.ts` (243 lines) — existing source-text-grep contract suite (e.g. `:31-48` pins `journalMaxAge` parity). Picked up by the ordinary unit config: confirmed `apps/api/vitest.config.ts` has no `exclude` for `services/*.test.ts`, so this file runs in `pnpm --filter @breeze/api test`, not the integration config.
- `apps/api/src/jobs/backupWorker.ts:411-490,640-760` `resolveBackupTargets`/dispatch payload construction — confirmed **no** `baseSnapshotId`/`publishLeaseExpiresAt` field exists yet (W01's job). Task 8's contract test must not hard-fail before W01 lands.
- `apps/api/src/services/backupHelperCapabilities.ts:1-20` — existing min-helper-version gate pattern (`BACKUP_QUEUE_MIN_HELPER_VERSION`, `backupHelperSupportsQueue`) that W02 will mirror for the GC capability gate; W03 does not add a TS constant, it only needs to confirm the *mechanism* by which a shipped agent's version becomes visible server-side (Task 9 below, doc-only).
- `agent/internal/heartbeat/backup_version.go:13-120` (exec at `:160`) — the helper reports its version by shelling out to `breeze-backup --version`, which prints `Breeze Backup Version: <version>` (`agent/cmd/breeze-backup/main.go:36 var version = "dev"`, overridden via `-ldflags "-X main.version=$VERSION"` in `agent/Makefile:2-8` and the release build script). This is a **build-time value supplied by the release pipeline**, not something this wave's code sets — see Open Questions.

## File structure

- Modify `agent/cmd/breeze-backup/exec_backup.go` — decode `baseSnapshotId`/`publishLeaseExpiresAt`, thread into both `BackupConfig` literals.
- Modify `agent/internal/backup/backup.go` — `BackupConfig` new fields + doc comments, HOISTED journal-open block (moved before VSS/scan) + early resume-shortcut check, gate-install call site keyed on `BaseSnapshotID != nil`, remove the retention-prune branch (preserving the `runCtx.Err()` guard that was inside it), remove ONLY the stale-journal `cleanupSnapshotPrefix` call (the two own-run-prefix `cleanupSnapshotPrefix` calls in `snapshot.go` are kept, see Task 5), fix `job.Error = errors.Join(scanErr, retentionErr)` → `job.Error = scanErr`, add `ErrPublishLeaseExpired`/`ErrJournalExpiredAtPublish`, add `GetBaseSnapshotID`/`GetPublishLeaseExpiresAt` getters, add a plain `"path"` import.
- Modify `agent/internal/backup/incremental.go` — new `fetchServerOwnedBase` function (imports gain `encoding/json`, `os`).
- Modify `agent/internal/backup/journal.go` — add `createdAt time.Time` field + `Age() time.Duration` method.
- Modify `agent/internal/backup/providers/interface.go` — new `ErrObjectNotFound` sentinel.
- Modify `agent/internal/backup/providers/local.go` and `agent/internal/backup/providers/s3.go` — wrap confirmed-not-found `Download` errors with `ErrObjectNotFound`.
- Modify `agent/internal/backup/snapshot.go` — new `leaseGate` provider wrapper (fail-closed on a zero lease) + `publishMargin` const + `uploadLeaseInterval` var; remove `DeleteSnapshot`/`DeleteSnapshotContext` only (`cleanupSnapshotPrefix`/`listSnapshotPrefixItems` and their two call sites in `abortStopped`/`abortSourceGone` are KEPT — spec §3.5 exception); add the three-state `fetchPublishedManifest` + its defensive in-function resume-shortcut check; add the `upload.lease` refresh goroutine (bounded per-refresh context, `leaseCtx`-based cancellation) + post-publish delete inside `createSnapshotWithProgress`.
- Modify (delete tests) `agent/internal/backup/snapshot_lifecycle_test.go` — remove the six `TestDeleteSnapshot_*` tests (they target the removed `DeleteSnapshot`/`DeleteSnapshotContext`) and the now-unused `"fmt"`/`"strings"` imports; no replacement test added here (moved to `backup_test.go`).
- Modify `agent/internal/backup/snapshot_test.go` — remove `TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix`; add `TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAForeignPublishedPrefix` plus lease-gate / resume-shortcut / upload-lease / `fetchPublishedManifest` tests.
- Modify `agent/internal/backup/incremental_test.go` — add `TestFetchServerOwnedBase` table.
- Modify `agent/internal/backup/journal_test.go` — add `TestSnapshotJournal_Age` (with the real-gap fix), `TestSnapshotJournal_Age_SurvivesResume`.
- Modify `agent/internal/backup/backup_test.go` — add `TestBackupNeverDeletesRemoteObjects_RetentionConfigured` (system-state-only config, see Task 5), rewrite `TestRunBackupContext_StaleJournalCleansUpRemotePrefixAndRunsFresh` → `TestRunBackupContext_StaleJournalDiscardedWithoutRemoteCleanup`, add `TestRunBackupContext_ServerOwnedMode_NeverListsTheBucket`, `TestRunBackupContext_ExpiredLease_RefusesToPublishManifest` (Task 4b), `TestRunBackupContext_ResumeWithPublishedManifest_SucceedsEvenIfSourceGone` (Task 6), update the stale comment on `TestRunBackup_IncrementalRetentionDoesNotStrandReferencedObjects`.
- Modify (new tests) `agent/internal/backup/providers/local_test.go`, `agent/internal/backup/providers/s3_test.go` — `ErrObjectNotFound` wrapping proof.
- Modify `agent/cmd/breeze-backup/exec_backup_test.go` — extend `TestManagerFromBackupRunPayload` table with the two new fields; add `TestManagerFromBackupRunPayload_RejectsServerOwnedModeWithoutLease`.
- Modify `apps/api/src/services/backupAgentContract.test.ts` — add the Go/TS payload-field-name parity test, the real `BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` import + comparison, and the gated `BACKUP_PUBLISH_MARGIN_MS` regex check.

### Task 1: Thread `baseSnapshotId`/`publishLeaseExpiresAt` from payload into `BackupConfig`

**Files:**
- Modify `agent/internal/backup/backup.go:56-109` (`BackupConfig` struct), `:220-224` (`GetRetention` comment)
- Modify `agent/cmd/breeze-backup/exec_backup.go:101-178` (`managerFromBackupRunPayload`)
- Test: `agent/cmd/breeze-backup/exec_backup_test.go:283-360` (extend `TestManagerFromBackupRunPayload`)

**Interfaces:**
- Produces: `BackupConfig.BaseSnapshotID *string`, `BackupConfig.PublishLeaseExpiresAt time.Time`
- Produces: `(*BackupManager) GetBaseSnapshotID() *string`, `(*BackupManager) GetPublishLeaseExpiresAt() time.Time`
- Consumes: `backup_run` payload fields `baseSnapshotId` (JSON string, may be absent), `publishLeaseExpiresAt` (JSON RFC3339 string, may be absent)

- [ ] Step 1: Write the failing test — extend the table in `TestManagerFromBackupRunPayload` (`exec_backup_test.go`), adding `wantBaseSnapshotID *string` and `wantPublishLeaseExpiresAt time.Time` fields to the test struct, two new cases, and assertions in the loop body:

```go
// Added fields on the existing test struct (exec_backup_test.go:283-296):
wantBaseSnapshotID        *string
wantPublishLeaseExpiresAt time.Time

// New cases appended to the table:
{
    name:                      "server-owned mode: non-empty baseSnapshotId with a lease",
    payload:                   `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"],"baseSnapshotId":"snap-123","publishLeaseExpiresAt":"2026-09-16T00:00:00Z"}`,
    wantProvider:              "local",
    wantBasePath:              filepath.Clean("/var/backups"),
    wantPaths:                 []string{"/data"},
    wantVSS:                   runtime.GOOS == "windows",
    wantBaseSnapshotID:        strPtr("snap-123"),
    wantPublishLeaseExpiresAt: time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC),
},
{
    name:               "server-owned mode: empty baseSnapshotId means full run, lease still set",
    payload:            `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"],"baseSnapshotId":"","publishLeaseExpiresAt":"2026-09-16T00:00:00Z"}`,
    wantProvider:       "local",
    wantBasePath:       filepath.Clean("/var/backups"),
    wantPaths:          []string{"/data"},
    wantVSS:            runtime.GOOS == "windows",
    wantBaseSnapshotID: strPtr(""),
    wantPublishLeaseExpiresAt: time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC),
},
{
    name:         "legacy payload: no baseSnapshotId field at all",
    payload:      `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"]}`,
    wantProvider: "local",
    wantBasePath: filepath.Clean("/var/backups"),
    wantPaths:    []string{"/data"},
    wantVSS:      runtime.GOOS == "windows",
    // wantBaseSnapshotID left nil (legacy mode), wantPublishLeaseExpiresAt left zero.
},
```

Also add a dedicated rejection test (P1 fix — a present `baseSnapshotId` with a missing/zero lease must be a hard payload error, not a silently-ungated run):
```go
func TestManagerFromBackupRunPayload_RejectsServerOwnedModeWithoutLease(t *testing.T) {
	cases := []struct {
		name    string
		payload string
	}{
		{
			name:    "baseSnapshotId present, publishLeaseExpiresAt entirely absent",
			payload: `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"],"baseSnapshotId":"snap-1"}`,
		},
		{
			name:    "baseSnapshotId present, publishLeaseExpiresAt empty string",
			payload: `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"],"baseSnapshotId":"snap-1","publishLeaseExpiresAt":""}`,
		},
		{
			name:    "baseSnapshotId is an explicit full-run empty string, lease still required",
			payload: `{"provider":"local","providerConfig":{"path":"/var/backups"},"paths":["/data"],"baseSnapshotId":""}`,
		},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			mgr, err := managerFromBackupRunPayload(json.RawMessage(tt.payload))
			if err == nil {
				t.Fatal("expected an error rejecting a server-owned-mode payload with no publish lease")
			}
			if mgr != nil {
				t.Fatal("expected a nil manager on rejection")
			}
		})
	}
}
```

Add near the top of the test file (or reuse if a similar helper already exists — grep first):
```go
func strPtr(s string) *string { return &s }
```

In the loop body, after the existing `wantVSS` assertion, add:
```go
gotBase := mgr.GetBaseSnapshotID()
if (gotBase == nil) != (tt.wantBaseSnapshotID == nil) {
    t.Fatalf("GetBaseSnapshotID() = %v, want %v", gotBase, tt.wantBaseSnapshotID)
}
if gotBase != nil && tt.wantBaseSnapshotID != nil && *gotBase != *tt.wantBaseSnapshotID {
    t.Fatalf("GetBaseSnapshotID() = %q, want %q", *gotBase, *tt.wantBaseSnapshotID)
}
if !mgr.GetPublishLeaseExpiresAt().Equal(tt.wantPublishLeaseExpiresAt) {
    t.Fatalf("GetPublishLeaseExpiresAt() = %v, want %v", mgr.GetPublishLeaseExpiresAt(), tt.wantPublishLeaseExpiresAt)
}
```

- [ ] Step 2: Run it, expect FAIL with `mgr.GetBaseSnapshotID undefined (type *backup.BackupManager has no field or method GetBaseSnapshotID)`; the new rejection test currently FAILS the other way (expects an error, gets none, since no validation exists yet):
```
cd agent && go test ./cmd/breeze-backup/ -run 'TestManagerFromBackupRunPayload|TestManagerFromBackupRunPayload_RejectsServerOwnedModeWithoutLease'
```

- [ ] Step 3: Implement.

In `agent/internal/backup/backup.go`, add to the `BackupConfig` struct (after the `AgentID string` field, before `VSSProvider`, i.e. insert before line 109's closing brace):
```go
	// BaseSnapshotID switches this run between server-owned base selection
	// (D18 §3.1) and the legacy bucket-listing previousManifest path. nil
	// means the dispatching server predates the field (legacy mode,
	// unchanged behavior — see exec_backup.go's payload decode). A non-nil
	// pointer to "" means the server explicitly selected no base for this
	// run (full run, no dedupe attempted). A non-nil pointer to a snapshot
	// id means the server selected that snapshot as this run's dedupe base
	// — fetchServerOwnedBase fetches and validates it (D6 identity guard)
	// before use, failing open to a full run on any problem (download
	// error, decode error, or identity mismatch).
	BaseSnapshotID *string

	// PublishLeaseExpiresAt is the deadline (verbatim from the backup_run
	// payload's publishLeaseExpiresAt field) after which this run must not
	// publish snapshots/<id>/manifest.json — see leaseGate. Set for every
	// server-dispatched file/system_image run, base or not (it fences late
	// results server-side too, D18 §3.1). Zero value means the dispatching
	// server predates the field, disabling the check entirely (legacy
	// behavior: publish whenever ready). There is no renewal — this is
	// exactly what the server chose at dispatch time.
	PublishLeaseExpiresAt time.Time
```

Add getters after `GetAgentID` (backup.go, near line 212):
```go
// GetBaseSnapshotID returns the server-selected incremental-dedupe base for
// this run (D18 §3.1): nil in legacy mode, a pointer to "" for an
// explicit full run, a pointer to a snapshot id otherwise.
func (m *BackupManager) GetBaseSnapshotID() *string {
	return m.config.BaseSnapshotID
}

// GetPublishLeaseExpiresAt returns the deadline this run must publish its
// manifest by (zero value = no lease, legacy server).
func (m *BackupManager) GetPublishLeaseExpiresAt() time.Time {
	return m.config.PublishLeaseExpiresAt
}
```

Update the now-stale `GetRetention` doc comment (backup.go:220-224):
```go
// GetRetention returns the configured retention count. It is retained for
// config-shape compatibility only: agent-side retention pruning has been
// removed entirely (D18 §3.5) — the server is the sole retention/GC
// authority. This value drives no behavior anywhere in this package.
func (m *BackupManager) GetRetention() int {
	return m.config.Retention
}
```

In `agent/cmd/breeze-backup/exec_backup.go`, extend the payload struct inside `managerFromBackupRunPayload` (`:105-114`):
```go
	var p struct {
		Provider       string                   `json:"provider"`
		ProviderConfig *backupRunProviderConfig `json:"providerConfig"`
		Paths          []string                 `json:"paths"`
		SystemImage    bool                     `json:"systemImage"`
		// BaseSnapshotID/PublishLeaseExpiresAt implement the D18 §3.1
		// server-owned-base protocol. BaseSnapshotID's presence in the JSON
		// (vs. entirely absent) is the protocol switch: a *string stays nil
		// when the field is omitted (older server, legacy bucket-listing
		// mode) and becomes non-nil (possibly pointing at "") when present.
		BaseSnapshotID        *string `json:"baseSnapshotId"`
		PublishLeaseExpiresAt string  `json:"publishLeaseExpiresAt"`
		// Vss lets the server force VSS on/off for this run. Not currently sent
		// by apps/api/src/jobs/backupWorker.ts (a future policy toggle can); when
		// absent the agent defaults it itself below.
		Vss *bool `json:"vss,omitempty"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Errorf("invalid backup_run payload: %w", err)
	}
	if p.ProviderConfig == nil || p.Provider == "" {
		return nil, nil
	}
	var publishLeaseExpiresAt time.Time
	if p.PublishLeaseExpiresAt != "" {
		parsed, parseErr := time.Parse(time.RFC3339, p.PublishLeaseExpiresAt)
		if parseErr != nil {
			return nil, fmt.Errorf("invalid backup_run payload: publishLeaseExpiresAt %q: %w", p.PublishLeaseExpiresAt, parseErr)
		}
		publishLeaseExpiresAt = parsed
	}
	// D18 §3.1 (P1 fix): publishLeaseExpiresAt is sent for EVERY
	// server-owned-mode run — base or an explicit full run — never only
	// when a base was actually chosen. A present baseSnapshotId (server-
	// owned mode is ON, even if it points at "") with a missing, empty, or
	// unparseable-to-zero lease means the dispatching server is violating
	// its own protocol. Reject the WHOLE payload here rather than silently
	// running server-owned mode ungated: main.go's caller turns this error
	// into `fail(err.Error())`, so the backup_run command fails outright
	// and uploads nothing.
	if p.BaseSnapshotID != nil && publishLeaseExpiresAt.IsZero() {
		return nil, fmt.Errorf("invalid backup_run payload: baseSnapshotId is present (server-owned mode) but publishLeaseExpiresAt is missing, empty, or zero")
	}
```

Then add `BaseSnapshotID: p.BaseSnapshotID` and `PublishLeaseExpiresAt: publishLeaseExpiresAt` to BOTH `backup.NewBackupManager(backup.BackupConfig{...})` literals — the system_image branch (`:154-163`) and the file-mode branch (`:171-177`):
```go
		return backup.NewBackupManager(backup.BackupConfig{
			Provider:              provider,
			SystemStateEnabled:    true,
			VSSEnabled:            vssEnabled,
			AgentID:               helperAgentID,
			BaseSnapshotID:        p.BaseSnapshotID,
			PublishLeaseExpiresAt: publishLeaseExpiresAt,
		}), nil
	}
	if len(p.Paths) == 0 {
		return nil, fmt.Errorf("backup_run payload has no paths")
	}
	return backup.NewBackupManager(backup.BackupConfig{
		Provider:              provider,
		Paths:                 p.Paths,
		Retention:             0,
		VSSEnabled:            vssEnabled,
		AgentID:               helperAgentID,
		BaseSnapshotID:        p.BaseSnapshotID,
		PublishLeaseExpiresAt: publishLeaseExpiresAt,
	}), nil
```

- [ ] Step 4: Run, expect PASS:
```
cd agent && go test ./cmd/breeze-backup/ -run TestManagerFromBackupRunPayload -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/backup.go agent/cmd/breeze-backup/exec_backup.go agent/cmd/breeze-backup/exec_backup_test.go
git commit -m "feat(agent/backup): decode server-owned base pin + publish lease from backup_run payload"
```

### Task 2: `fetchServerOwnedBase` + run-path mode switch

**Files:**
- Modify `agent/internal/backup/incremental.go` (new function; add `encoding/json`, `os` imports)
- Modify `agent/internal/backup/backup.go:665-691`
- Test: `agent/internal/backup/incremental_test.go` (new table), `agent/internal/backup/backup_test.go` (new `RunBackupContext` cases)

**Interfaces:**
- Produces: `fetchServerOwnedBase(ctx context.Context, provider providers.BackupProvider, baseSnapshotID, identity string) (*Snapshot, string)` — mirrors `previousManifest`'s `(*Snapshot, reason string)` fail-open contract.
- Consumes: `Snapshot.BackupIdentity`, `snapshotRootDir`, `snapshotManifestKey` (all existing).

- [ ] Step 1: Write the failing test in `incremental_test.go` (mirror `storeManifest`/`newMockProvider` helpers already used at the top of that file):

```go
func TestFetchServerOwnedBase(t *testing.T) {
	const myIdentity = "s3|bucket-1|device-a|file"

	t.Run("valid base with matching identity", func(t *testing.T) {
		provider := newMockProvider()
		base := &Snapshot{
			ID:             "snap-base",
			Timestamp:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			BackupIdentity: myIdentity,
			Files:          []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snap-base/files/a.txt.gz", Size: 1}},
		}
		storeManifest(t, provider, base)

		snap, reason := fetchServerOwnedBase(context.Background(), provider, "snap-base", myIdentity)
		if snap == nil {
			t.Fatalf("expected a matching snapshot, got nil (reason: %s)", reason)
		}
		if snap.ID != "snap-base" {
			t.Fatalf("fetchServerOwnedBase picked %q, want %q", snap.ID, "snap-base")
		}
	})

	t.Run("identity mismatch falls back to full run", func(t *testing.T) {
		provider := newMockProvider()
		base := &Snapshot{
			ID:             "snap-base",
			Timestamp:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			BackupIdentity: "s3|bucket-1|device-b|file",
			Files:          []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snap-base/files/a.txt.gz", Size: 1}},
		}
		storeManifest(t, provider, base)

		snap, reason := fetchServerOwnedBase(context.Background(), provider, "snap-base", myIdentity)
		if snap != nil {
			t.Fatalf("expected nil on identity mismatch, got %+v", snap)
		}
		if reason == "" {
			t.Error("expected a non-empty reason")
		}
	})

	t.Run("empty baseSnapshotId means full run", func(t *testing.T) {
		provider := newMockProvider()
		snap, reason := fetchServerOwnedBase(context.Background(), provider, "", myIdentity)
		if snap != nil {
			t.Fatalf("expected nil for empty baseSnapshotId, got %+v", snap)
		}
		if reason == "" {
			t.Error("expected a non-empty reason")
		}
	})

	t.Run("404 (manifest never uploaded) falls back to full run", func(t *testing.T) {
		provider := newMockProvider()
		snap, reason := fetchServerOwnedBase(context.Background(), provider, "snap-missing", myIdentity)
		if snap != nil {
			t.Fatalf("expected nil on download failure, got %+v", snap)
		}
		if reason == "" {
			t.Error("expected a non-empty reason")
		}
	})
}
```

- [ ] Step 2: Run it, expect FAIL with `undefined: fetchServerOwnedBase`:
```
cd agent && go test ./internal/backup/ -run TestFetchServerOwnedBase
```

- [ ] Step 3: Implement.

Add to `agent/internal/backup/incremental.go` imports:
```go
import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)
```

Append the new function:
```go
// fetchServerOwnedBase downloads and validates the manifest for
// baseSnapshotID as this run's incremental-dedupe base, per the D18
// server-owned-base protocol (§3.1). Unlike previousManifest (legacy
// bucket-listing mode), the server has already chosen the base id — this
// function only fetches and validates it belongs to this device/
// destination/run-kind (the same D6 identity guard as previousManifest); it
// never lists the bucket. Returns (nil, reason) on ANY failure — empty id,
// download error, decode error, or identity mismatch — collapsing to a full
// run, exactly like previousManifest's fail-open contract. reason is always
// non-empty in that case so callers can log it directly.
func fetchServerOwnedBase(ctx context.Context, provider providers.BackupProvider, baseSnapshotID, identity string) (*Snapshot, string) {
	if ctx == nil {
		ctx = context.Background()
	}
	if baseSnapshotID == "" {
		return nil, "server selected no base for this run (full run)"
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Sprintf("context already done: %v", err)
	}
	if identity == "" {
		return nil, "this run has no known backup identity, cannot safely validate the server-selected base"
	}

	manifestKey := path.Join(snapshotRootDir, baseSnapshotID, snapshotManifestKey)
	tempFile, err := os.CreateTemp("", "base-manifest-*.json")
	if err != nil {
		return nil, fmt.Sprintf("failed to create temp file for base manifest: %v", err)
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer os.Remove(tempPath)

	if err := provider.Download(manifestKey, tempPath); err != nil {
		return nil, fmt.Sprintf("failed to download server-selected base manifest %s: %v", manifestKey, err)
	}
	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, fmt.Sprintf("failed to read downloaded base manifest: %v", err)
	}
	var candidate Snapshot
	if err := json.Unmarshal(data, &candidate); err != nil {
		return nil, fmt.Sprintf("failed to decode base manifest %s: %v", manifestKey, err)
	}
	if candidate.BackupIdentity != identity {
		return nil, fmt.Sprintf(
			"server-selected base %s has BackupIdentity %q, this run's identity is %q — refusing to use a foreign snapshot as a dedupe base (D6)",
			baseSnapshotID, candidate.BackupIdentity, identity)
	}
	return &candidate, ""
}
```

In `agent/internal/backup/backup.go`, replace the block at `:682-691`:
```go
	var prevSnapshot *Snapshot
	incrementalDedupeActive := !m.config.SystemStateEnabled || len(m.config.Paths) > 0
	if incrementalDedupeActive {
		if m.config.BaseSnapshotID != nil {
			// Server-owned mode (D18 §3.1): the protocol switch is presence
			// of baseSnapshotId in the backup_run payload (see
			// exec_backup.go). The agent never lists the bucket to choose a
			// base in this mode.
			prev, reason := fetchServerOwnedBase(runCtx, m.config.Provider, *m.config.BaseSnapshotID, runIdentity)
			if prev == nil {
				log.Info("running full backup, no reference dedupe",
					"mode", "server-owned",
					"baseSnapshotId", *m.config.BaseSnapshotID,
					"reason", reason,
				)
			} else {
				prevSnapshot = prev
				log.Info("using server-selected base for incremental reference dedupe",
					"mode", "server-owned",
					"baseSnapshotId", prev.ID,
				)
			}
		} else {
			// Legacy mode: server predates the field, fall back to the
			// original bucket-listing lookup.
			prev, reason := previousManifest(runCtx, m.config.Provider, runIdentity)
			if prev == nil {
				log.Info("running full backup, no reference dedupe", "mode", "legacy", "reason", reason)
			} else {
				prevSnapshot = prev
			}
		}
	}
```

- [ ] Step 4: Run, expect PASS:
```
cd agent && go test ./internal/backup/ -run TestFetchServerOwnedBase -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/incremental.go agent/internal/backup/backup.go agent/internal/backup/incremental_test.go
git commit -m "feat(agent/backup): fetch server-selected dedupe base, fall back to legacy listing"
```

### Task 3: Checkpoint-journal age tracking

**Files:**
- Modify `agent/internal/backup/journal.go` (struct field + method + both construction sites)
- Test: `agent/internal/backup/journal_test.go` (new test)

**Interfaces:**
- Produces: `(*snapshotJournal) Age() time.Duration`

- [ ] Step 1: Write the failing test in `journal_test.go`:
```go
func TestSnapshotJournal_Age(t *testing.T) {
	dir := t.TempDir()
	j, _, err := openSnapshotJournal(dir, "age-test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	defer j.Abandon()

	if age := j.Age(); age < 0 || age > time.Second {
		t.Fatalf("fresh journal Age() = %v, want ~0", age)
	}

	// A nil journal must not panic and reports zero age.
	var nilJournal *snapshotJournal
	if age := nilJournal.Age(); age != 0 {
		t.Fatalf("nil journal Age() = %v, want 0", age)
	}
}

func TestSnapshotJournal_Age_SurvivesResume(t *testing.T) {
	dir := t.TempDir()
	restore := setJournalMaxAgeForTest(24 * time.Hour)
	defer restore()

	j1, _, err := openSnapshotJournal(dir, "resume-age-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal (1st) failed: %v", err)
	}
	if err := j1.Record(SnapshotFile{SourcePath: "/a.txt", Size: 1}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	j1.Abandon()

	// A real gap between creation and resume (P3 fix): back-to-back opens
	// with no sleep can't distinguish "createdAt correctly preserved from
	// the original header" from "createdAt buggily reset to time.Now() on
	// resume" — both would read back as ~0 either way. The sleep makes the
	// two hypotheses diverge: preserved reads back ~50ms, reset reads ~0.
	time.Sleep(50 * time.Millisecond)

	j2, resumed, err := openSnapshotJournal(dir, "resume-age-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal (2nd) failed: %v", err)
	}
	defer j2.Abandon()
	if !resumed {
		t.Fatal("expected the second open to resume the first journal")
	}
	if age := j2.Age(); age < 40*time.Millisecond || age > 2*time.Second {
		t.Fatalf("resumed journal Age() = %v, want ~50ms (original createdAt preserved across resume, not reset to time.Now())", age)
	}
}
```

- [ ] Step 2: Run it, expect FAIL with `j.Age undefined (type *snapshotJournal has no field or method Age)`:
```
cd agent && go test ./internal/backup/ -run TestSnapshotJournal_Age
```

- [ ] Step 3: Implement.

Add a field to the `snapshotJournal` struct (`journal.go`, after `identity string`):
```go
	// createdAt is the journal's original creation time (from its header,
	// preserved verbatim across a resume — NOT reset on resume). Age()
	// reports time.Since(createdAt), used at publish time to fence a
	// resumed run against journalMaxAge (see leaseGate in snapshot.go).
	createdAt time.Time
```

Set it in the resumed-open branch (`openSnapshotJournal`, inside the `identityMatches && time.Since(header.CreatedAt) <= maxAge` success path, where the `&snapshotJournal{...}` literal is built):
```go
				return &snapshotJournal{
					file:              f,
					writer:            bufio.NewWriter(f),
					path:              path,
					snapshotID:        header.SnapshotID,
					identity:          identity,
					entries:           entries,
					resumedBytesTotal: resumedBytes,
					resumed:           true,
					createdAt:         header.CreatedAt,
				}, true, nil
```

Set it in `createFreshJournal`'s return literal:
```go
	return &snapshotJournal{
		file:       f,
		writer:     bufio.NewWriter(f),
		path:       path,
		snapshotID: header.SnapshotID,
		identity:   identity,
		createdAt:  header.CreatedAt,
	}, false, nil
```

Add the method after `ResumedBytes`:
```go
// Age reports how long ago this journal was originally created (the
// header's CreatedAt, unaffected by resume — see the createdAt field doc).
// A nil journal reports zero age.
func (j *snapshotJournal) Age() time.Duration {
	if j == nil || j.createdAt.IsZero() {
		return 0
	}
	return time.Since(j.createdAt)
}
```

- [ ] Step 4: Run, expect PASS:
```
cd agent && go test ./internal/backup/ -run TestSnapshotJournal_Age -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/journal.go agent/internal/backup/journal_test.go
git commit -m "feat(agent/backup): track checkpoint journal creation age"
```

### Task 4: `leaseGate` — refuse to publish past the lease margin or journal age

**Files:**
- Modify `agent/internal/backup/backup.go` (sentinel errors, call-site substitution at `:758`)
- Modify `agent/internal/backup/snapshot.go` (new `leaseGate` type + constants)
- Test: `agent/internal/backup/snapshot_test.go` (new tests), `agent/internal/backup/backup_test.go` (new `RunBackupContext` case)

**Interfaces:**
- Produces: `ErrPublishLeaseExpired`, `ErrJournalExpiredAtPublish` (both `error`, `backup.go`); `leaseGate` (unexported, `snapshot.go`); `publishMargin`, `uploadLeaseInterval` constants (`snapshot.go`).
- Design note: `createSnapshotWithProgress`'s signature (`snapshot.go:343`) is deliberately left unchanged — it has ~30 call sites across 5 test files. The lease/journal-age check is enforced by wrapping the `providers.BackupProvider` passed in, at the ONE real call site (`backup.go:758`), so existing tests need no changes for this task.
- **Gate-installation rule (P1 fix, see Global Constraints):** the gate installs whenever `m.config.BaseSnapshotID != nil` (server-owned mode ON), NOT whenever the lease happens to be non-zero. Inside `checkPublish`, a zero `publishLeaseExpiresAt` is a FAIL-CLOSED condition (`ErrPublishLeaseExpired`), never treated as "no lease, allow" — Task 1's payload validation is what's supposed to prevent this combination from ever occurring, so this is defense in depth, not the primary enforcement point.

- [ ] Step 1: Write the failing test in `snapshot_test.go`:
```go
func TestLeaseGate_RefusesManifestPastLeaseMargin(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content")
	provider := newMockProvider()
	gated := &leaseGate{
		BackupProvider:        provider,
		publishLeaseExpiresAt: time.Now().Add(30 * time.Minute), // inside the 1h margin
	}

	files := []backupFile{{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 7, modTime: time.Now()}}
	_, err := createSnapshotWithProgress(context.Background(), gated, files, nil, nil, nil, nil)
	if !errors.Is(err, ErrPublishLeaseExpired) {
		t.Fatalf("err = %v, want ErrPublishLeaseExpired", err)
	}
	// provider.uploads is map[remotePath]localPath — range over the KEYS
	// (remote paths), never the values (which are local temp filenames and
	// would make isManifestPath check the wrong string entirely).
	for key := range provider.uploads {
		if isManifestPath(key) {
			t.Fatalf("manifest was uploaded despite an expired lease: %s", key)
		}
	}
}

func TestLeaseGate_ZeroLeaseFailsClosed(t *testing.T) {
	// Defense in depth for the P1 fix: Task 1's payload validation is
	// SUPPOSED to make a zero lease alongside server-owned mode
	// unreachable, but the gate itself must never fail open if that
	// invariant is ever violated upstream — a missing lease must refuse to
	// publish, not silently behave as "no lease configured".
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content")
	provider := newMockProvider()
	gated := &leaseGate{BackupProvider: provider} // publishLeaseExpiresAt left zero

	files := []backupFile{{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 7, modTime: time.Now()}}
	_, err := createSnapshotWithProgress(context.Background(), gated, files, nil, nil, nil, nil)
	if !errors.Is(err, ErrPublishLeaseExpired) {
		t.Fatalf("err = %v, want ErrPublishLeaseExpired (zero lease must fail closed)", err)
	}
}

func TestLeaseGate_AllowsManifestWellInsideLease(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content")
	provider := newMockProvider()
	gated := &leaseGate{
		BackupProvider:        provider,
		publishLeaseExpiresAt: time.Now().Add(24 * time.Hour),
	}

	files := []backupFile{{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 7, modTime: time.Now()}}
	snap, err := createSnapshotWithProgress(context.Background(), gated, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap == nil {
		t.Fatal("expected a snapshot")
	}
}

func TestLeaseGate_RefusesManifestWhenResumedJournalTooOld(t *testing.T) {
	restore := setJournalMaxAgeForTest(1 * time.Millisecond)
	defer restore()

	dir := t.TempDir()
	j1, _, err := openSnapshotJournal(dir, "lease-journal-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal (1st) failed: %v", err)
	}
	j1.Abandon()
	time.Sleep(5 * time.Millisecond)

	j2, resumed, err := openSnapshotJournal(dir, "lease-journal-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal (2nd) failed: %v", err)
	}
	if resumed {
		t.Fatal("journal should be treated as stale (too old), not resumed")
	}
	// Force resumed+old state directly to exercise the gate deterministically
	// (openSnapshotJournal already discarded the stale one above, matching
	// production behavior — this constructs the boundary case directly).
	j2.resumed = true
	j2.createdAt = time.Now().Add(-2 * journalMaxAge)

	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content")
	provider := newMockProvider()
	gated := &leaseGate{BackupProvider: provider, journal: j2}

	files := []backupFile{{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 7, modTime: time.Now()}}
	_, err = createSnapshotWithProgress(context.Background(), gated, files, nil, j2, nil, nil)
	if !errors.Is(err, ErrJournalExpiredAtPublish) {
		t.Fatalf("err = %v, want ErrJournalExpiredAtPublish", err)
	}
}
```

- [ ] Step 2: Run it, expect FAIL with `undefined: leaseGate`:
```
cd agent && go test ./internal/backup/ -run TestLeaseGate
```

- [ ] Step 3: Implement.

Add to `agent/internal/backup/backup.go` (near `errBackupStopped`, package-level `var` block):
```go
// ErrPublishLeaseExpired is returned when a server-dispatched run (D18
// §3.1) cannot publish its manifest because the server's publish lease
// (BackupConfig.PublishLeaseExpiresAt, minus the 1h publishMargin) expired
// before upload finished. The server treats a late result past lease
// expiry as failed — returning this distinct, unwrapped-comparable error
// lets logs and tests tell it apart from an ordinary publish failure. No
// manifest is uploaded and nothing is deleted: the partial, manifest-less
// prefix is reclaimed by GC's existing manifest-less-prefix rule.
var ErrPublishLeaseExpired = errors.New("backup publish lease expired before manifest could be published")

// ErrJournalExpiredAtPublish is the same fail-closed rule as
// ErrPublishLeaseExpired but keyed on the checkpoint journal's age for a
// RESUMED run: if journalMaxAge has elapsed by the time upload finishes,
// the server can no longer distinguish this manifest from an abandoned
// resume attempt, so publishing is refused.
var ErrJournalExpiredAtPublish = errors.New("checkpoint journal expired before manifest could be published")
```

Add to `agent/internal/backup/snapshot.go` (near the other package-level consts, e.g. next to `snapshotRootDir`):
```go
const (
	// publishMargin is subtracted from the lease deadline at publish time
	// (D18 §3.1): the server keeps a job's base pinned for
	// lease+publishMargin precisely so a manifest PUT that STARTS inside
	// the margin has room to finish before the server's pin lapses. Must
	// match the API's BACKUP_PUBLISH_MARGIN_MS default —
	// backupAgentContract.test.ts asserts the two stay equal.
	publishMargin = 1 * time.Hour

	// uploadLeaseInterval is how often createSnapshotWithProgress refreshes
	// snapshots/<id>/upload.lease while uploading (D18 §3.4), so a
	// long-running single-object upload keeps the prefix's newest object
	// fresh. MUST stay well under the API's manifest-less-prefix GC window
	// (journalMaxAge + 48h grace = 9 days) — backupAgentContract.test.ts
	// asserts this.
	uploadLeaseInterval = 15 * time.Minute
)

// leaseGate wraps a BackupProvider so publishing a snapshot manifest past
// its server-granted publish lease (or, for a resumed run, past the
// checkpoint journal's max age) fails closed instead of publishing a
// manifest the server can no longer trust (D18 §3.1/§3.4). Only
// isManifestPath uploads are gated — ordinary file uploads and the
// upload.lease heartbeat object pass straight through to the wrapped
// provider.
type leaseGate struct {
	providers.BackupProvider
	// publishLeaseExpiresAt is BackupConfig.PublishLeaseExpiresAt verbatim.
	// Zero value disables the lease check (legacy server, no field sent).
	publishLeaseExpiresAt time.Time
	// journal is this run's checkpoint journal, or nil. Only a RESUMED
	// journal (journal.resumed) is checked against journalMaxAge — a fresh
	// journal's age is irrelevant here.
	journal *snapshotJournal
}

func (g *leaseGate) checkPublish(remotePath string) error {
	if !isManifestPath(remotePath) {
		return nil
	}
	if g.publishLeaseExpiresAt.IsZero() {
		// P1 fix: a zero lease reaching here means the "server-owned mode
		// implies a non-zero lease" invariant (enforced at payload
		// validation, exec_backup.go) was violated somewhere upstream.
		// Fail CLOSED — refusing to publish is always safe; treating an
		// absent lease as "no lease configured, proceed" is exactly the
		// fail-open bug this gate exists to prevent, and this gate is only
		// ever installed when server-owned mode is on (see backup.go's
		// call site), so there is no legitimate zero-lease case here.
		return ErrPublishLeaseExpired
	}
	if time.Now().Add(publishMargin).After(g.publishLeaseExpiresAt) {
		return ErrPublishLeaseExpired
	}
	if g.journal != nil && g.journal.resumed && g.journal.Age() >= journalMaxAge {
		return ErrJournalExpiredAtPublish
	}
	return nil
}

// Upload implements providers.BackupProvider.
func (g *leaseGate) Upload(localPath, remotePath string) error {
	if err := g.checkPublish(remotePath); err != nil {
		return err
	}
	return g.BackupProvider.Upload(localPath, remotePath)
}

// UploadContext implements contextUploader. Declared unconditionally (even
// when the wrapped provider doesn't support it) so uploadSnapshotFile's
// type assertion on the WRAPPER always succeeds and the lease check always
// runs; it falls back to a plain Upload when the wrapped provider lacks
// context support, exactly like uploadSnapshotFile itself does.
func (g *leaseGate) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if err := g.checkPublish(remotePath); err != nil {
		return err
	}
	if u, ok := g.BackupProvider.(contextUploader); ok {
		return u.UploadContext(ctx, localPath, remotePath)
	}
	return g.BackupProvider.Upload(localPath, remotePath)
}
```

In `agent/internal/backup/backup.go`, change the call site at `:758` (immediately before it, after the journal block ends at `:756`):
```go
	// Gate manifest publication whenever server-owned mode is on (D18
	// §3.1) — keyed on BaseSnapshotID being present, NOT on the lease
	// being non-zero (P1 fix): Task 1's payload validation guarantees a
	// non-zero lease whenever BaseSnapshotID is set, but the gate's
	// INSTALLATION must not itself depend on that value, or a payload that
	// somehow slipped validation with a zero lease would run completely
	// ungated instead of hitting checkPublish's fail-closed zero-lease
	// branch. Legacy servers (nil BaseSnapshotID) get the unwrapped
	// provider and fully unchanged behavior. Applies to full runs too, not
	// just incremental ones — the server fences every dispatched run's
	// late-result window this way.
	uploadProvider := m.config.Provider
	if m.config.BaseSnapshotID != nil {
		uploadProvider = &leaseGate{
			BackupProvider:        m.config.Provider,
			publishLeaseExpiresAt: m.config.PublishLeaseExpiresAt,
			journal:               journal,
		}
	}
	snapshot, snapErr := createSnapshotWithProgress(runCtx, uploadProvider, files, progressFn, journal, prevSnapshot, sourceLiveness, runIdentity)
```

- [ ] Step 4: Run, expect PASS:
```
cd agent && go test ./internal/backup/ -run TestLeaseGate -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/backup.go agent/internal/backup/snapshot.go agent/internal/backup/snapshot_test.go
git commit -m "feat(agent/backup): refuse to publish a manifest past its lease or journal age"
```

### Task 4b: Manager-level proof — server-owned mode never lists, expired lease blocks publish end-to-end

Task 4's tests exercise `leaseGate`/`createSnapshotWithProgress` directly; this task proves the SAME properties hold through the full `RunBackupContext` wiring (goal 4's "never lists the bucket" and the gate's actual installation), which nothing else in this plan otherwise checks end-to-end.

**Files:**
- Test: `agent/internal/backup/backup_test.go` (new tests)

**Interfaces:** none new — exercises `BackupManager.RunBackupContext` only.

- [ ] Step 1: Write the failing tests:
```go
// listRecordingProvider wraps mockProvider and counts List calls, proving
// goal 4 ("the agent never lists the bucket to choose a base") at the
// RunBackupContext level — fetchServerOwnedBase's own unit tests (Task 2)
// only prove it in isolation.
type listRecordingProvider struct {
	*mockProvider
	listCalls int
}

func (p *listRecordingProvider) List(prefix string) ([]string, error) {
	p.listCalls++
	return p.mockProvider.List(prefix)
}

func TestRunBackupContext_ServerOwnedMode_NeverListsTheBucket(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content")
	backing := newMockProvider()
	provider := &listRecordingProvider{mockProvider: backing}

	baseID := "snap-base"
	mgr := NewBackupManager(BackupConfig{
		Provider:              provider,
		Paths:                 []string{tmpDir},
		StagingDir:            t.TempDir(),
		AgentID:               "test-device",
		BaseSnapshotID:        &baseID,
		PublishLeaseExpiresAt: time.Now().Add(1 * time.Hour),
	})

	// Seed the server-selected base AFTER constructing mgr, using its own
	// runBackupIdentity() so the identity guard (D6) matches exactly what
	// this run will compute — see incremental.go's fetchServerOwnedBase.
	base := &Snapshot{
		ID:             baseID,
		BackupIdentity: mgr.runBackupIdentity(),
		Files:          []SnapshotFile{{SourcePath: "/prior.txt", BackupPath: "snapshots/snap-base/files/prior.txt.gz", Size: 3}},
	}
	storeManifest(t, backing, base)

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext failed: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("job.Status = %q, want %q", job.Status, jobStatusCompleted)
	}
	if provider.listCalls != 0 {
		t.Fatalf("expected zero List calls in server-owned mode, got %d", provider.listCalls)
	}
}

func TestRunBackupContext_ExpiredLease_RefusesToPublishManifest(t *testing.T) {
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "file1.txt", "content")
	provider := newMockProvider()

	baseID := "" // full run — the lease is enforced for full runs too, not just incremental ones
	mgr := NewBackupManager(BackupConfig{
		Provider:              provider,
		Paths:                 []string{tmpDir},
		StagingDir:            t.TempDir(),
		AgentID:               "test-device",
		BaseSnapshotID:        &baseID,
		PublishLeaseExpiresAt: time.Now().Add(-1 * time.Hour), // already expired
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if !errors.Is(err, ErrPublishLeaseExpired) {
		t.Fatalf("err = %v, want ErrPublishLeaseExpired", err)
	}
	if job.Status != jobStatusFailed {
		t.Fatalf("job.Status = %q, want %q", job.Status, jobStatusFailed)
	}
	for key := range provider.files {
		if isManifestPath(key) {
			t.Fatalf("manifest was published despite an expired lease: %s", key)
		}
	}
}
```

- [ ] Step 2: Run it, expect FAIL (both: `TestRunBackupContext_ServerOwnedMode_NeverListsTheBucket` fails to compile / behaves like legacy mode since Tasks 1/2/4's production code doesn't exist on its own branch point yet if run standalone; run AFTER Tasks 1, 2, and 4 land, at which point this is a regression-proof addition — if implementing strictly in order, this task's tests should already be GREEN, so treat any failure here as a signal that Tasks 1/2/4 have a wiring gap, not as this task's own red-first step):
```
cd agent && go test ./internal/backup/ -run 'TestRunBackupContext_ServerOwnedMode_NeverListsTheBucket|TestRunBackupContext_ExpiredLease_RefusesToPublishManifest' -v
```

- [ ] Step 3: No new production code — this task is verification-only, confirming Tasks 1/2/4's wiring holds end-to-end.

- [ ] Step 4: Run, expect PASS:
```
cd agent && go test ./internal/backup/ -run 'TestRunBackupContext_ServerOwnedMode_NeverListsTheBucket|TestRunBackupContext_ExpiredLease_RefusesToPublishManifest' -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/backup_test.go
git commit -m "test(agent/backup): prove server-owned mode never lists the bucket and an expired lease blocks publish end-to-end"
```

### Task 5: Remove agent-side retention pruning and stale-journal cleanup; keep the own-run-prefix abort cleanups

Spec §3.5 (re-read after coordinator review) states the deletion removal has two **explicit
exceptions**, not zero: the helper may still delete objects under **its own current run's
prefix, before that run's manifest is published** (the journal-less abort paths at
`snapshot.go:499` and `:544`) and its own `upload.lease` after publication (Task 7). Both
exceptions are safe because neither prefix can ever be referenced by another manifest — nothing
else knows the id exists until a manifest publishes it. What actually gets removed in this task
is narrower than originally planned: the retention-prune branch, the stale-journal remote
cleanup, and `DeleteSnapshot`/`DeleteSnapshotContext` (which pruned OTHER, already-published
snapshots' entire prefixes — the actually dangerous case). `cleanupSnapshotPrefix` and
`listSnapshotPrefixItems` are KEPT, since the two retained call sites still need them.

**Files:**
- Modify `agent/internal/backup/backup.go` (retention branch `:780-806`, stale-journal cleanup call `:748`)
- Modify `agent/internal/backup/snapshot.go` (remove only `DeleteSnapshot`/`DeleteSnapshotContext`; `abortStopped` `:496-500` and `abortSourceGone`'s zero-files branch `:541-546` are UNCHANGED — their `cleanupSnapshotPrefix` calls stay)
- Modify `agent/internal/backup/snapshot_lifecycle_test.go` (remove ONLY the six `DeleteSnapshot`/`DeleteSnapshotContext` tests; also drop the now-unused `"fmt"` and `"strings"` imports — see P2 compile-facts note below)
- Modify `agent/internal/backup/snapshot_test.go` (`TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix` is removed since it targets the removed `DeleteSnapshot`; add the own-prefix-vs-foreign-prefix scoping test)
- Modify `agent/internal/backup/backup_test.go` (add the retention regression test HERE, not in `snapshot_lifecycle_test.go` — see below; also rewrite `TestRunBackupContext_StaleJournalCleansUpRemotePrefixAndRunsFresh` at `:245-300` to assert NO deletion)

**Interfaces:**
- Removes: `DeleteSnapshot`, `DeleteSnapshotContext` only (confirmed zero external callers in Ground Truth §0; `backup.go:799` was `DeleteSnapshotContext`'s only caller).
- Keeps unchanged: `cleanupSnapshotPrefix`, `listSnapshotPrefixItems` (still called from `snapshot.go:499`/`:544`).
- Produces (test-only): `TestBackupNeverDeletesRemoteObjects_RetentionConfigured` (moved to `backup_test.go`), `TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAForeignPublishedPrefix` (`snapshot_test.go`), a rewritten `TestRunBackupContext_StaleJournalCleansUpRemotePrefixAndRunsFresh` (`backup_test.go`).
- **Ordering guarantee this task relies on**: Task 6 (revised after review) installs the resume-with-already-published-manifest shortcut in TWO places: primarily in `RunBackupContext` (`backup.go`), hoisted to run before VSS/scan/`createSnapshotWithProgress` are ever reached at all; and defensively inside `createSnapshotWithProgress` itself, immediately after `prefix := path.Join(...)`, before the upload loop — and therefore before either `abortStopped` or `abortSourceGone` can be reached — whenever `journal != nil && journal.resumed` and that journal's manifest is CONFIRMED already published. Either way, a journal-resumed run whose manifest is already published never reaches a `cleanupSnapshotPrefix` call: it returns via one of the two early paths first. This is a structural property of the control flow both checks establish; Task 6's own `TestCreateSnapshot_ResumeWithAlreadyPublishedManifest_SkipsUploadAndDelete` test already asserts zero deletes for this exact scenario, so this task does not duplicate it.

- [ ] Step 1: Write the failing tests.

Remove `TestDeleteSnapshot_NothingToDelete`, `_ZeroRetention`, `_NegativeRetention`, `_PrunesOldSnapshots`, `_RetentionExceedsCount`, `_DeleteError` from `snapshot_lifecycle_test.go` (`:108-208`) — they exercise a function that no longer exists. **P2 compile-facts fix**: after removing them, `"fmt"` and `"strings"` become unused imports in this file (both are used ONLY inside these six tests — verified by reading the whole file; `errors` and `path` remain used by `TestListSnapshots_ListError`/`TestListSnapshots_CorruptManifest` and stay). Remove `"fmt"` and `"strings"` from this file's import block entirely; do not add a replacement test to this file (the replacement test below goes in `backup_test.go` instead, which already imports everything it needs).

**P2 fix — exercise the REAL retention-prune branch, not a vacuous config.** `incrementalDedupeActive := !m.config.SystemStateEnabled || len(m.config.Paths) > 0` (`backup.go:683`) is `true` for ANY file-mode config with `Paths` set, regardless of Retention — so a `Paths`-configured test can never reach the retention-prune branch (`backup.go:798`) even on UNFIXED code, making it pass vacuously both before and after this task's fix. The branch is reachable only for a system-state-ONLY run (`SystemStateEnabled: true`, `Paths` empty). Also, after Task 7 lands, EVERY successful run legitimately writes-then-deletes its own `upload.lease` — so asserting `len(deleteCalls) == 0` outright would break for an unrelated, correct reason. Add to `backup_test.go` (which already imports `systemstate` for `stubCollectSystemState`, defined at `:479-484`):
```go
// D18 §3.5: agent-side retention pruning is removed entirely. A
// system-state-only run is the ONLY config shape that reaches the (now
// removed) retention-prune branch pre-fix — incrementalDedupeActive is
// false exactly when SystemStateEnabled && len(Paths)==0 (backup.go:683) —
// so this is the config that actually exercises the danger, unlike a
// Paths-configured run which never reaches that branch either way.
func TestBackupNeverDeletesRemoteObjects_RetentionConfigured(t *testing.T) {
	systemStateDir := t.TempDir()
	if err := os.WriteFile(pathpkg.Join(systemStateDir, "services.txt"), []byte("svc"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test"}, systemStateDir, nil
	})

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:           provider,
		SystemStateEnabled: true,
		Retention:          1, // ignored — see GetRetention's doc comment
		StagingDir:         t.TempDir(),
		AgentID:            "test-device",
	})

	for i := 0; i < 3; i++ {
		if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
			t.Fatalf("RunBackupContext #%d failed: %v", i+1, err)
		}
	}
	// After Task 7, each run's own upload.lease is written then deleted —
	// the ONLY delete this test may legitimately see. Any delete for a
	// DIFFERENT run's snapshot id (i.e. anything but that run's own
	// upload.lease) is the retention-prune bug this test guards against.
	for _, key := range provider.deleteCalls {
		if !strings.HasSuffix(key, "/upload.lease") {
			t.Fatalf("expected deletes to be limited to each run's own upload.lease, got: %s (all: %v)", key, provider.deleteCalls)
		}
	}
}
```

Remove `TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix` in `snapshot_test.go` (`:198-230`) and add:
```go
// cancelAfterFirstUploadProvider wraps mockProvider and cancels the given
// CancelFunc right after the FIRST real Upload lands, so an aborted run has
// something concrete under ITS OWN prefix for the abort cleanup to act on
// (P3 fix — the previous version of this test never uploaded anything
// before cancelling, so it could only prove absence-of-harm on an empty
// prefix, not that own-prefix cleanup actually deletes what it should).
type cancelAfterFirstUploadProvider struct {
	*mockProvider
	cancel   context.CancelFunc
	uploaded int
	mu       sync.Mutex
}

func (p *cancelAfterFirstUploadProvider) Upload(localPath, remotePath string) error {
	err := p.mockProvider.Upload(localPath, remotePath)
	p.mu.Lock()
	p.uploaded++
	first := p.uploaded == 1
	p.mu.Unlock()
	if first && p.cancel != nil {
		p.cancel()
	}
	return err
}

// TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAForeignPublishedPrefix
// pins the §3.5 exception's boundary from both directions (P3 fix): objects
// are seeded under BOTH the aborted run's own (to-be-cleaned) prefix and a
// foreign, already-published sibling prefix, and only the former may be
// deleted. The resume-skips-cleanup property is deliberately NOT duplicated
// here — Task 6's TestCreateSnapshot_ResumeWithAlreadyPublishedManifest_
// SkipsUploadAndDelete already asserts zero deletes for that exact scenario
// with a valid (non-cancelled) context; an earlier draft of this test tried
// to force that scenario via an already-cancelled context, which cannot
// pass against this plan's fetchPublishedManifest (it checks ctx.Err()
// first and fails closed) and was dropped as a P2 fix.
func TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAForeignPublishedPrefix(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content-one")
	file2 := createTempFile(t, tmpDir, "file2.txt", "content-two")
	backing := newMockProvider()

	// Seed a sibling, already-published snapshot that must never be
	// touched by the aborted run's cleanup.
	sibling := &Snapshot{
		ID:    "snapshot-sibling-published",
		Files: []SnapshotFile{{SourcePath: "/data/other.txt", BackupPath: "snapshots/snapshot-sibling-published/files/other.txt.gz", Size: 1}},
	}
	storeManifest(t, backing, sibling)

	ctx, cancel := context.WithCancel(context.Background())
	provider := &cancelAfterFirstUploadProvider{mockProvider: backing, cancel: cancel}

	files := []backupFile{
		{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 11, modTime: time.Now()},
		{sourcePath: file2, snapshotPath: "path_0/file2.txt", size: 11, modTime: time.Now()},
	}
	_, err := createSnapshotWithProgress(ctx, provider, files, nil, nil, nil, nil)
	if !errors.Is(err, errBackupStopped) {
		t.Fatalf("err = %v, want errBackupStopped", err)
	}

	sawOwnPrefixDelete := false
	for _, key := range backing.deleteCalls {
		if strings.HasPrefix(key, "snapshots/snapshot-sibling-published/") {
			t.Fatalf("abort cleanup deleted a key under a PUBLISHED sibling prefix: %s", key)
		}
		sawOwnPrefixDelete = true
	}
	if !sawOwnPrefixDelete {
		t.Fatal("expected the aborted run's own uploaded file to be cleaned up under its own prefix")
	}
	if _, stillThere := backing.files["snapshots/snapshot-sibling-published/manifest.json"]; !stillThere {
		t.Fatal("sibling published manifest must survive the aborted run's cleanup")
	}
}
```

- [ ] Step 2: Run it, expect FAIL — `TestBackupNeverDeletesRemoteObjects_RetentionConfigured` (in `backup_test.go`) fails with a non-`/upload.lease` delete call, since the system-state-only config now correctly reaches the retention-prune branch pre-fix (`backup.go:798`, `!incrementalDedupeActive` is true for this config shape). `TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAForeignPublishedPrefix` should already PASS against current (pre-Task-5) code — it exercises `abortStopped`'s existing, UNCHANGED own-prefix cleanup, which this task does not remove; treat any failure here as a signal the test itself has a bug, not as this task's red-first step:
```
cd agent && go test ./internal/backup/ -run 'TestBackupNeverDeletesRemoteObjects_RetentionConfigured|TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix' -v
```

- [ ] Step 3: Implement.

In `agent/internal/backup/backup.go`, delete the entire retention-prune block (`:780-806`, from `retentionErr := error(nil)` through its closing `}`) and the `retentionErr` variable's later use — grep `retentionErr` first to confirm every reference is inside this block before deleting (it is: the variable is declared, assigned, and read only within `:780-806` in this file). Replace the block with nothing (the `if err := runCtx.Err(); err != nil { return stopBackupRun() }` guard immediately before it stays, since a stop-check is still correct there).

Change the stale-journal branch (`:738-749`) — remove ONLY the `cleanupSnapshotPrefix` call, keep the rest:
```go
	if journal != nil {
		if staleID, ok := journal.StaleSnapshotID(); ok {
			// StaleSnapshotID covers both an actually-stale (>journalMaxAge)
			// journal and the (near-impossible) identity-mismatch case — see
			// openSnapshotJournal — so the message below is deliberately
			// generic rather than claiming a specific cause. The agent no
			// longer cleans up the STALE JOURNAL'S remote prefix itself
			// (D18 §3.5): that prefix belongs to a PRIOR, different run
			// (not this run's own in-progress prefix, which is the only
			// exception §3.5 keeps — see abortStopped/abortSourceGone in
			// snapshot.go), so it is simply dropped and GC's existing
			// manifest-less-prefix rule reclaims it.
			log.Warn("discarding unusable checkpoint journal",
				"snapshotId", staleID,
				"maxAge", journalMaxAge.String(),
			)
		}
```
(Remove only the `cleanupSnapshotPrefix(m.config.Provider, staleID)` call. Do NOT touch `abortStopped`/`abortSourceGone` in `snapshot.go` — both keep their existing `cleanupSnapshotPrefix` calls unchanged, per the spec exception.)

Remove `DeleteSnapshot` (`:972-974`) and `DeleteSnapshotContext` (`:977-1023`) from `snapshot.go` entirely. Leave `cleanupSnapshotPrefix` (`:884-892`) and `listSnapshotPrefixItems` (`:1025-1032`) exactly as they are.

**P2 fix — rewrite the stale-journal test to assert NO deletion.** `TestRunBackupContext_StaleJournalCleansUpRemotePrefixAndRunsFresh` (`backup_test.go:245-300`) currently seeds an orphan object under the stale snapshot's prefix and asserts it GETS deleted (`found` must be `true` at `:295-299`) — that assertion describes the exact behavior this task removes. Rename and rewrite it:
```go
// TestRunBackupContext_StaleJournalDiscardedWithoutRemoteCleanup proves the
// D18 §3.5 fix directly: a journal older than journalMaxAge is discarded
// and the run proceeds fresh with a brand new snapshot ID, but the STALE
// journal's remote prefix is left untouched — no agent-side delete, ever,
// for another run's (even an abandoned one's) prefix. GC's existing
// manifest-less-prefix rule is the only thing that may eventually reclaim
// it.
func TestRunBackupContext_StaleJournalDiscardedWithoutRemoteCleanup(t *testing.T) {
	restoreMaxAge := setJournalMaxAgeForTest(time.Millisecond)
	defer restoreMaxAge()

	provider := newMockProvider()
	stagingDir := t.TempDir()
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "data.txt", "hello")

	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{tmpDir},
		StagingDir: stagingDir,
	})

	identity := backupIdentity(provider, []string{tmpDir})
	staleJournal, _, err := openSnapshotJournal(stagingDir, identity, time.Hour)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if err := staleJournal.Record(SnapshotFile{SourcePath: "/gone.txt", Size: 1, ModTime: time.Now()}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	staleSnapshotID := staleJournal.snapshotID
	staleJournal.Abandon()

	orphanKey := path.Join(snapshotRootDir, staleSnapshotID, snapshotFilesDir, "orphan.gz")
	provider.files[orphanKey] = []byte("orphan")

	time.Sleep(2 * time.Millisecond) // the journal is now older than the shrunk maxAge

	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("job.Status = %q, want %q", job.Status, jobStatusCompleted)
	}
	if job.Snapshot == nil {
		t.Fatal("expected a completed snapshot")
	}
	if job.Snapshot.ID == staleSnapshotID {
		t.Fatal("a stale journal must never resume the old snapshot ID")
	}

	if len(provider.deleteCalls) != 0 {
		t.Fatalf("expected zero Delete calls for a discarded stale journal, got: %v", provider.deleteCalls)
	}
	if _, stillThere := provider.files[orphanKey]; !stillThere {
		t.Fatal("the stale journal's orphan object must survive — the agent no longer cleans it up (GC's manifest-less rule is the backstop)")
	}
}
```

Update the comment on `TestRunBackup_IncrementalRetentionDoesNotStrandReferencedObjects` (`backup_test.go:924-933`) — the branch it warns about is now gone, not merely gated:
```go
// Incremental dedupe (now unconditional) carries an unchanged file's bytes
// forward under the OLDEST snapshot's prefix, and every newer manifest
// references back into it. Agent-side retention pruning of OTHER,
// already-published snapshots has been removed entirely (D18 §3.5,
// DeleteSnapshotContext deleted) — this test proves the server-only-
// retention invariant holds end-to-end: with Retention:2 (now fully
// ignored, see GetRetention's doc comment) and 3+ incremental runs over an
// UNCHANGED source, the agent must NOT prune, and a verify/restore from the
// NEWEST manifest must still succeed. (The narrower own-run-prefix cleanup
// in abortStopped/abortSourceGone is unaffected and unrelated to this test.)
```

- [ ] Step 4: Run, expect PASS (and confirm the two removed functions leave no dangling references while the two kept ones still compile and are still called):
```
cd agent && go build ./... && go test ./internal/backup/... ./cmd/breeze-backup/... -run 'TestBackupNeverDeletesRemoteObjects|TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix|TestRunBackup_IncrementalRetentionDoesNotStrandReferencedObjects|TestRunBackupContext_StaleJournalDiscardedWithoutRemoteCleanup' -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/backup.go agent/internal/backup/snapshot.go agent/internal/backup/snapshot_lifecycle_test.go agent/internal/backup/snapshot_test.go agent/internal/backup/backup_test.go
git commit -m "feat(agent/backup): remove agent-side retention pruning and stale-journal cleanup (D18 §3.5)"
```

### Task 6: Resume with an already-published manifest — skip re-upload entirely, fail CLOSED on ambiguous errors, run BEFORE source validation

Two corrections from independent review folded in here:
- **P1 (fail-open bug):** the original design treated ANY download failure — including a transient network error — as "manifest absent, safe to upload". That is wrong: a transient error must never be conflated with a confirmed-absent object, since guessing wrong risks silently overwriting/duplicating a manifest that genuinely exists. Only a POSITIVELY CONFIRMED not-found may proceed to upload; every other error must abort the run untouched. This requires a way to distinguish "confirmed absent" from "some other failure" across providers — added as part of this task (`providers.ErrObjectNotFound`).
- **P2 (ordering bug):** the resume check must run BEFORE `RunBackupContext`'s source-scan short-circuits (`backup.go:641`'s `len(files) == 0` exit, reached before `createSnapshotWithProgress` is ever called) and before `createSnapshotWithProgress`'s own `len(files) == 0` reject (`snapshot.go:371`). Otherwise a resumed run whose source has since vanished (disk unplugged, volume gone) would report failure/skipped instead of the success it should report, since the manifest was already durably published. This means the journal-open block (currently `backup.go:713-756`) must be HOISTED to before VSS/scan, and the resume check performed there — not solely inside `createSnapshotWithProgress`, which by construction can't run early enough for this ordering to hold when reached only from `RunBackupContext`.

**Files:**
- Modify `agent/internal/backup/providers/interface.go` (new `ErrObjectNotFound` sentinel)
- Modify `agent/internal/backup/providers/local.go` (`Download`, `:87-107`) and `agent/internal/backup/providers/s3.go` (`Download`, `:135-165`) — wrap confirmed-not-found errors
- Modify `agent/internal/backup/backup.go` — hoist the journal-open block (`:713-756`) from after the scan to right after `defer stopRunKeepalive()` (`:408`), before the VSS block (`:410`); add the resume-shortcut check there
- Modify `agent/internal/backup/snapshot.go` (`createSnapshotWithProgress`, insert after the `prefix := path.Join(...)` line, currently `:390`, as a SECOND, defensive check — see design note)
- Test: `agent/internal/backup/snapshot_test.go`, `agent/internal/backup/backup_test.go` (new tests), `agent/internal/backup/providers/local_test.go`, `agent/internal/backup/providers/s3_test.go` (new tests for the sentinel wrapping)

**Interfaces:**
- Produces: `providers.ErrObjectNotFound` (sentinel `error`, `providers/interface.go`) — a provider's `Download` wraps it (`fmt.Errorf("%w: ...", providers.ErrObjectNotFound, ...)`) only when it can POSITIVELY confirm the object doesn't exist.
- Produces (unexported): `fetchPublishedManifest(ctx context.Context, provider providers.BackupProvider, prefix string) (snapshot *Snapshot, err error)` — **three-state**, not two: `(snapshot, nil)` = confirmed present and decodable; `(nil, nil)` = confirmed absent (`errors.Is(downloadErr, providers.ErrObjectNotFound)`), safe to proceed with upload; `(nil, err)` = anything else (network failure, decode error, corrupt manifest) — caller MUST fail the run closed, uploading and deleting nothing.
- Design note: the check now lives in TWO places by design, not one. `RunBackupContext` (`backup.go`) performs it early (before scan) as the PRIMARY enforcement point — this is what makes the "source gone" ordering correct. `createSnapshotWithProgress` keeps a second, identical check (as before) so its own direct unit tests (which call it without going through `RunBackupContext`) still exercise and prove the behavior in isolation. Both call the same `fetchPublishedManifest` helper, so there is one implementation, not two.

- [ ] Step 1: Write the failing tests.

**Provider-level (new files or extend existing `_test.go` files) — proves the sentinel wrapping:**
```go
// In agent/internal/backup/providers/local_test.go
func TestLocalProvider_Download_MissingFileWrapsErrObjectNotFound(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Download("snapshots/does-not-exist/manifest.json", filepath.Join(t.TempDir(), "out.json"))
	if err == nil {
		t.Fatal("expected an error for a missing object")
	}
	if !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("err = %v, want it to wrap ErrObjectNotFound", err)
	}
}

// In agent/internal/backup/providers/s3_test.go — requires whatever fake S3
// backend / httptest server this file's existing tests already use to
// return a 404/NoSuchKey response; mirror that pattern (grep the file
// first for its existing GetObject-mocking approach) rather than hitting
// real S3. If no such fake exists for Download today, add the minimal one
// needed to return a NoSuchKey-shaped error.
func TestS3Provider_Download_NoSuchKeyWrapsErrObjectNotFound(t *testing.T) {
	// (fill in using this file's existing S3 test-double pattern)
}
```

**Resume/ordering (`snapshot_test.go`):**
```go
func TestFetchPublishedManifest_ConfirmedAbsent_ReturnsNilNil(t *testing.T) {
	provider := newMockProvider() // never seeded with the manifest key
	snap, err := fetchPublishedManifest(context.Background(), provider, "snapshots/never-published")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap != nil {
		t.Fatalf("expected nil snapshot for a confirmed-absent manifest, got %+v", snap)
	}
}

// mockProvider needs a way to simulate a TRANSIENT (non-not-found) download
// failure, distinct from "key genuinely absent" — add a `downloadErr error`
// override if the existing field always represents a generic failure (check
// mockProvider.downloadErr's current semantics first; if it's already a
// plain, non-ErrObjectNotFound error by default, it already models this
// case correctly with no changes needed).
func TestFetchPublishedManifest_TransientError_FailsClosed_NotTreatedAsAbsent(t *testing.T) {
	provider := newMockProvider()
	provider.downloadErr = errors.New("connection reset by peer") // NOT ErrObjectNotFound
	snap, err := fetchPublishedManifest(context.Background(), provider, "snapshots/some-id")
	if err == nil {
		t.Fatal("expected a non-nil error for a transient failure — must NOT be treated as confirmed absence")
	}
	if snap != nil {
		t.Fatalf("expected nil snapshot on error, got %+v", snap)
	}
}

func TestCreateSnapshot_ResumeWithAlreadyPublishedManifest_SkipsUploadAndDelete(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content one")
	provider := newMockProvider()

	journalDir := t.TempDir()
	journal, _, err := openSnapshotJournal(journalDir, "resume-published-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}

	// Simulate a crash AFTER manifest publish but BEFORE journal.Complete():
	// the manifest already exists at this snapshot's prefix.
	published := &Snapshot{
		ID:        journal.snapshotID,
		Timestamp: time.Now().UTC(),
		Files:     []SnapshotFile{{SourcePath: file1, BackupPath: "snapshots/" + journal.snapshotID + "/files/file1.txt.gz", Size: 11}},
		Size:      11,
	}
	storeManifest(t, provider, published)
	preUploadCount := len(provider.uploadCalls)

	journal.Abandon()
	journal2, resumed, err := openSnapshotJournal(journalDir, "resume-published-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal (resume) failed: %v", err)
	}
	if !resumed {
		t.Fatal("expected the journal to resume")
	}

	files := []backupFile{{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 11, modTime: time.Now()}}
	snap, err := createSnapshotWithProgress(context.Background(), provider, files, nil, journal2, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap == nil || snap.ID != journal.snapshotID {
		t.Fatalf("expected the already-published snapshot to be returned, got %+v", snap)
	}
	if len(provider.uploadCalls) != preUploadCount {
		t.Fatalf("expected zero NEW uploads on an already-published resume, got %d new calls", len(provider.uploadCalls)-preUploadCount)
	}
	if len(provider.deleteCalls) != 0 {
		t.Fatalf("expected zero deletes on an already-published resume, got %v", provider.deleteCalls)
	}
}
```

**Source-gone ordering, at the `RunBackupContext` level (`backup_test.go`) — this is the test that actually proves the P2 fix:**
```go
func TestRunBackupContext_ResumeWithPublishedManifest_SucceedsEvenIfSourceGone(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content")
	provider := newMockProvider()
	stagingDir := t.TempDir()

	identity := backupIdentity(provider, []string{tmpDir})
	journal, _, err := openSnapshotJournal(stagingDir, identity, journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	published := &Snapshot{
		ID:    journal.snapshotID,
		Files: []SnapshotFile{{SourcePath: file1, BackupPath: "snapshots/" + journal.snapshotID + "/files/file1.txt.gz", Size: 7}},
		Size:  7,
	}
	storeManifest(t, provider, published)
	journal.Abandon()

	// The source is now GONE — remove the file (and its directory) the
	// configured path pointed at, so a fresh scan would find nothing and,
	// pre-fix, hit backup.go:641's len(files)==0 early exit BEFORE the
	// journal/resume check ever ran.
	if err := os.RemoveAll(tmpDir); err != nil {
		t.Fatalf("failed to remove source dir: %v", err)
	}

	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{tmpDir},
		StagingDir: stagingDir,
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("expected the resume shortcut to succeed despite the gone source, got err: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("job.Status = %q, want %q (source-gone must not prevent reporting the already-published manifest)", job.Status, jobStatusCompleted)
	}
	if job.Snapshot == nil || job.Snapshot.ID != journal.snapshotID {
		t.Fatalf("expected the already-published snapshot back, got %+v", job.Snapshot)
	}
}
```

- [ ] Step 2: Run it, expect FAIL — `TestLocalProvider_Download_MissingFileWrapsErrObjectNotFound` fails to compile (`undefined: ErrObjectNotFound`); `TestFetchPublishedManifest_TransientError_FailsClosed_NotTreatedAsAbsent` fails to compile (`undefined: fetchPublishedManifest`, or once Step 3 lands, fails because the old two-state version treats the transient error as absence); `TestRunBackupContext_ResumeWithPublishedManifest_SucceedsEvenIfSourceGone` fails against CURRENT/unhoisted code with `job.Status = "skipped"` (or `"failed"`), proving the ordering bug:
```
cd agent && go test ./internal/backup/... -run 'ErrObjectNotFound|FetchPublishedManifest|TestCreateSnapshot_ResumeWithAlreadyPublishedManifest|TestRunBackupContext_ResumeWithPublishedManifest' -v
```

- [ ] Step 3: Implement.

In `agent/internal/backup/providers/interface.go`, add:
```go
// ErrObjectNotFound is a sentinel a BackupProvider's Download should wrap
// (via fmt.Errorf("%w: ...", ErrObjectNotFound, ...)) ONLY when it can
// POSITIVELY confirm the requested remote object does not exist — never for
// any other failure (network, permission, decode, timeout). Callers use
// errors.Is(err, ErrObjectNotFound) to distinguish "confirmed absent, safe
// to proceed" from "unknown, must fail closed" — see backup.fetchPublished
// Manifest, whose entire correctness depends on this distinction never
// being blurred. LocalProvider and S3Provider (the two providers reachable
// via the backup_run payload today, per exec_backup.go) implement this;
// other providers are not wired to it yet and any caller depending on it
// must treat their errors as "not confirmed absent" (the safe default).
var ErrObjectNotFound = errors.New("backup provider: object not found")
```
(Add `"errors"` to that file's imports if not already present.)

In `agent/internal/backup/providers/local.go`, change `Download` (`:87-107`) to check for a missing source file and wrap it:
```go
// Download retrieves a file from the local backup store.
func (p *LocalProvider) Download(remotePath, localPath string) error {
	if p.BasePath == "" {
		return errors.New("local provider base path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}
	if localPath == "" {
		return errors.New("local destination path is required")
	}

	srcPath, err := containedPath(p.BasePath, remotePath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	var downloadErr error
	if strings.HasSuffix(remotePath, ".gz") {
		downloadErr = decompressFile(srcPath, localPath)
	} else {
		downloadErr = copyFileContext(context.Background(), srcPath, localPath)
	}
	if downloadErr != nil && errors.Is(downloadErr, fs.ErrNotExist) {
		// %w wrapping through decompressFile/copyFileContext's own
		// fmt.Errorf calls preserves the underlying os.PathError, so
		// errors.Is against fs.ErrNotExist still sees through the chain —
		// this positively confirms the source object is absent, not merely
		// that SOME step failed.
		return fmt.Errorf("%w: %s", ErrObjectNotFound, downloadErr)
	}
	return downloadErr
}
```
(Add `"io/fs"` to `local.go`'s imports.)

In `agent/internal/backup/providers/s3.go`, change `Download` (`:135-165`) to check for `NoSuchKey`:
```go
	resp, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(remotePath),
	})
	if err != nil {
		var noSuchKey *s3types.NoSuchKey
		if errors.As(err, &noSuchKey) {
			return fmt.Errorf("%w: %s", ErrObjectNotFound, err)
		}
		return fmt.Errorf("failed to get s3 object: %w", err)
	}
```
(Note: some S3-compatible backends return a generic API error with `Code() == "NoSuchKey"` rather than the typed `s3types.NoSuchKey` struct — this typed check does not catch that case. Flagged in Open Questions; not fixed in this wave to avoid pulling `github.com/aws/smithy-go` from an indirect to a direct `go.mod` dependency for a single error-classification edge case.)

In `agent/internal/backup/snapshot.go`, replace the earlier two-state `fetchPublishedManifest` design with the three-state contract:
```go
// fetchPublishedManifest checks whether prefix's manifest.json has already
// been published, distinguishing three outcomes (P1 fix — a transient
// error must NEVER be treated the same as confirmed absence):
//   - (snapshot, nil): confirmed present and decodable — the caller's
//     resume-shortcut must return this snapshot, uploading nothing.
//   - (nil, nil): CONFIRMED absent (providers.ErrObjectNotFound) — safe to
//     proceed with a normal upload.
//   - (nil, err): anything else (network error, decode error, corrupt
//     manifest, context already done) — the caller MUST fail the run
//     closed: upload nothing, delete nothing, since we genuinely don't
//     know whether a real manifest exists at this prefix.
func fetchPublishedManifest(ctx context.Context, provider providers.BackupProvider, prefix string) (*Snapshot, error) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	manifestKey := path.Join(prefix, snapshotManifestKey)
	tempFile, err := os.CreateTemp("", "resume-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file for resume manifest check: %w", err)
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer os.Remove(tempPath)

	if err := provider.Download(manifestKey, tempPath); err != nil {
		if errors.Is(err, providers.ErrObjectNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to check for an already-published manifest at %s: %w", manifestKey, err)
	}
	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read downloaded resume manifest: %w", err)
	}
	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, fmt.Errorf("failed to decode resume manifest %s: %w", manifestKey, err)
	}
	return &snapshot, nil
}
```

In `createSnapshotWithProgress`, immediately after `prefix := path.Join(snapshotRootDir, snapshot.ID)` (currently line 390, right before `var errs []error`), add the SECOND (defensive, unit-testable-in-isolation) check:
```go
	prefix := path.Join(snapshotRootDir, snapshot.ID)

	// Resume-with-already-published-manifest (D18 §3.5): a prior attempt
	// may have published manifest.json and then crashed before
	// journal.Complete() removed the journal. Re-uploading now would
	// overwrite a COMPLETED, restorable manifest — treat its confirmed
	// presence as "this run already finished" and return it as-is,
	// uploading nothing. This is a SECOND check: RunBackupContext
	// (backup.go) performs the same one earlier, before source scanning,
	// so a source-gone resumed run reports success instead of hitting the
	// len(files)==0 reject below first — see this task's ordering note.
	// Kept here too so direct callers of this function (this package's own
	// unit tests) still exercise and prove the behavior without going
	// through RunBackupContext.
	if journal != nil && journal.resumed {
		existing, fetchErr := fetchPublishedManifest(ctx, provider, prefix)
		if fetchErr != nil {
			return nil, fmt.Errorf("resume check failed, refusing to guess whether %s was already published: %w", prefix, fetchErr)
		}
		if existing != nil {
			log.Info("resume: manifest already published, skipping upload",
				"snapshotId", existing.ID,
				"files", len(existing.Files),
			)
			if err := journal.Complete(); err != nil {
				log.Warn("failed to remove completed checkpoint journal", "error", err.Error())
			}
			completed = true
			return existing, nil
		}
		// existing == nil, fetchErr == nil: confirmed absent — fall through
		// to a normal upload below.
	}

	var errs []error
```

In `agent/internal/backup/backup.go`, HOIST the journal-open block. Move the existing block currently at `:713-756` (from the `// Checkpoint journal:` comment through the closing `}` of the `if journal != nil { ... }` logging block) to immediately after `defer stopRunKeepalive()` (`:408`), before the `// VSS:` comment (`:410`). Immediately after the moved block, insert the early resume-shortcut check:
```go
	// (moved block: journal open + stale-journal warn + resumed-journal log,
	// unchanged content from the original :713-756, minus the
	// cleanupSnapshotPrefix call already removed by Task 5)

	// Resume-with-already-published-manifest, checked BEFORE any source
	// scanning (P2 fix): a resumed run whose manifest is already published
	// must report success even if the configured source has since vanished
	// — the len(files)==0 exits later in this function (and in
	// createSnapshotWithProgress) must never get a chance to fail this run
	// first. See fetchPublishedManifest's three-state contract: only a
	// CONFIRMED-absent result falls through to a normal run; any other
	// error fails the job closed right here.
	if journal != nil && resumedJournal {
		prefix := path.Join(snapshotRootDir, journal.snapshotID)
		existing, fetchErr := fetchPublishedManifest(runCtx, m.config.Provider, prefix)
		if fetchErr != nil {
			job.Status = jobStatusFailed
			job.CompletedAt = time.Now().UTC()
			job.Error = fmt.Errorf("resume check failed, refusing to guess whether %s was already published: %w", prefix, fetchErr)
			return job, job.Error
		}
		if existing != nil {
			log.Info("resume: manifest already published, skipping the entire run",
				"snapshotId", existing.ID,
				"files", len(existing.Files),
			)
			if err := journal.Complete(); err != nil {
				log.Warn("failed to remove completed checkpoint journal", "error", err.Error())
			}
			job.Status = jobStatusCompleted
			job.CompletedAt = time.Now().UTC()
			job.Snapshot = existing
			job.FilesBackedUp = len(existing.Files)
			job.BytesBackedUp = existing.Size
			for _, f := range existing.Files {
				if isReferenceEntry(f, existing.ID) {
					job.ReferencedFiles++
					job.ReferencedBytes += f.Size
				}
			}
			return job, nil
		}
		// existing == nil, fetchErr == nil: confirmed absent — proceed to
		// VSS/scan/upload normally, reusing this SAME journal (no second
		// open) all the way down to createSnapshotWithProgress's call site.
	}
```
`path` is already imported by `backup.go` — verify (`grep -n '"path"' agent/internal/backup/backup.go`); if the file imports only `path/filepath` today, add a plain `"path"` import alongside it (`path.Join` and `path/filepath`'s `filepath.Join` are different packages — `snapshotRootDir`/prefix construction elsewhere in this package uses `path.Join`, e.g. `snapshot.go:390`, so match that convention here, not `filepath.Join`).

Remove the now-redundant original journal-open block from its old location (the code has moved, not duplicated) — the `createSnapshotWithProgress` call site (originally `:758`) now simply reuses the `journal`/`resumedJournal` variables declared up top; no `openSnapshotJournal` call remains at the bottom of the function.

- [ ] Step 4: Run, expect PASS:
```
cd agent && go build ./... && go test ./internal/backup/... -run 'ErrObjectNotFound|FetchPublishedManifest|TestCreateSnapshot_ResumeWithAlreadyPublishedManifest|TestRunBackupContext_ResumeWithPublishedManifest' -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/providers/interface.go agent/internal/backup/providers/local.go agent/internal/backup/providers/s3.go agent/internal/backup/backup.go agent/internal/backup/snapshot.go agent/internal/backup/snapshot_test.go agent/internal/backup/backup_test.go agent/internal/backup/providers/local_test.go agent/internal/backup/providers/s3_test.go
git commit -m "feat(agent/backup): resume-with-published-manifest runs before source validation, fails closed on ambiguous errors"
```

### Task 7: `upload.lease` heartbeat — write during upload, delete after publish

**Files:**
- Modify `agent/internal/backup/snapshot.go` (`createSnapshotWithProgress`, alongside the existing progress-keepalive goroutine at `:433-452`, and at the two successful-publish points: normal completion `:784-796` and `abortSourceGone`'s partial-publish branch `:548-566` — re-verified line numbers)
- Test: `agent/internal/backup/snapshot_test.go` (new tests)

**Interfaces:**
- Produces (unexported): `refreshUploadLease(ctx context.Context, provider providers.BackupProvider, leaseKey string)`
- **P2 fix — bounded, cancellable refreshes:** each refresh call gets its OWN context, derived from a dedicated `leaseCtx` (not the run's raw `ctx`) with a 60s timeout, so a single stalled PUT can never block longer than 60s. `stopLeaseRefresh` cancels `leaseCtx` directly (not just a bare `close(leaseStop)` channel) so an in-flight refresh's context becomes `Done` immediately on stop, rather than `stopLeaseRefresh` waiting out whatever timeout happened to be in flight.

- [ ] Step 1: Write the failing test (use a short interval via a test seam, and a small local fake that sleeps on the FIRST file upload so the lease ticker has time to fire — `blockAfterNProvider` (`snapshot_test.go:743-778`) blocks until `ctx.Done()` rather than for a fixed duration, so it doesn't fit this test; a purpose-built fake is simpler than adapting it):
```go
// setUploadLeaseIntervalForTest overrides uploadLeaseInterval so tests don't
// wait 15 real minutes. Mirrors setJournalMaxAgeForTest's pattern.
// uploadLeaseInterval must be a `var` (Task 4/7 make it one, not `const`)
// for this seam to compile.
func setUploadLeaseIntervalForTest(d time.Duration) (restore func()) {
	old := uploadLeaseInterval
	uploadLeaseInterval = d
	return func() { uploadLeaseInterval = old }
}

// slowFirstUploadProvider wraps mockProvider and sleeps for `delay` on the
// FIRST call to Upload/UploadContext only (the real file, not the
// upload.lease refreshes or the final manifest), so a test can force the
// upload loop to sit still long enough for the lease-refresh ticker to fire
// at least once without depending on real wall-clock file I/O.
type slowFirstUploadProvider struct {
	*mockProvider
	delay    time.Duration
	slowOnce sync.Once
}

func (p *slowFirstUploadProvider) Upload(localPath, remotePath string) error {
	p.slowOnce.Do(func() { time.Sleep(p.delay) })
	return p.mockProvider.Upload(localPath, remotePath)
}

func (p *slowFirstUploadProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	p.slowOnce.Do(func() { time.Sleep(p.delay) })
	return p.mockProvider.Upload(localPath, remotePath)
}

func TestCreateSnapshot_UploadLease_RefreshedDuringUploadThenDeletedAfterPublish(t *testing.T) {
	restore := setUploadLeaseIntervalForTest(10 * time.Millisecond)
	defer restore()

	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "file1.txt", "content")
	backing := newMockProvider()
	provider := &slowFirstUploadProvider{mockProvider: backing, delay: 50 * time.Millisecond}

	files := []backupFile{{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 7, modTime: time.Now()}}
	snap, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	leaseKey := "snapshots/" + snap.ID + "/upload.lease"
	sawLeaseUpload := false
	for _, call := range backing.uploadCalls {
		if call.remotePath == leaseKey {
			sawLeaseUpload = true
		}
	}
	if !sawLeaseUpload {
		t.Error("expected at least one upload.lease refresh during a slow upload")
	}
	if _, stillThere := backing.files[leaseKey]; stillThere {
		t.Error("expected upload.lease to be deleted after a successful publish")
	}
	sawLeaseDelete := false
	for _, key := range backing.deleteCalls {
		if key == leaseKey {
			sawLeaseDelete = true
		}
	}
	if !sawLeaseDelete {
		t.Error("expected exactly one Delete call for upload.lease after publish")
	}
}
```

- [ ] Step 2: Run it, expect FAIL (`sawLeaseUpload` false — no such object is ever written today):
```
cd agent && go test ./internal/backup/ -run TestCreateSnapshot_UploadLease -v
```

- [ ] Step 3: Implement.

Change `uploadLeaseInterval` from `const` to a test-seamable `var` in `snapshot.go` (it must stay a variable, matching `journalMaxAge`'s pattern, so tests can shrink it):
```go
// uploadLeaseInterval is how often createSnapshotWithProgress refreshes
// snapshots/<id>/upload.lease while uploading (D18 §3.4) ... [same doc as Task 4]
var uploadLeaseInterval = 15 * time.Minute
```
(Move it out of the `const (...)` block introduced in Task 4 — `publishMargin` stays a `const`, `uploadLeaseInterval` becomes a package-level `var`.)

Add the refresh helper near `publishSnapshotManifest`:
```go
// refreshUploadLease best-effort writes the current UTC time (RFC3339) to
// leaseKey. Failure is logged, never fatal — see the upload.lease doc
// comment in createSnapshotWithProgress.
func refreshUploadLease(ctx context.Context, provider providers.BackupProvider, leaseKey string) {
	tempFile, err := os.CreateTemp("", "upload-lease-*.txt")
	if err != nil {
		log.Warn("failed to create upload lease temp file", "error", err.Error())
		return
	}
	tempPath := tempFile.Name()
	if _, err := tempFile.WriteString(time.Now().UTC().Format(time.RFC3339)); err != nil {
		_ = tempFile.Close()
		os.Remove(tempPath)
		log.Warn("failed to write upload lease content", "error", err.Error())
		return
	}
	_ = tempFile.Close()
	defer os.Remove(tempPath)
	if err := uploadSnapshotFile(ctx, provider, tempPath, leaseKey); err != nil {
		log.Warn("failed to refresh upload lease", "key", leaseKey, "error", err.Error())
	}
}
```

In `createSnapshotWithProgress`, right after the existing progress-keepalive goroutine block (`:433-452`, the `if onProgress != nil { ... }` block), add a second, unconditional (runs regardless of `onProgress`) goroutine. **P2 fix**: each refresh gets its own 60s-bounded context derived from a dedicated `leaseCtx`, and `stopLeaseRefresh` cancels `leaseCtx` (not merely a bare channel close) so a stalled in-flight PUT is interrupted immediately on stop rather than making the caller wait out the full 60s:
```go
	// upload.lease heartbeat (D18 §3.4): refresh a tiny marker object every
	// uploadLeaseInterval while uploading, so GC's manifest-less-prefix
	// window keeps extending for a legitimately slow multi-day single-file
	// upload. leaseCtx (derived from ctx) is cancelled by stopLeaseRefresh —
	// called exactly once via leaseStopOnce, on completion or ctx
	// cancellation — which immediately interrupts any in-flight refresh
	// rather than waiting out its 60s bound. Skipped entirely by the
	// resume-already-published shortcut above, since that path returns
	// before this point.
	leaseKey := path.Join(prefix, "upload.lease")
	leaseCtx, leaseCancel := context.WithCancel(ctx)
	leaseDone := make(chan struct{})
	var leaseStopOnce sync.Once
	stopLeaseRefresh := func() {
		leaseStopOnce.Do(func() {
			leaseCancel()
			<-leaseDone
		})
	}
	go func() {
		defer close(leaseDone)
		ticker := time.NewTicker(uploadLeaseInterval)
		defer ticker.Stop()
		for {
			select {
			case <-leaseCtx.Done():
				return
			case <-ticker.C:
				// Each refresh is bounded to 60s AND tied to leaseCtx, so
				// stopLeaseRefresh's leaseCancel() unblocks it immediately
				// instead of this goroutine sitting in a stalled PUT for up
				// to 60s after the caller asked it to stop.
				refreshCtx, cancel := context.WithTimeout(leaseCtx, 60*time.Second)
				refreshUploadLease(refreshCtx, provider, leaseKey)
				cancel()
			}
		}
	}()
	defer stopLeaseRefresh()
```

At the normal-completion success path (immediately after the existing `if journal != nil { journal.Complete(); completed = true }` block, before `return snapshot, nil`):
```go
	stopLeaseRefresh()
	if delErr := provider.Delete(leaseKey); delErr != nil {
		log.Warn("failed to remove upload.lease after publish", "key", leaseKey, "error", delErr.Error())
	}

	return snapshot, nil
```

At `abortSourceGone`'s successful partial-publish path (after the `log.Warn("published a PARTIAL manifest...")` line, before `return snapshot, detail`):
```go
		stopLeaseRefresh()
		if delErr := provider.Delete(leaseKey); delErr != nil {
			log.Warn("failed to remove upload.lease after partial publish", "key", leaseKey, "error", delErr.Error())
		}
		return snapshot, detail
```
(`stopLeaseRefresh`/`leaseKey` are closures/locals of `createSnapshotWithProgress`, already in scope inside the `abortSourceGone` closure defined in the same function body.)

- [ ] Step 4: Run, expect PASS:
```
cd agent && go test ./internal/backup/ -run TestCreateSnapshot_UploadLease -v -race
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/snapshot.go agent/internal/backup/snapshot_test.go
git commit -m "feat(agent/backup): refresh an upload.lease heartbeat during upload, delete after publish"
```

### Task 8: API-side contract test for the new payload fields and constants

**Files:**
- Modify `apps/api/src/services/backupAgentContract.test.ts`

**Interfaces:**
- Consumes: `BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` — a REAL import from `apps/api/src/jobs/backupRetention.ts` (it already exists today, confirmed via `grep -n "export const BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS" apps/api/src/jobs/backupRetention.ts`), so the `uploadLeaseInterval` assertion is an ACTUAL comparison against the live constant, not two independently-hardcoded literals that merely happen to agree. `BACKUP_PUBLISH_MARGIN_MS` does NOT exist anywhere in `apps/api` yet (it's spec §3.4/W02's constant) — it CANNOT be imported (a missing named export fails TypeScript compilation immediately, unlike a runtime `skipIf`), so that comparison is gated by source-text regex the same way the file's existing `BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS` check is (`:33-42`), and will need a follow-up edit once W02 lands to switch to a real import (noted in Open Questions).

- [ ] Step 1: Write the failing test — append to `backupAgentContract.test.ts`. Add the import alongside the file's existing imports at the top:
```ts
import { BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS } from '../jobs/backupRetention';
```
Then:
```ts
describe('backup Go<->TS contract — D18 server-owned base payload fields', () => {
  it('agent exec_backup.go decodes baseSnapshotId/publishLeaseExpiresAt and rejects server-owned mode without a lease', () => {
    const src = readRepoFile('agent/cmd/breeze-backup/exec_backup.go');
    expect(src).toMatch(/BaseSnapshotID\s*\*string\s*`json:"baseSnapshotId"`/);
    expect(src).toMatch(/PublishLeaseExpiresAt\s*string\s*`json:"publishLeaseExpiresAt"`/);
    expect(src).toMatch(/BaseSnapshotID != nil && publishLeaseExpiresAt\.IsZero\(\)/);
  });

  // Gated on W01 having landed: apps/api/src/jobs/backupWorker.ts does not
  // send these fields yet (confirmed 2026-09-09, no baseSnapshotId/
  // publishLeaseExpiresAt in that file). Once W01 adds them, this
  // assertion activates automatically — it is not skipped by name, it is
  // skipped by content, so no follow-up edit is needed here when W01 lands.
  const workerSrc = readRepoFile('apps/api/src/jobs/backupWorker.ts');
  const workerHasBaseFields = /baseSnapshotId/.test(workerSrc);

  it.skipIf(!workerHasBaseFields)(
    'backupWorker.ts dispatch payload uses the exact field names baseSnapshotId/publishLeaseExpiresAt (matches the Go json tags)',
    () => {
      expect(workerSrc).toMatch(/baseSnapshotId/);
      expect(workerSrc).toMatch(/publishLeaseExpiresAt/);
    },
  );

  it('agent publishMargin is 1 hour', () => {
    const src = readRepoFile('agent/internal/backup/snapshot.go');
    expect(src).toMatch(/publishMargin\s*=\s*1\s*\*\s*time\.Hour/);
  });

  // BACKUP_PUBLISH_MARGIN_MS is W02's constant (spec §3.4) and does not
  // exist in apps/api yet as of this wave (confirmed 2026-09-09) — it
  // CANNOT be imported here (an import of a non-existent export fails
  // TypeScript compilation outright, unlike a runtime skip), so this is
  // gated by source-text regex, mirroring this file's existing
  // BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS pattern (:33-42). When W02 adds the
  // real export, switch this to a real import + direct equality check
  // (see Open Questions) — until then this only proves the AGENT side.
  const retentionSrc = readRepoFile('apps/api/src/jobs/backupRetention.ts');
  const apiHasPublishMargin = /BACKUP_PUBLISH_MARGIN_MS/.test(retentionSrc);
  it.skipIf(!apiHasPublishMargin)(
    'API BACKUP_PUBLISH_MARGIN_MS equals 1 hour (3,600,000 ms), matching the agent publishMargin',
    () => {
      expect(retentionSrc).toMatch(/BACKUP_PUBLISH_MARGIN_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000\b/);
    },
  );

  it('agent uploadLeaseInterval (15 min) stays well under the ACTUAL API manifest-less GC window', () => {
    const agentSrc = readRepoFile('agent/internal/backup/snapshot.go');
    expect(agentSrc).toMatch(/uploadLeaseInterval\s*=\s*15\s*\*\s*time\.Minute/);
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    // Real comparison against the imported constant (currently 9 days:
    // journalMaxAge 7d + BACKUP_GC_GRACE_MS 48h) — not two independent
    // literals that happen to agree today.
    expect(FIFTEEN_MIN_MS).toBeLessThan(BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS / 100);
  });
});
```

- [ ] Step 2: Run it, expect FAIL with the `BaseSnapshotID`/`publishMargin`/`uploadLeaseInterval` regexes not matching (none exist until Tasks 1 and 4 land):
```
cd apps/api && npx vitest run src/services/backupAgentContract.test.ts
```
(Run this AFTER Tasks 1-7 are implemented, or expect it red until then — this task's steps assume it runs last in the sequence, per the Wave ordering below.)

- [ ] Step 3: Implement — no production code change; this task IS the test (Step 1's content), confirmed to pass once Tasks 1-7 land.

- [ ] Step 4: Run, expect PASS:
```
cd apps/api && npx vitest run src/services/backupAgentContract.test.ts
```

- [ ] Step 5: Commit:
```
git add apps/api/src/services/backupAgentContract.test.ts
git commit -m "test(api): pin the D18 server-owned-base payload field names and lease/GC-window constants"
```

## Task 9 (doc-only, no code): Confirm the helper-version reporting path

Not a code task — recorded here because the plan brief requires verifying it, and the finding is doc-only (see Open Questions).

`devices.backup_version` is populated from `breeze-backup --version`'s stdout (`agent/internal/heartbeat/backup_version.go:13-120`, the actual `exec.CommandContext(...).Output()` call at `:160`), which prints `main.version` (`agent/cmd/breeze-backup/main.go:36`), a build-time value injected via `-ldflags "-X main.version=$(VERSION)"` (`agent/Makefile:2-8`; release builds go through `agent/scripts/build-edition.sh` per the Makefile's own comment at `:4-6`). **No code in this wave sets or changes that value** — it is set by whatever release tag builds the binary that ships W03's changes. There is nothing to implement here; the release process must simply ensure the binary that carries this wave's changes is built with `VERSION` set to that release's number, so that W02's future capability gate (a `BACKUP_SERVER_BASE_MIN_HELPER_VERSION`-style constant, not yet added) can compare against it correctly. Flagged in Open Questions.

## Task 10: Wave verification

**Files:** none (verification only)

- [ ] Run the full agent backup package + breeze-backup command suite (including the touched `providers` subpackage) with race detection:
```
cd agent && go build ./... && go vet ./... && go test -race ./internal/backup/... ./internal/backup/providers/... ./cmd/breeze-backup/...
```
- [ ] Run the specific tests this review round added or rewrote, to confirm each is actually green (not just "the package compiles"):
```
cd agent && go test -race ./internal/backup/... -run 'TestManagerFromBackupRunPayload|TestFetchServerOwnedBase|TestSnapshotJournal_Age|TestLeaseGate|TestRunBackupContext_ServerOwnedMode_NeverListsTheBucket|TestRunBackupContext_ExpiredLease_RefusesToPublishManifest|TestBackupNeverDeletesRemoteObjects|TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix|TestRunBackupContext_StaleJournalDiscardedWithoutRemoteCleanup|TestFetchPublishedManifest|TestCreateSnapshot_ResumeWithAlreadyPublishedManifest|TestRunBackupContext_ResumeWithPublishedManifest|TestCreateSnapshot_UploadLease' -v
cd agent && go test -race ./internal/backup/providers/... -run 'ErrObjectNotFound' -v
```
- [ ] Run the one API-side contract test file:
```
cd apps/api && npx vitest run src/services/backupAgentContract.test.ts
```
- [ ] Confirm no other agent package references the two REMOVED functions (`cleanupSnapshotPrefix`/`listSnapshotPrefixItems` are intentionally kept — spec §3.5 exception — so they must NOT appear in this grep's target list):
```
grep -rn "DeleteSnapshot(\|DeleteSnapshotContext(" agent/ apps/helper/
```
Expect zero results (aside from any remaining doc-comment prose, which should also have been updated by Task 5). Separately confirm the two kept call sites still exist exactly twice:
```
grep -rn "cleanupSnapshotPrefix(" agent/internal/backup/snapshot.go
```
Expect exactly the function definition plus its two call sites in `abortStopped`/`abortSourceGone` (three matches total).
- [ ] Confirm the full agent test suite still passes (catches any of the ~30 unmodified `createSnapshotWithProgress` call sites breaking from an unrelated typo, though the signature itself is unchanged by design):
```
cd agent && go test -race ./...
```
- [ ] No DB migration, no Drizzle schema change, no cascade/export-registry change in this wave — `pnpm db:check-drift` is not applicable.
- [ ] PR body checklist:
  - [ ] Links the parent D18 tracking issue/feature (if `register_feature` was run for the whole D18 effort — check via `get_feature_status` before opening the PR).
  - [ ] States this wave is agent-shipped code (full review round per repo convention for agent/GC-adjacent changes) and names the one independent reviewer round performed.
  - [ ] Notes explicitly: no signature change to `createSnapshotWithProgress`; the lease/journal-age fence is enforced via the `leaseGate` provider wrapper instead, to avoid touching ~30 existing call sites.
  - [ ] Notes the two kept exceptions: `snapshot.go:499`/`:544` (`abortStopped`/`abortSourceGone`'s own-run-prefix `cleanupSnapshotPrefix` calls) are retained per spec §3.5 and are NOT part of this wave's "never deletes" removal — only `DeleteSnapshotContext`/`DeleteSnapshot` (deletion of OTHER, already-published snapshots) and the retention/stale-journal call sites were removed.
  - [ ] Notes the independent-review fixes folded into this version: resume detection fails CLOSED on any ambiguous error via the new `providers.ErrObjectNotFound` sentinel (Task 6); the lease gate installs on `BaseSnapshotID != nil`, not on a non-zero lease, and fails closed on a zero lease (Task 4); the resume-with-published-manifest check runs in `RunBackupContext` BEFORE source scanning, not only inside `createSnapshotWithProgress` (Task 6); the `upload.lease` heartbeat uses a per-refresh bounded context so `stopLeaseRefresh` never blocks on a stalled PUT (Task 7).
  - [ ] Notes Task 9's finding as a follow-up for whoever cuts the release that ships this wave (confirm `VERSION` at build time is the release's own version, so `devices.backup_version` reports it correctly for W02's future capability gate).

## Open questions / contradictions

1. **RESOLVED by coordinator decision (2026-09-09):** an earlier draft of this plan flagged `agent/internal/backup/snapshot.go:499`/`:544` (`abortStopped`/`abortSourceGone`'s own-run-prefix `cleanupSnapshotPrefix` calls) as candidates for removal, since the spec text available at the time named only two delete call sites. Spec §3.5 was subsequently updated to state these two are explicit, intentional exceptions ("the helper may delete objects under its own current run prefix before its manifest is published... kept as-is") — they delete only the CURRENT run's own never-yet-referenced prefix, never another snapshot's. Task 5 now keeps both call sites and the `cleanupSnapshotPrefix`/`listSnapshotPrefixItems` functions unchanged, removing only the retention-prune branch, the stale-journal cleanup call, and `DeleteSnapshot`/`DeleteSnapshotContext` (which deleted OTHER, already-published snapshots — the actually dangerous case). No further action needed.
2. **`publishLeaseExpiresAt` applying to full runs too, with no renewal, means a slow full run can outlive its lease and simply fail to publish**, exactly like a run that outlives `journalMaxAge` already fails to resume. This is explicitly the spec's stated design ("a run longer than the lease already cannot resume... so 'a run must publish within 7d of dispatch' is the existing envelope made explicit" — spec line ~130-135), not an open question about correctness, but it IS a new user-visible failure mode for slow FULL (non-incremental) backups that didn't exist before this wave (previously a full run had no deadline at all beyond the per-file/whole-run reaper timeouts). Confirming this is accepted product behavior, not something W03 should soften, is worth an explicit sign-off since it wasn't true before D18.
3. **Helper-version gating (spec §3.4's capability gate) is entirely W02's responsibility**, and its minimum-version constant does not exist yet in this worktree (confirmed via grep — only `BACKUP_QUEUE_MIN_HELPER_VERSION` exists today, for an unrelated feature). W03 has no code to write for it; Task 9 records that the mechanism it will eventually gate on (`devices.backup_version` sourced from `breeze-backup --version`, a build-time `-ldflags` value) is orthogonal to this wave's code and depends entirely on the release pipeline stamping the correct version — flagging so whoever cuts that release checks it, since there's no automated test that could catch a wrong `VERSION` at build time.
4. **`leaseGate`'s `UploadContext` fallback-to-plain-`Upload` when the wrapped provider lacks context support** silently drops `ctx` cancellation for that one call, identical to `uploadSnapshotFile`'s own pre-existing fallback behavior (`snapshot.go:869-880`) — not a regression, just noting the design intentionally mirrors an existing accepted trade-off rather than introducing a new one.
5. **S3 not-found detection (Task 6) only checks the typed `s3types.NoSuchKey`.** Some S3-compatible backends (older MinIO, certain on-prem gateways) return a generic API error with `Code() == "NoSuchKey"` rather than the SDK's typed struct — that shape is NOT caught by `errors.As(err, &noSuchKey)`, so on those backends a genuine 404 would be (safely, but sub-optimally) treated as "unknown error, fail closed" rather than "confirmed absent, proceed". This is the conservative failure direction (never silently overwrites/duplicates a real manifest) but does mean a resumed run against such a backend could spuriously fail its resume-check when it didn't need to. Not fixed in this wave because closing the gap requires promoting `github.com/aws/smithy-go` from an indirect to a direct `go.mod` dependency for one error-classification edge case — flagged for whoever owns provider compatibility to decide if it's worth doing.
6. **`BACKUP_PUBLISH_MARGIN_MS` contract test (Task 8) is source-text-gated, not a real import**, because the constant doesn't exist in `apps/api` yet (it's W02's, per spec §3.4). When W02 adds it, `backupAgentContract.test.ts` should be updated to import it directly (mirroring how `BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` is already imported after this wave) rather than leaving the regex-based check in place indefinitely — noted so it isn't forgotten once the real export exists.
