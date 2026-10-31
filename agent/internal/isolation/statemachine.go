package isolation

import (
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

// ProvisionalWindow is how long an apply stays provisional: the probes must
// finish within 60 s, and the one-shot OS rollback fires at apply + 90 s.
const ProvisionalWindow = 90 * time.Second

// AttemptKind says what an in-flight attempt is installing.
type AttemptKind string

const (
	// AttemptApply is the first apply of an episode (phase provisional). Its
	// failure removes every rule.
	AttemptApply AttemptKind = "apply"
	// AttemptRefresh re-installs a committed episode's rules (re-resolved
	// addresses, a changed allowlist, drift). Its failure restores the last
	// committed rules: the device stays isolated.
	AttemptRefresh AttemptKind = "refresh"
)

// ReleaseIntent is why the rules are coming off (phase releasing).
type ReleaseIntent struct {
	// Kind is the release kind; empty for a rollback.
	Kind string
	// Rollback marks the removal of an uncommitted apply.
	Rollback bool
	// FailureCode is the episode failure a rollback reports.
	FailureCode string
}

// LocalState is the part of the journal the state machine decides on.
type LocalState struct {
	Phase       journal.Phase
	IsolationID string
	Generation  int
	ExpiresAt   time.Time

	// The attempt in flight, if any.
	AttemptID     string
	AttemptKind   AttemptKind
	Deadline      time.Time
	AttemptBootID string
	AttemptMono   time.Duration
	ProbesPassed  bool

	// RulesMayExist is true from the moment an apply is decided until a
	// ConfirmAbsent succeeds (or a journal is lost while rules are owned).
	RulesMayExist bool
	Release       ReleaseIntent

	// Clock-rule anchor (see Expired).
	AppliedAtWall time.Time
	AppliedAtMono time.Duration
	BootID        string
	HighWaterWall time.Time

	// The episode outcome this device reports.
	State       string
	FailureCode string
	ReleaseKind string
}

// EventKind is an input to Step.
type EventKind int

const (
	// EvIsolate: the server wants IsolationID isolated at Generation.
	EvIsolate EventKind = iota + 1
	// EvRefresh: re-install the committed episode's rules.
	EvRefresh
	// EvProbesPassed: both probes passed for AttemptID.
	EvProbesPassed
	// EvCommitReady: under the lock, AttemptID, the deadline and the Verify
	// digest all still check out.
	EvCommitReady
	// EvAttemptFailed: AttemptID failed with Code (arming, apply, probes or
	// the commit check).
	EvAttemptFailed
	// EvRelease: take the rules off (ReleaseKind says why).
	EvRelease
	// EvReleaseFailed: Rollback or ReleaseRules returned an error, or the
	// rules were still owned afterwards.
	EvReleaseFailed
	// EvAbsentConfirmed: Owned() is false.
	EvAbsentConfirmed
	// EvTick: periodic evaluation (deadline, expiry, retries, clock anchor).
	EvTick
)

// Event is one input. Only the fields its Kind names are read.
type Event struct {
	Kind        EventKind
	IsolationID string
	Generation  int
	ExpiresAt   time.Time
	AttemptID   string
	Code        string
	ReleaseKind string
	Err         string
}

// EffectKind is something the manager must do.
type EffectKind int

const (
	// EffArmProvisional: arm the one-shot OS rollback at the deadline.
	EffArmProvisional EffectKind = iota + 1
	// EffApplyRules: re-check the deadline, then Isolator.Apply.
	EffApplyRules
	// EffRunProbes: drop the lock, run the positive and negative probes.
	EffRunProbes
	// EffCommit: retake the lock; re-check attempt, deadline and Verify.
	EffCommit
	// EffRollback: undo an attempt (Prior=false: remove every rule;
	// Prior=true: re-install the last committed rules).
	EffRollback
	// EffReleaseRules: Isolator.Release.
	EffReleaseRules
	// EffConfirmAbsent: Isolator.Owned must be false.
	EffConfirmAbsent
	// EffDisarmProvisional: remove the attempt's one-shot rollback
	// (All=true: remove every recovery task).
	EffDisarmProvisional
	// EffArmExpiry: arm the one-shot expiry task and the poll.
	EffArmExpiry
	// EffReport: the outcome of the operation.
	EffReport
)

var effectNames = map[EffectKind]string{
	EffArmProvisional:    "ArmProvisional",
	EffApplyRules:        "ApplyRules",
	EffRunProbes:         "RunProbes",
	EffCommit:            "Commit",
	EffRollback:          "Rollback",
	EffReleaseRules:      "ReleaseRules",
	EffConfirmAbsent:     "ConfirmAbsent",
	EffDisarmProvisional: "DisarmProvisional",
	EffArmExpiry:         "ArmExpiry",
	EffReport:            "Report",
}

func (k EffectKind) String() string {
	if n, ok := effectNames[k]; ok {
		return n
	}
	return "Effect(?)"
}

// Effect is one instruction.
type Effect struct {
	Kind      EffectKind
	AttemptID string
	// All: DisarmProvisional removes every recovery task.
	All bool
	// Prior: Rollback re-installs the last committed rules.
	Prior bool
	// Report fields.
	State       string
	FailureCode string
	ReleaseKind string
	Refusal     wire.CommandErrorCode
	Detail      string
}

// ReportStateForKind is the reported episode state for a release kind.
func ReportStateForKind(kind string) string {
	switch kind {
	case ReleaseExpired:
		return StateExpired
	case ReleaseLocalCode, ReleaseLocalForced:
		return StateReleasedLocally
	case ReleaseDeadMan:
		return StateSelfReleased
	}
	return StateReleased
}

func validReleaseKind(kind string) bool {
	switch kind {
	case ReleaseConsole, ReleaseAI, ReleaseExpired, ReleaseDeadMan, ReleaseLocalCode, ReleaseLocalForced, ReleaseUninstall, ReleaseSystem:
		return true
	}
	return false
}

func refuse(code wire.CommandErrorCode, detail string) []Effect {
	return []Effect{{Kind: EffReport, Refusal: code, Detail: detail}}
}

func laterOf(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func (s LocalState) facts() clockFacts {
	return clockFacts{expiresAt: s.ExpiresAt, appliedAtWall: s.AppliedAtWall, appliedAtMono: s.AppliedAtMono, bootID: s.BootID, highWaterWall: s.HighWaterWall}
}

// attemptOverdue: the attempt's window passed by the wall clock or the
// monotonic clock, or the machine rebooted since it started (a provisional
// apply is never promoted after a restart).
func (s LocalState) attemptOverdue(c Clock) bool {
	if s.AttemptID == "" {
		return false
	}
	if !c.Now().Before(s.Deadline) {
		return true
	}
	boot := c.BootID()
	if s.AttemptBootID != "" && s.AttemptBootID != boot {
		return true
	}
	return s.AttemptBootID == boot && c.Mono()-s.AttemptMono >= ProvisionalWindow
}

func (s LocalState) attemptLive(attemptID string) bool {
	if attemptID == "" || s.AttemptID != attemptID {
		return false
	}
	switch s.AttemptKind {
	case AttemptApply:
		return s.Phase == journal.PhaseProvisional
	case AttemptRefresh:
		return s.Phase == journal.PhaseCommitted
	}
	return false
}

func (s *LocalState) clearAttempt() {
	s.AttemptID, s.AttemptKind, s.Deadline, s.AttemptBootID, s.AttemptMono, s.ProbesPassed = "", "", time.Time{}, "", 0, false
}

// Step is the pure transition function. It never panics, never performs I/O
// and reads time only through c. The manager persists the returned state
// (journal + fsync) before it executes any returned effect, executes effects
// in order, and feeds each decision or failure back in as the next event.
func Step(cur LocalState, ev Event, c Clock) (LocalState, []Effect) {
	switch ev.Kind {
	case EvIsolate:
		return stepIsolate(cur, ev, c)
	case EvRefresh:
		if cur.Phase != journal.PhaseCommitted || cur.AttemptID != "" || ev.AttemptID == "" {
			return cur, nil
		}
		next := cur
		next.AttemptID, next.AttemptKind, next.ProbesPassed = ev.AttemptID, AttemptRefresh, false
		next.Deadline = c.Now().Add(ProvisionalWindow)
		next.AttemptBootID, next.AttemptMono = c.BootID(), c.Mono()
		return next, []Effect{{Kind: EffApplyRules, AttemptID: ev.AttemptID}, {Kind: EffRunProbes, AttemptID: ev.AttemptID}}
	case EvProbesPassed:
		if !cur.attemptLive(ev.AttemptID) {
			return cur, nil
		}
		next := cur
		next.ProbesPassed = true
		return next, []Effect{{Kind: EffCommit, AttemptID: ev.AttemptID}}
	case EvCommitReady:
		return stepCommit(cur, ev, c)
	case EvAttemptFailed:
		return stepAttemptFailed(cur, ev.AttemptID, ev.Code, ev.Err)
	case EvRelease:
		return stepRelease(cur, ev)
	case EvReleaseFailed:
		if cur.Phase != journal.PhaseReleasing && !cur.RulesMayExist {
			return cur, nil
		}
		return cur, []Effect{{Kind: EffReport, State: cur.State, Detail: "cleanup failed: " + ev.Err}}
	case EvAbsentConfirmed:
		return stepAbsent(cur)
	case EvTick:
		return stepTick(cur, c)
	}
	return cur, nil
}

func stepIsolate(cur LocalState, ev Event, c Clock) (LocalState, []Effect) {
	now := c.Now()
	switch {
	case ev.IsolationID == "" || ev.Generation < 1:
		return cur, refuse(wire.ErrCodeIsolationInvalidSpec, "isolationId and generation >= 1 are required")
	case ev.AttemptID == "":
		return cur, refuse(wire.ErrCodeIsolationInvalidSpec, "no attempt id")
	case !now.Before(ev.ExpiresAt):
		return cur, refuse(wire.ErrCodeIsolationInvalidSpec, "expiresAt is not in the future")
	}

	switch cur.Phase {
	case journal.PhaseProvisional, journal.PhaseReleasing:
		return cur, refuse(wire.ErrCodeIsolationBusy, "another apply or release is in progress")
	case journal.PhaseCommitted:
		switch {
		case ev.IsolationID != cur.IsolationID:
			return cur, refuse(wire.ErrCodeIsolationEpisodeMismatch, "a different episode is applied")
		case ev.Generation < cur.Generation:
			return cur, refuse(wire.ErrCodeIsolationStaleGeneration, "older generation than the applied one")
		case cur.AttemptID != "":
			return cur, refuse(wire.ErrCodeIsolationBusy, "a refresh is in progress")
		case ev.Generation == cur.Generation:
			return cur, []Effect{{Kind: EffReport, State: StateVerified}}
		}
		// Extend: a newer generation of the applied episode. The rules do not
		// encode expiry, so only the expiry task moves.
		next := cur
		next.Generation, next.ExpiresAt = ev.Generation, ev.ExpiresAt
		return next, []Effect{{Kind: EffArmExpiry}, {Kind: EffReport, State: StateVerified}}
	case journal.PhaseReleased, journal.PhaseRolledBack:
		if ev.IsolationID == cur.IsolationID {
			// Local terminal state wins: a human must start a new episode.
			return cur, refuse(wire.ErrCodeIsolationStaleGeneration, "this episode already ended on the device")
		}
	}
	if cur.RulesMayExist {
		return cur, refuse(wire.ErrCodeIsolationBusy, "Breeze-owned rules are awaiting cleanup")
	}

	next := LocalState{
		Phase:         journal.PhaseProvisional,
		IsolationID:   ev.IsolationID,
		Generation:    ev.Generation,
		ExpiresAt:     ev.ExpiresAt,
		AttemptID:     ev.AttemptID,
		AttemptKind:   AttemptApply,
		Deadline:      now.Add(ProvisionalWindow),
		AttemptBootID: c.BootID(),
		AttemptMono:   c.Mono(),
		RulesMayExist: true,
		HighWaterWall: laterOf(cur.HighWaterWall, now),
		State:         StateApplying,
	}
	return next, []Effect{
		{Kind: EffArmProvisional, AttemptID: ev.AttemptID},
		{Kind: EffArmExpiry},
		{Kind: EffApplyRules, AttemptID: ev.AttemptID},
		{Kind: EffRunProbes, AttemptID: ev.AttemptID},
	}
}

func stepCommit(cur LocalState, ev Event, c Clock) (LocalState, []Effect) {
	if !cur.attemptLive(ev.AttemptID) || !cur.ProbesPassed {
		return cur, nil
	}
	if cur.attemptOverdue(c) {
		return stepAttemptFailed(cur, ev.AttemptID, FailControlPlaneUnreachable, "verification finished after the provisional deadline")
	}
	next := cur
	attempt := cur.AttemptID
	kind := cur.AttemptKind
	next.clearAttempt()
	next.State, next.FailureCode = StateVerified, ""
	if kind == AttemptRefresh {
		return next, []Effect{{Kind: EffReport, State: StateVerified}}
	}
	now := c.Now()
	next.Phase = journal.PhaseCommitted
	next.AppliedAtWall, next.AppliedAtMono, next.BootID = now, c.Mono(), c.BootID()
	next.HighWaterWall = laterOf(next.HighWaterWall, now)
	return next, []Effect{{Kind: EffDisarmProvisional, AttemptID: attempt}, {Kind: EffReport, State: StateVerified}}
}

func stepAttemptFailed(cur LocalState, attemptID, code, detail string) (LocalState, []Effect) {
	if !cur.attemptLive(attemptID) {
		return cur, nil
	}
	if code == "" {
		code = FailApplyError
	}
	next := cur
	if cur.AttemptKind == AttemptRefresh {
		next.clearAttempt()
		return next, []Effect{
			{Kind: EffRollback, AttemptID: attemptID, Prior: true},
			{Kind: EffReport, State: StateVerified, Detail: "refresh failed (" + code + "); restored the last verified rules: " + detail},
		}
	}
	next.Phase = journal.PhaseReleasing
	next.ProbesPassed = false
	next.Release = ReleaseIntent{Rollback: true, FailureCode: code}
	return next, []Effect{{Kind: EffRollback, AttemptID: attemptID}, {Kind: EffConfirmAbsent}}
}

func stepRelease(cur LocalState, ev Event) (LocalState, []Effect) {
	if !validReleaseKind(ev.ReleaseKind) {
		return cur, refuse(wire.ErrCodeIsolationInvalidSpec, "unknown release kind")
	}
	removal := []Effect{{Kind: EffReleaseRules}, {Kind: EffConfirmAbsent}}

	// Orphan rules with nothing journalled (a lost or corrupt journal): only
	// a system release with no episode id may clean them up.
	if cur.Phase == journal.PhaseNone || cur.Phase == journal.PhaseReleased || cur.Phase == journal.PhaseRolledBack {
		if cur.RulesMayExist && ev.IsolationID == "" && ev.ReleaseKind == ReleaseSystem {
			next := cur
			next.Phase = journal.PhaseReleasing
			next.Release = ReleaseIntent{Kind: ReleaseSystem}
			next.clearAttempt()
			return next, removal
		}
	}

	id := ev.IsolationID
	if id == "" && ev.ReleaseKind == ReleaseSystem {
		id = cur.IsolationID // release whatever is journalled
	}
	if id == "" || id != cur.IsolationID {
		return cur, refuse(wire.ErrCodeIsolationEpisodeMismatch, "this device does not hold that episode")
	}
	gen := ev.Generation
	if gen == 0 {
		gen = cur.Generation
	}

	switch cur.Phase {
	case journal.PhaseProvisional, journal.PhaseCommitted, journal.PhaseReleasing:
		if gen < cur.Generation {
			return cur, refuse(wire.ErrCodeIsolationStaleGeneration, "older generation than the journalled one")
		}
		next := cur
		next.Phase = journal.PhaseReleasing
		next.Generation = gen
		next.Release = ReleaseIntent{Kind: ev.ReleaseKind}
		next.RulesMayExist = true
		// Clearing the attempt fences any worker still probing.
		next.clearAttempt()
		return next, removal
	case journal.PhaseReleased, journal.PhaseRolledBack:
		// Already confirmed absent: report the outcome again.
		return cur, []Effect{{Kind: EffReport, State: cur.State, FailureCode: cur.FailureCode, ReleaseKind: cur.ReleaseKind}}
	}
	return cur, refuse(wire.ErrCodeIsolationEpisodeMismatch, "this device does not hold that episode")
}

func stepAbsent(cur LocalState) (LocalState, []Effect) {
	if cur.Phase != journal.PhaseReleasing {
		return cur, nil
	}
	next := cur
	next.RulesMayExist = false
	next.clearAttempt()
	disarm := Effect{Kind: EffDisarmProvisional, All: true}
	if cur.Release.Rollback {
		next.Phase = journal.PhaseRolledBack
		next.State, next.FailureCode, next.ReleaseKind = StateFailed, cur.Release.FailureCode, ""
		return next, []Effect{disarm, {Kind: EffReport, State: StateFailed, FailureCode: cur.Release.FailureCode}}
	}
	kind := cur.Release.Kind
	next.Phase = journal.PhaseReleased
	if cur.IsolationID == "" {
		next.Phase = journal.PhaseNone
	}
	next.State, next.FailureCode, next.ReleaseKind = ReportStateForKind(kind), "", kind
	return next, []Effect{disarm, {Kind: EffReport, State: next.State, ReleaseKind: kind}}
}

func stepTick(cur LocalState, c Clock) (LocalState, []Effect) {
	now := c.Now()
	next := cur
	next.HighWaterWall = laterOf(cur.HighWaterWall, now)

	switch cur.Phase {
	case journal.PhaseProvisional:
		if cur.attemptOverdue(c) {
			return stepAttemptFailed(next, cur.AttemptID, FailControlPlaneUnreachable, "provisional apply was not committed in time")
		}
		if exp, _ := expired(cur.facts(), c); exp {
			return stepAttemptFailed(next, cur.AttemptID, FailControlPlaneUnreachable, "episode expired before it was verified")
		}
		return next, nil
	case journal.PhaseCommitted:
		if exp, _ := expired(cur.facts(), c); exp {
			next.Phase = journal.PhaseReleasing
			next.Release = ReleaseIntent{Kind: ReleaseExpired}
			next.clearAttempt()
			return next, []Effect{{Kind: EffReleaseRules}, {Kind: EffConfirmAbsent}}
		}
		if cur.AttemptID != "" && cur.attemptOverdue(c) {
			return stepAttemptFailed(next, cur.AttemptID, FailControlPlaneUnreachable, "refresh was not committed in time")
		}
		if cur.BootID != c.BootID() {
			// New boot, not expired: re-anchor the monotonic clause.
			next.AppliedAtWall, next.AppliedAtMono, next.BootID = now, c.Mono(), c.BootID()
		}
		return next, nil
	case journal.PhaseReleasing:
		if cur.Release.Rollback {
			return next, []Effect{{Kind: EffRollback, AttemptID: cur.AttemptID}, {Kind: EffConfirmAbsent}}
		}
		return next, []Effect{{Kind: EffReleaseRules}, {Kind: EffConfirmAbsent}}
	}
	if cur.RulesMayExist {
		return stepRelease(next, Event{Kind: EvRelease, ReleaseKind: ReleaseSystem})
	}
	return next, nil
}
