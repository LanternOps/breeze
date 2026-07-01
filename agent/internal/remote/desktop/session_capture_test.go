package desktop

import (
	"testing"
	"time"
)

func TestSampleDuration(t *testing.T) {
	const fallback = 16 * time.Millisecond

	tests := []struct {
		name string
		// lastAgo < 0 means "never written" (lastSampleNanos = 0)
		lastAgo time.Duration
		// exact expected value, or 0 to use the range check below
		wantExact time.Duration
		wantMin   time.Duration
		wantMax   time.Duration
	}{
		{name: "first frame falls back", lastAgo: -1, wantExact: fallback},
		{name: "sub-millisecond delta falls back", lastAgo: 0, wantExact: fallback},
		{name: "normal gap returns real elapsed", lastAgo: 100 * time.Millisecond, wantMin: 100 * time.Millisecond, wantMax: time.Second},
		{name: "idle gap returns real elapsed", lastAgo: 2 * time.Second, wantMin: 2 * time.Second, wantMax: 3 * time.Second},
		{name: "pathological gap capped", lastAgo: 30 * time.Second, wantExact: maxSampleDuration},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Session{id: "test"}
			if tt.lastAgo >= 0 {
				s.lastSampleNanos.Store(time.Now().Add(-tt.lastAgo).UnixNano())
			}
			got := s.sampleDuration(fallback)
			if tt.wantExact != 0 {
				if got != tt.wantExact {
					t.Fatalf("sampleDuration = %v, want %v", got, tt.wantExact)
				}
				return
			}
			if got < tt.wantMin || got > tt.wantMax {
				t.Fatalf("sampleDuration = %v, want within [%v, %v]", got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestNoteSampleWrite_AdvancesSampleClock(t *testing.T) {
	s := &Session{id: "test"}
	if s.lastSampleNanos.Load() != 0 {
		t.Fatal("expected zero-value sample clock")
	}
	before := time.Now().UnixNano()
	s.noteSampleWrite()
	got := s.lastSampleNanos.Load()
	if got < before {
		t.Fatalf("noteSampleWrite did not advance lastSampleNanos: %d < %d", got, before)
	}
}

// TestMaybeResendCachedFrameOnIdle_DoesNotAdvanceSampleClock pins the
// capture-alive vs sample-written separation: the idle heartbeat bumps
// lastVideoWriteUnixNano (to keep the no-video watchdog quiet) but must NOT
// touch lastSampleNanos — if it did, the idle gap would be absorbed into the
// heartbeat and the next real frame's sampleDuration would no longer reflect
// the true inter-sample gap, re-introducing the media-clock drift this
// separation was added to fix.
func TestMaybeResendCachedFrameOnIdle_DoesNotAdvanceSampleClock(t *testing.T) {
	s := &Session{id: "test"}
	s.noteSampleWrite()
	sampleClockBefore := s.lastSampleNanos.Load()

	// Make the session look idle past the resend interval so the heartbeat
	// branch actually runs (rather than returning early).
	idleSince := time.Now().Add(-2 * staticDesktopResendInterval)
	s.lastVideoWriteUnixNano.Store(idleSince.UnixNano())

	s.maybeResendCachedFrameOnIdle(16 * time.Millisecond)

	if got := s.lastSampleNanos.Load(); got != sampleClockBefore {
		t.Fatalf("idle heartbeat advanced lastSampleNanos (%d -> %d); it must only touch lastVideoWriteUnixNano", sampleClockBefore, got)
	}
	if got := s.lastVideoWriteUnixNano.Load(); got <= idleSince.UnixNano() {
		t.Fatalf("idle heartbeat did not bump lastVideoWriteUnixNano (still %d)", got)
	}
}
