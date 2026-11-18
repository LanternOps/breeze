package websocket

import (
	"encoding/json"
	"testing"
	"time"
)

// #11840: every renewal request carries a renewAnchor, and an answer that
// echoes it is measured from when the agent ASKED, so no delay on the way
// (the request, the server's checks, the answer) can stretch the lease past
// what the server granted.
func TestRenewRequestCarriesAnAnchorTheAnswerResolvesBackToTheRequestTime(t *testing.T) {
	c := &Client{sendChan: make(chan []byte, 1), done: make(chan struct{})}
	before := time.Now()
	if err := c.SendRevocationLeaseRenew("s1"); err != nil {
		t.Fatal(err)
	}
	after := time.Now()
	var sent map[string]any
	if err := json.Unmarshal(<-c.sendChan, &sent); err != nil {
		t.Fatal(err)
	}
	anchor, ok := sent["renewAnchor"].(float64)
	if !ok || anchor < 0 {
		t.Fatalf("renew request must carry a non-negative renewAnchor: %#v", sent)
	}

	var got RevocationLeaseMessage
	c.OnRevocationLease = func(msg RevocationLeaseMessage) { got = msg }
	raw, _ := json.Marshal(map[string]any{
		"type": "revocation_lease", "sessionId": "s1",
		"expiresAt": 1, "expiresInMs": 60000, "renewAnchor": anchor,
	})
	c.handleRevocationLeaseMessage("revocation_lease", raw)

	// Millisecond resolution: the recovered time sits up to 1 ms below the
	// real request time, never above it.
	if got.RequestedAt.Before(before.Add(-time.Millisecond)) || got.RequestedAt.After(after) {
		t.Fatalf("RequestedAt = %v, want within [%v, %v]", got.RequestedAt, before, after)
	}
	if !got.LeaseClockAnchor().Equal(got.RequestedAt) {
		t.Fatal("an echoed anchor must be what the lease is measured from")
	}
	if got.RequestedAt.After(got.ReceivedAt) {
		t.Fatal("the request cannot have been queued after its answer arrived")
	}
}

func TestUnusableRenewAnchorFallsBackToReceipt(t *testing.T) {
	cases := map[string]any{
		"absent":   nil,
		"negative": -5,
		"future":   float64(time.Since(leaseAnchorBase).Milliseconds() + 3_600_000),
	}
	for name, echo := range cases {
		t.Run(name, func(t *testing.T) {
			var got RevocationLeaseMessage
			c := &Client{OnRevocationLease: func(msg RevocationLeaseMessage) { got = msg }}
			frame := map[string]any{"type": "revocation_lease", "sessionId": "s1", "expiresAt": 1}
			if echo != nil {
				frame["renewAnchor"] = echo
			}
			raw, _ := json.Marshal(frame)
			c.handleRevocationLeaseMessage("revocation_lease", raw)
			if got.SessionID != "s1" {
				t.Fatalf("frame not delivered: %#v", got)
			}
			if !got.RequestedAt.IsZero() {
				t.Fatalf("an unusable echo must be ignored, got RequestedAt %v", got.RequestedAt)
			}
			if !got.LeaseClockAnchor().Equal(got.ReceivedAt) {
				t.Fatal("without a usable echo the lease is measured from receipt")
			}
		})
	}
}

// A huge remaining value must saturate, not wrap to a negative "absent" that
// would fall back to the device's wall clock.
func TestHugeRemainingDurationSaturates(t *testing.T) {
	var got RevocationLeaseMessage
	c := &Client{OnRevocationLease: func(msg RevocationLeaseMessage) { got = msg }}
	raw := []byte(`{"type":"revocation_lease","sessionId":"s1","expiresAt":1,"expiresInMs":1e30,"hardDeadlineInMs":-4}`)
	c.handleRevocationLeaseMessage("revocation_lease", raw)
	if got.ExpiresInMs <= 0 {
		t.Fatalf("a huge expiresInMs must stay positive, got %d", got.ExpiresInMs)
	}
	if got.HardDeadlineInMs != 0 {
		t.Fatalf("a negative hardDeadlineInMs is absent, got %d", got.HardDeadlineInMs)
	}
}
