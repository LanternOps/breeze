package desktop

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #11840: the lease expiry was an absolute server timestamp read against the
// device's wall clock, so a device running ~2 min fast lost every session
// ~20 s in, and a device running slow kept a silent session alive for the
// full lag. These pin the clock-independent form: a remaining duration
// measured from receipt on the monotonic clock.

func TestLeaseExpiryPrefersTheRemainingDuration(t *testing.T) {
	received := time.Now()
	// The device clock runs 10 min ahead, so the server's absolute expiry
	// looks 9 min stale. The remaining duration must win.
	stale := received.Add(-10 * time.Minute).Add(time.Minute).UnixMilli()

	if got, want := LeaseExpiry(received, 60_000, stale), received.Add(time.Minute); !got.Equal(want) {
		t.Fatalf("LeaseExpiry = %v, want %v", got, want)
	}
	if got, want := LeaseHardDeadline(received, (4*time.Hour).Milliseconds(), stale), received.Add(4*time.Hour); !got.Equal(want) {
		t.Fatalf("LeaseHardDeadline = %v, want %v", got, want)
	}
}

func TestLeaseExpiryFallsBackToTheAbsoluteTimestampFromAnOlderAPI(t *testing.T) {
	received := time.Now()
	abs := received.Add(time.Minute).UnixMilli()
	if got, want := LeaseExpiry(received, 0, abs), time.UnixMilli(abs); !got.Equal(want) {
		t.Fatalf("LeaseExpiry = %v, want %v", got, want)
	}
	if got := LeaseExpiry(received, 0, 0); !got.IsZero() {
		t.Fatalf("an absent deadline must stay absent, got %v", got)
	}
	if got := LeaseHardDeadline(received, -5, 0); !got.IsZero() {
		t.Fatalf("a non-positive remaining time is absent, got %v", got)
	}
}

// A malformed answer must not keep a silent session alive far past its outage
// budget, nor push the hard deadline past the local 12h ceiling.
func TestLeaseExpiryCapsTheRemainingDuration(t *testing.T) {
	received := time.Now()
	if got, want := LeaseExpiry(received, (24*time.Hour).Milliseconds(), 0), received.Add(MaxRevocationLeaseTTL); !got.Equal(want) {
		t.Fatalf("LeaseExpiry = %v, want capped at %v", got, want)
	}
	if got, want := LeaseHardDeadline(received, 1<<62, 0), received.Add(MaxSessionDurationCap); !got.Equal(want) {
		t.Fatalf("LeaseHardDeadline = %v, want capped at %v", got, want)
	}
}

// The deadline is measured on the monotonic clock: it carries the receipt
// reading, so a later wall-clock step cannot move it.
func TestLeaseExpiryIsAnchoredToTheMonotonicClock(t *testing.T) {
	received := time.Now()
	got := LeaseExpiry(received, 60_000, 0)
	// time.Time.String prints "m=±…" only for a reading with a monotonic clock.
	if !strings.Contains(got.String(), " m=") {
		t.Fatalf("the resolved expiry must carry a monotonic reading: %s", got)
	}
}

func TestNormalizeRevocationLeaseUsesTheRemainingDurations(t *testing.T) {
	serverNow := time.Now().Add(-10 * time.Minute) // device 10 min fast
	before := time.Now()
	lease, err := NormalizeRevocationLease(&ipc.RevocationLease{
		Token:              "tok",
		ExpiresAtUnixMs:    serverNow.Add(time.Minute).UnixMilli(),
		ExpiresInMs:        60_000,
		HardDeadlineUnixMs: serverNow.Add(time.Hour).UnixMilli(),
		HardDeadlineInMs:   time.Hour.Milliseconds(),
		RenewEverySec:      25,
		GraceSec:           90,
	})
	after := time.Now()
	if err != nil {
		t.Fatal(err)
	}
	if lease.ExpiresAt.Before(before.Add(time.Minute)) || lease.ExpiresAt.After(after.Add(time.Minute)) {
		t.Fatalf("expiresAt = %v, want ~now+1m", lease.ExpiresAt)
	}
	if lease.HardDeadline.Before(before.Add(time.Hour)) || lease.HardDeadline.After(after.Add(time.Hour)) {
		t.Fatalf("hardDeadline = %v, want ~now+1h", lease.HardDeadline)
	}

	// A lease carrying only the remaining form is still a usable lease, and
	// the missing hard deadline back-fills the 12h cap.
	before = time.Now()
	only, err := NormalizeRevocationLease(&ipc.RevocationLease{ExpiresInMs: 60_000, RenewEverySec: 25})
	after = time.Now()
	if err != nil {
		t.Fatalf("a lease with only expiresInMs must be accepted: %v", err)
	}
	if only.ExpiresAt.Before(before.Add(time.Minute)) || only.ExpiresAt.After(after.Add(time.Minute)) {
		t.Fatalf("expiresAt = %v, want ~now+1m", only.ExpiresAt)
	}
	if only.HardDeadline.Before(before.Add(MaxSessionDurationCap)) || only.HardDeadline.After(after.Add(MaxSessionDurationCap)) {
		t.Fatalf("hardDeadline = %v, want ~now+12h", only.HardDeadline)
	}
}

// End to end on the watchdog (issue acceptance criterion 4): with the device
// clock 10 min fast or slow, a session holds while renewals land, and stops
// within the intended window — expiresAt+grace after the last renewal, give or
// take one watchdog tick — once they cease.
func TestWatchdogHoldsAndStopsOnTimeUnderDeviceClockSkew(t *testing.T) {
	for _, skew := range []time.Duration{10 * time.Minute, -10 * time.Minute} {
		t.Run(skew.String(), func(t *testing.T) {
			var answering atomic.Bool
			answering.Store(true)
			var lastRenewal atomic.Int64 // virtual UnixNano of the last applied renewal
			h := newWsLeaseHarness(t, "ws-skew", func(h *wsLeaseHarness, sessionID string) {
				if !answering.Load() {
					return
				}
				// What a current API sends: the absolute expiry in ITS clock
				// (device clock minus the skew) plus the remaining duration.
				deviceNow := h.clock.Now()
				serverNow := deviceNow.Add(-skew)
				h.mgr.ApplyRevocationLease(sessionID,
					LeaseExpiry(deviceNow, helperLeaseTTL.Milliseconds(), serverNow.Add(helperLeaseTTL).UnixMilli()),
					LeaseHardDeadline(deviceNow, time.Hour.Milliseconds(), serverNow.Add(time.Hour).UnixMilli()))
				lastRenewal.Store(deviceNow.UnixNano())
			})

			if lived := h.run(5 * time.Minute); lived != 5*time.Minute {
				t.Fatalf("stream stopped after %s although every renewal succeeded", lived)
			}

			answering.Store(false)
			cutoff := h.clock.Now()
			h.run(helperRunFor)
			if got := h.awaitStopCallback(); got != "ws-skew:"+StopReasonLeaseExpired {
				t.Fatalf("OnSessionStopped = %q, want ws-skew:%s", got, StopReasonLeaseExpired)
			}
			stoppedAt := h.clock.Now()
			last := time.Unix(0, lastRenewal.Load())
			if last.After(cutoff) {
				t.Fatal("a renewal landed after answers were switched off")
			}
			// The watchdog decides on tick T and the harness observes the stop
			// on tick T+1, so the observed stop is up to two ticks after the
			// deadline.
			deadline := last.Add(helperLeaseTTL + helperGrace)
			if stoppedAt.Before(deadline) || stoppedAt.After(deadline.Add(2*watchdogTickInterval)) {
				t.Fatalf("stopped at last renewal +%s, want +%s (within two ticks)",
					stoppedAt.Sub(last), helperLeaseTTL+helperGrace)
			}
		})
	}
}

// Control: the same harness fed only the absolute timestamp (an older API) on
// a device 10 min fast reproduces the field failure — the session cannot be
// held at all — which is what the remaining-duration form fixes.
func TestWatchdogWithAbsoluteOnlyLeaseCannotHoldOnAFastDevice(t *testing.T) {
	const skew = 10 * time.Minute
	h := newWsLeaseHarness(t, "ws-abs", func(h *wsLeaseHarness, sessionID string) {
		serverNow := h.clock.Now().Add(-skew)
		h.mgr.ApplyRevocationLease(sessionID,
			LeaseExpiry(h.clock.Now(), 0, serverNow.Add(helperLeaseTTL).UnixMilli()),
			time.Time{})
	})
	if lived := h.run(5 * time.Minute); lived >= 5*time.Minute {
		t.Fatal("control failed: an absolute-only lease on a 10 min fast device should not hold a session")
	}
}
