//go:build windows

package tools

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

// §13 row 1, Windows half: a JUNCTION is not a symlink and Go does not report
// it through os.ModeSymlink, so a pathname-based delete would traverse it. The
// os.Root handle refuses it in the runtime.
func TestCleanupGuardRefusesAnAncestorJunction(t *testing.T) {
	outside := t.TempDir()
	victim := filepath.Join(outside, "x")
	if err := os.WriteFile(victim, []byte("do not delete"), 0o644); err != nil {
		t.Fatalf("write victim: %v", err)
	}

	tempDir := t.TempDir()
	volumeRoot := filepath.VolumeName(tempDir) + string(filepath.Separator)
	if matchCleanupRuleFor("windows", filepath.Join(tempDir, "sub", "x")) == nil {
		t.Fatal("Windows temp fixture must match a cleanup rule")
	}
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	junction := filepath.Join(tempDir, "sub")
	// mklink /J creates a directory junction without the SeCreateSymbolicLink
	// privilege that developer mode grants for symlinks.
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", junction, outside).CombinedOutput(); err != nil {
		t.Skipf("mklink /J unavailable in this environment: %v (%s)", err, out)
	}

	target, err := openCleanupTarget("windows", filepath.Join(junction, "x"), volumeRoot)
	if err == nil {
		target.close()
		t.Fatal("expected the handle-based open to refuse a path whose ancestor is a junction out of the anchor")
	}
	if _, statErr := os.Stat(victim); statErr != nil {
		t.Fatal("the file outside the tree must survive")
	}
}

func TestIsSharingViolationRecognisesWindowsLockErrnos(t *testing.T) {
	if !isSharingViolation(syscall.Errno(32)) {
		t.Error("ERROR_SHARING_VIOLATION must be recognised")
	}
	if !isSharingViolation(syscall.Errno(33)) {
		t.Error("ERROR_LOCK_VIOLATION must be recognised")
	}
	if !isSharingViolation(fmt.Errorf("remove x: %w", syscall.Errno(32))) {
		t.Error("a wrapped errno must be recognised")
	}
	if isSharingViolation(syscall.Errno(5)) {
		t.Error("ERROR_ACCESS_DENIED is not a lock")
	}
	if isSharingViolation(os.ErrNotExist) {
		t.Error("a missing file is not a lock")
	}
}
