package websocket

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// simulateAnchorBaseWallShift makes leaseAnchorBase's wall reading sit shift
// away from "now minus the monotonic time elapsed since it". That is what a
// wall-clock step since the agent started looks like (or, where the monotonic
// clock pauses, a sleep since then): elapsed time is still measured
// correctly, but the base's own wall reading no longer matches the clock.
func simulateAnchorBaseWallShift(t *testing.T, shift time.Duration) {
	t.Helper()
	origBase, origElapsed := leaseAnchorBase, leaseAnchorElapsed
	t.Cleanup(func() { leaseAnchorBase, leaseAnchorElapsed = origBase, origElapsed })
	realStart := time.Now().Add(-time.Hour)
	leaseAnchorBase = realStart.Add(shift)
	leaseAnchorElapsed = func(at time.Time) time.Duration { return at.Sub(realStart) }
}

// #11840 review: the deadline forwarded to a helper is read against the
// helper's CURRENT wall clock, so the request instant it is measured from must
// be expressed on the current wall clock too, not on "process start + elapsed
// monotonic time". Otherwise any wall step since the agent started shifts the
// helper's deadline by the step: forward ends sessions early, backward
// stretches the lease past what the server granted.
func TestRenewedLeaseForwardedToTheHelperIsOnTheCurrentWallClock(t *testing.T) {
	const expiresIn, hardIn = time.Minute, time.Hour
	for name, shift := range map[string]time.Duration{
		"anchor base 10m behind the wall clock":   -10 * time.Minute,
		"anchor base 10m ahead of the wall clock": 10 * time.Minute,
	} {
		t.Run(name, func(t *testing.T) {
			simulateAnchorBaseWallShift(t, shift)

			c := &Client{sendChan: make(chan []byte, 1), done: make(chan struct{})}
			before := time.Now()
			if err := c.SendRevocationLeaseRenew("s1"); err != nil {
				t.Fatal(err)
			}
			var sent map[string]any
			if err := json.Unmarshal(<-c.sendChan, &sent); err != nil {
				t.Fatal(err)
			}

			var got RevocationLeaseMessage
			c.OnRevocationLease = func(msg RevocationLeaseMessage) { got = msg }
			raw, _ := json.Marshal(map[string]any{
				"type": "revocation_lease", "sessionId": "s1",
				"expiresInMs": expiresIn.Milliseconds(), "hardDeadlineInMs": hardIn.Milliseconds(),
				"renewAnchor": sent["renewAnchor"],
			})
			c.handleRevocationLeaseMessage("revocation_lease", raw)
			after := time.Now()
			if got.RequestedAt.IsZero() {
				t.Fatal("the echoed anchor must be usable")
			}

			// What heartbeat.withResolvedLeaseDeadlines forwards.
			anchor := got.LeaseClockAnchor()
			forwarded := map[string]struct {
				unixMs int64
				in     time.Duration
			}{
				"expiresAt":    {desktop.LeaseExpiry(anchor, got.ExpiresInMs, got.ExpiresAtUnixMs).UnixMilli(), expiresIn},
				"hardDeadline": {desktop.LeaseHardDeadline(anchor, got.HardDeadlineInMs, got.HardDeadlineUnixMs).UnixMilli(), hardIn},
			}
			for field, f := range forwarded {
				// Within the round trip of now + granted remaining, and never
				// later than the server granted. 1 ms for the anchor's
				// millisecond resolution.
				lo := before.Add(f.in).UnixMilli() - 1
				hi := after.Add(f.in).UnixMilli()
				if f.unixMs < lo || f.unixMs > hi {
					t.Fatalf("forwarded %s = %d, want within [%d, %d] (off by %v)",
						field, f.unixMs, lo, hi, time.Duration(f.unixMs-hi)*time.Millisecond)
				}
			}
		})
	}
}
