package sessionbroker

import (
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"
)

// startReapTestHelper re-execs this test binary as a long-lived child (the
// standard os/exec self-exec pattern — `sleep` does not exist on Windows, and
// this package's tests run in the Windows CI job) and returns the command.
func startReapTestHelper(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcess")
	cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start test helper process: %v", err)
	}
	return cmd
}

// observeBackupHelperReap installs the reap observation hook and returns a
// channel that receives the reaped *exec.Cmd once the reaping goroutine has
// returned from Wait. The channel handoff establishes happens-before, so the
// test may safely read cmd.ProcessState afterwards.
func observeBackupHelperReap(t *testing.T) <-chan *exec.Cmd {
	t.Helper()
	reaped := make(chan *exec.Cmd, 4)
	hook := func(cmd *exec.Cmd, _ *os.Process) { reaped <- cmd }
	backupHelperReapedHook.Store(&hook)
	t.Cleanup(func() { backupHelperReapedHook.Store(nil) })
	return reaped
}

// awaitReap fails the test unless a reap is observed, and unless that reap
// actually collected the child's exit status. ProcessState is set only by
// Wait, so a nil ProcessState is precisely the #5420 bug: the helper was
// killed but never waited on, leaving a zombie for the agent's lifetime.
func awaitReap(t *testing.T, reaped <-chan *exec.Cmd, what string) {
	t.Helper()
	select {
	case cmd := <-reaped:
		if cmd == nil {
			t.Fatalf("%s: reap hook fired without a command", what)
		}
		if cmd.ProcessState == nil {
			t.Fatalf("%s: killed helper (pid %d) was never waited on — it stays a zombie for the agent's lifetime (#5420)", what, cmd.Process.Pid)
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("%s: killed backup helper was never reaped (zombie PID leaked)", what)
	}
}

func newReapTestBroker(cmd *exec.Cmd, sessionID string) *Broker {
	return &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup: &backupHelper{
			process: cmd.Process,
			cmd:     cmd,
			// Mirrors what spawnBackupHelper publishes: the once that makes
			// this child's reap single-owner.
			reapOnce: &sync.Once{},
			session:  &Session{SessionID: sessionID},
		},
	}
}

// TestStopBackupHelper_ReapsKilledProcess proves the shutdown kill path
// (#5420) collects the child's exit status instead of leaving a zombie.
func TestStopBackupHelper_ReapsKilledProcess(t *testing.T) {
	reaped := observeBackupHelperReap(t)
	cmd := startReapTestHelper(t)
	b := newReapTestBroker(cmd, "backup-reap-stop")

	b.StopBackupHelper()

	if b.backup.process != nil || b.backup.cmd != nil {
		t.Fatalf("expected process/cmd to be cleared, got %+v / %+v", b.backup.process, b.backup.cmd)
	}
	awaitReap(t, reaped, "StopBackupHelper")
}

// TestStopBackupHelperIfIdle_ReapsKilledProcess proves the binary-swap kill
// path reaps too — this one runs repeatedly (every upgrade/reconcile), so an
// unreaped kill here compounds over the agent's lifetime.
func TestStopBackupHelperIfIdle_ReapsKilledProcess(t *testing.T) {
	reaped := observeBackupHelperReap(t)
	cmd := startReapTestHelper(t)
	b := newReapTestBroker(cmd, "backup-reap-idle")

	if !b.StopBackupHelperIfIdle() {
		t.Fatal("expected idle=true with no active runs")
	}
	if b.backup.process != nil || b.backup.cmd != nil {
		t.Fatalf("expected process/cmd to be cleared, got %+v / %+v", b.backup.process, b.backup.cmd)
	}
	awaitReap(t, reaped, "StopBackupHelperIfIdle")
}

// TestKillAndReap_IsSingleOwner covers the race between two kill sites that
// legitimately hold the same child: spawnBackupHelper keeps its own cmd
// reference across the whole connect wait, and a shutdown or binary swap can
// kill and reap that child in the meantime. A second exec.Cmd.Wait on the
// same command is a data race inside os/exec, not a harmless duplicate, so
// the shared reapOnce must make the loser a no-op — exactly one reap for one
// child.
func TestKillAndReap_IsSingleOwner(t *testing.T) {
	reaped := observeBackupHelperReap(t)
	cmd := startReapTestHelper(t)

	b := newReapTestBroker(cmd, "backup-reap-single-owner")
	once := b.backup.reapOnce

	// The Stop path wins and reaps.
	b.StopBackupHelper()
	awaitReap(t, reaped, "StopBackupHelper")

	// The spawn-timeout path, still holding its own cmd + the shared once,
	// now loses. It must not Wait again.
	killAndReap(once, cmd, cmd.Process)

	select {
	case <-reaped:
		t.Fatal("killAndReap reaped the same child twice — concurrent exec.Cmd.Wait is a data race")
	case <-time.After(500 * time.Millisecond):
	}
}

// TestSpawnBackupHelper_ConnectTimeout_ReapsKilledProcess covers the third
// kill site: a helper that starts but never connects back over IPC is killed
// on the spawn deadline. The stand-in "backup binary" is this test binary
// re-execed with flags it does not understand, so it exits immediately and
// would sit in the process table as a zombie unless the spawn path reaps it.
func TestSpawnBackupHelper_ConnectTimeout_ReapsKilledProcess(t *testing.T) {
	orig := backupHelperSpawnTimeout
	backupHelperSpawnTimeout = 300 * time.Millisecond
	t.Cleanup(func() { backupHelperSpawnTimeout = orig })

	reaped := observeBackupHelperReap(t)
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		socketPath: t.TempDir() + "/backup.sock",
	}

	if _, err := b.spawnBackupHelper(os.Args[0]); err == nil {
		t.Fatal("expected the spawn to fail on the connect timeout")
	}
	if b.backup.process != nil || b.backup.cmd != nil {
		t.Fatalf("expected process/cmd to be cleared after the timeout kill, got %+v / %+v", b.backup.process, b.backup.cmd)
	}
	awaitReap(t, reaped, "spawnBackupHelper connect timeout")
}

// startExitingReapTestHelper starts a child that exits on its own almost
// immediately — the crash / panic / OOM-kill shape #5980 is about. It is left
// un-waited on purpose: whatever reaps it must be the code under test.
func startExitingReapTestHelper(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start self-exiting test helper: %v", err)
	}
	return cmd
}

// awaitReapOf waits for a reap of want specifically, skipping reaps of other
// children (a respawn attempt reaps its own child too), and fails unless that
// reap actually collected want's exit status.
func awaitReapOf(t *testing.T, reaped <-chan *exec.Cmd, want *exec.Cmd, what string) {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for {
		select {
		case cmd := <-reaped:
			if cmd != want {
				continue
			}
			if cmd.ProcessState == nil {
				t.Fatalf("%s: helper (pid %d) was never waited on — it stays a zombie for the agent's lifetime (#5980)", what, cmd.Process.Pid)
			}
			return
		case <-deadline:
			t.Fatalf("%s: helper (pid %d) was never reaped — zombie PID leaked (#5980)", what, want.Process.Pid)
		}
	}
}

// TestFinishHelperSession_ReapsSelfExitedBackupHelper covers the path #5420 /
// PR #5975 left open: the helper dies on its own, its IPC connection drops,
// and the disconnect runs through finishHelperSession. Nothing there used to
// touch bh.process, so the dead child sat in the process table as a zombie.
//
// The grace is set far beyond the test's reap deadline, so a pass proves the
// self-exited child was collected by the wait alone, without being killed.
func TestFinishHelperSession_ReapsSelfExitedBackupHelper(t *testing.T) {
	setBackupHelperExitGrace(t, 10*time.Minute)
	reaped := observeBackupHelperReap(t)
	rig := newBackupDeathRig(t)
	cmd := startExitingReapTestHelper(t)

	bh := rig.broker.backup
	bh.mu.Lock()
	bh.process = cmd.Process
	bh.cmd = cmd
	bh.reapOnce = &sync.Once{}
	bh.mu.Unlock()
	rig.session.PID = cmd.Process.Pid

	// The helper's end of the socket goes away, exactly as when it exits.
	_ = rig.helper.Close()
	select {
	case <-rig.disconnected:
	case <-time.After(5 * time.Second):
		t.Fatal("helper disconnect never reached finishHelperSession")
	}

	awaitReapOf(t, reaped, cmd, "finishHelperSession after self-exit")
	bh.mu.Lock()
	defer bh.mu.Unlock()
	if bh.process != nil || bh.cmd != nil || bh.reapOnce != nil {
		t.Fatalf("expected process/cmd/reapOnce to be cleared after the reap, got %v / %v / %v", bh.process, bh.cmd, bh.reapOnce)
	}
}

func setBackupHelperExitGrace(t *testing.T, d time.Duration) {
	t.Helper()
	orig := backupHelperExitGrace
	backupHelperExitGrace = d
	t.Cleanup(func() { backupHelperExitGrace = orig })
}

// TestClearBackupSession_KillsHungDisconnectedHelperAfterGrace covers a helper
// whose session dropped but whose process never exits. Once its fields are
// cleared nothing else would ever kill it, so the disconnect reap must, but
// only after the grace: a helper that is merely finishing its own shutdown is
// left to exit by itself.
func TestClearBackupSession_KillsHungDisconnectedHelperAfterGrace(t *testing.T) {
	const grace = 1500 * time.Millisecond
	setBackupHelperExitGrace(t, grace)
	reaped := observeBackupHelperReap(t)
	cmd := startReapTestHelper(t) // sleeps 30s: it will not exit on its own in time
	b := newReapTestBroker(cmd, "backup-reap-hung")
	b.backup.session.PID = cmd.Process.Pid

	if !b.ClearBackupSession(b.backup.session) {
		t.Fatal("expected the owning session to be cleared")
	}
	b.backup.mu.Lock()
	cleared := b.backup.process == nil && b.backup.cmd == nil && b.backup.reapOnce == nil
	b.backup.mu.Unlock()
	if !cleared {
		t.Fatal("expected process/cmd/reapOnce to be cleared on disconnect")
	}

	select {
	case <-reaped:
		t.Fatal("hung helper was reaped before the grace expired — it was killed without being given time to exit")
	case <-time.After(grace / 3):
	}
	awaitReapOf(t, reaped, cmd, "hung disconnected helper after grace")
	if cmd.ProcessState.Success() {
		t.Fatalf("expected the hung helper to have been killed, got a clean exit: %v", cmd.ProcessState)
	}
}

// TestClearBackupSession_LeavesProcessItCannotAttribute proves the disconnect
// reap only touches the process the disconnecting session belongs to. A
// superseded session, or one whose peer PID is not the tracked child, must
// leave bh.process alone.
func TestClearBackupSession_LeavesProcessItCannotAttribute(t *testing.T) {
	cmd := startReapTestHelper(t)
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	pid := cmd.Process.Pid

	tests := []struct {
		name      string
		owner     *Session
		closing   *Session
		wantClear bool
	}{
		{
			name:    "superseded session",
			owner:   &Session{SessionID: "new", PID: pid},
			closing: &Session{SessionID: "old", PID: pid},
		},
		{
			name:      "peer pid does not match the tracked child",
			owner:     &Session{SessionID: "owner", PID: pid + 1},
			wantClear: true,
		},
		{
			name:      "peer pid unknown",
			owner:     &Session{SessionID: "owner-no-pid"},
			wantClear: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b := newReapTestBroker(cmd, "unused")
			b.backup.session = tc.owner
			closing := tc.closing
			if closing == nil {
				closing = tc.owner
			}
			if got := b.ClearBackupSession(closing); got != tc.wantClear {
				t.Fatalf("ClearBackupSession = %v, want %v", got, tc.wantClear)
			}

			b.backup.mu.Lock()
			defer b.backup.mu.Unlock()
			if b.backup.process != cmd.Process || b.backup.cmd != cmd {
				t.Fatal("ClearBackupSession killed/cleared a process it cannot attribute to the disconnecting session")
			}
		})
	}
}

// TestSpawnBackupHelper_ReapsStaleProcessBeforeRespawn covers the second half
// of #5980: a helper process with no session (exited on its own, or orphaned
// alive) is still referenced by bh.process when the next backup_run spawns a
// replacement. spawnBackupHelper used to overwrite bh.process / bh.cmd /
// bh.reapOnce, dropping the only reference, so that child could never be
// reaped for the rest of the agent's lifetime. Both shapes are covered: a
// predecessor that already exited, and one still alive (which must be killed —
// no session owns it).
func TestSpawnBackupHelper_ReapsStaleProcessBeforeRespawn(t *testing.T) {
	orig := backupHelperSpawnTimeout
	backupHelperSpawnTimeout = 300 * time.Millisecond
	t.Cleanup(func() { backupHelperSpawnTimeout = orig })

	tests := []struct {
		name       string
		start      func(*testing.T) *exec.Cmd
		wantKilled bool
	}{
		{name: "predecessor exited on its own", start: startExitingReapTestHelper},
		{name: "predecessor orphaned but alive", start: startReapTestHelper, wantKilled: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reaped := observeBackupHelperReap(t)
			stale := tc.start(t)
			b := &Broker{
				sessions:   make(map[string]*Session),
				byIdentity: make(map[string][]*Session),
				socketPath: t.TempDir() + "/backup.sock",
				backup: &backupHelper{
					process:  stale.Process,
					cmd:      stale,
					reapOnce: &sync.Once{},
				},
			}

			// The replacement never connects (it is this test binary with
			// flags it ignores), so the spawn fails on the connect timeout.
			// That is irrelevant here; what matters is the predecessor.
			_, _ = b.spawnBackupHelper(os.Args[0])

			awaitReapOf(t, reaped, stale, "spawnBackupHelper respawn ("+tc.name+")")
			if tc.wantKilled && stale.ProcessState.Success() {
				t.Fatalf("expected the live predecessor to be killed, got a clean exit: %v", stale.ProcessState)
			}
		})
	}
}
