//go:build darwin

package tcc

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckFDAAtPath_OpenableFile(t *testing.T) {
	// A file this process can open means the OS granted the read —
	// the probe must report FDA as held.
	path := filepath.Join(t.TempDir(), "TCC.db")
	if err := os.WriteFile(path, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !checkFDAAtPath(path) {
		t.Error("checkFDAAtPath = false for an openable file, want true")
	}
}

func TestCheckFDAAtPath_PermissionDenied(t *testing.T) {
	// EACCES/EPERM on open is exactly how TCC denies access without FDA.
	if os.Getuid() == 0 {
		t.Skip("root bypasses file mode bits; test requires non-root execution")
	}
	path := filepath.Join(t.TempDir(), "TCC.db")
	if err := os.WriteFile(path, []byte("stub"), 0o000); err != nil {
		t.Fatal(err)
	}
	if checkFDAAtPath(path) {
		t.Error("checkFDAAtPath = true for a permission-denied file, want false")
	}
}

func TestCheckFDAAtPath_MissingFile(t *testing.T) {
	// ENOENT (e.g. Apple moves the DB in a future macOS) must read as
	// denied, never as granted.
	path := filepath.Join(t.TempDir(), "does-not-exist.db")
	if checkFDAAtPath(path) {
		t.Error("checkFDAAtPath = true for a missing file, want false")
	}
}

func TestCheckFDA_NotRoot(t *testing.T) {
	// The daemon-side fallback only means anything for the root daemon;
	// non-root callers must get false, not a probe against file modes.
	if os.Getuid() == 0 {
		t.Skip("test requires non-root execution")
	}
	if CheckFDA() {
		t.Error("CheckFDA = true when not running as root, want false")
	}
}

func TestConstants(t *testing.T) {
	if systemTCCDBPath != "/Library/Application Support/com.apple.TCC/TCC.db" {
		t.Errorf("unexpected TCC DB path: %s", systemTCCDBPath)
	}
}
