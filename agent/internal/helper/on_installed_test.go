package helper

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// #7043: the session broker snapshots the allowlisted helper hashes when the
// agent starts. The Breeze Helper is installed (and updated) after that, so the
// Manager must tell the agent when a new binary lands, via WithOnInstalled, so
// the broker can refresh before the new helper connects.

func withVerifiedDownload(t *testing.T, mgr *Manager) {
	t.Helper()
	pkg := filepath.Join(t.TempDir(), "verified"+packageExtension())
	mgr.downloadFunc = func(string) (string, error) {
		return pkg, os.WriteFile(pkg, []byte("VERIFIED"), 0o600)
	}
}

func TestOnInstalledCalledAfterSuccessfulFirstInstall(t *testing.T) {
	mgr, _, _ := newFailingInstallManager(t) // stubs autostart + install recorder
	withVerifiedDownload(t, mgr)
	// A real installer puts the stamped binary on disk.
	installPackageFunc = func(_, binaryPath, version string) error {
		return os.WriteFile(binaryPath, []byte(version), 0o755)
	}
	mgr.binaryVersionFunc = func(path string) (string, error) {
		b, err := os.ReadFile(path)
		return string(b), err
	}
	calls := 0
	WithOnInstalled(func(string) { calls++ })(mgr)

	heartbeatTick(mgr, "0.116.0")
	heartbeatTick(mgr, "0.116.0") // already installed: no second install, no second refresh

	if calls != 1 {
		t.Fatalf("onInstalled called %d times after a successful first install, want 1", calls)
	}
}

func TestOnInstalledNotCalledWhenDownloadFails(t *testing.T) {
	mgr, downloads, _ := newFailingInstallManager(t)
	calls := 0
	WithOnInstalled(func(string) { calls++ })(mgr)

	heartbeatTick(mgr, "0.116.0")

	if *downloads != 1 {
		t.Fatalf("downloads = %d, want 1", *downloads)
	}
	if calls != 0 {
		t.Fatalf("onInstalled called %d times after a failed download, want 0", calls)
	}
}

func TestOnInstalledNotCalledWhenPackageInstallFails(t *testing.T) {
	mgr, _, _ := newFailingInstallManager(t)
	withVerifiedDownload(t, mgr)
	installPackageFunc = func(string, string, string) error {
		return errors.New("msiexec: exit status 1603")
	}
	calls := 0
	WithOnInstalled(func(string) { calls++ })(mgr)

	heartbeatTick(mgr, "0.116.0")

	if calls != 0 {
		t.Fatalf("onInstalled called %d times after msiexec failed, want 0", calls)
	}
}

// msiexec exit 0 that left the old binary in place (#6252) is a failed
// install, not a new binary.
func TestOnInstalledNotCalledWhenInstallNotApplied(t *testing.T) {
	h := newRollbackHarness(t)
	installPackageFunc = func(string, string, string) error { return nil } // leaves 0.108.0
	calls := 0
	WithOnInstalled(func(string) { calls++ })(h.mgr)

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	if calls != 0 {
		t.Fatalf("onInstalled called %d times when the on-disk version did not change, want 0", calls)
	}
}

// The refresh must happen before the updated helper is spawned, or its first
// connection races the refresh and is rejected.
func TestOnInstalledRunsBeforeUpdatedHelperIsSpawned(t *testing.T) {
	h := newRollbackHarness(t, "1")
	var order []string
	spawn := h.mgr.spawnFunc
	h.mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
		order = append(order, "spawn")
		return spawn(sessionKey, binaryPath, args...)
	}
	WithOnInstalled(func(path string) {
		if path != h.mgr.binaryPath {
			t.Errorf("onInstalled path = %q, want %q", path, h.mgr.binaryPath)
		}
		order = append(order, "refresh")
	})(h.mgr)

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	pending := h.mgr.pendingHelperVersion
	h.mgr.mu.Unlock()

	if pending != "" {
		t.Fatalf("update did not complete: pending=%q", pending)
	}
	if len(order) < 2 || order[0] != "refresh" {
		t.Fatalf("call order = %v, want refresh before the first spawn of the updated helper", order)
	}
	refreshes := 0
	for _, c := range order {
		if c == "refresh" {
			refreshes++
		}
	}
	if refreshes != 1 {
		t.Fatalf("onInstalled called %d times for one update, want 1", refreshes)
	}
}

// When the updated helper will not start, the rollback puts the previous build
// back on disk. The broker was just refreshed to the new build's hash, so it
// must be refreshed again before the restored helper is respawned, or that
// helper is rejected until the broker's rate-limited backstop re-hashes.
func TestOnInstalledRefreshesAgainAfterStartFailureRollback(t *testing.T) {
	h := newRollbackHarness(t, "1")
	h.failNext = func(int) bool {
		return strings.TrimSpace(h.binaryContent(t)) == "0.114.0"
	}
	var order []string
	spawn := h.mgr.spawnFunc
	h.mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
		order = append(order, "spawn:"+strings.TrimSpace(h.binaryContent(t)))
		return spawn(sessionKey, binaryPath, args...)
	}
	WithOnInstalled(func(string) {
		order = append(order, "refresh:"+strings.TrimSpace(h.binaryContent(t)))
	})(h.mgr)

	h.mgr.CheckUpdate("0.114.0")
	h.mgr.mu.Lock()
	h.mgr.applyPendingUpdate()
	h.mgr.mu.Unlock()

	want := []string{"refresh:0.114.0", "spawn:0.114.0", "refresh:0.108.0", "spawn:0.108.0"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("call order = %v, want %v", order, want)
	}
}
