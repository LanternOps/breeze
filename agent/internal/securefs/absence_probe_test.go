package securefs

import (
	"errors"
	"io/fs"
	"testing"
	"time"
)

// scriptedProbe answers watchForAbsence from a fixed script, one entry per
// call, and closes stop once the script is exhausted so the watcher returns.
// After that it keeps answering with the last entry.
func scriptedProbe(script []error, stop chan struct{}) func() error {
	calls := 0
	return func() error {
		i := calls
		calls++
		if i >= len(script) {
			i = len(script) - 1
		}
		if calls == len(script) {
			close(stop)
		}
		return script[i]
	}
}

func TestWatchForAbsence(t *testing.T) {
	miss := fs.ErrNotExist
	denied := fs.ErrPermission
	tests := []struct {
		name           string
		script         []error
		recheck        time.Duration
		wantTransient  int
		wantPersistent bool
	}{
		{name: "always present", script: []error{nil, nil, nil}, recheck: time.Second},
		{name: "a miss that heals on the recheck is transient", script: []error{nil, miss, nil, nil}, recheck: time.Second, wantTransient: 1},
		{name: "every healed miss is counted", script: []error{miss, nil, miss, nil, miss, nil}, recheck: time.Second, wantTransient: 3},
		{name: "a miss that never heals is persistent", script: []error{nil, miss}, recheck: 5 * time.Millisecond, wantPersistent: true},
		{name: "zero recheck window is strict", script: []error{nil, miss, nil}, recheck: 0, wantPersistent: true},
		{name: "errors other than not-exist are not absences", script: []error{denied, denied, nil}, recheck: 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stop := make(chan struct{})
			report := watchForAbsence(scriptedProbe(tc.script, stop), stop, tc.recheck)
			if report.transient != tc.wantTransient {
				t.Fatalf("transient = %d, want %d", report.transient, tc.wantTransient)
			}
			if gotPersistent := report.persistent != nil; gotPersistent != tc.wantPersistent {
				t.Fatalf("persistent = %v, want %v", report.persistent, tc.wantPersistent)
			}
			if tc.wantPersistent && !errors.Is(report.persistent, fs.ErrNotExist) {
				t.Fatalf("persistent error must be the not-exist answer, got %v", report.persistent)
			}
		})
	}
}

// fakeAbsenceClock is a manual clock: sleep advances it, and a timed probe can
// advance it further to simulate the watcher goroutine being descheduled
// between two probes on a loaded runner (#6176).
type fakeAbsenceClock struct{ t time.Time }

func (c *fakeAbsenceClock) clock() absenceClock {
	return absenceClock{
		now:   func() time.Time { return c.t },
		sleep: func(d time.Duration) { c.t = c.t.Add(d) },
	}
}

// timedStep is one probe answer, given after the clock has been advanced by
// stall (time the watcher spent descheduled before the probe ran).
type timedStep struct {
	stall time.Duration
	err   error
}

func timedProbe(clock *fakeAbsenceClock, script []timedStep, stop chan struct{}) func() error {
	calls := 0
	return func() error {
		i := calls
		calls++
		if i >= len(script) {
			i = len(script) - 1
		}
		if calls == len(script) {
			close(stop)
		}
		clock.t = clock.t.Add(script[i].stall)
		return script[i].err
	}
}

// repeatStep returns n copies of step.
func repeatStep(step timedStep, n int) []timedStep {
	out := make([]timedStep, n)
	for i := range out {
		out[i] = step
	}
	return out
}

// The watcher's verdict must rest on what it actually observed. #6176: on a
// loaded runner a single descheduled re-probe that happened to land on another
// replace was reported as "stayed absent for 100ms" although the watcher had
// sampled the destination only twice. Continuity of an absence is only known
// across probes that are close together.
func TestWatchForAbsenceNeedsContinuousEvidence(t *testing.T) {
	miss := fs.ErrNotExist
	const recheck = 100 * time.Millisecond
	tests := []struct {
		name           string
		script         []timedStep
		wantTransient  int
		wantPersistent bool
	}{
		{
			name: "two misses separated by a stall longer than the window are not a continuous absence",
			script: []timedStep{
				{err: miss},
				{stall: 150 * time.Millisecond, err: miss},
				{err: nil},
				{err: nil},
			},
			wantTransient: 1,
		},
		{
			name:           "a densely observed absence past the window is persistent",
			script:         append([]timedStep{{err: miss}}, repeatStep(timedStep{stall: time.Millisecond, err: miss}, 200)...),
			wantPersistent: true,
		},
		{
			name: "dense absence after a stall is measured from the stall, not before it",
			script: append(append([]timedStep{{err: miss}, {stall: 150 * time.Millisecond, err: miss}},
				repeatStep(timedStep{stall: time.Millisecond, err: miss}, 10)...), timedStep{err: nil}, timedStep{err: nil}),
			wantTransient: 1,
		},
		{
			// Deliberate trade-off, pinned so it cannot drift silently: misses
			// that were only ever sampled sparsely prove nothing about the time
			// between them, so a sparse run under the ceiling that heals is
			// transient. It is still charged against transientMissBudget,
			// which is what catches a systemic per-publish gap.
			name: "sparse misses spanning most of the ceiling that then heal are transient",
			script: append(append([]timedStep{{err: miss}},
				repeatStep(timedStep{stall: 300 * time.Millisecond, err: miss}, 5)...), timedStep{err: nil}, timedStep{err: nil}),
			wantTransient: 1,
		},
		{
			name:           "an absence that outlasts the ceiling is persistent even when every probe was stalled",
			script:         append([]timedStep{{err: miss}}, repeatStep(timedStep{stall: 500 * time.Millisecond, err: miss}, 20)...),
			wantPersistent: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := &fakeAbsenceClock{t: time.Unix(1_800_000_000, 0)}
			stop := make(chan struct{})
			report := watchForAbsenceWith(timedProbe(clock, tc.script, stop), stop, recheck, clock.clock())
			if report.transient != tc.wantTransient {
				t.Fatalf("transient = %d, want %d", report.transient, tc.wantTransient)
			}
			if gotPersistent := report.persistent != nil; gotPersistent != tc.wantPersistent {
				t.Fatalf("persistent = %v, want %v", report.persistent, tc.wantPersistent)
			}
			if tc.wantPersistent && !errors.Is(report.persistent, fs.ErrNotExist) {
				t.Fatalf("persistent error must be the not-exist answer, got %v", report.persistent)
			}
		})
	}
}
