package selfuninstall

import (
	"context"
	"strings"
	"testing"
)

// settlingOps reports the agent image running for the first N checks, then
// gone: a process that outlived its service's STOPPED state briefly.
type settlingOps struct {
	fakeOps
	runningChecks int
}

func (s *settlingOps) ProcessesRunning(names []string) ([]string, error) {
	s.add("running?")
	if s.runningChecks > 0 {
		s.runningChecks--
		return []string{"breeze-agent.exe"}, nil
	}
	return nil, nil
}

// A process image that lingers past its service stop is killed and re-checked
// before verify-processes fails: that failure cannot be rolled back.
func TestWindowsPlanVerifyProcessesKillsAndRechecks(t *testing.T) {
	ops := &settlingOps{runningChecks: 1}
	p := BuildWindowsPlan(testOptions(), ops)
	var got Outcome
	p.Report = func(_ context.Context, o Outcome) error { got = o; return nil }
	if _, err := Run(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusCompleted {
		t.Fatalf("status = %s (%v), want completed once the lingering process is gone", got.Status, got.Err)
	}
	assertInOrder(t, ops.log, "running?", "kill breeze-agent.exe", "sleep 2s", "running?")
}

// A step that panics is a failed step: reported, and the failure hook runs.
func TestRunTurnsAPanickingStepIntoAFailure(t *testing.T) {
	var reported Outcome
	restored := false
	p := Plan{
		Steps: []Step{{Name: "boom", Run: func(context.Context, *Recorder) error {
			panic("step blew up")
		}}},
		Report:    func(_ context.Context, o Outcome) error { reported = o; return nil },
		OnFailure: func(context.Context, Outcome) { restored = true },
	}
	if _, err := Run(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if reported.Status != StatusFailed || reported.FailedStep != "boom" || !strings.Contains(reported.Err.Error(), "panic") {
		t.Fatalf("reported = %+v, want failed at boom naming the panic", reported)
	}
	if !restored {
		t.Fatal("failure hook did not run after a panic")
	}
}

// A step that ends on the run's deadline is still reported and restored: the
// report and the failure hook do not inherit the expired context.
func TestRunReportsAndRestoresAfterTheDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var reportCtxErr, restoreCtxErr error
	p := Plan{
		Steps: []Step{{Name: "wedged", Run: func(ctx context.Context, _ *Recorder) error {
			cancel()
			return ctx.Err()
		}}},
		Report:    func(ctx context.Context, _ Outcome) error { reportCtxErr = ctx.Err(); return nil },
		OnFailure: func(ctx context.Context, _ Outcome) { restoreCtxErr = ctx.Err() },
	}
	out, _ := Run(ctx, p)
	if out.Status != StatusFailed || reportCtxErr != nil || restoreCtxErr != nil {
		t.Fatalf("status=%s reportCtx=%v restoreCtx=%v, want a failed run reported and restored on a live context", out.Status, reportCtxErr, restoreCtxErr)
	}
}
