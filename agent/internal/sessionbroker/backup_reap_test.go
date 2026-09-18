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
