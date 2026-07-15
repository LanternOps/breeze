package sessionbroker

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestSetClearBackupSession(t *testing.T) {
	b := &Broker{
		sessions:     make(map[string]*Session),
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
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
		sessions:     make(map[string]*Session),
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}
	// Should not panic when backup is nil
	b.StopBackupHelper()
}

func TestForwardBackupCommand_NotConnected(t *testing.T) {
	b := &Broker{
		sessions:     make(map[string]*Session),
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}
	_, err := b.ForwardBackupCommand("cmd-1", "backup_run", nil, 5e9)
	if err == nil {
		t.Fatal("expected error when backup helper not connected")
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

// TestBackupBinaryName pins the platform-suffix contract for the breeze-backup
// helper. The helper is built for every supported OS (see agent/Makefile), and
// is installed as breeze-backup.exe on Windows but breeze-backup elsewhere. The
// original bug resolved the sibling fallback as "breeze-backup" on every OS, so
// on Windows os.Stat could never find the installed breeze-backup.exe and every
// backup run failed with "backup binary not found". No non-Windows CI run could
// have caught it, hence this GOOS-parameterized test.
func TestBackupBinaryName(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"windows", "breeze-backup.exe"},
		{"linux", "breeze-backup"},
		{"darwin", "breeze-backup"},
	}
	for _, tt := range tests {
		if got := backupBinaryName(tt.goos); got != tt.want {
			t.Errorf("backupBinaryName(%q) = %q, want %q", tt.goos, got, tt.want)
		}
	}
}

func TestGetOrSpawnBackupHelper_ExistingSession(t *testing.T) {
	b := &Broker{
		sessions:     make(map[string]*Session),
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
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
