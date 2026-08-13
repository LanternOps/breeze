package sessionbroker

import (
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestSetClearBackupSession(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}

	s := &Session{SessionID: "backup-test"}
	b.SetBackupSession(s)

	b.mu.RLock()
	if b.backup == nil || b.backup.session == nil {
		b.mu.RUnlock()
		t.Fatal("expected backup session to be set")
	}
	if b.backup.session.SessionID != "backup-test" {
		b.mu.RUnlock()
		t.Errorf("got %s, want backup-test", b.backup.session.SessionID)
	}
	b.mu.RUnlock()

	b.ClearBackupSession()
	b.mu.RLock()
	if b.backup.session != nil {
		b.mu.RUnlock()
		t.Error("expected backup session to be cleared")
	}
	b.mu.RUnlock()
}

func TestStopBackupHelper_NilBroker(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	// Should not panic when backup is nil
	b.StopBackupHelper()
}

func TestForwardBackupCommand_NotConnected(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	_, err := b.ForwardBackupCommand("cmd-1", "backup_run", nil, 5e9, false)
	if err == nil {
		t.Fatal("expected error when backup helper not connected")
	}
}

// TestForwardBackupCommand_ThreadsAsyncFlag proves the async parameter reaches
// the helper on the wire as BackupCommandRequest.Async, and that the sync
// (false) path is unaffected — the field must default off so an old server
// (whose forwarder never passes true) round-trips a byte-identical request.
func TestForwardBackupCommand_ThreadsAsyncFlag(t *testing.T) {
	tests := []struct {
		name  string
		async bool
	}{
		{"async true", true},
		{"async false (compat default)", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			serverConn, clientConn := net.Pipe()
			defer func() { _ = serverConn.Close() }()
			defer func() { _ = clientConn.Close() }()

			brokerSideConn := ipc.NewConn(serverConn)
			helperSideConn := ipc.NewConn(clientConn)

			s := &Session{
				SessionID: "backup-async-test",
				conn:      brokerSideConn,
				pending:   make(map[string]pendingResponse),
				done:      make(chan struct{}),
			}
			go s.RecvLoop(func(*Session, *ipc.Envelope) {})

			b := &Broker{
				sessions:   make(map[string]*Session),
				byIdentity: make(map[string][]*Session),
			}
			b.SetBackupSession(s)

			reqCh := make(chan backupipc.BackupCommandRequest, 1)
			go func() {
				env, err := helperSideConn.Recv()
				if err != nil {
					return
				}
				var req backupipc.BackupCommandRequest
				if jsonErr := json.Unmarshal(env.Payload, &req); jsonErr != nil {
					return
				}
				reqCh <- req
				result := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true}
				_ = helperSideConn.SendTyped(env.ID, backupipc.TypeBackupResult, result)
			}()

			if _, err := b.ForwardBackupCommand("cmd-async-1", "backup_run", nil, 5*time.Second, tt.async); err != nil {
				t.Fatalf("ForwardBackupCommand error: %v", err)
			}

			select {
			case req := <-reqCh:
				if req.Async != tt.async {
					t.Fatalf("got Async=%v, want %v", req.Async, tt.async)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for helper to receive request")
			}
		})
	}
}

func TestBackupHelperScopes(t *testing.T) {
	if len(backupHelperScopes) != 1 || backupHelperScopes[0] != "backup" {
		t.Errorf("unexpected backup helper scopes: %v", backupHelperScopes)
	}
}

func TestHelperRoleBackupConstant(t *testing.T) {
	if backupipc.HelperRoleBackup != "backup" {
		t.Errorf("expected 'backup', got %s", backupipc.HelperRoleBackup)
	}
}

// TestBackupBinaryName pins the platform-suffix contract for the nu-backup
// helper. The helper is built for every supported OS (see agent/Makefile), and
// is installed as nu-backup.exe on Windows but nu-backup elsewhere. The
// original bug resolved the sibling fallback as "nu-backup" on every OS, so
// on Windows os.Stat could never find the installed nu-backup.exe and every
// backup run failed with "backup binary not found". No non-Windows CI run could
// have caught it, hence this GOOS-parameterized test.
func TestBackupBinaryName(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"windows", "nu-backup.exe"},
		{"linux", "nu-backup"},
		{"darwin", "nu-backup"},
	}
	for _, tt := range tests {
		if got := backupBinaryName(tt.goos); got != tt.want {
			t.Errorf("backupBinaryName(%q) = %q, want %q", tt.goos, got, tt.want)
		}
	}
}

// TestStopBackupHelperIfIdle_NilBroker: nothing spawned yet — nothing blocks
// a swap, so it must report idle (true) rather than panic or false-positive
// "busy".
func TestStopBackupHelperIfIdle_NilBroker(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	if !b.StopBackupHelperIfIdle() {
		t.Fatal("expected idle=true when no backup helper has ever been spawned")
	}
}

// TestStopBackupHelperIfIdle_ActiveRunBlocks: a tracked in-flight run (any
// state — pending-ack, executing, or the doomed tombstone) must defer the
// swap rather than kill a helper mid-job.
func TestStopBackupHelperIfIdle_ActiveRunBlocks(t *testing.T) {
	for _, state := range []backupRunState{backupRunPendingAck, backupRunExecuting, backupRunDoomed} {
		b := &Broker{
			sessions:   make(map[string]*Session),
			byIdentity: make(map[string][]*Session),
			backup: &backupHelper{
				activeRuns: map[string]backupRunState{"cmd-1": state},
			},
		}
		if b.StopBackupHelperIfIdle() {
			t.Fatalf("expected idle=false with an active run in state %v", state)
		}
		// The tracked run must be left untouched — deferring must not itself
		// mutate broker state.
		if len(b.backup.activeRuns) != 1 {
			t.Fatalf("expected activeRuns to be untouched by a deferred check, got %v", b.backup.activeRuns)
		}
	}
}

// TestStopBackupHelperIfIdle_IdleStopsProcessAndClearsSession verifies the
// success path: no active runs, so the resident process is killed, process
// and session are cleared, and the call reports idle=true.
func TestStopBackupHelperIfIdle_IdleStopsProcessAndClearsSession(t *testing.T) {
	// Re-exec this test binary as a long-lived helper process (the standard
	// os/exec self-exec pattern) rather than shelling out to `sleep`, which
	// doesn't exist on Windows — this package's tests run in the Windows CI
	// job (see ci.yml test-agent-windows). See TestHelperProcess below.
	cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcess")
	cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start test helper process: %v", err)
	}
	defer func() { _, _ = cmd.Process.Wait() }()

	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup: &backupHelper{
			process: cmd.Process,
			session: &Session{SessionID: "backup-idle-test"},
		},
	}

	if !b.StopBackupHelperIfIdle() {
		t.Fatal("expected idle=true with no active runs")
	}
	if b.backup.process != nil {
		t.Fatalf("expected process to be cleared, got %+v", b.backup.process)
	}
	if b.backup.session != nil {
		t.Fatalf("expected session to be cleared, got %+v", b.backup.session)
	}
}

// TestHelperProcess is not a real test — it's the re-exec target for
// TestStopBackupHelperIfIdle_IdleStopsProcessAndClearsSession's cross-platform
// long-lived-process stand-in. It no-ops unless GO_WANT_HELPER_PROCESS=1 is
// set, so a normal `go test` run treats it as a (trivially passing) test.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	time.Sleep(30 * time.Second)
	os.Exit(0)
}

func TestGetOrSpawnBackupHelper_ExistingSession(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}

	// Pre-set a backup session
	s := &Session{
		SessionID: "backup-existing",
		conn:      &ipc.Conn{},
		pending:   make(map[string]pendingResponse),
	}
	b.SetBackupSession(s)

	got, err := b.GetOrSpawnBackupHelper("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.SessionID != "backup-existing" {
		t.Errorf("got %s, want backup-existing", got.SessionID)
	}
}
