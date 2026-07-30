//go:build !windows

package logging

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"

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
//
// The final check-and-repair step opens dir itself with O_NOFOLLOW and
// chmods via that file descriptor (fchmod), never by path — an earlier
// version here did os.Lstat(dir) followed by a separate, path-based
// os.Chmod(dir, ...), which is exactly the TOCTOU gap this task exists to
// close: an attacker who wins the window between the Lstat and the Chmod
// swaps dir for a symlink and gets an arbitrary directory chmod'd 0700.
func secureLogDirectory(dir string) error {
	if err := rejectSymlinkAncestors(dir); err != nil {
		return err
	}

	if err := os.MkdirAll(dir, secureLogDirMode); err != nil {
		return fmt.Errorf("create log directory %s: %w", dir, err)
	}

	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			return &ErrUnsafeLogPath{Path: dir, Reason: "log directory path is a symlink"}
		}
		if errors.Is(err, unix.ENOTDIR) {
			return &ErrUnsafeLogPath{Path: dir, Reason: "log directory path is not a directory"}
		}
		return fmt.Errorf("open log directory %s: %w", dir, err)
	}

	f := os.NewFile(uintptr(fd), dir)
	if f == nil {
		// Reclaim the descriptor; the close error is unactionable here.
		_ = unix.Close(fd)
		return fmt.Errorf("open log directory %s: os.NewFile failed", dir)
	}
	// Directory handle is only used for Stat/Fchmod below.
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat log directory %s: %w", dir, err)
	}
	if !info.IsDir() {
		return &ErrUnsafeLogPath{Path: dir, Reason: "log directory path is not a directory"}
	}

	if info.Mode().Perm() != secureLogDirMode {
		if err := f.Chmod(secureLogDirMode); err != nil {
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
// Narrowed guarantee, stated precisely: in steady state — the log
// directory already exists, which is true on every run after the first —
// this walk finds `dir` itself as the first pre-existing component and
// returns immediately. It then contributes nothing beyond the direct
// Lstat/open that secureLogDirectory already performs on dir. Its entire
// incremental value is the first-run case, where the log directory doesn't
// exist yet: it verifies the nearest existing ancestor (the directory
// MkdirAll is about to create into) isn't a symlink before creating
// anything under it.
//
// Stopping at the first pre-existing component (rather than continuing to
// the filesystem root) is deliberate, but the original justification for
// this repo overstated the production risk: Breeze's actual configured log
// directories (/var/log/breeze on Linux, /Library/Application
// Support/Breeze/logs on macOS) don't have a symlinked ancestor in normal
// deployments — /Library is a genuine top-level directory. What a
// root-to-leaf walk actually breaks is test infrastructure: t.TempDir()
// resolves under /var/folders on macOS, and macOS symlinks /var ->
// private/var as part of its base OS layout, which a full walk would flag
// as a false positive. Some minimal/immutable-root Linux distributions and
// containers do symlink ancestors above wherever an application manages
// its own directories, so bounding the walk is still the right general
// policy — it just isn't defending a specific known Breeze production
// path today.
//
// Residual exposure: an attacker able to replace or symlink an ancestor
// directory of the log directory already needs write access to that
// ancestor's parent, which on stock deployments (0755 root-owned
// /var/log, /Library) requires root or an existing privilege-equivalent
// misconfiguration — this check is defense-in-depth layered on top of
// already-required elevated access, not an independently exploitable gap
// on its own. The load-bearing, race-proof guarantee remains the
// O_NOFOLLOW open of the leaf directory/file itself (see
// secureLogDirectory's final open and openSecureLogFile below), which
// holds regardless of what sits above it.
//
// This is a check-then-create step: it narrows the window before
// os.MkdirAll, but cannot itself be atomic (MkdirAll dereferences
// intermediate components).
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
// file with exactly one hard link, and repairs its mode to 0600. The caller
// is responsible for having already secured the containing directory
// (secureLogDirectory).
func openSecureLogFile(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_WRONLY|unix.O_APPEND|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, uint32(secureLogFileMode))
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			// ELOOP means O_NOFOLLOW refused to dereference a symlink
			// somewhere in path resolution — usually the final component,
			// but it can also be an ancestor directory (e.g. a symlink
			// loop) that secureLogDirectory didn't independently catch for
			// this exact call site (repairRotatedFile calls this directly
			// for backup paths without re-running the directory check).
			return nil, &ErrUnsafeLogPath{Path: path, Reason: "path is a symlink, or resolves through a symlinked ancestor, and was refused by O_NOFOLLOW"}
		}
		return nil, fmt.Errorf("open log file %s: %w", path, err)
	}

	f := os.NewFile(uintptr(fd), path)
	if f == nil {
		// Reclaim the descriptor; the close error is unactionable here.
		_ = unix.Close(fd)
		return nil, fmt.Errorf("open log file %s: os.NewFile failed", path)
	}

	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("stat log file %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, &ErrUnsafeLogPath{Path: path, Reason: "log file is not a regular file"}
	}
	// O_NOFOLLOW stops a symlink at this path, but not a hardlink planted
	// here that points at a different, attacker-chosen inode (e.g. a link
	// to /etc/shadow named agent.log). A regular file we manage should
	// always have exactly one link.
	if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Nlink != 1 {
		_ = f.Close()
		return nil, &ErrUnsafeLogPath{Path: path, Reason: "log file has multiple hard links"}
	}

	if err := repairLogFileMode(f); err != nil {
		_ = f.Close()
		return nil, err
	}

	return f, nil
}

// chmodWarnFired guards the tolerable-chmod-errno warning (see
// repairLogFileMode) so it fires at most once per process. This is a plain
// atomic (not sync.Once) specifically so tests can reset it between cases;
// production code only ever transitions it false->true.
var chmodWarnFired atomic.Bool

// repairLogFileMode chmods an already-open, already-verified-regular file
// to 0600 via its file descriptor (never the path). A permission-repair
// error equal to EPERM, EROFS, ENOTSUP, or EOPNOTSUPP is tolerated with
// exactly one prominent, process-lifetime-bounded warning IF the file is
// confirmed regular and non-symlink (which the caller — openSecureLogFile —
// guarantees before calling this). Any other error fails the caller.
//
// The warning is written directly to os.Stderr with fmt.Fprintf, never
// through the logging package's slog handlers. This function can run while
// RotatingWriter.mu is held (openFile/rotate call it via
// openSecureLogFile), and logging.Init may have installed this very
// RotatingWriter as the global slog sink (agentapp does this for every log
// file it opens). Routing this warning through slog would call back into
// rw.Write on the same goroutine that already holds rw.mu — sync.Mutex is
// not reentrant, so that call would block forever, hanging every other
// goroutine in the agent that tries to log. Writing straight to os.Stderr
// cannot recurse into any RotatingWriter, by construction. It is also
// bounded to fire once per process (not once per call) — on a filesystem
// that persistently returns a tolerable errno, this function runs on every
// open plus every backup on every rotation, and logging the same warning
// each time would itself grow the log file and trigger more rotations.
func repairLogFileMode(file *os.File) error {
	err := chmodFile(file, secureLogFileMode)
	if err == nil {
		return nil
	}

	if isTolerableChmodErrno(err) {
		if chmodWarnFired.CompareAndSwap(false, true) {
			fmt.Fprintf(os.Stderr,
				"breeze-agent: WARNING log file permission repair unsupported on this filesystem (path=%s reason=%s); continuing without chmod 0600\n",
				file.Name(), err)
		}
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

// rotationStepFatal reports whether an error from a single rotate() step —
// renaming one backup slot, or the post-rename repair-open of that slot —
// should abort the whole rotation (and, for an unsafe path, disable the
// writer) or be silently skipped so rotation continues with the next slot.
//
// Unix treats every such error as fatal: the entire point of this file's
// hardening is to never silently continue past an unverified path. See
// rotation_windows.go's counterpart, which restores the pre-hardening
// Windows behavior of ignoring a single slot's rename/open failure (e.g. a
// sharing violation because the log shipper or an AV/tail viewer has the
// file open) instead of aborting rotation for the whole file. Called from
// the shared, platform-agnostic rotate() in rotation.go.
func rotationStepFatal(err error) bool {
	return err != nil
}
