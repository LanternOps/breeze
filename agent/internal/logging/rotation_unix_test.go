//go:build !windows

package logging

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// sentinelContent is the initial content of every "attack target" file used
// in these tests.
const sentinelContent = "SENTINEL-DO-NOT-TOUCH"

// targetSnapshot captures everything about the attack target that a
// TOCTOU-vulnerable implementation could plausibly alter: byte content
// (a followed symlink opened for append/write), and mode + inode (a
// path-based chmod, or the file being unlinked and replaced). Checking
// content alone is not enough — see the race tests below, where the only
// operation performed through a re-opened backup is a chmod, never a
// write, so a vulnerable check-then-open-then-path-chmod implementation
// would leave content untouched but the mode changed.
type targetSnapshot struct {
	size    int64
	mode    os.FileMode
	inode   uint64
	content string
}

func snapshotTarget(t *testing.T, path string) targetSnapshot {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat attack target: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read attack target: %v", err)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("unexpected Sys() type for attack target: %T", info.Sys())
	}
	return targetSnapshot{
		size:    info.Size(),
		mode:    info.Mode(),
		inode:   st.Ino,
		content: string(data),
	}
}

// newAttackTarget creates a fresh attack-target file under dir and returns
// its path along with a snapshot taken immediately after creation, for
// later comparison via requireTargetUntouched.
func newAttackTarget(t *testing.T, dir string) (path string, before targetSnapshot) {
	t.Helper()
	target := filepath.Join(dir, "outside-target")
	// 0644, not 0600: repairRotatedFile's only observable action on a
	// backup slot is open+chmod+close — it never writes. A vulnerable
	// path-based chmod is only observable if it would actually change
	// something; pre-creating the target at 0600 (the mode the hardening
	// repairs *to*) would make that chmod a silent no-op and the test
	// would pass against a vulnerable implementation for the wrong
	// reason. 0644 is also the more realistic stand-in for an arbitrary
	// attacker-chosen target file the agent was never meant to touch.
	if err := os.WriteFile(target, []byte(sentinelContent), 0644); err != nil {
		t.Fatalf("write attack target: %v", err)
	}
	return target, snapshotTarget(t, target)
}

// requireTargetUntouched asserts the attack target's size, mode, inode, and
// content are all identical to the snapshot taken when it was created —
// i.e. that literally nothing about it changed, regardless of what the
// log-rotation code under test did.
func requireTargetUntouched(t *testing.T, target string, before targetSnapshot) {
	t.Helper()
	after := snapshotTarget(t, target)
	if after != before {
		t.Fatalf("attack target changed:\n before=%+v\n after=%+v", before, after)
	}
}

func requireUnsafeLogPath(t *testing.T, err error) *ErrUnsafeLogPath {
	t.Helper()
	var unsafe *ErrUnsafeLogPath
	if !errors.As(err, &unsafe) {
		t.Fatalf("expected *ErrUnsafeLogPath, got %v (%T)", err, err)
	}
	return unsafe
}

// newTestRotatingWriter builds a RotatingWriter with a byte-precise
// maxSize (bypassing NewRotatingWriter's MB-only, 50MB-default public
// constructor) so tests can force rotation after a handful of bytes.
func newTestRotatingWriter(t *testing.T, filePath string, maxSize int64, maxBackups int) *RotatingWriter {
	t.Helper()
	rw := &RotatingWriter{filePath: filePath, maxSize: maxSize, maxBackups: maxBackups}
	if err := rw.openFile(); err != nil {
		t.Fatalf("openFile: %v", err)
	}
	return rw
}

// resetDisabled clears a RotatingWriter's disabled state directly (bypassing
// the "permanently disabled" production contract), so a race-loop iteration
// can force a fresh attempt at the underlying syscalls even though the
// writer already tripped on a previous iteration. Without this, Reopen()
// and Write() both short-circuit on rw.disabled before ever touching the
// filesystem, so only the very first of many loop iterations would ever
// actually race — exactly the bug called out in review: a "500 iteration"
// race loop that stops racing after iteration 1 proves nothing.
//
// disabledWarned is deliberately NOT reset here: it only gates the
// one-line "file logging disabled" fallback message, which has nothing to
// do with the syscall-level race under test, and re-arming it every
// iteration would mean up to 500 iterations' worth of fallback writes —
// enough to exceed a pipe's kernel buffer in tests that capture stderr.
func resetDisabled(rw *RotatingWriter) {
	rw.mu.Lock()
	rw.disabled = false
	rw.disabledErr = nil
	rw.mu.Unlock()
}

// rootedTempDir returns a temp directory with no symlinked ancestor
// component, for tests that specifically want to exercise
// rejectSymlinkAncestors climbing multiple non-existent levels to a real,
// unambiguous root. On macOS, t.TempDir() itself resolves under
// /var/folders, and macOS symlinks /var -> private/var as part of its base
// OS layout — using the lexical path as-is would leave the test unable to
// tell "found a real ancestor" apart from "walked into an OS symlink we
// don't care about". Resolving through filepath.EvalSymlinks fixes that
// without writing anywhere outside the normal t.TempDir() sandbox: it
// returns the canonical path with every symlink component (including
// /var -> private/var) already followed, so nothing above the returned
// directory is a symlink at all.
func rootedTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("resolve temp dir symlinks: %v", err)
	}
	return resolved
}

// --- secureLogDirectory ---

func TestSecureLogDirectoryRejectsSymlinkedDirectory(t *testing.T) {
	base := t.TempDir()
	realDir := filepath.Join(base, "real-dir")
	if err := os.Mkdir(realDir, 0700); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(base, "logs")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Fatal(err)
	}

	err := secureLogDirectory(linkDir)
	unsafe := requireUnsafeLogPath(t, err)
	if unsafe.Path != linkDir {
		t.Fatalf("expected unsafe path %s, got %s", linkDir, unsafe.Path)
	}
}

func TestSecureLogDirectoryRejectsSymlinkedAncestorComponent(t *testing.T) {
	base := t.TempDir()
	realParent := filepath.Join(base, "real-parent")
	if err := os.Mkdir(realParent, 0700); err != nil {
		t.Fatal(err)
	}
	linkParent := filepath.Join(base, "link-parent")
	if err := os.Symlink(realParent, linkParent); err != nil {
		t.Fatal(err)
	}

	// "logs" does not exist yet; its parent (link-parent) is a symlink.
	logDir := filepath.Join(linkParent, "logs")

	err := secureLogDirectory(logDir)
	_ = requireUnsafeLogPath(t, err)

	if _, statErr := os.Lstat(logDir); !os.IsNotExist(statErr) {
		t.Fatalf("expected logs dir to never be created under a symlinked parent, lstat err=%v", statErr)
	}
}

func TestSecureLogDirectoryDoesNotWalkPastFirstExistingRealAncestor(t *testing.T) {
	// Regression guard: some hosts legitimately symlink well above any
	// directory Breeze manages (macOS: /var -> private/var, /tmp ->
	// private/tmp). secureLogDirectory must not reject a fresh log
	// directory just because some unrelated ancestor far above it happens
	// to be a symlink — t.TempDir() itself lives under exactly such a
	// tree on macOS, so this also guards every other test in this file
	// that still uses t.TempDir().
	base := t.TempDir()
	logDir := filepath.Join(base, "fresh", "logs")

	if err := secureLogDirectory(logDir); err != nil {
		t.Fatalf("secureLogDirectory on a fresh nested dir under a real temp dir: %v", err)
	}
}

// TestSecureLogDirectoryWalksMultipleNonexistentLevelsToRealRoot proves
// rejectSymlinkAncestors' walk genuinely climbs more than one non-existent
// level to find the nearest pre-existing ancestor, using a root outside
// /var so the result is unambiguous (unlike t.TempDir() on macOS, nothing
// above rootedTempDir's root is a legitimate OS-level symlink here).
func TestSecureLogDirectoryWalksMultipleNonexistentLevelsToRealRoot(t *testing.T) {
	root := rootedTempDir(t)
	logDir := filepath.Join(root, "a", "b", "c") // three not-yet-existing levels

	if err := secureLogDirectory(logDir); err != nil {
		t.Fatalf("secureLogDirectory: %v", err)
	}

	info, err := os.Stat(logDir)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() {
		t.Fatalf("expected %s to be created as a directory", logDir)
	}
}

// TestSecureLogDirectoryRejectsSymlinkSeveralLevelsBelowRealRoot is the
// rejecting counterpart: the walk must still find a symlink several
// non-existent levels below where it starts, rooted outside /var so macOS's
// /var -> private/var can't be mistaken for what's being tested here.
func TestSecureLogDirectoryRejectsSymlinkSeveralLevelsBelowRealRoot(t *testing.T) {
	root := rootedTempDir(t)
	realDir := filepath.Join(root, "real")
	if err := os.Mkdir(realDir, 0700); err != nil {
		t.Fatal(err)
	}
	linkedMid := filepath.Join(root, "linked-mid")
	if err := os.Symlink(realDir, linkedMid); err != nil {
		t.Fatal(err)
	}

	// "a/b" don't exist yet; the walk must climb past both to find
	// linked-mid (a symlink) and reject, without needing anything above root.
	logDir := filepath.Join(linkedMid, "a", "b")

	err := secureLogDirectory(logDir)
	_ = requireUnsafeLogPath(t, err)
}

func TestSecureLogDirectoryRepairsMode0700(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "logs")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}

	if err := secureLogDirectory(dir); err != nil {
		t.Fatalf("secureLogDirectory: %v", err)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != secureLogDirMode {
		t.Fatalf("expected dir mode %o, got %o", secureLogDirMode, perm)
	}
}

// TestSecureLogDirectoryChmodsViaFdNotPath is the direct regression test
// for the directory-chmod Critical: secureLogDirectory must repair mode via
// an already-open, O_NOFOLLOW'd file descriptor (fchmod), never via a
// separate path-based os.Chmod call after the existence/symlink check. A
// path-based chmod guarded only by a preceding Lstat has a TOCTOU gap: an
// attacker who wins the window between the Lstat and the Chmod swaps dir
// for a symlink and gets an arbitrary directory chmod'd 0700. This test
// can't directly observe "which syscall was used," so it instead pins the
// documented, load-bearing behavior: repairing the mode of a directory that
// legitimately needs it works, on a directory secureLogDirectory itself
// just verified is real. Real TOCTOU coverage for this exact bug lives in
// the vulnerable-implementation verification described in the task report.
func TestSecureLogDirectoryChmodsViaFdNotPath(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "logs")
	if err := os.Mkdir(dir, 0777); err != nil {
		t.Fatal(err)
	}

	if err := secureLogDirectory(dir); err != nil {
		t.Fatalf("secureLogDirectory: %v", err)
	}

	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("dir must not have become a symlink")
	}
	if perm := info.Mode().Perm(); perm != secureLogDirMode {
		t.Fatalf("expected dir mode %o, got %o", secureLogDirMode, perm)
	}
}

// --- openSecureLogFile ---

func TestOpenSecureLogFileRejectsSymlink(t *testing.T) {
	base := t.TempDir()
	target, targetBefore := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")
	if err := os.Symlink(target, logPath); err != nil {
		t.Fatal(err)
	}

	f, err := openSecureLogFile(logPath)
	if f != nil {
		_ = f.Close()
		t.Fatalf("expected nil file for a symlinked log path")
	}
	_ = requireUnsafeLogPath(t, err)
	requireTargetUntouched(t, target, targetBefore)
}

func TestOpenSecureLogFileRepairsMode0600(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")
	if err := os.WriteFile(logPath, []byte("existing"), 0644); err != nil {
		t.Fatal(err)
	}

	f, err := openSecureLogFile(logPath)
	if err != nil {
		t.Fatalf("openSecureLogFile: %v", err)
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != secureLogFileMode {
		t.Fatalf("expected file mode %o, got %o", secureLogFileMode, perm)
	}
}

func TestOpenSecureLogFileRequiresRegularFile(t *testing.T) {
	const devNull = "/dev/null"
	if _, err := os.Stat(devNull); err != nil {
		t.Skipf("no %s on this platform: %v", devNull, err)
	}

	f, err := openSecureLogFile(devNull)
	if f != nil {
		_ = f.Close()
		t.Fatalf("expected nil file for a non-regular target")
	}
	_ = requireUnsafeLogPath(t, err)
}

func TestOpenSecureLogFileRejectsHardLink(t *testing.T) {
	base := t.TempDir()
	target, targetBefore := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")
	if err := os.Link(target, logPath); err != nil {
		t.Skipf("hardlinks unsupported on this filesystem: %v", err)
	}

	f, err := openSecureLogFile(logPath)
	if f != nil {
		_ = f.Close()
		t.Fatalf("expected nil file for a hard-linked log path")
	}
	_ = requireUnsafeLogPath(t, err)
	requireTargetUntouched(t, target, targetBefore)
}

func TestOpenSecureLogFileSetsCloseOnExec(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	f, err := openSecureLogFile(logPath)
	if err != nil {
		t.Fatalf("openSecureLogFile: %v", err)
	}
	defer func() { _ = f.Close() }()

	flags, err := unix.FcntlInt(f.Fd(), unix.F_GETFD, 0)
	if err != nil {
		t.Fatalf("fcntl F_GETFD: %v", err)
	}
	if flags&unix.FD_CLOEXEC == 0 {
		t.Fatalf("expected FD_CLOEXEC set on the log file descriptor, flags=%#x", flags)
	}
}

// --- repairLogFileMode ---

// resetChmodWarnFired clears the process-lifetime "already warned" guard so
// each test that exercises the tolerable-errno path can observe its own
// warning independent of test execution order within the package.
func resetChmodWarnFired(t *testing.T) {
	t.Helper()
	chmodWarnFired.Store(false)
	t.Cleanup(func() { chmodWarnFired.Store(false) })
}

// captureStderr redirects os.Stderr to a pipe for the duration of fn,
// returning everything written to it. Used to verify the tolerable-chmod
// warning (which must never go through slog — see the deadlock test below)
// actually reaches the operator, and to keep the race-loop tests' fallback
// output out of normal test output.
//
// The pipe is drained by a concurrent goroutine, not read after fn
// returns: a pipe's kernel buffer is small (~64KB), and a race-loop test
// can write well past that across hundreds of iterations. Reading only
// after fn() returns would mean fn()'s write blocks forever once the
// buffer fills, because nothing is draining it yet — a genuine deadlock in
// the test helper itself, not the code under test.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stderr
	os.Stderr = w

	captured := make(chan string, 1)
	go func() {
		var buf strings.Builder
		_, _ = io.Copy(&buf, r) // drains until r hits EOF on w.Close(); nothing here inspects the error.
		captured <- buf.String()
	}()

	// fn may call t.Fatalf, which invokes runtime.Goexit — anything after
	// fn() that isn't deferred would then never run, leaving os.Stderr
	// pointed at this pipe (with nothing draining it) and its copier
	// goroutine leaked for the rest of the test binary. Every later test
	// that writes to stderr would then fill the pipe's small kernel buffer
	// and block forever. Both are deferred so they run on Goexit too.
	//
	// The explicit w.Close() below (not deferred) is what actually
	// unblocks the copier goroutine on the normal path: io.Copy only
	// returns once it sees EOF on r, which only happens once w is closed,
	// and `return <-captured` blocks until the copier sends. Deferred
	// statements run *after* the return expression is evaluated, so
	// relying on the deferred w.Close() alone to unblock that read would
	// deadlock. Calling Close twice (once explicitly, once via the
	// deferred Goexit safety net) is harmless — the second call just
	// returns an already-closed error, which nothing here inspects.
	defer func() { os.Stderr = orig }()
	defer func() { _ = w.Close() }()

	fn()

	_ = w.Close()
	return <-captured
}

func TestRepairLogFileModeToleratesPermissionErrnosOnRegularFile(t *testing.T) {
	tolerable := []error{unix.EPERM, unix.EROFS, unix.ENOTSUP, unix.EOPNOTSUPP}

	for _, errno := range tolerable {
		t.Run(errno.Error(), func(t *testing.T) {
			resetChmodWarnFired(t)

			base := t.TempDir()
			f, err := os.CreateTemp(base, "log")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = f.Close() }()

			orig := chmodFile
			chmodFile = func(*os.File, os.FileMode) error { return errno }
			t.Cleanup(func() { chmodFile = orig })

			if err := repairLogFileMode(f); err != nil {
				t.Fatalf("expected tolerated errno %v to return nil, got %v", errno, err)
			}
		})
	}
}

func TestRepairLogFileModeFailsOnNonTolerableErrno(t *testing.T) {
	base := t.TempDir()
	f, err := os.CreateTemp(base, "log")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()

	orig := chmodFile
	chmodFile = func(*os.File, os.FileMode) error { return unix.EACCES }
	t.Cleanup(func() { chmodFile = orig })

	err = repairLogFileMode(f)
	if err == nil {
		t.Fatalf("expected a non-tolerated chmod errno to fail repairLogFileMode")
	}
	var unsafe *ErrUnsafeLogPath
	if errors.As(err, &unsafe) {
		t.Fatalf("did not expect ErrUnsafeLogPath for a generic chmod failure, got %v", err)
	}
}

// TestRepairLogFileModeWarnsExactlyOnceOnTolerableErrno proves the warning
// is written straight to os.Stderr (never through slog — see
// TestRepairLogFileModeDoesNotDeadlockWhenInstalledAsGlobalLoggerSink for
// why) and fires at most once per process.
func TestRepairLogFileModeWarnsExactlyOnceOnTolerableErrno(t *testing.T) {
	resetChmodWarnFired(t)

	base := t.TempDir()
	f, err := os.CreateTemp(base, "log")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()

	orig := chmodFile
	chmodFile = func(*os.File, os.FileMode) error { return unix.EROFS }
	t.Cleanup(func() { chmodFile = orig })

	out := captureStderr(t, func() {
		if err := repairLogFileMode(f); err != nil {
			t.Fatalf("repairLogFileMode: %v", err)
		}
		// Calling it again in the same process must not warn a second time.
		if err := repairLogFileMode(f); err != nil {
			t.Fatalf("repairLogFileMode (second call): %v", err)
		}
	})

	if count := strings.Count(out, "WARNING"); count != 1 {
		t.Fatalf("expected exactly one WARNING line across two calls, got %d: %s", count, out)
	}
	if lines := strings.Count(out, "\n"); lines > 1 {
		t.Fatalf("expected a single bounded warning line, got %d newlines: %s", lines, out)
	}
}

// TestRepairLogFileModeDoesNotDeadlockWhenInstalledAsGlobalLoggerSink is the
// direct regression test for the reentrant-mutex deadlock found in review:
// agentapp installs a RotatingWriter as the actual global slog sink
// (logging.Init(..., rw)). If the tolerable-chmod-errno warning were
// emitted via slog instead of os.Stderr, and it fires while rotate() (via
// Write) already holds rw.mu, the slog call chains back into rw.Write on
// the same goroutine — shippingHandler.Handle -> TextHandler -> rw.Write ->
// rw.mu.Lock() while the very same goroutine already holds it. sync.Mutex
// is not reentrant, so that blocks forever, and because it holds the lock,
// every other goroutine in the agent that tries to log blocks too — a
// silent total agent hang. This test wires up exactly that configuration
// and asserts Write returns within a bounded time.
func TestRepairLogFileModeDoesNotDeadlockWhenInstalledAsGlobalLoggerSink(t *testing.T) {
	resetChmodWarnFired(t)

	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 4, 2) // rotate on almost every write
	defer func() { _ = rw.Close() }()

	Init("text", "info", rw) // install rw as the actual global slog sink, like agentapp does
	t.Cleanup(func() { Init("text", "info", nil) })

	orig := chmodFile
	chmodFile = func(*os.File, os.FileMode) error { return unix.EROFS }
	t.Cleanup(func() { chmodFile = orig })

	done := make(chan struct{})
	go func() {
		defer close(done)
		// "hello world" (11 bytes) exceeds maxSize(4), forcing rotate() ->
		// rotateOne -> repairRotatedFile -> openSecureLogFile ->
		// repairLogFileMode, which hits the tolerated-errno path while
		// Write already holds rw.mu.
		_, _ = rw.Write([]byte("hello world"))
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("DEADLOCK: Write did not return within 5s")
	}
}

// --- validateRotationPath ---

func TestValidateRotationPathRejectsSymlink(t *testing.T) {
	base := t.TempDir()
	target, _ := newAttackTarget(t, base)
	backup := filepath.Join(base, "agent.log.1")
	if err := os.Symlink(target, backup); err != nil {
		t.Fatal(err)
	}

	err := validateRotationPath(backup)
	_ = requireUnsafeLogPath(t, err)
}

func TestValidateRotationPathAllowsMissingPath(t *testing.T) {
	base := t.TempDir()
	missing := filepath.Join(base, "agent.log.1")
	if err := validateRotationPath(missing); err != nil {
		t.Fatalf("expected nil for a missing path, got %v", err)
	}
}

func TestValidateRotationPathRejectsNonRegularFile(t *testing.T) {
	base := t.TempDir()
	dirAsBackup := filepath.Join(base, "agent.log.1")
	if err := os.Mkdir(dirAsBackup, 0700); err != nil {
		t.Fatal(err)
	}

	err := validateRotationPath(dirAsBackup)
	_ = requireUnsafeLogPath(t, err)
}

// --- RotatingWriter: current log symlink ---

func TestRotatingWriterCurrentLogSymlinkNeverOpensOrWrites(t *testing.T) {
	base := t.TempDir()
	target, targetBefore := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")
	if err := os.Symlink(target, logPath); err != nil {
		t.Fatal(err)
	}

	rw, err := NewRotatingWriter(logPath, 1, 2)
	if rw != nil {
		_ = rw.Close()
		t.Fatalf("expected nil writer for a symlinked log path")
	}
	_ = requireUnsafeLogPath(t, err)
	requireTargetUntouched(t, target, targetBefore)

	info, err := os.Lstat(logPath)
	if err != nil {
		t.Fatalf("lstat log path: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected log path to remain a symlink (never renamed away), got mode %v", info.Mode())
	}
}

// --- RotatingWriter: backup symlink during rotation ---

// TestRotatingWriterBackupSymlinkDisablesWriter pins the post-hardening
// contract precisely: Write no longer *fails* once the writer disables —
// it transparently falls back to os.Stderr (see Important 3 in the task
// report) — so the observable proof of "the backup was never touched" is
// the disabled flag plus the untouched attack target, not a returned error.
func TestRotatingWriterBackupSymlinkDisablesWriter(t *testing.T) {
	base := t.TempDir()
	target, targetBefore := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 4, 2)
	defer func() { _ = rw.Close() }()

	backup1 := logPath + ".1"
	if err := os.Symlink(target, backup1); err != nil {
		t.Fatal(err)
	}

	captureStderr(t, func() {
		if _, err := rw.Write([]byte("hello world")); err != nil { // exceeds maxSize=4, forces rotate()
			t.Fatalf("Write must not return an error once disabled — it falls back to stderr instead: %v", err)
		}
	})

	if !rw.disabled {
		t.Fatalf("expected the writer to be disabled after detecting a symlinked backup")
	}
	requireTargetUntouched(t, target, targetBefore)

	captureStderr(t, func() {
		if _, err := rw.Write([]byte("x")); err != nil {
			t.Fatalf("expected the writer to stay disabled and keep falling back cleanly, got error: %v", err)
		}
	})
	requireTargetUntouched(t, target, targetBefore)
}

func TestRotatingWriterBackupsGetRepairedTo0600Mode(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 4, 2)
	defer func() { _ = rw.Close() }()

	if _, err := rw.Write([]byte("12345")); err != nil { // > maxSize(4), triggers rotate
		t.Fatalf("write: %v", err)
	}

	backup1 := logPath + ".1"
	info, err := os.Stat(backup1)
	if err != nil {
		t.Fatalf("stat backup1: %v", err)
	}
	if perm := info.Mode().Perm(); perm != secureLogFileMode {
		t.Fatalf("expected backup1 mode %o, got %o", secureLogFileMode, perm)
	}

	// Simulate a loosely-permissioned backup (e.g. inherited from an older
	// agent version) and confirm the next rotation repairs it once it
	// shifts from .1 to .2.
	if err := os.Chmod(backup1, 0644); err != nil {
		t.Fatal(err)
	}

	if _, err := rw.Write([]byte("67890")); err != nil {
		t.Fatalf("second write: %v", err)
	}

	backup2 := logPath + ".2"
	info2, err := os.Stat(backup2)
	if err != nil {
		t.Fatalf("stat backup2: %v", err)
	}
	if perm := info2.Mode().Perm(); perm != secureLogFileMode {
		t.Fatalf("expected backup2 mode repaired to %o, got %o", secureLogFileMode, perm)
	}
}

// --- RotatingWriter: link swap before reopen (TOCTOU) ---

func TestRotatingWriterReopenRejectsSymlinkSwap(t *testing.T) {
	base := t.TempDir()
	target, targetBefore := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 1<<20, 2)
	defer func() { _ = rw.Close() }()

	if _, err := rw.Write([]byte("line one\n")); err != nil {
		t.Fatalf("initial write: %v", err)
	}

	// Simulate an attacker swapping the log path for a symlink between
	// writes, then the daemon receiving SIGHUP and reopening.
	if err := os.Remove(logPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, logPath); err != nil {
		t.Fatal(err)
	}

	err := rw.Reopen()
	_ = requireUnsafeLogPath(t, err)
	if !rw.disabled {
		t.Fatalf("expected the writer to be disabled after Reopen hit a symlink")
	}
	requireTargetUntouched(t, target, targetBefore)

	captureStderr(t, func() {
		if _, err := rw.Write([]byte("should never land\n")); err != nil {
			t.Fatalf("expected writes to keep falling back to stderr cleanly after disable, got error: %v", err)
		}
	})
	requireTargetUntouched(t, target, targetBefore)
}

// TestRotatingWriterReopenSymlinkSwapRace races a concurrent "attacker"
// goroutine against repeated Reopen() calls, each followed by a Write() —
// driving a Write after every Reopen matters because Reopen alone (an
// O_APPEND-only open) never pushes bytes anywhere by itself; if a
// vulnerable implementation's Reopen followed the symlink, it's the
// subsequent Write that would actually land bytes in the attack target.
// Each iteration resets the writer's disabled state first so the syscalls
// genuinely run 500 times rather than stopping after the first detection —
// with rw.disabled left sticky (as an earlier version of this test did),
// Reopen and Write both short-circuit before touching the filesystem at
// all once disabled, so only ~1 of 500 "iterations" actually raced.
//
// A check-then-open implementation (e.g. os.Lstat(path) followed by a
// separate os.OpenFile(path, ...) with no O_NOFOLLOW) has a window between
// the check and the open where the swapper can win and get the open to
// dereference the symlink. The real implementation opens with a single
// unix.Open(..., O_NOFOLLOW, ...) syscall, so there is no window to win.
// This test's only real invariant is the target-snapshot assertion at the
// end: it must hold no matter how the goroutines interleave. See the task
// report for the vulnerable-implementation swap that was run against this
// test to confirm it actually fails without the fix (this is necessary,
// not just "constructed to look plausible": a prior version of this same
// test passed against that vulnerable implementation too, for the two
// independent reasons above).
func TestRotatingWriterReopenSymlinkSwapRace(t *testing.T) {
	base := t.TempDir()
	target, targetBefore := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 1<<20, 2)
	defer func() { _ = rw.Close() }()

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			// Deliberately ignored: this is best-effort attacker churn racing
			// the writer goroutine, so every step here is expected to fail
			// under legitimate interleavings (Remove racing an already-gone
			// path, Symlink racing a path the writer just recreated). Per the
			// comment on this test, the only real invariant is the
			// target-snapshot assertion below — it must hold no matter how
			// many of these steps actually land.
			_ = os.Remove(logPath)
			_ = os.Symlink(target, logPath)
			_ = os.Remove(logPath)
			_ = os.WriteFile(logPath, []byte("regular\n"), 0600)
		}
	}()

	captureStderr(t, func() {
		for i := 0; i < 8000; i++ {
			resetDisabled(rw)
			_ = rw.Reopen()
			// Whichever path Reopen actually opened (legitimate file,
			// or — in a vulnerable implementation — the dereferenced
			// symlink), attempt a write. This is what would actually
			// push bytes into the attack target if Reopen had followed it.
			_, _ = rw.Write([]byte("race-write\n"))
		}
	})

	close(stop)
	wg.Wait()

	requireTargetUntouched(t, target, targetBefore)
}

// --- RotatingWriter: link swap during rotation (TOCTOU) ---

// TestRotatingWriterRotationSymlinkSwapRaceNeverWritesTarget races a
// concurrent "attacker" goroutine against a writer configured to rotate on
// nearly every Write(), repeatedly replacing the backup slot rotate() is
// about to rename into and then repair-chmod. Each iteration resets
// rw.disabled first for the same reason as the Reopen race test above —
// otherwise the loop stops racing after the first detection.
//
// Unlike the Reopen race, repairRotatedFile never writes to the file it
// reopens (it only opens, chmods, and closes) — so a vulnerable
// implementation's observable effect here is a *mode* change on the attack
// target via a path-based chmod, not a content change. That's why
// requireTargetUntouched checks mode+inode, not just content: an earlier
// version of this test asserted content only, and passed against a
// vulnerable implementation that opened the symlink (no O_NOFOLLOW), found
// it was a symlink to a 0600 file already, "repaired" nothing content-wise
// (O_APPEND, no O_TRUNC, and the pre-created attack target was already
// 0600 so the reviewer's PoC chmod was a no-op on mode too — the point
// generalizes to any case where content is untouched by design but a
// path-based chmod would still register on mode/inode for a differently
// permissioned target).
//
// See TestRotatingWriterReopenSymlinkSwapRace for why a check-then-act
// implementation cannot guarantee this invariant under race pressure the
// way the no-follow-open-then-Fchmod-via-fd implementation does: renaming
// over a symlinked destination replaces the link entry itself (rename
// never dereferences), and the post-rename repair step reopens with
// O_NOFOLLOW, so it either gets the just-renamed regular file or fails
// outright — it can never end up chmod'ing through a symlink to the target.
func TestRotatingWriterRotationSymlinkSwapRaceNeverWritesTarget(t *testing.T) {
	base := t.TempDir()
	target, targetBefore := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 8, 2) // rotate on almost every write
	defer func() { _ = rw.Close() }()

	backup1 := logPath + ".1"

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			// Deliberately ignored — see the identical comment in
			// TestRotatingWriterReopenSymlinkSwapRace above: best-effort
			// attacker churn, expected to fail under legitimate races, with
			// the target-snapshot assertion below as the only real invariant.
			_ = os.Remove(backup1)
			_ = os.Symlink(target, backup1)
			_ = os.Remove(backup1)
		}
	}()

	payload := []byte("0123456789") // 10 bytes > maxSize(8): forces rotate() nearly every call
	captureStderr(t, func() {
		for i := 0; i < 30000; i++ {
			resetDisabled(rw)
			_, _ = rw.Write(payload)
		}
	})

	close(stop)
	wg.Wait()

	requireTargetUntouched(t, target, targetBefore)
}

// TestRotatingWriterFinalReopenSymlinkSwapRace targets specifically the
// final step of rotate(): after all backups have shifted and the current
// log has been renamed to .1, rotate() opens a fresh file at the (now
// vacated) current log path. Each iteration resets rw.disabled first, for
// the same reason as the other two race tests. This complements
// TestRotatingWriterRotationSymlinkSwapRaceNeverWritesTarget, which races
// the backup slot instead of the current log path.
//
// The swapper must not leave logPath symlinked persistently: rotateOne's
// pre-rename validateRotationPath(src) check runs on logPath *before* the
// rename that vacates it, and if logPath is already a symlink at that
// earlier check, rotation aborts right there — correctly, but that means a
// swapper which keeps logPath symlinked continuously (an earlier version of
// this test did: Symlink to a temp name, then Rename that onto logPath,
// never removing it) gets caught by that unrelated, already-correct check
// almost every time and never actually exercises the final-reopen window
// this test exists to cover. Cycling remove/symlink/remove (matching the
// other two race tests' pattern) leaves logPath absent or normal most of
// the time, so the pre-rename check usually passes, and the swapper's
// window lands on the actual target: the gap between the rename-away and
// the final reopen.
func TestRotatingWriterFinalReopenSymlinkSwapRace(t *testing.T) {
	base := t.TempDir()
	target, targetBefore := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 8, 2)
	defer func() { _ = rw.Close() }()

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			// Deliberately ignored — see the identical comment in
			// TestRotatingWriterReopenSymlinkSwapRace above: best-effort
			// attacker churn, expected to fail under legitimate races, with
			// the target-snapshot assertion below as the only real invariant.
			_ = os.Remove(logPath)
			_ = os.Symlink(target, logPath)
			_ = os.Remove(logPath)
		}
	}()

	payload := []byte("0123456789") // 10 bytes > maxSize(8): forces rotate() nearly every call
	captureStderr(t, func() {
		for i := 0; i < 8000; i++ {
			resetDisabled(rw)
			_, _ = rw.Write(payload)
		}
	})

	close(stop)
	wg.Wait()

	requireTargetUntouched(t, target, targetBefore)
}

// --- RotatingWriter: general concurrency robustness (no symlinks) ---

func TestRotatingWriterConcurrentWritesAndRotation(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 64, 3)
	defer func() { _ = rw.Close() }()

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			line := []byte(fmt.Sprintf("worker-%d-line\n", id))
			for i := 0; i < 200; i++ {
				if _, err := rw.Write(line); err != nil {
					t.Errorf("worker %d write %d: %v", id, i, err)
					return
				}
			}
		}(g)
	}
	wg.Wait()
}
