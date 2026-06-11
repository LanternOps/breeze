//go:build !windows

// Tests in this file rely on syscall.Stat_t / inode semantics that don't
// exist on Windows. Splitting them out with a build tag keeps the rest of
// updater_test.go cross-compilable for GOOS=windows.
package updater

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestRollback_UnlinksBeforeWrite(t *testing.T) {
	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	backupPath := filepath.Join(tmpDir, "breeze-agent.backup")

	// Create "current" binary and hold it open (simulates running executable)
	os.WriteFile(binaryPath, []byte("corrupted"), 0755)
	holder, err := os.Open(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()

	origInfo, _ := os.Stat(binaryPath)
	origSys := origInfo.Sys().(*syscall.Stat_t)
	origIno := origSys.Ino

	// Create backup
	os.WriteFile(backupPath, []byte("good v0.1.0"), 0755)

	u := New(&Config{BinaryPath: binaryPath, BackupPath: backupPath})
	if err := u.Rollback(); err != nil {
		t.Fatalf("rollback failed: %v", err)
	}

	// Verify rollback content
	content, _ := os.ReadFile(binaryPath)
	if string(content) != "good v0.1.0" {
		t.Fatalf("rollback content mismatch: %s", string(content))
	}

	// Verify new inode (unlink happened)
	newInfo, _ := os.Stat(binaryPath)
	newSys := newInfo.Sys().(*syscall.Stat_t)
	if newSys.Ino == origIno {
		t.Fatal("expected new inode after unlink+create in rollback")
	}
}

func TestReplaceBinary_UnlinksBeforeWrite(t *testing.T) {
	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	newBinaryPath := filepath.Join(tmpDir, "new-binary")

	// Create current binary and hold it open (simulates running executable holding inode)
	os.WriteFile(binaryPath, []byte("old binary"), 0755)
	holder, err := os.Open(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()

	// Record original inode
	origInfo, _ := os.Stat(binaryPath)
	origSys := origInfo.Sys().(*syscall.Stat_t)
	origIno := origSys.Ino

	// Create new binary
	os.WriteFile(newBinaryPath, []byte("new binary v2"), 0644)

	u := New(&Config{BinaryPath: binaryPath})
	if err := u.replaceBinary(newBinaryPath); err != nil {
		t.Fatalf("replace failed: %v", err)
	}

	// Verify new content at path
	content, _ := os.ReadFile(binaryPath)
	if string(content) != "new binary v2" {
		t.Fatalf("expected new content, got: %s", string(content))
	}

	// Verify it's a NEW inode (unlink created a new file, not truncated old one)
	newInfo, _ := os.Stat(binaryPath)
	newSys := newInfo.Sys().(*syscall.Stat_t)
	if newSys.Ino == origIno {
		t.Fatal("expected new inode after unlink+create, but got same inode")
	}

	// Verify the held-open file descriptor still reads old content (kernel kept old inode)
	holder.Seek(0, 0)
	oldContent := make([]byte, 100)
	n, _ := holder.Read(oldContent)
	if string(oldContent[:n]) != "old binary" {
		t.Fatalf("held FD should still read old content, got: %s", string(oldContent[:n]))
	}
}
