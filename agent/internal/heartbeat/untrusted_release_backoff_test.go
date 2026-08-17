package heartbeat

import (
	"testing"
	"time"
)

// Issue #3544: when the control plane refuses an upgrade target as untrusted
// (HTTP 409 -> updater.ErrUntrustedRelease), the condition is terminal for
// that version — retrying cannot produce a signed manifest — but it is NOT
// permanent, because an operator re-registering the version must recover the
// fleet automatically. So doUpgrade backs off per target version instead of
// disabling auto-update. These tests pin that policy on the decision helpers
// doUpgrade delegates to.

func TestUntrustedReleaseBackoff_InactiveBeforeAnyRejection(t *testing.T) {
	h := &Heartbeat{}
	if h.untrustedReleaseBackoffActive("0.105.1") {
		t.Fatal("a target that was never rejected must not be backed off")
	}
}

func TestUntrustedReleaseBackoff_ActiveAfterRejection(t *testing.T) {
	h := &Heartbeat{}
	h.noteUntrustedRelease("0.105.1")
	if !h.untrustedReleaseBackoffActive("0.105.1") {
		t.Fatal("a just-rejected target must be backed off, not retried next heartbeat")
	}
}

// The whole point of the cooldown: the server re-sends the same upgradeTo on
// every heartbeat (~60s), so without keying on it the device re-runs the full
// prefetch + download path forever. This is the exact reported symptom.
func TestUntrustedReleaseBackoff_SuppressesRepeatedHeartbeats(t *testing.T) {
	h := &Heartbeat{}
	attempts := 0
	for i := 0; i < 60; i++ { // an hour of heartbeats at ~60s
		if h.untrustedReleaseBackoffActive("0.105.1") {
			continue
		}
		attempts++
		h.noteUntrustedRelease("0.105.1")
	}
	if attempts != 1 {
		t.Fatalf("expected 1 attempt across 60 heartbeats, got %d", attempts)
	}
}

// Keyed on the target version: promoting a DIFFERENT version is the operator's
// fix for this condition, so it must take effect on the very next heartbeat
// rather than waiting out a cooldown earned by the broken version.
func TestUntrustedReleaseBackoff_NewTargetIsNotThrottled(t *testing.T) {
	h := &Heartbeat{}
	h.noteUntrustedRelease("0.105.1")
	if h.untrustedReleaseBackoffActive("0.105.2") {
		t.Fatal("a different target version must not inherit the cooldown")
	}
}

// Not permanent: re-registering the SAME version with a signed manifest must
// recover without restarting the agent.
func TestUntrustedReleaseBackoff_ExpiresAfterCooldown(t *testing.T) {
	h := &Heartbeat{}
	h.noteUntrustedRelease("0.105.1")

	h.untrustedReleaseMu.Lock()
	h.untrustedReleaseAt = time.Now().Add(-2 * untrustedReleaseRetryCooldown)
	h.untrustedReleaseMu.Unlock()

	if h.untrustedReleaseBackoffActive("0.105.1") {
		t.Fatal("the cooldown must expire so a fixed registration recovers on its own")
	}
}

// doUpgrade runs on a goroutine per heartbeat, so the state must be safe
// under concurrent access (-race makes this meaningful).
func TestUntrustedReleaseBackoff_ConcurrentAccess(t *testing.T) {
	h := &Heartbeat{}
	done := make(chan struct{})
	for i := 0; i < 8; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 200; j++ {
				h.noteUntrustedRelease("0.105.1")
				_ = h.untrustedReleaseBackoffActive("0.105.1")
			}
		}()
	}
	for i := 0; i < 8; i++ {
		<-done
	}
}
