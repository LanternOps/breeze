package isolation

import (
	"reflect"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

const (
	idA = "6f1c2a9e-4b3d-4c5e-8f70-1a2b3c4d5e6f"
	idB = "0b9e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6b"
)

func kinds(effects []Effect) []EffectKind {
	out := make([]EffectKind, 0, len(effects))
	for _, e := range effects {
		out = append(out, e.Kind)
	}
	return out
}

func wantKinds(t *testing.T, effects []Effect, want ...EffectKind) {
	t.Helper()
	if got := kinds(effects); !reflect.DeepEqual(got, want) {
		t.Fatalf("effects = %v, want %v", got, want)
	}
}

func lastReport(t *testing.T, effects []Effect) Effect {
	t.Helper()
	for i := len(effects) - 1; i >= 0; i-- {
		if effects[i].Kind == EffReport {
			return effects[i]
		}
	}
	t.Fatalf("no Report effect in %v", kinds(effects))
	return Effect{}
}

func isolateEv(id string, gen int, c Clock, attempt string) Event {
	return Event{Kind: EvIsolate, IsolationID: id, Generation: gen, ExpiresAt: c.Now().Add(72 * time.Hour), AttemptID: attempt}
}

// provisional returns the state right after an isolate was accepted.
func provisional(t *testing.T, c Clock) LocalState {
	t.Helper()
	s, effects := Step(LocalState{Phase: journal.PhaseNone}, isolateEv(idA, 1, c, "a1"), c)
	wantKinds(t, effects, EffArmProvisional, EffArmExpiry, EffApplyRules, EffRunProbes)
	return s
}

func committed(t *testing.T, c Clock) LocalState {
	t.Helper()
	s := provisional(t, c)
	s, _ = Step(s, Event{Kind: EvProbesPassed, AttemptID: "a1"}, c)
	s, _ = Step(s, Event{Kind: EvCommitReady, AttemptID: "a1"}, c)
	if s.Phase != journal.PhaseCommitted {
		t.Fatalf("phase = %s, want committed", s.Phase)
	}
	return s
}

func TestStepIsolateFromNone(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	if s.Phase != journal.PhaseProvisional || s.IsolationID != idA || s.Generation != 1 || s.AttemptID != "a1" {
		t.Fatalf("unexpected provisional state %+v", s)
	}
	if !s.Deadline.Equal(c.Now().Add(ProvisionalWindow)) {
		t.Fatalf("deadline = %v, want now+%v", s.Deadline, ProvisionalWindow)
	}
	if !s.RulesMayExist || s.State != StateApplying {
		t.Fatalf("RulesMayExist=%v State=%q", s.RulesMayExist, s.State)
	}
}

func TestStepIsolateRefusals(t *testing.T) {
	c := newFakeClock()
	prov := provisional(t, c)
	comm := committed(t, c)
	rolled := LocalState{Phase: journal.PhaseRolledBack, IsolationID: idA, Generation: 1, State: StateFailed}
	releasing := comm
	releasing.Phase = journal.PhaseReleasing
	releasing.Release = ReleaseIntent{Kind: "console"}
	orphan := LocalState{Phase: journal.PhaseNone, RulesMayExist: true}

	expired := isolateEv(idA, 1, c, "a2")
	expired.ExpiresAt = c.Now()

	cases := []struct {
		name string
		cur  LocalState
		ev   Event
		code wire.CommandErrorCode
	}{
		{"no id", LocalState{Phase: journal.PhaseNone}, isolateEv("", 1, c, "a2"), wire.ErrCodeIsolationInvalidSpec},
		{"generation 0", LocalState{Phase: journal.PhaseNone}, isolateEv(idA, 0, c, "a2"), wire.ErrCodeIsolationInvalidSpec},
		{"no attempt", LocalState{Phase: journal.PhaseNone}, isolateEv(idA, 1, c, ""), wire.ErrCodeIsolationInvalidSpec},
		{"already expired", LocalState{Phase: journal.PhaseNone}, expired, wire.ErrCodeIsolationInvalidSpec},
		{"provisional busy", prov, isolateEv(idA, 2, c, "a2"), wire.ErrCodeIsolationBusy},
		{"releasing busy", releasing, isolateEv(idB, 1, c, "a2"), wire.ErrCodeIsolationBusy},
		{"orphan rules pending cleanup", orphan, isolateEv(idA, 1, c, "a2"), wire.ErrCodeIsolationBusy},
		{"other episode committed", comm, isolateEv(idB, 1, c, "a2"), wire.ErrCodeIsolationEpisodeMismatch},
		{"stale generation", withGen(comm, 3), isolateEv(idA, 2, c, "a2"), wire.ErrCodeIsolationStaleGeneration},
		{"ended locally", rolled, isolateEv(idA, 2, c, "a2"), wire.ErrCodeIsolationStaleGeneration},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			next, effects := Step(tc.cur, tc.ev, c)
			if !reflect.DeepEqual(next, tc.cur) {
				t.Fatalf("a refusal changed the state:\n cur %+v\nnext %+v", tc.cur, next)
			}
			wantKinds(t, effects, EffReport)
			if effects[0].Refusal != tc.code {
				t.Fatalf("refusal = %q, want %q", effects[0].Refusal, tc.code)
			}
		})
	}
}

func withGen(s LocalState, gen int) LocalState { s.Generation = gen; return s }

func TestStepIsolateNewEpisodeAfterTerminal(t *testing.T) {
	c := newFakeClock()
	for _, phase := range []journal.Phase{journal.PhaseReleased, journal.PhaseRolledBack} {
		cur := LocalState{Phase: phase, IsolationID: idA, Generation: 2, State: StateReleased, HighWaterWall: c.Now()}
		next, effects := Step(cur, isolateEv(idB, 1, c, "b1"), c)
		wantKinds(t, effects, EffArmProvisional, EffArmExpiry, EffApplyRules, EffRunProbes)
		if next.IsolationID != idB || next.Phase != journal.PhaseProvisional {
			t.Fatalf("%s: next = %+v", phase, next)
		}
	}
}

func TestStepProbesPassThenCommit(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	s, effects := Step(s, Event{Kind: EvProbesPassed, AttemptID: "a1"}, c)
	wantKinds(t, effects, EffCommit)
	if s.Phase != journal.PhaseProvisional || !s.ProbesPassed {
		t.Fatalf("after probes: %+v", s)
	}
	c.Advance(10 * time.Second)
	s, effects = Step(s, Event{Kind: EvCommitReady, AttemptID: "a1"}, c)
	wantKinds(t, effects, EffDisarmProvisional, EffReport)
	if effects[0].AttemptID != "a1" || effects[0].All {
		t.Fatalf("disarm effect = %+v, want the one attempt", effects[0])
	}
	if r := lastReport(t, effects); r.State != StateVerified {
		t.Fatalf("report state = %q", r.State)
	}
	if s.Phase != journal.PhaseCommitted || s.AttemptID != "" || s.State != StateVerified {
		t.Fatalf("committed state %+v", s)
	}
	if !s.AppliedAtWall.Equal(c.Now()) || s.AppliedAtMono != c.Mono() || s.BootID != c.BootID() {
		t.Fatalf("clock anchor not recorded: %+v", s)
	}
}

func TestStepCommitRequiresProbes(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	next, effects := Step(s, Event{Kind: EvCommitReady, AttemptID: "a1"}, c)
	if len(effects) != 0 || next.Phase != journal.PhaseProvisional {
		t.Fatalf("commit without probes: phase %s effects %v", next.Phase, kinds(effects))
	}
}

func TestStepStaleAttemptEventsIgnored(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	for _, ev := range []Event{
		{Kind: EvProbesPassed, AttemptID: "old"},
		{Kind: EvCommitReady, AttemptID: "old"},
		{Kind: EvAttemptFailed, AttemptID: "old", Code: FailControlPlaneUnreachable},
	} {
		next, effects := Step(s, ev, c)
		if !reflect.DeepEqual(next, s) || len(effects) != 0 {
			t.Fatalf("event %+v for another attempt changed things: %v", ev, kinds(effects))
		}
	}
}

func TestStepAttemptFailedRollsBack(t *testing.T) {
	c := newFakeClock()
	for _, code := range []string{FailMechanismUnavailable, FailApplyError, FailControlPlaneUnreachable, FailEnforcementNotObserved} {
		s := provisional(t, c)
		s, effects := Step(s, Event{Kind: EvAttemptFailed, AttemptID: "a1", Code: code}, c)
		wantKinds(t, effects, EffRollback, EffConfirmAbsent)
		if s.Phase != journal.PhaseReleasing || !s.Release.Rollback || s.Release.FailureCode != code || !s.RulesMayExist {
			t.Fatalf("%s: %+v", code, s)
		}
		s, effects = Step(s, Event{Kind: EvAbsentConfirmed}, c)
		wantKinds(t, effects, EffDisarmProvisional, EffReport)
		if !effects[0].All {
			t.Fatal("rollback did not remove every recovery task")
		}
		r := lastReport(t, effects)
		if r.State != StateFailed || r.FailureCode != code {
			t.Fatalf("%s: report %+v", code, r)
		}
		if s.Phase != journal.PhaseRolledBack || s.RulesMayExist {
			t.Fatalf("%s: final %+v", code, s)
		}
	}
}

func TestStepCleanupFailureStaysUnresolved(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	s, _ = Step(s, Event{Kind: EvAttemptFailed, AttemptID: "a1", Code: FailApplyError}, c)
	next, effects := Step(s, Event{Kind: EvReleaseFailed, Err: "engine refused"}, c)
	wantKinds(t, effects, EffReport)
	if next.Phase != journal.PhaseReleasing || !next.RulesMayExist {
		t.Fatalf("cleanup failure resolved the episode: %+v", next)
	}
	if r := lastReport(t, effects); r.State == StateFailed || r.Detail == "" {
		t.Fatalf("cleanup failure reported %+v", r)
	}
	// Tick retries the rollback.
	_, effects = Step(next, Event{Kind: EvTick}, c)
	wantKinds(t, effects, EffRollback, EffConfirmAbsent)
}

func TestStepProvisionalPastDeadlineRollsBack(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	c.Advance(ProvisionalWindow - time.Second)
	if _, effects := Step(s, Event{Kind: EvTick}, c); len(effects) != 0 {
		t.Fatalf("rolled back before the deadline: %v", kinds(effects))
	}
	c.Advance(time.Second)
	next, effects := Step(s, Event{Kind: EvTick}, c)
	wantKinds(t, effects, EffRollback, EffConfirmAbsent)
	if next.Release.FailureCode != FailControlPlaneUnreachable {
		t.Fatalf("code = %q", next.Release.FailureCode)
	}
}

// A commit that arrives after the deadline rolls back instead.
func TestStepCommitAfterDeadlineRollsBack(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	s, _ = Step(s, Event{Kind: EvProbesPassed, AttemptID: "a1"}, c)
	c.Advance(ProvisionalWindow)
	next, effects := Step(s, Event{Kind: EvCommitReady, AttemptID: "a1"}, c)
	wantKinds(t, effects, EffRollback, EffConfirmAbsent)
	if next.Phase != journal.PhaseReleasing {
		t.Fatalf("phase = %s", next.Phase)
	}
}

// A reboot during a provisional apply never promotes it, even inside the
// window: the worker that would commit is gone.
func TestStepProvisionalAcrossRebootRollsBack(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	c.Reboot("boot-2", c.Now().Add(10*time.Second))
	_, effects := Step(s, Event{Kind: EvTick}, c)
	wantKinds(t, effects, EffRollback, EffConfirmAbsent)
}

func TestStepExtend(t *testing.T) {
	c := newFakeClock()
	s := committed(t, c)
	ev := isolateEv(idA, 2, c, "a2")
	ev.ExpiresAt = c.Now().Add(100 * time.Hour)
	next, effects := Step(s, ev, c)
	wantKinds(t, effects, EffArmExpiry, EffReport)
	if next.Generation != 2 || !next.ExpiresAt.Equal(ev.ExpiresAt) || next.Phase != journal.PhaseCommitted {
		t.Fatalf("extend: %+v", next)
	}
	// A retransmission of the same generation is idempotent.
	again, effects := Step(next, ev, c)
	wantKinds(t, effects, EffReport)
	if !reflect.DeepEqual(again, next) {
		t.Fatal("retransmission changed the state")
	}
}

func TestStepRefresh(t *testing.T) {
	c := newFakeClock()
	s := committed(t, c)
	s, effects := Step(s, Event{Kind: EvRefresh, AttemptID: "r1"}, c)
	wantKinds(t, effects, EffApplyRules, EffRunProbes)
	if s.AttemptID != "r1" || s.AttemptKind != AttemptRefresh || s.Phase != journal.PhaseCommitted {
		t.Fatalf("refresh: %+v", s)
	}
	// A second refresh while one is in flight does nothing.
	if _, effects := Step(s, Event{Kind: EvRefresh, AttemptID: "r2"}, c); len(effects) != 0 {
		t.Fatalf("overlapping refresh: %v", kinds(effects))
	}
	passed, effects := Step(s, Event{Kind: EvProbesPassed, AttemptID: "r1"}, c)
	wantKinds(t, effects, EffCommit)
	done, effects := Step(passed, Event{Kind: EvCommitReady, AttemptID: "r1"}, c)
	wantKinds(t, effects, EffReport)
	if done.AttemptID != "" || done.Phase != journal.PhaseCommitted {
		t.Fatalf("refresh commit: %+v", done)
	}

	// A failed refresh re-installs the last committed rules and stays isolated.
	failed, effects := Step(s, Event{Kind: EvAttemptFailed, AttemptID: "r1", Code: FailControlPlaneUnreachable}, c)
	wantKinds(t, effects, EffRollback, EffReport)
	if !effects[0].Prior {
		t.Fatal("refresh rollback must restore the prior rules, not remove them")
	}
	if failed.Phase != journal.PhaseCommitted || failed.AttemptID != "" {
		t.Fatalf("refresh failure: %+v", failed)
	}
}

func TestStepRefreshIgnoredUnlessCommitted(t *testing.T) {
	c := newFakeClock()
	for _, s := range []LocalState{{Phase: journal.PhaseNone}, provisional(t, c)} {
		next, effects := Step(s, Event{Kind: EvRefresh, AttemptID: "r1"}, c)
		if len(effects) != 0 || !reflect.DeepEqual(next, s) {
			t.Fatalf("refresh in %s: %v", s.Phase, kinds(effects))
		}
	}
}

func TestStepRelease(t *testing.T) {
	c := newFakeClock()
	cases := []struct {
		kind  string
		state string
	}{
		{"console", StateReleased},
		{"ai", StateReleased},
		{"system", StateReleased},
		{"uninstall", StateReleased},
		{"expired", StateExpired},
		{"local_code", StateReleasedLocally},
		{"local_forced", StateReleasedLocally},
		{"dead_man", StateSelfReleased},
	}
	for _, tc := range cases {
		s := committed(t, c)
		s, effects := Step(s, Event{Kind: EvRelease, IsolationID: idA, Generation: 2, ReleaseKind: tc.kind}, c)
		wantKinds(t, effects, EffReleaseRules, EffConfirmAbsent)
		if s.Phase != journal.PhaseReleasing || s.Generation != 2 || s.Release.Kind != tc.kind {
			t.Fatalf("%s: %+v", tc.kind, s)
		}
		s, effects = Step(s, Event{Kind: EvAbsentConfirmed}, c)
		wantKinds(t, effects, EffDisarmProvisional, EffReport)
		r := lastReport(t, effects)
		if r.State != tc.state || r.ReleaseKind != tc.kind || !effects[0].All {
			t.Fatalf("%s: report %+v disarm %+v", tc.kind, r, effects[0])
		}
		if s.Phase != journal.PhaseReleased || s.RulesMayExist {
			t.Fatalf("%s: final %+v", tc.kind, s)
		}
	}
}

func TestStepReleaseDuringProvisional(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	s, effects := Step(s, Event{Kind: EvRelease, IsolationID: idA, Generation: 2, ReleaseKind: "console"}, c)
	wantKinds(t, effects, EffReleaseRules, EffConfirmAbsent)
	if s.AttemptID != "" {
		t.Fatal("release left the attempt live, so a probing worker could still commit")
	}
	// The probing worker comes back: fenced.
	next, effects := Step(s, Event{Kind: EvProbesPassed, AttemptID: "a1"}, c)
	if len(effects) != 0 || !reflect.DeepEqual(next, s) {
		t.Fatal("a fenced worker's probe result was accepted")
	}
}

func TestStepReleaseRefusals(t *testing.T) {
	c := newFakeClock()
	comm := withGen(committed(t, c), 3)
	cases := []struct {
		name string
		ev   Event
		code wire.CommandErrorCode
	}{
		{"other episode", Event{Kind: EvRelease, IsolationID: idB, Generation: 4, ReleaseKind: "console"}, wire.ErrCodeIsolationEpisodeMismatch},
		{"stale generation", Event{Kind: EvRelease, IsolationID: idA, Generation: 2, ReleaseKind: "console"}, wire.ErrCodeIsolationStaleGeneration},
		{"no kind", Event{Kind: EvRelease, IsolationID: idA, Generation: 4}, wire.ErrCodeIsolationInvalidSpec},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			next, effects := Step(comm, tc.ev, c)
			wantKinds(t, effects, EffReport)
			if effects[0].Refusal != tc.code || !reflect.DeepEqual(next, comm) {
				t.Fatalf("refusal %q state changed=%v", effects[0].Refusal, !reflect.DeepEqual(next, comm))
			}
		})
	}
	// Nothing journalled: a release names an episode this device never had.
	_, effects := Step(LocalState{Phase: journal.PhaseNone}, Event{Kind: EvRelease, IsolationID: idA, Generation: 2, ReleaseKind: "console"}, c)
	if effects[0].Refusal != wire.ErrCodeIsolationEpisodeMismatch {
		t.Fatalf("release with no journal: %q", effects[0].Refusal)
	}
}

func TestStepReleaseIdempotentAfterRelease(t *testing.T) {
	c := newFakeClock()
	s := committed(t, c)
	s, _ = Step(s, Event{Kind: EvRelease, IsolationID: idA, Generation: 2, ReleaseKind: "console"}, c)
	s, _ = Step(s, Event{Kind: EvAbsentConfirmed}, c)
	next, effects := Step(s, Event{Kind: EvRelease, IsolationID: idA, Generation: 2, ReleaseKind: "console"}, c)
	wantKinds(t, effects, EffReport)
	if r := lastReport(t, effects); r.State != StateReleased || r.Refusal != "" {
		t.Fatalf("re-release report %+v", r)
	}
	if !reflect.DeepEqual(next, s) {
		t.Fatal("re-release changed the state")
	}
}

// A release that arrives while a rollback is cleaning up becomes the release
// (the server's tombstone needs `released` at its generation).
func TestStepReleaseTakesOverRollback(t *testing.T) {
	c := newFakeClock()
	s := provisional(t, c)
	s, _ = Step(s, Event{Kind: EvAttemptFailed, AttemptID: "a1", Code: FailApplyError}, c)
	s, effects := Step(s, Event{Kind: EvRelease, IsolationID: idA, Generation: 2, ReleaseKind: "console"}, c)
	wantKinds(t, effects, EffReleaseRules, EffConfirmAbsent)
	if s.Release.Rollback || s.Generation != 2 {
		t.Fatalf("release over rollback: %+v", s)
	}
}

func TestStepOrphanCleanup(t *testing.T) {
	c := newFakeClock()
	s := LocalState{Phase: journal.PhaseNone, RulesMayExist: true}
	s, effects := Step(s, Event{Kind: EvRelease, ReleaseKind: "system"}, c)
	wantKinds(t, effects, EffReleaseRules, EffConfirmAbsent)
	s, effects = Step(s, Event{Kind: EvAbsentConfirmed}, c)
	wantKinds(t, effects, EffDisarmProvisional, EffReport)
	if s.Phase != journal.PhaseNone || s.RulesMayExist {
		t.Fatalf("orphan cleanup final %+v", s)
	}
}

// `system` with no id releases whatever episode is journalled (the
// desired-episode-differs-from-journal rule).
func TestStepSystemReleaseOfJournalledEpisode(t *testing.T) {
	c := newFakeClock()
	s := committed(t, c)
	next, effects := Step(s, Event{Kind: EvRelease, ReleaseKind: "system"}, c)
	wantKinds(t, effects, EffReleaseRules, EffConfirmAbsent)
	if next.IsolationID != idA || next.Release.Kind != "system" {
		t.Fatalf("%+v", next)
	}
}

func TestStepTickExpires(t *testing.T) {
	c := newFakeClock()
	s := committed(t, c)
	c.Advance(72 * time.Hour)
	next, effects := Step(s, Event{Kind: EvTick}, c)
	wantKinds(t, effects, EffReleaseRules, EffConfirmAbsent)
	if next.Release.Kind != "expired" {
		t.Fatalf("expiry kind %q", next.Release.Kind)
	}
}

func TestStepTickUpdatesHighWaterAndReanchorsAfterReboot(t *testing.T) {
	c := newFakeClock()
	s := committed(t, c)
	c.Advance(time.Hour)
	s, effects := Step(s, Event{Kind: EvTick}, c)
	if len(effects) != 0 || !s.HighWaterWall.Equal(c.Now()) {
		t.Fatalf("tick: effects %v highWater %v", kinds(effects), s.HighWaterWall)
	}
	c.Reboot("boot-2", c.Now().Add(time.Minute))
	s, _ = Step(s, Event{Kind: EvTick}, c)
	if s.BootID != "boot-2" || s.AppliedAtMono != c.Mono() || !s.AppliedAtWall.Equal(c.Now()) {
		t.Fatalf("not re-anchored after reboot: %+v", s)
	}
}

func TestStepTickStaleRefreshRestoresPrior(t *testing.T) {
	c := newFakeClock()
	s := committed(t, c)
	s, _ = Step(s, Event{Kind: EvRefresh, AttemptID: "r1"}, c)
	c.Advance(ProvisionalWindow)
	next, effects := Step(s, Event{Kind: EvTick}, c)
	wantKinds(t, effects, EffRollback, EffReport)
	if !effects[0].Prior || next.AttemptID != "" {
		t.Fatalf("stale refresh: %+v %+v", effects[0], next)
	}
}

func TestStepUnknownEventIsNoop(t *testing.T) {
	c := newFakeClock()
	s := committed(t, c)
	next, effects := Step(s, Event{Kind: EventKind(99)}, c)
	if len(effects) != 0 || !reflect.DeepEqual(next, s) {
		t.Fatal("unknown event changed state")
	}
}

func TestReportStateForKind(t *testing.T) {
	if got := ReportStateForKind("bogus"); got != StateReleased {
		t.Fatalf("unknown kind maps to %q", got)
	}
}
