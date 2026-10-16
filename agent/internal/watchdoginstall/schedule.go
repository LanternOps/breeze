package watchdoginstall

import "time"

// Plan is the bounded retry schedule for installing a missing watchdog. All
// methods are pure: the clock and randomness are injected.
type Plan struct {
	Initial       time.Duration // delay after the first failure
	Multiplier    float64       // growth per failure
	Cap           time.Duration // max delay in the active phase
	Jitter        float64       // ± fraction applied to every delay
	MaxAttempts   int           // active-phase attempts before going terminal
	SlowProbe     time.Duration // terminal re-probe for transient classes
	SecurityProbe time.Duration // terminal re-probe for permanent classes
}

// DefaultPlan: 5m ×3 → cap 6h, ±20% jitter, 8 attempts, then a 24h probe
// (transient) or 7d probe (permanent / security classes).
var DefaultPlan = Plan{
	Initial:       5 * time.Minute,
	Multiplier:    3,
	Cap:           6 * time.Hour,
	Jitter:        0.2,
	MaxAttempts:   8,
	SlowProbe:     24 * time.Hour,
	SecurityProbe: 7 * 24 * time.Hour,
}

// Due reports whether an attempt may start now for the running agent version.
// A record from an older agent version re-arms the budget (a new build may
// carry new trust keys or a fixed artifact) — at most once per version, since
// Reserve then binds the budget to this version. A record with no version
// (fresh, or the fail-closed corrupt record) is governed by NextAttemptAt only.
func (p Plan) Due(rec Record, version string, now time.Time) bool {
	if rec.BudgetVersion != "" && rec.BudgetVersion != version {
		return true
	}
	return !now.Before(rec.NextAttemptAt)
}

// Reserve records the start of an attempt. It is persisted BEFORE any side
// effect so a crash or kill mid-attempt still spends the attempt: the
// reservation's NextAttemptAt is the delay a transient failure would get (or
// the probe interval when terminal), never "retry immediately".
func (p Plan) Reserve(rec Record, version string, now time.Time) Record {
	if rec.BudgetVersion != "" && rec.BudgetVersion != version {
		rec = Record{}
	}
	rec.SchemaVersion = SchemaVersion
	rec.BudgetVersion = version
	if rec.Attempts < MaxRecordedAttempts {
		rec.Attempts++
	}
	if rec.FirstAttemptAt.IsZero() {
		rec.FirstAttemptAt = now
	}
	rec.LastAttemptAt = now
	switch {
	case rec.Terminal && rec.LastClass.Permanent():
		rec.NextAttemptAt = now.Add(p.SecurityProbe)
	case rec.Terminal:
		rec.NextAttemptAt = now.Add(p.SlowProbe)
	default:
		rec.NextAttemptAt = now.Add(p.delay(rec.Attempts))
	}
	return rec
}

// Failed records the outcome of the attempt Reserve started. It does not
// increment Attempts again. A permanent class goes terminal immediately; a
// transient class goes terminal once the active-phase budget is spent.
func (p Plan) Failed(rec Record, now time.Time, class ErrorClass, rnd func() float64) Record {
	if !class.Valid() {
		class = ClassUnknown
	}
	rec.LastClass = class
	switch {
	case class.Permanent():
		rec.Terminal = true
		rec.NextAttemptAt = now.Add(p.jitter(p.SecurityProbe, rnd))
	case rec.Terminal || rec.Attempts >= p.MaxAttempts:
		rec.Terminal = true
		rec.NextAttemptAt = now.Add(p.jitter(p.SlowProbe, rnd))
	default:
		rec.NextAttemptAt = now.Add(p.jitter(p.delay(rec.Attempts), rnd))
	}
	return rec
}

// Normalize repairs a record against clock anomalies. A clock behind
// LastAttemptAt (moved backwards) rebases the pending wait onto now — never a
// negative wait, never an immediate storm, never a stall as long as the skew.
// A NextAttemptAt further out than the longest (jittered) probe is clamped to
// it.
func (p Plan) Normalize(rec Record, now time.Time) (Record, bool) {
	changed := false
	if !rec.LastAttemptAt.IsZero() && now.Before(rec.LastAttemptAt) {
		wait := rec.NextAttemptAt.Sub(rec.LastAttemptAt)
		if wait < p.Initial {
			wait = p.Initial
		}
		rec.LastAttemptAt = now
		rec.NextAttemptAt = now.Add(wait)
		changed = true
	}
	if max := now.Add(p.maxWait()); rec.NextAttemptAt.After(max) {
		rec.NextAttemptAt = max
		changed = true
	}
	return rec, changed
}

// maxWait is the longest wait the plan itself can produce: the security probe
// at maximum positive jitter.
func (p Plan) maxWait() time.Duration {
	return time.Duration(float64(p.SecurityProbe) * (1 + p.Jitter))
}

// delay is the un-jittered active-phase delay after attempt n (1-based).
func (p Plan) delay(n int) time.Duration {
	d := float64(p.Initial)
	for i := 1; i < n && time.Duration(d) < p.Cap; i++ {
		d *= p.Multiplier
	}
	if time.Duration(d) > p.Cap {
		return p.Cap
	}
	return time.Duration(d)
}

// jitter applies ±Jitter using rnd ∈ [0,1] (clamped; 0.5 = no jitter).
func (p Plan) jitter(d time.Duration, rnd func() float64) time.Duration {
	if rnd == nil || p.Jitter <= 0 {
		return d
	}
	r := rnd()
	if r < 0 {
		r = 0
	} else if r > 1 {
		r = 1
	}
	return time.Duration(float64(d) * (1 + p.Jitter*(2*r-1)))
}
