//go:build windows

package logging

import (
	"fmt"
	"os"
)

// secureLogDirectory creates dir if needed. Unix's symlink-rejection and
// mode-repair hardening (P1-AGENT-LOG-001) is Unix-specific; Windows keeps
// its pre-existing os.MkdirAll behavior unchanged.
func secureLogDirectory(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create log directory %s: %w", dir, err)
	}
	return nil
}

// openSecureLogFile opens path with the same os.OpenFile flags the Windows
// agent has always used. No no-follow/regular-file/chmod hardening is
// applied here — that hardening is Unix-specific.
func openSecureLogFile(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return nil, fmt.Errorf("open log file %s: %w", path, err)
	}
	return f, nil
}

// repairLogFileMode is a no-op on Windows: there is no chmod-repair step in
// the pre-existing Windows behavior.
func repairLogFileMode(file *os.File) error {
	return nil
}

// validateRotationPath is a no-op on Windows: there is no symlink-rejection
// step in the pre-existing Windows rotation behavior.
func validateRotationPath(path string) error {
	return nil
}

// rotationStepFatal restores the pre-hardening Windows behavior for a
// single rotate() step (renaming one backup slot, or the post-rename
// repair-open of that slot): never abort the whole rotation over it.
//
// Before this task, rotate() called os.Rename for each backup slot and
// discarded the error entirely, then unconditionally proceeded to reopen
// the current log — a sharing violation on one locked backup (routine on
// Windows: the log shipper, an AV scanner, or a tail viewer can have any of
// these files open) just meant that slot silently didn't rotate this time.
// The shared, platform-agnostic rotate() in rotation.go now checks
// rotationStepFatal for every such error; returning false here for any
// error preserves that original "skip and continue" semantics — it must
// not become "abort rotation and start failing every subsequent Write,"
// which rw.written never resetting would otherwise cause. See
// rotation_unix.go's counterpart, which is fatal for every error, matching
// this task's Unix-specific hardening intent.
func rotationStepFatal(err error) bool {
	return false
}
