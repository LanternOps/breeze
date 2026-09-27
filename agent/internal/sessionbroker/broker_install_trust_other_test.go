//go:build !windows

package sessionbroker

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHelperBinaryInstallTrusted_RefusesNonRootOwner(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: every temp file is root-owned")
	}
	path := filepath.Join(t.TempDir(), "breeze-helper")
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := helperBinaryInstallTrusted(path); err == nil {
		t.Fatal("a helper binary owned by a non-root user must not be treated as an administrator-only install")
	}
}

func TestHelperBinaryInstallTrusted_AcceptsRootOwnedSystemBinary(t *testing.T) {
	// /bin/sh and /bin are root-owned and not group/world-writable on every
	// supported Unix host.
	path, err := filepath.EvalSymlinks("/bin/sh")
	if err != nil {
		t.Skipf("no /bin/sh: %v", err)
	}
	if err := helperBinaryInstallTrusted(path); err != nil {
		t.Fatalf("a root-owned, non-writable binary in a root-owned directory must be trusted: %v", err)
	}
}
