//go:build !windows

package backup

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSDHelpersAreNoOpsOffWindows pins the non-Windows contract Task 5's
// restore relies on (R37): capture yields no descriptor, apply ignores any
// descriptor it is handed (even one that would be malformed on Windows),
// and the privilege scopes return a callable release.
func TestSDHelpersAreNoOpsOffWindows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	sd, err := fileSecurity(path)
	if sd != nil || err != nil {
		t.Errorf("fileSecurity = %v, %v; want nil, nil", sd, err)
	}
	if err := applySecurity(path, []byte{1, 2, 3}); err != nil {
		t.Errorf("applySecurity = %v, want nil", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("applySecurity changed the mode to %v", info.Mode().Perm())
	}
	for _, enable := range []func() func(){enableCaptureSDPrivileges, enableRestoreSDPrivileges} {
		release := enable()
		if release == nil {
			t.Fatal("privilege scope returned a nil release")
		}
		release()
	}
}
