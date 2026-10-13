package sim

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeExec struct {
	mu    sync.Mutex
	calls [][]string
	fail  string // argv[1] that returns an error
}

func (f *fakeExec) Exec(_ context.Context, argv []string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, argv)
	if len(argv) > 1 && argv[1] == f.fail {
		return "boom", errors.New("exit status 1")
	}
	return "", nil
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
	if steps[0].StartedS < 0.1 || steps[0].StartedS > 0.2 {
		t.Fatalf("start ran at %.3fs from open, want ~0.1s", steps[0].StartedS)
	}
	if steps[2].OK || steps[2].Output != "boom" {
		t.Fatalf("a failed end action must be recorded, not hidden: %+v", steps[2])
	}
	if dropped != 1 || len(ex.calls) != 2 {
		t.Fatalf("dropped %d, exec calls %v", dropped, ex.calls)
	}
	ev := s.Events()
	if len(ev) != 1 || ev[0].End.Sub(ev[0].Start) < 50*ms {
		t.Fatalf("event window %+v", ev)
	}
	rec.ObserveHTTP(RouteHeartbeat, true, time.Now(), 5*ms, 200, nil) // after recovery: in no phase
	if n := rec.PhaseLatency("kill", "recovery").Count; n != 0 {
		t.Fatalf("an observation after the recovery window landed in it: %d", n)
	}
}

func TestSchedulerPhasesTakeTheirObservations(t *testing.T) {
	rec := newTestRecorder()
	sc := Scenario{Name: "t", Events: []Event{{Name: "e", At: Duration{400 * ms}, Hold: Duration{200 * ms}, Recovery: Duration{200 * ms},
		Start: []Action{{Exec: []string{"docker", "pause", "c"}}}, End: []Action{{Exec: []string{"docker", "unpause", "c"}}}}}}
	s := &Scheduler{Scenario: sc, Exec: &fakeExec{}, Rec: rec, PreWindow: 200 * ms}
	done := make(chan struct{})
	open := time.Now()
	go func() { s.Run(context.Background(), open); close(done) }()

	time.Sleep(time.Until(open.Add(300 * ms))) // inside pre [200, 400)
	rec.ObserveHTTP(RouteHeartbeat, true, time.Now(), 5*ms, 200, nil)
	time.Sleep(time.Until(open.Add(500 * ms))) // inside storm [400, 600)
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
	if ev := s.Events(); len(ev) != 1 || ev[0].End.IsZero() {
		t.Fatalf("event not closed: %+v", ev)
	}
}
