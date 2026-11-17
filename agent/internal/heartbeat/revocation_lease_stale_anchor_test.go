package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/websocket"
)

// #11840 review: an answer measured from an OLD but valid anchor (applied
// late, or delivered twice) resolves to deadlines earlier than a fresh answer
// would. It must go through the same forward-only ratchet as any renewal
// (desktop revocationLeaseState.applyRenewal): the expiry never moves back,
// and the hard deadline never moves out. The only thing such an answer can
// still do is pull the hard deadline in, by at most the anchor's age, which
// is the direction the cap allows.
func TestRenewalWithAnOldAnchorNeitherExtendsNorShortensTheLease(t *testing.T) {
	h, mgr := startSkewTestStream(t, "ws-stale")

	// A fresh renewal first.
	fresh := time.Now()
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:        "ws-stale",
		ExpiresInMs:      time.Minute.Milliseconds(),
		HardDeadlineInMs: (30 * time.Minute).Milliseconds(),
		ReceivedAt:       fresh,
		RequestedAt:      fresh,
	})
	want, ok := mgr.LeaseStatus("ws-stale")
	if !ok || want.Revoked {
		t.Fatalf("fresh renewal must leave the stream live: %+v", want)
	}

	// The answer to a request made 50 s earlier lands afterwards. Granting a
	// longer hard deadline must not move it out; its expiry, measured from
	// the old request, is earlier than the current one and must not pull it in.
	old := fresh.Add(-50 * time.Second)
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:        "ws-stale",
		ExpiresInMs:      time.Minute.Milliseconds(),
		HardDeadlineInMs: (2 * time.Hour).Milliseconds(),
		ReceivedAt:       time.Now(),
		RequestedAt:      old,
	})
	got, _ := mgr.LeaseStatus("ws-stale")
	if got.Revoked {
		t.Fatal("a late renewal is still a renewal, not a revocation")
	}
	if !got.ExpiresAt.Equal(want.ExpiresAt) {
		t.Fatalf("expiresAt moved from %v to %v: an old anchor must not shorten the lease", want.ExpiresAt, got.ExpiresAt)
	}
	if !got.HardDeadline.Equal(want.HardDeadline) {
		t.Fatalf("hardDeadline moved from %v to %v: an old anchor must not extend the cap", want.HardDeadline, got.HardDeadline)
	}

	// The same late answer replayed with the SAME hard deadline it was
	// granted then: that resolves 50 s earlier than the live cap, and pulling
	// the cap in is the one move applyRenewal allows. Bounded by the anchor's
	// age, never beyond what the server granted.
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:        "ws-stale",
		ExpiresInMs:      time.Minute.Milliseconds(),
		HardDeadlineInMs: (30 * time.Minute).Milliseconds(),
		ReceivedAt:       time.Now(),
		RequestedAt:      old,
	})
	got, _ = mgr.LeaseStatus("ws-stale")
	if !got.ExpiresAt.Equal(want.ExpiresAt) {
		t.Fatalf("expiresAt moved from %v to %v on a replay", want.ExpiresAt, got.ExpiresAt)
	}
	if wantHard := old.Add(30 * time.Minute); !got.HardDeadline.Equal(wantHard) {
		t.Fatalf("hardDeadline = %v, want %v (pulled in by the anchor's age, no further)", got.HardDeadline, wantHard)
	}
}
