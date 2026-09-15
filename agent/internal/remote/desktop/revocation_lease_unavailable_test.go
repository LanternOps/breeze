package desktop

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// SEC-038 owner decision 2: a start whose FIRST lease renewal comes back
// `unavailable` hard-stops instead of riding the 90 s grace — a session that
// has never been confirmed by the control plane has no standing to keep
// streaming through an outage. Renewals after the session is established keep
// the grace unchanged, so a live session still rides out a Redis blip.

func TestFirstRenewalUnavailableRevokesImmediately(t *testing.T) {
	st := newRevocationLeaseState(RevocationLease{
		ExpiresAt:    time.Now().Add(time.Minute),
		HardDeadline: time.Now().Add(time.Hour),
		Grace:        90 * time.Second,
		RenewEvery:   25 * time.Second,
	})

	st.noteRenewalUnavailable()

	stop, reason := evaluateRevocationLease(time.Now(), st.snapshot())
	if !stop {
		t.Fatal("an unavailable answer to the first renewal must stop the session")
	}
	if reason != StopReasonLeaseRevoked {
		t.Fatalf("stop reason = %q, want %q", reason, StopReasonLeaseRevoked)
	}
	if got := st.snapshot().revokedReason; got != StopReasonLeaseUnavailableAtStart {
		t.Fatalf("revoked reason = %q, want %q", got, StopReasonLeaseUnavailableAtStart)
	}
}

func TestLaterRenewalUnavailableRidesGrace(t *testing.T) {
	now := time.Now()
	st := newRevocationLeaseState(RevocationLease{
		ExpiresAt:    now.Add(time.Minute),
		HardDeadline: now.Add(time.Hour),
		Grace:        90 * time.Second,
		RenewEvery:   25 * time.Second,
	})

	// The session is established: one renewal has succeeded.
	st.applyRenewal(now.Add(2*time.Minute), time.Time{})
	st.noteRenewalUnavailable()

	if stop, _ := evaluateRevocationLease(now, st.snapshot()); stop {
		t.Fatal("an unavailable answer on an established session must ride the grace window")
	}
	// ...and the grace still ends the session once expiry+grace passes.
	if stop, reason := evaluateRevocationLease(now.Add(5*time.Minute), st.snapshot()); !stop || reason != StopReasonLeaseExpired {
		t.Fatalf("grace must still expire the session: stop=%v reason=%q", stop, reason)
	}
}

func TestUnavailableAfterRevocationKeepsOriginalReason(t *testing.T) {
	st := newRevocationLeaseState(RevocationLease{ExpiresAt: time.Now().Add(time.Minute)})
	st.revoke("membership_removed")
	st.noteRenewalUnavailable()
	if got := st.snapshot().revokedReason; got != "membership_removed" {
		t.Fatalf("a later unavailable must not overwrite the real revocation reason, got %q", got)
	}
}

// The manager-level entry point the agent calls when the control plane answers
// `revocation_lease_unavailable`. An unknown session id is ignored.
func TestSessionManagerNoteLeaseUnavailableIsSafeForUnknownSession(t *testing.T) {
	m := NewSessionManager()
	m.NoteLeaseUnavailable("nope") // must not panic
}

func TestApplyLeaseUpdateRoutesUnavailable(t *testing.T) {
	m := NewSessionManager()
	// No session: the call is a no-op, but it must be ROUTED as unavailable,
	// not decoded as a renewal with zero deadlines (which would mark the
	// session established and hand it the grace window it must not get).
	m.ApplyLeaseUpdate(ipc.DesktopLeaseUpdate{SessionID: "s1", Unavailable: true})
}
