// Package selfuninstall runs the agent's self_uninstall teardown in a detached
// helper process and reports the command's result only once that teardown has
// finished (#11154).
//
// The agent cannot report its own uninstall: stopping its service kills it, so
// for years the agent reported `completed` the moment it had handed teardown
// to a helper. The server read that as "uninstalled", and a teardown that then
// failed (a blocked helper, an isolation release that could not be confirmed)
// left an agent running on a machine whose record had been purged. Here the
// helper, which outlives the agent, runs every step, verifies the end state and
// only then reports: completed when all of it held, failed (naming the step)
// otherwise.
package selfuninstall

import (
	"context"
	"errors"
	"fmt"
)

// Outcome statuses. They are the server's terminal command statuses.
const (
	StatusCompleted = "completed"
	StatusFailed    = "failed"
)

// ErrNoReporter is returned by Run when the plan had no way to report, which is
// the case when the helper could not load the agent's credentials. The teardown
// still runs; the server then never hears a result for the command.
var ErrNoReporter = errors.New("self-uninstall outcome not reported: no reporter (agent credentials unavailable)")

// Recorder collects what the steps want carried in the reported result.
type Recorder struct {
	details  map[string]any
	warnings []string
}

// Set records a detail, overwriting an earlier value under the same key.
func (r *Recorder) Set(key string, v any) {
	if r.details == nil {
		r.details = map[string]any{}
	}
	r.details[key] = v
}

// Warn records something an operator should know about a step that did not
// fail the teardown (a file left for removal at reboot, say).
func (r *Recorder) Warn(format string, args ...any) {
	r.warnings = append(r.warnings, fmt.Sprintf(format, args...))
}

// Step is one teardown action. The first step to return an error ends the run.
type Step struct {
	Name string
	Run  func(ctx context.Context, rec *Recorder) error
}

// Outcome is what Run reports.
type Outcome struct {
	Status string // StatusCompleted or StatusFailed
	// FailedStep and Err name the step that ended a failed run.
	FailedStep string
	Err        error
	// Steps are the steps that succeeded, in order.
	Steps    []string
	Details  map[string]any
	Warnings []string
}

// Plan is a teardown: its steps in order (the last of them verifying the end
// state), how to report the outcome, and what to do after a failure.
type Plan struct {
	Steps []Step
	// Report delivers the outcome. Run calls it exactly once, after the last
	// step ran or the first one failed, and never before. Nil means the
	// outcome cannot be reported (see ErrNoReporter).
	Report func(ctx context.Context, o Outcome) error
	// OnFailure runs after a failed outcome has been reported, whether or not
	// the report was delivered. It restores the agent. Reporting comes first so
	// the server records the real reason before a restored agent can report
	// the same command as interrupted.
	OnFailure func(ctx context.Context, o Outcome)
}

// Run executes the plan's steps in order, stops at the first failure, reports
// the outcome, and on failure runs the plan's OnFailure. It returns the outcome
// and the report's error (or ErrNoReporter).
func Run(ctx context.Context, p Plan) (Outcome, error) {
	rec := &Recorder{}
	out := Outcome{Status: StatusCompleted}
	for _, s := range p.Steps {
		if err := s.Run(ctx, rec); err != nil {
			out.Status = StatusFailed
			out.FailedStep = s.Name
			out.Err = fmt.Errorf("%s: %w", s.Name, err)
			break
		}
		out.Steps = append(out.Steps, s.Name)
	}
	out.Details = rec.details
	out.Warnings = rec.warnings

	reportErr := ErrNoReporter
	if p.Report != nil {
		reportErr = p.Report(ctx, out)
	}
	if out.Status == StatusFailed && p.OnFailure != nil {
		p.OnFailure(ctx, out)
	}
	return out, reportErr
}
