package sim

import (
	"testing"
	"time"
)

func TestTimelineBucketsBySecondFromRunStart(t *testing.T) {
	start := time.Unix(1_700_000_000, 0)
	tl := NewTimeline(start, time.Second, 10*time.Second)
	tl.WSConnect(start.Add(1500 * ms))
	tl.WSConnect(start.Add(1900 * ms))
	tl.WSConnectFailed(start.Add(2100 * ms))
	tl.SocketUp()
	tl.SocketUp()
	tl.SocketDown()
	tl.SampleLive(start.Add(3 * time.Second))
	tl.HeartbeatAttempt(start.Add(4*time.Second), 1200*ms, 200, nil) // slow
	tl.HeartbeatAttempt(start.Add(4*time.Second), 20*ms, 503, nil)
	tl.Outcome(RouteHeartbeat, start.Add(5*time.Second), false)
	tl.HeartbeatGap(start.Add(6*time.Second), 70*time.Second)
	tl.WSConnect(start.Add(42 * time.Second)) // past the end: dropped, never panics

	b := tl.Buckets()
	if len(b) != 10 {
		t.Fatalf("buckets %d, want 10", len(b))
	}
	if b[1].WSConnects != 2 || b[2].WSConnectFailures != 1 {
		t.Fatalf("connects by second wrong: %+v %+v", b[1], b[2])
	}
	if b[3].WSLive != 1 {
		t.Fatalf("live gauge %d, want 1", b[3].WSLive)
	}
	if b[4].Heartbeats != 0 || b[4].HeartbeatSlow != 1 || b[4].Attempts503 != 1 {
		t.Fatalf("attempt counts wrong: %+v", b[4])
	}
	if b[5].Heartbeats != 1 || b[5].HeartbeatsLost != 1 || b[5].RequestsLost != 1 {
		t.Fatalf("outcome counts wrong: %+v", b[5])
	}
	if b[6].MaxHeartbeatGapS != 70 {
		t.Fatalf("gap %v, want 70", b[6].MaxHeartbeatGapS)
	}
}

// A sampler tick that lands late must not leave a skipped bucket at 0 live
// sockets: that would read as a phantom trough in the reconnect curve.
func TestSampleLiveFillsSkippedBuckets(t *testing.T) {
	start := time.Unix(1_700_000_000, 0)
	tl := NewTimeline(start, time.Second, 10*time.Second)
	tl.SocketUp()
	tl.SampleLive(start.Add(1 * time.Second))
	tl.SampleLive(start.Add(4 * time.Second)) // the ticks for 2 and 3 were missed
	b := tl.Buckets()
	for i := 1; i <= 4; i++ {
		if b[i].WSLive != 1 {
			t.Fatalf("bucket %d live %d, want 1 (filled)", i, b[i].WSLive)
		}
	}
}
