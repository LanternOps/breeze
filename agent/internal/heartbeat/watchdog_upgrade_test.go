package heartbeat

import (
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

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

func TestHandleWatchdogUpgrade_SkipsEmptyOrSameVersion(t *testing.T) {
	for _, target := range []string{"", "0.82.1"} {
		h, calls, _ := newWatchdogTestHeartbeat("0.82.1", true)
		h.handleWatchdogUpgrade(target)
		if calls.Load() != 0 {
			t.Fatalf("target %q: expected installer NOT called, got %d", target, calls.Load())
		}
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
