# Backup Job Reliability & Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make backup jobs unable to hang forever — stalled uploads time out on the agent, orphaned `running` rows get reaped on the server, live progress (bytes/files/speed) streams to the UI, and Stop actually stops a server-dispatched run.

**Architecture:** Three cooperating layers. (1) Agent: thread a cancellable context through `BackupManager` runs, register `backup_run` with the helper's command canceller so `backup_stop` works, add per-file upload deadlines + HTTP transport timeouts to the S3 provider, and emit throttled `backup_progress` IPC events that the heartbeat already forwards to the server WS. (2) API: ingest the (currently dropped) `backup_progress` WS message into new `backup_jobs` progress columns, add a `reapStaleBackupJobs` sweep to the existing stale-command reaper (no-progress / device-offline / absolute-cap rules), and make the result handler tolerant of the legacy agent's bogus 10-minute "command timed out" error. (3) New agents switch `backup_run` to async ack + unsolicited final result, gated on a new `backup_run_async` server WS capability so every old/new agent×server pairing keeps working. A second wave (Tasks 11–15) adds resilience: neutralize the unsafe mtime-cutoff vestige, per-file upload retry, VSS default-on for dispatched Windows file runs, a checkpoint journal so interrupted/stopped jobs resume instead of re-uploading from zero (Stop + later run ≈ pause/resume), and a terminal-result outbox. Incremental backups (manifests referencing unchanged prior objects) are explicitly deferred to their own design.

**Tech Stack:** Go (agent + breeze-backup helper, aws-sdk-go-v2), Hono + Drizzle + BullMQ (API), React (web), Vitest + Go `testing`.

## Field-report root cause (context for implementers)

User backed up `C:\Users`; after 38 MB / 456 files network traffic stopped; job showed `running` for >1 h and survived a device reboot. Verified causes:

1. **No upload timeout.** `S3Provider.getClient` (`agent/internal/backup/providers/s3.go:226-264`) builds the SDK client with no `HTTPClient` override and the job context is `context.WithCancel(context.Background())` (`agent/internal/backup/backup.go:193`) — a mid-stream TCP stall blocks a `PutObject` indefinitely inside the serial upload loop (`agent/internal/backup/snapshot.go:118-164`).
2. **The 10-minute forward timeout abandons the wait, not the work** (`agent/internal/heartbeat/handlers_backup_forward.go:17`, `agent/internal/sessionbroker/session.go:113-153`). Worse: the helper runs `backup_run` synchronously (`agent/cmd/breeze-backup/main.go:460-473`), so any *healthy* backup >10 min sends an error result at the 10-minute mark, which consumes the one-shot dispatch expectation and falsely fails the job; the real result is later dropped as a replay.
3. **`backup_stop` cannot cancel a dispatched run.** `backup_run` builds an ephemeral manager from the payload (`managerFromBackupRunPayload`, `agent/cmd/breeze-backup/exec_backup.go:83-140`) that is never registered anywhere; `backup_stop` calls `mgr.Stop()` on the *default* (agent.yaml) manager plus `commandCanceller.cancelAll()`, and `backup_run` is never tracked by the canceller (`main.go:417-424, 476-479`). The UI Cancel button flips the DB row but the agent keeps uploading.
4. **No server-side reaper for `backup_jobs`.** `staleCommandReaper.ts` never touches the table, and `backup_run` is dispatched WS-direct (`sendCommandToAgent`, `apps/api/src/routes/agentWs.ts:2747-2764`) with no `device_commands` row to reap. A reboot mid-job orphans the row in `running` forever, which also permanently blocks manual runs (`createManualBackupJobIfIdle`, `apps/api/src/services/backupJobCreation.ts:48-98`).
5. **No progress channel for backups.** The agent WS client already emits `{type:"backup_progress"}` (`agent/internal/websocket/client.go:613-632`, used by restore), but `agentWs.ts` has **no handler** — messages are silently dropped. `backup_jobs.transferred_size` exists and is never written.

## Global Constraints

- **Compatibility matrix is sacred:** old agent + new server, new agent + old server, and mixed fleets must all keep working. New agent async behavior activates ONLY when the server's connected handshake advertises `backup_run_async` (mirror the `terminal_output_base64` capability mechanism, `apps/api/src/routes/agentWs.ts:44`).
- Migrations: `YYYY-MM-DD-<slug>.sql` in `apps/api/migrations/`, idempotent (`ADD COLUMN IF NOT EXISTS`), no inner `BEGIN;/COMMIT;`, never edit shipped migrations.
- `backup_jobs` already exists with RLS + cascade registration — this plan adds columns only; no new tables, no new RLS/cascade work.
- All reaper DB writes run inside `withSystemDbAccessContext` (existing pattern in `staleCommandReaper.ts:60-66`).
- Go: `cd agent && go test -race ./...` and `go vet ./...` green; test files alongside sources; table-driven tests.
- API: `pnpm test --filter=@breeze/api` green; test files alongside sources.
- Web: any new user-facing string needs its key in `en` **and** `es`, `fr`, `de` locale files (parity test reds main otherwise). DOM hooks via `data-testid`.
- Commit at the end of every task (small, reviewable commits).

## File Structure (created/modified)

| File | Responsibility |
|---|---|
| `agent/internal/backup/backup.go` | `RunBackupContext` (external ctx), progress fn plumbing |
| `agent/internal/backup/snapshot.go` | per-file upload deadline, progress callbacks |
| `agent/internal/backup/providers/s3.go` | HTTP transport timeouts |
| `agent/internal/backupipc/types.go` | `BackupProgress` files fields, `BackupCommandRequest.Async` |
| `agent/cmd/breeze-backup/main.go` | canceller-tracked + async `backup_run`, progress wiring |
| `agent/internal/heartbeat/backup_forwarder.go` | set `Async` flag from server capability |
| `agent/internal/websocket/client.go` | expose server capability check (if not already) |
| `apps/api/migrations/2026-07-16-backup-job-progress.sql` | new columns |
| `apps/api/src/db/schema/backup.ts` | `lastProgressAt`, `totalFiles` columns |
| `apps/api/src/routes/agentWs.ts` | `backup_progress` handler; started-ack + timed-out guards; capability |
| `apps/api/src/jobs/staleCommandReaper.ts` | `reapStaleBackupJobs` |
| `apps/api/src/routes/backup/jobs.ts` | expose progress fields in `toJobResponse` |
| `apps/web/src/components/backup/BackupJobList.tsx` | progress bar, speed, stalled chip, Stop copy |

---

### Task 1: Agent — external context + canceller tracking for `backup_run` (make Stop work)

**Files:**
- Modify: `agent/internal/backup/backup.go` (RunBackupWithExcludes, ~line 172)
- Modify: `agent/cmd/breeze-backup/main.go:459-473` (`backup_run` case in `executeCommand`)
- Test: `agent/internal/backup/backup_test.go`, `agent/cmd/breeze-backup/exec_backup_test.go`

**Interfaces:**
- Produces: `func (m *BackupManager) RunBackupContext(ctx context.Context, excludes []string) (*BackupJob, error)` — identical to `RunBackupWithExcludes` but the job context is `context.WithCancel(ctx)` so an external cancel (command canceller) aborts the run. `RunBackupWithExcludes(excludes)` delegates to `RunBackupContext(context.Background(), excludes)`.
- Consumes: `commandCanceller.track(commandID)` (already exists in `main.go`; used by `backup_restore`/`bmr_recover`).

- [ ] **Step 1: Write the failing test** in `agent/internal/backup/backup_test.go`. Use the existing fake/stub provider pattern in that file (a provider whose `UploadContext` blocks until ctx is done):

```go
func TestRunBackupContextExternalCancel(t *testing.T) {
	blocking := &blockingProvider{started: make(chan struct{})} // UploadContext: close(started) once, then <-ctx.Done(); return ctx.Err()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0644)
	mgr := NewBackupManager(BackupConfig{Provider: blocking, Paths: []string{dir}})

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := mgr.RunBackupContext(ctx, nil)
		errCh <- err
	}()
	<-blocking.started
	cancel()
	select {
	case err := <-errCh:
		if !errors.Is(err, errBackupStopped) {
			t.Fatalf("want errBackupStopped, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("backup did not unwind after external cancel")
	}
	if _, err := mgr.RunBackupContext(context.Background(), nil); errors.Is(err, errors.New("backup already running")) {
		t.Fatal("jobRunning flag not cleared after cancelled run")
	}
}
```

(If `backup_test.go` already has a blocking/stub provider, reuse it instead of adding `blockingProvider`.)

- [ ] **Step 2: Run it** — `cd agent && go test -race ./internal/backup/ -run TestRunBackupContextExternalCancel -v`. Expected: FAIL (undefined `RunBackupContext`).

- [ ] **Step 3: Implement.** In `backup.go`, rename the body of `RunBackupWithExcludes` to `RunBackupContext(ctx context.Context, excludes []string)` and change one line (`backup.go:193`):

```go
// before
ctx, cancel := context.WithCancel(context.Background())
// after (parent is the caller's ctx; nil-guard for safety)
if ctx == nil {
	ctx = context.Background()
}
runCtx, cancel := context.WithCancel(ctx)
```

(then use `runCtx` where the old `ctx` was used inside the run). Re-add the old entry point as a delegate:

```go
func (m *BackupManager) RunBackupWithExcludes(excludes []string) (*BackupJob, error) {
	return m.RunBackupContext(context.Background(), excludes)
}
```

- [ ] **Step 4: Wire the canceller.** In `main.go` `executeCommand`, `backup_run` case (line ~459):

```go
case "backup_run":
	if err := applyCommandStorageEncryption(mgr.GetProvider(), req.Payload); err != nil {
		return fail(err.Error())
	}
	excludes, err := parseBackupRunExcludes(req.Payload)
	if err != nil {
		return fail(err.Error())
	}
	ctx, cleanup := commandCanceller.track(req.CommandID)
	defer cleanup()
	result := marshalResult(mgr.RunBackupContext(ctx, excludes))
	if result.Success {
		go autoSyncToVault(result.Stdout, vaultState, conn)
	}
	return result
```

`backup_stop` (line ~476) already calls `commandCanceller.cancelAll()` — no change needed there; it now actually cancels payload-manager runs.

- [ ] **Step 5: Add an exec-level test** in `agent/cmd/breeze-backup/exec_backup_test.go` proving `backup_stop` cancels a running payload-dispatched `backup_run` (start `executeCommand` with a blocking local provider in a goroutine, then call `commandCanceller.cancelAll()`, assert the run returns a stopped/cancelled result within 10 s). Mirror the harness the file already uses for `managerFromBackupRunPayload` tests.

- [ ] **Step 6: Run** `cd agent && go test -race ./internal/backup/... ./cmd/breeze-backup/... && go vet ./...`. Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -m "fix(agent): backup_stop actually cancels server-dispatched backup_run"`

---

### Task 2: Agent — anti-stall upload timeouts (fix the hang)

**Files:**
- Modify: `agent/internal/backup/providers/s3.go` (`getClient`, ~line 226)
- Modify: `agent/internal/backup/snapshot.go` (`CreateSnapshotContext` loop, ~line 118; manifest upload ~line 182)
- Test: `agent/internal/backup/snapshot_test.go`, `agent/internal/backup/providers/s3_test.go` (if present; otherwise snapshot-level only)

**Interfaces:**
- Produces: `func uploadDeadline(size int64) time.Duration` (package `backup`, snapshot.go) — `max(5*time.Minute, size / 64KiB-per-sec)`.
- Behavior contract: a per-file deadline expiry is a **per-file failure** (recorded in `errs`, loop continues); only a cancel of the *job* context aborts the snapshot with `errBackupStopped`.

- [ ] **Step 1: Write the failing test** in `snapshot_test.go`:

```go
func TestPerFileUploadTimeoutDoesNotAbortJob(t *testing.T) {
	// stallOnceProvider: first UploadContext call blocks until ctx.Done() then
	// returns ctx.Err(); subsequent calls succeed immediately.
	p := &stallOnceProvider{}
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 1},
		{sourcePath: writeTempFile(t, "b"), snapshotPath: "b", size: 1},
	}
	restore := setUploadTimeoutFloorForTest(50 * time.Millisecond) // test seam, see Step 3
	defer restore()

	snap, err := CreateSnapshotContext(context.Background(), p, files)
	if err != nil {
		t.Fatalf("job aborted, want per-file skip: %v", err)
	}
	if len(snap.Files) != 1 {
		t.Fatalf("want 1 uploaded file (one timed out), got %d", len(snap.Files))
	}
}
```

- [ ] **Step 2: Run** `go test -race ./internal/backup/ -run TestPerFileUploadTimeout -v`. Expected: FAIL (test hangs are prevented by the deadline seam not existing → compile error).

- [ ] **Step 3: Implement in `snapshot.go`.** Add:

```go
const uploadMinThroughputBps = 64 * 1024 // deadline floor: assume ≥64 KiB/s or declare the link stalled

var uploadTimeoutFloor = 5 * time.Minute

// test seam
func setUploadTimeoutFloorForTest(d time.Duration) (restore func()) {
	old := uploadTimeoutFloor
	uploadTimeoutFloor = d
	return func() { uploadTimeoutFloor = old }
}

func uploadDeadline(size int64) time.Duration {
	d := time.Duration(size/uploadMinThroughputBps) * time.Second
	if d < uploadTimeoutFloor {
		return uploadTimeoutFloor
	}
	return d
}
```

In the `CreateSnapshotContext` loop replace the direct upload call (~line 127):

```go
attemptCtx, cancelAttempt := context.WithTimeout(ctx, uploadDeadline(file.size))
uploadErr := uploadSnapshotFile(attemptCtx, provider, file.sourcePath, backupPath)
cancelAttempt()
if errors.Is(uploadErr, errBackupStopped) && ctx.Err() == nil {
	// The per-file deadline fired, not a job cancel: skip this file, keep going.
	uploadErr = fmt.Errorf("upload stalled: no completion within %s", uploadDeadline(file.size))
}
if uploadErr != nil {
	if errors.Is(uploadErr, errBackupStopped) {
		cleanupSnapshotPrefix(provider, snapshot.ID)
		return nil, errBackupStopped
	}
	err := fmt.Errorf("failed to upload %s: %w", file.sourcePath, uploadErr)
	errs = append(errs, err)
	log.Printf("[backup] upload failed: %s: %v", file.sourcePath, err)
	continue
}
```

Apply the same attempt-ctx wrap to the manifest upload (~line 182), except a manifest timeout is fatal for the snapshot (return the error as today).

- [ ] **Step 4: Harden the S3 transport** in `s3.go` `getClient` (defense-in-depth for dial/TLS/header stalls; the mid-body stall is covered by Step 3):

```go
import (
	"net"
	"net/http"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
)

httpClient := awshttp.NewBuildableClient().
	WithDialerOptions(func(d *net.Dialer) { d.Timeout = 30 * time.Second }).
	WithTransportOptions(func(tr *http.Transport) {
		tr.TLSHandshakeTimeout = 30 * time.Second
		tr.ResponseHeaderTimeout = 2 * time.Minute
		tr.ExpectContinueTimeout = 10 * time.Second
	})
options = append(options, awscfg.WithHTTPClient(httpClient))
```

- [ ] **Step 5: Run** `cd agent && go test -race ./internal/backup/... && go vet ./...`. Expected: PASS (existing cancel tests still green — the job-cancel path is untouched).

- [ ] **Step 6: Commit** — `git commit -m "fix(agent): per-file upload deadlines + S3 transport timeouts (stalled backup hang)"`

---

### Task 3: Agent — progress emission for `backup_run`

**Files:**
- Modify: `agent/internal/backupipc/types.go:46-53` (`BackupProgress`)
- Modify: `agent/internal/backup/backup.go`, `agent/internal/backup/snapshot.go`
- Modify: `agent/cmd/breeze-backup/main.go` (`backup_run` case)
- Test: `agent/internal/backup/snapshot_test.go`

**Interfaces:**
- Produces (package `backup`): `type ProgressFn func(filesDone, filesTotal int, bytesDone, bytesTotal int64)`; `func (m *BackupManager) SetProgressFn(fn ProgressFn)`. Snapshot loop invokes it throttled (≥3 s between calls; always once after the final file).
- Produces (package `backupipc`): extended progress struct —

```go
type BackupProgress struct {
	CommandID  string `json:"commandId"`
	Phase      string `json:"phase"`
	Current    int64  `json:"current"` // bytes done (backup_run) — restore keeps its existing meaning
	Total      int64  `json:"total"`   // bytes total
	FilesDone  int    `json:"filesDone,omitempty"`
	FilesTotal int    `json:"filesTotal,omitempty"`
	Message    string `json:"message,omitempty"`
}
```

- Consumes: heartbeat forwarding already exists (`heartbeat.go:751-761` → `wsClient.SendBackupProgress` → WS `backup_progress`). No heartbeat change needed.

- [ ] **Step 1: Failing test** in `snapshot_test.go`:

```go
func TestSnapshotProgressCallback(t *testing.T) {
	p := &okProvider{} // UploadContext always succeeds
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 10},
		{sourcePath: writeTempFile(t, "b"), snapshotPath: "b", size: 20},
	}
	var got []int64
	restore := setProgressThrottleForTest(0) // emit every file in tests
	defer restore()
	_, err := createSnapshotWithProgress(context.Background(), p, files,
		func(fd, ft int, bd, bt int64) { got = append(got, bd) })
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || got[len(got)-1] != 30 {
		t.Fatalf("want final bytesDone=30, got %v", got)
	}
}
```

- [ ] **Step 2: Run** — Expected: FAIL (undefined `createSnapshotWithProgress`).

- [ ] **Step 3: Implement.** In `snapshot.go`: add `createSnapshotWithProgress(ctx, provider, files, onProgress ProgressFn)` holding today's `CreateSnapshotContext` body plus: compute `bytesTotal` (sum of `file.size`) and `filesTotal` before the loop; after each successful upload accumulate `bytesDone`/`filesDone` and invoke `onProgress` if non-nil and ≥ throttle interval since last call (package var `progressThrottle = 3 * time.Second` + `setProgressThrottleForTest` seam); one final unconditional call after the loop. `CreateSnapshotContext` delegates with `nil`. In `backup.go`: add `progressFn ProgressFn` field + `SetProgressFn` setter (guarded by `m.mu`), and pass it into the snapshot call inside `RunBackupContext`. Emit a first `phase:"scanning"` call (0/0 bytes) after the walk completes so totals reach the server before the first upload finishes.

- [ ] **Step 4: Wire the helper.** In `main.go` `backup_run` case (after Task 1's canceller wiring), before the run — mirror how `execBackupRestoreWithProgress` (`exec_backup.go:266-286`) sends progress envelopes on `conn`:

```go
mgr.SetProgressFn(func(filesDone, filesTotal int, bytesDone, bytesTotal int64) {
	sendBackupRunProgress(conn, req.CommandID, backupipc.BackupProgress{
		CommandID: req.CommandID, Phase: "uploading",
		Current: bytesDone, Total: bytesTotal,
		FilesDone: filesDone, FilesTotal: filesTotal,
	})
})
```

(`sendBackupRunProgress` = small helper using the same `conn.SendTyped(..., backupipc.TypeBackupProgress, ...)` envelope construction as the restore path; send failures are log-only.)

- [ ] **Step 5: Run** `cd agent && go test -race ./... && go vet ./...`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(agent): stream backup_run progress (bytes/files) over IPC to server WS"`

---

### Task 4: Agent — async `backup_run` gated on server capability

**Files:**
- Modify: `agent/internal/backupipc/types.go` (`BackupCommandRequest`: add `Async bool \`json:"async,omitempty"\``)
- Modify: `agent/internal/heartbeat/backup_forwarder.go`, `agent/internal/heartbeat/handlers_backup_forward.go`
- Modify: `agent/internal/websocket/client.go` (server-capability accessor, if none exists)
- Modify: `agent/cmd/breeze-backup/main.go` (`handleBackupCommand`, line ~393)
- Test: `agent/cmd/breeze-backup/main_test.go` (or the file where `handleBackupCommand` is testable), `agent/internal/heartbeat/backup_forwarder_test.go`

**Interfaces:**
- Consumes: server connected-handshake capabilities (the `terminal_output_base64` mechanism, `client.go:635` comment; API list at `agentWs.ts:44`). Add accessor `func (c *Client) HasServerCapability(name string) bool` if one doesn't already exist.
- Produces: when `Async` is set on a `backup_run` request, the helper replies to the envelope immediately with `BackupCommandResult{Success:true, Stdout:"{\"started\":true}"}` and later emits the real result as an **unsolicited** `TypeBackupResult` envelope. The heartbeat's helper-message handler (`heartbeat.go` `case backupipc.TypeBackupResult` → `wsClient.SendResult`, ~line 735-751) forwards late/unsolicited results already.

**⚠ Pre-step: verify envelope routing.** Read `agent/internal/sessionbroker/session.go:113-153` and the broker's receive loop to confirm (a) a reply matched to a waiting `SendCommand` is delivered to the waiter and NOT also forwarded to the heartbeat handler, and (b) an unsolicited `TypeBackupResult` envelope IS forwarded to the heartbeat handler. If (a) is false today (double delivery), the ack design still works — the server-side started-ack guard (Task 7) makes the duplicate a no-op — but note it in the PR.

- [ ] **Step 1: Failing helper test** — drive `handleBackupCommand` with `req.Async=true`, a fake conn recording `SendTyped` calls, and a fast local provider; assert two `TypeBackupResult` sends: first payload `{"started":true}` replying to the request envelope ID, second the real result with a fresh envelope ID.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement in `main.go`** inside `handleBackupCommand` (it already runs in a per-command goroutine, `commandLoop` line ~375):

```go
if req.CommandType == "backup_run" && req.Async {
	ack := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: `{"started":true}`}
	if err := conn.SendTyped(env.ID, backupipc.TypeBackupResult, ack); err != nil {
		slog.Error("failed to send backup ack", "commandId", req.CommandID, "error", err.Error())
	}
	result := executeCommand(req, mgr, vaultState, conn, commandCanceller)
	result.CommandID = req.CommandID
	result.DurationMs = time.Since(start).Milliseconds()
	if err := sendUnsolicitedResult(conn, result); err != nil { // fresh envelope ID, TypeBackupResult
		slog.Error("failed to send final backup result", "commandId", req.CommandID, "error", err.Error())
	}
	return
}
```

- [ ] **Step 4: Forwarder flag.** In `backup_forwarder.go` `forwardToBackupHelper`, accept an `async bool` (or read capability directly): set `req.Async = true` only when `cmd.Type == tools.CmdBackupRun && h.wsClient != nil && h.wsClient.HasServerCapability("backup_run_async")`. `handlers_backup_forward.go`: `handleBackupRun` keeps its 10-minute timeout (the ack arrives in seconds; 10 min remains the legacy-path bound when the server lacks the capability). The ack path means the CommandResult sent to the server for the command is `{"started":true}` — the server-side guard (Task 7) treats it as a progress ping, not a terminal result.

- [ ] **Step 5: Run** `cd agent && go test -race ./... && go vet ./...`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(agent): async backup_run (immediate ack + unsolicited final result) behind backup_run_async capability"`

---

### Task 5: API — schema migration for progress columns

**Files:**
- Create: `apps/api/migrations/2026-07-16-backup-job-progress.sql`
- Modify: `apps/api/src/db/schema/backup.ts` (backupJobs table, ~line 157)

**Interfaces:**
- Produces: `backupJobs.lastProgressAt` (`timestamptz`, nullable), `backupJobs.totalFiles` (`integer`, nullable). Existing `transferred_size bigint` and `file_count int` are reused for bytes-done / files-done.

- [ ] **Step 1: Migration**

```sql
-- Backup job live-progress columns (stall detection + UI progress/speed).
-- last_progress_at: set on every backup_progress WS message and on the async
-- started-ack; NULL means the agent never reported progress (legacy agent).
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS last_progress_at timestamptz;
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS total_files integer;
```

- [ ] **Step 2: Drizzle schema** — add to `backupJobs` in `apps/api/src/db/schema/backup.ts`:

```ts
lastProgressAt: timestamp('last_progress_at', { withTimezone: true }),
totalFiles: integer('total_files'),
```

- [ ] **Step 3: Verify** — `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`. Expected: no drift.

- [ ] **Step 4: Commit** — `git commit -m "feat(api): backup_jobs progress columns (last_progress_at, total_files)"`

---

### Task 6: API — ingest `backup_progress` WS messages

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts` (message dispatch switch; near the backup-result handling ~line 1317)
- Modify: the module exporting `recordDispatchedExpectation`/`consumeDispatchedExpectation` (locate: `grep -rn "export async function recordDispatchedExpectation" apps/api/src`) — add `refreshDispatchedExpectation`
- Test: sibling test file of the expectation module; `apps/api/src/routes/agentWs` has limited unit coverage — put handler-logic tests in `apps/api/src/services/backupProgress.test.ts` by extracting the handler core into `apps/api/src/services/backupProgress.ts`

**Interfaces:**
- Produces: `export async function applyBackupProgress(params: { agentId: string; commandId: string; progress: { phase?: string; current?: number; total?: number; filesDone?: number; filesTotal?: number } }): Promise<{ applied: boolean; reason?: string }>` in `services/backupProgress.ts`. `agentWs.ts` calls it from a new `case 'backup_progress':` (payload shape from `agent/internal/websocket/client.go:613-632`: `{type, commandId, progress}`).
- Behavior: look up the job by `id = commandId` joined to `devices` and require `devices.agentId === agentId` (mirror the result handler's ownership check, `agentWs.ts:1318-1329`); UPDATE guarded by `inArray(status, ['pending','running'])` setting `transferredSize: progress.current`, `totalSize: progress.total || keep` (only set when > 0 — `sql\`COALESCE(NULLIF(${val}, 0), total_size)\`` or conditional set), `fileCount: progress.filesDone`, `totalFiles: progress.filesTotal`, `lastProgressAt: now`, `updatedAt: now`; then `refreshDispatchedExpectation('backup', deviceId, jobId)` so a multi-hour backup's final result isn't dropped by the 30-min expectation TTL. Zod-validate the progress payload; drop (log-debug, no throw) on validation failure, unknown job, agent mismatch, or terminal status. **Do not** route restore progress differently than today — key only on backup_jobs rows; a `commandId` that matches no backup job is ignored (restore progress continues to be handled/dropped exactly as before this change).

- [ ] **Step 1: Failing tests** in `services/backupProgress.test.ts` (Drizzle mock pattern per `breeze-testing` skill): running job + owning agent → applied, fields set; wrong agent → `{applied:false, reason:'agent-mismatch'}`; terminal job → not applied; `total: 0` does not clobber an existing `totalSize`.
- [ ] **Step 2: Run** `pnpm test --filter=@breeze/api -- backupProgress`. Expected: FAIL.
- [ ] **Step 3: Implement** `services/backupProgress.ts` + the `agentWs.ts` case + `refreshDispatchedExpectation` (Redis `PEXPIRE` on the existing expectation key iff it exists; return boolean; same key-derivation helper as `consumeDispatchedExpectation`).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): ingest agent backup_progress into backup_jobs (bytes/files/last_progress_at)"`

---

### Task 7: API — non-terminal result guards + capability advertisement

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts` — `AGENT_WS_CAPABILITIES` (line 44) and the backup-result block (lines ~1317-1345)
- Test: extend `apps/api/src/services/backupProgress.test.ts` or the existing backup-result persistence tests (`grep -rn "applyBackupCommandResultToJob" apps/api/src --include=*.test.ts`)

**Interfaces:**
- Produces: `AGENT_WS_CAPABILITIES = ['terminal_output_base64', 'backup_run_async']`.
- Behavior (order matters — BOTH guards run **before** `consumeDispatchedExpectation`, which is one-shot):
  1. **Started-ack guard:** parse `result.result ?? result.stdout` (string → JSON.parse, tolerate failure); if it is `{ started: true }`, treat as a progress ping: set `lastProgressAt`/`updatedAt` on the (pending|running) job, refresh the dispatch expectation TTL, `return` without consuming the expectation or touching status.
  2. **Legacy timed-out guard:** if `result.status !== 'completed'` and `/command timed out/i.test(result.error ?? result.stderr ?? '')`, log and `return` without consuming the expectation and without failing the job. Rationale: old agents' `forwardToBackupHelper` emits this at exactly 10 minutes while the helper is still uploading (`sessionbroker/session.go` `time.After` wait); today it falsely fails every >10-min backup and burns the expectation so the real result is dropped as a replay. The Task 8 reaper now owns deciding when a silent job is dead.

- [ ] **Step 1: Failing tests** — started-ack leaves status `running` + sets `lastProgressAt` + expectation NOT consumed; timed-out error result leaves status `running` + expectation NOT consumed; a genuine failure result (non-timeout error) still fails the job; a completed result still completes it.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the two guards + capability constant. Keep the guards in the extracted service if that keeps `agentWs.ts` thin.
- [ ] **Step 4: Run tests + `pnpm test --filter=@breeze/api`.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "fix(api): backup results — started-ack + agent-timeout are non-terminal; advertise backup_run_async"`

---

### Task 8: API — `reapStaleBackupJobs` (orphan/stall reconciliation)

**Files:**
- Modify: `apps/api/src/jobs/staleCommandReaper.ts` (add reap function; register it in the worker's process step alongside `reapStaleDeviceCommands` etc.)
- Test: `apps/api/src/jobs/staleCommandReaper.test.ts` (extend existing suite; check `ls apps/api/src/jobs/*.test.ts` and follow its mock pattern)

**Interfaces:**
- Consumes: `queueBackupStopCommand(deviceId, { userId? })` from `apps/api/src/services/commandQueue.ts:587` (already exported; used by the cancel endpoint at `routes/backup/jobs.ts:616-628`).
- Produces: `export async function reapStaleBackupJobs(): Promise<number>` returning rows reaped; wired into the reaper job (runs every 2 min, inside `withSystemDbAccessContext`).

**Rules (constants at top of file, env-tunable like `STALE_REAPER_MAX_PER_RUN`):**

```ts
const BACKUP_STALL_TIMEOUT_MS = 15 * 60 * 1000;      // progress-capable agent went silent
const BACKUP_OFFLINE_GRACE_MS = 10 * 60 * 1000;      // device offline mid-job (covers reboot)
const BACKUP_ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // legacy agents: no progress signal exists
const BACKUP_PENDING_TIMEOUT_MS = 60 * 60 * 1000;    // dispatch enqueued but never flipped/failed
```

A `running` job is reaped when ANY of:
- **A (stall):** `lastProgressAt IS NOT NULL AND lastProgressAt < now - STALL` → error `'Backup stalled: no progress reported for 15 minutes'`;
- **B (offline):** device offline (join `devices`, use the same offline predicate `offlineDetector.ts` uses — read that file and reuse its status/lastSeen condition) `AND coalesce(lastProgressAt, startedAt) < now - OFFLINE_GRACE` → error `'Device went offline during backup'`;
- **C (absolute):** `lastProgressAt IS NULL AND startedAt < now - ABSOLUTE` → error `'Backup timed out (no completion after 24h)'`.

A `pending` job is reaped when `createdAt < now - PENDING_TIMEOUT` → error `'Backup dispatch never completed'`.

Per reaped `running` job on an **online** device: best-effort `queueBackupStopCommand(deviceId, {})` (catch + warn, exactly like `routes/backup/jobs.ts:616-628`) so a live-but-silent agent stops uploading. UPDATE must be guarded `inArray(status, ['pending','running'])`, set `status:'failed'`, `completedAt`, `updatedAt`, `errorLog` (append if existing). Cap per run with `MAX_REAP_PER_RUN`. Log one summary line per run when count > 0.

- [ ] **Step 1: Failing tests** (mock db per existing reaper tests): each rule A–C fires; healthy running job with recent progress NOT reaped; recent legacy job (no progress, 2h old, device online) NOT reaped; pending <1h NOT reaped; stop command queued for online device only; terminal-status guard (concurrent completion wins).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement + register** in the reaper worker processor.
- [ ] **Step 4: Run** `pnpm test --filter=@breeze/api`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): reap stalled/orphaned backup jobs (stall, offline, absolute-cap, stuck-pending)"`

---

### Task 9: Web — live progress, network speed, stalled indicator

**Files:**
- Modify: `apps/api/src/routes/backup/jobs.ts` (`toJobResponse`, ~line 649: add `transferredSize`, `totalFiles`, `lastProgressAt`)
- Modify: `apps/web/src/components/backup/BackupJobList.tsx`
- Modify: locale files — add every new key to `en` + `es` + `fr` + `de` (find them: `grep -rln '"backup' apps/web/src/i18n* apps/web/src/locales 2>/dev/null` or wherever existing BackupJobList keys live)
- Test: `apps/web/src/components/backup/BackupJobList.test.tsx` (extend existing)

**Interfaces:**
- Consumes: job response now carries `transferredSize` (bytes done), `totalSize` (bytes total once first progress arrives), `fileCount`/`totalFiles`, `lastProgressAt`.
- Produces (running rows only):
  - **Progress bar + percent** when `totalSize > 0`: `Math.min(100, transferredSize/totalSize*100)`; indeterminate bar when totals unknown (legacy agent).
  - **Files counter** `fileCount/totalFiles` when both present.
  - **Network speed**: compute client-side from consecutive poll samples — keep a `useRef<Map<jobId, {bytes: number, at: number}>>`; on each render with fresh data, `bps = (transferredSize - prev.bytes) / ((now - prev.at)/1000)` when positive; format with the component's existing byte formatter + `/s`. Fall back to average `transferredSize / elapsedSec` when no prior sample.
  - **Stalled chip**: when `lastProgressAt` present and `now - lastProgressAt > 2 min`, render an amber "Stalled" badge (`data-testid="backup-job-stalled"`) with tooltip copy "No data received for {minutes} minutes".
  - Rename the running-job action button label from "Cancel" to "Stop" (it stops the run on the device; keep the confirm dialog and `handleCancel` wiring, `BackupJobList.tsx:201-221, 422-435`). Update its `data-testid` only if tests require.
- Mutation feedback: `handleCancel` already uses the component's request pattern — do not regress `runAction` conventions if it uses them.

- [ ] **Step 1: Failing tests** — running job with progress fields renders percent + files + speed after two data refreshes; stalled badge appears when `lastProgressAt` is 5 min old; legacy job (null progress fields) renders the current spinner-only state (no NaN/Infinity).
- [ ] **Step 2: Run** `pnpm test --filter=@breeze/web -- BackupJobList`. Expected: FAIL.
- [ ] **Step 3: Implement** API response fields + component changes + all four locale files.
- [ ] **Step 4: Run web tests + `pnpm test --filter=@breeze/api`** (toJobResponse tests). Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): backup job live progress, transfer speed, stalled indicator; Cancel→Stop"`

---

### Task 10: Deferred items — file follow-up issues (do not implement)

**Files:** none (gh CLI only). Execute LAST (after Tasks 11–15, which absorbed several formerly-deferred items).

- [ ] **Step 1:** File GitHub issues (follow the `github-issues` skill conventions; no tenant identifiers):
  1. **Incremental backups** — every run re-uploads every file today. The vestigial mtime-cutoff (`shouldIncludeFile`, removed by Task 11) was unsafe: a cutoff-filtered snapshot is an incomplete restore point. Proper design: snapshot manifests referencing unchanged objects from prior snapshots ("synthetic full"), with retention/GFS, verify, storage accounting, and legal-hold made reference-aware. Note that Task 14's journal + the manifest's per-file `size/modTime/checksum` are the substrate. This gets a dedicated brainstorm + plan doc.
  2. **First-class Pause button** — Task 14 makes Stop preserve the checkpoint journal, so Stop + a later run resumes where it left off (pause in effect). A dedicated Pause/Resume UI affordance (distinct status, resume button, no reaper interference) is follow-up polish.
- [ ] **Step 2:** Cross-link the issues to this plan doc and to the shipping PR(s).

---

## Wave 2 — Resilience & hardening (Tasks 11–15)

Execution order note: run Tasks 11–13 after Task 4 (all touch the agent), Task 14 after Tasks 2–3 (it reshapes the snapshot loop they touch), Task 15 anytime after Task 4. API Tasks 5–8 and web Task 9 are independent of Wave 2 except where noted.

### Task 11: Agent — remove the unsafe mtime-cutoff (every snapshot a complete restore point)

**Files:**
- Modify: `agent/internal/backup/backup.go` (`lastSnapshotTime` field ~line 92, `cutoff` at ~296, `collectBackupFiles` ~379, `shouldIncludeFile` ~499, the `lastSnapshotTime` update ~353)
- Test: `agent/internal/backup/backup_test.go`

**Why:** `cutoff := m.lastSnapshotTime` filters the walk to files modified since the previous in-process run. For server-dispatched runs the manager is fresh each command so cutoff is always zero (full upload — no behavior change from this task). But a long-lived locally-configured manager produces a second snapshot containing ONLY recently-modified files — an incomplete restore point that looks complete. Remove the mechanism until real incremental (manifest-referencing) ships.

- [ ] **Step 1: Failing test:** two consecutive `RunBackupContext` calls on the same manager with an unmodified source dir — assert the second snapshot contains the same file count as the first (today it would be skipped/empty).
- [ ] **Step 2: Run** `go test -race ./internal/backup/ -run <name> -v`. Expected: FAIL.
- [ ] **Step 3: Implement:** delete `lastSnapshotTime`, the `cutoff` variable (pass `time.Time{}` or drop the parameter through `collectBackupFilesFromPaths`/`collectBackupFiles`), the update at ~353, and `shouldIncludeFile`'s cutoff branch (keep the `IsRegular` check). Grep for other `cutoff`/`lastSnapshotTime` references (`grep -rn "cutoff\|lastSnapshotTime" agent/internal/backup/`) and remove them all.
- [ ] **Step 4: Run** `go test -race ./internal/backup/... && go vet ./...`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "fix(agent): remove mtime-cutoff snapshot filter (incomplete restore points)"`

### Task 12: Agent — per-file upload retry with backoff

**Files:**
- Modify: `agent/internal/backup/snapshot.go` (the per-file attempt block Task 2 added)
- Test: `agent/internal/backup/snapshot_test.go`

**Interfaces:** package-level `var uploadRetryDelay = 30 * time.Second` + `setUploadRetryDelayForTest` seam (mirror Task 2's floor seam). Retry policy: exactly ONE retry per file, only when the first attempt failed with a non-cancel error (including the per-file deadline conversion); job-context cancel is never retried.

- [ ] **Step 1: Failing test:** `failOnceProvider` (first `UploadContext` per key returns an error, second succeeds) with retry delay 0 → snapshot contains the file, no entry in `errs`. Second test: job ctx cancelled during first attempt → no retry, returns `errBackupStopped`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement:** wrap Task 2's attempt block in a 2-iteration loop: on failure, if `ctx.Err() != nil` break (job cancel); otherwise `select { case <-ctx.Done(): ... case <-time.After(uploadRetryDelay): }` then retry with a fresh attempt ctx/deadline. Record the error only after the final attempt fails.
- [ ] **Step 4: Run** `go test -race ./internal/backup/...`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): retry failed backup file uploads once with backoff"`

### Task 13: Agent — VSS default-on for server-dispatched Windows file backups

**Files:**
- Modify: `agent/cmd/breeze-backup/exec_backup.go` (`managerFromBackupRunPayload`, ~line 83)
- Test: `agent/cmd/breeze-backup/exec_backup_test.go` (extend the existing payload table tests)

**Interfaces:** payload gains optional `vss *bool` (`json:"vss,omitempty"` in the anonymous parse struct). Effective value: `p.Vss != nil ? *p.Vss : (runtime.GOOS == "windows" && !p.SystemImage)`. Set `VSSEnabled` in BOTH `BackupConfig` constructions (system_image path keeps `false` unless payload overrides — system-state collection manages its own consistency). VSS failure is already non-fatal (`backup.go:234-235` proceeds without VSS), so this cannot break Linux/macOS (GOOS gate) or Windows hosts without VSS. The API's `backupWorker.ts` does not need to send the field (future policy toggle can); document the payload field in a comment referencing `backupWorker.ts` like the existing `backupRunProviderConfig` comment does.

- [ ] **Step 1: Failing table tests:** payload with `"vss": true` → `VSSEnabled` true on any OS; `"vss": false` → false; absent → `runtime.GOOS == "windows"` for file mode, `false` for `systemImage:true`. (Expose via a getter or check the config through an exported accessor — `GetSystemStateEnabled` at `backup.go:127` is the precedent; add `GetVSSEnabled()`.)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd agent && go test -race ./cmd/breeze-backup/... && go vet ./...`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): enable VSS by default for dispatched Windows file backups (locked-file fidelity)"`

### Task 14: Agent — checkpoint journal: interrupted/stopped backups resume

**Files:**
- Create: `agent/internal/backup/journal.go`, `agent/internal/backup/journal_test.go`
- Modify: `agent/internal/backup/snapshot.go`, `agent/internal/backup/backup.go`
- Test: `agent/internal/backup/snapshot_test.go` (resume scenarios)

**Design (server-transparent — no API/protocol changes):**
- Journal file per destination identity: `filepath.Join(journalDir, "backup-journal-"+identityHash+".jsonl")` where `identityHash = sha256(provider-kind | endpoint | bucket | paths-in-config-order)[:16]` — **deviation from the original "sorted paths" wording, adopted during execution:** object naming is positional (`path_%d`), so an order-insensitive identity let a path reorder resume into the same prefix with swapped root indices (wrong-content manifest mapping, found in review). Order-sensitive identity makes a reorder start fresh instead. and `journalDir` comes from `resolveJournalDir` (`mgr.GetStagingDir()`) — **deviation from the original "falling back to `os.TempDir()`" wording, adopted during execution:** the final code deliberately has NO `os.TempDir()` fallback. A world-writable temp dir would let any local user plant or tamper with a resume journal (checkpoint state the agent trusts for 7 days without re-verifying remote objects), so `resolveJournalDir` refuses it and the backup runs without a journal rather than journaling into an untrusted location (security fix, found in review). First line: header `{"snapshotId": "...", "createdAt": "...", "identity": "..."}`; subsequent lines: one JSON `SnapshotFile` per successfully uploaded file.
- **Write path:** `createSnapshotWithProgress` appends each `SnapshotFile` line right after its successful upload (buffered writer, `Sync` per line is overkill — flush per file). On manifest-upload success: delete the journal.
- **Resume path:** at snapshot start, if a journal with matching identity exists and `createdAt` < 7 days old: reuse its `snapshotId` (skip `newSnapshotID`), load entries into a `map[sourcePath]SnapshotFile`, and for each walked file whose `(size, modTime)` equals the journal entry: skip the upload, append the journal entry to `snapshot.Files`, and count its bytes as already-done in the progress callback (`bytesDone` starts at the resumed sum — the UI shows an instant jump, which is correct). Files that changed since the journal entry are re-uploaded (same backupPath key → object overwritten, journal line superseded by appending the new entry; last-entry-wins on load).
- **Stale journal:** identity matches but >7 days old → best-effort `cleanupSnapshotPrefix(provider, journal.snapshotId)` + delete journal, then proceed fresh.
- **Stop semantics change:** `CreateSnapshotContext`'s `errBackupStopped` paths NO LONGER call `cleanupSnapshotPrefix` when a journal is active — the partial prefix + journal are the resume state. (This flips Task 2's manifest-timeout fatal path too: keep the journal on failure.) The reaper/cancel flow on the server is unchanged: the next scheduled or manual job simply resumes agent-side.
- **Corrupt journal:** any parse error → log, delete journal, proceed fresh (never fail a backup because of its checkpoint).

**Interfaces (journal.go):**

```go
type snapshotJournal struct { /* file handle, path, snapshotID, entries map[string]SnapshotFile */ }
func openSnapshotJournal(dir, identity string, maxAge time.Duration) (*snapshotJournal, bool /*resumed*/, error)
func (j *snapshotJournal) Record(f SnapshotFile) error      // append one line
func (j *snapshotJournal) Lookup(sourcePath string, size int64, modTime time.Time) (SnapshotFile, bool)
func (j *snapshotJournal) ResumedBytes() int64
func (j *snapshotJournal) Complete() error                  // manifest uploaded: close + remove file
func (j *snapshotJournal) Abandon()                         // close, KEEP file (stop/failure)
```

- [ ] **Step 1: Failing journal unit tests** (`journal_test.go`): round-trip (record N entries, reopen, lookup hits with matching size/modTime, miss on changed size); last-entry-wins for a re-recorded path; corrupt line → open returns fresh (no resume); stale header (>maxAge) → no resume.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement journal.go.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Failing integration-style test** (`snapshot_test.go`): run snapshot with a provider that fails after uploading 2 of 4 files (via cancel or injected error) → journal retained; run again with a `recordingProvider` → exactly the 2 missing files are uploaded, final snapshot manifest lists all 4, snapshot ID matches run 1.
- [ ] **Step 6: Run.** Expected: FAIL. **Step 7: Wire into `createSnapshotWithProgress`/`RunBackupContext`** per the design above (manager passes `journalDir` + identity computed from its provider config; add an accessor on the provider or pass identity material through `BackupConfig`). **Step 8: Run full agent suite** `go test -race ./... && go vet ./...`. Expected: PASS.
- [ ] **Step 9: Commit** — `git commit -m "feat(agent): checkpoint journal — interrupted/stopped backups resume instead of restarting"`

### Task 15: Agent — terminal-result outbox (backup results survive WS blips)

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (the `case backupipc.TypeBackupResult:` forward, ~line 735-751)
- Create: `agent/internal/heartbeat/backup_result_outbox.go`, `agent/internal/heartbeat/backup_result_outbox_test.go`

**Interfaces:**
- `newBackupResultOutbox(dir string) *backupResultOutbox` (dir: the agent's existing data/config dir — find the pattern other persisted state uses: `grep -rn "os.UserConfigDir\|dataDir\|configDir" agent/internal/heartbeat/ agent/internal/config/ | head`).
- `(o *backupResultOutbox) Enqueue(result tools.CommandResult)` — persist JSON file `outbox/<commandId>.json`; cap: max 20 pending, max age 48 h (evict oldest/expired on enqueue).
- `(o *backupResultOutbox) Flush(send func(tools.CommandResult) error)` — attempt each pending file; delete on success; called on WS (re)connect (find the reconnect hook: wherever `wsClient` signals connected — the capability-handshake handling from Task 4 is a good anchor).
- Behavior: in the `TypeBackupResult` forward, `SendResult` failure → `Enqueue` instead of log-and-drop. Do NOT outbox progress messages (ephemeral by design). Server side already handles late results (expectation TTL + terminal-status guard make a too-late flush a harmless drop).

- [ ] **Step 1: Failing tests:** enqueue + flush round-trip (send succeeds → file removed); send fails → file retained for next flush; cap eviction (21st enqueue evicts oldest); expired entries skipped + removed.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement + wire** (enqueue on send failure; flush on reconnect). **Step 4: Run** `cd agent && go test -race ./internal/heartbeat/... && go vet ./...`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): persist undeliverable backup results and flush on reconnect"`

---

## Verification (end-to-end, after all tasks)

1. `cd agent && go test -race ./... && go vet ./...`; `pnpm test --filter=@breeze/api --filter=@breeze/web`; `pnpm db:check-drift`.
2. Live rig (worktree-stack or dev compose): dispatch a file backup ≥ a few hundred MB against MinIO/S3 → UI shows advancing bytes/percent/speed; press **Stop** mid-run → job → `cancelled` within seconds and agent-side upload halts (agent log shows stop); snapshot prefix cleaned.
3. Stall simulation: `iptables`/pf-block the S3 endpoint mid-run (or use a toxiproxy) → per-file deadline fires, job continues past the stalled file or, when everything stalls, the reaper fails the job within ~15 min and the UI shows the stall error.
4. Reboot simulation: kill the device VM mid-backup → job → `failed: Device went offline during backup` within ~12 min; next manual run is no longer blocked.
5. Legacy-agent check: run a pre-change agent build against the new server → >10-min backup no longer flips to failed at 10:00 (timed-out guard), completes when the late unsolicited result arrives or is reaped per rule C.
6. Resume check (Task 14): Stop a run at ~50%, run again → journal resume; bytes counter starts near 50%, only the remaining files upload (verify object count in bucket), final snapshot verifies clean via the existing integrity check.

## Self-review notes

- Type/name consistency verified across tasks: `RunBackupContext` (T1→T3/T4), `ProgressFn`/`SetProgressFn` (T3→T4), `lastProgressAt`/`totalFiles` (T5→T6/T8/T9), `backup_run_async` (T4↔T7), `refreshDispatchedExpectation` (T6↔T7).
- Ordering: T5 (columns) must land before T6–T9; T7's started-ack guard must ship in the same release as (or before) T4's agent behavior — the capability gate enforces this at runtime regardless of deploy order.
- Old-agent regression risk: T7's timed-out guard changes failure timing for >10-min legacy backups from "false-fail at 10 min" to "reaped by rule C at 24 h or completed by late result". This is intentional; rule B (offline) covers the common dead-device case much sooner.
