package securefs

import (
	"errors"
	"fmt"
	"io/fs"
	"time"
)

// absenceReport is what watchForAbsence saw while writers kept replacing a
// destination.
type absenceReport struct {
	// transient counts "does not exist" answers that a re-probe inside the
	// recheck window contradicted.
	transient int
	// persistent is the first "does not exist" answer that did NOT heal within
	// the recheck window: the destination was really gone. The watch stops at
	// it. It wraps the original not-exist error and says what the watcher
	// actually observed (probe count, continuous span, largest probe gap).
	persistent error
}

const (
	// absenceMaxProbeGap is the largest interval between two consecutive
	// probes across which a not-exist answer still counts as ONE continuous
	// absence. The re-probe loop sleeps at most 5ms, so a wider gap means the
	// watcher goroutine itself was descheduled and did not see what happened
	// in between (#6176).
	absenceMaxProbeGap = 25 * time.Millisecond
	// absenceCeiling bounds one recheck in wall-clock time. An absence that
	// every probe for this long agrees on is persistent even if the watcher
	// was starved throughout, so a destination that is really gone still fails
	// the watch — within the ceiling rather than within the recheck window.
	absenceCeiling = 2 * time.Second
)

// absenceClock is the time source for the watch, injectable so the starvation
// cases can be tested deterministically.
type absenceClock struct {
	now   func() time.Time
	sleep func(time.Duration)
}

// watchForAbsence calls probe in a tight loop until stop is closed and
// classifies every not-exist answer as transient (healed within recheck) or
// persistent (did not). Errors other than not-exist are not absences — a
// by-name probe racing a replace can legitimately see a sharing or
// delete-pending answer, and the file is there.
//
// A recheck of 0 makes the watch strict: the first miss is persistent. That is
// the right setting wherever the platform's rename is linearizable against
// by-name lookups (rename(2) on unix).
func watchForAbsence(probe func() error, stop <-chan struct{}, recheck time.Duration) absenceReport {
	return watchForAbsenceWith(probe, stop, recheck, absenceClock{now: time.Now, sleep: time.Sleep})
}

func watchForAbsenceWith(probe func() error, stop <-chan struct{}, recheck time.Duration, clock absenceClock) absenceReport {
	var report absenceReport
	for {
		select {
		case <-stop:
			return report
		default:
		}
		err := probe()
		if !errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if recheck <= 0 {
			report.persistent = err
			return report
		}
		evidence, present := recheckAbsence(probe, recheck, clock)
		if present {
			report.transient++
			continue
		}
		report.persistent = fmt.Errorf("%w (%s)", err, evidence)
		return report
	}
}

// absenceEvidence is what one recheck observed before giving up.
type absenceEvidence struct {
	probes     int
	continuous time.Duration // longest span of densely sampled absence
	elapsed    time.Duration // wall-clock time since the first miss
	maxGap     time.Duration // largest interval between consecutive probes
}

func (e absenceEvidence) String() string {
	return fmt.Sprintf("absent on all %d probes over %v; continuously observed for %v; largest probe gap %v",
		e.probes, e.elapsed, e.continuous, e.maxGap)
}

// recheckAbsence re-probes after a miss with bounded exponential backoff. It
// reports present as soon as any answer says the destination exists.
// Otherwise it reports the absence as persistent once the destination has been
// seen absent CONTINUOUSLY for window, or once absenceCeiling has elapsed.
//
// Continuity is only claimed across probes no more than absenceMaxProbeGap
// apart. When the watcher is descheduled for longer than that, the two misses
// either side of the stall say nothing about the time between them — under
// eight concurrent writers each can be an independent hit on the brief
// by-name lookup race — so the continuous span restarts at the probe after the
// stall. Before #6176 two such samples straddling the deadline were reported
// as "stayed absent for 100ms".
func recheckAbsence(probe func() error, window time.Duration, clock absenceClock) (absenceEvidence, bool) {
	first := clock.now()
	evidence := absenceEvidence{probes: 1}
	spanStart, last := first, first
	for delay := 50 * time.Microsecond; ; delay *= 2 {
		clock.sleep(min(delay, 5*time.Millisecond))
		err := probe()
		now := clock.now()
		evidence.probes++
		evidence.elapsed = now.Sub(first)
		gap := now.Sub(last)
		last = now
		evidence.maxGap = max(evidence.maxGap, gap)
		if !errors.Is(err, fs.ErrNotExist) {
			return evidence, true
		}
		if gap > absenceMaxProbeGap {
			spanStart = now
		}
		evidence.continuous = max(evidence.continuous, now.Sub(spanStart))
		if evidence.continuous >= window || evidence.elapsed >= absenceCeiling {
			return evidence, false
		}
	}
}
