package sessionbroker

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBinaryPathMatchesAllowedRequiresResolvablePeerPath(t *testing.T) {
	allowed := filepath.Join(t.TempDir(), "breeze-agent")
	if err := os.WriteFile(allowed, []byte("agent"), 0o755); err != nil {
		t.Fatalf("write allowed binary: %v", err)
	}

	if binaryPathMatchesAllowed(filepath.Join(t.TempDir(), "missing-helper"), []string{allowed}) {
		t.Fatal("unresolvable peer path matched allowed helper path")
	}
}

func TestBinaryPathMatchesAllowedResolvesSymlinks(t *testing.T) {
	dir := t.TempDir()
	allowed := filepath.Join(dir, "breeze-desktop-helper")
	if err := os.WriteFile(allowed, []byte("helper"), 0o755); err != nil {
		t.Fatalf("write allowed binary: %v", err)
	}
	link := filepath.Join(dir, "helper-link")
	if err := os.Symlink(allowed, link); err != nil {
		t.Fatalf("symlink helper: %v", err)
	}

	if !binaryPathMatchesAllowed(link, []string{allowed}) {
		t.Fatal("symlinked peer path did not match resolved allowed helper path")
	}
}

// TestAllowedHelperPathsIncludesBackupHelper guards against a regression where
// the backup helper (breeze-backup / breeze-backup.exe) is missing from the IPC
// peer allowlist. Without it, verifyBinaryPath rejects the backup helper before
// it can register, and every backup_run command fails with
// "backup helper failed to connect within 15s".
func TestAllowedHelperPathsIncludesBackupHelper(t *testing.T) {
	b := &Broker{}
	paths := b.allowedHelperPaths()
	var hasBackup, hasBackupExe bool
	for _, p := range paths {
		switch filepath.Base(p) {
		case "breeze-backup":
			hasBackup = true
		case "breeze-backup.exe":
			hasBackupExe = true
		}
	}
	if !hasBackup {
		t.Errorf("allowedHelperPaths() must include breeze-backup (non-Windows); got %v", paths)
	}
	if !hasBackupExe {
		t.Errorf("allowedHelperPaths() must include breeze-backup.exe (Windows); got %v", paths)
	}
}
