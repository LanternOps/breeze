//go:build linux || darwin

package heartbeat

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// watchdogBinaryPathUnix is where the watchdog service binary lives on
// Linux/macOS (matches breeze-watchdog's own service install paths).
const watchdogBinaryPathUnix = "/usr/local/bin/breeze-watchdog"

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
