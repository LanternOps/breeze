package securefs

import (
	"errors"
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
	// the recheck window: the destination was really gone. The watch stops at it.
	persistent error
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
		if recheck > 0 && presentWithin(probe, recheck) {
			report.transient++
			continue
		}
		report.persistent = err
		return report
	}
}

// presentWithin re-probes with bounded exponential backoff and reports whether
// any answer within window said the destination exists.
func presentWithin(probe func() error, window time.Duration) bool {
	deadline := time.Now().Add(window)
	for delay := 50 * time.Microsecond; ; delay *= 2 {
		if !errors.Is(probe(), fs.ErrNotExist) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(min(delay, 5*time.Millisecond))
	}
}
