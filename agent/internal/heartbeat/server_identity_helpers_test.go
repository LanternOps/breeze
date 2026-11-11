package heartbeat

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

// #8318 review fix 14: the identity sync and the reattach share one backoff
// and one log-once helper.
func TestDoublingBackoff(t *testing.T) {
	cases := []struct {
		failures int
		lo, hi   time.Duration
		want     time.Duration
	}{
		{1, rebindRetryMin, rebindRetryMax, 30 * time.Second},
		{2, rebindRetryMin, rebindRetryMax, time.Minute},
		{4, rebindRetryMin, rebindRetryMax, 4 * time.Minute},
		{5, rebindRetryMin, rebindRetryMax, rebindRetryMax},
		{40, rebindRetryMin, rebindRetryMax, rebindRetryMax},
		{3, identityWriteRetryMin, identityWriteRetryMax, 2 * time.Minute},
	}
	for _, tc := range cases {
		if got := doublingBackoff(tc.failures, tc.lo, tc.hi); got != tc.want {
			t.Errorf("doublingBackoff(%d, %v, %v) = %v, want %v", tc.failures, tc.lo, tc.hi, got, tc.want)
		}
	}
	if identityWriteRetryDelay(3) != doublingBackoff(3, identityWriteRetryMin, identityWriteRetryMax) {
		t.Error("identityWriteRetryDelay does not use the shared backoff")
	}
}

func TestLogOncePerReason(t *testing.T) {
	buf := &syncBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	var a, b atomic.Pointer[string]
	logOncePerReason(&a, "warn", "ignoring rebind directive", "expired")
	logOncePerReason(&a, "warn", "ignoring rebind directive", "expired")
	logOncePerReason(&b, "warn", "ignoring rebind directive", "expired") // another flow's slot
	logOncePerReason(&a, "error", "ignoring rebind directive", "unpinned")
	logOncePerReason(&a, "warn", "ignoring rebind directive", "expired") // a new reason since
	out := buf.String()
	if n := strings.Count(out, "reason=expired"); n != 3 {
		t.Fatalf("logged the repeated reason %d times, want 3 (once per slot, again after a change):\n%s", n, out)
	}
	if !strings.Contains(out, "level=ERROR") {
		t.Fatal("the level was not honoured")
	}
}
