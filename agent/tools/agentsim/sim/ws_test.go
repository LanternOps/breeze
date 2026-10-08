package sim

import (
	"context"
	"testing"
	"time"
)

func runAgent(t *testing.T, f *fakeAPI, mutate func(*Config)) (*Agent, Identity, *Recorder, context.CancelFunc) {
	t.Helper()
	cfg := testConfig(f, t.TempDir())
	if mutate != nil {
		mutate(&cfg)
	}
	id := f.preEnroll(0)
	rec := newTestRecorder()
	a := NewAgent(&cfg, rec, id, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return a, id, rec, cancel
}

func TestWSCommandIsAnsweredOverTheSocket(t *testing.T) {
	f := newFakeAPI(t)
	_, id, _, _ := runAgent(t, f, nil)
	eventually(t, 2*time.Second, func() bool { return f.socketFor(id.AgentID) }, "agent never opened its socket")
	if err := f.pushWS(id.AgentID, "c-ws"); err != nil {
		t.Fatal(err)
	}
	eventually(t, 2*time.Second, func() bool { return f.result("c-ws") == "ws" }, "WS command never got a command_result frame")
}

func TestAppPingIsAnsweredWithPong(t *testing.T) {
	f := newFakeAPI(t)
	f.setPingEvery(50 * ms)
	runAgent(t, f, nil)
	eventually(t, 2*time.Second, func() bool { return f.pongs() >= 3 }, "server app pings were not answered with pong frames (the API closes with 4008)")
}

func TestEstablishedDropReconnectsImmediately(t *testing.T) {
	f := newFakeAPI(t)
	_, id, rec, _ := runAgent(t, f, nil)
	eventually(t, 2*time.Second, func() bool { return f.socketFor(id.AgentID) }, "no first connection")
	f.dropSockets()
	// No backoff after an established drop: well under the 700 ms floor a
	// failed connect would cost (1 s − 30 %).
	eventually(t, 500*ms, func() bool { return f.socketFor(id.AgentID) && rec.wsReconnects.Load() >= 1 },
		"an established socket that dropped was not redialled at once")
}

func TestFailedUpgradeBacksOff(t *testing.T) {
	f := newFakeAPI(t)
	f.setRejectWS(true)
	_, _, rec, _ := runAgent(t, f, nil)
	time.Sleep(1600 * ms)
	// Attempt 1 at ~first beat, attempt 2 after 1 s ± 30 %, attempt 3 only
	// after a further 2 s ± 30 %: at most 2 attempts in 1.6 s.
	if got := f.count(RouteWSUpgrade); got < 1 || got > 2 {
		t.Fatalf("upgrade attempts in 1.6 s = %d, want 1..2 (a hot reconnect loop would be dozens)", got)
	}
	if rec.wsConnectFailures.Load() == 0 {
		t.Fatal("refused upgrades must count as connect failures")
	}
}
