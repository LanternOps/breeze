package backup

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestBackupJournalStaysInTheSupportFolder: in a support session the backup
// journal does not go to the per-user ~/.breeze dir (which outlives the
// session) but to the data dir, which is inside the session's private folder
// (#7629).
func TestBackupJournalStaysInTheSupportFolder(t *testing.T) {
	restoreHome, restoreData := journalHomeDirFn, journalDataDirFn
	t.Cleanup(func() { journalHomeDirFn, journalDataDirFn = restoreHome, restoreData })
	journalHomeDirFn = func() (string, error) { return t.TempDir(), nil }
	journalDataDirFn = config.GetDataDir

	t.Cleanup(config.ResetUserWorkspaceForTest)
	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	if err := config.SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	dir, ok := resolveJournalDir("")
	if !ok {
		t.Fatal("resolveJournalDir found no dir")
	}
	if rel, err := filepath.Rel(ws, dir); err != nil || strings.HasPrefix(rel, "..") {
		t.Fatalf("journal dir = %q, want inside the support folder %q", dir, ws)
	}
}
