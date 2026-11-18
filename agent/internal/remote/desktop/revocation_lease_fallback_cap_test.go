package desktop

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #11840 follow-up: an answer without the remaining-time fields (an older API,
// or a missing or malformed field) falls back to the absolute timestamps,
// which are read against this device's wall clock. On a device whose clock is
// behind, that stretches the lease by the full lag. The fallback is bounded
// at anchor + the same ceilings the remaining-time path uses
// (MaxRevocationLeaseTTL, MaxSessionDurationCap). The bound only ever
// shortens: a deadline the absolute field puts earlier is kept as it is.

// oldAPILeaseAnswer is what an API without expiresInMs / hardDeadlineInMs
// sends: the deadlines as absolute timestamps in the SERVER's clock. The
// device clock is skew ahead of the server (negative = behind).
func oldAPILeaseAnswer(deviceNow time.Time, skew, ttl, hardIn time.Duration) (expiresAtUnixMs, hardDeadlineUnixMs int64) {
	serverNow := deviceNow.Add(-skew)
	return serverNow.Add(ttl).UnixMilli(), serverNow.Add(hardIn).UnixMilli()
}

func TestAbsoluteFallbackIsCappedOnASlowDevice(t *testing.T) {
	received := time.Now()
	// Device clock 10 min slow: the 60 s lease reads as 11 min left, the 12 h
	// hard deadline as 12 h 10 min.
	expiresAt, hard := oldAPILeaseAnswer(received, -10*time.Minute, time.Minute, MaxSessionDurationCap)

	if got, want := LeaseExpiry(received, 0, expiresAt), received.Add(MaxRevocationLeaseTTL); !got.Equal(want) {
		t.Fatalf("LeaseExpiry = %v (+%v), want capped at +%v", got, got.Sub(received), MaxRevocationLeaseTTL)
	}
	if got, want := LeaseHardDeadline(received, 0, hard), received.Add(MaxSessionDurationCap); !got.Equal(want) {
		t.Fatalf("LeaseHardDeadline = %v (+%v), want capped at +%v", got, got.Sub(received), MaxSessionDurationCap)
	}
}

func TestAbsoluteFallbackIsNeverExtendedOnAFastDevice(t *testing.T) {
	received := time.Now()
	// Device clock 10 min fast: the lease already reads as 9 min expired and
	// the hard deadline as 11 h 50 min away. The cap must not move either.
	expiresAt, hard := oldAPILeaseAnswer(received, 10*time.Minute, time.Minute, MaxSessionDurationCap)

	if got, want := LeaseExpiry(received, 0, expiresAt), time.UnixMilli(expiresAt); !got.Equal(want) {
		t.Fatalf("LeaseExpiry = %v, want the absolute field unchanged %v", got, want)
	}
	if got, want := LeaseHardDeadline(received, 0, hard), time.UnixMilli(hard); !got.Equal(want) {
		t.Fatalf("LeaseHardDeadline = %v, want the absolute field unchanged %v", got, want)
	}
}

// A remaining-time field that decoded to a non-positive value (malformed, or
// negative) is treated as absent; the capped fallback still applies.
func TestAbsoluteFallbackCapAppliesWhenTheRemainingFieldIsMalformed(t *testing.T) {
	received := time.Now()
	expiresAt, hard := oldAPILeaseAnswer(received, -10*time.Minute, time.Minute, MaxSessionDurationCap)

	if got, want := LeaseExpiry(received, -1, expiresAt), received.Add(MaxRevocationLeaseTTL); !got.Equal(want) {
		t.Fatalf("LeaseExpiry = +%v, want capped at +%v", got.Sub(received), MaxRevocationLeaseTTL)
	}
	if got, want := LeaseHardDeadline(received, -1, hard), received.Add(MaxSessionDurationCap); !got.Equal(want) {
		t.Fatalf("LeaseHardDeadline = +%v, want capped at +%v", got.Sub(received), MaxSessionDurationCap)
	}
}

// The start payload goes through NormalizeRevocationLease, anchored at its
// own receipt. Same bound, on both clock directions.
func TestNormalizeRevocationLeaseCapsTheAbsoluteFallback(t *testing.T) {
	for _, tc := range []struct {
		skew    time.Duration
		capped  bool
		comment string
	}{
		{-10 * time.Minute, true, "slow device: the absolute fields read 10 min long"},
		{10 * time.Minute, false, "fast device: the absolute fields are already short"},
	} {
		t.Run(tc.skew.String(), func(t *testing.T) {
			before := time.Now()
			expiresAt, hard := oldAPILeaseAnswer(before, tc.skew, time.Minute, time.Hour)
			lease, err := NormalizeRevocationLease(&ipc.RevocationLease{
				Token:              "tok",
				ExpiresAtUnixMs:    expiresAt,
				HardDeadlineUnixMs: hard,
				RenewEverySec:      25,
				GraceSec:           90,
			})
			after := time.Now()
			if err != nil {
				t.Fatal(err)
			}
			if tc.capped {
				if lease.ExpiresAt.Before(before.Add(MaxRevocationLeaseTTL)) || lease.ExpiresAt.After(after.Add(MaxRevocationLeaseTTL)) {
					t.Fatalf("%s: expiresAt = +%v, want capped at +%v", tc.comment, lease.ExpiresAt.Sub(before), MaxRevocationLeaseTTL)
				}
			} else if !lease.ExpiresAt.Equal(time.UnixMilli(expiresAt)) {
				t.Fatalf("%s: expiresAt = %v, want the absolute field %v", tc.comment, lease.ExpiresAt, time.UnixMilli(expiresAt))
			}
			// A 1 h hard deadline is under the 12 h ceiling either way: the
			// cap leaves it exactly where the absolute field put it.
			if !lease.HardDeadline.Equal(time.UnixMilli(hard)) {
				t.Fatalf("%s: hardDeadline = %v, want the absolute field %v", tc.comment, lease.HardDeadline, time.UnixMilli(hard))
			}
		})
	}
}
