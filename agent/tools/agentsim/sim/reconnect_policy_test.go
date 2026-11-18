package sim

import (
	"context"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	agentws "github.com/breeze-rmm/agent/internal/websocket"
)

// fakeClock swaps the session's clock and sleep seams. The clock advances
// 31 s per call, so every socket "lived" past the 30 s stable threshold; the
// sleep records each requested wait and blocks (until ctx ends) after the
// first `free` calls. No test here sleeps in real time.
func fakeClock(t *testing.T, free int) chan time.Duration {
	t.Helper()
	oldNow, oldSleep := nowFn, sleepFn
	t.Cleanup(func() { nowFn, sleepFn = oldNow, oldSleep })
	base := time.Unix(1_700_000_000, 0)
	var ticks, calls atomic.Int64
	nowFn = func() time.Time { return base.Add(time.Duration(ticks.Add(1)) * 31 * time.Second) }
	waits := make(chan time.Duration, 32)
	sleepFn = func(ctx context.Context, d time.Duration) bool {
		waits <- d
		if int(calls.Add(1)) <= free {
			return ctx.Err() == nil
		}
		<-ctx.Done()
		return false
	}
	return waits
}

func nextWait(t *testing.T, ch chan time.Duration) time.Duration {
	t.Helper()
	select {
	case d := <-ch:
		return d
	case <-time.After(5 * time.Second):
		t.Fatal("the session never asked to wait")
		return 0
	}
}

func TestSimRunUsesAgentReconnectPolicy(t *testing.T) {
	f := newFakeAPI(t)
	waits := fakeClock(t, 1)
	_, id, _, _ := runAgent(t, f, func(c *Config) { c.wsPaceScale = 0 })

	// The same seeded pacer the session builds.
	p := agentws.NewReconnectPacer(newPacerRand(id.Index).Float64, agentws.DefaultFirstReconnectWindow)
	if got, want := nextWait(t, waits), p.AtStart(agentws.DefaultStartDialWindow); got != want {
		t.Fatalf("start wait %s, want the pacer's %s", got, want)
	}
	eventually(t, 2*time.Second, func() bool { return f.socketFor(id.AgentID) }, "no first connection")
	f.dropSockets()
	// A socket that lived > 30 s and dropped without a close frame: not "at once".
	want := p.AfterDisconnect(0, false, 31*time.Second, -1)
	got := nextWait(t, waits)
	if got != want || got < time.Second {
		t.Fatalf("wait after an established drop %s, want the pacer's %s (>= 1 s)", got, want)
	}
}

func TestHubDrainSetsHintAndClosesAsGoingAway(t *testing.T) {
	f := newFakeAPI(t)
	waits := fakeClock(t, 1)
	hub := newSocketHub()
	cfg := testConfig(f, t.TempDir())
	cfg.wsPaceScale = 0
	id := f.preEnroll(0)
	a := NewAgent(&cfg, newTestRecorder(), id, nil)
	a.hub = hub
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	done := make(chan struct{})
	go func() { a.ws.(*wsSession).Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	p := agentws.NewReconnectPacer(newPacerRand(id.Index).Float64, agentws.DefaultFirstReconnectWindow)
	nextWait(t, waits)
	p.AtStart(agentws.DefaultStartDialWindow)
	eventually(t, 2*time.Second, func() bool { return hub.Len() == 1 }, "no socket")
	if n := hub.Drain(120 * time.Second); n != 1 {
		t.Fatalf("Drain closed %d, want 1", n)
	}
	want := p.AfterDisconnect(1001, false, 62*time.Second, 120*time.Second)
	if got := nextWait(t, waits); got != want {
		t.Fatalf("wait after a drain close %s, want the pacer's drained wait %s", got, want)
	}
}

// sessions builds cfg.Agents real sessions (no sockets) for pacing decisions.
func sessions(cfg *Config) []*wsSession {
	rec := newTestRecorder()
	out := make([]*wsSession, cfg.Agents)
	for i := range out {
		out[i] = NewAgent(cfg, rec, Identity{Index: i}, nil).ws.(*wsSession)
	}
	return out
}

func TestPreW09CohortUsesShippedPacing(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Agents, cfg.PreW09Fraction = 100, 0.5
	if preW09Count(&cfg) != 50 {
		t.Fatalf("cohort %d, want 50", preW09Count(&cfg))
	}
	honoured := 0
	for i, s := range sessions(&cfg) {
		s.setDrain(120 * time.Second) // a pre-W09 agent skips the frame
		w := s.waitAfterDisconnect(1001, false, time.Hour)
		if i < 50 {
			if !s.preW09 || s.startWait() != 0 {
				t.Fatalf("agent %d: want the pre-W09 cohort with no start jitter", i)
			}
			if w < time.Second || w > 5*time.Second {
				t.Fatalf("pre-W09 agent %d waited %s after a stable close, want [1 s, 5 s]", i, w)
			}
			continue
		}
		if s.preW09 {
			t.Fatalf("agent %d should run the W09 policy", i)
		}
		if w > 5*time.Second {
			honoured++
		}
	}
	if honoured < 40 {
		t.Fatalf("only %d of 50 W09 agents honoured the 120 s drain hint", honoured)
	}
}

func TestDrainSocketsActionSpreadsReconnects(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Agents = 1000
	ss := sessions(&cfg)
	waits := make([]time.Duration, len(ss))
	for i, s := range ss {
		s.setDrain(120 * time.Second)
		waits[i] = s.waitAfterDisconnect(1001, false, time.Hour)
	}
	sort.Slice(waits, func(i, j int) bool { return waits[i] < waits[j] })

	// Feed the reconnect times to the timeline the storm report reads. A 5 s
	// bucket: at 1 s, a uniform spread of 1000 agents has Poisson noise that
	// alone puts peak/mean near 1.8.
	const step = 5 * time.Second
	start := time.Unix(1_700_000_000, 0)
	tl := NewTimeline(start, step, 5*time.Minute)
	for range ss {
		tl.SocketUp()
	}
	closeAt := 60 * time.Second
	next := 0
	for at := time.Duration(0); at < 5*time.Minute; at += step {
		ts := start.Add(at)
		if at == closeAt {
			for range ss {
				tl.SocketDown()
			}
		}
		for at >= closeAt && next < len(waits) && closeAt+waits[next] < at+step {
			tl.SocketUp()
			tl.WSConnect(ts)
			next++
		}
		tl.SampleLive(ts)
	}
	rc := reconnectCurve(tl.Buckets(), EventWindow{Name: "drain", PreS: 30, StartS: 60, EndS: 60, RecoveryS: 200})
	if rc.ReconnectSpanS < 108 || rc.ReconnectSpanS > 132 {
		t.Fatalf("reconnectSpanS %v, want within [108, 132] for a 120 s drain", rc.ReconnectSpanS)
	}
	if rc.PeakToMean > 1.5 {
		t.Fatalf("peakToMean %v, want <= 1.5", rc.PeakToMean)
	}
	if rc.Connects != 1000 {
		t.Fatalf("connects %d, want 1000", rc.Connects)
	}
}

func TestDrainHintLapsClampsAndIsConsumedOnce(t *testing.T) {
	fakeClock(t, 0)
	cfg := DefaultConfig()
	cfg.Agents = 1
	s := sessions(&cfg)[0]
	s.setDrain(time.Second) // the fake clock moves 31 s per call; the hint lives 31 s: still live
	if got := s.takeDrain(); got != time.Second {
		t.Fatalf("a fresh hint applies, got %s", got)
	}
	s.setDrain(time.Hour) // clamped to the 600 s maximum
	if got := s.takeDrain(); got != agentws.MaxDrainWithin {
		t.Fatalf("hint %s, want clamp to %s", got, agentws.MaxDrainWithin)
	}
	if got := s.takeDrain(); got != -1 {
		t.Fatalf("a hint is consumed once, got %s", got)
	}
	s.setDrain(time.Second)
	for range 3 {
		nowFn() // 3 x 31 s > 1 s + 30 s
	}
	if got := s.takeDrain(); got != -1 {
		t.Fatalf("a lapsed hint must not apply, got %s", got)
	}
}
