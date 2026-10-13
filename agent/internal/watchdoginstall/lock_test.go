package watchdoginstall

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLock_SecondAcquirerDefers(t *testing.T) {
	dir := t.TempDir()
	l1, err := AcquireLock(dir)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if _, err := AcquireLock(dir); !errors.Is(err, ErrLockHeld) {
		t.Fatalf("second acquire: want ErrLockHeld, got %v", err)
	}
	l1.Release()
	l1.Release() // idempotent
	l2, err := AcquireLock(dir)
	if err != nil {
		t.Fatalf("re-acquire after release: %v", err)
	}
	l2.Release()
	if _, err := os.Stat(filepath.Join(dir, LockFileName)); err != nil {
		t.Fatalf("lock file should persist (never removed): %v", err)
	}
}

// The OS-level lock must exclude a second holder even when the process-local
// claim is bypassed (stands in for a second agent process).
func TestLock_OSLevelExclusion(t *testing.T) {
	dir := t.TempDir()
	l1, err := AcquireLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l1.Release()
	f, err := os.OpenFile(filepath.Join(dir, LockFileName), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := lockFile(f); err == nil {
		t.Fatal("a second open file description must not get the lock")
	}
}

func TestLock_EmptyDirRejected(t *testing.T) {
	if _, err := AcquireLock(""); err == nil {
		t.Fatal("empty dir must error")
	}
}

func TestLock_NonRegularLockPathRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, LockFileName)); err != nil {
		t.Fatal(err)
	}
	l, err := AcquireLock(dir)
	if err == nil {
		l.Release()
		t.Fatal("a symlinked lock path must be refused, not followed")
	}
}

func TestStageSweep_RemovesStaleOnly(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	mk := func(name string, age time.Duration) string {
		p := filepath.Join(root, name)
		if err := os.Mkdir(p, 0o700); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(p, "breeze-agent-dev-1"), []byte("x"), 0o600)
		ts := now.Add(-age)
		if err := os.Chtimes(p, ts, ts); err != nil {
			t.Fatal(err)
		}
		return p
	}
	stale := mk(StageDirPrefix+"old", 2*time.Hour)
	fresh := mk(StageDirPrefix+"new", 10*time.Minute)
	foreign := mk("something-else", 48*time.Hour)

	removed := SweepStageDirs(root, time.Hour, now)
	if removed != 1 {
		t.Fatalf("removed=%d want 1", removed)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale attempt dir should be removed")
	}
	for _, p := range []string{fresh, foreign} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s should be kept: %v", p, err)
		}
	}
	if SweepStageDirs(filepath.Join(root, "missing"), time.Hour, now) != 0 {
		t.Fatal("missing root sweeps nothing")
	}
}

func TestNewAttemptDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "watchdog-stage")
	d, err := NewAttemptDir(root)
	if err != nil {
		t.Fatalf("NewAttemptDir: %v", err)
	}
	if filepath.Dir(d) != root || !strings.HasPrefix(filepath.Base(d), StageDirPrefix) {
		t.Fatalf("unexpected attempt dir %q", d)
	}
	if runtime.GOOS != "windows" {
		for _, p := range []string{root, d} {
			fi, err := os.Stat(p)
			if err != nil {
				t.Fatal(err)
			}
			if fi.Mode().Perm() != 0o700 {
				t.Fatalf("%s mode=%v want 0700", p, fi.Mode().Perm())
			}
		}
	}
	d2, err := NewAttemptDir(root)
	if err != nil || d2 == d {
		t.Fatalf("second attempt dir must be unique: %q %v", d2, err)
	}
}

func TestNewAttemptDir_RefusesSymlinkedRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "watchdog-stage")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := NewAttemptDir(link); err == nil {
		t.Fatal("a symlinked stage root must be refused")
	}
}

func TestNewAttemptDir_RefusesGroupWritableRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes only")
	}
	root := filepath.Join(t.TempDir(), "watchdog-stage")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := NewAttemptDir(root); err != nil {
		t.Fatalf("an over-permissive root we own is tightened, not fatal: %v", err)
	}
	fi, _ := os.Stat(root)
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("root not tightened: %v", fi.Mode().Perm())
	}
}
