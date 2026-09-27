//go:build linux || darwin

package heartbeat

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// watchdogBinaryPath returns the on-disk path of the installed watchdog
// binary so the agent can read its version for heartbeat telemetry, and so
// a remote watchdog update knows where to write.
//
// On Linux this is always securefs.LegacyExecutableDir — Linux installs
// aren't relocated by this release. On macOS it prefers
// securefs.TrustedExecutableDir (where a migrated install's watchdog
// actually runs from) and falls back to the legacy path for a host that
// hasn't migrated yet, so this keeps working correctly across the upgrade.
func watchdogBinaryPath() (string, error) {
	if runtime.GOOS == "darwin" {
		trusted := securefs.TrustedExecutableDir + "/breeze-watchdog"
		if _, err := os.Stat(trusted); err == nil {
			return trusted, nil
		}
	}
	return securefs.LegacyExecutableDir + "/breeze-watchdog", nil
}

// replaceWatchdogBinaryUnix atomically swaps the watchdog binary at dest with
// the verified bytes at srcTemp. It copies into a sibling temp in dest's
// directory (so the final rename is same-filesystem and atomic) then renames
// over dest. Replacing the file of a RUNNING process is safe on POSIX — the
// running watchdog keeps its open inode until the service restart re-execs the
// new file. Mode is forced to 0755 so the service manager can execute it.
func replaceWatchdogBinaryUnix(srcTemp, dest string) error {
	src, err := os.Open(srcTemp)
	if err != nil {
		return fmt.Errorf("open downloaded watchdog: %w", err)
	}
	defer src.Close()

	destDir := filepath.Dir(dest)
	staging, err := os.CreateTemp(destDir, ".breeze-watchdog-*.new")
	if err != nil {
		return fmt.Errorf("create staging file in %s: %w", destDir, err)
	}
	stagingPath := staging.Name()
	// Best-effort cleanup if we bail before the rename.
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
	if err := os.Chmod(stagingPath, 0o755); err != nil {
		return fmt.Errorf("chmod staging watchdog: %w", err)
	}
	if err := os.Rename(stagingPath, dest); err != nil {
		return fmt.Errorf("rename watchdog into place: %w", err)
	}
	cleanup = false
	return nil
}
