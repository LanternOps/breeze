package security

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
)

// requireSymlinks skips the test only when this account may not create
// symbolic links (Windows without the privilege); Administrator and
// LocalSystem can, so the test runs there.
func requireSymlinks(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := os.Symlink(target, filepath.Join(dir, "link"))
	if err == nil {
		return
	}
	var errno syscall.Errno
	if runtime.GOOS == "windows" && errors.As(err, &errno) && errno == 1314 { // ERROR_PRIVILEGE_NOT_HELD
		t.Skipf("this account may not create symbolic links: %v", err)
	}
	t.Fatalf("symlink: %v", err)
}
