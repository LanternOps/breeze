package helper

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// A kept backup is the only good copy of the helper (#7357).
//
// When a rollback cannot restore the backup and the exe has changed,
// rollbackBinaryLocked keeps breeze-helper.exe.backup. The next update attempt
// must not overwrite it with a copy of the broken exe, or a second failure
// "restores" the broken build and the good copy is gone.

// holdExe puts an untracked helper on the exe that the update and the
// rollback cannot stop, so every rename onto the binary fails. Everything else
// stops normally.
func (h *rollbackHarness) holdExe() {
	h.procs.procs = append(h.procs.procs, helperInstance{PID: 4242, SessionKey: "7"})
	h.mgr.stopIfOursFunc = func(pid int, path string) (bool, error) {
		if pid == 4242 {
			return false, nil
		}
		return h.procs.stop(pid, path)
	}
}

// releaseExe lets the rollback stop the holder again.
func (h *rollbackHarness) releaseExe() {
	h.mgr.stopIfOursFunc = h.procs.stop
}

// installWrites makes the next installs write content into the binary and
// then fail, the way an msiexec that dies part way leaves a partial exe.
func installWrites(content string) {
	installPackageFunc = func(_, binaryPath, _ string) error {
		if err := os.WriteFile(binaryPath, []byte(content), 0755); err != nil {
			return err
		}
		return errors.New("msiexec: exit status 1603")
	}
}

func (h *rollbackHarness) attempt() {
	h.mgr.mu.Lock()
	defer h.mgr.mu.Unlock()
	h.mgr.applyPendingUpdate()
}

func (h *rollbackHarness) backupContent(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(h.backup)
	if err != nil {
		t.Fatalf("read %s: %v", h.backup, err)
	}
	return string(b)
}

// restartAgent replaces the Manager with a fresh one on the same files, the
// way an agent restart does: every in-memory record is gone.
func (h *rollbackHarness) restartAgent(t *testing.T) {
	t.Helper()
	old := h.mgr
	old.Shutdown()
	ctx, cancel := context.WithCancel(context.Background())
	mgr := New(ctx, func() string { return "https://control.example.test" }, secmem.NewSecureString("tok"), "agent-1", WithMachineInstallOwner(true))
	t.Cleanup(func() {
		cancel()
		mgr.Shutdown()
	})
	mgr.baseDir = old.baseDir
	mgr.binaryPath = old.binaryPath
	mgr.sessionEnumerator = old.sessionEnumerator
	mgr.binaryVersionFunc = old.binaryVersionFunc
	mgr.downloadFunc = old.downloadFunc
	mgr.stopIfOursFunc = old.stopIfOursFunc
	mgr.isOurProcessFunc = old.isOurProcessFunc
	mgr.spawnFunc = old.spawnFunc
	for key := range old.sessions {
		mgr.sessions[key] = newSessionState(key, old.baseDir)
	}
	h.mgr = mgr
}

// failOnceKeepingBackup runs one update attempt whose install leaves a partial
// exe and whose rollback cannot restore, so the backup is kept.
func (h *rollbackHarness) failOnceKeepingBackup(t *testing.T, partial string) {
	t.Helper()
	h.holdExe()
	installWrites(partial)
	h.mgr.CheckUpdate("0.114.0")
	h.attempt()
	if got := h.backupContent(t); got != "0.108.0" {
		t.Fatalf("after the first failed rollback backup = %q, want the pre-update 0.108.0 kept", got)
	}
	if got := h.binaryContent(t); got != partial {
		t.Fatalf("after the first failed rollback binary = %q, want the partial build", got)
	}
}

func TestNextUpdateAfterFailedRollbackDoesNotOverwriteKeptBackup(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.failOnceKeepingBackup(t, "broken-1")

	// Second attempt fails the same way. The backup must still be the good
	// build, not a copy of the partial exe the attempt started from.
	installWrites("broken-2")
	h.attempt()
	if got := h.backupContent(t); got != "0.108.0" {
		t.Fatalf("after the second attempt backup = %q, want the kept 0.108.0", got)
	}

	// Third attempt (still inside the cap): the holder can be stopped now, so
	// the rollback restores the good build.
	h.releaseExe()
	h.attempt()
	if got := h.binaryContent(t); got != "0.108.0" {
		t.Fatalf("after the third attempt binary = %q, want the good 0.108.0 restored", got)
	}
	if backupExists(h.backup) {
		t.Fatalf("%s left behind after a successful restore", h.backup)
	}
	if backupExists(keptBackupRecordPath(h.backup)) {
		t.Fatalf("kept-backup record left behind after a successful restore")
	}
}

// The "nothing to restore" check compares the exe with the build the backup
// holds. After a kept backup, the exe the next attempt starts from is the
// broken build: an install that leaves it untouched must not make the rollback
// discard the good copy as a stale duplicate. The broken build here carries a
// readable version (an interrupted install that swapped in a mismatched exe),
// which is what the version comparison needs to match.
func TestFailedRollbackDoesNotDiscardKeptBackupAsDuplicate(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.failOnceKeepingBackup(t, "0.113.0")

	installPackageFunc = func(string, string, string) error {
		return errors.New("msiexec: exit status 1603") // exe untouched
	}
	h.attempt()
	if !backupExists(h.backup) {
		t.Fatalf("%s discarded although it is the only good copy", h.backup)
	}
	if got := h.backupContent(t); got != "0.108.0" {
		t.Fatalf("backup = %q, want the kept 0.108.0", got)
	}
}

func TestKeptBackupSurvivesAgentRestart(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.failOnceKeepingBackup(t, "broken-1")

	h.restartAgent(t)
	h.holdExe()
	installWrites("broken-2")
	h.mgr.CheckUpdate("0.114.0")
	h.attempt()
	if got := h.backupContent(t); got != "0.108.0" {
		t.Fatalf("after a restart and a failed attempt backup = %q, want the kept 0.108.0", got)
	}

	h.releaseExe()
	h.attempt()
	if got := h.binaryContent(t); got != "0.108.0" {
		t.Fatalf("binary = %q, want the good 0.108.0 restored after the restart", got)
	}
}

// A verified-good build (installed and started) supersedes the kept copy: the
// backup and its record go, and the next update backs up the new build.
func TestSuccessfulUpdateReleasesKeptBackup(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.failOnceKeepingBackup(t, "broken-1")

	h.releaseExe()
	installPackageFunc = func(_, binaryPath, version string) error {
		return os.WriteFile(binaryPath, []byte(version), 0755)
	}
	h.attempt()
	if got := h.binaryContent(t); got != "0.114.0" {
		t.Fatalf("binary = %q, want the updated 0.114.0", got)
	}
	if backupExists(h.backup) || backupExists(keptBackupRecordPath(h.backup)) {
		t.Fatal("backup or kept-backup record left behind after a successful update")
	}

	h.holdExe()
	installWrites("broken-3")
	h.mgr.CheckUpdate("0.115.0")
	h.attempt()
	if got := h.backupContent(t); got != "0.114.0" {
		t.Fatalf("backup = %q, want a fresh copy of the running 0.114.0", got)
	}
}

// A kept backup that no longer matches its record is not the good copy any
// more. The next attempt takes a fresh backup instead of trusting it.
func TestDamagedKeptBackupIsReplacedByFreshBackup(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.failOnceKeepingBackup(t, "broken-1")

	if err := os.WriteFile(h.backup, []byte("garbage"), 0755); err != nil {
		t.Fatal(err)
	}
	installWrites("broken-2")
	h.attempt()
	if got := h.backupContent(t); got != "broken-1" {
		t.Fatalf("backup = %q, want a fresh copy of the exe the attempt started from", got)
	}
}

// The record is written next to the backup and is readable back.
func TestKeptBackupRecordRoundTrip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "breeze-helper")
	if err := os.WriteFile(src, []byte("0.108.0"), 0755); err != nil {
		t.Fatal(err)
	}
	b, err := writeHelperBackup(src, src+".backup")
	if err != nil {
		t.Fatal(err)
	}
	b.version = "0.108.0"
	if err := saveKeptBackupRecord(b); err != nil {
		t.Fatal(err)
	}
	got, err := loadKeptBackupRecord(b.path)
	if err != nil {
		t.Fatal(err)
	}
	if got != b {
		t.Fatalf("loaded %+v, want %+v", got, b)
	}
	if err := got.verify(); err != nil {
		t.Fatalf("loaded record does not verify: %v", err)
	}
}

// A record that exists but cannot be parsed still says a rollback kept the
// backup. The backup must not be overwritten because its record is damaged:
// it is adopted again from its current bytes.
func TestCorruptKeptRecordStillProtectsBackup(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.failOnceKeepingBackup(t, "broken-1")

	h.restartAgent(t)
	if err := os.WriteFile(keptBackupRecordPath(h.backup), []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	h.holdExe()
	installWrites("broken-2")
	h.mgr.CheckUpdate("0.114.0")
	h.attempt()
	if got := h.backupContent(t); got != "0.108.0" {
		t.Fatalf("backup = %q, want the kept 0.108.0 despite its damaged record", got)
	}

	h.releaseExe()
	h.attempt()
	if got := h.binaryContent(t); got != "0.108.0" {
		t.Fatalf("binary = %q, want the good 0.108.0 restored", got)
	}
}

// A kept backup that cannot be read is not overwritten either: it may still be
// the good copy.
func TestUnreadableKeptBackupIsNotOverwritten(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs POSIX permissions enforced for the test user")
	}
	h := newRollbackHarness(t, "1")
	h.failOnceKeepingBackup(t, "broken-1")
	if !backupExists(keptBackupRecordPath(h.backup)) {
		t.Fatal("no kept-backup record written after the failed rollback")
	}

	if err := os.Chmod(h.backup, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(h.backup, 0755) })
	installWrites("broken-2")
	h.attempt()
	if err := os.Chmod(h.backup, 0755); err != nil {
		t.Fatal(err)
	}
	if got := h.backupContent(t); got != "0.108.0" {
		t.Fatalf("backup = %q, want the unreadable kept 0.108.0 left alone", got)
	}
}
