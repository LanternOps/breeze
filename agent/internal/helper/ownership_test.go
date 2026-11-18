package helper

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// OD-8 (a), #10185: the agent manages only the Breeze Assist installs it made.
// An install it did not make is left alone when deploy is off and reported as
// unmanaged_install; deploy on adopts it at the next server-offered version.

func ownershipPath(dir string) string { return filepath.Join(dir, ownershipFileName) }

// markAgentInstalled records the install under mgr as one the agent made.
func markAgentInstalled(t *testing.T, mgr *Manager) {
	t.Helper()
	if err := writeOwnership(mgr.baseDir, ownershipMarker{InstalledBy: ownershipInstalledByAgent, Version: "1.2.3", InstalledAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
}

// startOwnershipTracking puts the host past its first Apply on an
// ownership-aware build, with no marker: the steady state for an install the
// agent did not make.
func startOwnershipTracking(t *testing.T, dir string) {
	t.Helper()
	if err := clearOwnership(dir); err != nil {
		t.Fatal(err)
	}
}

// stubUninstall replaces the machine-wide uninstall seams for tests that do not
// use stubMachineSeams, so a test can never run the real package uninstall.
func stubUninstall(t *testing.T, binaryPath string) *int {
	t.Helper()
	calls := 0
	origUninstall, origRemove := uninstallPackageFunc, removeAutoStartFunc
	t.Cleanup(func() { uninstallPackageFunc, removeAutoStartFunc = origUninstall, origRemove })
	uninstallPackageFunc = func() error { calls++; _ = os.Remove(binaryPath); return nil }
	removeAutoStartFunc = func() error { return nil }
	return &calls
}

func isMarked(t *testing.T, dir string) bool {
	t.Helper()
	_, ok := readOwnership(dir)
	return ok
}

func TestApplyDisabledLeavesUnmarkedInstall(t *testing.T) {
	for _, firstRun := range []bool{true, false} {
		name := "steady state"
		if firstRun {
			name = "first apply after the agent upgrade"
		}
		t.Run(name, func(t *testing.T) {
			var calls ownershipCalls
			f := newOwnershipFixture(t, true)
			stubMachineSeams(t, &calls, f.binaryPath)
			if !firstRun {
				startOwnershipTracking(t, f.baseDir)
			}
			mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))

			mgr.Apply(&Settings{Enabled: false})
			mgr.Apply(&Settings{Enabled: false})

			if calls != (ownershipCalls{}) {
				t.Fatalf("agent touched an Assist it did not install: %+v", calls)
			}
			for _, p := range []string{f.binaryPath, f.sessionConfig, f.legacyConfig} {
				if !fileExists(p) {
					t.Fatalf("agent removed %s from an Assist it did not install", p)
				}
			}
			if got := mgr.InstallIssue(); got != InstallIssueUnmanagedInstall {
				t.Fatalf("InstallIssue() = %q, want %q", got, InstallIssueUnmanagedInstall)
			}
			if isMarked(t, f.baseDir) {
				t.Fatal("an unmanaged install must not be marked as the agent's")
			}
		})
	}
}

// Control for the test above: the agent's own install is still removed.
func TestApplyDisabledRemovesMarkedInstall(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, true)
	stubMachineSeams(t, &calls, f.binaryPath)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	markAgentInstalled(t, mgr)

	mgr.Apply(&Settings{Enabled: false})

	if calls.uninstall != 1 {
		t.Fatalf("uninstall calls = %d, want 1", calls.uninstall)
	}
	if isMarked(t, f.baseDir) {
		t.Fatal("marker must be cleared once the agent removed its install")
	}
	if !ownershipTracked(f.baseDir) {
		t.Fatal("clearing the marker must keep ownership tracking (a later hand install is not the agent's)")
	}
	if got := mgr.InstallIssue(); got != "" {
		t.Fatalf("InstallIssue() = %q, want empty", got)
	}

	// A copy installed by hand after the agent removed its own is left alone.
	if err := os.WriteFile(f.binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	mgr.Apply(&Settings{Enabled: false})
	if calls.uninstall != 1 {
		t.Fatalf("uninstall calls after a hand install = %d, want still 1", calls.uninstall)
	}
}

func installingSeams(t *testing.T, mgr *Manager, version string) {
	t.Helper()
	pkg := filepath.Join(t.TempDir(), "verified"+packageExtension())
	if err := os.WriteFile(pkg, []byte("VERIFIED"), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr.downloadFunc = func(string) (string, error) {
		if err := os.WriteFile(mgr.binaryPath, []byte("bin-"+version), 0o755); err != nil {
			return "", err
		}
		return pkg, nil
	}
	mgr.spawnFunc = func(string, string, ...string) (int, error) { return 0, nil }
}

func TestApplyEnabledAdoptsUnmarkedOnNextOffer(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, true)
	stubMachineSeams(t, &calls, f.binaryPath)
	startOwnershipTracking(t, f.baseDir)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	installingSeams(t, mgr, "1.2.4")

	// Deploy on, nothing offered: the agent runs the copy but has not made it.
	mgr.Apply(&Settings{Enabled: true})
	if isMarked(t, f.baseDir) {
		t.Fatal("deploy on alone must not adopt a hand-installed Assist")
	}

	// The server offers a version: the agent installs it over the copy.
	mgr.CheckUpdate("1.2.4")
	mgr.Apply(&Settings{Enabled: true})
	marker, ok := readOwnership(f.baseDir)
	if !ok || marker.Version != "1.2.4" || marker.InstalledBy != ownershipInstalledByAgent {
		t.Fatalf("marker after the adopting install = %+v, %v; want breeze-agent 1.2.4", marker, ok)
	}

	mgr.Apply(&Settings{Enabled: false})
	if calls.uninstall != 1 {
		t.Fatalf("adopted install: uninstall calls = %d, want 1", calls.uninstall)
	}
}

// Upgrade adoption: today's agent manages the install it finds with deploy on,
// so the first Apply on this build marks it.
func TestUpgradeAdoptsEnabledInstall(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, true)
	stubMachineSeams(t, &calls, f.binaryPath)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	mgr.binaryVersionFunc = func(string) (string, error) { return "0.124.0", nil }

	mgr.Apply(&Settings{Enabled: true})
	marker, ok := readOwnership(f.baseDir)
	if !ok || marker.InstalledBy != ownershipInstalledByAgent || marker.Version != "0.124.0" {
		t.Fatalf("marker after the first Apply with deploy on = %+v, %v; want breeze-agent 0.124.0", marker, ok)
	}

	mgr.Apply(&Settings{Enabled: false})
	if calls.uninstall != 1 {
		t.Fatalf("uninstall calls = %d, want 1 (deploy off must still remove the agent's own install)", calls.uninstall)
	}
}

// Upgrade with deploy off: today's agent would already have removed its own
// install, so the copy found is someone else's, and stays unadopted afterwards.
func TestUpgradeLeavesDisabledInstallUnmanaged(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, true)
	stubMachineSeams(t, &calls, f.binaryPath)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))

	mgr.Apply(&Settings{Enabled: false})
	if !ownershipTracked(f.baseDir) {
		t.Fatal("the first Apply must record that ownership tracking started")
	}
	mgr.Apply(&Settings{Enabled: true}) // later turned on, nothing offered
	mgr.Apply(&Settings{Enabled: false})

	if calls.uninstall != 0 || isMarked(t, f.baseDir) {
		t.Fatalf("uninstall=%d marked=%v; the upgrade-time adoption is one-shot", calls.uninstall, isMarked(t, f.baseDir))
	}
}

func TestMarkerWrittenAfterInstall(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, false)
	stubMachineSeams(t, &calls, f.binaryPath)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	installingSeams(t, mgr, "1.2.3")
	before := time.Now().Add(-time.Second)

	mgr.CheckUpdate("1.2.3")
	mgr.Apply(&Settings{Enabled: true})

	marker, ok := readOwnership(f.baseDir)
	if !ok {
		t.Fatal("no ownership marker after the agent installed Assist")
	}
	if marker.InstalledBy != ownershipInstalledByAgent || marker.Version != "1.2.3" || marker.InstalledAt.Before(before) {
		t.Fatalf("marker = %+v, want breeze-agent 1.2.3 stamped now", marker)
	}
	if fileExists(ownershipPath(f.baseDir) + ".tmp") {
		t.Fatal("atomic write left its temp file behind")
	}
}

// A marker the agent cannot parse is never read as permission to uninstall.
func TestOwnershipFileMalformedIsTreatedAsUnmanaged(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, true)
	stubMachineSeams(t, &calls, f.binaryPath)
	if err := os.WriteFile(ownershipPath(f.baseDir), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))

	mgr.Apply(&Settings{Enabled: false})

	if calls.uninstall != 0 {
		t.Fatalf("uninstall calls = %d with an unreadable marker, want 0", calls.uninstall)
	}
	if got := mgr.InstallIssue(); got != InstallIssueUnmanagedInstall {
		t.Fatalf("InstallIssue() = %q, want %q", got, InstallIssueUnmanagedInstall)
	}
}

// Deploy flipped off while the agent was running a copy it did not install:
// its watchers stop (they would respawn Assist), the copy stays.
func TestDeployOffStopsWatchersOnUnmanagedInstall(t *testing.T) {
	var calls ownershipCalls
	f := newOwnershipFixture(t, true)
	stubMachineSeams(t, &calls, f.binaryPath)
	startOwnershipTracking(t, f.baseDir)
	mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
	mgr.spawnFunc = func(string, string, ...string) (int, error) { calls.spawn++; return 0, nil }

	mgr.Apply(&Settings{Enabled: true})
	if mgr.sessions["1"] == nil || mgr.sessions["1"].watcher == nil {
		t.Fatal("expected a watcher while deploy is on")
	}
	mgr.Apply(&Settings{Enabled: false})

	if mgr.sessions["1"].watcher != nil {
		t.Fatal("watcher still running after deploy turned off")
	}
	if calls.uninstall != 0 || !fileExists(f.binaryPath) {
		t.Fatalf("uninstall=%d; an unmanaged install must survive deploy off", calls.uninstall)
	}
}

func TestOwnershipRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, ok := readOwnership(dir); ok || ownershipTracked(dir) {
		t.Fatal("empty dir reports a marker or tracking")
	}
	at := time.Date(2026, 10, 26, 6, 0, 0, 0, time.UTC)
	want := ownershipMarker{InstalledBy: ownershipInstalledByAgent, Version: "0.125.0", InstalledAt: at}
	if err := writeOwnership(dir, want); err != nil {
		t.Fatal(err)
	}
	got, ok := readOwnership(dir)
	if !ok || got.InstalledBy != want.InstalledBy || got.Version != want.Version || !got.InstalledAt.Equal(at) {
		t.Fatalf("readOwnership = %+v, %v; want %+v", got, ok, want)
	}
	if err := clearOwnership(dir); err != nil {
		t.Fatal(err)
	}
	if _, ok := readOwnership(dir); ok {
		t.Fatal("marker survived clearOwnership")
	}
	if !ownershipTracked(dir) {
		t.Fatal("clearOwnership dropped the tracking record")
	}
	// A marker naming another installer is not the agent's.
	if err := writeOwnership(dir, ownershipMarker{InstalledBy: "intune"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := readOwnership(dir); ok {
		t.Fatal("a marker from another installer reads as the agent's")
	}
}
