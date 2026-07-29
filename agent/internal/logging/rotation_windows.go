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
