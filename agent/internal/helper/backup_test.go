package helper

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// #7113 (4): a backup copy that fails part-way leaves no truncated .backup, and
// does not clobber the backup already on disk (a previous rollback keeps the
// only good copy there when it could not restore it).
func TestBackupCopyFailurePartWayLeavesNoTruncatedBackup(t *testing.T) {
	h := newRollbackHarness(t, "1")
	if err := os.WriteFile(h.backup, []byte("previous-good"), 0755); err != nil {
		t.Fatal(err)
	}
	orig := backupCopyFunc
	t.Cleanup(func() { backupCopyFunc = orig })
	backupCopyFunc = func(dst io.Writer, src io.Reader) (int64, error) {
		n, _ := io.CopyN(dst, src, 3)
		return n, errors.New("disk full")
	}
	installPackageFunc = func(_, binaryPath, _ string) error {
		if err := os.WriteFile(binaryPath, []byte("0.114.0-partial"), 0755); err != nil {
			return err
		}
		return errors.New("msiexec: exit status 1603")
	}

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	b, err := os.ReadFile(h.backup)
	if err != nil {
		t.Fatalf("existing backup removed: %v", err)
	}
	if string(b) != "previous-good" {
		t.Fatalf("backup = %q, want the previous copy untouched by the failed write", b)
	}
	if h.renames != 0 {
		t.Fatalf("rollback renamed %d times with no verified backup of this attempt, want 0", h.renames)
	}
	if got := h.binaryContent(t); got == "previous-good" {
		t.Fatal("rollback restored a backup this attempt never wrote")
	}
	entries, _ := os.ReadDir(filepath.Dir(h.backup))
	for _, e := range entries {
		if e.Name() != filepath.Base(h.backup) && len(e.Name()) > len(filepath.Base(h.backup)) &&
			e.Name()[:len(filepath.Base(h.backup))] == filepath.Base(h.backup) {
			t.Fatalf("partial backup %s left behind", e.Name())
		}
	}
}

// A successful backup write is exact: size and bytes match the source.
func TestWriteHelperBackupRecordsExactCopy(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "breeze-helper.exe")
	dst := src + ".backup"
	if err := os.WriteFile(src, []byte("0.108.0-bytes"), 0755); err != nil {
		t.Fatal(err)
	}
	b, err := writeHelperBackup(src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.verify(); err != nil {
		t.Fatalf("fresh backup fails verification: %v", err)
	}
	if err := os.WriteFile(dst, []byte("0.108.0-bytez"), 0755); err != nil { // same size, different bytes
		t.Fatal(err)
	}
	if err := b.verify(); !errors.Is(err, errBackupMismatch) {
		t.Fatalf("verify of a same-size altered backup = %v, want errBackupMismatch", err)
	}
}
