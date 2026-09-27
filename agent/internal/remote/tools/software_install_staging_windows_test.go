//go:build windows

package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

func TestCreatePrivateInstallDirIsProtected(t *testing.T) {
	dir, err := createPrivateInstallDir()
	if err != nil {
		t.Fatalf("createPrivateInstallDir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	if !strings.HasPrefix(filepath.Base(dir), "breeze-sw-install-") {
		t.Fatalf("unexpected directory name %q", dir)
	}
	if filepath.Dir(dir) != filepath.Clean(os.TempDir()) {
		t.Fatalf("staging directory %q is not directly under %q", dir, os.TempDir())
	}
	if err := securefs.VerifyPrivateDir(dir); err != nil {
		t.Fatalf("install staging directory is not protected: %v", err)
	}
}

// Positive control: the previous implementation (os.MkdirTemp, which inherits
// the parent directory's DACL) must FAIL the same check, so the assertion
// above discriminates rather than being vacuous.
func TestMkdirTempInstallDirIsNotProtected(t *testing.T) {
	dir, err := os.MkdirTemp("", "breeze-sw-install-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := securefs.VerifyPrivateDir(dir); err == nil {
		t.Fatal("an os.MkdirTemp directory passed the protected-DACL check")
	}
}

func TestCreatePrivateInstallDirIsUniquePerCall(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 5; i++ {
		dir, err := createPrivateInstallDir()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(dir) })
		if seen[dir] {
			t.Fatalf("createPrivateInstallDir reused %q", dir)
		}
		seen[dir] = true
	}
}
