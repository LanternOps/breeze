package isolation

import (
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// FuzzStep drives Step with arbitrary event sequences and checks the three
// W1d safety invariants after every step:
//
//  1. committed is never reached without RunProbes succeeding for that attempt;
//  2. ApplyRules always leaves a pending Commit or Rollback;
//  3. released (or any terminal outcome) is never reported without
//     ConfirmAbsent succeeding.
func FuzzStep(f *testing.F) {
	f.Add([]byte{0, 0, 3, 0, 4, 0})                   // isolate, probes pass, commit
	f.Add([]byte{0, 0, 5, 1, 8, 0})                   // isolate, attempt fails, absent
	f.Add([]byte{0, 0, 3, 0, 4, 0, 6, 0, 8, 0})       // ... release, absent
	f.Add([]byte{0, 0, 9, 200, 9, 200, 8, 0})         // isolate, ticks past deadline
	f.Add([]byte{0, 0, 3, 0, 4, 0, 2, 0, 5, 0, 9, 0}) // refresh that fails
	f.Add([]byte{0, 0, 6, 0, 7, 0, 9, 0, 8, 0})       // release during apply, cleanup fails then succeeds
	f.Add([]byte{0, 0, 3, 0, 10, 0, 4, 0, 9, 0})      // reboot mid-apply

	f.Fuzz(func(t *testing.T, input []byte) {
		if len(input) > 256 {
			input = input[:256]
		}
		runStepModel(t, input)
	})
}

// Also run the seeds (and a few long pseudo-random walks) under plain `go test`.
func TestStepInvariantWalks(t *testing.T) {
	seed := uint32(2463534242)
	for walk := 0; walk < 300; walk++ {
		input := make([]byte, 120)
		for i := range input {
			seed ^= seed << 13
			seed ^= seed >> 17
			seed ^= seed << 5
			input[i] = byte(seed)
		}
		runStepModel(t, input)
	}
}

type stepModel struct {
	t       *testing.T
	clock   *fakeClock
	state   LocalState
	attempt int
	// probesPassed records attempts whose EvProbesPassed was accepted (it
	// produced a Commit effect).
	probesPassed map[string]bool
	// pendingApply is the attempt whose ApplyRules has run and which has not
	// yet been committed or rolled back.
	pendingApply string
	boots        int
}

func runStepModel(t *testing.T, input []byte) {
	m := &stepModel{t: t, clock: newFakeClock(), state: LocalState{Phase: journal.PhaseNone}, probesPassed: map[string]bool{}}
	for i := 0; i+1 < len(input); i += 2 {
		m.step(i/2, input[i], input[i+1])
	}
}

func (m *stepModel) ids(b byte) string {
	if b%2 == 0 {
		return idA
	}
	return idB
}

var fuzzCodes = []string{FailMechanismUnavailable, FailApplyError, FailControlPlaneUnreachable, FailEnforcementNotObserved}
var fuzzKinds = []string{"console", "ai", "expired", "dead_man", "local_code", "local_forced", "uninstall", "system", ""}

func (m *stepModel) currentOr(b byte) string {
	// Mostly target the live attempt, sometimes a stale one.
	if b%4 != 0 && m.state.AttemptID != "" {
		return m.state.AttemptID
	}
	return fmt.Sprintf("a%d", int(b)%(m.attempt+2))
}

func (m *stepModel) event(op, arg byte) Event {
	switch op % 11 {
	case 0:
		m.attempt++
		ttl := time.Duration(int(arg)%100+1) * time.Hour
		if arg%17 == 0 {
			ttl = -time.Minute
		}
		return Event{Kind: EvIsolate, IsolationID: m.ids(arg), Generation: int(arg)%3 + 1, ExpiresAt: m.clock.Now().Add(ttl), AttemptID: fmt.Sprintf("a%d", m.attempt)}
	case 1:
		return Event{Kind: EvIsolate, IsolationID: m.ids(arg), Generation: m.state.Generation + int(arg)%2, ExpiresAt: m.clock.Now().Add(time.Duration(arg) * time.Hour), AttemptID: fmt.Sprintf("x%d", arg)}
	case 2:
		m.attempt++
		return Event{Kind: EvRefresh, AttemptID: fmt.Sprintf("a%d", m.attempt)}
	case 3:
		return Event{Kind: EvProbesPassed, AttemptID: m.currentOr(arg)}
	case 4:
		return Event{Kind: EvCommitReady, AttemptID: m.currentOr(arg)}
	case 5:
		return Event{Kind: EvAttemptFailed, AttemptID: m.currentOr(arg), Code: fuzzCodes[int(arg)%len(fuzzCodes)]}
	case 6:
		id := m.state.IsolationID
		if arg%5 == 0 {
			id = m.ids(arg)
		}
		if arg%7 == 0 {
			id = ""
		}
		return Event{Kind: EvRelease, IsolationID: id, Generation: m.state.Generation + int(arg)%3 - 1, ReleaseKind: fuzzKinds[int(arg)%len(fuzzKinds)]}
	case 7:
		return Event{Kind: EvReleaseFailed, Err: "fuzz"}
	case 8:
		return Event{Kind: EvAbsentConfirmed}
	case 9:
		m.clock.Advance(time.Duration(arg) * time.Second)
		if arg > 250 {
			m.clock.Advance(80 * time.Hour)
		}
		return Event{Kind: EvTick}
	default:
		m.boots++
		m.clock.Reboot(fmt.Sprintf("fuzz-boot-%d", m.boots), m.clock.Now().Add(time.Duration(int(arg)-128)*time.Minute))
		return Event{Kind: EvTick}
	}
}

func hasEffect(effects []Effect, k EffectKind) bool {
	for _, e := range effects {
		if e.Kind == k {
			return true
		}
	}
	return false
}

func isTerminalReport(state string) bool {
	switch state {
	case StateFailed, StateReleased, StateExpired, StateReleasedLocally, StateSelfReleased:
		return true
	}
	return false
}

func (m *stepModel) step(index int, op, arg byte) {
	t := m.t
	cur := m.state
	ev := m.event(op, arg)
	next, effects := Step(cur, ev, m.clock)
	fail := func(format string, args ...any) {
		t.Helper()
		t.Fatalf("step %d (%+v):\n cur %+v\nnext %+v\neffects %v\n"+format, append([]any{index, ev, cur, next, kinds(effects)}, args...)...)
	}

	// Invariant 1: entering committed needs a successful probe for the attempt.
	if next.Phase == journal.PhaseCommitted && cur.Phase != journal.PhaseCommitted {
		if ev.Kind != EvCommitReady || ev.AttemptID != cur.AttemptID || !cur.ProbesPassed || !m.probesPassed[cur.AttemptID] {
			fail("entered committed without RunProbes succeeding")
		}
	}
	if hasEffect(effects, EffCommit) {
		if ev.Kind != EvProbesPassed || m.pendingApply != ev.AttemptID {
			fail("Commit effect without a probe pass on an applied attempt")
		}
		m.probesPassed[ev.AttemptID] = true
	}

	// Invariant 2: ApplyRules leaves a pending Commit or Rollback.
	committedNow := ev.Kind == EvCommitReady && m.pendingApply != "" && ev.AttemptID == m.pendingApply &&
		cur.AttemptID == m.pendingApply && next.AttemptID == "" && !hasEffect(effects, EffRollback)
	resolved := committedNow || hasEffect(effects, EffRollback) || hasEffect(effects, EffReleaseRules)
	if m.pendingApply != "" {
		if !resolved && next.AttemptID != m.pendingApply {
			fail("attempt %q left its rules with neither Commit nor Rollback", m.pendingApply)
		}
		if resolved {
			// A rollback keeps the attempt id journalled until absence is
			// confirmed (recovery matches on it); the attempt is resolved.
			m.pendingApply = ""
		}
	}
	for _, e := range effects {
		if e.Kind == EffApplyRules {
			if next.AttemptID != e.AttemptID || !next.RulesMayExist {
				fail("ApplyRules without a live attempt to commit or roll back")
			}
			m.pendingApply = e.AttemptID
		}
	}
	if m.pendingApply != "" && !next.RulesMayExist {
		fail("rules may exist for attempt %q but RulesMayExist is false", m.pendingApply)
	}
	switch next.Phase {
	case journal.PhaseProvisional, journal.PhaseCommitted, journal.PhaseReleasing:
		if !next.RulesMayExist {
			fail("phase %s with RulesMayExist=false", next.Phase)
		}
	}

	// Invariant 3: a terminal outcome is reported only after ConfirmAbsent.
	for _, e := range effects {
		if e.Kind == EffReport && e.Refusal == "" && isTerminalReport(e.State) {
			confirmedNow := ev.Kind == EvAbsentConfirmed && cur.Phase == journal.PhaseReleasing
			reReport := (cur.Phase == journal.PhaseReleased || cur.Phase == journal.PhaseRolledBack) && !cur.RulesMayExist
			if !confirmedNow && !reReport {
				fail("reported %q without ConfirmAbsent", e.State)
			}
		}
	}
	if (next.Phase == journal.PhaseReleased || next.Phase == journal.PhaseRolledBack) && cur.Phase != next.Phase {
		if ev.Kind != EvAbsentConfirmed {
			fail("reached %s without ConfirmAbsent", next.Phase)
		}
	}
	if next.Phase == journal.PhaseNone && cur.Phase == journal.PhaseReleasing && ev.Kind != EvAbsentConfirmed {
		fail("left releasing without ConfirmAbsent")
	}

	// The generation of a held episode never goes backwards.
	if next.IsolationID == cur.IsolationID && next.IsolationID != "" && next.Generation < cur.Generation {
		fail("generation went backwards")
	}

	m.state = next
}
