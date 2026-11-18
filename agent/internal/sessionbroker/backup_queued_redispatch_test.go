package sessionbroker

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12193: a run the helper admitted to its execution queue ({"queued":true})
// and never started is not lost with the helper's session. The agent sends it
// to a fresh helper instead of failing it with the running one.

const (
	ackQueued  = `{"queued":true}`
	ackStarted = `{"started":true}`
)

// ackNext plays the helper for one forwarded command: it reads the request,
// acks it with stdout, and hands the request back for inspection.
func ackNext(conn *ipc.Conn, stdout string) <-chan backupipc.BackupCommandRequest {
	got := make(chan backupipc.BackupCommandRequest, 1)
	go func() {
		env, err := conn.Recv()
		if err != nil {
			close(got)
			return
		}
		var req backupipc.BackupCommandRequest
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			close(got)
			return
		}
		ack := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: stdout}
		_ = conn.SendTyped(env.ID, backupipc.TypeBackupResult, ack)
		got <- req
	}()
	return got
}

// forwardQueueAsync forwards one queue-aware workload and waits for its ack.
func (r *backupDeathRig) forwardQueueAsync(t *testing.T, conn *ipc.Conn, commandID, stdout string, payload []byte) {
	t.Helper()
	acked := ackNext(conn, stdout)
	if _, err := r.broker.ForwardBackupCommand(commandID, "backup_run", payload, backupDeathWait, true, true); err != nil {
		t.Fatalf("ForwardBackupCommand(%s): %v", commandID, err)
	}
	if _, ok := <-acked; !ok {
		t.Fatalf("helper never acked %s", commandID)
	}
}

// replacementHelper is a second backup helper session on the rig's broker,
// standing in for the process a real respawn would start.
type replacementHelper struct {
	session      *Session
	helper       *ipc.Conn
	disconnected chan struct{}
}

func attachReplacementHelper(t *testing.T, b *Broker, id string) *replacementHelper {
	t.Helper()
	brokerSide, helperSide := net.Pipe()
	r := &replacementHelper{helper: ipc.NewConn(helperSide), disconnected: make(chan struct{})}
	r.session = &Session{
		SessionID:     id,
		AllowedScopes: []string{"backup"},
		HelperRole:    backupipc.HelperRoleBackup,
		conn:          ipc.NewConn(brokerSide),
		pending:       make(map[string]pendingResponse),
		done:          make(chan struct{}),
		broker:        b,
	}
	b.mu.Lock()
	b.sessions[id] = r.session
	b.mu.Unlock()
	b.SetBackupSession(r.session)
	go func() {
		r.session.RecvLoop(b.dispatchHelperMessage)
		b.finishHelperSession(r.session)
		close(r.disconnected)
	}()
	t.Cleanup(func() {
		_ = helperSide.Close()
		_ = brokerSide.Close()
	})
	return r
}

// respawnTo installs the respawn seam: each call attaches the next replacement
// helper and reports it on spawned.
func respawnTo(t *testing.T, b *Broker, spawned chan<- *replacementHelper) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	b.respawnBackupHelper = func() (*Session, error) {
		n := calls.Add(1)
		r := attachReplacementHelper(t, b, "backup-replacement-"+string(rune('0'+n)))
		spawned <- r
		return r.session, nil
	}
	return &calls
}

func waitReplacement(t *testing.T, spawned <-chan *replacementHelper) *replacementHelper {
	t.Helper()
	select {
	case r := <-spawned:
		return r
	case <-time.After(backupDeathWait):
		t.Fatal("timed out waiting for the queued run to be sent to a fresh helper")
		return nil
	}
}

func waitRequest(t *testing.T, got <-chan backupipc.BackupCommandRequest) backupipc.BackupCommandRequest {
	t.Helper()
	select {
	case req, ok := <-got:
		if !ok {
			t.Fatal("replacement helper connection closed before a request arrived")
		}
		return req
	case <-time.After(backupDeathWait):
		t.Fatal("timed out waiting for the re-dispatched request")
		return backupipc.BackupCommandRequest{}
	}
}

func runState(b *Broker, commandID string) (backupRunState, bool) {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	bh.mu.Lock()
	defer bh.mu.Unlock()
	run, ok := bh.activeRuns[commandID]
	if !ok {
		return 0, false
	}
	return run.state, true
}

func waitRunState(t *testing.T, b *Broker, commandID string, want backupRunState) {
	t.Helper()
	deadline := time.Now().Add(backupDeathWait)
	for time.Now().Before(deadline) {
		if got, ok := runState(b, commandID); ok && got == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	got, ok := runState(b, commandID)
	t.Fatalf("run %s state = %v (tracked=%v), want %v", commandID, got, ok, want)
}

func TestBackupHelperDeath_QueuedRun_RedispatchedToFreshHelper(t *testing.T) {
	rig := newBackupDeathRig(t)
	spawned := make(chan *replacementHelper, 2)
	respawnTo(t, rig.broker, spawned)

	rig.forwardQueueAsync(t, rig.helper, "cmd-running", ackStarted, []byte(`{"sel":"a"}`))
	rig.forwardQueueAsync(t, rig.helper, "cmd-queued", ackQueued, []byte(`{"sel":"b"}`))

	rig.killHelper(t)

	// Only the running run fails.
	result := decodeBackupResult(t, rig.nextForwarded(t))
	assertHelperDeathResult(t, result, "cmd-running")

	// The queued run goes to the replacement helper, unchanged.
	replacement := waitReplacement(t, spawned)
	req := waitRequest(t, ackNext(replacement.helper, ackQueued))
	if req.CommandID != "cmd-queued" || req.CommandType != "backup_run" || string(req.Payload) != `{"sel":"b"}` {
		t.Fatalf("re-dispatched request = %+v, want cmd-queued backup_run {\"sel\":\"b\"}", req)
	}
	if !req.Async || !req.QueueAsync {
		t.Fatalf("re-dispatched request lost its async flags: async=%v queueAsync=%v", req.Async, req.QueueAsync)
	}
	waitRunState(t, rig.broker, "cmd-queued", backupRunQueued)
	rig.expectNoForwarded(t)

	// The fresh helper now owns it: its terminal result retires the run.
	final := backupipc.BackupCommandResult{CommandID: "cmd-queued", Success: true, Stdout: `{}`}
	if err := replacement.helper.SendTyped("cmd-queued-final", backupipc.TypeBackupResult, final); err != nil {
		t.Fatalf("send final result: %v", err)
	}
	if got := decodeBackupResult(t, rig.nextForwarded(t)); got.CommandID != "cmd-queued" || !got.Success {
		t.Fatalf("forwarded final result = %+v, want cmd-queued success", got)
	}
	if n := rig.trackedRuns(); n != 0 {
		t.Fatalf("tracked runs after the re-dispatched run finished = %d, want 0", n)
	}
}

// A run that told the agent it left the queue is executing; the helper's death
// fails it like any running run, and it must never be sent again (that would
// run the same backup twice).
func TestBackupHelperDeath_QueuedRunThatStarted_IsFailedNotRedispatched(t *testing.T) {
	for i := range 20 {
		rig := newBufferedBackupDeathRig(t)
		spawned := make(chan *replacementHelper, 1)
		calls := respawnTo(t, rig.broker, spawned)

		// Ack and the "starting" progress back to back: RecvLoop may dispatch
		// the progress before the forwarder resumes from its ack.
		go func() {
			env, err := rig.helper.Recv()
			if err != nil {
				return
			}
			ack := backupipc.BackupCommandResult{CommandID: "cmd-q", Success: true, Stdout: ackQueued}
			_ = rig.helper.SendTyped(env.ID, backupipc.TypeBackupResult, ack)
			_ = rig.helper.SendTyped("", backupipc.TypeBackupProgress, backupipc.BackupProgress{CommandID: "cmd-q", Phase: "starting"})
		}()
		if _, err := rig.broker.ForwardBackupCommand("cmd-q", "backup_run", nil, backupDeathWait, true, true); err != nil {
			t.Fatalf("iteration %d: forward: %v", i, err)
		}
		if env := rig.nextForwarded(t); env.Type != backupipc.TypeBackupProgress {
			t.Fatalf("iteration %d: forwarded %q, want the progress frame", i, env.Type)
		}

		rig.killHelper(t)

		assertHelperDeathResult(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-q")
		rig.expectNoForwarded(t)
		if n := calls.Load(); n != 0 {
			t.Fatalf("iteration %d: a started run was re-dispatched (%d respawns)", i, n)
		}
		if n := rig.trackedRuns(); n != 0 {
			t.Fatalf("iteration %d: tracked runs = %d, want 0", i, n)
		}
	}
}

// A "queued" progress frame (the helper's queue heartbeat) does not mean the
// run started.
func TestBackupHelperDeath_QueuedHeartbeat_StaysQueued(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.forwardQueueAsync(t, rig.helper, "cmd-q", ackQueued, nil)
	if err := rig.helper.SendTyped("", backupipc.TypeBackupProgress, backupipc.BackupProgress{CommandID: "cmd-q", Phase: "queued"}); err != nil {
		t.Fatalf("send progress: %v", err)
	}
	if env := rig.nextForwarded(t); env.Type != backupipc.TypeBackupProgress {
		t.Fatalf("forwarded %q, want the progress frame", env.Type)
	}
	if got, _ := runState(rig.broker, "cmd-q"); got != backupRunQueued {
		t.Fatalf("state after a queued heartbeat = %v, want queued", got)
	}
}

func assertNeverStarted(t *testing.T, result backupipc.BackupCommandResult, commandID, wantDetail string) {
	t.Helper()
	if result.CommandID != commandID || result.Success {
		t.Fatalf("result = %+v, want a failure for %s", result, commandID)
	}
	if !strings.HasPrefix(result.Stderr, backupRunNeverStartedError) {
		t.Fatalf("Stderr = %q, want prefix %q", result.Stderr, backupRunNeverStartedError)
	}
	if wantDetail != "" && !strings.Contains(result.Stderr, wantDetail) {
		t.Fatalf("Stderr = %q, want it to mention %q", result.Stderr, wantDetail)
	}
	if strings.Contains(result.Stderr, backupHelperDiedError) || strings.Contains(result.Stderr, backupHelperSessionClosedError) {
		t.Fatalf("Stderr = %q reads as a run that was executing (helper_stopped)", result.Stderr)
	}
}

func TestBackupHelperDeath_QueuedRun_RespawnFails_FailsAsNeverStarted(t *testing.T) {
	rig := newBackupDeathRig(t)
	rig.broker.respawnBackupHelper = func() (*Session, error) {
		return nil, errors.New("backup binary not found")
	}
	rig.forwardQueueAsync(t, rig.helper, "cmd-q", ackQueued, nil)

	rig.killHelper(t)

	assertNeverStarted(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-q", "backup binary not found")
	if n := rig.trackedRuns(); n != 0 {
		t.Fatalf("tracked runs = %d, want 0", n)
	}
}

func TestBackupHelperDeath_QueuedRun_RefusedByFreshHelper_ReportsTheRefusal(t *testing.T) {
	rig := newBackupDeathRig(t)
	spawned := make(chan *replacementHelper, 1)
	respawnTo(t, rig.broker, spawned)
	rig.forwardQueueAsync(t, rig.helper, "cmd-q", ackQueued, nil)

	rig.killHelper(t)

	replacement := waitReplacement(t, spawned)
	go func() {
		env, err := replacement.helper.Recv()
		if err != nil {
			return
		}
		ack := backupipc.BackupCommandResult{CommandID: "cmd-q", Success: false, Stderr: "vault locked"}
		_ = replacement.helper.SendTyped(env.ID, backupipc.TypeBackupResult, ack)
	}()
	assertNeverStarted(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-q", "vault locked")
	if n := rig.trackedRuns(); n != 0 {
		t.Fatalf("tracked runs = %d, want 0", n)
	}
}

// Re-dispatch is bounded: a device whose helper sessions keep ending (the
// #11044 suspend pattern) does not bounce one run between helpers forever.
func TestBackupHelperDeath_QueuedRun_RedispatchIsBounded(t *testing.T) {
	rig := newBackupDeathRig(t)
	spawned := make(chan *replacementHelper, maxBackupRunRedispatches+1)
	calls := respawnTo(t, rig.broker, spawned)
	rig.forwardQueueAsync(t, rig.helper, "cmd-q", ackQueued, nil)

	rig.killHelper(t)
	for range maxBackupRunRedispatches {
		replacement := waitReplacement(t, spawned)
		waitRequest(t, ackNext(replacement.helper, ackQueued))
		waitRunState(t, rig.broker, "cmd-q", backupRunQueued)
		_ = replacement.helper.Close()
		select {
		case <-replacement.disconnected:
		case <-time.After(backupDeathWait):
			t.Fatal("timed out waiting for the replacement session teardown")
		}
	}

	assertNeverStarted(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-q", "")
	if n := calls.Load(); n != maxBackupRunRedispatches {
		t.Fatalf("respawns = %d, want %d", n, maxBackupRunRedispatches)
	}
	if n := rig.trackedRuns(); n != 0 {
		t.Fatalf("tracked runs = %d, want 0", n)
	}
}

// Agent shutdown ends the helper session on purpose; a queued run is failed
// as never started and no helper is spawned behind the shutdown.
func TestBackupHelperDeath_QueuedRun_DuringShutdown_FailsWithoutRespawn(t *testing.T) {
	origGrace := backupHelperStopGrace
	backupHelperStopGrace = 10 * time.Millisecond
	defer func() { backupHelperStopGrace = origGrace }()

	rig := newBackupDeathRig(t)
	spawned := make(chan *replacementHelper, 1)
	calls := respawnTo(t, rig.broker, spawned)
	rig.forwardQueueAsync(t, rig.helper, "cmd-q", ackQueued, nil)

	rig.broker.StopBackupHelper()
	rig.killHelper(t)

	assertNeverStarted(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-q", "")
	if n := calls.Load(); n != 0 {
		t.Fatalf("respawned %d helper(s) during shutdown", n)
	}
	if n := rig.trackedRuns(); n != 0 {
		t.Fatalf("tracked runs = %d, want 0", n)
	}
}
