//go:build windows

package heartbeat

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/serviceinstall"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const windowsWatchdogServiceName = "BreezeWatchdog"

// installAndRestartWatchdog downloads the verified watchdog binary and swaps it
// into the protected Program Files location. Windows holds an exclusive lock on
// a running .exe, so unlike the Unix path this must STOP the service before
// replacing the file, then START it again. The agent runs as LocalSystem, so it
// can drive the SCM and write to the protected directory.
func (h *Heartbeat) installAndRestartWatchdog(targetVersion string) error {
	tempPath, err := h.downloadWatchdogBinary(targetVersion)
	if err != nil {
		return fmt.Errorf("download watchdog: %w", err)
	}
	defer func() { _ = os.Remove(tempPath) }()

	dest, err := serviceinstall.ProtectedBinaryPath("breeze-watchdog.exe")
	if err != nil {
		return fmt.Errorf("resolve protected watchdog path: %w", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(windowsWatchdogServiceName)
	if err != nil {
		return fmt.Errorf("open service %q: %w", windowsWatchdogServiceName, err)
	}
	defer s.Close()

	// Stop the service so the .exe is unlocked (ignore the control error — it
	// may already be stopped), then wait for it to actually reach Stopped.
	_, _ = s.Control(svc.Stop)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		st, qErr := s.Query()
		if qErr != nil {
			return fmt.Errorf("query service state: %w", qErr)
		}
		if st.State == svc.Stopped {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if err := replaceWatchdogBinaryWindows(tempPath, dest); err != nil {
		// Best effort: bring the service back up on the OLD binary so a failed
		// swap doesn't leave the watchdog down.
		_ = s.Start()
		return err
	}

	if err := s.Start(); err != nil {
		return fmt.Errorf("start service %q after swap: %w", windowsWatchdogServiceName, err)
	}
	return nil
}

// replaceWatchdogBinaryWindows copies the verified bytes at srcTemp over dest.
// The service is already stopped by the caller, so the file is no longer locked.
// Copies into a sibling staging file then renames over dest (Go's os.Rename uses
// MoveFileEx with replace-existing on Windows).
func replaceWatchdogBinaryWindows(srcTemp, dest string) error {
	src, err := os.Open(srcTemp)
	if err != nil {
		return fmt.Errorf("open downloaded watchdog: %w", err)
	}
	defer src.Close()

	staging, err := os.CreateTemp(filepath.Dir(dest), "breeze-watchdog-*.new")
	if err != nil {
		return fmt.Errorf("create staging file: %w", err)
	}
	stagingPath := staging.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(stagingPath)
		}
	}()

	if _, err := io.Copy(staging, src); err != nil {
		staging.Close()
		return fmt.Errorf("copy watchdog bytes: %w", err)
	}
	if err := staging.Sync(); err != nil {
		staging.Close()
		return fmt.Errorf("sync staging watchdog: %w", err)
	}
	if err := staging.Close(); err != nil {
		return fmt.Errorf("close staging watchdog: %w", err)
	}
	if err := os.Rename(stagingPath, dest); err != nil {
		return fmt.Errorf("rename watchdog into place: %w", err)
	}
	cleanup = false
	return nil
}
