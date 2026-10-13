package watchdoginstall

import (
	"testing"
	"time"
)

func noJitter() float64 { return 0.5 }

// fail runs one full attempt cycle (reserve, then record the failure).
func fail(p Plan, rec Record, version string, now time.Time, class ErrorClass, rnd func() float64) Record {
	rec = p.Reserve(rec, version, now)
	return p.Failed(rec, now, class, rnd)
}

func TestPlan_DelaySeries(t *testing.T) {
	p := DefaultPlan
	want := []time.Duration{
		5 * time.Minute, 15 * time.Minute, 45 * time.Minute,
		2*time.Hour + 15*time.Minute, 6 * time.Hour, 6 * time.Hour, 6 * time.Hour,
	}
	var rec Record
	now := fixedTime
	for i, w := range want {
		rec = fail(p, rec, "1.0.0", now, ClassNetwork, noJitter)
		if got := rec.NextAttemptAt.Sub(now); got != w {
			t.Fatalf("attempt %d: delay=%v want %v", i+1, got, w)
		}
		if rec.Terminal {
			t.Fatalf("attempt %d: terminal too early", i+1)
		}
		now = rec.NextAttemptAt
	}
}

func TestPlan_JitterBounds(t *testing.T) {
	p := DefaultPlan
	lo := fail(p, Record{}, "1.0.0", fixedTime, ClassNetwork, func() float64 { return 0 })
	hi := fail(p, Record{}, "1.0.0", fixedTime, ClassNetwork, func() float64 { return 1 })
	if got := lo.NextAttemptAt.Sub(fixedTime); got != 4*time.Minute {
		t.Fatalf("low jitter=%v want 4m", got)
	}
	if got := hi.NextAttemptAt.Sub(fixedTime); got != 6*time.Minute {
		t.Fatalf("high jitter=%v want 6m", got)
	}
	// Out-of-range rnd is clamped, never a negative or exploding wait.
	odd := fail(p, Record{}, "1.0.0", fixedTime, ClassNetwork, func() float64 { return -5 })
	if got := odd.NextAttemptAt.Sub(fixedTime); got != 4*time.Minute {
		t.Fatalf("clamped jitter=%v want 4m", got)
	}
}

func TestPlan_FreshRecordIsDue(t *testing.T) {
	if !DefaultPlan.Due(Record{}, "1.0.0", fixedTime) {
		t.Fatal("a host that never attempted must be due")
	}
}

func TestPlan_PermanentGoesTerminalImmediately(t *testing.T) {
	p := DefaultPlan
	rec := fail(p, Record{}, "1.0.0", fixedTime, ClassSignature, noJitter)
	if !rec.Terminal || rec.Attempts != 1 || rec.LastClass != ClassSignature {
		t.Fatalf("got %+v", rec)
	}
	if got := rec.NextAttemptAt.Sub(fixedTime); got != 7*24*time.Hour {
		t.Fatalf("probe=%v want 7d", got)
	}
	if p.Due(rec, "1.0.0", fixedTime.Add(6*24*time.Hour+23*time.Hour)) {
		t.Fatal("must not be due before the security probe")
	}
	if !p.Due(rec, "1.0.0", fixedTime.Add(7*24*time.Hour)) {
		t.Fatal("must be due at the security probe")
	}
}

func TestPlan_RestartDoesNotResetBudget(t *testing.T) {
	p := DefaultPlan
	var rec Record
	now := fixedTime
	for i := 0; i < 3; i++ {
		rec = fail(p, rec, "1.0.0", now, ClassNetwork, noJitter)
		now = rec.NextAttemptAt
	}
	// "Restart": a brand-new Plan value with the persisted record, same version.
	p2 := DefaultPlan
	if p2.Due(rec, "1.0.0", rec.LastAttemptAt.Add(time.Minute)) {
		t.Fatal("restart must honour the persisted NextAttemptAt")
	}
	if !p2.Due(rec, "1.0.0", rec.NextAttemptAt) {
		t.Fatal("due at NextAttemptAt")
	}
}

func TestPlan_VersionChangeRearmsOnce(t *testing.T) {
	p := DefaultPlan
	rec := fail(p, Record{}, "1.0.0", fixedTime, ClassChecksum, noJitter) // terminal, 7d
	if p.Due(rec, "1.0.0", fixedTime.Add(time.Hour)) {
		t.Fatal("same version must stay quiet")
	}
	if !p.Due(rec, "1.1.0", fixedTime.Add(time.Hour)) {
		t.Fatal("a new agent version must re-arm the budget")
	}
	rec = p.Reserve(rec, "1.1.0", fixedTime.Add(time.Hour))
	if rec.Terminal || rec.Attempts != 1 || rec.BudgetVersion != "1.1.0" {
		t.Fatalf("re-armed reservation wrong: %+v", rec)
	}
	rec = p.Failed(rec, fixedTime.Add(time.Hour), ClassChecksum, noJitter)
	if p.Due(rec, "1.1.0", fixedTime.Add(2*time.Hour)) {
		t.Fatal("the same new version must not re-arm a second time")
	}
}

func TestPlan_ExhaustionGoesTerminalThenSlowProbe(t *testing.T) {
	p := DefaultPlan
	var rec Record
	now := fixedTime
	for i := 0; i < p.MaxAttempts; i++ {
		if !p.Due(rec, "1.0.0", now) {
			t.Fatalf("attempt %d should be due", i+1)
		}
		rec = fail(p, rec, "1.0.0", now, ClassNetwork, noJitter)
		now = rec.NextAttemptAt
	}
	if !rec.Terminal {
		t.Fatalf("want terminal after %d attempts: %+v", p.MaxAttempts, rec)
	}
	if got := rec.NextAttemptAt.Sub(rec.LastAttemptAt); got != 24*time.Hour {
		t.Fatalf("slow probe=%v want 24h", got)
	}
	if p.Due(rec, "1.0.0", rec.LastAttemptAt.Add(23*time.Hour)) {
		t.Fatal("must not be due before the slow probe")
	}
	// A probe failure stays terminal and re-arms +24h.
	probeAt := rec.NextAttemptAt
	rec = fail(p, rec, "1.0.0", probeAt, ClassNetwork, noJitter)
	if !rec.Terminal || rec.NextAttemptAt.Sub(probeAt) != 24*time.Hour {
		t.Fatalf("probe failure: %+v", rec)
	}
}

func TestPlan_AttemptsSaturate(t *testing.T) {
	p := DefaultPlan
	rec := Record{SchemaVersion: SchemaVersion, BudgetVersion: "1.0.0", Attempts: MaxRecordedAttempts, Terminal: true}
	rec = fail(p, rec, "1.0.0", fixedTime, ClassNetwork, noJitter)
	if rec.Attempts != MaxRecordedAttempts {
		t.Fatalf("attempts=%d want saturate at %d", rec.Attempts, MaxRecordedAttempts)
	}
}

// The reservation is the only place Attempts grows: a kill between Reserve and
// Failed still spent the attempt, and Failed does not count it twice.
func TestPlan_ReservationNotDoubleCounted(t *testing.T) {
	p := DefaultPlan
	rec := p.Reserve(Record{}, "1.0.0", fixedTime)
	if rec.Attempts != 1 || rec.LastAttemptAt != fixedTime || rec.FirstAttemptAt != fixedTime {
		t.Fatalf("reservation: %+v", rec)
	}
	if p.Due(rec, "1.0.0", fixedTime.Add(time.Minute)) {
		t.Fatal("a reservation persisted before a crash must defer the next attempt")
	}
	rec = p.Failed(rec, fixedTime, ClassServer, noJitter)
	if rec.Attempts != 1 {
		t.Fatalf("Failed must not increment: %d", rec.Attempts)
	}
}

func TestPlan_ClockSkewBackwards(t *testing.T) {
	p := DefaultPlan
	rec := fail(p, Record{}, "1.0.0", fixedTime, ClassNetwork, noJitter) // next = +5m
	back := fixedTime.Add(-365 * 24 * time.Hour)
	norm, changed := p.Normalize(rec, back)
	if !changed {
		t.Fatal("a clock behind LastAttemptAt must rebase the record")
	}
	if p.Due(norm, "1.0.0", back) {
		t.Fatal("never an immediate storm after a backwards jump")
	}
	if got := norm.NextAttemptAt.Sub(back); got != 5*time.Minute {
		t.Fatalf("rebased wait=%v want the original 5m", got)
	}
	// Clamp a far-future NextAttemptAt (forward-skewed or hand-edited state).
	far := rec
	far.NextAttemptAt = fixedTime.Add(10 * 365 * 24 * time.Hour)
	norm, changed = p.Normalize(far, fixedTime)
	if !changed || norm.NextAttemptAt.Sub(fixedTime) != p.SecurityProbe {
		t.Fatalf("far-future clamp: changed=%v next=%v", changed, norm.NextAttemptAt.Sub(fixedTime))
	}
	if _, changed := p.Normalize(rec, fixedTime.Add(time.Minute)); changed {
		t.Fatal("a sane record must not change")
	}
}
