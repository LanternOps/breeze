package selfuninstall

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// journal records every step, report and failure hook in call order, so a
// test can assert WHEN the result was reported relative to the teardown.
type journal struct{ entries []string }

func (j *journal) step(name string, err error) Step {
	return Step{Name: name, Run: func(context.Context, *Recorder) error {
		j.entries = append(j.entries, name)
		return err
	}}
}

func (j *journal) plan(steps ...Step) (Plan, *[]Outcome) {
	var reported []Outcome
	return Plan{
		Steps: steps,
		Report: func(_ context.Context, o Outcome) error {
			j.entries = append(j.entries, "report:"+o.Status)
			reported = append(reported, o)
			return nil
		},
		OnFailure: func(context.Context, Outcome) {
			j.entries = append(j.entries, "on-failure")
		},
	}, &reported
}

// #11154: the result is reported only once the last teardown step has run,
// never when the teardown is merely handed off.
func TestRunReportsCompletedOnlyAfterTheLastStep(t *testing.T) {
	j := &journal{}
	p, reported := j.plan(j.step("release", nil), j.step("stop", nil), j.step("verify", nil))

	out, err := Run(context.Background(), p)
	if err != nil {
		t.Fatalf("Run returned report error: %v", err)
	}
	want := []string{"release", "stop", "verify", "report:completed"}
	if !reflect.DeepEqual(j.entries, want) {
		t.Fatalf("call order = %v, want %v", j.entries, want)
	}
	if out.Status != StatusCompleted || out.FailedStep != "" || out.Err != nil {
		t.Fatalf("outcome = %+v, want completed with no failure", out)
	}
	if len(*reported) != 1 {
		t.Fatalf("reported %d times, want exactly once", len(*reported))
	}
	if got := (*reported)[0].Steps; !reflect.DeepEqual(got, []string{"release", "stop", "verify"}) {
		t.Fatalf("reported steps = %v", got)
	}
}

// A failing step ends the run: nothing after it runs, the failure is reported
// as failed (never completed) naming the step, and the failure hook runs only
// after that report.
func TestRunReportsFailedAtTheFirstFailingStep(t *testing.T) {
	j := &journal{}
	boom := errors.New("msiexec exited 1603")
	p, reported := j.plan(j.step("release", nil), j.step("msi-uninstall", boom), j.step("verify", nil))

	out, err := Run(context.Background(), p)
	if err != nil {
		t.Fatalf("Run returned report error: %v", err)
	}
	want := []string{"release", "msi-uninstall", "report:failed", "on-failure"}
	if !reflect.DeepEqual(j.entries, want) {
		t.Fatalf("call order = %v, want %v", j.entries, want)
	}
	if out.Status != StatusFailed || out.FailedStep != "msi-uninstall" || !errors.Is(out.Err, boom) {
		t.Fatalf("outcome = %+v, want failed at msi-uninstall wrapping %v", out, boom)
	}
	if len(*reported) != 1 || (*reported)[0].Status != StatusFailed {
		t.Fatalf("reported = %+v, want one failed report", *reported)
	}
	if got := (*reported)[0].Steps; !reflect.DeepEqual(got, []string{"release"}) {
		t.Fatalf("reported completed steps = %v, want only the steps before the failure", got)
	}
}

func TestRunDoesNotCallTheFailureHookOnSuccess(t *testing.T) {
	j := &journal{}
	p, _ := j.plan(j.step("only", nil))
	if _, err := Run(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	for _, e := range j.entries {
		if e == "on-failure" {
			t.Fatalf("failure hook ran on a completed teardown: %v", j.entries)
		}
	}
}

// A report that cannot be delivered is surfaced to the caller (to log), and a
// failed teardown still runs its failure hook: restoring the agent matters
// more than the report that could not be sent.
func TestRunSurfacesAReportErrorAndStillRunsTheFailureHook(t *testing.T) {
	j := &journal{}
	sendErr := errors.New("server unreachable")
	p := Plan{
		Steps:     []Step{j.step("release", errors.New("isolation release could not be confirmed"))},
		Report:    func(context.Context, Outcome) error { j.entries = append(j.entries, "report"); return sendErr },
		OnFailure: func(context.Context, Outcome) { j.entries = append(j.entries, "on-failure") },
	}
	_, err := Run(context.Background(), p)
	if !errors.Is(err, sendErr) {
		t.Fatalf("Run error = %v, want the report error", err)
	}
	if !reflect.DeepEqual(j.entries, []string{"release", "report", "on-failure"}) {
		t.Fatalf("call order = %v", j.entries)
	}
}

func TestRecorderDetailsAndWarningsReachTheReport(t *testing.T) {
	var got Outcome
	p := Plan{
		Steps: []Step{{Name: "msi-uninstall", Run: func(_ context.Context, rec *Recorder) error {
			rec.Set("method", "msi")
			rec.Warn("reboot required to finish removing %s", "files")
			return nil
		}}},
		Report: func(_ context.Context, o Outcome) error { got = o; return nil },
	}
	if _, err := Run(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if got.Details["method"] != "msi" {
		t.Fatalf("details = %v", got.Details)
	}
	if len(got.Warnings) != 1 || !strings.Contains(got.Warnings[0], "reboot required") {
		t.Fatalf("warnings = %v", got.Warnings)
	}
}

// A nil Report (credentials could not be loaded) still runs the teardown.
func TestRunWithoutAReporterStillTearsDown(t *testing.T) {
	j := &journal{}
	out, err := Run(context.Background(), Plan{Steps: []Step{j.step("stop", nil)}})
	if !errors.Is(err, ErrNoReporter) {
		t.Fatalf("err = %v, want ErrNoReporter", err)
	}
	if out.Status != StatusCompleted || !reflect.DeepEqual(j.entries, []string{"stop"}) {
		t.Fatalf("out=%+v entries=%v", out, j.entries)
	}
}
