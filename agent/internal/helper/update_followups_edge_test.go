package helper

import (
	"errors"
	"os"
	"runtime"
	"testing"
)

// #7113 (2): a chat that starts in an untracked session after the pre-update
// gate, while the tracked sessions are being stopped, still defers the update.
// It is not a failed attempt, and the tracked sessions get their helper back.
func TestApplyPendingUpdateDefersWhenUntrackedChatStartsDuringStop(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.procs.procs = append(h.procs.procs,
		helperInstance{PID: 1001, SessionKey: "1"},
		helperInstance{PID: 4242, SessionKey: "7"})
	h.mgr.stopIfOursFunc = func(pid int, path string) (bool, error) {
		if pid == 1001 { // the tracked stop runs after the gate
			writeSessionStatus(t, h.mgr.baseDir, "7", activeChatStatus(0))
		}
		return h.procs.stop(pid, path)
	}
	installed := false
	installPackageFunc = func(string, string, string) error { installed = true; return nil }

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if installed {
		t.Fatal("installer ran although a chat started in an untracked session")
	}
	if containsPID(h.procs.stopped, 4242) {
		t.Fatal("stopped the untracked helper whose chat had started")
	}
	if h.mgr.updateFailures != 0 || h.mgr.pendingHelperVersion != "0.114.0" {
		t.Fatalf("failures=%d pending=%q, want a plain deferral", h.mgr.updateFailures, h.mgr.pendingHelperVersion)
	}
	if h.spawns == 0 {
		t.Fatal("tracked session 1 not restarted after the deferral")
	}
}

// #7113 (4): a backup that cannot be read is neither restored nor deleted. It
// may still be the only good copy; only a definite mismatch is discarded.
func TestRollbackKeepsUnreadableBackup(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs POSIX permissions enforced for the test user")
	}
	h := newRollbackHarness(t, "1")
	installPackageFunc = func(_, binaryPath, _ string) error {
		if err := os.Chmod(h.backup, 0); err != nil {
			return err
		}
		if err := os.WriteFile(binaryPath, []byte("0.114.0-partial"), 0755); err != nil {
			return err
		}
		return errors.New("msiexec: exit status 1603")
	}
	t.Cleanup(func() { _ = os.Chmod(h.backup, 0755) })

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if h.renames != 0 {
		t.Fatalf("rename attempted %d times with an unverifiable backup, want 0", h.renames)
	}
	if !backupExists(h.backup) {
		t.Fatalf("unreadable backup %s deleted, want it kept", h.backup)
	}
}
