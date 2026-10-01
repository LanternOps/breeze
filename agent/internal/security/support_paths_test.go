package security

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestQuarantineStaysInTheSupportFolder: a support session keeps all files in
// its private folder, including anything a technician quarantines during the
// session, never the machine-wide Breeze folder the installed agent owns
// (#7629).
func TestQuarantineStaysInTheSupportFolder(t *testing.T) {
	t.Cleanup(config.ResetUserWorkspaceForTest)
	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	if err := config.SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	got := DefaultQuarantineDir()
	if rel, err := filepath.Rel(ws, got); err != nil || strings.HasPrefix(rel, "..") {
		t.Fatalf("DefaultQuarantineDir() = %q, want inside the support folder %q", got, ws)
	}
}
