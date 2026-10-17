package sim

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeExec struct {
	mu      sync.Mutex
	calls   [][]string
	ctxErrs []error       // ctx.Err() at each call: a real exec on a cancelled ctx fails at once
	fail    string        // argv[1] that returns an error
	delay   time.Duration // how long each call takes
}

func (f *fakeExec) Exec(ctx context.Context, argv []string) (string, error) {
	time.Sleep(f.delay)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, argv)
	f.ctxErrs = append(f.ctxErrs, ctx.Err())
	if len(argv) > 1 && argv[1] == f.fail {
		return "boom", errors.New("exit status 1")
	}
	return "", nil
}

func TestOSExecutorRefusesAnythingButDocker(t *testing.T) {
	if _, err := (osExecutor{}).Exec(context.Background(), []string{"sh", "-c", "true"}); err == nil {
		t.Fatal("osExecutor must refuse a non-docker argv even if validation was bypassed")
	}
}

// An internal drop that closed nothing did not inject the fault.
func TestSchedulerDropOfNoSocketsIsNotOK(t *testing.T) {
	sc := Scenario{Name: "t", Events: []Event{{Name: "d", At: Duration{20 * ms}, Start: []Action{{Internal: ActionDropSockets}}}}}
	s := &Scheduler{Scenario: sc, Exec: &fakeExec{}, Rec: newTestRecorder(), PreWindow: 10 * ms,
		Internal: map[string]func() int{ActionDropSockets: func() int { return 0 }}}
	s.Run(context.Background(), time.Now())
	if st := s.Steps(); len(st) != 1 || st[0].OK {
		t.Fatalf("closing 0 sockets must be a failed step: %+v", st)
	}
}

// Hold runs from the planned start, not from when a slow start action
// finished, so a 30 s docker stop does not push the schedule back.
func TestSchedulerHoldDoesNotDrift(t *testing.T) {
	ex := &fakeExec{delay: 300 * ms}
	sc := Scenario{Name: "t", Events: []Event{{Name: "e", At: Duration{50 * ms}, Hold: Duration{400 * ms}, Recovery: Duration{10 * ms},
		Start: []Action{{Exec: []string{"docker", "stop", "c"}}}, End: []Action{{Exec: []string{"docker", "start", "c"}}}}}}
	s := &Scheduler{Scenario: sc, Exec: ex, Rec: newTestRecorder(), PreWindow: 10 * ms}
	s.Run(context.Background(), time.Now())
	st := s.Steps()
	if len(st) != 2 {
		t.Fatalf("steps %+v", st)
	}
	if lag := st[1].StartedS - st[1].PlannedS; lag > 0.2 {
		t.Fatalf("end action ran %.3fs after its planned time; hold drifted by the start action's duration", lag)
	}
}

func TestSchedulerRunsEventsAtOffsetsAndMarksPhases(t *testing.T) {
	rec := newTestRecorder()
	ex := &fakeExec{fail: "start"}
	dropped := 0
	sc := Scenario{Name: "t", Events: []Event{{Name: "kill", At: Duration{100 * ms}, Hold: Duration{50 * ms}, Recovery: Duration{100 * ms},
		Start: []Action{{Exec: []string{"docker", "kill", "c"}}, {Internal: ActionDropSockets}},
		End:   []Action{{Exec: []string{"docker", "start", "c"}}}}}}
	s := &Scheduler{Scenario: sc, Exec: ex, Rec: rec, Internal: map[string]func() int{ActionDropSockets: func() int { dropped++; return 3 }},
		PreWindow: 50 * ms}
	open := time.Now()
	s.Run(context.Background(), open)

	steps := s.Steps()
	if len(steps) != 3 || steps[0].Phase != "start" || steps[2].Phase != "end" {
		t.Fatalf("steps %+v", steps)
	}
	if steps[0].StartedS < 0.1 || steps[0].StartedS > 0.5 { // loose upper bound: -race on a loaded host
		t.Fatalf("start ran at %.3fs from open, want ~0.1s", steps[0].StartedS)
	}
	if steps[2].OK || steps[2].Output != "boom" {
		t.Fatalf("a failed end action must be recorded, not hidden: %+v", steps[2])
	}
	if dropped != 1 || len(ex.calls) != 2 {
		t.Fatalf("dropped %d, exec calls %v", dropped, ex.calls)
	}
	ev := s.Events()
	if len(ev) != 1 || ev[0].End.Sub(ev[0].Start) < 40*ms { // hold runs from the planned start; Start is the actual one
		t.Fatalf("event window %+v", ev)
	}
	rec.ObserveHTTP(RouteHeartbeat, true, time.Now(), 5*ms, 200, nil) // after recovery: in no phase
	if n := rec.PhaseLatency("kill", "recovery").Count; n != 0 {
		t.Fatalf("an observation after the recovery window landed in it: %d", n)
	}
}

func TestSchedulerPhasesTakeTheirObservations(t *testing.T) {
	rec := newTestRecorder()
	sc := Scenario{Name: "t", Events: []Event{{Name: "e", At: Duration{time.Second}, Hold: Duration{600 * ms}, Recovery: Duration{200 * ms},
		Start: []Action{{Exec: []string{"docker", "pause", "c"}}}, End: []Action{{Exec: []string{"docker", "unpause", "c"}}}}}}
	s := &Scheduler{Scenario: sc, Exec: &fakeExec{}, Rec: rec, PreWindow: 600 * ms}
	done := make(chan struct{})
	open := time.Now()
	go func() { s.Run(context.Background(), open); close(done) }()

	time.Sleep(time.Until(open.Add(700 * ms))) // inside pre [400, 1000)
	rec.ObserveHTTP(RouteHeartbeat, true, time.Now(), 5*ms, 200, nil)
	time.Sleep(time.Until(open.Add(1300 * ms))) // inside storm [1000, 1600)
	rec.ObserveHTTP(RouteHeartbeat, true, time.Now(), 7*ms, 200, nil)
	rec.ObserveHTTP(RouteHeartbeat, true, time.Now(), 0, 0, errors.New("reset"))
	<-done

	if n := rec.PhaseLatency("e", "pre").Count; n != 1 {
		t.Fatalf("pre count %d, want 1", n)
	}
	if n := rec.PhaseLatency("e", "storm").Count; n != 1 {
		t.Fatalf("storm count %d, want 1", n)
	}
	if n := rec.PhaseTransportErrors("e", "storm"); n != 1 {
		t.Fatalf("storm transport errors %d, want 1", n)
	}
}

// A run that ends during an event's hold still runs the end actions, so a
// Ctrl-C never leaves the lab API killed or paused.
func TestSchedulerRestoresOnCancelDuringHold(t *testing.T) {
	rec := newTestRecorder()
	ex := &fakeExec{}
	sc := Scenario{Name: "t", Events: []Event{{Name: "e", At: Duration{50 * ms}, Hold: Duration{time.Hour},
		Start: []Action{{Exec: []string{"docker", "pause", "c"}}}, End: []Action{{Exec: []string{"docker", "unpause", "c"}}}}}}
	s := &Scheduler{Scenario: sc, Exec: ex, Rec: rec, PreWindow: 10 * ms}
	ctx, cancel := context.WithTimeout(context.Background(), 200*ms)
	defer cancel()
	s.Run(ctx, time.Now())
	if len(ex.calls) != 2 || ex.calls[1][1] != "unpause" {
		t.Fatalf("end action not run on cancel: %v", ex.calls)
	}
	if ex.ctxErrs[1] != nil {
		t.Fatalf("the restoring end action got a cancelled context (%v): docker would fail at once", ex.ctxErrs[1])
	}
	if ev := s.Events(); len(ev) != 1 || ev[0].End.IsZero() {
		t.Fatalf("event not closed: %+v", ev)
	}
}
