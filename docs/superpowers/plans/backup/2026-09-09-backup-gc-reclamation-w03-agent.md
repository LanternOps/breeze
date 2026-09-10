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
- `agent/internal/backup/snapshot.go:812-834` `publishSnapshotManifest` — writes the manifest to a temp file, then `uploadSnapshotFile(attemptCtx, provider, manifestPath, manifestKey)`. Both the normal-completion call (`:782`) and the `abortSourceGone` partial-manifest call (`:544-561`, specifically the `publishSnapshotManifest` at `:547`) go through this same function, so gating at the `provider.Upload`/`UploadContext` boundary via `isManifestPath` covers both without duplicating the check.
- `agent/internal/backup/snapshot.go:151` `contextUploader` interface (`UploadContext(ctx, localPath, remotePath) error`), checked via type assertion in `uploadSnapshotFile` (`:869`).
- `agent/internal/backup/snapshot.go:1054-1057` `isManifestPath(item string) bool` — already matches `.../manifest.json` or a bare `manifest.json` basename; reused as-is by the new lease gate, no change needed.
- `agent/internal/backup/journal.go:34` `journalMaxAge`. `:60-68` `snapshotJournal` struct has no `createdAt` field today — `header.CreatedAt` is read at `:155` inside `openSnapshotJournal` but never stored on the struct, so nothing today can ask "how old is my journal" after open. `:268-292` `createFreshJournal` builds `header.CreatedAt = time.Now().UTC()` but likewise drops it. `:88` `resumed bool` field already exists and is exactly the flag Task 4 needs ("if the run was resumed from a journal").
- `agent/internal/backup/snapshot_test.go:18-111` `mockProvider` — the fake `providers.BackupProvider` used across the package (`uploadCalls`/`deleteCalls`/`downloadCalls` tracking, `listResult` override, `uploadErr`/`downloadErr`/`listErr`/`deleteErr` injection). This is the fake every new test in this wave uses; no new fake needed.
- `agent/internal/backup/snapshot_lifecycle_test.go:108-208` (`TestDeleteSnapshot_NothingToDelete`, `_ZeroRetention`, `_NegativeRetention`, `_PrunesOldSnapshots`, `_RetentionExceedsCount`, `_DeleteError`) and `agent/internal/backup/snapshot_test.go:198-230` (`TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix`) are the seven tests directly exercising the functions Task 5 removes.
- `agent/internal/backup/backup_test.go:924-985` `TestRunBackup_IncrementalRetentionDoesNotStrandReferencedObjects` already asserts the agent performs **no** pruning in the incremental path (its comment describes the bug this wave permanently forecloses) — it needs no behavior change, only a comment update (the branch it describes is now gone, not merely gated).
- `apps/api/src/services/backupAgentContract.test.ts` (243 lines) — existing source-text-grep contract suite (e.g. `:31-48` pins `journalMaxAge` parity). Picked up by the ordinary unit config: confirmed `apps/api/vitest.config.ts` has no `exclude` for `services/*.test.ts`, so this file runs in `pnpm --filter @breeze/api test`, not the integration config.
- `apps/api/src/jobs/backupWorker.ts:411-490,640-760` `resolveBackupTargets`/dispatch payload construction — confirmed **no** `baseSnapshotId`/`publishLeaseExpiresAt` field exists yet (W01's job). Task 8's contract test must not hard-fail before W01 lands.
- `apps/api/src/services/backupHelperCapabilities.ts:1-20` — existing min-helper-version gate pattern (`BACKUP_QUEUE_MIN_HELPER_VERSION`, `backupHelperSupportsQueue`) that W02 will mirror for the GC capability gate; W03 does not add a TS constant, it only needs to confirm the *mechanism* by which a shipped agent's version becomes visible server-side (Task 9 below, doc-only).
- `agent/internal/heartbeat/backup_version.go:13-120` — the helper reports its version by shelling out to `breeze-backup --version`, which prints `Breeze Backup Version: <version>` (`agent/cmd/breeze-backup/main.go:36 var version = "dev"`, overridden via `-ldflags "-X main.version=$VERSION"` in `agent/Makefile:2-8` and the release build script). This is a **build-time value supplied by the release pipeline**, not something this wave's code sets — see Open Questions.

## File structure

- Modify `agent/cmd/breeze-backup/exec_backup.go` — decode `baseSnapshotId`/`publishLeaseExpiresAt`, thread into both `BackupConfig` literals.
- Modify `agent/internal/backup/backup.go` — `BackupConfig` new fields + doc comments, run-path mode switch, lease-gated provider substitution at the `createSnapshotWithProgress` call site, remove the retention-prune branch, remove ONLY the stale-journal `cleanupSnapshotPrefix` call (the two own-run-prefix `cleanupSnapshotPrefix` calls in `snapshot.go` are kept, see Task 5), add `ErrPublishLeaseExpired`/`ErrJournalExpiredAtPublish`, add `GetBaseSnapshotID`/`GetPublishLeaseExpiresAt` getters.
- Modify `agent/internal/backup/incremental.go` — new `fetchServerOwnedBase` function (imports gain `encoding/json`, `os`).
- Modify `agent/internal/backup/journal.go` — add `createdAt time.Time` field + `Age() time.Duration` method.
- Modify `agent/internal/backup/snapshot.go` — new `leaseGate` provider wrapper + `publishMargin`/`uploadLeaseInterval` constants; remove `DeleteSnapshot`/`DeleteSnapshotContext` only (`cleanupSnapshotPrefix`/`listSnapshotPrefixItems` and their two call sites in `abortStopped`/`abortSourceGone` are KEPT — spec §3.5 exception); add the resume-with-published-manifest shortcut and the `upload.lease` refresh goroutine + post-publish delete inside `createSnapshotWithProgress`.
- Modify (delete tests) `agent/internal/backup/snapshot_lifecycle_test.go` — remove the six `TestDeleteSnapshot_*` tests (they target the removed `DeleteSnapshot`/`DeleteSnapshotContext`), replace with `TestBackupNeverDeletesRemoteObjects_RetentionConfigured`.
- Modify `agent/internal/backup/snapshot_test.go` — remove `TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix`; add `TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAPublishedManifestPrefix` plus lease-gate / resume-shortcut / upload-lease tests.
- Modify `agent/internal/backup/incremental_test.go` — add `TestFetchServerOwnedBase_*` table.
- Modify `agent/internal/backup/journal_test.go` — add `TestSnapshotJournal_Age`.
- Modify `agent/internal/backup/backup_test.go` — add server-owned-mode `RunBackupContext` integration-style tests; update the stale comment on `TestRunBackup_IncrementalRetentionDoesNotStrandReferencedObjects`.
- Modify `agent/cmd/breeze-backup/exec_backup_test.go` — extend `TestManagerFromBackupRunPayload` table with the two new fields.
- Modify `apps/api/src/services/backupAgentContract.test.ts` — add the Go/TS payload-field-name parity test + the `uploadLeaseInterval` vs. manifest-less-window assertion.

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

- [ ] Step 2: Run it, expect FAIL with `mgr.GetBaseSnapshotID undefined (type *backup.BackupManager has no field or method GetBaseSnapshotID)`:
```
cd agent && go test ./cmd/breeze-backup/ -run TestManagerFromBackupRunPayload
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

	j2, resumed, err := openSnapshotJournal(dir, "resume-age-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal (2nd) failed: %v", err)
	}
	defer j2.Abandon()
	if !resumed {
		t.Fatal("expected the second open to resume the first journal")
	}
	if age := j2.Age(); age < 0 || age > time.Second {
		t.Fatalf("resumed journal Age() = %v, want ~0 (same createdAt as the original)", age)
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
	for _, key := range provider.uploads {
		if isManifestPath(key) {
			t.Fatalf("manifest was uploaded despite an expired lease: %s", key)
		}
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
	if !g.publishLeaseExpiresAt.IsZero() && time.Now().Add(publishMargin).After(g.publishLeaseExpiresAt) {
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
	// Gate manifest publication on the server's lease (D18 §3.1) whenever
	// one was sent — legacy servers (zero PublishLeaseExpiresAt) get the
	// unwrapped provider and unchanged behavior. Applies to full runs too,
	// not just incremental ones: the server fences every dispatched run's
	// late-result window this way.
	uploadProvider := m.config.Provider
	if !m.config.PublishLeaseExpiresAt.IsZero() {
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
- Modify `agent/internal/backup/snapshot_lifecycle_test.go` (remove the `DeleteSnapshot`/`DeleteSnapshotContext` tests only; `cleanupSnapshotPrefix`'s own behavior needs no new coverage here since Task 6 already proves it's never reached for a published manifest)
- Modify `agent/internal/backup/snapshot_test.go` (add a new scoping test; `TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix` is removed since it targets the removed `DeleteSnapshot`)
- Modify `agent/internal/backup/backup_test.go:924-985` (comment update only)

**Interfaces:**
- Removes: `DeleteSnapshot`, `DeleteSnapshotContext` only (confirmed zero external callers in Ground Truth §0; `backup.go:799` was `DeleteSnapshotContext`'s only caller).
- Keeps unchanged: `cleanupSnapshotPrefix`, `listSnapshotPrefixItems` (still called from `snapshot.go:499`/`:544`).
- Produces (test-only): `TestBackupNeverDeletesRemoteObjects_RetentionConfigured`, `TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAPublishedManifestPrefix`.
- **Ordering guarantee this task relies on**: Task 6's resume-with-already-published-manifest shortcut is inserted immediately after `prefix := path.Join(snapshotRootDir, snapshot.ID)` and returns before the upload loop — and therefore before either `abortStopped` or `abortSourceGone` can be reached — whenever `journal != nil && journal.resumed` and that journal's manifest already exists. So a journal-resumed run whose manifest is already published can never reach a `cleanupSnapshotPrefix` call: it returns via Task 6's early path first. This is a structural property of the current control flow (Task 6's insertion point strictly precedes both abort closures' only call sites), not something Task 5 needs to add logic for — but the new test below pins it as a regression guard in case a future refactor reorders them.

- [ ] Step 1: Write the failing tests.

Remove `TestDeleteSnapshot_NothingToDelete`, `_ZeroRetention`, `_NegativeRetention`, `_PrunesOldSnapshots`, `_RetentionExceedsCount`, `_DeleteError` from `snapshot_lifecycle_test.go` (`:108-208`) — they exercise a function that no longer exists — and add:
```go
// D18 §3.5: agent-side retention pruning is removed entirely (unlike the
// two explicit own-run-prefix exceptions kept in snapshot.go — see
// TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix... below). This replaces
// the removed DeleteSnapshot/DeleteSnapshotContext pruning tests: instead of
// asserting pruning behavior, it asserts NO deletion happens across
// multiple successful runs even with Retention configured.
func TestBackupNeverDeletesRemoteObjects_RetentionConfigured(t *testing.T) {
	tmpDir := t.TempDir()
	createTempFile(t, tmpDir, "data.txt", "content")
	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{tmpDir},
		Retention:  1, // ignored — see GetRetention's doc comment
		StagingDir: t.TempDir(),
		AgentID:    "test-device",
	})

	for i := 0; i < 3; i++ {
		if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
			t.Fatalf("RunBackupContext #%d failed: %v", i+1, err)
		}
	}
	if len(provider.deleteCalls) != 0 {
		t.Fatalf("expected zero Delete calls across successful runs with Retention set, got %d: %v", len(provider.deleteCalls), provider.deleteCalls)
	}
}
```

Remove `TestDeleteSnapshot_DoesNotDeleteAdjacentPrefix` in `snapshot_test.go` (`:198-230`) and add:
```go
// TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAPublishedManifestPrefix
// pins the §3.5 exception's boundary from both directions: (1) a journal-less
// stop DOES delete keys, but only under the aborted run's OWN snapshot id —
// never a sibling prefix that already has a manifest.json (an existing,
// referenceable snapshot); and (2) proves the ordering guarantee this task's
// Interfaces section describes — a journal-RESUMED run whose manifest is
// already published takes Task 6's early-return path and reaches
// cleanupSnapshotPrefix zero times, never deleting the manifest it just
// found.
func TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAPublishedManifestPrefix(t *testing.T) {
	t.Run("journal-less stop deletes only its own snapshot id's keys", func(t *testing.T) {
		tmpDir := t.TempDir()
		file1 := createTempFile(t, tmpDir, "file1.txt", "content")
		provider := newMockProvider()

		// Seed a sibling, already-published snapshot that must never be
		// touched by the aborted run's cleanup.
		sibling := &Snapshot{
			ID:    "snapshot-sibling-published",
			Files: []SnapshotFile{{SourcePath: "/data/other.txt", BackupPath: "snapshots/snapshot-sibling-published/files/other.txt.gz", Size: 1}},
		}
		storeManifest(t, provider, sibling)

		ctx, cancel := context.WithCancel(context.Background())
		cancel() // already stopped before the loop starts
		files := []backupFile{{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 7, modTime: time.Now()}}
		snap, err := createSnapshotWithProgress(ctx, provider, files, nil, nil, nil, nil)
		if !errors.Is(err, errBackupStopped) {
			t.Fatalf("err = %v, want errBackupStopped", err)
		}
		_ = snap // stopped runs return a nil snapshot; the aborted run's own id is read from deleteCalls below.

		for _, key := range provider.deleteCalls {
			if strings.HasPrefix(key, "snapshots/snapshot-sibling-published/") {
				t.Fatalf("abort cleanup deleted a key under a PUBLISHED sibling prefix: %s", key)
			}
		}
		if _, stillThere := provider.files["snapshots/snapshot-sibling-published/manifest.json"]; !stillThere {
			t.Fatal("sibling published manifest must survive the aborted run's cleanup")
		}
	})

	t.Run("resumed run with an already-published manifest never reaches cleanupSnapshotPrefix", func(t *testing.T) {
		tmpDir := t.TempDir()
		file1 := createTempFile(t, tmpDir, "file1.txt", "content")
		provider := newMockProvider()

		journalDir := t.TempDir()
		journal, _, err := openSnapshotJournal(journalDir, "resume-cleanup-guard-identity", journalMaxAge)
		if err != nil {
			t.Fatalf("openSnapshotJournal failed: %v", err)
		}
		published := &Snapshot{
			ID:    journal.snapshotID,
			Files: []SnapshotFile{{SourcePath: file1, BackupPath: "snapshots/" + journal.snapshotID + "/files/file1.txt.gz", Size: 7}},
		}
		storeManifest(t, provider, published)
		journal.Abandon()

		journal2, resumed, err := openSnapshotJournal(journalDir, "resume-cleanup-guard-identity", journalMaxAge)
		if err != nil {
			t.Fatalf("openSnapshotJournal (resume) failed: %v", err)
		}
		if !resumed {
			t.Fatal("expected the journal to resume")
		}

		// A cancelled context proves the resume shortcut wins the race
		// against abortStopped: if cleanupSnapshotPrefix ran here instead,
		// it would delete the manifest just seeded above.
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		files := []backupFile{{sourcePath: file1, snapshotPath: "path_0/file1.txt", size: 7, modTime: time.Now()}}
		snap, err := createSnapshotWithProgress(ctx, provider, files, nil, journal2, nil, nil)
		if err != nil {
			t.Fatalf("expected the resume shortcut to succeed despite the cancelled context, got err: %v", err)
		}
		if snap == nil || snap.ID != journal.snapshotID {
			t.Fatalf("expected the already-published snapshot back, got %+v", snap)
		}
		manifestKey := "snapshots/" + journal.snapshotID + "/manifest.json"
		if _, stillThere := provider.files[manifestKey]; !stillThere {
			t.Fatal("resumed run's own already-published manifest must survive — cleanupSnapshotPrefix must never have run")
		}
		for _, key := range provider.deleteCalls {
			if strings.HasPrefix(key, "snapshots/"+journal.snapshotID+"/") {
				t.Fatalf("cleanupSnapshotPrefix ran for a prefix with an already-published manifest: deleted %s", key)
			}
		}
	})
}
```
(`strings` is already imported by `snapshot_test.go` — verify before adding if not.)

- [ ] Step 2: Run it, expect FAIL — `TestBackupNeverDeletesRemoteObjects_RetentionConfigured` fails with non-zero delete calls (current retention-prune branch still fires for `Retention:1` since it's only gated on `!incrementalDedupeActive`, and this test uses `Paths` with no prior snapshot so `incrementalDedupeActive` is still true every run in this config... re-check: confirm which sub-case reproduces the CURRENT bug before relying on it — if `incrementalDedupeActive` is true throughout for this config the branch already doesn't fire, in which case this specific test is a regression guard rather than red-first. The second test, `TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix_NeverAPublishedManifestPrefix`'s second subtest, IS red-first against current code: Task 6 doesn't exist yet, so the resumed run calls `abortStopped()` → `cleanupSnapshotPrefix` → deletes the seeded manifest):
```
cd agent && go test ./internal/backup/ -run 'TestBackupNeverDeletesRemoteObjects_RetentionConfigured|TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix' -v
```
Confirm the resume subtest fails with the manifest missing (`stillThere` false) before implementing — that failure is this task's actual red signal; write Task 6 first if sequencing this task standalone (Tasks are listed in dependency order specifically so Task 6 lands before this test is expected green — if implementing out of order, note the dependency here).

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
cd agent && go build ./... && go test ./internal/backup/... ./cmd/breeze-backup/... -run 'TestBackupNeverDeletesRemoteObjects|TestAbortCleanup_OnlyDeletesOwnUnpublishedPrefix|TestRunBackup_IncrementalRetentionDoesNotStrandReferencedObjects' -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/backup.go agent/internal/backup/snapshot.go agent/internal/backup/snapshot_lifecycle_test.go agent/internal/backup/snapshot_test.go agent/internal/backup/backup_test.go
git commit -m "feat(agent/backup): remove agent-side retention pruning and stale-journal cleanup (D18 §3.5)"
```

### Task 6: Resume with an already-published manifest — skip re-upload entirely

**Files:**
- Modify `agent/internal/backup/snapshot.go` (`createSnapshotWithProgress`, insert after the `prefix := path.Join(...)` line, currently `:388`)
- Test: `agent/internal/backup/snapshot_test.go` (new tests)

**Interfaces:**
- Produces (unexported): `fetchPublishedManifest(ctx context.Context, provider providers.BackupProvider, prefix string) (*Snapshot, bool)`

- [ ] Step 1: Write the failing test:
```go
func TestCreateSnapshot_ResumeWithAlreadyPublishedManifest_SkipsUpload(t *testing.T) {
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

	// Re-open as a resume (same identity, same dir): openSnapshotJournal
	// would normally do this on a real second process start. Emulate it by
	// re-opening — resumed should be true since createdAt is fresh.
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
}
```

- [ ] Step 2: Run it, expect FAIL (current code re-uploads `file1.txt` since it isn't in the journal's resumed entries):
```
cd agent && go test ./internal/backup/ -run TestCreateSnapshot_ResumeWithAlreadyPublishedManifest_SkipsUpload -v
```

- [ ] Step 3: Implement.

Add near `publishSnapshotManifest` in `snapshot.go`:
```go
// fetchPublishedManifest downloads and decodes prefix's manifest.json if it
// exists, returning (snapshot, true) on success. ANY failure — download
// error (including a genuine "not found"), or decode error — returns
// (nil, false): a resume whose manifest isn't there yet just proceeds to
// upload normally, exactly like every other fail-open check in this
// package.
func fetchPublishedManifest(ctx context.Context, provider providers.BackupProvider, prefix string) (*Snapshot, bool) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, false
		}
	}
	manifestKey := path.Join(prefix, snapshotManifestKey)
	tempFile, err := os.CreateTemp("", "resume-manifest-*.json")
	if err != nil {
		return nil, false
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer os.Remove(tempPath)

	if err := provider.Download(manifestKey, tempPath); err != nil {
		return nil, false
	}
	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, false
	}
	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, false
	}
	return &snapshot, true
}
```

In `createSnapshotWithProgress`, immediately after `prefix := path.Join(snapshotRootDir, snapshot.ID)` (currently line 388, right before `var errs []error`):
```go
	prefix := path.Join(snapshotRootDir, snapshot.ID)

	// Resume-with-already-published-manifest (D18 §3.5): a prior attempt
	// may have published manifest.json and then crashed before
	// journal.Complete() removed the journal (or before Abandon even ran).
	// Re-uploading now would overwrite a COMPLETED, restorable manifest —
	// treat its presence as the definitive "this run already finished"
	// signal and return it as-is, uploading nothing.
	if journal != nil && journal.resumed {
		if existing, ok := fetchPublishedManifest(ctx, provider, prefix); ok {
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
	}

	var errs []error
```

- [ ] Step 4: Run, expect PASS:
```
cd agent && go test ./internal/backup/ -run TestCreateSnapshot_ResumeWithAlreadyPublishedManifest_SkipsUpload -v
```

- [ ] Step 5: Commit:
```
git add agent/internal/backup/snapshot.go agent/internal/backup/snapshot_test.go
git commit -m "feat(agent/backup): skip re-upload when resume finds an already-published manifest"
```

### Task 7: `upload.lease` heartbeat — write during upload, delete after publish

**Files:**
- Modify `agent/internal/backup/snapshot.go` (`createSnapshotWithProgress`, alongside the existing progress-keepalive goroutine at `:433-452`, and at the two successful-publish points: normal completion `:782-796` and `abortSourceGone`'s partial-publish branch `:547-566`)
- Test: `agent/internal/backup/snapshot_test.go` (new tests)

**Interfaces:**
- Produces (unexported): `refreshUploadLease(ctx context.Context, provider providers.BackupProvider, leaseKey string)`

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

In `createSnapshotWithProgress`, right after the existing progress-keepalive goroutine block (`:433-452`, the `if onProgress != nil { ... }` block), add a second, unconditional (runs regardless of `onProgress`) goroutine:
```go
	// upload.lease heartbeat (D18 §3.4): refresh a tiny marker object every
	// uploadLeaseInterval while uploading, so GC's manifest-less-prefix
	// window keeps extending for a legitimately slow multi-day single-file
	// upload. Stopped on completion (stopLeaseRefresh, called exactly once
	// via leaseStopOnce) or ctx cancellation. Skipped entirely by the
	// resume-already-published shortcut above, since that path returns
	// before this point.
	leaseKey := path.Join(prefix, "upload.lease")
	leaseStop := make(chan struct{})
	leaseDone := make(chan struct{})
	var leaseStopOnce sync.Once
	stopLeaseRefresh := func() {
		leaseStopOnce.Do(func() {
			close(leaseStop)
			<-leaseDone
		})
	}
	go func() {
		defer close(leaseDone)
		ticker := time.NewTicker(uploadLeaseInterval)
		defer ticker.Stop()
		for {
			select {
			case <-leaseStop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				refreshUploadLease(ctx, provider, leaseKey)
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
- Consumes (source-text grep only, no import): Go field tags `baseSnapshotId`/`publishLeaseExpiresAt` in `exec_backup.go`; Go `publishMargin`/`uploadLeaseInterval` in `snapshot.go`; whatever W01 names the equivalent TS constants (grepped, not imported, so this file compiles today even though those TS names don't exist yet).

- [ ] Step 1: Write the failing test — append to `backupAgentContract.test.ts`:
```ts
describe('backup Go<->TS contract — D18 server-owned base payload fields', () => {
  it('agent exec_backup.go still decodes baseSnapshotId and publishLeaseExpiresAt from the backup_run payload', () => {
    const src = readRepoFile('agent/cmd/breeze-backup/exec_backup.go');
    expect(src).toMatch(/BaseSnapshotID\s*\*string\s*`json:"baseSnapshotId"`/);
    expect(src).toMatch(/PublishLeaseExpiresAt\s*string\s*`json:"publishLeaseExpiresAt"`/);
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

  it('agent publishMargin is 1 hour and stays strictly under the manifest-less GC window', () => {
    const src = readRepoFile('agent/internal/backup/snapshot.go');
    expect(src).toMatch(/publishMargin\s*=\s*1\s*\*\s*time\.Hour/);
  });

  it('agent uploadLeaseInterval (15 min) stays well under the 9-day manifest-less GC window', () => {
    const src = readRepoFile('agent/internal/backup/snapshot.go');
    expect(src).toMatch(/uploadLeaseInterval\s*=\s*15\s*\*\s*time\.Minute/);
    // 15 minutes must be at least an order of magnitude under the 9-day
    // window (journalMaxAge 7d + 48h grace) so a slow upload has many
    // refresh opportunities before the prefix could be swept.
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    const NINE_DAYS_MS = 9 * 24 * 60 * 60 * 1000;
    expect(FIFTEEN_MIN_MS).toBeLessThan(NINE_DAYS_MS / 100);
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

`devices.backup_version` is populated from `breeze-backup --version`'s stdout (`agent/internal/heartbeat/backup_version.go:13-120`), which prints `main.version` (`agent/cmd/breeze-backup/main.go:36`), a build-time value injected via `-ldflags "-X main.version=$(VERSION)"` (`agent/Makefile:2-8`; release builds go through `agent/scripts/build-edition.sh` per the Makefile's own comment at `:4-6`). **No code in this wave sets or changes that value** — it is set by whatever release tag builds the binary that ships W03's changes. There is nothing to implement here; the release process must simply ensure the binary that carries this wave's changes is built with `VERSION` set to that release's number, so that W02's future capability gate (a `BACKUP_SERVER_BASE_MIN_HELPER_VERSION`-style constant, not yet added) can compare against it correctly. Flagged in Open Questions.

## Task 10: Wave verification

**Files:** none (verification only)

- [ ] Run the full agent backup package + breeze-backup command suite with race detection:
```
cd agent && go build ./... && go vet ./... && go test -race ./internal/backup/... ./cmd/breeze-backup/...
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
  - [ ] Notes Task 9's finding as a follow-up for whoever cuts the release that ships this wave (confirm `VERSION` at build time is the release's own version, so `devices.backup_version` reports it correctly for W02's future capability gate).

## Open questions / contradictions

1. **RESOLVED by coordinator decision (2026-09-09):** an earlier draft of this plan flagged `agent/internal/backup/snapshot.go:499`/`:544` (`abortStopped`/`abortSourceGone`'s own-run-prefix `cleanupSnapshotPrefix` calls) as candidates for removal, since the spec text available at the time named only two delete call sites. Spec §3.5 was subsequently updated to state these two are explicit, intentional exceptions ("the helper may delete objects under its own current run prefix before its manifest is published... kept as-is") — they delete only the CURRENT run's own never-yet-referenced prefix, never another snapshot's. Task 5 now keeps both call sites and the `cleanupSnapshotPrefix`/`listSnapshotPrefixItems` functions unchanged, removing only the retention-prune branch, the stale-journal cleanup call, and `DeleteSnapshot`/`DeleteSnapshotContext` (which deleted OTHER, already-published snapshots — the actually dangerous case). No further action needed.
2. **`publishLeaseExpiresAt` applying to full runs too, with no renewal, means a slow full run can outlive its lease and simply fail to publish**, exactly like a run that outlives `journalMaxAge` already fails to resume. This is explicitly the spec's stated design ("a run longer than the lease already cannot resume... so 'a run must publish within 7d of dispatch' is the existing envelope made explicit" — spec line ~130-135), not an open question about correctness, but it IS a new user-visible failure mode for slow FULL (non-incremental) backups that didn't exist before this wave (previously a full run had no deadline at all beyond the per-file/whole-run reaper timeouts). Confirming this is accepted product behavior, not something W03 should soften, is worth an explicit sign-off since it wasn't true before D18.
3. **Helper-version gating (spec §3.4's capability gate) is entirely W02's responsibility**, and its minimum-version constant does not exist yet in this worktree (confirmed via grep — only `BACKUP_QUEUE_MIN_HELPER_VERSION` exists today, for an unrelated feature). W03 has no code to write for it; Task 9 records that the mechanism it will eventually gate on (`devices.backup_version` sourced from `breeze-backup --version`, a build-time `-ldflags` value) is orthogonal to this wave's code and depends entirely on the release pipeline stamping the correct version — flagging so whoever cuts that release checks it, since there's no automated test that could catch a wrong `VERSION` at build time.
4. **`leaseGate`'s `UploadContext` fallback-to-plain-`Upload` when the wrapped provider lacks context support** silently drops `ctx` cancellation for that one call, identical to `uploadSnapshotFile`'s own pre-existing fallback behavior (`snapshot.go:869-880`) — not a regression, just noting the design intentionally mirrors an existing accepted trade-off rather than introducing a new one.
