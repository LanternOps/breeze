package desktop

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// These tests stand in for the fleet-wide shape that shipped broken: on a
// Windows service / macOS daemon install the capture session runs inside the
// user helper, whose SessionManager has NO command WebSocket of its own. Its
// RequestRevocationLeaseRenew was nil, so the watchdog asked for nothing, no
// answer ever arrived, and every helper-hosted session died at
// expiresAt+grace — 60s+90s = 150s after start, fleet-wide.
//
// Timings are the production ones scaled by 1/1000 (60s lease -> 60ms, 25s
// renew -> 25ms, 90s grace -> 90ms) so the whole state machine, including the
// 150s cutoff, runs inside a normal unit test.
const (
	scaledLeaseTTL = 60 * time.Millisecond
	scaledRenew    = 25 * time.Millisecond
	scaledGrace    = 90 * time.Millisecond
	// Well past expiresAt+grace: an unrenewed session is dead several times
	// over by the time this elapses.
	scaledRunFor = 500 * time.Millisecond
)

// wireHelperBridge builds the two halves of the IPC lease bridge around a
// helper-hosted SessionManager: the helper's outbound renew request, and the
// agent's inbound answer. `answer` plays the agent: it is handed the session id
// the helper asked to renew and returns the update the agent forwards back
// (nil = the agent never answered).
func wireHelperBridge(t *testing.T, mgr *SessionManager, answer func(sessionID string) *ipc.DesktopLeaseUpdate) *atomic.Int64 {
	t.Helper()
	var sent atomic.Int64
	// The real helper wiring: renewals leave as ipc.TypeDesktopLeaseRenew over
	// the broker connection.
	mgr.WireHelperRevocationLease(func(msgType string, payload any) error {
		if msgType != ipc.TypeDesktopLeaseRenew {
			t.Errorf("helper sent %q, want %q", msgType, ipc.TypeDesktopLeaseRenew)
			return nil
		}
		req, ok := payload.(ipc.DesktopLeaseRenewRequest)
		if !ok {
			t.Errorf("helper renew payload is %T, want ipc.DesktopLeaseRenewRequest", payload)
			return nil
		}
		sent.Add(1)
		if update := answer(req.SessionID); update != nil {
			// The agent answers asynchronously over IPC.
			go mgr.ApplyLeaseUpdate(*update)
		}
		return nil
	})
	return &sent
}

func startHelperHostedSession(t *testing.T, mgr *SessionManager, id string) (*Session, chan string) {
	t.Helper()
	lease := RevocationLease{
		Token:        "lease-token",
		ExpiresAt:    time.Now().Add(scaledLeaseTTL),
		HardDeadline: time.Now().Add(time.Hour),
		Grace:        scaledGrace,
		RenewEvery:   scaledRenew,
	}
	s := newWatchdogTestSession(id, lease)
	mgr.mu.Lock()
	mgr.sessions[id] = s
	mgr.mu.Unlock()

	stopped := make(chan string, 1)
	mgr.OnSessionStopped = func(sessionID, _ string) {
		select {
		case stopped <- sessionID:
		default:
		}
	}
	go mgr.watchSessionLifetime(id, s, SessionPolicy{
		MaxDuration:     time.Hour,
		RevocationLease: &lease,
	}, time.Millisecond)
	return s, stopped
}

func TestHelperHostedSessionSurvivesPastLeaseExpiryWhenRenewalsSucceed(t *testing.T) {
	mgr := NewSessionManager()
	sent := wireHelperBridge(t, mgr, func(sessionID string) *ipc.DesktopLeaseUpdate {
		return &ipc.DesktopLeaseUpdate{
			SessionID:       sessionID,
			ExpiresAtUnixMs: time.Now().Add(scaledLeaseTTL).UnixMilli(),
		}
	})
	s, stopped := startHelperHostedSession(t, mgr, "helper-alive")
	defer s.Stop()

	select {
	case <-stopped:
		t.Fatal("helper-hosted session was killed despite renewals landing over the IPC bridge")
	case <-time.After(scaledRunFor):
	}
	if sent.Load() == 0 {
		t.Fatal("the helper never asked its agent to renew the lease")
	}
}

// The negative control for the test above: with the bridge in place but the
// agent never answering, the SAME session dies at expiresAt+grace. Without this
// the test above could pass on a watchdog that never enforces anything.
func TestHelperHostedSessionStillDiesWhenNoAnswerEverArrives(t *testing.T) {
	mgr := NewSessionManager()
	wireHelperBridge(t, mgr, func(string) *ipc.DesktopLeaseUpdate { return nil })
	s, stopped := startHelperHostedSession(t, mgr, "helper-silent")
	defer s.Stop()

	select {
	case <-stopped:
	case <-time.After(scaledRunFor):
		t.Fatal("an unrenewed helper-hosted session must stop at expiresAt+grace")
	}
}

func TestHelperHostedSessionStopsWhenTheAgentForwardsARevocation(t *testing.T) {
	mgr := NewSessionManager()
	var revoke atomic.Bool
	wireHelperBridge(t, mgr, func(sessionID string) *ipc.DesktopLeaseUpdate {
		if revoke.Load() {
			return &ipc.DesktopLeaseUpdate{
				SessionID: sessionID,
				Revoked:   true,
				Reason:    "membership_removed",
			}
		}
		return &ipc.DesktopLeaseUpdate{
			SessionID:       sessionID,
			ExpiresAtUnixMs: time.Now().Add(scaledLeaseTTL).UnixMilli(),
		}
	})
	s, stopped := startHelperHostedSession(t, mgr, "helper-revoked")
	defer s.Stop()

	// Healthy first, so the stop below is attributable to the revocation and
	// not to a lease that was already lapsing.
	select {
	case <-stopped:
		t.Fatal("session stopped before the revocation was issued")
	case <-time.After(3 * scaledRenew):
	}
	revoke.Store(true)
	select {
	case <-stopped:
	case <-time.After(scaledRunFor):
		t.Fatal("a revocation forwarded by the agent must stop the helper-hosted session")
	}
}

// Wall-clock deadlines let an NTP step or a hostile local clock extend a lease.
// Converting to a TTL at receipt and storing it against the monotonic clock is
// what makes the watchdog immune, so the conversion must be lossless in the
// normal case and must carry a monotonic reading.
func TestRevocationLeaseDeadlinesAreMonotonic(t *testing.T) {
	wall := time.Now().Add(90 * time.Second)
	got := MonotonicDeadline(wall.UnixMilli())
	if got.IsZero() {
		t.Fatal("a positive epoch must produce a deadline")
	}
	if delta := got.Sub(wall); delta > 50*time.Millisecond || delta < -50*time.Millisecond {
		t.Fatalf("deadline drifted %v from the wall-clock value it was derived from", delta)
	}
	// time.Time.Round(0) strips the monotonic reading. Equal() compares
	// instants and is therefore ALWAYS true across that strip — only the
	// formatted form differs, because String() renders a monotonic reading as a
	// trailing " m=+<seconds>". So the format comparison is the whole test.
	if got.String() == got.Round(0).String() {
		t.Fatal("deadline carries no monotonic reading, so a clock step would move it")
	}
	if !MonotonicDeadline(0).IsZero() || !MonotonicDeadline(-1).IsZero() {
		t.Fatal("a non-positive epoch must produce the zero time")
	}
}
