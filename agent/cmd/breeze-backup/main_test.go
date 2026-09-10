package main

import (
	"encoding/json"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// backupRunTestPayload builds a backup_run command payload that drives a
// real (fast, local-provider) backup, so handleBackupCommand exercises the
// full executeCommand -> mgr.RunBackupContext path rather than a stub.
func backupRunTestPayload(t *testing.T) json.RawMessage {
	t.Helper()

	srcDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(srcDir, "hello.txt"), []byte("hello world"), 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	destDir := t.TempDir()

	payload, err := json.Marshal(map[string]any{
		"provider": "local",
		"providerConfig": map[string]any{
			"path": destDir,
		},
		"paths": []string{srcDir},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return payload
}

type recvResult struct {
	env *ipc.Envelope
	err error
}

// startEnvelopeReader continuously reads envelopes off conn into a channel,
// concurrently with the writer under test. handleBackupCommand's progress
// callback (SetProgressFn) sends TypeBackupProgress envelopes on the same
// conn interleaved with the result(s) we care about; net.Pipe is unbuffered
// and synchronous, so a reader that only drains after the writer finishes
// would deadlock the writer on the first progress send. Reads stop (channel
// closed) on the first error, e.g. EOF once the peer closes.
func startEnvelopeReader(conn *ipc.Conn) <-chan recvResult {
	ch := make(chan recvResult, 16)
	go func() {
		defer close(ch)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			env, err := conn.Recv()
			ch <- recvResult{env, err}
			if err != nil {
				return
			}
		}
	}()
	return ch
}

// nextBackupResult drains envelopes from ch until it finds one of type
// backup_result (silently skipping backup_progress and any other type),
// failing the test if none arrives within the timeout.
func nextBackupResult(t *testing.T, ch <-chan recvResult) *ipc.Envelope {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case r := <-ch:
			if r.err != nil {
				t.Fatalf("recv envelope: %v", r.err)
			}
			if r.env.Type == backupipc.TypeBackupResult {
				return r.env
			}
			// drain progress (or any other) envelopes and keep waiting
		case <-deadline:
			t.Fatal("timed out waiting for a backup_result envelope")
		}
	}
}

// #3006: the snapshot id must actually reach the WIRE, not just the in-process
// ProgressFn. This exercises the whole hop the fix depends on —
// createSnapshotWithProgress -> ProgressFn -> the SetProgressFn closure in
// executeCommand -> backupipc.BackupProgress -> a real IPC envelope — and pins
// it to the snapshot id the terminal result reports, which is what the server
// keys the restore point on. Without this, deleting `SnapshotID: snapshotID`
// from the closure makes Part 1 a silent no-op with every other test green.
func TestHandleBackupCommand_BackupRunProgressCarriesSnapshotID(t *testing.T) {
	provider := providers.NewLocalProvider(t.TempDir())
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider})

	agentSide, helperSide := net.Pipe()
	defer func() { _ = agentSide.Close() }()
	defer func() { _ = helperSide.Close() }()

	agentConn := ipc.NewConn(agentSide)
	helperConn := ipc.NewConn(helperSide)

	req := backupipc.BackupCommandRequest{
		CommandID:   "progress-snapshot-id-cmd",
		CommandType: "backup_run",
		Payload:     backupRunTestPayload(t),
		Async:       true,
	}
	reqPayload, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	env := &ipc.Envelope{ID: req.CommandID, Type: backupipc.TypeBackupCommand, Payload: reqPayload}

	ch := startEnvelopeReader(agentConn)
	done := make(chan struct{})
	go func() {
		defer close(done)
		handleBackupCommand(helperConn, env, mgr, nil, newActiveCommandCanceller())
	}()

	// Collect every envelope until the terminal result arrives, keeping the
	// progress frames this time instead of discarding them.
	var progressSnapshotIDs []string
	var finalResult backupipc.BackupCommandResult
	deadline := time.After(10 * time.Second)
collect:
	for {
		select {
		case r := <-ch:
			if r.err != nil {
				t.Fatalf("recv envelope: %v", r.err)
			}
			switch r.env.Type {
			case backupipc.TypeBackupProgress:
				var progress backupipc.BackupProgress
				if err := json.Unmarshal(r.env.Payload, &progress); err != nil {
					t.Fatalf("unmarshal progress: %v", err)
				}
				if progress.SnapshotID != "" {
					progressSnapshotIDs = append(progressSnapshotIDs, progress.SnapshotID)
				}
			case backupipc.TypeBackupResult:
				var res backupipc.BackupCommandResult
				if err := json.Unmarshal(r.env.Payload, &res); err != nil {
					t.Fatalf("unmarshal result: %v", err)
				}
				// Skip the immediate {"started":true} ack.
				if res.Stdout == `{"started":true}` {
					continue
				}
				finalResult = res
				break collect
			}
		case <-deadline:
			t.Fatal("timed out waiting for the terminal backup_result envelope")
		}
	}
	<-done

	if len(progressSnapshotIDs) == 0 {
		t.Fatal("no backup_progress envelope carried a snapshotId — the mid-run registration never reached the wire")
	}

	var job backup.BackupJob
	if err := json.Unmarshal([]byte(finalResult.Stdout), &job); err != nil {
		t.Fatalf("unmarshal backup job from result stdout: %v", err)
	}
	if job.Snapshot == nil || job.Snapshot.ID == "" {
		t.Fatalf("terminal result carried no snapshot: %+v", job)
	}
	for i, id := range progressSnapshotIDs {
		if id != job.Snapshot.ID {
			t.Fatalf("progress emission %d reported snapshotId %q, but the run produced %q",
				i, id, job.Snapshot.ID)
		}
	}
}

func TestHandleBackupCommand_AsyncBackupRunSendsAckThenUnsolicitedResult(t *testing.T) {
	provider := providers.NewLocalProvider(t.TempDir())
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider})

	agentSide, helperSide := net.Pipe()
	defer func() { _ = agentSide.Close() }()
	defer func() { _ = helperSide.Close() }()

	agentConn := ipc.NewConn(agentSide)
	helperConn := ipc.NewConn(helperSide)

	req := backupipc.BackupCommandRequest{
		CommandID:   "async-test-cmd",
		CommandType: "backup_run",
		Payload:     backupRunTestPayload(t),
		Async:       true,
	}
	reqPayload, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	env := &ipc.Envelope{ID: "async-test-cmd", Type: backupipc.TypeBackupCommand, Payload: reqPayload}

	ch := startEnvelopeReader(agentConn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleBackupCommand(helperConn, env, mgr, nil, newActiveCommandCanceller())
	}()

	// First backup_result envelope: the immediate ack, replying to the
	// request's own envelope ID (must match so the waiting SendCommand on the
	// real broker side is the one that receives it, per session.go's
	// HandleResponse ID match).
	ackEnv := nextBackupResult(t, ch)
	if ackEnv.ID != env.ID {
		t.Fatalf("ack envelope ID = %q, want %q", ackEnv.ID, env.ID)
	}
	var ack backupipc.BackupCommandResult
	if err := json.Unmarshal(ackEnv.Payload, &ack); err != nil {
		t.Fatalf("unmarshal ack: %v", err)
	}
	if !ack.Success || ack.Stdout != `{"started":true}` {
		t.Fatalf("ack = %+v, want Success=true Stdout={\"started\":true}", ack)
	}

	// Second backup_result envelope: the real result, unsolicited (fresh
	// envelope ID, distinct from the request/ack ID so it does NOT match the
	// (already-cleared) pending entry and instead falls through the broker's
	// dispatchHelperMessage to the heartbeat's unsolicited-result handler),
	// carrying the real job's CommandID.
	finalEnv := nextBackupResult(t, ch)
	if finalEnv.ID == env.ID {
		t.Fatalf("final envelope ID = %q, expected a fresh ID distinct from the request/ack ID", finalEnv.ID)
	}
	var final backupipc.BackupCommandResult
	if err := json.Unmarshal(finalEnv.Payload, &final); err != nil {
		t.Fatalf("unmarshal final result: %v", err)
	}
	if final.CommandID != "async-test-cmd" {
		t.Fatalf("final result CommandID = %q, want %q", final.CommandID, "async-test-cmd")
	}
	if !final.Success {
		t.Fatalf("expected backup to succeed, got stderr %q", final.Stderr)
	}
	// DurationMs is only checked for sanity here, NOT for a positive lower
	// bound: this backup copies one 11-byte file to a local temp dir and
	// legitimately completes in under a millisecond, and DurationMs is
	// time.Since(start).Milliseconds(), which truncates — so 0 is a correct
	// result, not a bug. Asserting > 0 here made this test red at random on
	// fast CI runners (same flake class as the script runner's, PR #2464).
	// The real timing teeth live in
	// TestHandleBackupCommand_AsyncResultDurationTracksElapsed below.
	if final.DurationMs < 0 {
		t.Fatalf("expected a non-negative DurationMs on the final result, got %d", final.DurationMs)
	}

	<-done
}

// TestHandleBackupCommand_SyncBackupRunSendsExactlyOneReply is the
// server-compat regression: when Async is not set, behavior must be
// byte-identical to today — exactly one reply (matching the request
// envelope ID), and never a second, unsolicited backup_result. An old
// server would parse a stray ack as a malformed terminal result.
func TestHandleBackupCommand_SyncBackupRunSendsExactlyOneReply(t *testing.T) {
	provider := providers.NewLocalProvider(t.TempDir())
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider})

	agentSide, helperSide := net.Pipe()
	defer func() { _ = agentSide.Close() }()

	agentConn := ipc.NewConn(agentSide)
	helperConn := ipc.NewConn(helperSide)

	req := backupipc.BackupCommandRequest{
		CommandID:   "sync-test-cmd",
		CommandType: "backup_run",
		Payload:     backupRunTestPayload(t),
		Async:       false,
	}
	reqPayload, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	env := &ipc.Envelope{ID: "sync-test-cmd", Type: backupipc.TypeBackupCommand, Payload: reqPayload}

	ch := startEnvelopeReader(agentConn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleBackupCommand(helperConn, env, mgr, nil, newActiveCommandCanceller())
		_ = helperSide.Close()
	}()

	replyEnv := nextBackupResult(t, ch)
	if replyEnv.ID != env.ID {
		t.Fatalf("reply envelope ID = %q, want %q", replyEnv.ID, env.ID)
	}
	var result backupipc.BackupCommandResult
	if err := json.Unmarshal(replyEnv.Payload, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if !result.Success || result.Stdout == `{"started":true}` {
		t.Fatalf("sync result = %+v, expected the real terminal result, not an async ack", result)
	}
	if result.CommandID != "sync-test-cmd" {
		t.Fatalf("result CommandID = %q, want %q", result.CommandID, "sync-test-cmd")
	}

	<-done

	// Drain whatever's left: only progress envelopes (if any) are allowed.
	// Seeing a second backup_result, or any read succeeding after the
	// helper side closed without EOF, would mean an unsolicited send leaked
	// through on the compat (non-async) path.
	for r := range ch {
		if r.err != nil {
			return // EOF/closed pipe: expected, nothing more was sent
		}
		if r.env.Type == backupipc.TypeBackupResult {
			t.Fatalf("unexpected second backup_result envelope on the sync path: %+v", r.env)
		}
	}
}

// A server-managed device typically has NO agent.yaml backup config, so the
// long-lived mgr is nil and every dispatched backup_run builds an ephemeral
// payload manager tracked only by the command canceller. backup_stop must
// still cancel those runs — routing it through the nil-mgr "backup not
// configured" fallback silently made Stop a no-op for exactly the devices the
// server dispatches to (found live: cancelled jobs kept uploading to
// completion and wrote their manifests).
func TestExecuteCommand_BackupStopNilManagerCancelsTrackedRun(t *testing.T) {
	canceller := newActiveCommandCanceller()
	ctx, cleanup := canceller.track("run-cmd-1")
	defer cleanup()

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "stop-cmd-1",
		CommandType: "backup_stop",
	}, nil, nil, nil, canceller)

	if !result.Success {
		t.Fatalf("backup_stop with nil manager failed: %q", result.Stderr)
	}
	if result.Stdout != `{"stopped":true}` {
		t.Fatalf("stdout = %q, want {\"stopped\":true}", result.Stdout)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("tracked run context was not cancelled by backup_stop")
	}
}

func TestExecuteCommand_BackupStopNilManagerNothingRunning(t *testing.T) {
	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "stop-cmd-2",
		CommandType: "backup_stop",
	}, nil, nil, nil, newActiveCommandCanceller())

	if !result.Success {
		t.Fatalf("backup_stop with nothing running should succeed, got: %q", result.Stderr)
	}
	if result.Stdout != `{"stopped":false}` {
		t.Fatalf("stdout = %q, want {\"stopped\":false}", result.Stdout)
	}
}

// slowUploadProvider wraps a BackupProvider and delays every Upload, so a
// test can force a backup run whose wall-clock time is safely above
// DurationMs's one-millisecond truncation granularity.
type slowUploadProvider struct {
	providers.BackupProvider
	delay time.Duration
}

func (p *slowUploadProvider) Upload(localPath, remotePath string) error {
	time.Sleep(p.delay)
	return p.BackupProvider.Upload(localPath, remotePath)
}

// TestHandleBackupCommand_AsyncResultDurationTracksElapsed is the timing
// counterpart to the async protocol test above: that test can't assert a
// positive DurationMs (a sub-millisecond local backup truncates to 0), so
// the guarantee that DurationMs actually reflects elapsed run time is
// pinned here, against a provider slow enough that truncation can't hide a
// broken measurement.
func TestHandleBackupCommand_AsyncResultDurationTracksElapsed(t *testing.T) {
	const uploadDelay = 60 * time.Millisecond

	srcDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(srcDir, "hello.txt"), []byte("hello world"), 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	provider := &slowUploadProvider{
		BackupProvider: providers.NewLocalProvider(t.TempDir()),
		delay:          uploadDelay,
	}
	// Paths live on the manager (not the command payload) on purpose: a
	// payload carrying provider+providerConfig makes executeCommand build its
	// OWN manager via managerFromBackupRunPayload, which would discard the
	// slow provider this test depends on. Omitting them keeps the
	// agent.yaml-configured manager in play.
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, Paths: []string{srcDir}})

	agentSide, helperSide := net.Pipe()
	defer func() { _ = agentSide.Close() }()
	defer func() { _ = helperSide.Close() }()

	agentConn := ipc.NewConn(agentSide)
	helperConn := ipc.NewConn(helperSide)

	req := backupipc.BackupCommandRequest{
		CommandID:   "async-duration-cmd",
		CommandType: "backup_run",
		Payload:     json.RawMessage(`{}`),
		Async:       true,
	}
	reqPayload, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	env := &ipc.Envelope{ID: "async-duration-cmd", Type: backupipc.TypeBackupCommand, Payload: reqPayload}

	ch := startEnvelopeReader(agentConn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleBackupCommand(helperConn, env, mgr, nil, newActiveCommandCanceller())
	}()

	// Skip the ack; the terminal result is the one carrying DurationMs.
	_ = nextBackupResult(t, ch)
	finalEnv := nextBackupResult(t, ch)

	var final backupipc.BackupCommandResult
	if err := json.Unmarshal(finalEnv.Payload, &final); err != nil {
		t.Fatalf("unmarshal final result: %v", err)
	}
	if !final.Success {
		t.Fatalf("expected backup to succeed, got stderr %q", final.Stderr)
	}
	// Lower bound is deliberately below uploadDelay to absorb timer
	// granularity, not so low that a zeroed/unset DurationMs would pass.
	if final.DurationMs < 40 {
		t.Fatalf("expected DurationMs >= 40 for a backup that slept %s uploading, got %d", uploadDelay, final.DurationMs)
	}

	<-done
}

// TestInitBackupManager_CarriesAgentIDIntoManager pins the production wiring
// in initBackupManager that stamps BackupConfig.AgentID from cfg.AgentID.
// D6 (incremental dedupe base scoped to backup identity) depends on this:
// without AgentID flowing into the manager, previousManifest can pick
// another device's snapshot as its dedupe base. See the AgentID doc comment
// on backup.BackupConfig for the full story.
func TestInitBackupManager_CarriesAgentIDIntoManager(t *testing.T) {
	cfg := &config.Config{
		AgentID:         "agent-wiring-test",
		BackupEnabled:   true,
		BackupPaths:     []string{t.TempDir()},
		BackupProvider:  "local",
		BackupLocalPath: t.TempDir(),
		BackupRetention: 7,
	}

	mgr := initBackupManager(cfg)
	if mgr == nil {
		t.Fatal("initBackupManager returned nil, expected a manager")
	}
	if got := mgr.GetAgentID(); got != "agent-wiring-test" {
		t.Fatalf("mgr.GetAgentID() = %q, want %q", got, "agent-wiring-test")
	}
}

// ── D20b item B: provider-backed workloads route through a payload-built
// manager when mgr == nil (the normal state for every policy-managed
// device) ──────────────────────────────────────────────────────────────
//
// Before this fix, mssql_backup/hyperv_backup/mssql_restore/hyperv_restore/
// mssql_verify fell straight through executeCommand's mgr==nil switch to the
// generic `default: return fail("backup not configured on this device")` —
// even though the on-demand routes (apps/api/src/routes/backup/mssql.ts,
// hyperv.ts) now attach provider/providerConfig to the payload (D20b item
// A). These tests dispatch through executeCommand with mgr == nil, exactly
// how handleBackupCommand calls it for a real policy-managed device.

func TestExecuteCommand_MSSQLBackupNilManagerUsesPayloadProvider(t *testing.T) {
	baseDir := t.TempDir()

	origRunMSSQLBackup := runMSSQLBackup
	t.Cleanup(func() { runMSSQLBackup = origRunMSSQLBackup })
	backupBytes := []byte("mssql-nil-mgr-backup-bytes")
	runMSSQLBackup = func(instance, database, backupType, outputPath string) (*mssql.BackupResult, error) {
		backupFile := filepath.Join(outputPath, "AppDb_full.bak")
		if err := os.WriteFile(backupFile, backupBytes, 0o644); err != nil {
			t.Fatalf("write backup file: %v", err)
		}
		return &mssql.BackupResult{
			InstanceName: instance,
			DatabaseName: database,
			BackupType:   backupType,
			BackupFile:   backupFile,
			SizeBytes:    int64(len(backupBytes)),
		}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"database":   "AppDb",
		"backupType": "full",
		"provider":   "local",
		"providerConfig": map[string]any{
			"path": baseDir,
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "mssql-backup-nil-mgr",
		CommandType: "mssql_backup",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	if !result.Success {
		t.Fatalf("mssql_backup with nil manager + payload provider failed: %q", result.Stderr)
	}
	var decoded struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if decoded.SnapshotID == "" {
		t.Fatal("expected snapshotId")
	}
}

func TestExecuteCommand_MSSQLBackupNilManagerNoProviderConfigFailsWithSpecificMessage(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"database":   "AppDb",
		"backupType": "full",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "mssql-backup-no-provider",
		CommandType: "mssql_backup",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	if result.Success {
		t.Fatal("expected failure when payload carries no provider config")
	}
	if result.Stderr == "backup not configured on this device" {
		t.Fatalf("expected a specific missing-provider message, got the generic fallback: %q", result.Stderr)
	}
	if !strings.Contains(result.Stderr, "provider") {
		t.Fatalf("expected error to name the missing provider config, got: %q", result.Stderr)
	}
}

func TestExecuteCommand_HypervBackupNilManagerUsesPayloadProvider(t *testing.T) {
	baseDir := t.TempDir()

	payload, err := json.Marshal(map[string]any{
		"vmName":          "Accounting VM",
		"consistencyType": "application",
		"provider":        "local",
		"providerConfig": map[string]any{
			"path": baseDir,
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "hyperv-backup-nil-mgr",
		CommandType: "hyperv_backup",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	// hyperv.ExportVM has no test seam and this suite always runs on the
	// !windows stub (ErrHyperVNotSupported) — so a real end-to-end backup
	// can't be driven here. What this test CAN prove is that the payload
	// carrying a provider config routed all the way through to
	// execHypervBackup (which calls hyperv.ExportVM) instead of stopping at
	// the nil-manager "backup not configured" fallback: the stub error is
	// the tell, since execHypervBackup's own nil-provider guard returns a
	// different message ("backup not configured", singular device-less
	// form) and the mgr built here is never nil.
	if result.Success {
		t.Fatal("expected failure: hyperv.ExportVM is not supported on this (non-Windows) test platform")
	}
	if result.Stderr == "backup not configured on this device" {
		t.Fatalf("routing stopped at the nil-manager fallback instead of reaching execHypervBackup: %q", result.Stderr)
	}
	if !strings.Contains(result.Stderr, hyperv.ErrHyperVNotSupported.Error()) {
		t.Fatalf("expected the platform-stub error from execHypervBackup, got: %q", result.Stderr)
	}
}

func TestExecuteCommand_HypervBackupNilManagerNoProviderConfigFailsWithSpecificMessage(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"vmName":          "Accounting VM",
		"consistencyType": "application",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "hyperv-backup-no-provider",
		CommandType: "hyperv_backup",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	if result.Success {
		t.Fatal("expected failure when payload carries no provider config")
	}
	if result.Stderr == "backup not configured on this device" {
		t.Fatalf("expected a specific missing-provider message, got the generic fallback: %q", result.Stderr)
	}
	if !strings.Contains(result.Stderr, "provider") {
		t.Fatalf("expected error to name the missing provider config, got: %q", result.Stderr)
	}
}

func TestExecuteCommand_MSSQLRestoreNilManagerUsesPayloadProvider(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "mssql-nil-mgr-restore-20260909"
	prefix := path.Join("snapshots", snapshotID)

	backupBytes := []byte("nil-mgr-restore-source-bytes")
	srcPath := filepath.Join(t.TempDir(), "AppDb_full.bak")
	if err := os.WriteFile(srcPath, backupBytes, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	remoteBackupPath := path.Join(prefix, "files", filepath.Base(srcPath))
	if err := provider.Upload(srcPath, remoteBackupPath); err != nil {
		t.Fatalf("upload backup file: %v", err)
	}
	manifest := backup.Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
		Files: []backup.SnapshotFile{
			{SourcePath: filepath.Base(srcPath), BackupPath: remoteBackupPath, Size: int64(len(backupBytes))},
		},
		Size: int64(len(backupBytes)),
	}
	if err := uploadMssqlSnapshotManifest(provider, manifest); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	origRunMSSQLRestore := runMSSQLRestore
	t.Cleanup(func() { runMSSQLRestore = origRunMSSQLRestore })
	var stagedPath string
	runMSSQLRestore = func(instance, backupFile, targetDB string, noRecovery bool) (*mssql.RestoreResult, error) {
		stagedPath = backupFile
		return &mssql.RestoreResult{DatabaseName: targetDB, RestoredAs: targetDB, Status: "completed"}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":       "MSSQLSERVER",
		"snapshotId":     snapshotID,
		"targetDatabase": "AppDb_Restore",
		"provider":       "local",
		"providerConfig": map[string]any{
			"path": baseDir,
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "mssql-restore-nil-mgr",
		CommandType: "mssql_restore",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	if !result.Success {
		t.Fatalf("mssql_restore with nil manager + payload provider failed: %q", result.Stderr)
	}
	if stagedPath == "" {
		t.Fatal("expected restore to receive a staged backup file path")
	}
}

func TestExecuteCommand_MSSQLRestoreNilManagerNoProviderConfigFailsWithSpecificMessage(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"instance":       "MSSQLSERVER",
		"snapshotId":     "mssql-some-snapshot",
		"targetDatabase": "AppDb_Restore",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "mssql-restore-no-provider",
		CommandType: "mssql_restore",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	if result.Success {
		t.Fatal("expected failure when payload carries no provider config")
	}
	if result.Stderr == "backup not configured on this device" {
		t.Fatalf("expected a specific missing-provider message, got the generic fallback: %q", result.Stderr)
	}
	if !strings.Contains(result.Stderr, "provider") {
		t.Fatalf("expected error to name the missing provider config, got: %q", result.Stderr)
	}
}

func TestExecuteCommand_MSSQLVerifyNilManagerUsesPayloadProvider(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "mssql-nil-mgr-verify-20260909"
	prefix := path.Join("snapshots", snapshotID)

	backupBytes := []byte("nil-mgr-verify-source-bytes")
	srcPath := filepath.Join(t.TempDir(), "AppDb_log.trn")
	if err := os.WriteFile(srcPath, backupBytes, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	remoteBackupPath := path.Join(prefix, "files", filepath.Base(srcPath))
	if err := provider.Upload(srcPath, remoteBackupPath); err != nil {
		t.Fatalf("upload backup file: %v", err)
	}
	manifest := backup.Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
		Files: []backup.SnapshotFile{
			{SourcePath: filepath.Base(srcPath), BackupPath: remoteBackupPath, Size: int64(len(backupBytes))},
		},
		Size: int64(len(backupBytes)),
	}
	if err := uploadMssqlSnapshotManifest(provider, manifest); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	origRunMSSQLVerify := runMSSQLVerify
	t.Cleanup(func() { runMSSQLVerify = origRunMSSQLVerify })
	var verifiedPath string
	runMSSQLVerify = func(instance, backupFile string) (*mssql.VerifyResult, error) {
		verifiedPath = backupFile
		return &mssql.VerifyResult{Valid: true}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"snapshotId": snapshotID,
		"provider":   "local",
		"providerConfig": map[string]any{
			"path": baseDir,
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "mssql-verify-nil-mgr",
		CommandType: "mssql_verify",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	if !result.Success {
		t.Fatalf("mssql_verify with nil manager + payload provider failed: %q", result.Stderr)
	}
	if verifiedPath == "" {
		t.Fatal("expected verify to receive a staged backup file path")
	}
}

func TestExecuteCommand_MSSQLVerifyNilManagerNoProviderConfigFailsWithSpecificMessage(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"snapshotId": "mssql-some-snapshot",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "mssql-verify-no-provider",
		CommandType: "mssql_verify",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	if result.Success {
		t.Fatal("expected failure when payload carries no provider config")
	}
	if result.Stderr == "backup not configured on this device" {
		t.Fatalf("expected a specific missing-provider message, got the generic fallback: %q", result.Stderr)
	}
	if !strings.Contains(result.Stderr, "provider") {
		t.Fatalf("expected error to name the missing provider config, got: %q", result.Stderr)
	}
}

func TestExecuteCommand_HypervRestoreNilManagerReachesExecFunction(t *testing.T) {
	baseDir := t.TempDir()

	payload, err := json.Marshal(map[string]any{
		"snapshotId": "hyperv-nil-mgr-restore-20260909",
		"vmName":     "Recovered VM",
		"provider":   "local",
		"providerConfig": map[string]any{
			"path": baseDir,
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "hyperv-restore-nil-mgr",
		CommandType: "hyperv_restore",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	// No real snapshot manifest exists at baseDir, so execHypervRestore fails
	// at the manifest-download step (before it would ever reach
	// hyperv.ImportVM's platform stub) — that failure, distinct from the
	// nil-manager fallback, is what proves the payload-built manager routed
	// all the way into execHypervRestore.
	if result.Success {
		t.Fatal("expected failure: no real Hyper-V snapshot manifest exists at the test provider path")
	}
	if result.Stderr == "backup not configured on this device" {
		t.Fatalf("routing stopped at the nil-manager fallback instead of reaching execHypervRestore: %q", result.Stderr)
	}
	if !strings.Contains(result.Stderr, "Hyper-V snapshot manifest") {
		t.Fatalf("expected execHypervRestore's manifest-download error, got: %q", result.Stderr)
	}
}

func TestExecuteCommand_HypervRestoreNilManagerNoProviderConfigFailsWithSpecificMessage(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"snapshotId": "hyperv-some-snapshot",
		"vmName":     "Recovered VM",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := executeCommand(backupipc.BackupCommandRequest{
		CommandID:   "hyperv-restore-no-provider",
		CommandType: "hyperv_restore",
		Payload:     payload,
	}, nil, nil, nil, newActiveCommandCanceller())

	if result.Success {
		t.Fatal("expected failure when payload carries no provider config")
	}
	if result.Stderr == "backup not configured on this device" {
		t.Fatalf("expected a specific missing-provider message, got the generic fallback: %q", result.Stderr)
	}
	if !strings.Contains(result.Stderr, "provider") {
		t.Fatalf("expected error to name the missing provider config, got: %q", result.Stderr)
	}
}
