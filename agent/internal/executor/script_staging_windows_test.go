//go:build windows

package executor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

func TestCreatePrivateScriptDirIsProtected(t *testing.T) {
	dir, err := createPrivateScriptDir()
	if err != nil {
		t.Fatalf("createPrivateScriptDir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	if !strings.HasPrefix(filepath.Base(dir), "breeze-scripts-") {
		t.Fatalf("unexpected directory name %q; CleanupScript only accepts this prefix", dir)
	}
	if filepath.Dir(dir) != filepath.Clean(os.TempDir()) {
		t.Fatalf("staging directory %q is not directly under %q", dir, os.TempDir())
	}
	if err := securefs.VerifyPrivateDir(dir); err != nil {
		t.Fatalf("script staging directory is not protected: %v", err)
	}
}

// Positive control: the previous implementation (os.MkdirTemp) must FAIL the
// same check, so the assertion above is discriminating rather than vacuous.
func TestMkdirTempScriptDirIsNotProtected(t *testing.T) {
	dir, err := os.MkdirTemp("", "breeze-scripts-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := securefs.VerifyPrivateDir(dir); err == nil {
		t.Fatal("an os.MkdirTemp directory passed the protected-DACL check")
	}
}

func TestCreatePrivateScriptDirIsUniquePerCall(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 5; i++ {
		dir, err := createPrivateScriptDir()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(dir) })
		if seen[dir] {
			t.Fatalf("createPrivateScriptDir reused %q", dir)
		}
		seen[dir] = true
	}
}

func TestWriteScriptFileUsesAProtectedDirectory(t *testing.T) {
	path, err := WriteScriptFile("Write-Output 'hi'", ScriptTypePowerShell)
	if err != nil {
		t.Fatalf("WriteScriptFile: %v", err)
	}
	t.Cleanup(func() { CleanupScript(path) })
	if err := securefs.VerifyPrivateDir(filepath.Dir(path)); err != nil {
		t.Fatalf("script was staged in an unprotected directory: %v", err)
	}
}
