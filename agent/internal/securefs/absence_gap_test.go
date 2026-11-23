package securefs

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"time"
)

// checkInjectedGapReport is the verdict of a control that opened ONE
// publication gap over [opened, closed], both stamped with the watch's own
// clock: opened before the destination was taken away, closed after the
// publish that ended the gap returned. The watch must have reported that gap
// as its persistent absence, and no excuse may have covered any part of it.
//
// It deliberately does not demand that nothing at all was excused during the
// run. The publishes around the gap are real ones, and the kernel's
// in-flight-rename lookup race (#8491) can excuse a separate absence on them,
// bounded by excuseBudget. #12559 was exactly that: an absence on the publish
// before the gap was excused, the gap was then reported persistent, and the
// old "excused must be empty" assertion failed a control that had held.
func checkInjectedGapReport(report absenceReport, opened, closed time.Time, excuseBudget int) error {
	// An excuse covers its absence from the first miss until the probe that
	// found the destination again; the watch looked for nothing new between.
	for _, e := range report.excused {
		if e.evidence.firstMiss.Before(closed) && e.healed.After(opened) {
			return fmt.Errorf("the watch excused an absence overlapping the injected gap (%v): %v; persistent=%v",
				closed.Sub(opened), e, report.persistent)
		}
	}
	ev := report.persistentEvidence
	if report.persistent == nil || ev == nil {
		return fmt.Errorf("the injected gap (%v) was not reported as a persistent absence; persistent=%v excused=%v",
			closed.Sub(opened), report.persistent, report.excused)
	}
	if !ev.lastMiss.After(opened) || !ev.firstMiss.Before(closed) {
		return fmt.Errorf("the persistent absence was not the injected gap: it was observed from %v to %v, the gap was open from %v to %v; persistent=%v excused=%v",
			ev.firstMiss.Format(time.RFC3339Nano), ev.lastMiss.Format(time.RFC3339Nano),
			opened.Format(time.RFC3339Nano), closed.Format(time.RFC3339Nano), report.persistent, report.excused)
	}
	if len(report.excused) > excuseBudget {
		return fmt.Errorf("%d absences outside the injected gap were excused, over the budget of %d: %v",
			len(report.excused), excuseBudget, report.excused)
	}
	return nil
}

// presenceGate lets a control wait until the watch has seen the destination
// present on a probe issued after a given instant (#12559). A control that
// opens its gap only then knows the watch is not still inside an earlier
// absence, so the excuse for that absence cannot also cover the gap, and it
// knows the gap's first miss was issued after everything before the wait, so a
// publish that returned before the gap opened cannot count as returning inside
// it. Closing the gate when the watch returns releases any waiter.
type presenceGate struct {
	mu          sync.Mutex
	cond        *sync.Cond
	lastPresent time.Time
	done        bool
}

func newPresenceGate() *presenceGate {
	g := &presenceGate{}
	g.cond = sync.NewCond(&g.mu)
	return g
}

// observe records one probe answer and when that probe was issued.
func (g *presenceGate) observe(issued time.Time, err error) {
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	g.mu.Lock()
	if issued.After(g.lastPresent) {
		g.lastPresent = issued
	}
	g.mu.Unlock()
	g.cond.Broadcast()
}

// close releases every waiter: the watch has returned and will probe no more.
func (g *presenceGate) close() {
	g.mu.Lock()
	g.done = true
	g.mu.Unlock()
	g.cond.Broadcast()
}

// waitPresentAfter blocks until a probe issued strictly after t has answered
// present (true), or the watch has ended without one (false).
func (g *presenceGate) waitPresentAfter(t time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for !g.lastPresent.After(t) && !g.done {
		g.cond.Wait()
	}
	return g.lastPresent.After(t)
}

func TestCheckInjectedGapReport(t *testing.T) {
	t0 := time.Unix(1_800_000_000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	opened, closed := at(200), at(700)
	gone := fmt.Errorf("%w (absent)", fs.ErrNotExist)
	absence := func(first, last int) *absenceEvidence {
		return &absenceEvidence{probes: 25, firstMiss: at(first), lastMiss: at(last)}
	}
	excused := func(first, last, healed int) excusedAbsence {
		return excusedAbsence{reason: "rename in flight", evidence: *absence(first, last), healed: at(healed)}
	}
	tests := []struct {
		name    string
		report  absenceReport
		budget  int
		wantErr string // "" means the control held
	}{
		{
			name:   "the gap reported persistent with nothing excused holds",
			report: absenceReport{persistent: gone, persistentEvidence: absence(205, 305)},
			budget: 1,
		},
		{
			// #12559, CI run 45130165098: the publish before the gap hit the
			// kernel's in-flight-rename lookup race, that absence was excused
			// and healed, and the gap was then reported persistent.
			name: "an excused absence before the gap, then the gap reported persistent, holds",
			report: absenceReport{persistent: gone, persistentEvidence: absence(205, 305),
				excused: []excusedAbsence{excused(10, 110, 120)}},
			budget: 1,
		},
		{
			name:    "no persistent absence fails",
			report:  absenceReport{},
			budget:  1,
			wantErr: "was not reported as a persistent absence",
		},
		{
			name:    "an excused gap fails even when the watch later reports something persistent",
			report:  absenceReport{persistent: gone, persistentEvidence: absence(800, 900), excused: []excusedAbsence{excused(205, 305, 710)}},
			budget:  1,
			wantErr: "excused an absence overlapping the injected gap",
		},
		{
			// An absence excused just before the gap whose await for the
			// destination rode through the whole gap: the excuse covered it.
			name:    "an excuse whose wait for presence spans the gap fails",
			report:  absenceReport{persistent: gone, persistentEvidence: absence(800, 900), excused: []excusedAbsence{excused(80, 180, 710)}},
			budget:  1,
			wantErr: "excused an absence overlapping the injected gap",
		},
		{
			name:    "a persistent absence that ended before the gap opened fails",
			report:  absenceReport{persistent: gone, persistentEvidence: absence(10, 110)},
			budget:  1,
			wantErr: "was not the injected gap",
		},
		{
			name:    "a persistent absence that began after the gap closed fails",
			report:  absenceReport{persistent: gone, persistentEvidence: absence(710, 810)},
			budget:  1,
			wantErr: "was not the injected gap",
		},
		{
			name:    "a persistent absence with no evidence fails",
			report:  absenceReport{persistent: gone},
			budget:  1,
			wantErr: "was not reported as a persistent absence",
		},
		{
			name: "excused absences beyond the budget fail",
			report: absenceReport{persistent: gone, persistentEvidence: absence(205, 305),
				excused: []excusedAbsence{excused(10, 110, 115), excused(120, 180, 190)}},
			budget:  1,
			wantErr: "over the budget",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := checkInjectedGapReport(tc.report, opened, closed, tc.budget)
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("control held but the check failed it: %v", err)
			case tc.wantErr != "" && err == nil:
				t.Fatalf("check passed a report it must fail (%s)", tc.wantErr)
			case tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr):
				t.Fatalf("check failed for the wrong reason: %v, want %q", err, tc.wantErr)
			}
		})
	}
}

// #12559 end to end, on the real watch and the real in-flight-rename evidence
// (renamesSpanning), with no real time: a rename on the publish BEFORE the gap
// stays in the kernel across a 100ms absence and is excused; then the control
// takes the destination away for good, which no rename spans. The watch must
// excuse the first absence, report the gap as persistent, and the control's
// check must accept that run. The pre-#12559 assertion ("excused must be
// empty") rejected exactly this report.
func TestInjectedGapAfterAnExcusedRenameRaceIsReportedPersistent(t *testing.T) {
	const recheck = 100 * time.Millisecond
	clock := &fakeAbsenceClock{t: time.Unix(1_800_000_000, 0)}
	miss := fs.ErrNotExist
	rename := renameCall{start: clock.t.Add(-time.Millisecond), class: 65} // in the kernel before the watch starts
	var opened, closed time.Time
	stop := make(chan struct{})
	calls := 0
	probe := func() error {
		calls++
		switch {
		case calls == 1:
			return nil // present before the race
		case calls <= 61:
			return miss // the in-flight rename hides the name: 60 dense misses, ~100ms of recheck and then some
		case calls == 62:
			// The rename returns and the name is back.
			rename.end, rename.done = clock.t, true
			return nil
		case calls <= 64:
			return nil
		default:
			if opened.IsZero() {
				opened = clock.t // the control takes the destination away
			}
			if calls == 10_000 {
				close(stop) // the watch never reached a verdict; fail below rather than hang
			}
			return miss
		}
	}
	excuse := func(firstMiss, lastMiss time.Time) (string, bool) {
		if n := len(renamesSpanning([]renameCall{rename}, firstMiss, lastMiss)); n > 0 {
			return fmt.Sprintf("lookup missed while %d rename syscall(s) entered before the first miss were still executing", n), true
		}
		return "", false
	}
	report := watchForAbsenceExcusing(probe, stop, recheck, clock.clock(), excuse)
	closed = clock.t.Add(time.Millisecond) // the gap is still open when the watch returns

	if len(report.excused) != 1 {
		t.Fatalf("excused = %v, want exactly the rename race before the gap", report.excused)
	}
	if report.persistent == nil {
		t.Fatalf("the gap was not reported persistent (excused %v, transient %d)", report.excused, report.transient)
	}
	if err := checkInjectedGapReport(report, opened, closed, 1); err != nil {
		t.Fatalf("the control held but its check failed it: %v", err)
	}
}

func TestPresenceGate(t *testing.T) {
	t0 := time.Unix(1_800_000_000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }

	t.Run("a present probe issued after t releases the wait", func(t *testing.T) {
		g := newPresenceGate()
		g.observe(at(11), nil)
		if !g.waitPresentAfter(at(10)) {
			t.Fatal("waitPresentAfter = false after a present probe issued later")
		}
	})
	t.Run("misses and present probes issued at or before t do not; ending the watch does", func(t *testing.T) {
		g := newPresenceGate()
		g.observe(at(9), nil)
		g.observe(at(10), nil)
		g.observe(at(20), fs.ErrNotExist)
		g.close()
		if g.waitPresentAfter(at(10)) {
			t.Fatal("waitPresentAfter = true with no present probe issued after t")
		}
	})
	t.Run("errors other than not-exist mean the file is there", func(t *testing.T) {
		g := newPresenceGate()
		g.observe(at(11), fs.ErrPermission)
		if !g.waitPresentAfter(at(10)) {
			t.Fatal("waitPresentAfter = false after a probe that found the name")
		}
	})
	t.Run("a waiter blocks until the watch catches up", func(t *testing.T) {
		g := newPresenceGate()
		got := make(chan bool)
		go func() { got <- g.waitPresentAfter(at(10)) }()
		g.observe(at(5), nil)
		g.observe(at(12), nil)
		if !<-got {
			t.Fatal("waiter released without a present probe after t")
		}
	})
}
