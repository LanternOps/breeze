package heartbeat

import (
	"errors"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

var errInstallFailed = errors.New("simulated watchdog install failure")

// newWatchdogTestHeartbeat builds a Heartbeat wired with a fake watchdog
// installer that records the version it was asked to install. The returned
// counter tracks invocations; the Value holds the last target version.
func newWatchdogTestHeartbeat(agentVersion string, autoUpdate bool) (*Heartbeat, *atomic.Int32, *atomic.Value) {
	calls := &atomic.Int32{}
	lastTarget := &atomic.Value{}
	lastTarget.Store("")
	h := &Heartbeat{
		config:       &config.Config{AutoUpdate: autoUpdate},
		agentVersion: agentVersion,
		watchdogInstaller: func(targetVersion string) error {
			calls.Add(1)
			lastTarget.Store(targetVersion)
			return nil
		},
	}
	return h, calls, lastTarget
}

func TestHandleWatchdogUpgrade_InstallsNewerVersion(t *testing.T) {
	h, calls, lastTarget := newWatchdogTestHeartbeat("0.82.1", true)
	h.handleWatchdogUpgrade("0.83.0")
	if calls.Load() != 1 {
		t.Fatalf("expected installer called once, got %d", calls.Load())
	}
	if got := lastTarget.Load().(string); got != "0.83.0" {
		t.Fatalf("expected install target 0.83.0, got %q", got)
	}
}

func TestHandleWatchdogUpgrade_SkipsEmptyVersion(t *testing.T) {
	h, calls, _ := newWatchdogTestHeartbeat("0.82.1", true)
	h.handleWatchdogUpgrade("")
	if calls.Load() != 0 {
		t.Fatalf("expected installer NOT called for empty target, got %d", calls.Load())
	}
}

// The common recovery case: agent and the latest watchdog are BOTH at the same
// version (e.g. 0.82.1) while the on-disk watchdog is stale (0.69.0). The server
// sends watchdogUpgradeTo=0.82.1; target == agentVersion must NOT be treated as
// a no-op (regression guard for the original bad early-return).
func TestHandleWatchdogUpgrade_InstallsWhenTargetEqualsAgentVersion(t *testing.T) {
	h, calls, lastTarget := newWatchdogTestHeartbeat("0.82.1", true)
	h.handleWatchdogUpgrade("0.82.1")
	if calls.Load() != 1 {
		t.Fatalf("expected installer called once for target==agentVersion, got %d", calls.Load())
	}
	if got := lastTarget.Load().(string); got != "0.82.1" {
		t.Fatalf("expected install target 0.82.1, got %q", got)
	}
}

// After a successful install the same target must be deduped, so a server that
// keeps re-sending watchdogUpgradeTo (a healthy watchdog stops heartbeating, so
// device.watchdogVersion never updates) doesn't cause a re-swap loop.
func TestHandleWatchdogUpgrade_DedupesAfterSuccess(t *testing.T) {
	h, calls, _ := newWatchdogTestHeartbeat("0.82.1", true)
	h.handleWatchdogUpgrade("0.82.1")
	h.handleWatchdogUpgrade("0.82.1")
	h.handleWatchdogUpgrade("0.82.1")
	if calls.Load() != 1 {
		t.Fatalf("expected installer called exactly once across repeats, got %d", calls.Load())
	}
}

func TestHandleWatchdogUpgrade_SkipsWhenAutoUpdateDisabled(t *testing.T) {
	h, calls, _ := newWatchdogTestHeartbeat("0.82.1", false)
	h.handleWatchdogUpgrade("0.83.0")
	if calls.Load() != 0 {
		t.Fatalf("expected installer NOT called when auto_update disabled, got %d", calls.Load())
	}
}

// SECURITY: a watchdog older than the running agent must be refused so a
// replayed/compromised control-plane response can't push a known-vulnerable,
// validly-signed older watchdog.
func TestHandleWatchdogUpgrade_RefusesDowngrade(t *testing.T) {
	h, calls, _ := newWatchdogTestHeartbeat("0.82.1", true)
	h.handleWatchdogUpgrade("0.69.0")
	if calls.Load() != 0 {
		t.Fatalf("expected installer NOT called for downgrade, got %d", calls.Load())
	}
}

// A FAILING install must not be deduped (so transient failures recover) but is
// throttled by the retry cooldown so a stuck device doesn't re-swap every tick.
func TestHandleWatchdogUpgrade_FailedInstallIsCooldownThrottled(t *testing.T) {
	calls := &atomic.Int32{}
	h := &Heartbeat{
		config:       &config.Config{AutoUpdate: true},
		agentVersion: "0.82.1",
		watchdogInstaller: func(string) error {
			calls.Add(1)
			return errInstallFailed
		},
	}
	h.handleWatchdogUpgrade("0.82.1") // attempt 1 — fails
	h.handleWatchdogUpgrade("0.82.1") // within cooldown — throttled
	if calls.Load() != 1 {
		t.Fatalf("expected installer called once (cooldown throttles the retry), got %d", calls.Load())
	}
	// Not recorded as installed, so it remains eligible to retry after cooldown.
	if h.watchdogInstalledVersion == "0.82.1" {
		t.Fatal("a failed install must not be recorded as installed")
	}
}

// The in-progress guard prevents overlapping heartbeat-delivered signals from
// running the swap concurrently.
func TestHandleWatchdogUpgrade_SkipsWhenInProgress(t *testing.T) {
	h, calls, _ := newWatchdogTestHeartbeat("0.82.1", true)
	h.watchdogUpgradeInProgress.Store(true)
	h.handleWatchdogUpgrade("0.83.0")
	if calls.Load() != 0 {
		t.Fatalf("expected installer NOT called while an upgrade is in progress, got %d", calls.Load())
	}
}
