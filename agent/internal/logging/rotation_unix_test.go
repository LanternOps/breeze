//go:build !windows

package logging

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

// sentinelContent is written to every "attack target" file used in these
// tests. Any test that swaps in a symlink asserts this content is still
// exactly what's there afterward — proving zero bytes reached the target
// through the symlink, regardless of what the log-rotation code did.
const sentinelContent = "SENTINEL-DO-NOT-TOUCH"

func newAttackTarget(t *testing.T, dir string) string {
	t.Helper()
	target := filepath.Join(dir, "outside-target")
	if err := os.WriteFile(target, []byte(sentinelContent), 0600); err != nil {
		t.Fatalf("write attack target: %v", err)
	}
	return target
}

func requireTargetUntouched(t *testing.T, target string) {
	t.Helper()
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read attack target: %v", err)
	}
	if string(got) != sentinelContent {
		t.Fatalf("symlink target was modified: got %q, want %q", got, sentinelContent)
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
	requireUnsafeLogPath(t, err)

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
	// tree on macOS, so this also guards every other test in this file.
	base := t.TempDir()
	logDir := filepath.Join(base, "fresh", "logs")

	if err := secureLogDirectory(logDir); err != nil {
		t.Fatalf("secureLogDirectory on a fresh nested dir under a real temp dir: %v", err)
	}
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

// --- openSecureLogFile ---

func TestOpenSecureLogFileRejectsSymlink(t *testing.T) {
	base := t.TempDir()
	target := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")
	if err := os.Symlink(target, logPath); err != nil {
		t.Fatal(err)
	}

	f, err := openSecureLogFile(logPath)
	if f != nil {
		f.Close()
		t.Fatalf("expected nil file for a symlinked log path")
	}
	requireUnsafeLogPath(t, err)
	requireTargetUntouched(t, target)
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
	defer f.Close()

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
		f.Close()
		t.Fatalf("expected nil file for a non-regular target")
	}
	requireUnsafeLogPath(t, err)
}

func TestOpenSecureLogFileSetsCloseOnExec(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	f, err := openSecureLogFile(logPath)
	if err != nil {
		t.Fatalf("openSecureLogFile: %v", err)
	}
	defer f.Close()

	flags, err := unix.FcntlInt(f.Fd(), unix.F_GETFD, 0)
	if err != nil {
		t.Fatalf("fcntl F_GETFD: %v", err)
	}
	if flags&unix.FD_CLOEXEC == 0 {
		t.Fatalf("expected FD_CLOEXEC set on the log file descriptor, flags=%#x", flags)
	}
}

// --- repairLogFileMode ---

func TestRepairLogFileModeToleratesPermissionErrnosOnRegularFile(t *testing.T) {
	tolerable := []error{unix.EPERM, unix.EROFS, unix.ENOTSUP, unix.EOPNOTSUPP}

	for _, errno := range tolerable {
		t.Run(errno.Error(), func(t *testing.T) {
			base := t.TempDir()
			f, err := os.CreateTemp(base, "log")
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()

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
	defer f.Close()

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

func TestRepairLogFileModeWarnsExactlyOnceOnTolerableErrno(t *testing.T) {
	var buf strings.Builder
	Init("text", "info", &buf)
	t.Cleanup(func() { Init("text", "info", nil) })

	base := t.TempDir()
	f, err := os.CreateTemp(base, "log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	orig := chmodFile
	chmodFile = func(*os.File, os.FileMode) error { return unix.EROFS }
	t.Cleanup(func() { chmodFile = orig })

	if err := repairLogFileMode(f); err != nil {
		t.Fatalf("repairLogFileMode: %v", err)
	}

	out := buf.String()
	if count := strings.Count(out, "level=WARN"); count != 1 {
		t.Fatalf("expected exactly one WARN record, got %d: %s", count, out)
	}
	if lines := strings.Count(out, "\n"); lines > 1 {
		t.Fatalf("expected a single bounded warning line, got %d newlines: %s", lines, out)
	}
}

// --- validateRotationPath ---

func TestValidateRotationPathRejectsSymlink(t *testing.T) {
	base := t.TempDir()
	target := newAttackTarget(t, base)
	backup := filepath.Join(base, "agent.log.1")
	if err := os.Symlink(target, backup); err != nil {
		t.Fatal(err)
	}

	err := validateRotationPath(backup)
	requireUnsafeLogPath(t, err)
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
	requireUnsafeLogPath(t, err)
}

// --- RotatingWriter: current log symlink ---

func TestRotatingWriterCurrentLogSymlinkNeverOpensOrWrites(t *testing.T) {
	base := t.TempDir()
	target := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")
	if err := os.Symlink(target, logPath); err != nil {
		t.Fatal(err)
	}

	rw, err := NewRotatingWriter(logPath, 1, 2)
	if rw != nil {
		rw.Close()
		t.Fatalf("expected nil writer for a symlinked log path")
	}
	requireUnsafeLogPath(t, err)
	requireTargetUntouched(t, target)

	info, err := os.Lstat(logPath)
	if err != nil {
		t.Fatalf("lstat log path: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected log path to remain a symlink (never renamed away), got mode %v", info.Mode())
	}
}

// --- RotatingWriter: backup symlink during rotation ---

func TestRotatingWriterBackupSymlinkDisablesWriter(t *testing.T) {
	base := t.TempDir()
	target := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 4, 2)
	defer rw.Close()

	backup1 := logPath + ".1"
	if err := os.Symlink(target, backup1); err != nil {
		t.Fatal(err)
	}

	_, err := rw.Write([]byte("hello world")) // exceeds maxSize=4, forces rotate()
	if err == nil {
		t.Fatalf("expected the write to fail once rotation hits the symlinked backup")
	}
	requireUnsafeLogPath(t, err)

	if !rw.disabled {
		t.Fatalf("expected the writer to be disabled after detecting a symlinked backup")
	}
	requireTargetUntouched(t, target)

	if _, err := rw.Write([]byte("x")); err == nil {
		t.Fatalf("expected the writer to stay disabled — it must never quietly recover")
	}
	requireTargetUntouched(t, target)
}

func TestRotatingWriterBackupsGetRepairedTo0600Mode(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 4, 2)
	defer rw.Close()

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
	target := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 1<<20, 2)
	defer rw.Close()

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
	requireUnsafeLogPath(t, err)
	if !rw.disabled {
		t.Fatalf("expected the writer to be disabled after Reopen hit a symlink")
	}
	requireTargetUntouched(t, target)

	if _, err := rw.Write([]byte("should never land\n")); err == nil {
		t.Fatalf("expected writes to keep failing after disable")
	}
	requireTargetUntouched(t, target)
}

// TestRotatingWriterReopenSymlinkSwapRace races a concurrent "attacker"
// goroutine against repeated Reopen() calls. A check-then-open
// implementation (e.g. os.Lstat(path) followed by a separate
// os.OpenFile(path, ...) with no O_NOFOLLOW) has a window between the check
// and the open where the swapper can win and get the open to dereference
// the symlink, appending/creating through it. The real implementation opens
// with a single unix.Open(..., O_NOFOLLOW, ...) syscall, so there is no
// window to win — no interleaving of the swapper goroutine can make it
// dereference the symlink. This test's only real invariant is the target
// content assertion at the end: it must hold no matter how the goroutines
// interleave, which is exactly what a TOCTOU implementation cannot
// guarantee under -race scheduling pressure.
func TestRotatingWriterReopenSymlinkSwapRace(t *testing.T) {
	base := t.TempDir()
	target := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 1<<20, 2)
	defer rw.Close()

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
			os.Remove(logPath)
			os.Symlink(target, logPath)
			os.Remove(logPath)
			os.WriteFile(logPath, []byte("regular\n"), 0600)
		}
	}()

	for i := 0; i < 500; i++ {
		_ = rw.Reopen()
		if rw.disabled {
			break
		}
	}

	close(stop)
	wg.Wait()

	requireTargetUntouched(t, target)
}

// --- RotatingWriter: link swap during rotation (TOCTOU) ---

// TestRotatingWriterRotationSymlinkSwapRace races a concurrent "attacker"
// goroutine against a writer configured to rotate on nearly every Write(),
// repeatedly replacing the backup slot rotate() is about to rename into and
// then repair-chmod. See TestRotatingWriterReopenSymlinkSwapRace for why a
// check-then-act implementation cannot guarantee this invariant under race
// pressure the way the no-follow-open-then-Fchmod-via-fd implementation
// does: renaming over a symlinked destination replaces the link entry
// itself (rename never dereferences), and the post-rename repair step
// reopens with O_NOFOLLOW, so it either gets the just-renamed regular file
// or fails outright — it can never end up chmod'ing through a symlink to
// the target.
func TestRotatingWriterRotationSymlinkSwapRaceNeverWritesTarget(t *testing.T) {
	base := t.TempDir()
	target := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 8, 2) // rotate on almost every write
	defer rw.Close()

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
			os.Remove(backup1)
			os.Symlink(target, backup1)
			os.Remove(backup1)
		}
	}()

	payload := []byte("0123456789") // 10 bytes > maxSize(8): forces rotate() nearly every call
	for i := 0; i < 500; i++ {
		_, _ = rw.Write(payload) // errors expected once disabled; that's fine, target is what matters
	}

	close(stop)
	wg.Wait()

	requireTargetUntouched(t, target)
}

// TestRotatingWriterFinalReopenSymlinkSwapRace targets specifically the
// final step of rotate(): after all backups have shifted and the current
// log has been renamed to .1, rotate() opens a fresh file at the (now
// vacated) current log path. A racing attacker who wins the window between
// the rename and that final open should never get rotate() to dereference a
// symlink there. This complements
// TestRotatingWriterRotationSymlinkSwapRaceNeverWritesTarget, which races
// the backup slot instead of the current log path.
func TestRotatingWriterFinalReopenSymlinkSwapRace(t *testing.T) {
	base := t.TempDir()
	target := newAttackTarget(t, base)
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 8, 2)
	defer rw.Close()

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
			// Race the exact path rotate()'s final step is about to
			// reopen once it's been vacated by the rename to .1.
			os.Symlink(target, logPath+".raceattempt")
			os.Rename(logPath+".raceattempt", logPath)
		}
	}()

	payload := []byte("0123456789") // 10 bytes > maxSize(8): forces rotate() nearly every call
	for i := 0; i < 500; i++ {
		_, _ = rw.Write(payload)
	}

	close(stop)
	wg.Wait()

	requireTargetUntouched(t, target)
}

// --- RotatingWriter: general concurrency robustness (no symlinks) ---

func TestRotatingWriterConcurrentWritesAndRotation(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	rw := newTestRotatingWriter(t, logPath, 64, 3)
	defer rw.Close()

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
