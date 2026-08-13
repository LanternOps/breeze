package updater

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// swapCompanionBinary atomically installs pair.Temp at pair.Target using a
// same-directory staging file + rename, mirroring
// heartbeat.replaceWatchdogBinaryUnix. It is currently only used for the
// nu-backup companion binary on the Linux and macOS-fallback raw-binary
// upgrade paths (updateTo); Windows swaps its companions via the restart-helper
// PowerShell script instead (see restart_windows.go).
//
// pair.Temp is produced by DownloadBinary in the OS temp directory, which may
// be a different filesystem than pair.Target's directory — a direct
// os.Rename(pair.Temp, pair.Target) would then fail with EXDEV, so the bytes
// are copied into a sibling of pair.Target first (making the final rename
// same-filesystem and therefore atomic) rather than renamed directly. POSIX
// makes replacing a running process's file safe: the old inode stays open for
// whatever currently has it mapped/executing until that process exits, so
// this can run while the backup helper it's replacing is executing (though
// callers are expected to avoid that — see sessionbroker.StopBackupHelperIfIdle).
//
// On success pair.Temp is removed (its bytes now live at pair.Target). On
// failure pair.Temp is left in place for the caller to clean up and
// pair.Target is untouched.
func swapCompanionBinary(pair *BinaryPair) error {
	src, err := os.Open(pair.Temp)
	if err != nil {
		return fmt.Errorf("open downloaded binary: %w", err)
	}
	// Read-only handle: a close error carries nothing the caller can act on,
	// and the bytes have already been copied out by then. Explicitly discarded
	// so errcheck can tell "ignored on purpose" from "forgotten".
	defer func() { _ = src.Close() }()

	destDir := filepath.Dir(pair.Target)
	staging, err := os.CreateTemp(destDir, ".nu-backup-*.new")
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

	// On these two bail-outs the copy has already failed, so the staging file is
	// garbage that the deferred cleanup above is about to remove — a close error
	// would only mask the real error being returned. Discarded explicitly.
	if _, err := io.Copy(staging, src); err != nil {
		_ = staging.Close()
		return fmt.Errorf("copy binary bytes: %w", err)
	}
	if err := staging.Sync(); err != nil {
		_ = staging.Close()
		return fmt.Errorf("sync staging file: %w", err)
	}
	if err := staging.Close(); err != nil {
		return fmt.Errorf("close staging file: %w", err)
	}
	if err := os.Chmod(stagingPath, 0o755); err != nil {
		return fmt.Errorf("chmod staging file: %w", err)
	}
	if err := os.Rename(stagingPath, pair.Target); err != nil {
		return fmt.Errorf("rename into place: %w", err)
	}
	cleanup = false
	removeCleanup(pair.Temp)
	return nil
}
