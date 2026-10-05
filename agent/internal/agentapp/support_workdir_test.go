package agentapp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestPrepareSupportWorkDirRegistersAPrivateWorkspace pins the #7620 wiring:
// the support client must create its workspace through
// config.SecureUserWorkspace, not a bare MkdirAll. If it did not, the
// enrollment pre-flight would apply the machine-wide policy, which on Windows
// a standard user may not assign and off Windows loosens the directory to
// 0755. Asserted through PrepareSaveDir, the call enrollment makes next.
func TestPrepareSupportWorkDirRegistersAPrivateWorkspace(t *testing.T) {
	dir, err := prepareSupportWorkDir()
	// The registration confines every later config write in this process to
	// the workspace (#7629); undo it so it cannot leak into other tests.
	t.Cleanup(config.ResetUserWorkspaceForTest)
	if err != nil {
		t.Fatalf("prepareSupportWorkDir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if dir != supportWorkDir() {
		t.Fatalf("prepareSupportWorkDir = %q, want supportWorkDir %q", dir, supportWorkDir())
	}
	if err := config.PrepareSaveDir(filepath.Join(dir, "agent.yaml")); err != nil {
		t.Fatalf("PrepareSaveDir on the support workspace: %v", err)
	}
	if runtime.GOOS == "windows" {
		return // the Windows ACL is asserted by config's TestUserWorkspace* tests
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != 0o700 {
		t.Errorf("support workspace mode after PrepareSaveDir = %o, want 700 (not registered as a user workspace?)", got)
	}
}
