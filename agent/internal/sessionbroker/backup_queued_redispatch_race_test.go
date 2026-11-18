package sessionbroker

import (
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
)

// Interleavings of #12193's re-dispatch that the straight-line tests in
// backup_queued_redispatch_test.go do not reach.

// The helper admits the run to its queue and its session ends at once, so the
// death report may run before the forwarder resumes from the ack. The run
// never started either way and must be re-sent, never failed.
func TestBackupHelperDeath_QueuedAckThenImmediateDeath_IsRedispatched(t *testing.T) {
	for i := range 30 {
		rig := newBackupDeathRig(t)
		spawned := make(chan *replacementHelper, 1)
		respawnTo(t, rig.broker, spawned)

		go func() {
			env, err := rig.helper.Recv()
			if err != nil {
				return
			}
			ack := backupipc.BackupCommandResult{CommandID: "cmd-q", Success: true, Stdout: ackQueued}
			_ = rig.helper.SendTyped(env.ID, backupipc.TypeBackupResult, ack)
			_ = rig.helper.Close()
		}()
		if _, err := rig.broker.ForwardBackupCommand("cmd-q", "backup_run", nil, backupDeathWait, true, true); err != nil {
			t.Fatalf("iteration %d: a run admitted to the queue failed with its session: %v", i, err)
		}
		select {
		case <-rig.disconnected:
		case <-time.After(backupDeathWait):
			t.Fatal("timed out waiting for the session teardown")
		}

		replacement := waitReplacement(t, spawned)
		if req := waitRequest(t, ackNext(replacement.helper, ackQueued)); req.CommandID != "cmd-q" {
			t.Fatalf("iteration %d: re-sent %q, want cmd-q", i, req.CommandID)
		}
		waitRunState(t, rig.broker, "cmd-q", backupRunQueued)
		rig.expectNoForwarded(t)
	}
}

// A re-sent run that the new helper started, before that helper's session
// ended too, was executing: it fails as a helper that stopped mid-run, not as
// a run that never started.
func TestBackupHelperDeath_RedispatchedRunStartedThenDied_FailsAsHelperStopped(t *testing.T) {
	for i := range 20 {
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
			ack := backupipc.BackupCommandResult{CommandID: "cmd-q", Success: true, Stdout: ackStarted}
			_ = replacement.helper.SendTyped(env.ID, backupipc.TypeBackupResult, ack)
			_ = replacement.helper.Close()
		}()

		assertHelperDeathResult(t, decodeBackupResult(t, rig.nextForwarded(t)), "cmd-q")
		select {
		case <-replacement.disconnected:
		case <-time.After(backupDeathWait):
			t.Fatal("timed out waiting for the replacement session teardown")
		}
		rig.expectNoForwarded(t)
		if n := rig.trackedRuns(); n != 0 {
			t.Fatalf("iteration %d: tracked runs = %d, want 0", i, n)
		}
	}
}

// A queued run is re-sent only once the ended helper's process is gone, so it
// cannot execute in the old helper and the new one at the same time: its
// "starting" frame can be lost on a connection the agent closed itself.
func TestBackupHelperDeath_Redispatch_WaitsForEndedHelperToExit(t *testing.T) {
	origGrace := backupHelperExitGrace
	backupHelperExitGrace = 300 * time.Millisecond
	t.Cleanup(func() { backupHelperExitGrace = origGrace })
	reaped := observeBackupHelperReap(t)

	rig := newBackupDeathRig(t)
	cmd := startReapTestHelper(t)
	rig.session.PID = cmd.Process.Pid
	rig.broker.backup.mu.Lock()
	rig.broker.backup.process = cmd.Process
	rig.broker.backup.cmd = cmd
	rig.broker.backup.reapOnce = &sync.Once{}
	rig.broker.backup.mu.Unlock()

	var respawnedBeforeExit atomic.Bool
	spawned := make(chan *replacementHelper, 1)
	rig.broker.respawnBackupHelper = func() (*Session, error) {
		select {
		case <-reaped:
		default:
			respawnedBeforeExit.Store(true)
		}
		r := attachReplacementHelper(t, rig.broker, "backup-replacement-exit")
		spawned <- r
		return r.session, nil
	}
	rig.forwardQueueAsync(t, rig.helper, "cmd-q", ackQueued, nil)

	// The helper process keeps running after its connection drops; the
	// disconnect reap kills it once the grace is up.
	rig.killHelper(t)

	replacement := waitReplacement(t, spawned)
	waitRequest(t, ackNext(replacement.helper, ackQueued))
	if respawnedBeforeExit.Load() {
		t.Fatal("the queued run was re-sent while the ended helper process was still running")
	}
}

func TestSpawnBackupHelper_RefusedOnceStopping(t *testing.T) {
	origTimeout := backupHelperSpawnTimeout
	backupHelperSpawnTimeout = 200 * time.Millisecond
	t.Cleanup(func() { backupHelperSpawnTimeout = origTimeout })

	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup:     &backupHelper{},
	}
	b.StopBackupHelper()
	if _, err := b.spawnBackupHelper(os.Args[0]); !errors.Is(err, errBackupHelperStopping) {
		t.Fatalf("spawn after StopBackupHelper: err = %v, want errBackupHelperStopping", err)
	}
	b.backup.mu.Lock()
	defer b.backup.mu.Unlock()
	if b.backup.process != nil {
		t.Fatal("a helper process was started behind the shutdown")
	}
}
