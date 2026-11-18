package collectors

import (
	"testing"
	"time"
)

func TestCachedHostProbe(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	checks := 0
	answer := false
	probe := newCachedHostProbe(hostProbeAvailabilityTTL, func() bool {
		checks++
		return answer
	})
	probe.now = func() time.Time { return now }

	for range 2 {
		if probe.get() != false {
			t.Fatal("want the cached false answer")
		}
	}
	if checks != 1 {
		t.Fatalf("detect ran %d times within the TTL, want 1", checks)
	}

	// The host changes, but the answer is trusted until the TTL passes.
	answer = true
	now = now.Add(24*time.Hour - time.Nanosecond)
	if probe.get() != false {
		t.Fatal("answer refreshed before the TTL passed")
	}
	now = now.Add(time.Nanosecond)
	if probe.get() != true {
		t.Fatal("answer not refreshed once the TTL passed")
	}
	if checks != 2 {
		t.Fatalf("detect ran %d times across one expiry, want 2", checks)
	}
}
