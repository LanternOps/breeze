package sessionbroker

import (
	"encoding/json"
	"net"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// backupDeathRig wires a Broker to a piped backup-helper session the way a live
// agent does. Crucially the session is driven by the SAME goroutine shape as
// production — RecvLoop followed by finishHelperSession, exactly as
// Broker.handleConnection does — so the tests exercise the wiring rather than
// calling the cleanup by hand. Killing the helper end of the pipe is the whole
// trigger; no test reaches in and invokes the reporting path itself.
type backupDeathRig struct {
	broker       *Broker
	session      *Session
	helper       *ipc.Conn
	forwarded    chan *ipc.Envelope
	disconnected chan struct{}
}

func newBackupDeathRig(t *testing.T) *backupDeathRig {
	t.Helper()
	brokerSide, helperSide := net.Pipe()
	return newBackupDeathRigOn(t, brokerSide, helperSide)
}

// newBufferedBackupDeathRig uses a kernel-buffered loopback pair instead of the
// synchronous net.Pipe, so the helper can queue an ack, a terminal result and a
// close without waiting for the broker to read each one. That is what a real
// unix-socket helper does, and it is the only way to drive the interleaving
// where RecvLoop consumes everything before the forwarding goroutine resumes.
func newBufferedBackupDeathRig(t *testing.T) *backupDeathRig {
	t.Helper()
	brokerSide, helperSide := newLoopbackConnPair(t)
	return newBackupDeathRigOn(t, brokerSide, helperSide)
}

func newLoopbackConnPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen loopback: %v", err)
	}
	defer func() { _ = listener.Close() }()

	type accepted struct {
		conn net.Conn
		err  error
	}
	accepts := make(chan accepted, 1)
	go func() {
		conn, err := listener.Accept()
		accepts <- accepted{conn: conn, err: err}
	}()

	dialed, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("dial loopback: %v", err)
	}
	got := <-accepts
	if got.err != nil {
		t.Fatalf("accept loopback: %v", got.err)
	}
	return got.conn, dialed
}

func newBackupDeathRigOn(t *testing.T, brokerSide, helperSide net.Conn) *backupDeathRig {
	t.Helper()

	rig := &backupDeathRig{
		helper:       ipc.NewConn(helperSide),
		forwarded:    make(chan *ipc.Envelope, 8),
		disconnected: make(chan struct{}),
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

	// The production shape: handleConnection's tail, verbatim.
	go func() {
		rig.session.RecvLoop(rig.broker.dispatchHelperMessage)
		rig.broker.finishHelperSession(rig.session)
		close(rig.disconnected)
	}()

	t.Cleanup(func() {
		_ = helperSide.Close()
		_ = brokerSide.Close()
	})
	return rig
}

// serveAcks plays the helper side for n forwarded commands, replying on each
// request's envelope id the way breeze-backup's async ack does
// (cmd/breeze-backup/main.go). ackSuccess=false models a refused run.
func (r *backupDeathRig) serveAcks(n int, ackSuccess bool) {
	go func() {
		for i := 0; i < n; i++ {
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
		}
	}()
}

// startAsyncRun forwards an async backup_run and waits for the helper's ack,
// leaving the run in flight exactly as a real backup_run command does.
func (r *backupDeathRig) startAsyncRun(t *testing.T, commandID string, ackSuccess bool) {
	t.Helper()
	r.serveAcks(1, ackSuccess)
	if _, err := r.broker.ForwardBackupCommand(commandID, "backup_run", nil, 5*time.Second, true); err != nil {
		t.Fatalf("ForwardBackupCommand(%s): %v", commandID, err)
	}
}

// killHelper simulates breeze-backup.exe being terminated: the helper end of
// the pipe goes away, RecvLoop hits EOF, and the production cleanup runs.
func (r *backupDeathRig) killHelper(t *testing.T) {
	t.Helper()
	_ = r.helper.Close()
	select {
	case <-r.disconnected:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the session teardown to complete")
	}
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

// expectNoForwarded is called only after killHelper has confirmed teardown
// finished, and the reporting path is synchronous within it, so anything the
// disconnect would have sent is already queued.
func (r *backupDeathRig) expectNoForwarded(t *testing.T) {
	t.Helper()
	select {
	case env := <-r.forwarded:
		t.Fatalf("expected no forwarded envelope, got type=%q payload=%s", env.Type, string(env.Payload))
	default:
	}
}

func (r *backupDeathRig) trackedRuns() int {
	r.broker.mu.RLock()
	bh := r.broker.backup
	r.broker.mu.RUnlock()
	if bh == nil {
		return 0
	}
	bh.mu.Lock()
	defer bh.mu.Unlock()
	return len(bh.activeRuns)
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

func assertHelperDeathResult(t *testing.T, result backupipc.BackupCommandResult, wantCommandID string) {
	t.Helper()
	if result.CommandID != wantCommandID {
		t.Errorf("CommandID = %q, want %q", result.CommandID, wantCommandID)
	}
	if result.Success {
		t.Error("expected Success=false for a helper that died mid-run")
	}
	if result.Stderr != backupHelperDiedError {
		t.Errorf("Stderr = %q, want %q", result.Stderr, backupHelperDiedError)
	}
}

// TestBackupHelperDeath_ActiveRun_ReportsTerminalFailure is the #2998 headline:
// when breeze-backup dies mid-run the disconnect must synthesize a terminal
// backup_result so the server fails the job in seconds, instead of leaving it
// "running" for the 15-minute stale reaper to mislabel as "no progress".
func TestBackupHelperDeath_ActiveRun_ReportsTerminalFailure(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.startAsyncRun(t, "cmd-run-1", true)

	rig.killHelper(t)

	assertHelperDeathResult(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-run-1")
	rig.expectNoForwarded(t)
	if got := rig.trackedRuns(); got != 0 {
		t.Errorf("tracked runs after death = %d, want 0", got)
	}
}

// TestBackupHelperDeath_ConcurrentRuns_ReportsEveryRun covers the shape a
// profile fan-out produces: several backup_run commands executing on one helper
// at once (file + system_image both dispatch as backup_run). Every one of them
// must be failed, not just the most recent — tracking only the latest would
// leave the others stranded for the reaper, i.e. #2998 unfixed for fan-out.
func TestBackupHelperDeath_ConcurrentRuns_ReportsEveryRun(t *testing.T) {
	rig := newBackupDeathRig(t)

	// The two dispatches are serialized, not raced. What this test needs is
	// two runs tracked SIMULTANEOUSLY, which sequential starts give; racing the
	// sends instead would trip a pre-existing ipc.Conn defect — Send assigns
	// env.Seq outside c.mu (internal/ipc/protocol.go), so concurrent senders on
	// one Conn can reach the wire out of sequence and the peer rejects the
	// frame as a replay. That is a real bug for the production fan-out this
	// test models, but it belongs to the ipc package, not to #2998.
	rig.startAsyncRun(t, "cmd-run-a", true)
	rig.startAsyncRun(t, "cmd-run-b", true)

	rig.killHelper(t)

	got := map[string]bool{}
	for i := 0; i < 2; i++ {
		result := decodeBackupResult(t, rig.nextForwarded(t))
		assertHelperDeathResult(t, result, result.CommandID)
		got[result.CommandID] = true
	}
	if !got["cmd-run-a"] || !got["cmd-run-b"] {
		t.Fatalf("expected both runs failed, got %v", got)
	}
	rig.expectNoForwarded(t)
	if n := rig.trackedRuns(); n != 0 {
		t.Errorf("tracked runs after death = %d, want 0", n)
	}
}

// TestBackupHelperDeath_NoActiveRun_ReportsNothing guards the normal case: a
// helper that exits when nothing is running must not fabricate a failed job.
func TestBackupHelperDeath_NoActiveRun_ReportsNothing(t *testing.T) {
	rig := newBackupDeathRig(t)

	rig.killHelper(t)

	rig.expectNoForwarded(t)
}

// TestBackupHelperDeath_AfterTerminalResult_DoesNotDoubleReport proves the
// disconnect is a no-op once the helper has already delivered its terminal
// result — the ordinary end of every async run, where the helper sends the
// result and then exits.
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

	rig.killHelper(t)

	rig.expectNoForwarded(t)
	if n := rig.trackedRuns(); n != 0 {
		t.Errorf("tracked runs after terminal result = %d, want 0", n)
	}
}

// TestBackupHelperDeath_AckThenImmediateDeath_ReportsExactlyOnce pins the
// interleaving that matters most in the field: a run that dies microseconds
// after acking (bad VSS snapshot, OOM, missing repository). The terminal
// failure must be reported EXACTLY once — either synthesized by the disconnect,
// or returned as an error from the forward, which the heartbeat turns into the
// command's failure result. Never both (duplicate) and never neither (the job
// strands for the 15-minute reaper, i.e. #2998 unfixed).
func TestBackupHelperDeath_AckThenImmediateDeath_ReportsExactlyOnce(t *testing.T) {
	for i := 0; i < 60; i++ {
		rig := newBackupDeathRig(t)

		// Ack and die in the same breath, with no synchronization against the
		// forwarding goroutine.
		go func() {
			env, err := rig.helper.Recv()
			if err != nil {
				return
			}
			var req backupipc.BackupCommandRequest
			if err := json.Unmarshal(env.Payload, &req); err != nil {
				return
			}
			ack := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: `{"started":true}`}
			_ = rig.helper.SendTyped(env.ID, backupipc.TypeBackupResult, ack)
			_ = rig.helper.Close()
		}()

		_, err := rig.broker.ForwardBackupCommand("cmd-race", "backup_run", nil, 5*time.Second, true)

		select {
		case <-rig.disconnected:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for the session teardown to complete")
		}

		reported := 0
		for {
			select {
			case env := <-rig.forwarded:
				assertHelperDeathResult(t, decodeBackupResult(t, env), "cmd-race")
				reported++
				continue
			default:
			}
			break
		}

		switch {
		case err != nil && reported != 0:
			t.Fatalf("iteration %d: double report — forward errored (%v) AND %d synthetic failures", i, err, reported)
		case err == nil && reported != 1:
			t.Fatalf("iteration %d: forward succeeded but %d synthetic failures reported, want exactly 1", i, reported)
		}
		if n := rig.trackedRuns(); n != 0 {
			t.Fatalf("iteration %d: %d runs left tracked after death — a later disconnect would fail a finished job", i, n)
		}
	}
}

// TestBackupHelperDeath_TerminalResultThenDeathDuringForward_NoContradiction
// pins the interleaving that a per-session "is the helper dead" flag gets
// wrong. The helper acks, delivers a genuine SUCCESS result, and exits — all
// while the forwarding goroutine is still between SendCommand and its
// bookkeeping. When it resumes, its tracking entry is gone and the helper is
// dead, but the run is NOT a casualty: the server already has the real result.
// Failing the command here would overwrite a recorded success with a bogus
// "backup helper exited unexpectedly".
func TestBackupHelperDeath_TerminalResultThenDeathDuringForward_NoContradiction(t *testing.T) {
	// Single-threaded scheduling makes the forwarding goroutine reliably lose
	// the race to RecvLoop, which is the whole point of the test.
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(1))

	for i := 0; i < 40; i++ {
		rig := newBufferedBackupDeathRig(t)

		go func() {
			env, err := rig.helper.Recv()
			if err != nil {
				return
			}
			var req backupipc.BackupCommandRequest
			if err := json.Unmarshal(env.Payload, &req); err != nil {
				return
			}
			ack := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: `{"started":true}`}
			_ = rig.helper.SendTyped(env.ID, backupipc.TypeBackupResult, ack)

			// The real terminal result, then a normal exit.
			done := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: `{"filesBackedUp":12}`}
			_ = rig.helper.SendTyped(req.CommandID+"-final", backupipc.TypeBackupResult, done)
			_ = rig.helper.Close()
		}()

		_, err := rig.broker.ForwardBackupCommand("cmd-finished", "backup_run", nil, 5*time.Second, true)
		if err != nil {
			t.Fatalf("iteration %d: forward failed a run that completed successfully: %v", i, err)
		}

		select {
		case <-rig.disconnected:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for the session teardown to complete")
		}

		result := decodeBackupResult(t, rig.nextForwarded(t))
		if !result.Success || result.CommandID != "cmd-finished" {
			t.Fatalf("iteration %d: expected the genuine success result, got %+v", i, result)
		}
		rig.expectNoForwarded(t)
		if n := rig.trackedRuns(); n != 0 {
			t.Fatalf("iteration %d: %d runs left tracked after a completed run", i, n)
		}
	}
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

	rig.killHelper(t)

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

// TestBackupHelperDeath_DeathBeforeAck_ForwarderOwnsTheFailure covers the
// helper dying with the request delivered but never acked. The forward is still
// blocked in SendCommand, which errors when the session closes, and the
// heartbeat turns that into the command's failure — so the death path must stay
// silent. Reporting it here as well would fail the same command twice.
func TestBackupHelperDeath_DeathBeforeAck_ForwarderOwnsTheFailure(t *testing.T) {
	rig := newBackupDeathRig(t)

	done := make(chan error, 1)
	go func() {
		_, err := rig.broker.ForwardBackupCommand("cmd-unacked", "backup_run", nil, 5*time.Second, true)
		done <- err
	}()

	// Request reaches the helper, which dies without acking.
	if _, err := rig.helper.Recv(); err != nil {
		t.Fatalf("helper Recv: %v", err)
	}
	rig.killHelper(t)

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected the forward to fail when the session closed before the ack")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the forward to fail")
	}

	rig.expectNoForwarded(t)
	if n := rig.trackedRuns(); n != 0 {
		t.Errorf("tracked runs after an unacked death = %d, want 0", n)
	}
}

// TestBackupHelperDeath_AckReportedFailure_ReportsNothing covers a helper that
// rejects the run in its ack: the forwarder already returns that failure as the
// command result, so the run was never in flight and the later disconnect must
// stay silent.
func TestBackupHelperDeath_AckReportedFailure_ReportsNothing(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.startAsyncRun(t, "cmd-run-3", false)

	rig.killHelper(t)

	rig.expectNoForwarded(t)
	if n := rig.trackedRuns(); n != 0 {
		t.Errorf("tracked runs after a refused ack = %d, want 0", n)
	}
}

// TestBackupHelperDeath_NonBackupRole_ReportsNothing pins the role gate: a user
// helper disconnecting must never touch the backup reporting path. The live
// backup run is then failed by its own helper's death, proving the run was
// genuinely tracked the whole time rather than the assertion passing vacuously.
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

	rig.killHelper(t)
	assertHelperDeathResult(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-run-4")
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
	rig.broker.reportBackupHelperDeath(stale)

	rig.expectNoForwarded(t)

	// The live session still owns the run, so its own death still reports.
	rig.killHelper(t)
	assertHelperDeathResult(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-run-5")
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

func TestNativeSynchronousHelperReplyDoesNotRemainActive(t *testing.T) {
	for _, command := range []string{"mssql_backup", "hyperv_backup"} {
		t.Run(command, func(t *testing.T) {
			rig := newBackupDeathRig(t)
			go func() {
				env, err := rig.helper.Recv()
				if err != nil {
					return
				}
				_ = rig.helper.SendTyped(env.ID, backupipc.TypeBackupResult, backupipc.BackupCommandResult{
					CommandID: "legacy-native", Success: true, Stdout: `{"snapshotId":"snapshot"}`,
				})
			}()
			if _, err := rig.broker.ForwardBackupCommand("legacy-native", command, nil, 5*time.Second, true, true); err != nil {
				t.Fatal(err)
			}
			rig.broker.backup.mu.Lock()
			defer rig.broker.backup.mu.Unlock()
			if len(rig.broker.backup.activeRuns) != 0 {
				t.Fatalf("terminal helper response left active run: %v", rig.broker.backup.activeRuns)
			}
		})
	}
}
