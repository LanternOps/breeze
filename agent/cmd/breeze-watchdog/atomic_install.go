//go:build linux || darwin

package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// atomicRename is a test seam so a test can inject a failure after the temp
// file has been fully written.
var atomicRename = os.Rename

// installBinaryAtomically copies src to dst via a sibling temp file and an
// atomic rename, so a crash or power loss mid-copy never leaves a torn binary
// at dst (which Restart=always / KeepAlive would crash-loop on). On any
// failure the temp is removed and dst is left untouched.
//
// This intentionally mirrors replaceWatchdogBinaryUnix in
// internal/heartbeat/watchdog_install_unix.go to avoid a cross-package
// dependency; keep the two in sync.
func installBinaryAtomically(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open source binary: %w", err)
	}
	defer func() { _ = in.Close() }() // read-only handle

	dir := filepath.Dir(dst)
	staging, err := os.CreateTemp(dir, ".breeze-watchdog-*.new")
	if err != nil {
		return fmt.Errorf("create staging file in %s: %w", dir, err)
	}
	stagingPath := staging.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(stagingPath)
		}
	}()

	if _, err := io.Copy(staging, in); err != nil {
		_ = staging.Close() // already failing; original error is returned
		return fmt.Errorf("copy binary bytes: %w", err)
	}
	if err := staging.Sync(); err != nil {
		_ = staging.Close() // already failing; original error is returned
		return fmt.Errorf("sync staging binary: %w", err)
	}
	if err := staging.Close(); err != nil {
		return fmt.Errorf("close staging binary: %w", err)
	}
	if err := os.Chmod(stagingPath, 0o755); err != nil {
		return fmt.Errorf("chmod staging binary: %w", err)
	}
	if err := atomicRename(stagingPath, dst); err != nil {
		return fmt.Errorf("rename binary into place: %w", err)
	}
	cleanup = false
	return nil
}

// writeFileAtomically writes data to dst via a sibling temp file (fsync, chmod,
// atomic rename). On failure the temp is removed and dst is left untouched.
func writeFileAtomically(dst string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(dst)
	staging, err := os.CreateTemp(dir, "."+filepath.Base(dst)+"-*.new")
	if err != nil {
		return fmt.Errorf("create staging file in %s: %w", dir, err)
	}
	stagingPath := staging.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(stagingPath)
		}
	}()

	if _, err := staging.Write(data); err != nil {
		_ = staging.Close() // already failing; original error is returned
		return fmt.Errorf("write staging file: %w", err)
	}
	if err := staging.Sync(); err != nil {
		_ = staging.Close() // already failing; original error is returned
		return fmt.Errorf("sync staging file: %w", err)
	}
	if err := staging.Close(); err != nil {
		return fmt.Errorf("close staging file: %w", err)
	}
	if err := os.Chmod(stagingPath, mode); err != nil {
		return fmt.Errorf("chmod staging file: %w", err)
	}
	if err := atomicRename(stagingPath, dst); err != nil {
		return fmt.Errorf("rename file into place: %w", err)
	}
	cleanup = false
	return nil
}
