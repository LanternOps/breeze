package heartbeat

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestSupportSessionStateFilesStayInItsFolder: the small state stores that
// prefer the per-user ~/.breeze dir (IP history, reliability, the backup
// result outbox) resolve inside a support session's private folder instead,
// so a session leaves nothing behind in the user's profile (#7629). Data-dir
// stores (audit, fence, hardware health, time sync) follow config.GetDataDir,
// which config's TestUserWorkspacePathHelpersResolveIntoIt covers.
func TestSupportSessionStateFilesStayInItsFolder(t *testing.T) {
	t.Cleanup(config.ResetUserWorkspaceForTest)
	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	if err := config.SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	h := &Heartbeat{}
	for name, p := range map[string]string{
		"ipStatePath":           h.ipStatePath(),
		"reliabilityStatePath":  h.reliabilityStatePath(),
		"backupResultOutboxDir": backupResultOutboxDir(),
	} {
		rel, err := filepath.Rel(ws, p)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			t.Errorf("%s = %q, want inside the support folder %q", name, p, ws)
		}
	}
}
