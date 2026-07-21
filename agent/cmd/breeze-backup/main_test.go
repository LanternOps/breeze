package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
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
