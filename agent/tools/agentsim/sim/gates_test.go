package sim

import (
	"testing"
	"time"
)

func TestGateFiresOnlyAfterStrictlyMoreThanItsPeriod(t *testing.T) {
	t0 := time.Now()
	g := gate{period: 5 * time.Minute, last: t0}
	if g.due(t0.Add(5 * time.Minute)) {
		t.Fatal("exactly one period is not > period (heartbeat.go uses a strict >)")
	}
	if !g.due(t0.Add(5*time.Minute + time.Millisecond)) {
		t.Fatal("past the period must fire")
	}
	if g.due(t0.Add(6 * time.Minute)) {
		t.Fatal("fired twice in one period")
	}
	if (&gate{}).due(t0) {
		t.Fatal("a disabled gate never fires")
	}
}

func TestColdGatesMatchHeartbeatStart(t *testing.T) {
	t0 := time.Now()
	g := newGates(DefaultCadence(), StartCold, t0, func(time.Duration) time.Duration { return 0 })
	if !g.security.due(t0.Add(time.Minute)) || !g.sessions.due(t0.Add(time.Minute)) || !g.eventlogs.due(t0.Add(time.Minute)) {
		t.Fatal("cold security/sessions/event-log gates are zero-stamped and fire on the first tick")
	}
	if g.inventory.due(t0.Add(time.Minute)) || g.posture.due(t0.Add(time.Minute)) {
		t.Fatal("cold inventory/posture are stamped at startup")
	}
}

func TestWarmGatesStartAtARandomPhase(t *testing.T) {
	t0 := time.Now()
	g := newGates(DefaultCadence(), StartWarm, t0, func(p time.Duration) time.Duration { return p - time.Second })
	if !g.inventory.due(t0.Add(2 * time.Second)) {
		t.Fatal("a warm gate whose phase is almost elapsed must fire within seconds")
	}
}
