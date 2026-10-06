//go:build !windows

package tools

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// resolveForContainment resolves cleanPath through any symlinks, returning
// false only when nothing along the path can be resolved at all.
//
// filepath.EvalSymlinks requires EVERY component including the leaf to exist,
// which is never true for a write destination — so a naive
// `EvalSymlinks(path); if err == nil` check silently no-ops on exactly the case
// enforceWriteContainment cares about. That left a real bypass: with a
// pre-existing symlinked PARENT (/tmp/innocent -> ~/.ssh),
// WriteFile("/tmp/innocent/authorized_keys") passed both legs of the check —
// the literal string carries no "/.ssh/" to match, and EvalSymlinks errored on
// the missing leaf so the symlink leg never ran — and implanted the key.
//
// So walk up to the nearest ancestor that EXISTS and re-attach the unresolved
// remainder. That also covers destinations several levels below a symlink,
// which WriteFile/RenameFile/CopyFile happily MkdirAll into.
//
// Two properties of this loop are load-bearing, and an earlier version of this
// fix got both wrong by capping the iteration count at a constant:
//
//   - NO DEPTH CAP. The caller controls the destination string, so any fixed
//     cap is a bypass, not a safety valve: padding the path with more junk
//     segments than the cap ("<link>/a/a/a/…/authorized_keys") exhausts the
//     budget before the resolvable ancestor is reached, the function reports
//     "could not resolve", and EnforcePathContainment reads that as "nothing to
//     check" — reopening the exact hole. Termination needs no cap: each step
//     strictly shortens the path and the loop exits at the root.
//   - CHEAP PROBE, ONE RESOLVE. The ascent probes with os.Lstat (one syscall
//     per level) and calls EvalSymlinks once, on the ancestor that exists.
//     Calling EvalSymlinks on every level instead is quadratic in path depth,
//     which hands the same attacker a CPU-exhaustion knob.
func resolveForContainment(cleanPath string) (string, bool) {
	current := cleanPath
	remainder := ""
	for {
		if _, err := os.Lstat(current); err == nil {
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", false
			}
			if remainder != "" {
				resolved = filepath.Join(resolved, remainder)
			}
			return resolved, true
		}
		parent, base := filepath.Split(current)
		if base == "" {
			return "", false
		}
		remainder = filepath.Join(base, remainder)
		parent = filepath.Clean(parent)
		if parent == current {
			return "", false
		}
		current = parent
	}
}

// pinnedEntry is the entry a rename or delete acts on. Unix has no
// rename-by-descriptor, so these keep operating on the path exactly as before;
// the Windows build pins the entry with a handle instead.
type pinnedEntry struct{ path string }

func pinEntry(_ string, cleanPath string, _ bool) (*pinnedEntry, error) {
	return &pinnedEntry{path: cleanPath}, nil
}

func (e *pinnedEntry) close() {}

func (e *pinnedEntry) renameTo(newPath string, _, _ bool) error { return os.Rename(e.path, newPath) }

func (e *pinnedEntry) remove() error { return os.Remove(e.path) }

func (e *pinnedEntry) removeAll() error { return os.RemoveAll(e.path) }

// handleCheckMandatory: platforms other than Windows run the open-handle
// check as an extra layer on top of the path check, and skip it when the
// kernel cannot name the descriptor (e.g. /proc not mounted).
const handleCheckMandatory = false

// containmentFinalPathOfFile is where the kernel says an open descriptor is.
func containmentFinalPathOfFile(f *os.File) (string, error) { return finalPathOfFile(f) }

// openForReadShared opens p for reading. On Unix this is a plain open; the
// Windows build adds FILE_SHARE_DELETE so a concurrent delete handle on the
// same file does not block the read.
func openForReadShared(p string) (*os.File, error) { return os.Open(p) }

// isCrossDeviceError reports a rename that failed only because source and
// destination are on different filesystems.
func isCrossDeviceError(err error) bool { return errors.Is(err, syscall.EXDEV) }
