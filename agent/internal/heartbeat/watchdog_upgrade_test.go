package heartbeat

import (
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

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

func newFailingWatchdogHeartbeat(agentVersion string) (*Heartbeat, *atomic.Int32) {
	calls := &atomic.Int32{}
	h := &Heartbeat{
		config:       &config.Config{AutoUpdate: true},
		agentVersion: agentVersion,
		watchdogInstaller: func(string) error {
			calls.Add(1)
			return errInstallFailed
		},
	}
	return h, calls
}

// A FAILING install must not be deduped (so transient failures recover) but is
// throttled by the retry cooldown so a stuck device doesn't re-swap every tick.
func TestHandleWatchdogUpgrade_FailedInstallIsCooldownThrottled(t *testing.T) {
	h, calls := newFailingWatchdogHeartbeat("0.82.1")
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

// Once the cooldown elapses, a previously-failing target must be retried — a
// stuck device must not be stranded forever.
func TestHandleWatchdogUpgrade_RetriesAfterCooldownExpiry(t *testing.T) {
	h, calls := newFailingWatchdogHeartbeat("0.82.1")
	h.handleWatchdogUpgrade("0.82.1") // attempt 1 — fails, records attempt time
	// Simulate the cooldown having elapsed.
	h.watchdogUpgradeMu.Lock()
	h.watchdogLastAttemptAt = time.Now().Add(-2 * watchdogUpgradeRetryCooldown)
	h.watchdogUpgradeMu.Unlock()
	h.handleWatchdogUpgrade("0.82.1") // cooldown expired — retries
	if calls.Load() != 2 {
		t.Fatalf("expected installer retried after cooldown, got %d calls", calls.Load())
	}
}

// The cooldown is keyed on the target version, so a NEW target must not be
// throttled by a recent failure of a different target.
func TestHandleWatchdogUpgrade_DifferentTargetBypassesCooldown(t *testing.T) {
	h, calls := newFailingWatchdogHeartbeat("0.82.1")
	h.handleWatchdogUpgrade("0.83.0") // fails, records 0.83.0 attempt
	h.handleWatchdogUpgrade("0.83.1") // different target — not throttled
	if calls.Load() != 2 {
		t.Fatalf("expected a different target to bypass the cooldown, got %d calls", calls.Load())
	}
}

// Contract guard: the server emits "watchdogUpgradeTo"; the agent must decode it
// into HeartbeatResponse.WatchdogUpgradeTo. A field-name drift between the Go
// struct tag and the server JSON would otherwise pass both suites yet break in
// production.
func TestHeartbeatResponse_DecodesWatchdogUpgradeTo(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"watchdogUpgradeTo":"0.83.0"}`), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.WatchdogUpgradeTo != "0.83.0" {
		t.Fatalf("WatchdogUpgradeTo = %q, want 0.83.0", resp.WatchdogUpgradeTo)
	}
}

// Defense-in-depth: a non-semver target from a compromised control plane must be
// refused (fail-closed), not passed through to the fail-open downgrade check.
func TestHandleWatchdogUpgrade_RefusesNonSemverTarget(t *testing.T) {
	h, calls, _ := newWatchdogTestHeartbeat("0.82.1", true)
	h.handleWatchdogUpgrade("garbage-not-semver")
	if calls.Load() != 0 {
		t.Fatalf("expected installer NOT called for non-semver target, got %d", calls.Load())
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
