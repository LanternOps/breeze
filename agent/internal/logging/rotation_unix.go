//go:build !windows

package logging

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

const (
	secureLogDirMode  os.FileMode = 0700
	secureLogFileMode os.FileMode = 0600
)

// chmodFile performs the actual mode repair on an already-open file. It is
// a variable (rather than a direct file.Chmod call) so tests can inject
// EPERM/EROFS/ENOTSUP/EOPNOTSUPP failures deterministically without needing
// a real read-only or exotic filesystem. In production this is always
// file.Chmod, which chmods via the file descriptor (fchmod), never the
// path — so it cannot be redirected by a symlink swapped in after open.
var chmodFile = func(f *os.File, mode os.FileMode) error {
	return f.Chmod(mode)
}

// secureLogDirectory ensures dir exists, contains no symlink in any
// existing ancestor path component, is not itself a symlink, and is mode
// 0700. Path components that don't exist yet are fine — MkdirAll creates
// them. Called before every open/reopen and before rotation.
func secureLogDirectory(dir string) error {
	if err := rejectSymlinkAncestors(dir); err != nil {
		return err
	}

	if err := os.MkdirAll(dir, secureLogDirMode); err != nil {
		return fmt.Errorf("create log directory %s: %w", dir, err)
	}

	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("lstat log directory %s: %w", dir, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return &ErrUnsafeLogPath{Path: dir, Reason: "log directory path is a symlink"}
	}
	if !info.IsDir() {
		return &ErrUnsafeLogPath{Path: dir, Reason: "log directory path is not a directory"}
	}

	if info.Mode().Perm() != secureLogDirMode {
		if err := os.Chmod(dir, secureLogDirMode); err != nil {
			return fmt.Errorf("repair log directory mode %s: %w", dir, err)
		}
	}

	return nil
}

// rejectSymlinkAncestors walks up from dir (dir itself, then its parent, and
// so on) and Lstats each component until it finds the first one that
// already exists. Components that don't exist yet are skipped — MkdirAll
// will create them fresh, so there's nothing an attacker could have
// pre-planted there. The first pre-existing component found is checked: a
// symlink there is rejected; a real directory is treated as the trust
// boundary and the walk stops without climbing further.
//
// Stopping at the first pre-existing component (rather than continuing to
// the filesystem root) is deliberate: several hosts legitimately symlink
// well above anywhere Breeze manages (macOS symlinks /var -> private/var
// and /tmp -> private/tmp as part of the base OS layout), and treating
// those as an attack would break logging on stock installs. The realistic
// attack this defends against is a symlink planted at or immediately above
// the log directory this process actually creates/manages — not the host's
// own pre-existing filesystem layout.
//
// This is a check-then-create step: it narrows the window before
// os.MkdirAll, but cannot itself be atomic (MkdirAll dereferences
// intermediate components). The authoritative, race-proof guarantee comes
// from the O_NOFOLLOW open of the final log file and the no-follow reopen
// of every rotation backup — this check is defense-in-depth against a
// symlink already sitting in the path before we ever touch it.
func rejectSymlinkAncestors(dir string) error {
	cur := filepath.Clean(dir)
	for {
		info, err := os.Lstat(cur)
		if err != nil {
			if os.IsNotExist(err) {
				parent := filepath.Dir(cur)
				if parent == cur {
					return nil // reached the root; nothing along the way exists yet
				}
				cur = parent
				continue
			}
			return fmt.Errorf("lstat %s: %w", cur, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return &ErrUnsafeLogPath{Path: cur, Reason: "log directory path component is a symlink"}
		}
		return nil // first pre-existing component is a real (non-symlink) entry; trust boundary
	}
}

// openSecureLogFile opens path for append-only writing without following a
// symlink at the final path component, verifies the result is a regular
// file, and repairs its mode to 0600. The caller is responsible for having
// already secured the containing directory (secureLogDirectory).
func openSecureLogFile(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_WRONLY|unix.O_APPEND|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, uint32(secureLogFileMode))
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			return nil, &ErrUnsafeLogPath{Path: path, Reason: "log file is a symlink"}
		}
		return nil, fmt.Errorf("open log file %s: %w", path, err)
	}

	f := os.NewFile(uintptr(fd), path)
	if f == nil {
		unix.Close(fd)
		return nil, fmt.Errorf("open log file %s: os.NewFile failed", path)
	}

	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("stat log file %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return nil, &ErrUnsafeLogPath{Path: path, Reason: "log file is not a regular file"}
	}

	if err := repairLogFileMode(f); err != nil {
		f.Close()
		return nil, err
	}

	return f, nil
}

// repairLogFileMode chmods an already-open, already-verified-regular file
// to 0600 via its file descriptor (never the path). A permission-repair
// error equal to EPERM, EROFS, ENOTSUP, or EOPNOTSUPP is tolerated with
// exactly one prominent, bounded warning IF the file is confirmed regular
// and non-symlink (which the caller — openSecureLogFile — guarantees before
// calling this). Any other error fails the caller.
func repairLogFileMode(file *os.File) error {
	err := chmodFile(file, secureLogFileMode)
	if err == nil {
		return nil
	}

	if isTolerableChmodErrno(err) {
		slog.Warn("log file permission repair unsupported on this filesystem, continuing without chmod 0600",
			"path", file.Name(), "reason", err.Error())
		return nil
	}

	return fmt.Errorf("repair log file mode %s: %w", file.Name(), err)
}

func isTolerableChmodErrno(err error) bool {
	return errors.Is(err, unix.EPERM) ||
		errors.Is(err, unix.EROFS) ||
		errors.Is(err, unix.ENOTSUP) ||
		errors.Is(err, unix.EOPNOTSUPP)
}

// validateRotationPath rejects a path that is a symlink (or sits behind a
// symlinked ancestor directory component) before rotation renames or
// reopens it. A path that does not exist yet is not an error — the rename
// or open that follows will create it.
func validateRotationPath(path string) error {
	if err := rejectSymlinkAncestors(filepath.Dir(path)); err != nil {
		return err
	}

	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("lstat %s: %w", path, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return &ErrUnsafeLogPath{Path: path, Reason: "rotation path is a symlink"}
	}
	if !info.Mode().IsRegular() {
		return &ErrUnsafeLogPath{Path: path, Reason: "rotation path is not a regular file"}
	}

	return nil
}
