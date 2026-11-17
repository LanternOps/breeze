package heartbeat

import (
	"testing"
	"time"
)

// #11840: a device whose clock ran ~2 minutes fast lost every desktop session
// ~20 s after it started, because the agent compared the server's ABSOLUTE
// lease expiry with its own wall clock. A current API also ships each
// deadline as a duration remaining at send time, and the agent must measure
// that duration from receipt, so its wall clock no longer matters.
//
// `skew` is how far the device clock runs AHEAD of the server's: the server's
// absolute timestamps are built from serverNow = deviceNow - skew.
var leaseSkews = []time.Duration{10 * time.Minute, -10 * time.Minute, 2 * time.Minute}

func assertNear(t *testing.T, what string, got, lo, hi time.Time) {
	t.Helper()
	if got.Before(lo) || got.After(hi) {
		t.Fatalf("%s = %v, want within [%v, %v] (off by %v)", what, got, lo, hi, got.Sub(lo))
	}
}

func TestParseRevocationLeaseIgnoresDeviceClockSkew(t *testing.T) {
	for _, skew := range leaseSkews {
		t.Run(skew.String(), func(t *testing.T) {
			serverNow := time.Now().Add(-skew)
			payload := map[string]any{"revocationLease": map[string]any{
				"token":            "tok",
				"expiresAt":        float64(serverNow.Add(time.Minute).UnixMilli()),
				"expiresInMs":      float64(time.Minute.Milliseconds()),
				"hardDeadline":     float64(serverNow.Add(4 * time.Hour).UnixMilli()),
				"hardDeadlineInMs": float64((4 * time.Hour).Milliseconds()),
				"renewEverySec":    float64(25),
				"graceSec":         float64(90),
			}}

			before := time.Now()
			lease := parseRevocationLease(payload)
			after := time.Now()
			if lease == nil {
				t.Fatal("a valid lease block must decode")
			}
			assertNear(t, "expiresAt", lease.ExpiresAt, before.Add(time.Minute), after.Add(time.Minute))
			assertNear(t, "hardDeadline", lease.HardDeadline, before.Add(4*time.Hour), after.Add(4*time.Hour))
		})
	}
}

// An older API sends only the absolute timestamps; the agent must keep
// honouring them exactly as before (wire compatibility).
func TestParseRevocationLeaseFromAnOlderAPIStillUsesTheAbsoluteExpiry(t *testing.T) {
	now := time.Now()
	lease := parseRevocationLease(map[string]any{"revocationLease": map[string]any{
		"token":         "tok",
		"expiresAt":     float64(now.Add(time.Minute).UnixMilli()),
		"hardDeadline":  float64(now.Add(4 * time.Hour).UnixMilli()),
		"renewEverySec": float64(25),
		"graceSec":      float64(90),
	}})
	if lease == nil {
		t.Fatal("a valid lease block must decode")
	}
	assertNear(t, "expiresAt", lease.ExpiresAt, now.Add(time.Minute-time.Second), now.Add(time.Minute+time.Second))
	assertNear(t, "hardDeadline", lease.HardDeadline, now.Add(4*time.Hour-time.Second), now.Add(4*time.Hour+time.Second))
}
