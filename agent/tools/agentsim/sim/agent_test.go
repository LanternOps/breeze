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
