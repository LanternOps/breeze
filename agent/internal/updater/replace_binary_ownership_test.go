//go:build !windows

package updater

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestReplaceBinary_PreservesRootOwnershipWhenPrivileged proves that when
// the updater is actually running as root (a privileged self-update),
// replaceBinary explicitly (re-)asserts root:wheel/root ownership on the
// installed binary rather than trusting whatever os.Create happened to
// leave it as. It uses injected geteuidFn/chownBinaryFn seams so this is
// verifiable without real root.
func TestReplaceBinary_PreservesRootOwnershipWhenPrivileged(t *testing.T) {
	stubStagedSignatureCheck(t, func(string) error { return nil })

	prevGeteuid, prevChown := geteuidFn, chownBinaryFn
	t.Cleanup(func() { geteuidFn, chownBinaryFn = prevGeteuid, prevChown })

	geteuidFn = func() int { return 0 }
	var gotPath string
	var gotUID, gotGID int
	chownCalled := false
	chownBinaryFn = func(path string, uid, gid int) error {
		chownCalled = true
		gotPath, gotUID, gotGID = path, uid, gid
		return nil
	}

	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	newBinaryPath := filepath.Join(tmpDir, "new-binary")
	os.WriteFile(binaryPath, []byte("old"), 0755)
	os.WriteFile(newBinaryPath, []byte("new version"), 0644)

	u := New(&Config{BinaryPath: binaryPath})
	if err := u.replaceBinary(newBinaryPath); err != nil {
		t.Fatalf("replaceBinary() error = %v, want nil", err)
	}

	if runtime.GOOS == "windows" {
		return
	}
	if !chownCalled {
		t.Fatal("replaceBinary() did not call chownBinaryFn while running privileged (geteuidFn == 0)")
	}
	if gotPath != binaryPath {
		t.Errorf("chown path = %q, want %q", gotPath, binaryPath)
	}
	if gotUID != 0 || gotGID != 0 {
		t.Errorf("chown owner = (%d,%d), want (0,0) — root:wheel/root", gotUID, gotGID)
	}
}

// TestReplaceBinary_SkipsChownWhenUnprivileged proves replaceBinary does not
// attempt to chown when not running as root — an unprivileged dev/test
// invocation would otherwise fail with EPERM on every replace.
func TestReplaceBinary_SkipsChownWhenUnprivileged(t *testing.T) {
	stubStagedSignatureCheck(t, func(string) error { return nil })

	prevGeteuid, prevChown := geteuidFn, chownBinaryFn
	t.Cleanup(func() { geteuidFn, chownBinaryFn = prevGeteuid, prevChown })

	geteuidFn = func() int { return 501 }
	chownBinaryFn = func(path string, uid, gid int) error {
		t.Fatalf("chownBinaryFn called while unprivileged (path=%s uid=%d gid=%d)", path, uid, gid)
		return nil
	}

	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	newBinaryPath := filepath.Join(tmpDir, "new-binary")
	os.WriteFile(binaryPath, []byte("old"), 0755)
	os.WriteFile(newBinaryPath, []byte("new version"), 0644)

	u := New(&Config{BinaryPath: binaryPath})
	if err := u.replaceBinary(newBinaryPath); err != nil {
		t.Fatalf("replaceBinary() error = %v, want nil", err)
	}
}
