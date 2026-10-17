package sim

import (
	"context"
	"fmt"
	"os/exec"
	"sync"
	"time"
)

// Executor runs one docker argv. osExecutor in production; tests fake it.
type Executor interface {
	Exec(ctx context.Context, argv []string) (output string, err error)
}

// execTimeout bounds one docker command (docker stop --time 30 needs ~30 s).
const execTimeout = 90 * time.Second

// maxStepOutput is how much of a command's output a step record keeps.
const maxStepOutput = 400

type osExecutor struct{}

// Exec runs argv directly, never through a shell. LoadScenario has already
// refused anything but docker and anything but STORM_* expansion.
func (osExecutor) Exec(ctx context.Context, argv []string) (string, error) {
	if len(argv) == 0 || argv[0] != "docker" {
		return "", fmt.Errorf("refusing to exec %v: only docker is allowed", argv)
	}
	ctx, cancel := context.WithTimeout(ctx, execTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).CombinedOutput() // #nosec G204 -- argv[0] is docker; args validated by LoadScenario
	if len(out) > maxStepOutput {
		out = out[len(out)-maxStepOutput:]
	}
	return string(out), err
}

// StepRecord is one action the scheduler ran. Times are seconds from the
// recorder's run start.
type StepRecord struct {
	Event     string   `json:"event"`
	Phase     string   `json:"phase"` // start | end
	PlannedS  float64  `json:"plannedS"`
	StartedS  float64  `json:"startedS"`
	FinishedS float64  `json:"finishedS"`
	Argv      []string `json:"argv,omitempty"`
	Internal  string   `json:"internal,omitempty"`
	OK        bool     `json:"ok"`
	Output    string   `json:"output"`
}

// ScheduledEvent is when one event actually started (first start action) and
// ended (after its end actions), plus its planned windows.
type ScheduledEvent struct {
	Name      string
	PreWindow time.Duration
	Start     time.Time
	End       time.Time // zero when the run ended before the event started
	Recovery  time.Duration
}

// Scheduler runs a scenario's events at offsets from the steady-window open
// and marks the recorder's phases: pre (PreWindow before the planned start),
// storm (actual start → actual end), recovery (end → end + Recovery).
type Scheduler struct {
	Scenario  Scenario
	Exec      Executor
	Rec       *Recorder
	Internal  map[string]func() int
	PreWindow time.Duration

	mu     sync.Mutex
	steps  []StepRecord
	events []ScheduledEvent
}

func (s *Scheduler) rel(t time.Time) float64 { return t.Sub(s.Rec.Start).Seconds() }

func sleepUntil(ctx context.Context, t time.Time) bool { return sleepCtx(ctx, time.Until(t)) }

// Run blocks until the last recovery ends or ctx ends. A failed action is
// recorded and the schedule continues. When ctx ends during an event, its end
// actions still run (on a context without the cancel) so an interrupted run
// never leaves the lab API killed, paused or throttled.
func (s *Scheduler) Run(ctx context.Context, windowOpen time.Time) {
	defer s.Rec.MarkPhase("", "")
	for _, ev := range s.Scenario.Events {
		planned := windowOpen.Add(ev.At.D)
		if !sleepUntil(ctx, planned.Add(-s.PreWindow)) {
			return
		}
		s.Rec.MarkPhase(ev.Name, "pre")
		if !sleepUntil(ctx, planned) {
			return
		}
		s.Rec.MarkPhase(ev.Name, "storm")
		started := time.Now()
		s.mu.Lock()
		s.events = append(s.events, ScheduledEvent{Name: ev.Name, PreWindow: s.PreWindow, Start: started, Recovery: ev.Recovery.D})
		idx := len(s.events) - 1
		s.mu.Unlock()
		s.runActions(ctx, ev.Name, "start", planned, ev.Start)
		// Hold counts from the planned start, so a slow start action (docker
		// stop --time 30) does not push the end, or the next event, back.
		held := sleepUntil(ctx, planned.Add(ev.Hold.D))
		endCtx := ctx
		if !held {
			endCtx = context.WithoutCancel(ctx)
		}
		s.runActions(endCtx, ev.Name, "end", planned.Add(ev.Hold.D), ev.End)
		ended := time.Now()
		s.mu.Lock()
		s.events[idx].End = ended
		s.mu.Unlock()
		if !held {
			return
		}
		s.Rec.MarkPhase(ev.Name, "recovery")
		if !sleepCtx(ctx, ev.Recovery.D) {
			return
		}
		s.Rec.MarkPhase("", "")
	}
}

func (s *Scheduler) runActions(ctx context.Context, event, phase string, planned time.Time, actions []Action) {
	for _, a := range actions {
		rec := StepRecord{Event: event, Phase: phase, PlannedS: s.rel(planned), StartedS: s.rel(time.Now()),
			Argv: a.Exec, Internal: a.Internal}
		switch {
		case a.Internal != "":
			f := s.Internal[a.Internal]
			if f == nil {
				rec.Output = "internal action " + a.Internal + " is not wired in this run"
				break
			}
			n := f()
			rec.OK = n > 0 // closing nothing did not inject the fault
			rec.Output = fmt.Sprintf("closed %d sockets", n)
		default:
			out, err := s.Exec.Exec(ctx, a.Exec)
			rec.OK = err == nil
			rec.Output = out
			if err != nil && out == "" {
				rec.Output = err.Error()
			}
		}
		rec.FinishedS = s.rel(time.Now())
		s.mu.Lock()
		s.steps = append(s.steps, rec)
		s.mu.Unlock()
	}
}

// Steps returns a copy of every step record so far.
func (s *Scheduler) Steps() []StepRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]StepRecord(nil), s.steps...)
}

// Events returns a copy of every event that started.
func (s *Scheduler) Events() []ScheduledEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]ScheduledEvent(nil), s.events...)
}
