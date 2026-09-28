package helper

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// Follow-ups to the #6869/#7049 update fixes (#7113).

func activeChatStatus(pid int) string {
	return "pid: " + strconv.Itoa(pid) + "\nchat_active: true\nlast_activity: " +
		time.Now().UTC().Format(time.RFC3339) + "\n"
}

// #7113 (1): a helper in a session the console-only enumerator never tracks
// (RDP) maps breeze-helper.exe. It must be stopped before msiexec runs, not
// only by the rollback after msiexec has already failed on it.
func TestApplyPendingUpdateStopsUntrackedHelpersBeforeInstall(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.procs.procs = append(h.procs.procs, helperInstance{PID: 4242, SessionKey: "7"})
	var aliveAtInstall, installed bool
	installPackageFunc = func(_, binaryPath, version string) error {
		installed = true
		aliveAtInstall = h.procs.alive(4242)
		return os.WriteFile(binaryPath, []byte(version), 0755)
	}

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if !installed {
		t.Fatal("install never ran")
	}
	if aliveAtInstall {
		t.Fatal("untracked helper 4242 was still running when the installer ran")
	}
	if h.mgr.pendingHelperVersion != "" {
		t.Fatalf("pending = %q, want the update applied", h.mgr.pendingHelperVersion)
	}
}

// #7113 (2): the "no active Assist chat" gate must cover every session running
// the helper, not just the tracked ones. A chat in an untracked session defers
// the whole update: nothing is stopped, nothing is installed, nothing counted.
func TestApplyPendingUpdateDefersOnActiveChatInUntrackedSession(t *testing.T) {
	cases := []struct {
		name  string
		write func(t *testing.T, baseDir string)
	}{
		{"per-session status", func(t *testing.T, baseDir string) {
			writeSessionStatus(t, baseDir, "7", activeChatStatus(0))
		}},
		{"legacy root status of a helper started without --config", func(t *testing.T, baseDir string) {
			if err := os.WriteFile(filepath.Join(baseDir, "helper_status.yaml"), []byte(activeChatStatus(4242)), 0644); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newRollbackHarness(t, "1")
			h.procs.procs = append(h.procs.procs,
				helperInstance{PID: 1001, SessionKey: "1"},
				helperInstance{PID: 4242, SessionKey: "7"})
			tc.write(t, h.mgr.baseDir)
			installed := false
			installPackageFunc = func(string, string, string) error { installed = true; return nil }

			h.mgr.CheckUpdate("0.114.0")
			h.mgr.mu.Lock()
			h.mgr.applyPendingUpdate()
			h.mgr.mu.Unlock()

			if installed {
				t.Fatal("installer ran while an untracked session had an active chat")
			}
			if len(h.procs.stopped) != 0 {
				t.Fatalf("stopped %v while an untracked session had an active chat", h.procs.stopped)
			}
			if h.mgr.updateFailures != 0 || h.mgr.pendingHelperVersion != "0.114.0" {
				t.Fatalf("failures=%d pending=%q, want a plain deferral", h.mgr.updateFailures, h.mgr.pendingHelperVersion)
			}
		})
	}
}

// #7113 (3): a helper that cannot be stopped before the update is a failed
// attempt. Without counting it, the stop is retried on every heartbeat forever
// and the 3-attempt cap never engages.
func TestApplyPendingUpdateCountsPreUpdateStopFailureTowardCap(t *testing.T) {
	cases := []struct {
		name string
		pid  int
		key  string
	}{
		{"tracked session", 1001, "1"},
		{"untracked session", 4242, "7"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newRollbackHarness(t, "1")
			h.procs.procs = append(h.procs.procs, helperInstance{PID: tc.pid, SessionKey: tc.key})
			h.mgr.stopIfOursFunc = func(pid int, path string) (bool, error) {
				if pid == tc.pid {
					return false, errors.New("OpenProcess: access is denied")
				}
				return h.procs.stop(pid, path)
			}
			installs := 0
			installPackageFunc = func(string, string, string) error { installs++; return nil }

			h.mgr.CheckUpdate("0.114.0")
			h.mgr.mu.Lock()
			defer h.mgr.mu.Unlock()
			h.mgr.applyPendingUpdate()
			if h.mgr.updateFailures != 1 || h.mgr.pendingHelperVersion != "0.114.0" {
				t.Fatalf("after one stop failure: failures=%d pending=%q, want 1 and pending kept",
					h.mgr.updateFailures, h.mgr.pendingHelperVersion)
			}
			for i := 0; i < maxHelperInstallFailures; i++ {
				h.mgr.applyPendingUpdate()
			}
			if h.mgr.abandonedVersion != "0.114.0" {
				t.Fatalf("abandoned=%q, want 0.114.0 abandoned after %d stop failures",
					h.mgr.abandonedVersion, maxHelperInstallFailures)
			}
			if installs != 0 {
				t.Fatalf("installer ran %d times although the helper could not be stopped", installs)
			}
		})
	}
}

// #7113 (4): a backup whose bytes no longer match what was copied (truncated
// or otherwise damaged) must never be restored over the helper binary.
func TestRollbackRefusesBackupThatDoesNotMatchRecordedCopy(t *testing.T) {
	h := newRollbackHarness(t, "1")
	installPackageFunc = func(_, binaryPath, _ string) error {
		if err := os.WriteFile(h.backup, []byte("0.1"), 0755); err != nil { // truncated
			return err
		}
		if err := os.WriteFile(binaryPath, []byte("0.114.0-partial"), 0755); err != nil {
			return err
		}
		return errors.New("msiexec: exit status 1603")
	}

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if got := h.binaryContent(t); got == "0.1" {
		t.Fatal("rollback restored a truncated backup over the helper binary")
	}
	if h.renames != 0 {
		t.Fatalf("rename attempted %d times with a damaged backup, want 0", h.renames)
	}
	if backupExists(h.backup) {
		t.Fatalf("damaged backup %s kept, want it discarded", h.backup)
	}
	if h.mgr.updateFailures != 1 {
		t.Fatalf("failures = %d, want the failed install counted", h.mgr.updateFailures)
	}
}
