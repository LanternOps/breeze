package desktop

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestEvaluateRevocationLease(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name       string
		snap       revocationLeaseSnapshot
		wantStop   bool
		wantReason string
	}{
		{
			name: "healthy lease keeps streaming",
			snap: revocationLeaseSnapshot{
				expiresAt:    now.Add(30 * time.Second),
				hardDeadline: now.Add(4 * time.Hour),
				grace:        90 * time.Second,
			},
		},
		{
			name: "explicit revocation stops immediately",
			snap: revocationLeaseSnapshot{
				expiresAt:     now.Add(30 * time.Second),
				hardDeadline:  now.Add(4 * time.Hour),
				grace:         90 * time.Second,
				revoked:       true,
				revokedReason: "membership_removed",
			},
			wantStop:   true,
			wantReason: StopReasonLeaseRevoked,
		},
		{
			name: "expired lease still inside its grace window keeps streaming",
			snap: revocationLeaseSnapshot{
				expiresAt:    now.Add(-60 * time.Second),
				hardDeadline: now.Add(4 * time.Hour),
				grace:        90 * time.Second,
			},
		},
		{
			name: "expired lease past its grace window stops",
			snap: revocationLeaseSnapshot{
				expiresAt:    now.Add(-91 * time.Second),
				hardDeadline: now.Add(4 * time.Hour),
				grace:        90 * time.Second,
			},
			wantStop:   true,
			wantReason: StopReasonLeaseExpired,
		},
		{
			name: "grace boundary is inclusive",
			snap: revocationLeaseSnapshot{
				expiresAt:    now.Add(-90 * time.Second),
				hardDeadline: now.Add(4 * time.Hour),
				grace:        90 * time.Second,
			},
			wantStop:   true,
			wantReason: StopReasonLeaseExpired,
		},
		{
			name: "hard deadline stops even while renewals are succeeding",
			snap: revocationLeaseSnapshot{
				expiresAt:    now.Add(30 * time.Second),
				hardDeadline: now.Add(-time.Second),
				grace:        90 * time.Second,
			},
			wantStop:   true,
			wantReason: StopReasonHardDeadline,
		},
		{
			name: "revocation outranks the hard deadline in reporting",
			snap: revocationLeaseSnapshot{
				expiresAt:    now.Add(30 * time.Second),
				hardDeadline: now.Add(-time.Second),
				grace:        90 * time.Second,
				revoked:      true,
			},
			wantStop:   true,
			wantReason: StopReasonLeaseRevoked,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stop, reason := evaluateRevocationLease(now, tt.snap)
			if stop != tt.wantStop {
				t.Fatalf("stop = %v, want %v (reason %q)", stop, tt.wantStop, reason)
			}
			if stop && reason != tt.wantReason {
				t.Fatalf("reason = %q, want %q", reason, tt.wantReason)
			}
		})
	}
}

func TestShouldRequestRenewal(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name        string
		last        time.Time
		renewEvery  time.Duration
		wantRequest bool
	}{
		{"first tick always requests", time.Time{}, 25 * time.Second, true},
		{"too soon", now.Add(-10 * time.Second), 25 * time.Second, false},
		{"exactly due", now.Add(-25 * time.Second), 25 * time.Second, true},
		{"overdue", now.Add(-60 * time.Second), 25 * time.Second, true},
		{"no cadence configured never requests", time.Time{}, 0, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldRequestRenewal(now, tt.last, tt.renewEvery); got != tt.wantRequest {
				t.Fatalf("shouldRequestRenewal = %v, want %v", got, tt.wantRequest)
			}
		})
	}
}

func TestApplyRenewalNeverExtendsTheHardDeadline(t *testing.T) {
	start := time.Now()
	st := newRevocationLeaseState(RevocationLease{
		ExpiresAt:    start.Add(time.Minute),
		HardDeadline: start.Add(time.Hour),
		Grace:        90 * time.Second,
		RenewEvery:   25 * time.Second,
	})

	// A renewal that tries to push the deadline OUT is ignored: the deadline was
	// fixed at session start, and honouring a later one from the wire would let a
	// compromised or buggy control plane defeat the cap entirely.
	st.applyRenewal(start.Add(2*time.Minute), start.Add(10*time.Hour))
	if got := st.snapshot().hardDeadline; !got.Equal(start.Add(time.Hour)) {
		t.Fatalf("hardDeadline = %v, want it unchanged at start+1h", got)
	}
	if got := st.snapshot().expiresAt; !got.Equal(start.Add(2 * time.Minute)) {
		t.Fatalf("expiresAt = %v, want the extended value", got)
	}

	// A renewal that SHORTENS it is honoured (policy tightened mid-session).
	st.applyRenewal(start.Add(3*time.Minute), start.Add(30*time.Minute))
	if got := st.snapshot().hardDeadline; !got.Equal(start.Add(30 * time.Minute)) {
		t.Fatalf("hardDeadline = %v, want the shortened value", got)
	}

	// An expiry that moves BACKWARD is ignored: renewals only ever extend the
	// TTL, and a stale/out-of-order answer must not shorten the grace window.
	st.applyRenewal(start.Add(time.Second), time.Time{})
	if got := st.snapshot().expiresAt; !got.Equal(start.Add(3 * time.Minute)) {
		t.Fatalf("expiresAt = %v, want it unchanged by a backwards renewal", got)
	}
}

// newWatchdogTestSession builds the minimum viable live session: enough state
// for Stop() to run cleanly, without any capture/encode/WebRTC machinery.
func newWatchdogTestSession(id string, lease RevocationLease) *Session {
	s := &Session{
		id:         id,
		done:       make(chan struct{}),
		isActive:   true,
		fps:        30,
		differ:     newFrameDiffer(),
		cursor:     newCursorOverlay(),
		metrics:    newStreamMetrics(),
		leaseState: newRevocationLeaseState(lease),
	}
	s.recordInputActivity()
	return s
}

func runWatchdog(t *testing.T, m *SessionManager, id string, s *Session, policy SessionPolicy) chan string {
	t.Helper()
	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()

	stopped := make(chan string, 1)
	m.OnSessionStopped = func(sessionID, reason string) {
		select {
		case stopped <- sessionID:
		default:
		}
	}
	go m.watchSessionLifetime(id, s, policy, time.Millisecond)
	return stopped
}

func waitForStop(t *testing.T, stopped chan string, want bool) {
	t.Helper()
	select {
	case <-stopped:
		if !want {
			t.Fatal("session was stopped but should have kept streaming")
		}
	case <-time.After(2 * time.Second):
		if want {
			t.Fatal("session was not stopped within the timeout")
		}
	}
}

// The watchdog is driven on millisecond timers here; in production the same
// state machine runs on the 25s renew / 90s grace / 12h deadline values.
func TestWatchdogStopsOnRevocation(t *testing.T) {
	m := NewSessionManager()
	s := newWatchdogTestSession("sess-revoke", RevocationLease{
		ExpiresAt:    time.Now().Add(time.Hour),
		HardDeadline: time.Now().Add(time.Hour),
		Grace:        time.Hour,
		RenewEvery:   time.Millisecond,
	})
	stopped := runWatchdog(t, m, "sess-revoke", s, SessionPolicy{
		MaxDuration:     time.Hour,
		RevocationLease: &RevocationLease{RenewEvery: time.Millisecond},
	})

	m.RevokeSession("sess-revoke", "membership_removed")
	waitForStop(t, stopped, true)
}

func TestWatchdogStopsWhenLeaseExpiresPastGrace(t *testing.T) {
	m := NewSessionManager()
	// Already expired, with a grace window that lapses almost immediately: this
	// is the "API unreachable, nothing ever renews" path.
	s := newWatchdogTestSession("sess-expired", RevocationLease{
		ExpiresAt:    time.Now().Add(-time.Second),
		HardDeadline: time.Now().Add(time.Hour),
		Grace:        5 * time.Millisecond,
		RenewEvery:   time.Millisecond,
	})
	stopped := runWatchdog(t, m, "sess-expired", s, SessionPolicy{
		MaxDuration:     time.Hour,
		RevocationLease: &RevocationLease{RenewEvery: time.Millisecond},
	})

	waitForStop(t, stopped, true)
}

func TestWatchdogStopsAtTheHardDeadlineDespiteHealthyRenewals(t *testing.T) {
	m := NewSessionManager()
	s := newWatchdogTestSession("sess-deadline", RevocationLease{
		ExpiresAt:    time.Now().Add(time.Hour), // lease is perfectly healthy
		HardDeadline: time.Now().Add(5 * time.Millisecond),
		Grace:        time.Hour,
		RenewEvery:   time.Millisecond,
	})
	// Keep renewing successfully throughout — the deadline must still fire.
	var renewals atomic.Int64
	m.RequestRevocationLeaseRenew = func(sessionID string) {
		renewals.Add(1)
		m.ApplyRevocationLease(sessionID, time.Now().Add(time.Hour), time.Time{})
	}
	stopped := runWatchdog(t, m, "sess-deadline", s, SessionPolicy{
		MaxDuration:     time.Hour,
		RevocationLease: &RevocationLease{RenewEvery: time.Millisecond},
	})

	waitForStop(t, stopped, true)
	if renewals.Load() == 0 {
		t.Fatal("expected the watchdog to have requested renewals")
	}
}

func TestWatchdogKeepsStreamingWhileRenewalsSucceed(t *testing.T) {
	m := NewSessionManager()
	s := newWatchdogTestSession("sess-healthy", RevocationLease{
		ExpiresAt:    time.Now().Add(20 * time.Millisecond),
		HardDeadline: time.Now().Add(time.Hour),
		Grace:        10 * time.Millisecond,
		RenewEvery:   time.Millisecond,
	})
	var renewals atomic.Int64
	m.RequestRevocationLeaseRenew = func(sessionID string) {
		renewals.Add(1)
		m.ApplyRevocationLease(sessionID, time.Now().Add(500*time.Millisecond), time.Time{})
	}
	stopped := runWatchdog(t, m, "sess-healthy", s, SessionPolicy{
		MaxDuration:     time.Hour,
		RevocationLease: &RevocationLease{RenewEvery: time.Millisecond},
	})

	// Positive control for the expiry test above: with renewals landing, the
	// same expiry+grace values that stopped that session keep this one alive.
	select {
	case <-stopped:
		t.Fatal("session stopped despite successful renewals")
	case <-time.After(200 * time.Millisecond):
	}
	if renewals.Load() == 0 {
		t.Fatal("expected the watchdog to have requested renewals")
	}
	s.Stop()
}

func TestWatchdogExitsWhenTheSessionStops(t *testing.T) {
	m := NewSessionManager()
	s := newWatchdogTestSession("sess-exit", RevocationLease{
		ExpiresAt:    time.Now().Add(time.Hour),
		HardDeadline: time.Now().Add(time.Hour),
		Grace:        time.Hour,
		RenewEvery:   time.Hour,
	})
	stopped := runWatchdog(t, m, "sess-exit", s, SessionPolicy{
		MaxDuration:     time.Hour,
		RevocationLease: &RevocationLease{RenewEvery: time.Hour},
	})

	s.Stop()
	// The goroutine returns on session.done; it must not fire OnSessionStopped
	// (that is the stopping caller's job, not the watchdog's).
	waitForStop(t, stopped, false)
}
