package helper

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Rollback of a failed helper update (#6869, #7049).
//
// On Windows, MoveFileEx(MOVEFILE_REPLACE_EXISTING) — what os.Rename calls —
// fails with ERROR_ACCESS_DENIED while the target exe is mapped by a running
// process. fakeImageHolders models that: renames onto the helper binary fail
// while any fake helper process is alive, the way they do on a real host.

var errFakeAccessDenied = errors.New("access is denied")

type rollbackHarness struct {
	mgr      *Manager
	procs    *fakeHelperProcs
	backup   string
	renames  int
	sleeps   []time.Duration
	spawns   int
	failNext func(call int) bool // spawn call number (1-based) that fails
	nextPID  int
}

// newRollbackHarness builds a Manager with the given tracked sessions, an
// installed helper whose on-disk bytes are its version string, and an
// installer that writes the target version into the binary. binaryVersionFunc
// reads the file, so a rollback really does show the old version again.
func newRollbackHarness(t *testing.T, sessionKeys ...string) *rollbackHarness {
	t.Helper()
	tmpDir := t.TempDir()
	h := &rollbackHarness{procs: &fakeHelperProcs{}, nextPID: 1000}

	ctx, cancel := context.WithCancel(context.Background())
	mgr := newInstallTestManager(t, tmpDir)
	mgr.ctx = ctx
	t.Cleanup(func() {
		cancel()
		mgr.Shutdown()
	})
	mgr.binaryPath = filepath.Join(tmpDir, "breeze-helper")
	h.backup = mgr.binaryPath + ".backup"
	if err := os.WriteFile(mgr.binaryPath, []byte("0.108.0"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.binaryVersionFunc = func(path string) (string, error) {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	verifiedPkg := filepath.Join(tmpDir, "verified"+packageExtension())
	mgr.downloadFunc = func(string) (string, error) {
		return verifiedPkg, os.WriteFile(verifiedPkg, []byte("VERIFIED"), 0600)
	}
	origInstall := installPackageFunc
	t.Cleanup(func() { installPackageFunc = origInstall })
	installPackageFunc = func(_, binaryPath, version string) error {
		return os.WriteFile(binaryPath, []byte(version), 0755)
	}

	installFakeProcs(t, h.procs)
	mgr.stopIfOursFunc = h.procs.stop
	mgr.isOurProcessFunc = func(pid int, _ string) bool { return h.procs.alive(pid) }
	mgr.spawnFunc = func(sessionKey, _ string, _ ...string) (int, error) {
		h.spawns++
		if h.failNext != nil && h.failNext(h.spawns) {
			return 0, errors.New("CreateProcessAsUser: The system cannot find the file specified.")
		}
		h.nextPID++
		h.procs.procs = append(h.procs.procs, helperInstance{PID: h.nextPID, SessionKey: sessionKey})
		return h.nextPID, nil
	}

	origRename, origSleep := renameFunc, rollbackSleepFunc
	t.Cleanup(func() { renameFunc, rollbackSleepFunc = origRename, origSleep })
	renameFunc = func(src, dst string) error {
		if dst == mgr.binaryPath {
			h.renames++
			if len(h.procs.procs) > 0 {
				return &os.LinkError{Op: "rename", Old: src, New: dst, Err: errFakeAccessDenied}
			}
		}
		return os.Rename(src, dst)
	}
	rollbackSleepFunc = func(d time.Duration) { h.sleeps = append(h.sleeps, d) }

	for _, key := range sessionKeys {
		mgr.sessions[key] = newSessionState(key, tmpDir)
	}
	h.mgr = mgr
	return h
}

func (h *rollbackHarness) binaryContent(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(h.mgr.binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func backupExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// #7049: an update whose new binary will not start is a failed attempt. It
// must count toward the retry cap, so the version is abandoned instead of being
// reinstalled and rolled back on every heartbeat.
func TestApplyPendingUpdateCountsStartFailureTowardCap(t *testing.T) {
	h := newRollbackHarness(t, "1")
	// Every spawn of the new binary fails; spawns of the restored one succeed.
	h.failNext = func(int) bool {
		return strings.TrimSpace(h.binaryContent(t)) == "0.114.0"
	}

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	defer h.mgr.mu.Unlock()
	h.mgr.applyPendingUpdate()
	if h.mgr.updateFailures != 1 || h.mgr.pendingHelperVersion != "0.114.0" {
		t.Fatalf("after one start failure: failures=%d pending=%q, want 1 failure and pending kept",
			h.mgr.updateFailures, h.mgr.pendingHelperVersion)
	}
	for i := 0; i < maxHelperInstallFailures; i++ {
		h.mgr.applyPendingUpdate()
	}
	if h.mgr.abandonedVersion != "0.114.0" || h.mgr.pendingHelperVersion != "" {
		t.Fatalf("abandoned=%q pending=%q, want 0.114.0 abandoned after %d start failures",
			h.mgr.abandonedVersion, h.mgr.pendingHelperVersion, maxHelperInstallFailures)
	}
	if got := h.binaryContent(t); got != "0.108.0" {
		t.Fatalf("binary = %q after rollback, want the pre-update 0.108.0", got)
	}
}

// #6869: when the updated helper starts in one session and fails in another,
// the session that did start is running the new exe. Rolling back without
// stopping it first renames over a running image, which Windows refuses with
// "Access is denied" and leaves breeze-helper.exe.backup behind.
func TestStartFailureRollbackStopsStartedSessionsBeforeRestoring(t *testing.T) {
	h := newRollbackHarness(t, "1", "2")
	h.failNext = func(call int) bool { return call == 2 } // 2nd spawn of the new binary

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if got := h.binaryContent(t); got != "0.108.0" {
		t.Fatalf("binary = %q, want the pre-update 0.108.0 restored", got)
	}
	if backupExists(h.backup) {
		t.Fatalf("%s left behind after a successful rollback", h.backup)
	}
	if h.renames != 1 {
		t.Fatalf("restore took %d rename attempts, want 1 (nothing should hold the exe)", h.renames)
	}
}

// #6869: a helper running from the exe in a session the update did not stop
// (an RDP session the console-only enumerator never tracks, or one relaunched
// by msiexec's Restart Manager) holds the image. The rollback stops it and
// retries instead of giving up on the first "Access is denied".
func TestInstallFailureRollbackStopsUntrackedHolderAndRetries(t *testing.T) {
	h := newRollbackHarness(t, "1")
	installPackageFunc = func(_, binaryPath, _ string) error {
		// msiexec replaced the file, then failed (1603) — and something
		// relaunched the helper from it in an untracked session.
		h.procs.procs = append(h.procs.procs, helperInstance{PID: 4242, SessionKey: "7"})
		if err := os.WriteFile(binaryPath, []byte("0.114.0-partial"), 0755); err != nil {
			return err
		}
		return errors.New("msiexec: exit status 1603")
	}

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if got := h.binaryContent(t); got != "0.108.0" {
		t.Fatalf("binary = %q, want the pre-update 0.108.0 restored", got)
	}
	if backupExists(h.backup) {
		t.Fatalf("%s left behind after a successful rollback", h.backup)
	}
	if !containsPID(h.procs.stopped, 4242) {
		t.Fatalf("untracked holder 4242 not stopped; stopped=%v", h.procs.stopped)
	}
}

// When the exe cannot be replaced after every retry but is still the
// pre-update build (msiexec rolled its own change back), there is nothing to
// restore: the backup is a stale duplicate and is removed.
func TestRollbackDiscardsBackupWhenBinaryUnchanged(t *testing.T) {
	h := newRollbackHarness(t, "1")
	installPackageFunc = func(string, string, string) error {
		return errors.New("msiexec: exit status 1603") // file untouched
	}
	h.mgr.stopIfOursFunc = func(int, string) (bool, error) { return false, nil } // holder cannot be stopped
	h.procs.procs = append(h.procs.procs, helperInstance{PID: 4242, SessionKey: "7"})

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if h.renames < 2 {
		t.Fatalf("restore attempted %d times, want retries with backoff", h.renames)
	}
	if len(h.sleeps) == 0 {
		t.Fatal("no backoff between restore attempts")
	}
	if backupExists(h.backup) {
		t.Fatalf("%s kept although the binary is still the pre-update build", h.backup)
	}
	if got := h.binaryContent(t); got != "0.108.0" {
		t.Fatalf("binary = %q, want 0.108.0 untouched", got)
	}
}

// When the exe cannot be replaced and is NOT the pre-update build, the backup
// is the only good copy: it must be kept, not deleted.
func TestRollbackKeepsBackupWhenBinaryChangedAndRestoreFails(t *testing.T) {
	h := newRollbackHarness(t, "1")
	installPackageFunc = func(_, binaryPath, _ string) error {
		if err := os.WriteFile(binaryPath, []byte("0.114.0-partial"), 0755); err != nil {
			return err
		}
		return errors.New("msiexec: exit status 1603")
	}
	h.mgr.stopIfOursFunc = func(int, string) (bool, error) { return false, nil }
	h.procs.procs = append(h.procs.procs, helperInstance{PID: 4242, SessionKey: "7"})

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if !backupExists(h.backup) {
		t.Fatalf("%s deleted although the restore failed and the binary changed", h.backup)
	}
	b, _ := os.ReadFile(h.backup)
	if string(b) != "0.108.0" {
		t.Fatalf("backup = %q, want the pre-update 0.108.0", b)
	}
}

// A missing backup (the pre-install copy failed) is not a rollback failure to
// retry: there is nothing to restore.
func TestRollbackWithoutBackupDoesNotRename(t *testing.T) {
	h := newRollbackHarness(t, "1")
	installPackageFunc = func(string, string, string) error {
		_ = os.Remove(h.backup)
		return errors.New("msiexec: exit status 1603")
	}

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if h.renames != 0 {
		t.Fatalf("rename attempted %d times with no backup on disk, want 0", h.renames)
	}
}

func containsPID(pids []int, pid int) bool {
	for _, p := range pids {
		if p == pid {
			return true
		}
	}
	return false
}

// The idle gate before an update covers only tracked sessions, so a helper in
// an untracked session can be mid-chat. The rollback must not kill a live
// Assist conversation to free the exe: it leaves that holder running and keeps
// the backup (the logged, safe fallback).
func TestRollbackDoesNotStopHolderWithActiveChat(t *testing.T) {
	h := newRollbackHarness(t, "1")
	installPackageFunc = func(_, binaryPath, _ string) error {
		if err := os.WriteFile(binaryPath, []byte("0.114.0-partial"), 0755); err != nil {
			return err
		}
		return errors.New("msiexec: exit status 1603")
	}
	h.procs.procs = append(h.procs.procs, helperInstance{PID: 4242, SessionKey: "7"})
	writeSessionStatus(t, h.mgr.baseDir, "7", "pid: 0\nchat_active: true\nlast_activity: "+
		time.Now().UTC().Format(time.RFC3339)+"\n")

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if containsPID(h.procs.stopped, 4242) {
		t.Fatal("rollback stopped a helper with an active chat in an untracked session")
	}
	if !backupExists(h.backup) {
		t.Fatalf("%s deleted although the restore could not run", h.backup)
	}
}
