package helper

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// #6927: the first-install branch of Apply (binary missing, server offering a
// version) retried download + msiexec on every heartbeat forever. These tests
// drive the heartbeat's real call order — CheckUpdate(offer) then Apply — and
// assert the install path shares the update path's failure cap / abandon
// semantics, that a withdrawn offer clears the pending version, and that a
// new version (or the abandon cooldown expiring) re-arms the install.

func newFailingInstallManager(t *testing.T) (*Manager, *int, *time.Time) {
	t.Helper()
	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}
	withInstallRecorder(t)

	mgr := newInstallTestManager(t, t.TempDir())
	downloads := 0
	mgr.downloadFunc = func(string) (string, error) {
		downloads++
		return "", errors.New("download info request failed with status 404")
	}
	clock := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	mgr.now = func() time.Time { return clock }
	return mgr, &downloads, &clock
}

// heartbeatTick mirrors processHeartbeatResponse: offer (or withdrawal), then Apply.
func heartbeatTick(mgr *Manager, offer string) {
	if offer != "" {
		mgr.CheckUpdate(offer)
	} else {
		mgr.WithdrawOffer()
	}
	mgr.Apply(&Settings{Enabled: true})
}

func pendingAndAbandoned(mgr *Manager) (string, string) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	return mgr.pendingHelperVersion, mgr.abandonedVersion
}

func TestInstallFailureIsCappedAndAbandoned(t *testing.T) {
	mgr, downloads, _ := newFailingInstallManager(t)

	for i := 0; i < 10; i++ {
		heartbeatTick(mgr, "0.116.0")
	}

	if *downloads != maxHelperInstallFailures {
		t.Fatalf("install attempted %d times over 10 heartbeats, want %d (the shared failure cap)", *downloads, maxHelperInstallFailures)
	}
	pending, abandoned := pendingAndAbandoned(mgr)
	if pending != "" || abandoned != "0.116.0" {
		t.Fatalf("pending=%q abandoned=%q, want pending cleared and 0.116.0 abandoned", pending, abandoned)
	}
}

func TestInstallRetriesWhenANewVersionIsOffered(t *testing.T) {
	mgr, downloads, _ := newFailingInstallManager(t)
	for i := 0; i < 5; i++ {
		heartbeatTick(mgr, "0.116.0")
	}
	before := *downloads

	heartbeatTick(mgr, "0.117.0")

	if *downloads != before+1 {
		t.Fatalf("a new offered version did not re-arm the install: downloads %d -> %d", before, *downloads)
	}
	if pending, _ := pendingAndAbandoned(mgr); pending != "0.117.0" {
		t.Fatalf("pending=%q, want 0.117.0", pending)
	}
}

func TestAbandonedVersionIsRetriedAfterCooldown(t *testing.T) {
	mgr, downloads, clock := newFailingInstallManager(t)
	for i := 0; i < 5; i++ {
		heartbeatTick(mgr, "0.116.0")
	}
	before := *downloads

	*clock = clock.Add(helperAbandonRetryAfter - time.Minute)
	heartbeatTick(mgr, "0.116.0")
	if *downloads != before {
		t.Fatalf("abandoned version retried before the cooldown elapsed")
	}

	*clock = clock.Add(2 * time.Minute)
	heartbeatTick(mgr, "0.116.0")
	if *downloads != before+1 {
		t.Fatalf("abandoned version not retried after the cooldown: downloads %d -> %d", before, *downloads)
	}

	// The retry gets a full fresh budget, then re-abandons.
	for i := 0; i < 10; i++ {
		heartbeatTick(mgr, "0.116.0")
	}
	if *downloads != before+maxHelperInstallFailures {
		t.Fatalf("post-cooldown attempts = %d, want a fresh budget of %d", *downloads-before, maxHelperInstallFailures)
	}
	if _, abandoned := pendingAndAbandoned(mgr); abandoned != "0.116.0" {
		t.Fatalf("abandoned=%q after the post-cooldown budget, want 0.116.0", abandoned)
	}
}

// A successful first install clears the failure count, so a later update to
// the same version string (e.g. reinstall after removal) starts fresh.
func TestInstallSuccessClearsFailureCount(t *testing.T) {
	mgr, downloads, _ := newFailingInstallManager(t)
	heartbeatTick(mgr, "0.116.0")
	heartbeatTick(mgr, "0.116.0")

	mgr.downloadFunc = func(string) (string, error) {
		*downloads++
		if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
			return "", err
		}
		pkg := filepath.Join(t.TempDir(), "verified"+packageExtension())
		return pkg, os.WriteFile(pkg, []byte("VERIFIED"), 0600)
	}
	heartbeatTick(mgr, "0.116.0")

	mgr.mu.Lock()
	failures, failuresVersion := mgr.updateFailures, mgr.failuresVersion
	mgr.mu.Unlock()
	if failures != 0 || failuresVersion != "" {
		t.Fatalf("after a successful install: failures=%d failuresVersion=%q, want cleared", failures, failuresVersion)
	}
}

// After abandonment the not-installed warning must say why, not claim the
// server has offered nothing.
func TestAbandonedInstallIsNotReportedAsWaitingForServer(t *testing.T) {
	mgr, _, _ := newFailingInstallManager(t)
	for i := 0; i < 5; i++ {
		heartbeatTick(mgr, "0.116.0")
	}
	mgr.mu.Lock()
	msg := mgr.notInstalledReasonLocked()
	mgr.mu.Unlock()
	if !strings.Contains(msg, "abandoned") || !strings.Contains(msg, "0.116.0") {
		t.Fatalf("not-installed reason = %q, want it to name the abandoned version", msg)
	}
}

func TestWithdrawnOfferClearsPendingAndStopsInstall(t *testing.T) {
	mgr, downloads, _ := newFailingInstallManager(t)
	heartbeatTick(mgr, "0.116.0")
	if *downloads != 1 {
		t.Fatalf("downloads=%d after first offered tick, want 1", *downloads)
	}

	for i := 0; i < 5; i++ {
		heartbeatTick(mgr, "")
	}

	if *downloads != 1 {
		t.Fatalf("install kept retrying after the server withdrew the offer: downloads=%d", *downloads)
	}
	if pending, _ := pendingAndAbandoned(mgr); pending != "" {
		t.Fatalf("pending=%q after withdrawal, want cleared", pending)
	}
}

// A flapping offer (server-side resolver error omits it for one heartbeat)
// must not reset the failure count and so defeat the cap.
func TestWithdrawAndReofferKeepsFailureCount(t *testing.T) {
	mgr, downloads, _ := newFailingInstallManager(t)
	for i := 0; i < 10; i++ {
		heartbeatTick(mgr, "0.116.0")
		heartbeatTick(mgr, "")
	}
	if *downloads != maxHelperInstallFailures {
		t.Fatalf("flapping offer produced %d install attempts, want %d", *downloads, maxHelperInstallFailures)
	}
}
