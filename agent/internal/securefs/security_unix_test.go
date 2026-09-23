//go:build linux || darwin

package securefs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func inodeOfFD(t *testing.T, fd uintptr) uint64 {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Fstat(int(fd), &st); err != nil {
		t.Fatalf("fstat handed-in descriptor: %v", err)
	}
	return uint64(st.Ino)
}

func inodeOfPath(t *testing.T, p string) uint64 {
	t.Helper()
	info, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	return uint64(info.Sys().(*syscall.Stat_t).Ino)
}

// TestInstallFileWithSecurityAppliesToPinnedTemporaryBeforePublish: the
// applier runs on the pinned temporary's descriptor while the destination
// name does not exist yet, and that descriptor IS the file later published.
func TestInstallFileWithSecurityAppliesToPinnedTemporaryBeforePublish(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "nested", "file.txt")
	var appliedInode uint64
	calls := 0
	sec := &SecurityApplier{Apply: func(h uintptr) error {
		calls++
		appliedInode = inodeOfFD(t, h)
		if _, err := os.Lstat(dest); !os.IsNotExist(err) {
			t.Errorf("destination already published when the applier ran (lstat err %v)", err)
		}
		return nil
	}}
	warnings, err := InstallFileWithSecurity(base, filepath.Join("nested", "file.txt"), writeSource(t, "data"), 0o644, time.Time{}, nil, 0, sec)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("InstallFileWithSecurity = %v, %v", warnings, err)
	}
	if calls != 1 {
		t.Fatalf("applier ran %d times, want 1", calls)
	}
	if got := inodeOfPath(t, dest); got != appliedInode {
		t.Errorf("published inode %d != inode the applier was handed %d", got, appliedInode)
	}
}

// TestInstallFileWithSecurityApplyErrorIsAWarning: a failing applier never
// fails the install.
func TestInstallFileWithSecurityApplyErrorIsAWarning(t *testing.T) {
	base := t.TempDir()
	sec := &SecurityApplier{Apply: func(uintptr) error { return errors.New("boom") }}
	warnings, err := InstallFileWithSecurity(base, "f.txt", writeSource(t, "data"), 0o644, time.Time{}, nil, 0, sec)
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0].Error(), "apply security descriptor: boom") {
		t.Fatalf("warnings = %v, want one 'apply security descriptor: boom'", warnings)
	}
	if b, err := os.ReadFile(filepath.Join(base, "f.txt")); err != nil || string(b) != "data" {
		t.Fatalf("file not published: %q, %v", b, err)
	}
}

// TestApplyDirSecurityPinsTheDirectory: positive control (the applier gets
// the directory's own descriptor), a symlinked intermediate component is
// refused before the applier runs, and a missing directory is not created.
func TestApplyDirSecurityPinsTheDirectory(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real", "sub")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	var got uint64
	if err := ApplyDirSecurity(base, filepath.Join("real", "sub"), SecurityApplier{Apply: func(h uintptr) error {
		got = inodeOfFD(t, h)
		return nil
	}}); err != nil {
		t.Fatalf("positive control: %v", err)
	}
	if want := inodeOfPath(t, real); got != want {
		t.Errorf("applier handed inode %d, want the directory's %d", got, want)
	}

	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(base, "link")); err != nil {
		t.Fatal(err)
	}
	called := false
	err := ApplyDirSecurity(base, filepath.Join("link", "sub"), SecurityApplier{Apply: func(uintptr) error { called = true; return nil }})
	if err == nil || called {
		t.Fatalf("symlinked component: err=%v called=%v, want refusal before apply", err, called)
	}

	err = ApplyDirSecurity(base, "missing", SecurityApplier{Apply: func(uintptr) error { called = true; return nil }})
	if err == nil || called {
		t.Fatalf("missing dir: err=%v called=%v, want an error and no apply", err, called)
	}
	if _, statErr := os.Stat(filepath.Join(base, "missing")); !os.IsNotExist(statErr) {
		t.Error("ApplyDirSecurity created a missing directory")
	}
	if err := ApplyDirSecurity(base, "real", SecurityApplier{}); err == nil {
		t.Error("nil Apply accepted")
	}
}
