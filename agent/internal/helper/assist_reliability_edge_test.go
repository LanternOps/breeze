package helper

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Edge cases of the W01 Assist reliability changes (#10183, #10185) found in
// review: issue-code precedence, ownership records that outlive their
// install, update paths, and exit-probe bookkeeping.

// slowWatcher keeps any watcher Apply starts from ticking during the test, so
// spawn counts read after Apply are not racing it.
func slowWatcher(t *testing.T) {
	t.Helper()
	orig := watcherBaseInterval
	watcherBaseInterval = 1 << 40 // ~18 minutes; never fires in a test
	t.Cleanup(func() { watcherBaseInterval = orig })
}

// The heartbeat code must not flap between heartbeats: a machine-level code
// beats every session code, and a launch refusal in one session beats a crash
// loop in another whatever the map order.
func TestInstallIssuePrecedence(t *testing.T) {
	mgr, _ := newNotInstalledManager(t)
	mgr.lastApplyEnabled = true
	crashed := newSessionState("1", mgr.baseDir)
	crashed.watcherGaveUp = true
	refused := newSessionState("2", mgr.baseDir)
	refused.launchIssue = InstallIssueWebView2Outdated
	mgr.sessions["1"], mgr.sessions["2"] = crashed, refused

	for i := 0; i < 50; i++ { // map iteration order varies run to run
		if got := mgr.InstallIssue(); got != InstallIssueWebView2Outdated {
			t.Fatalf("iteration %d: InstallIssue() = %q, want %q", i, got, InstallIssueWebView2Outdated)
		}
	}
	mgr.installIssue = InstallIssueUnmanagedInstall
	if got := mgr.InstallIssue(); got != InstallIssueUnmanagedInstall {
		t.Fatalf("machine code: InstallIssue() = %q, want %q", got, InstallIssueUnmanagedInstall)
	}
	mgr.installIssue = ""
	refused.launchIssue = ""
	if got := mgr.InstallIssue(); got != InstallIssueCrashLoop {
		t.Fatalf("crash loop alone: InstallIssue() = %q, want %q", got, InstallIssueCrashLoop)
	}
	mgr.lastApplyEnabled = false
	if got := mgr.InstallIssue(); got != "" {
		t.Fatalf("disabled: InstallIssue() = %q, want empty", got)
	}
}

// A package uninstall that fails leaves the binary, so the marker must stay
// and the next disabled tick must try again; clearing it would orphan the
// agent's own install as "unmanaged" for good.
func TestFailedUninstallKeepsMarkerAndRetries(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, true)
	stubMachineSeams(t, &calls, f.binaryPath)
	uninstallPackageFunc = func() error { calls.uninstall++; return errors.New("msiexec: exit status 1603") }
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	markAgentInstalled(t, mgr)

	mgr.Apply(&Settings{Enabled: false})
	if !isMarked(t, f.baseDir) {
		t.Fatal("marker cleared although the binary is still installed")
	}
	mgr.Apply(&Settings{Enabled: false})
	if calls.uninstall != 2 {
		t.Fatalf("uninstall calls = %d, want 2 (the failed uninstall is retried)", calls.uninstall)
	}
}

// A marker whose binary is gone (an admin removed Assist, or clearing it
// failed) must not make a copy installed later by other means look like the
// agent's.
func TestDeadMarkerIsCleared(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, false)
	stubMachineSeams(t, &calls, f.binaryPath)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	markAgentInstalled(t, mgr) // stale: nothing is installed

	mgr.Apply(&Settings{Enabled: false})
	if isMarked(t, f.baseDir) {
		t.Fatal("a marker with no install behind it survived")
	}

	if err := os.WriteFile(f.binaryPath, []byte("bin"), 0o755); err != nil { // MSP pushes its own MSI
		t.Fatal(err)
	}
	mgr.Apply(&Settings{Enabled: false})
	if calls.uninstall != 0 {
		t.Fatalf("uninstall calls = %d; a later hand install must be left alone", calls.uninstall)
	}
	if got := mgr.InstallIssue(); got != InstallIssueUnmanagedInstall {
		t.Fatalf("InstallIssue() = %q, want %q", got, InstallIssueUnmanagedInstall)
	}
}

// Someone installed a different version over the agent's copy: not the agent's.
func TestMarkerVersionMismatchIsNotOurs(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, true)
	stubMachineSeams(t, &calls, f.binaryPath)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	markAgentInstalled(t, mgr) // records 1.2.3
	mgr.binaryVersionFunc = func(string) (string, error) { return "2.0.0", nil }

	mgr.Apply(&Settings{Enabled: false})
	if calls.uninstall != 0 {
		t.Fatalf("uninstall calls = %d; a different version on disk is not the agent's install", calls.uninstall)
	}

	// Control: the recorded version on disk is the agent's.
	mgr.binaryVersionFunc = func(string) (string, error) { return "1.2.3", nil }
	mgr.Apply(&Settings{Enabled: false})
	if calls.uninstall != 1 {
		t.Fatalf("matching version: uninstall calls = %d, want 1", calls.uninstall)
	}
}

// An update whose new build will not start is rolled back to the previous
// build, which the agent also installed: the marker must follow it, or the
// version check above would disown the agent's own install.
func TestRollbackRemarksTheRestoredBuild(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.failNext = func(int) bool { return strings.TrimSpace(h.binaryContent(t)) == "0.114.0" }
	if err := writeOwnership(h.mgr.baseDir, ownershipMarker{InstalledBy: ownershipInstalledByAgent, Version: "0.108.0"}); err != nil {
		t.Fatal(err)
	}

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if got := h.binaryContent(t); got != "0.108.0" {
		t.Fatalf("binary = %q, want the rolled-back 0.108.0", got)
	}
	marker, ok := readOwnership(h.mgr.baseDir)
	if !ok || marker.Version != "0.108.0" {
		t.Fatalf("marker after rollback = %+v, %v; want the restored 0.108.0", marker, ok)
	}
}

// msiexec can defer the file replacement to a reboot: the install attempt
// fails, and after the reboot the target build is simply on disk. The marker
// must follow it, or the version check disowns the agent's own install.
func TestUpdateLandedOutsideTheInstallerRemarks(t *testing.T) {
	h := newRollbackHarness(t, "1")
	if err := writeOwnership(h.mgr.baseDir, ownershipMarker{InstalledBy: ownershipInstalledByAgent, Version: "0.108.0"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.mgr.binaryPath, []byte("0.114.0"), 0o755); err != nil { // the deferred replacement
		t.Fatal(err)
	}

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate() // "already at target"
	h.mgr.mu.Unlock()

	marker, ok := readOwnership(h.mgr.baseDir)
	if !ok || marker.Version != "0.114.0" {
		t.Fatalf("marker = %+v, %v; want it re-recorded at the on-disk 0.114.0", marker, ok)
	}
}

// A device below the WebView2 minimum: the new build installs but the gate
// refuses it. That is not a broken build, and rolling back cannot fix it.
func TestUpdateKeepsTheNewBuildWhenWebView2Refuses(t *testing.T) {
	h := newRollbackHarness(t, "1")
	orig := webview2GateApplies
	t.Cleanup(func() { webview2GateApplies = orig })
	webview2GateApplies = true
	h.mgr.readWebView2Func = func(string) (string, bool) { return inboxWin11WebView2, true }

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.lastApplyEnabled = true // as the Apply that runs applyPendingUpdate sets it
	h.mgr.applyPendingUpdate()
	failures, pending := h.mgr.updateFailures, h.mgr.pendingHelperVersion
	h.mgr.mu.Unlock()

	if got := h.binaryContent(t); got != "0.114.0" {
		t.Fatalf("binary = %q, want the new 0.114.0 kept", got)
	}
	if failures != 0 || pending != "" {
		t.Fatalf("failures=%d pending=%q; a refused launch is not a failed update", failures, pending)
	}
	if h.spawns != 0 {
		t.Fatalf("spawned %d times below the WebView2 minimum, want 0", h.spawns)
	}
	if got := h.mgr.InstallIssue(); got != InstallIssueWebView2Outdated {
		t.Fatalf("InstallIssue() = %q, want %q", got, InstallIssueWebView2Outdated)
	}
}

// Assist running again (relaunched by the user, or the cause fixed) clears a
// crash loop and a launch refusal instead of reporting them for hours.
func TestRunningAssistClearsCrashLoopAndRefusal(t *testing.T) {
	slowWatcher(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	crashingAssist(t, mgr, &alive, 0)
	state := givenUpSession(mgr, mgr.nowTime(), "")
	state.spawnedPID = 777
	state.launchIssue = InstallIssueWebView2Outdated
	state.lastConfig = settingsToConfig(&Settings{Enabled: true}) // no config-reload restart this tick

	mgr.Apply(&Settings{Enabled: true})

	if got := mgr.InstallIssue(); got != "" {
		t.Fatalf("InstallIssue() with Assist running = %q, want empty", got)
	}
}

// A duplicate that exited while another instance keeps running is not the
// session's Assist going away: its exit must not be reported later.
func TestExitProbePrunesADuplicateThatExited(t *testing.T) {
	mgr, _ := newNotInstalledManager(t)
	state := newSessionState("1", mgr.baseDir)
	dupAlive, keeperAlive := false, true
	dup := &fakeExitProbe{alive: &dupAlive, code: 1}
	keeper := &fakeExitProbe{alive: &keeperAlive, code: 101}
	state.exitProbes = map[int]exitProbe{778: dup, 777: keeper}
	lists := 0
	origList := listHelperInstancesFunc
	t.Cleanup(func() { listHelperInstancesFunc = origList })
	listHelperInstancesFunc = func(string) ([]helperInstance, error) { lists++; return nil, nil }

	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	mgr.trackAssistExitsLocked(state)
	if !dup.closed || state.exitProbes[778] != nil {
		t.Fatal("the exited duplicate's probe was kept")
	}
	if keeper.closed || state.exitProbes[777] == nil {
		t.Fatal("the running instance's probe was dropped")
	}
	if lists != 0 {
		t.Fatalf("enumerated processes %d times with a live probe, want 0", lists)
	}

	keeperAlive = false
	exit, known := mgr.takeAssistExitLocked(state)
	if !known || exit.Code != 101 {
		t.Fatalf("takeAssistExitLocked = %v, %v; want the keeper's 101", exit, known)
	}
}

type erroringExitProbe struct{ closed bool }

func (p *erroringExitProbe) exitCode() (uint32, bool, error) {
	return 0, false, errors.New("GetExitCodeProcess: access denied")
}
func (p *erroringExitProbe) close() { p.closed = true }

func TestExitProbeReadErrorIsNotReportedAsAnExit(t *testing.T) {
	buf := captureLogs(t)
	mgr, _ := newNotInstalledManager(t)
	state := newSessionState("1", mgr.baseDir)
	p := &erroringExitProbe{}
	state.exitProbes = map[int]exitProbe{777: p}

	mgr.mu.Lock()
	_, known := mgr.takeAssistExitLocked(state)
	mgr.mu.Unlock()

	if known {
		t.Fatal("a probe that could not be read reported an exit code")
	}
	if !p.closed || len(state.exitProbes) != 0 {
		t.Fatal("the failed probe was not released")
	}
	if lines := linesContaining(buf, "could not watch breeze assist for its exit code"); len(lines) != 1 || !strings.Contains(lines[0], "level=WARN") {
		t.Fatalf("probe failure must be one WARN so exitCode=unknown has a cause: %v", lines)
	}
}

// The marker write after the agent's own install can fail (disk full, AV).
// The process still knows the install is its own, and writes the marker once
// it can.
func TestMarkerWriteFailureIsRetried(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	slowWatcher(t)
	var calls ownershipCalls
	f := newOwnershipFixture(t, false)
	f.binaryPath = filepath.Join(t.TempDir(), "breeze-helper") // outside the read-only config dir
	stubMachineSeams(t, &calls, f.binaryPath)
	startOwnershipTracking(t, f.baseDir)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	installingSeams(t, mgr, "1.2.3")

	if err := os.Chmod(f.baseDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(f.baseDir, 0o755) })
	mgr.CheckUpdate("1.2.3")
	mgr.Apply(&Settings{Enabled: true})
	if isMarked(t, f.baseDir) {
		t.Fatal("test setup: the marker write should have failed")
	}

	if err := os.Chmod(f.baseDir, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr.WithdrawOffer() // no reinstall on this tick: only the retry can write the marker
	mgr.Apply(&Settings{Enabled: true})
	marker, ok := readOwnership(f.baseDir)
	if !ok || marker.Version != "1.2.3" {
		t.Fatalf("marker after the retry = %+v, %v; want breeze-agent 1.2.3", marker, ok)
	}
}

// Same failure, then deploy off before the write lands: the agent still
// removes its own install.
func TestFailedMarkerWriteStillUninstallsTheAgentsInstall(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	slowWatcher(t)
	var calls ownershipCalls
	f := newOwnershipFixture(t, false)
	f.binaryPath = filepath.Join(t.TempDir(), "breeze-helper")
	stubMachineSeams(t, &calls, f.binaryPath)
	startOwnershipTracking(t, f.baseDir)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	installingSeams(t, mgr, "1.2.3")

	if err := os.Chmod(f.baseDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(f.baseDir, 0o755) })
	mgr.CheckUpdate("1.2.3")
	mgr.Apply(&Settings{Enabled: true})
	mgr.Apply(&Settings{Enabled: false})

	if calls.uninstall != 1 {
		t.Fatalf("uninstall calls = %d, want 1 (the install is the agent's although its marker write failed)", calls.uninstall)
	}
}
