package sim

import (
	"context"
	"testing"
	"time"
)

func TestAgentDrivesEverySteadyStateStream(t *testing.T) {
	f := newFakeAPI(t)
	cfg := testConfig(f, t.TempDir())
	id := f.preEnroll(0)
	ctx, cancel := context.WithTimeout(context.Background(), 2500*ms)
	defer cancel()
	NewAgent(&cfg, newTestRecorder(), id, nil).Run(ctx)

	for _, route := range append([]string{RouteHeartbeat, RouteUnifi, RouteProcessSample, RouteSecurity,
		RouteSessions, RoutePosture, RouteEventLogs}, InventoryBatchRoutes...) {
		if f.count(route) == 0 {
			t.Errorf("%s was never sent", route)
		}
	}
	if got := f.count(RouteCrawlConfig); got != 1 {
		t.Errorf("crawl-config 404 must back off for 6 h: got %d requests, want 1", got)
	}
	if hb := f.count(RouteHeartbeat); hb < 15 || hb > 27 {
		t.Errorf("heartbeats at 100 ms over ~2.4 s: got %d, want 15..27", hb)
	}
	if u := f.count(RouteUnifi); u < 30 || u > 52 {
		t.Errorf("unifi polls at 50 ms over ~2.5 s: got %d, want 30..52", u)
	}
}

func TestAgentReenrollsWhenTheStoredTokenIs401(t *testing.T) {
	f := newFakeAPI(t)
	cfg := testConfig(f, t.TempDir())
	cfg.WSEnabled = false
	stale := Identity{Index: 0, Hostname: "agentsim-test00-00000", AgentID: "gone", AuthToken: "brz_gone"}
	fresh := f.preEnroll(0)
	calls := 0
	reenroll := func(_ context.Context, old Identity) (Identity, error) {
		calls++
		if old.AgentID != "gone" {
			t.Errorf("re-enroll got %+v", old)
		}
		return fresh, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 700*ms)
	defer cancel()
	a := NewAgent(&cfg, newTestRecorder(), stale, reenroll)
	a.Run(ctx)
	if calls != 1 || a.identity().AgentID != fresh.AgentID {
		t.Fatalf("re-enroll calls %d, identity %s, want 1 call and %s", calls, a.identity().AgentID, fresh.AgentID)
	}
	if f.count(RouteHeartbeat) < 3 {
		t.Fatalf("the fresh identity must keep heartbeating, got %d beats", f.count(RouteHeartbeat))
	}
}

// A heartbeat cut off by the run ending is not a lost heartbeat: the error
// budget counts only failures the server or network caused.
func TestCancelledHeartbeatIsNotLost(t *testing.T) {
	f := newFakeAPI(t)
	hold := make(chan struct{})
	f.setHoldHeartbeat(hold)
	t.Cleanup(func() { close(hold) }) // registered after newFakeAPI: runs before srv.Close
	cfg := testConfig(f, t.TempDir())
	cfg.WSEnabled = false
	cfg.Cadence = Cadence{Heartbeat: 50 * ms}
	id := f.preEnroll(0)
	rec := newTestRecorder()
	rec.EnableTimeline(time.Second, time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { NewAgent(&cfg, rec, id, nil).Run(ctx); close(done) }()
	eventually(t, 2*time.Second, func() bool { return f.count(RouteHeartbeat) >= 1 }, "no heartbeat reached the fake")
	cancel()
	<-done
	for i, b := range rec.timeline.Buckets() {
		if b.HeartbeatsLost != 0 || b.RequestsLost != 0 {
			t.Fatalf("bucket %d: a heartbeat cancelled by the run end was counted as lost: %+v", i, b)
		}
	}
}

// A heartbeat that fails after the agent's own retries is lost.
func TestRefusedHeartbeatIsLost(t *testing.T) {
	f := newFakeAPI(t)
	cfg := testConfig(f, t.TempDir())
	cfg.WSEnabled = false
	cfg.Cadence = Cadence{Heartbeat: 50 * ms}
	id := Identity{Index: 0, AgentID: "unknown", AuthToken: "brz_nope"} // 401 on every beat
	rec := newTestRecorder()
	rec.EnableTimeline(time.Second, time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 300*ms)
	defer cancel()
	NewAgent(&cfg, rec, id, nil).Run(ctx)
	var lost uint64
	for _, b := range rec.timeline.Buckets() {
		lost += b.HeartbeatsLost
	}
	if lost == 0 {
		t.Fatal("401 heartbeats must count as lost")
	}
}

func TestHeartbeatCommandIsAnsweredOverHTTPWithoutASocket(t *testing.T) {
	f := newFakeAPI(t)
	cfg := testConfig(f, t.TempDir())
	cfg.WSEnabled = false
	id := f.preEnroll(0)
	f.queueHeartbeatCommand(id.AgentID, "c-http")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go NewAgent(&cfg, newTestRecorder(), id, nil).Run(ctx)
	eventually(t, 1500*ms, func() bool { return f.result("c-http") == "http" }, "heartbeat-delivered command never got an HTTP result")
}
