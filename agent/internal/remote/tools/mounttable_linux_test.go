//go:build linux

package tools

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// A bind mount shares its source's device, so only the mount table shows it
// as a volume top. Needs CAP_SYS_ADMIN (run in a privileged container).
func TestScanRecognisesBindMountAsVolumeTop(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "src")
	writeScanFixture(t, filepath.Join(src, "etc", "shadow"), "x")
	dst := filepath.Join(base, "mnt", "x")
	if err := os.MkdirAll(dst, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mount(src, dst, "", syscall.MS_BIND, ""); err != nil {
		t.Skipf("bind mount not permitted here: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Unmount(dst, 0) })

	p := filepath.Join(dst, "etc", "shadow")
	s := NewScanScope()
	r, err := s.CheckRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Skip(r, p, lstatT(t, p)) {
		t.Fatal("a protected file at the top of a bind mount was not recognised")
	}
	f, err := s.OpenFile(p, lstatT(t, p))
	if f != nil {
		_ = f.Close()
	}
	if err == nil {
		t.Fatal("OpenFile read a protected file at the top of a bind mount")
	}
}
