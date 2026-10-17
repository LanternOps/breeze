package heartbeat

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// A reservation that cannot be persisted aborts the attempt: a host with an
// unwritable config dir must never do unaccounted (unbounded) installs.
func TestReconcile_ReservationSaveFailureNeverAttempts(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs POSIX permissions and a non-root user")
	}
	dir := t.TempDir()
	// The lock file exists so the lock still works; the dir itself is read-only.
	if err := os.WriteFile(filepath.Join(dir, watchdoginstall.LockFileName), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.watchdogEnsure.stageRoot = filepath.Join(t.TempDir(), "stage")
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	for i := 0; i < 50; i++ {
		h.handleWatchdogUpgrade(ensureAgentVersion)
		f.advance(time.Hour)
	}
	if f.downloads.Load() != 0 || f.registers.Load() != 0 {
		t.Fatalf("unpersistable reservation still attempted: downloads=%d registers=%d", f.downloads.Load(), f.registers.Load())
	}
}

func TestReconcile_RegisterFailureIsInstallCmdAndBacksOff(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{registerErr: errors.New("watchdog service install exited with status 1")}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	rec := loadRec(t, dir)
	if rec.LastClass != watchdoginstall.ClassInstallCmd || rec.Terminal || rec.Attempts != 1 {
		t.Fatalf("want transient install_cmd, got %+v", rec)
	}
	f.advance(time.Minute)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.registers.Load() != 1 {
		t.Fatalf("must back off before NextAttemptAt: registers=%d", f.registers.Load())
	}
}

func TestReconcile_RegisterUnsupportedPassesThrough(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{registerErr: fmt.Errorf("x: %w", watchdoginstall.ErrUnsupportedOS)}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if rec := loadRec(t, dir); rec.LastClass != watchdoginstall.ClassUnsupportedOS || !rec.Terminal {
		t.Fatalf("want terminal unsupported_os, got %+v", rec)
	}
}

// An operator who opts out while a beat is already past the first opt-out
// check must not get an install: the marker is re-checked under the lock.
func TestReconcile_OptOutDuringAttemptIsHonoured(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	var calls atomic.Int32
	h.watchdogEnsure.now = func() time.Time {
		if calls.Add(1) == 1 { // first clock read happens after the first opt-out check
			_ = (watchdoginstall.Store{Dir: dir}).SetOptedOut(true)
		}
		return f.clock()
	}
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 0 || stateExists(dir) {
		t.Fatal("an opt-out recorded mid-beat must stop the attempt before it is reserved")
	}
}

func TestReconcile_ZeroedTokenIsUnenrolled(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.secureToken.Zero()
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 0 || stateExists(dir) {
		t.Fatal("zeroed token must not download or burn budget")
	}
}

func TestRunWatchdogInstallCommand_ErrorsAreBounded(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	err := runWatchdogInstallCommand(5*time.Second, "/bin/sh", "-c", "echo https://secret.example/x?token=abc; exit 3")
	if err == nil || err.Error() != "watchdog service install exited with status 3" {
		t.Fatalf("got %v", err)
	}
	err = runWatchdogInstallCommand(5*time.Second, filepath.Join(t.TempDir(), "missing"))
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a start failure must keep its cause (got %v)", err)
	}
	err = runWatchdogInstallCommand(200*time.Millisecond, "/bin/sh", "-c", "sleep 5")
	if err == nil || err.Error() != "watchdog service install timed out after 200ms" {
		t.Fatalf("got %v", err)
	}
}
