package logging

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// ErrUnsafeLogPath indicates that a log path (the active log file, its
// directory, or a rotation backup) could not be safely opened, renamed, or
// permission-repaired because a symlink was found where a regular file or
// directory was expected. Closes P1-AGENT-LOG-001: on Unix, anything that
// can pre-create a symlink at the agent's log path (or a rotation backup
// path) must not be able to make the agent write, truncate, or chmod a file
// it did not intend to touch.
type ErrUnsafeLogPath struct {
	// Path is the filesystem path that failed the safety check.
	Path string
	// Reason is a short, secret-free, human-readable explanation.
	Reason string
}

func (e *ErrUnsafeLogPath) Error() string {
	return fmt.Sprintf("unsafe log path %q: %s", e.Path, e.Reason)
}

// RotatingWriter is a size-based log file rotator.
// It implements io.Writer and is safe for concurrent use.
//
// All filesystem operations (opening, reopening, and rotating the log file)
// go through platform helpers (secureLogDirectory, openSecureLogFile,
// repairLogFileMode, validateRotationPath) defined in rotation_unix.go and
// rotation_windows.go. This file only owns locking and sequencing; it must
// stay platform-agnostic.
type RotatingWriter struct {
	mu         sync.Mutex
	file       *os.File
	filePath   string
	maxSize    int64 // bytes
	maxBackups int
	written    int64

	// disabled is set once an unsafe path is detected (current log or a
	// rotation backup resolves to a symlink). Once set, the writer never
	// renames, truncates, chmods, or writes to the target again — the
	// caller must construct a new RotatingWriter after resolving the
	// underlying condition.
	disabled    bool
	disabledErr error
	// disabledWarned tracks whether the one-time "file logging disabled"
	// warning has already been written to os.Stderr for this writer (see
	// writeDisabledFallback).
	disabledWarned bool
}

// NewRotatingWriter creates a writer that rotates when maxSizeMB is exceeded.
// maxBackups controls how many old log files to keep.
func NewRotatingWriter(filePath string, maxSizeMB int, maxBackups int) (*RotatingWriter, error) {
	if maxSizeMB <= 0 {
		maxSizeMB = 50
	}
	if maxBackups <= 0 {
		maxBackups = 3
	}

	rw := &RotatingWriter{
		filePath:   filePath,
		maxSize:    int64(maxSizeMB) * 1024 * 1024,
		maxBackups: maxBackups,
	}

	if err := rw.openFile(); err != nil {
		return nil, err
	}

	return rw, nil
}

// Write implements io.Writer. Rotates the file if maxSize is exceeded.
//
// Once the writer is disabled (an unsafe log path was detected), Write
// never returns an error for "the file is unavailable" — it transparently
// redirects every write to os.Stderr instead. Losing all logging is a
// worse failure than losing file logging: in the common no-console
// deployment shape (systemd/launchd/Windows service — see
// agentapp.initLogging), this RotatingWriter is the *only* configured slog
// sink, with no os.Stderr tee. Before this fallback existed, a disable
// triggered at runtime (e.g. an attacker planting a symlink at a rotation
// backup slot mid-run, which is only possible because of the very
// hardening this task adds) would make every subsequent log line vanish
// silently system-wide — slog discards handler errors, so nothing would
// ever surface the condition.
func (rw *RotatingWriter) Write(p []byte) (int, error) {
	rw.mu.Lock()
	defer rw.mu.Unlock()

	if rw.disabled {
		return rw.writeDisabledFallback(p)
	}

	if rw.written+int64(len(p)) > rw.maxSize {
		if err := rw.rotate(); err != nil {
			if rw.disabled {
				return rw.writeDisabledFallback(p)
			}
			return 0, fmt.Errorf("log rotation: %w", err)
		}
	}

	n, err := rw.file.Write(p)
	rw.written += int64(n)
	return n, err
}

// writeDisabledFallback is used once the writer has been permanently
// disabled. It never touches filePath again, but writes p to os.Stderr
// instead of dropping it, preceded by exactly one bounded warning
// explaining why. Callers using TeeWriter(os.Stderr, rw) will see each line
// duplicated on stderr once disabled (the tee's first leg already wrote it
// before reaching rw) — an accepted, purely cosmetic tradeoff against the
// alternative of silent log loss in the no-tee configuration.
func (rw *RotatingWriter) writeDisabledFallback(p []byte) (int, error) {
	if !rw.disabledWarned {
		rw.disabledWarned = true
		fmt.Fprintf(os.Stderr, "breeze-agent: WARNING file logging disabled (%s); falling back to stderr for all further log output\n", rw.disabledErr)
	}
	return os.Stderr.Write(p)
}

// Reopen closes and reopens the log file (for SIGHUP handling). If the log
// path is found to be unsafe (e.g. a symlink was swapped in since the file
// was last opened), the writer is disabled and never touches the path
// again; callers must construct a new RotatingWriter once the condition is
// resolved.
func (rw *RotatingWriter) Reopen() error {
	rw.mu.Lock()
	defer rw.mu.Unlock()

	if rw.disabled {
		return rw.disabledErr
	}

	if rw.file != nil {
		// Best-effort: we are already disabling file output because the path is
		// unsafe or the writer failed, so a Close error changes nothing.
		_ = rw.file.Close()
		rw.file = nil
	}

	if err := rw.openFile(); err != nil {
		return rw.fail(err)
	}
	return nil
}

// Close closes the underlying file.
func (rw *RotatingWriter) Close() error {
	rw.mu.Lock()
	defer rw.mu.Unlock()

	if rw.file != nil {
		err := rw.file.Close()
		rw.file = nil
		return err
	}
	return nil
}

// TeeWriter returns an io.Writer that writes to both w1 and w2.
func TeeWriter(w1, w2 io.Writer) io.Writer {
	return io.MultiWriter(w1, w2)
}

// fail records a rotation/open/reopen failure. Callers must hold rw.mu. It
// always closes and clears any stale file handle so a later Write never
// operates on an already-closed fd. When err is (or wraps) *ErrUnsafeLogPath
// — a symlink was found at the current log path or a rotation backup — the
// writer is permanently disabled: it never renames, truncates, chmods, or
// writes to filePath again, and the caller must construct a new
// RotatingWriter once the underlying condition is resolved. Other
// (transient I/O) errors are returned without disabling the writer, so a
// later size-triggered rotate() or an explicit Reopen() can retry once the
// condition clears.
func (rw *RotatingWriter) fail(err error) error {
	if rw.file != nil {
		// Best-effort: we are disabling file output anyway, so a Close error
		// changes nothing.
		_ = rw.file.Close()
		rw.file = nil
	}

	var unsafe *ErrUnsafeLogPath
	if errors.As(err, &unsafe) {
		rw.disabled = true
		rw.disabledErr = err
	}

	return err
}

// openFile secures the log directory and opens/creates the log file via the
// platform helpers, then records the current size for rotation accounting.
func (rw *RotatingWriter) openFile() error {
	dir := filepath.Dir(rw.filePath)
	if err := secureLogDirectory(dir); err != nil {
		return err
	}

	f, err := openSecureLogFile(rw.filePath)
	if err != nil {
		return err
	}

	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("stat log file: %w", err)
	}

	rw.file = f
	rw.written = info.Size()
	return nil
}

// rotate performs size-based rotation: shift existing numbered backups up by
// one slot, move the current log to .1, then open a fresh current log. Every
// path involved is validated immediately before it is touched (rename,
// open, or chmod) so a symlink swapped in at any point — including mid-loop
// — is caught before any bytes are written, renamed, or chmod'd through it.
// On the first sign of an unsafe path, rotation stops and the writer is
// disabled; it never proceeds to touch the offending path or any path after
// it.
func (rw *RotatingWriter) rotate() error {
	if rw.disabled {
		return rw.disabledErr
	}

	if rw.file != nil {
		// Best-effort: the handle is being replaced; a Close error on the old
		// one does not affect the new one.
		_ = rw.file.Close()
		rw.file = nil
	}

	dir := filepath.Dir(rw.filePath)
	if err := secureLogDirectory(dir); err != nil {
		return rw.fail(err)
	}

	// Shift existing backups: .maxBackups -> removed, ..., .1 -> .2
	//
	// A rotateOne error is only fatal to the whole rotation per
	// rotationStepFatal, which is platform-specific: Unix aborts on any
	// error (never silently continue past an unverified path); Windows
	// preserves its pre-hardening behavior of skipping a single slot whose
	// rename or post-rename repair-open hit a sharing violation (routine
	// there — the log shipper, an AV scanner, or a tail viewer can have
	// any of these files open) rather than aborting rotation for the
	// whole file and then failing every subsequent Write forever (rw.written
	// is never reset by a failed rotate).
	for i := rw.maxBackups; i >= 2; i-- {
		src := rw.backupName(i - 1)
		dst := rw.backupName(i)
		if i == rw.maxBackups {
			os.Remove(dst)
		}
		if err := rotateOne(src, dst); err != nil && rotationStepFatal(err) {
			return rw.fail(err)
		}
	}

	// Move current log to .1
	if err := rotateOne(rw.filePath, rw.backupName(1)); err != nil && rotationStepFatal(err) {
		return rw.fail(err)
	}

	// Open a fresh current log. A failure here — including one caused by a
	// symlink swapped into filePath in the instant between the rename
	// above and this open — must disable the writer exactly like any other
	// unsafe-path detection; openFile/openSecureLogFile below already
	// carries that classification through rw.fail via errors.As.
	if err := rw.openFile(); err != nil {
		return rw.fail(err)
	}
	return nil
}

// rotateOne validates and renames a single src -> dst rotation step, then
// repairs the destination's mode. A missing src is not an error (nothing to
// rotate for that slot yet).
func rotateOne(src, dst string) error {
	if _, err := os.Lstat(src); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("lstat %s: %w", src, err)
	}

	// Validate immediately before the rename to keep the check-to-act
	// window as narrow as possible.
	if err := validateRotationPath(src); err != nil {
		return err
	}
	if err := validateRotationPath(dst); err != nil {
		return err
	}

	if err := os.Rename(src, dst); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("rotate %s -> %s: %w", src, dst, err)
	}

	// The rename replaces whatever direntry was at dst with src's inode,
	// so dst cannot still be the pre-rename symlink. But a racing
	// attacker could swap dst back to a symlink between the rename above
	// and this repair step, so repair opens with no-follow (never
	// dereferencing) and bails out via ErrUnsafeLogPath if it finds one.
	return repairRotatedFile(dst)
}

// repairRotatedFile reopens a just-rotated backup with the same no-follow,
// regular-file-only checks as the live log file, repairing its mode to
// 0600. It never writes to the file — only opens (to obtain a safe fd) and
// closes it.
//
// openSecureLogFile's O_CREAT means it would happily create a fresh empty
// file if path no longer exists (e.g. something removed it in the instant
// between the rename that just placed it there and this call) — an
// Lstat check first turns that into "nothing to repair" instead of a
// stray empty backup silently appearing.
func repairRotatedFile(path string) error {
	if _, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("lstat %s: %w", path, err)
	}

	f, err := openSecureLogFile(path)
	if err != nil {
		return err
	}
	return f.Close()
}

func (rw *RotatingWriter) backupName(index int) string {
	if index == 0 {
		return rw.filePath
	}
	return fmt.Sprintf("%s.%d", rw.filePath, index)
}
