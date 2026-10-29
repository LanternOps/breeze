package desktop

import (
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

// #10421: before the watchdog stops a session on purpose, it tells the viewer
// why on the control channel, so the viewer shows the reason instead of a
// generic connection error and does not auto-reconnect into a dead session.

func TestSessionEndingNotice(t *testing.T) {
	cases := []struct {
		name          string
		reason        string
		revokedReason string
		policy        SessionPolicy
		fromLifetime  bool
		want          map[string]any
	}{
		{
			name:         "idle timeout carries its length",
			reason:       StopReasonIdleTimeout,
			policy:       SessionPolicy{IdleTimeout: 5 * time.Minute, MaxDuration: time.Hour},
			fromLifetime: true,
			want:         map[string]any{"type": "session_ending", "reason": "idle_timeout_exceeded", "idleTimeoutMinutes": 5},
		},
		{
			name:         "a sub-minute idle timeout rounds up rather than reading 0",
			reason:       StopReasonIdleTimeout,
			policy:       SessionPolicy{IdleTimeout: 30 * time.Second},
			fromLifetime: true,
			want:         map[string]any{"type": "session_ending", "reason": "idle_timeout_exceeded", "idleTimeoutMinutes": 1},
		},
		{
			name:         "policy max duration carries the clamped length",
			reason:       StopReasonHardDeadline,
			policy:       SessionPolicy{MaxDuration: 2 * time.Hour},
			fromLifetime: true,
			want:         map[string]any{"type": "session_ending", "reason": "max_session_duration_exceeded", "maxDurationMinutes": 120},
		},
		{
			name:   "the lease's hard deadline does not claim the policy's length",
			reason: StopReasonHardDeadline,
			policy: SessionPolicy{MaxDuration: 2 * time.Hour},
			want:   map[string]any{"type": "session_ending", "reason": "max_session_duration_exceeded"},
		},
		{
			name:          "revocation carries the control plane's reason",
			reason:        StopReasonLeaseRevoked,
			revokedReason: "permissions_changed",
			want:          map[string]any{"type": "session_ending", "reason": "revoked", "detail": "permissions_changed"},
		},
		{
			name:   "lease expiry carries only the reason",
			reason: StopReasonLeaseExpired,
			want:   map[string]any{"type": "session_ending", "reason": "lease_expired"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sessionEndingNotice(tc.reason, tc.revokedReason, tc.policy, tc.fromLifetime)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("sessionEndingNotice() = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestSessionEndingNoticeBoundsTheRevokedReason(t *testing.T) {
	long := make([]byte, 500)
	for i := range long {
		long[i] = 'a'
	}
	got := sessionEndingNotice(StopReasonLeaseRevoked, string(long), SessionPolicy{}, false)
	if detail, _ := got["detail"].(string); len(detail) != sessionEndingDetailMaxBytes {
		t.Fatalf("detail length = %d, want %d", len(detail), sessionEndingDetailMaxBytes)
	}
}

type fakeBuffered struct{ remaining atomic.Int64 }

func (f *fakeBuffered) BufferedAmount() uint64 {
	v := f.remaining.Add(-100)
	if v < 0 {
		return 0
	}
	return uint64(v)
}

type stuckBuffered struct{}

func (stuckBuffered) BufferedAmount() uint64 { return 1 }

func TestWaitForControlFlushReturnsOnceDrained(t *testing.T) {
	f := &fakeBuffered{}
	f.remaining.Store(300)
	if !waitForControlFlush(f, time.Second, time.Millisecond) {
		t.Fatal("expected the drained channel to report flushed")
	}
}

func TestWaitForControlFlushGivesUpAtTheTimeout(t *testing.T) {
	start := time.Now()
	if waitForControlFlush(stuckBuffered{}, 20*time.Millisecond, time.Millisecond) {
		t.Fatal("a channel that never drains must not report flushed")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("waited %v, want about the 20ms timeout", elapsed)
	}
}

func TestNotifySessionEndingWithoutAControlChannelDoesNotBlock(t *testing.T) {
	s := newWatchdogTestSession("sess-nodc", RevocationLease{})
	done := make(chan struct{})
	go func() {
		s.notifySessionEnding(map[string]any{"type": "session_ending", "reason": "idle_timeout_exceeded"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("notifySessionEnding blocked with no control channel")
	}
}

// The watchdog must tell the viewer BEFORE it stops the session: once the peer
// is closed the control channel is gone.
func TestWatchdogNotifiesTheViewerBeforeAnIdleStop(t *testing.T) {
	m := NewSessionManager()
	s := newWatchdogTestSession("sess-idle", RevocationLease{
		ExpiresAt:    time.Now().Add(time.Hour),
		HardDeadline: time.Now().Add(time.Hour),
		Grace:        time.Hour,
		RenewEvery:   time.Hour,
	})
	s.lastInputUnixNano.Store(time.Now().Add(-time.Hour).UnixNano())

	notices := make(chan map[string]any, 1)
	m.notifyEnding = func(session *Session, body map[string]any) {
		select {
		case <-session.done:
			t.Error("notice sent after the session was already stopped")
		default:
		}
		notices <- body
	}
	stopped := runWatchdog(t, m, "sess-idle", s, SessionPolicy{
		MaxDuration:     time.Hour,
		IdleTimeout:     5 * time.Minute,
		RevocationLease: &RevocationLease{RenewEvery: time.Hour},
	})
	waitForStop(t, stopped, true)

	select {
	case body := <-notices:
		want := map[string]any{"type": "session_ending", "reason": "idle_timeout_exceeded", "idleTimeoutMinutes": 5}
		if !reflect.DeepEqual(body, want) {
			t.Fatalf("notice = %#v, want %#v", body, want)
		}
	default:
		t.Fatal("the watchdog stopped the session without telling the viewer why")
	}
}
