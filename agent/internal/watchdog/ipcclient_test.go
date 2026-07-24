package watchdog

import (
	"testing"
	"time"
)

// pingVerdict is the liveness decision at ping time (#2763): any envelope
// received since the previous ping proves the agent alive, not just an
// explicit pong — the agent's ping handler can starve behind heavy collection
// work (WUA scans) while state_syncs keep flowing on the same pipe, and
// counting only pongs produced three consecutive false negatives and a kill
// cycle of a healthy agent in the field.
func TestPingVerdict(t *testing.T) {
	t.Parallel()
	base := time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		first    bool
		lastPing time.Time
		lastPong time.Time
		lastRecv time.Time
		want     bool
	}{
		{"first ping is optimistic", true, time.Time{}, time.Time{}, time.Time{}, true},
		{"pong since last ping", false, base, base.Add(time.Second), base.Add(time.Second), true},
		{"silent pipe since last ping", false, base, base.Add(-time.Minute), base.Add(-time.Minute), false},
		{"no pong but state_sync since last ping", false, base, base.Add(-time.Minute), base.Add(10 * time.Second), true},
		{"activity only before last ping", false, base, time.Time{}, base.Add(-time.Second), false},
		{"never any traffic", false, base, time.Time{}, time.Time{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pingVerdict(tc.first, tc.lastPing, tc.lastPong, tc.lastRecv); got != tc.want {
				t.Fatalf("pingVerdict(%v, %v, %v, %v) = %v, want %v",
					tc.first, tc.lastPing, tc.lastPong, tc.lastRecv, got, tc.want)
			}
		})
	}
}
