package watchdoginstall

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// StageDirPrefix names the per-attempt directories under the stage root.
const StageDirPrefix = "breeze-watchdog-ensure-"

// StageRootName is the stage root's name inside the agent data dir
// (config.GetDataDir()). On Linux that is /var/lib/breeze, which is visible
// both to the running agent and to a systemd-run transient service (it is in
// ReadWritePaths of the legacy hardened unit and the current unit is
// unsandboxed), unlike the OS temp dir under a PrivateTmp unit.
const StageRootName = "watchdog-stage"

// NewAttemptDir creates root (0700) if needed, refuses a root that is a
// symlink or not a directory or (on Unix) not owned by this process's user,
// tightens its mode to 0700, and returns a fresh unique 0700 attempt dir in it.
func NewAttemptDir(root string) (string, error) {
	if root == "" {
		return "", errNoDir
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("create watchdog stage root: %w", err)
	}
	fi, err := os.Lstat(root)
	if err != nil {
		return "", fmt.Errorf("inspect watchdog stage root: %w", err)
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return "", fmt.Errorf("watchdog stage root %s is not a plain directory", root)
	}
	if err := checkStageRootOwner(fi); err != nil {
		return "", err
	}
	if fi.Mode().Perm() != 0o700 {
		if err := os.Chmod(root, 0o700); err != nil {
			return "", fmt.Errorf("tighten watchdog stage root: %w", err)
		}
	}
	d, err := os.MkdirTemp(root, StageDirPrefix+"*")
	if err != nil {
		return "", fmt.Errorf("create watchdog attempt dir: %w", err)
	}
	return d, nil
}

// SweepStageDirs removes attempt dirs under root older than olderThan (by
// mtime) — orphans of an attempt killed mid-download/install. Entries that do
// not carry StageDirPrefix are never touched. Returns how many were removed.
func SweepStageDirs(root string, olderThan time.Duration, now time.Time) int {
	if root == "" {
		return 0
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), StageDirPrefix) {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < olderThan {
			continue
		}
		if os.RemoveAll(filepath.Join(root, e.Name())) == nil {
			removed++
		}
	}
	return removed
}
