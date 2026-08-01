package sessionbroker

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// backupDeathRig wires a Broker to a piped backup-helper session the way a live
// agent does: the session carries the "backup" scope and the backup role, is
// registered as the current backup session, and its RecvLoop dispatches through
// the real Broker.dispatchHelperMessage. That means an unsolicited terminal
// backup_result travels the production path (RecvLoop -> dispatchHelperMessage
// -> onMessage), so the tests below exercise wiring rather than a mock.
type backupDeathRig struct {
	broker    *Broker
	session   *Session
	helper    *ipc.Conn
	forwarded chan *ipc.Envelope
}

func newBackupDeathRig(t *testing.T) *backupDeathRig {
	t.Helper()

	brokerSide, helperSide := net.Pipe()
	rig := &backupDeathRig{
		helper:    ipc.NewConn(helperSide),
		forwarded: make(chan *ipc.Envelope, 8),
	}

	rig.session = &Session{
		SessionID:     "backup-death-test",
		AllowedScopes: []string{"backup"},
		HelperRole:    backupipc.HelperRoleBackup,
		conn:          ipc.NewConn(brokerSide),
		pending:       make(map[string]pendingResponse),
		done:          make(chan struct{}),
	}
	rig.broker = &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		onMessage: func(_ *Session, env *ipc.Envelope) {
			rig.forwarded <- env
		},
	}
	rig.session.broker = rig.broker
	rig.broker.sessions[rig.session.SessionID] = rig.session
	rig.broker.SetBackupSession(rig.session)

	go rig.session.RecvLoop(rig.broker.dispatchHelperMessage)

	t.Cleanup(func() {
		_ = helperSide.Close()
		_ = brokerSide.Close()
	})
	return rig
}

// ackNextCommand plays the helper side of one forwarded backup command: it
// reads the request and replies on the request's envelope id, mirroring
// breeze-backup's async ack (cmd/breeze-backup/main.go). ackSuccess=false
// models a helper that refused to start the run.
func (r *backupDeathRig) ackNextCommand(ackSuccess bool) {
	go func() {
		env, err := r.helper.Recv()
		if err != nil {
			return
		}
		var req backupipc.BackupCommandRequest
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			return
		}
		ack := backupipc.BackupCommandResult{
			CommandID: req.CommandID,
			Success:   ackSuccess,
			Stdout:    `{"started":true}`,
		}
		_ = r.helper.SendTyped(env.ID, backupipc.TypeBackupResult, ack)
	}()
}

// startAsyncRun forwards an async backup_run and waits for the helper's ack,
// leaving the run in flight exactly as it is after a real backup_run command.
func (r *backupDeathRig) startAsyncRun(t *testing.T, commandID string, ackSuccess bool) {
	t.Helper()
	r.ackNextCommand(ackSuccess)
	if _, err := r.broker.ForwardBackupCommand(commandID, "backup_run", nil, 5*time.Second, true); err != nil {
		t.Fatalf("ForwardBackupCommand: %v", err)
	}
}

// killHelper simulates breeze-backup.exe being terminated: the helper end of
// the pipe goes away, RecvLoop hits EOF and returns.
func (r *backupDeathRig) killHelper() {
	_ = r.helper.Close()
}

func (r *backupDeathRig) nextForwarded(t *testing.T) *ipc.Envelope {
	t.Helper()
	select {
	case env := <-r.forwarded:
		return env
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a forwarded envelope")
		return nil
	}
}

func (r *backupDeathRig) expectNoForwarded(t *testing.T) {
	t.Helper()
	select {
	case env := <-r.forwarded:
		t.Fatalf("expected no forwarded envelope, got type=%q payload=%s", env.Type, string(env.Payload))
	case <-time.After(250 * time.Millisecond):
	}
}

func decodeBackupResult(t *testing.T, env *ipc.Envelope) backupipc.BackupCommandResult {
	t.Helper()
	if env.Type != backupipc.TypeBackupResult {
		t.Fatalf("envelope type = %q, want %q", env.Type, backupipc.TypeBackupResult)
	}
	var result backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		t.Fatalf("unmarshal backup result: %v", err)
	}
	return result
}

// TestBackupHelperDeath_ActiveRun_ReportsTerminalFailure is the #2998 headline:
// when breeze-backup dies mid-run the disconnect must synthesize a terminal
// backup_result so the server fails the job in seconds, instead of leaving it
// "running" for the 15-minute stale reaper to mislabel as "no progress".
func TestBackupHelperDeath_ActiveRun_ReportsTerminalFailure(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.startAsyncRun(t, "cmd-run-1", true)

	rig.killHelper()
	rig.broker.finishHelperSession(rig.session)

	result := decodeBackupResult(t, rig.nextForwarded(t))
	if result.CommandID != "cmd-run-1" {
		t.Errorf("CommandID = %q, want cmd-run-1", result.CommandID)
	}
	if result.Success {
		t.Error("expected Success=false for a helper that died mid-run")
	}
	if result.Stderr != backupHelperDiedError {
		t.Errorf("Stderr = %q, want %q", result.Stderr, backupHelperDiedError)
	}
	rig.expectNoForwarded(t)
}

// TestBackupHelperDeath_NoActiveRun_ReportsNothing guards the normal case: a
// helper that exits when nothing is running must not fabricate a failed job.
func TestBackupHelperDeath_NoActiveRun_ReportsNothing(t *testing.T) {
	rig := newBackupDeathRig(t)

	rig.killHelper()
	rig.broker.finishHelperSession(rig.session)

	rig.expectNoForwarded(t)
}

// TestBackupHelperDeath_AfterTerminalResult_DoesNotDoubleReport proves the
// disconnect is a no-op once the helper has already delivered its terminal
// result — the ordinary end of every successful async run, where the helper
// sends the result and then exits.
func TestBackupHelperDeath_AfterTerminalResult_DoesNotDoubleReport(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.startAsyncRun(t, "cmd-run-2", true)

	// Helper delivers the real terminal result on a fresh envelope id, exactly
	// as sendUnsolicitedResult does in cmd/breeze-backup/main.go.
	genuine := backupipc.BackupCommandResult{
		CommandID: "cmd-run-2",
		Success:   true,
		Stdout:    `{"filesBackedUp":48000}`,
	}
	if err := rig.helper.SendTyped("cmd-run-2-final-1", backupipc.TypeBackupResult, genuine); err != nil {
		t.Fatalf("send terminal result: %v", err)
	}

	got := decodeBackupResult(t, rig.nextForwarded(t))
	if !got.Success || got.CommandID != "cmd-run-2" {
		t.Fatalf("unexpected genuine result: %+v", got)
	}

	rig.killHelper()
	rig.broker.finishHelperSession(rig.session)

	rig.expectNoForwarded(t)
}

// TestBackupHelperDeath_SyncCommandInFlight_ReportsNothing keeps the synthetic
// failure off the legacy synchronous path. There the caller is still blocked in
// Session.SendCommand, which errors out when the session closes, and the
// heartbeat forwarder turns that into the command's failure result — reporting
// again here would double-report the same command.
func TestBackupHelperDeath_SyncCommandInFlight_ReportsNothing(t *testing.T) {
	rig := newBackupDeathRig(t)

	done := make(chan error, 1)
	go func() {
		_, err := rig.broker.ForwardBackupCommand("cmd-sync-1", "backup_run", nil, 5*time.Second, false)
		done <- err
	}()

	// Let the request reach the helper side before killing it.
	if _, err := rig.helper.Recv(); err != nil {
		t.Fatalf("helper Recv: %v", err)
	}

	rig.killHelper()
	rig.broker.finishHelperSession(rig.session)

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected the synchronous forward to fail when the session closed")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the synchronous forward to fail")
	}
	rig.expectNoForwarded(t)
}

// TestBackupHelperDeath_AckReportedFailure_ReportsNothing covers a helper that
// rejects the run in its ack: the forwarder already returns that failure as the
// command result, so the run was never in flight and the later disconnect must
// stay silent.
func TestBackupHelperDeath_AckReportedFailure_ReportsNothing(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.startAsyncRun(t, "cmd-run-3", false)

	rig.killHelper()
	rig.broker.finishHelperSession(rig.session)

	rig.expectNoForwarded(t)
}

// TestBackupHelperDeath_NonBackupRole_ReportsNothing pins the role gate: a user
// helper disconnecting must never touch the backup reporting path, even while a
// backup run is in flight on the separate backup session.
func TestBackupHelperDeath_NonBackupRole_ReportsNothing(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.startAsyncRun(t, "cmd-run-4", true)

	other := &Session{
		SessionID: "user-helper-1",
		conn:      ipc.NewConn(newDiscardPipeConn(t)),
		pending:   make(map[string]pendingResponse),
		done:      make(chan struct{}),
	}
	rig.broker.finishHelperSession(other)

	rig.expectNoForwarded(t)
}

// TestBackupHelperDeath_StaleSession_ReportsNothing prevents the worst failure
// mode: a superseded backup session must not fail the run owned by the session
// that replaced it.
func TestBackupHelperDeath_StaleSession_ReportsNothing(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.startAsyncRun(t, "cmd-run-5", true)

	stale := &Session{
		SessionID:     "backup-stale",
		AllowedScopes: []string{"backup"},
		HelperRole:    backupipc.HelperRoleBackup,
		conn:          ipc.NewConn(newDiscardPipeConn(t)),
		pending:       make(map[string]pendingResponse),
		done:          make(chan struct{}),
	}
	rig.broker.finishHelperSession(stale)

	rig.expectNoForwarded(t)

	// The live session still owns the run, so its own death still reports.
	rig.killHelper()
	rig.broker.finishHelperSession(rig.session)
	result := decodeBackupResult(t, rig.nextForwarded(t))
	if result.CommandID != "cmd-run-5" || result.Success {
		t.Fatalf("unexpected result after live-session death: %+v", result)
	}
}

// newDiscardPipeConn returns one end of a pipe whose peer is drained and
// discarded, so writes on it never block a test.
func newDiscardPipeConn(t *testing.T) net.Conn {
	t.Helper()
	a, b := net.Pipe()
	go func() {
		buf := make([]byte, 256)
		for {
			if _, err := b.Read(buf); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		_ = a.Close()
		_ = b.Close()
	})
	return a
}
