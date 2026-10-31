package isolation

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/wire"
)

var log = logging.L("isolation")

const (
	// ReverifyInterval is the steady-state re-verify cadence (plus resume
	// and network change).
	ReverifyInterval = 5 * time.Minute
	// MaxTTL is the longest an episode may run (OD5: 30 days).
	MaxTTL = 720 * time.Hour
	// BreakGlassAttemptsPerHour caps offline code attempts.
	BreakGlassAttemptsPerHour = 5
	// maxAllowEntries mirrors NETWORK_ISOLATION_LIMITS.maxAllowEntries.
	maxAllowEntries = 64
	// expirySlack tolerates server/agent clock skew on the 720 h ceiling.
	expirySlack = 5 * time.Minute
)

var (
	// ErrNoActiveIsolation: LocalRelease with nothing isolated.
	ErrNoActiveIsolation = errors.New("no network isolation is active on this device")
	// ErrBreakGlassInvalid: the code matches none of the accepted hour buckets.
	ErrBreakGlassInvalid = errors.New("break-glass code is not valid")
	// ErrBreakGlassRateLimited: more than BreakGlassAttemptsPerHour attempts.
	ErrBreakGlassRateLimited = errors.New("too many break-glass attempts in the last hour; wait, or use --force")
	// ErrBreakGlassUnavailable: the active episode has no secret on this device.
	ErrBreakGlassUnavailable = errors.New("this device has no break-glass secret for the active isolation; use --force")
	// errCrashedOp is returned when a test's crash injection stopped an op.
	errCrashedOp = errors.New("operation stopped before completing")
)

// ManagerDeps are the Manager's collaborators. Everything is injected so the
// whole protocol runs against fakes; the heartbeat wiring (W1e) passes the
// real ones.
type ManagerDeps struct {
	Isolator Isolator
	// Scheduler arms the recovery tasks; Scheduler.Ready reports recovery
	// readiness (self-test passed, tasks registered and read back).
	Scheduler RecoveryScheduler
	DataDir   string
	Resolver  *Resolver
	// VerifyRoundTrip is the positive probe: a fresh authenticated round trip
	// (NewHTTPVerifier) returning the server's time.
	VerifyRoundTrip func(ctx context.Context, isolationID string) (serverTime time.Time, err error)
	Clock           Clock
	// Dialer dials the negative probe.
	Dialer Dialer
	// Proxy is the transport's effective proxy for the control plane
	// (http.ProxyFromEnvironment, as heartbeat.go keeps it); nil URL = none.
	Proxy func() (*url.URL, error)
}

// Manager runs the isolation protocol on this device. All of its operations
// serialise on one in-process mutex and the machine-wide journal lock; both
// are dropped while probes run, so a release (or the recovery binary) can
// always get in, and the probing worker re-checks everything when it returns.
type Manager struct {
	deps ManagerDeps

	opMu sync.Mutex

	snapMu sync.RWMutex
	snap   *journal.Journal

	lastReverify  time.Time // guarded by opMu
	forceReverify atomic.Bool

	negativeTimeout  time.Duration
	probeBudget      time.Duration
	reverifyInterval time.Duration

	// expiryUnarmed is true after an ArmExpiry failure on a committed episode;
	// the next Tick retries it. Guarded by opMu.
	expiryUnarmed bool

	// Test seams.
	beforeEffect func(Effect) error
	onPersist    func(*journal.Journal)
	saveJournal  func(path string, j *journal.Journal) error
}

// NewManager builds a Manager. It reads the journal for Report and Active but
// touches nothing else until an operation runs.
func NewManager(deps ManagerDeps) *Manager {
	if deps.Clock == nil {
		deps.Clock = SystemClock()
	}
	if deps.Resolver == nil {
		deps.Resolver = NewResolver(nil)
	}
	if deps.Dialer == nil {
		deps.Dialer = &net.Dialer{}
	}
	if deps.Proxy == nil {
		deps.Proxy = func() (*url.URL, error) { return nil, nil }
	}
	if deps.Isolator == nil {
		deps.Isolator = unsupportedIsolator{}
	}
	if deps.Scheduler == nil {
		deps.Scheduler = unsupportedScheduler{}
	}
	m := &Manager{
		deps:             deps,
		negativeTimeout:  NegativeProbeTimeout,
		probeBudget:      ProbeBudget,
		reverifyInterval: ReverifyInterval,
		saveJournal:      journal.Save,
	}
	if j, err := journal.Load(m.path()); err == nil {
		m.setSnapshot(j)
	}
	return m
}

func (m *Manager) path() string { return journal.Path(m.deps.DataDir) }

func (m *Manager) setSnapshot(j *journal.Journal) {
	c := j.Clone()
	m.snapMu.Lock()
	m.snap = c
	m.snapMu.Unlock()
}

func (m *Manager) snapshot() *journal.Journal {
	m.snapMu.RLock()
	defer m.snapMu.RUnlock()
	return m.snap
}

func activePhase(p journal.Phase) bool {
	return p == journal.PhaseProvisional || p == journal.PhaseCommitted || p == journal.PhaseReleasing
}

// Active reports whether Breeze-owned rules are (or may be) installed.
func (m *Manager) Active() bool {
	s := m.snapshot()
	return s != nil && activePhase(s.Phase)
}

// Report is the heartbeat's containment.networkIsolation report. It never
// carries the break-glass secret. It is always one of the two shapes the
// server accepts (networkIsolationReportSchema): an episode report, or the
// "nothing Breeze-owned is installed" form (no isolationId, phase none). It
// returns nil when neither is true — rules are being removed that belong to
// no journalled episode (an orphan cleanup) — and the caller omits the field
// rather than claim absence before it is confirmed.
func (m *Manager) Report() *Report {
	s := m.snapshot()
	if s == nil {
		return &Report{Phase: journal.PhaseNone}
	}
	if ep := s.Episode; ep == nil || ep.IsolationID == "" || ep.Generation < 1 || !reportableState(ep.State) {
		if activePhase(s.Phase) {
			return nil
		}
		r := &Report{JournalSeq: s.LastSeq(), Phase: journal.PhaseNone}
		if len(s.Events) > 0 {
			r.Events = append([]ReportEvent(nil), s.Events...)
		}
		return r
	}
	r := &Report{JournalSeq: s.LastSeq(), Phase: s.Phase}
	if len(s.Events) > 0 {
		r.Events = append([]ReportEvent(nil), s.Events...)
	}
	if s.SecretAckSeq > 0 {
		v := s.SecretAckSeq
		r.SecretAckSeq = &v
	}
	if ep := s.Episode; ep != nil {
		r.IsolationID, r.Generation, r.State = ep.IsolationID, ep.Generation, ep.State
		r.Mechanism, r.RuleDigest, r.LastError = ep.Mechanism, ep.RuleDigest, ep.LastError
		if !ep.AppliedAt.IsZero() {
			t := ep.AppliedAt
			r.AppliedAt = &t
		}
		if !ep.LastVerifiedAt.IsZero() {
			t := ep.LastVerifiedAt
			r.LastVerifiedAt = &t
		}
	}
	return r
}

// ---------------------------------------------------------------------------
// Operations

// attemptCtx is the in-memory half of an attempt: what is being installed.
// It lives only inside the operation that started the attempt.
type attemptCtx struct {
	id         string
	kind       AttemptKind
	allow      []AllowEntry
	proxy      *AllowEntry
	spec       ResolvedSpec
	resolved   map[string][]string
	digest     Digest
	serverTime time.Time
	drift      bool
}

// op is one locked operation.
type op struct {
	m      *Manager
	ctx    context.Context
	unlock func()

	j       *journal.Journal
	state   LocalState
	missing bool

	cap        Capability
	attempt    *attemptCtx
	newEpisode *journal.EpisodeRecord

	report        *Effect
	failDetail    string
	cleanupFailed bool
	crashed       bool
	lockLost      bool
	dirty         bool
}

func (m *Manager) begin(ctx context.Context) (*op, error) {
	m.opMu.Lock()
	unlock, err := journal.Lock(m.deps.DataDir)
	if err != nil {
		m.opMu.Unlock()
		return nil, err
	}
	o := &op{m: m, ctx: ctx, unlock: unlock}
	if err := o.load(); err != nil {
		o.end()
		return nil, err
	}
	return o, nil
}

func (o *op) end() {
	if o.dirty && !o.crashed && !o.lockLost && o.unlock != nil {
		if err := o.save(); err != nil {
			log.Warn("isolation journal write failed", "error", err.Error())
		}
	}
	if o.unlock != nil {
		o.unlock()
		o.unlock = nil
	}
	o.m.opMu.Unlock()
}

func (o *op) now() time.Time { return o.m.deps.Clock.Now() }

// load reads the journal into the op. A missing journal is an empty one; a
// corrupt or unknown-schema journal is set aside and replaced by an empty
// one whose rules must all be deleted.
func (o *op) load() error {
	j, err := journal.Load(o.m.path())
	switch {
	case err == nil:
		o.j, o.missing = j, false
		o.state = stateFromJournal(j)
	case errors.Is(err, journal.ErrNotFound):
		o.j, o.missing = journal.New(), true
		o.state = stateFromJournal(o.j)
	case errors.Is(err, journal.ErrCorrupt) || errors.Is(err, journal.ErrUnknownSchema):
		log.Warn("isolation journal unreadable; deleting every Breeze-owned rule", "error", err.Error())
		if rerr := os.Rename(o.m.path(), o.m.path()+".corrupt"); rerr != nil {
			log.Warn("could not set the unreadable isolation journal aside; it will be overwritten", "error", rerr.Error())
		}
		o.j, o.missing = journal.New(), false
		o.j.Append(o.now(), "journal_reset", "", 0, truncate(err.Error(), 300))
		o.state = stateFromJournal(o.j)
		o.state.RulesMayExist = true
	default:
		return err
	}
	if ep := o.j.Episode; ep != nil {
		for host, list := range ep.Resolved {
			o.m.deps.Resolver.Seed(host, parseAddrs(list))
		}
	}
	if !o.missing {
		o.m.setSnapshot(o.j)
	}
	return nil
}

// cleanupOrphans deletes Breeze-owned rules that no journalled episode
// accounts for: after a corrupt journal, or (checkOwned) when the journal is
// missing or terminal but the isolator still owns rules.
func (o *op) cleanupOrphans(checkOwned bool) {
	if checkOwned && !o.state.RulesMayExist && !activePhase(o.state.Phase) && o.cap.Version >= 1 {
		owned, err := o.m.deps.Isolator.Owned(o.ctx)
		if err != nil {
			log.Warn("could not check for Breeze-owned isolation rules", "error", err.Error())
		}
		if err == nil && owned {
			log.Warn("Breeze-owned isolation rules found with no active episode; deleting them")
			o.j.Append(o.now(), "orphan_rules", "", 0, "")
			o.state.RulesMayExist = true
		}
	}
	if o.state.RulesMayExist && !activePhase(o.state.Phase) {
		o.run(Event{Kind: EvRelease, ReleaseKind: ReleaseSystem})
	}
}

// run feeds ev to Step, persists, executes effects, and loops on the follow-up
// event until the protocol is quiescent.
func (o *op) run(ev Event) {
	for steps := 0; ev.Kind != 0 && steps < 64; steps++ {
		if ev.Kind == EvAttemptFailed && ev.Err != "" {
			o.failDetail = ev.Err
		}
		next, effects := Step(o.state, ev, o.m.deps.Clock)
		if err := o.persist(next, ev, effects); err != nil {
			o.journalWriteFailed(err)
			return
		}
		ev = Event{}
		for _, e := range effects {
			if o.m.beforeEffect != nil {
				if err := o.m.beforeEffect(e); err != nil {
					o.crashed = true
					return
				}
			}
			follow := o.exec(e)
			if o.crashed || o.lockLost {
				return
			}
			if follow.Kind != 0 {
				ev = follow
				break
			}
		}
	}
}

// journalWriteFailed: the journal cannot record the next step. Nothing past
// this point may run. Rules of an uncommitted apply are removed best-effort
// (the one-shot OS rollback would remove them at the deadline anyway); a
// committed episode is left alone (expiry and recovery still bound it).
func (o *op) journalWriteFailed(err error) {
	log.Error("isolation journal write failed", "error", err.Error())
	detail := "journal write failed: " + err.Error()
	if o.state.Phase == journal.PhaseProvisional {
		if rerr := o.m.deps.Isolator.Release(o.ctx); rerr != nil {
			log.Error("removing uncommitted isolation rules after a journal write failure also failed; the one-shot rollback is the backstop", "error", rerr.Error())
			detail += "; removing the uncommitted rules also failed: " + rerr.Error()
		}
	}
	o.report = &Effect{Kind: EffReport, Refusal: wire.ErrCodeIsolationMechanismUnavailable, Detail: detail}
}

func (o *op) attemptFailed(attemptID, code, detail string) Event {
	return Event{Kind: EvAttemptFailed, AttemptID: attemptID, Code: code, Err: detail}
}

func (o *op) noteError(msg string) {
	log.Warn("isolation: " + msg)
	if o.j.Episode != nil {
		o.j.Episode.LastError = truncate(msg, 900)
		o.dirty = true
	}
}

// armExpiry arms the expiry task for the journalled episode and ensures the
// poll. A failure is noted and remembered so the next Tick retries it.
func (o *op) armExpiry() error {
	sched := o.m.deps.Scheduler
	err := sched.ArmExpiry(o.state.IsolationID, o.state.Generation, o.state.ExpiresAt)
	if err == nil {
		err = sched.EnsurePoll()
	}
	o.m.expiryUnarmed = err != nil
	if err != nil {
		o.noteError("arm the expiry task: " + err.Error())
	}
	return err
}

func reportableState(s string) bool {
	switch s {
	case StateApplying, StateApplied, StateVerified, StateReleased, StateExpired, StateFailed, StateReleasedLocally, StateSelfReleased:
		return true
	}
	return false
}

func (o *op) exec(e Effect) Event {
	iso, sched := o.m.deps.Isolator, o.m.deps.Scheduler
	switch e.Kind {
	case EffArmProvisional:
		if err := sched.ArmProvisional(e.AttemptID, o.state.Deadline); err != nil {
			return o.attemptFailed(e.AttemptID, FailMechanismUnavailable, "arm the provisional rollback: "+err.Error())
		}
	case EffArmExpiry:
		if err := o.armExpiry(); err != nil && o.state.Phase == journal.PhaseProvisional {
			return o.attemptFailed(o.state.AttemptID, FailMechanismUnavailable, "arm the expiry task: "+err.Error())
		}
	case EffApplyRules:
		a := o.attempt
		if a == nil || a.id != e.AttemptID {
			return o.attemptFailed(e.AttemptID, FailApplyError, "no resolved rule set for the attempt")
		}
		if !o.now().Before(o.state.Deadline) {
			return o.attemptFailed(e.AttemptID, FailApplyError, "the provisional deadline passed before apply")
		}
		d, err := iso.Apply(o.ctx, a.spec)
		if err != nil {
			return o.attemptFailed(e.AttemptID, FailApplyError, "apply: "+err.Error())
		}
		a.digest = d
	case EffRunProbes:
		return o.runProbes(e.AttemptID)
	case EffCommit:
		a := o.attempt
		if a == nil || a.id != e.AttemptID {
			return o.attemptFailed(e.AttemptID, FailApplyError, "no rule set to commit")
		}
		d, err := iso.Verify(o.ctx, a.spec)
		if err != nil {
			return o.attemptFailed(e.AttemptID, FailApplyError, "verify before commit: "+err.Error())
		}
		if d != a.digest {
			return o.attemptFailed(e.AttemptID, FailApplyError, "the installed rules changed before commit")
		}
		return Event{Kind: EvCommitReady, AttemptID: e.AttemptID}
	case EffRollback:
		if e.Prior {
			prior, err := priorSpec(o.j)
			if err == nil {
				_, err = iso.Apply(o.ctx, prior)
			}
			if err != nil {
				// The engine may hold the candidate rules or a mix: re-verify on
				// the next tick rather than wait out the interval.
				o.noteError("restore the last verified rules: " + err.Error())
				o.m.forceReverify.Store(true)
			}
			return Event{}
		}
		if err := iso.Release(o.ctx); err != nil {
			o.cleanupFailed = true
			return Event{Kind: EvReleaseFailed, Err: err.Error()}
		}
	case EffReleaseRules:
		if err := iso.Release(o.ctx); err != nil {
			o.cleanupFailed = true
			return Event{Kind: EvReleaseFailed, Err: err.Error()}
		}
	case EffConfirmAbsent:
		owned, err := iso.Owned(o.ctx)
		if err != nil {
			o.cleanupFailed = true
			return Event{Kind: EvReleaseFailed, Err: "confirm absence: " + err.Error()}
		}
		if owned {
			o.cleanupFailed = true
			return Event{Kind: EvReleaseFailed, Err: "Breeze-owned rules are still installed"}
		}
		o.cleanupFailed = false
		return Event{Kind: EvAbsentConfirmed}
	case EffDisarmProvisional:
		var err error
		if e.All {
			err = sched.RemoveAll()
		} else {
			err = sched.DisarmProvisional(e.AttemptID)
		}
		if err != nil {
			o.noteError("disarm recovery tasks: " + err.Error())
		}
	case EffReport:
		r := e
		o.report = &r
	}
	return Event{}
}

// runProbes drops both locks, runs the negative then the positive probe
// within the probe budget, then retakes the locks and reloads the journal so
// the next Step decides on what is on disk now (fencing).
func (o *op) runProbes(attemptID string) Event {
	a := o.attempt
	if a == nil || a.id != attemptID {
		return o.attemptFailed(attemptID, FailApplyError, "no rule set to probe")
	}
	o.unlock()
	o.unlock = nil
	o.m.opMu.Unlock()

	ctx, cancel := context.WithTimeout(o.ctx, o.m.probeBudget)
	serverTime, probeErr := o.m.probe(ctx, a.spec)
	cancel()

	o.m.opMu.Lock()
	unlock, err := journal.Lock(o.m.deps.DataDir)
	if err != nil {
		o.lockLost = true
		o.report = &Effect{Kind: EffReport, Refusal: wire.ErrCodeIsolationBusy, Detail: "could not retake the isolation lock after probing: " + err.Error()}
		return Event{}
	}
	o.unlock = unlock
	if err := o.load(); err != nil {
		o.lockLost = true
		o.report = &Effect{Kind: EffReport, Refusal: wire.ErrCodeIsolationBusy, Detail: "reload the journal after probing: " + err.Error()}
		return Event{}
	}
	if probeErr != nil {
		return o.attemptFailed(attemptID, probeFailureCode(probeErr), probeErr.Error())
	}
	a.serverTime = serverTime
	return Event{Kind: EvProbesPassed, AttemptID: attemptID}
}

func (m *Manager) probe(ctx context.Context, spec ResolvedSpec) (time.Time, error) {
	target, err := negativeProbeTarget(spec)
	if err != nil {
		return time.Time{}, errNegative("%v", err)
	}
	if err := negativeProbe(ctx, m.deps.Dialer, m.deps.Isolator, target, m.negativeTimeout); err != nil {
		return time.Time{}, err
	}
	if m.deps.VerifyRoundTrip == nil {
		return time.Time{}, errPositive("no verify round trip configured")
	}
	serverTime, err := m.deps.VerifyRoundTrip(ctx, spec.IsolationID)
	if err != nil {
		return time.Time{}, errPositive("%v", err)
	}
	return serverTime, nil
}

// ---------------------------------------------------------------------------
// Journal mapping

func stateFromJournal(j *journal.Journal) LocalState {
	s := LocalState{
		Phase:         j.Phase,
		AttemptID:     j.AttemptID,
		Deadline:      j.ProvisionalDeadline,
		AttemptBootID: j.AttemptBootID,
		AttemptMono:   time.Duration(j.AttemptMono),
		AppliedAtWall: j.AppliedAtWall,
		AppliedAtMono: time.Duration(j.AppliedAtMono),
		BootID:        j.BootID,
		HighWaterWall: j.HighWaterWall,
	}
	ep := j.Episode
	if ep != nil {
		s.IsolationID, s.Generation, s.ExpiresAt = ep.IsolationID, ep.Generation, ep.ExpiresAt
		s.State, s.FailureCode, s.ReleaseKind = ep.State, ep.FailureCode, ep.ReleaseKind
	}
	switch j.Phase {
	case journal.PhaseProvisional:
		s.AttemptKind, s.RulesMayExist = AttemptApply, true
	case journal.PhaseCommitted:
		s.RulesMayExist = true
		if s.AttemptID != "" {
			s.AttemptKind = AttemptRefresh
		}
	case journal.PhaseReleasing:
		s.RulesMayExist = true
		switch {
		case ep == nil:
			s.Release = ReleaseIntent{Kind: ReleaseSystem}
		case ep.RollbackCode != "":
			s.Release = ReleaseIntent{Rollback: true, FailureCode: ep.RollbackCode}
			if s.AttemptID != "" {
				s.AttemptKind = AttemptApply
			}
		default:
			kind := ep.ReleaseKind
			if kind == "" {
				kind = ReleaseSystem
			}
			s.Release = ReleaseIntent{Kind: kind}
		}
	}
	return s
}

func toJournal(j *journal.Journal, s LocalState, newEp *journal.EpisodeRecord) {
	j.Phase = s.Phase
	if s.IsolationID == "" {
		j.Episode = nil
	} else {
		if j.Episode == nil || j.Episode.IsolationID != s.IsolationID {
			if newEp != nil && newEp.IsolationID == s.IsolationID {
				c := *newEp
				j.Episode = &c
			} else {
				j.Episode = &journal.EpisodeRecord{IsolationID: s.IsolationID}
			}
		}
		ep := j.Episode
		ep.Generation, ep.ExpiresAt = s.Generation, s.ExpiresAt
		ep.State, ep.FailureCode, ep.ReleaseKind, ep.RollbackCode = s.State, s.FailureCode, s.ReleaseKind, ""
		if s.Phase == journal.PhaseReleasing {
			if s.Release.Rollback {
				ep.RollbackCode, ep.ReleaseKind = s.Release.FailureCode, ""
			} else {
				ep.ReleaseKind = s.Release.Kind
			}
		}
	}
	j.AttemptID, j.ProvisionalDeadline = s.AttemptID, s.Deadline
	j.AttemptBootID, j.AttemptMono = s.AttemptBootID, int64(s.AttemptMono)
	j.AppliedAtWall, j.AppliedAtMono, j.BootID = s.AppliedAtWall, int64(s.AppliedAtMono), s.BootID
	j.HighWaterWall = s.HighWaterWall
}

func sameJournalState(a, b LocalState) bool {
	a.ProbesPassed, b.ProbesPassed = false, false
	return reflect.DeepEqual(a, b)
}

type pendingEvent struct {
	typ, id string
	gen     int
	detail  string
}

// transitionEvents names what happened for the local event log. Terminal
// classification is in the type (`failed_<code>`, `released_<kind>`) so the
// server never parses prose.
func transitionEvents(cur, next LocalState, ev Event, effects []Effect, a *attemptCtx) []pendingEvent {
	id, gen := next.IsolationID, next.Generation
	var out []pendingEvent
	add := func(typ, detail string) { out = append(out, pendingEvent{typ, id, gen, detail}) }
	switch {
	case next.Phase == journal.PhaseProvisional && cur.Phase != journal.PhaseProvisional:
		add("provisional", "")
	case next.Phase == journal.PhaseCommitted && cur.Phase == journal.PhaseProvisional:
		add("committed", "")
	case next.Phase == journal.PhaseCommitted && cur.Phase == journal.PhaseCommitted:
		if next.Generation > cur.Generation {
			add("extended", next.ExpiresAt.UTC().Format(time.RFC3339))
		}
		if cur.AttemptID != "" && next.AttemptID == "" {
			if hasRollback(effects) {
				add("refresh_reverted", ev.Code)
			} else if ev.Kind == EvCommitReady {
				if a != nil && a.drift {
					add("drift_reapplied", "")
				} else {
					add("refreshed", "")
				}
			}
		}
	case next.Phase == journal.PhaseReleasing && (cur.Phase != journal.PhaseReleasing || cur.Release != next.Release):
		if next.Release.Rollback {
			add("releasing", "rollback:"+next.Release.FailureCode)
		} else {
			add("releasing", next.Release.Kind)
		}
	case next.Phase == journal.PhaseRolledBack && cur.Phase == journal.PhaseReleasing:
		add("rolled_back", "")
		add("failed_"+next.FailureCode, "")
	case (next.Phase == journal.PhaseReleased || next.Phase == journal.PhaseNone) && cur.Phase == journal.PhaseReleasing:
		if next.Phase == journal.PhaseNone {
			id, gen = cur.IsolationID, cur.Generation
		}
		add("released_"+next.ReleaseKind, "")
	}
	if ev.Kind == EvReleaseFailed {
		add("cleanup_failed", truncate(ev.Err, 400))
	}
	return out
}

func hasRollback(effects []Effect) bool {
	for _, e := range effects {
		if e.Kind == EffRollback {
			return true
		}
	}
	return false
}

// persist writes the transition to the journal (fsynced) before any effect
// runs. A transition that changes nothing the journal records only updates
// the in-memory state.
func (o *op) persist(next LocalState, ev Event, effects []Effect) error {
	a := o.attempt
	commitOf := ev.Kind == EvCommitReady && a != nil && a.id == ev.AttemptID && next.AttemptID == "" && o.state.AttemptID == ev.AttemptID && !hasRollback(effects)
	if commitOf && !a.serverTime.IsZero() {
		next.HighWaterWall = laterOf(next.HighWaterWall, a.serverTime)
	}
	events := transitionEvents(o.state, next, ev, effects, a)
	newSecret := next.Phase == journal.PhaseProvisional && o.state.Phase != journal.PhaseProvisional &&
		o.newEpisode != nil && o.newEpisode.IsolationID == next.IsolationID && len(o.newEpisode.BreakGlassSecret) == breakGlassSecretBytes
	if sameJournalState(o.state, next) && len(events) == 0 && !commitOf {
		o.state = next
		return nil
	}

	j := o.j.Clone()
	toJournal(j, next, o.newEpisode)
	now := o.now()
	var terminalSeq int64
	for _, pe := range events {
		seq := j.Append(now, pe.typ, pe.id, pe.gen, pe.detail)
		if strings.HasPrefix(pe.typ, "failed_") || strings.HasPrefix(pe.typ, "released_") {
			terminalSeq = seq
		}
	}
	if newSecret {
		j.SecretAckSeq = j.Append(now, "secret_received", next.IsolationID, next.Generation, "")
		j.PendingReport = nil
	}
	if ep := j.Episode; commitOf && ep != nil {
		ep.RuleDigest = string(a.digest)
		ep.Resolved = a.resolved
		ep.Allow = a.allow
		ep.Proxy = a.proxy
		ep.Mechanism = o.cap.Mechanism
		ep.LastError = ""
		verifiedAt := now
		if !a.serverTime.IsZero() {
			verifiedAt = a.serverTime
		}
		ep.LastVerifiedAt = verifiedAt
		if a.kind == AttemptApply {
			ep.AppliedAt = now
		}
	}
	if terminalSeq > 0 && (next.Phase == journal.PhaseReleased || next.Phase == journal.PhaseRolledBack) {
		j.PendingReport = &journal.TerminalReceipt{
			IsolationID: next.IsolationID, Generation: next.Generation, State: next.State,
			Kind: next.ReleaseKind, FailureCode: next.FailureCode, At: now, JournalSeq: terminalSeq,
		}
	}
	if err := o.m.saveJournal(o.m.path(), j); err != nil {
		return err
	}
	o.j, o.state, o.missing, o.dirty = j, next, false, false
	if commitOf {
		o.m.lastReverify = now
	}
	o.m.setSnapshot(j)
	if o.m.onPersist != nil {
		o.m.onPersist(j)
	}
	return nil
}

func (o *op) save() error {
	if err := o.m.saveJournal(o.m.path(), o.j); err != nil {
		return err
	}
	o.missing, o.dirty = false, false
	o.m.setSnapshot(o.j)
	if o.m.onPersist != nil {
		o.m.onPersist(o.j)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Resolution

func hostPrefix(a netip.Addr) netip.Prefix {
	return netip.PrefixFrom(a, a.BitLen())
}

func parseAddrs(list []string) []netip.Addr {
	out := make([]netip.Addr, 0, len(list))
	for _, s := range list {
		if a, err := netip.ParseAddr(s); err == nil {
			out = append(out, a)
		}
	}
	return out
}

func entryPrefixes(e AllowEntry, resolved map[string][]netip.Addr) ([]netip.Prefix, error) {
	if e.Kind == KindCIDR {
		p, err := netip.ParsePrefix(e.CIDR)
		if err != nil {
			return nil, fmt.Errorf("bad cidr %q: %w", e.CIDR, err)
		}
		return []netip.Prefix{p.Masked()}, nil
	}
	addrs := resolved[normaliseHost(e.Host)]
	if len(addrs) == 0 {
		return nil, fmt.Errorf("no addresses for %s", e.Host)
	}
	out := make([]netip.Prefix, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, hostPrefix(a))
	}
	return out, nil
}

// buildSpec turns the allowlist (plus the proxy entry) into numeric permits.
func buildSpec(id string, gen int, relay bool, allow []AllowEntry, proxy *AllowEntry, resolved map[string][]netip.Addr) (ResolvedSpec, error) {
	spec := ResolvedSpec{IsolationID: id, Generation: gen, RemoteRelay: relay}
	entries := append([]AllowEntry(nil), allow...)
	for i, e := range entries {
		prefixes, err := entryPrefixes(e, resolved)
		if err != nil {
			return ResolvedSpec{}, err
		}
		spec.Entries = append(spec.Entries, ResolvedEntry{AllowEntry: entries[i], Addrs: prefixes})
	}
	if proxy != nil {
		prefixes, err := entryPrefixes(*proxy, resolved)
		if err != nil {
			return ResolvedSpec{}, fmt.Errorf("proxy: %w", err)
		}
		spec.Entries = append(spec.Entries, ResolvedEntry{AllowEntry: *proxy, Addrs: prefixes, Proxy: true})
	}
	return spec, nil
}

// priorSpec rebuilds the committed rule set from the journal.
func priorSpec(j *journal.Journal) (ResolvedSpec, error) {
	ep := j.Episode
	if ep == nil {
		return ResolvedSpec{}, errors.New("no journalled episode")
	}
	resolved := map[string][]netip.Addr{}
	for host, list := range ep.Resolved {
		resolved[host] = parseAddrs(list)
	}
	return buildSpec(ep.IsolationID, ep.Generation, ep.RemoteRelay, ep.Allow, ep.Proxy, resolved)
}

// proxyEntry is the transport's effective proxy as a Breeze-scoped permit
// (spec §3.4 baseline row: Breeze processes only).
func (m *Manager) proxyEntry() (*AllowEntry, error) {
	u, err := m.deps.Proxy()
	if err != nil {
		return nil, fmt.Errorf("read the effective proxy: %w", err)
	}
	if u == nil {
		return nil, nil
	}
	host := normaliseHost(u.Hostname())
	if host == "" {
		return nil, fmt.Errorf("proxy URL %q has no host", u.Redacted())
	}
	port := u.Port()
	if port == "" {
		switch strings.ToLower(u.Scheme) {
		case "https":
			port = "443"
		case "socks5", "socks5h", "socks":
			port = "1080"
		default:
			port = "80"
		}
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return nil, fmt.Errorf("proxy port %q is not valid", port)
	}
	e := &AllowEntry{Proto: ProtoTCP, Ports: []uint16{uint16(p)}, Scope: ScopeBreeze}
	if a, err := netip.ParseAddr(host); err == nil {
		e.Kind, e.CIDR = KindCIDR, hostPrefix(a.Unmap()).String()
	} else {
		e.Kind, e.Host = KindHost, host
	}
	return e, nil
}

// resolveAttempt resolves the allowlist and proxy into a candidate rule set.
func (o *op) resolveAttempt(id string, gen int, relay bool, allow []AllowEntry) (*attemptCtx, error) {
	proxy, err := o.m.proxyEntry()
	if err != nil {
		return nil, err
	}
	var hosts []string
	for _, e := range allow {
		if e.Kind == KindHost {
			hosts = append(hosts, e.Host)
		}
	}
	if proxy != nil && proxy.Kind == KindHost {
		hosts = append(hosts, proxy.Host)
	}
	res, err := o.m.deps.Resolver.Resolve(o.ctx, hosts)
	if err != nil {
		return nil, err
	}
	spec, err := buildSpec(id, gen, relay, allow, proxy, res)
	if err != nil {
		return nil, err
	}
	resolved := make(map[string][]string, len(res))
	for host, list := range res {
		if _, err := netip.ParseAddr(host); err == nil {
			continue // literals need no journalling
		}
		strs := make([]string, 0, len(list))
		for _, a := range list {
			strs = append(strs, a.String())
		}
		resolved[host] = strs
	}
	return &attemptCtx{id: newAttemptID(), allow: append([]AllowEntry(nil), allow...), proxy: proxy, spec: spec, resolved: resolved}, nil
}

func newAttemptID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func allowEqual(a, b []AllowEntry) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// ---------------------------------------------------------------------------
// Validation

// validateSpec is the structural check every desired spec passes before the
// manager acts on it. (W1e layers the server-host and policy checks on top.)
func validateSpec(s *Spec, now time.Time) error {
	s.IsolationID = strings.ToLower(strings.TrimSpace(s.IsolationID))
	switch {
	case !uuidRE.MatchString(s.IsolationID):
		return errors.New("isolationId must be a UUID")
	case s.Generation < 1:
		return errors.New("generation must be >= 1")
	case !now.Before(s.ExpiresAt):
		return errors.New("expiresAt must be in the future")
	case s.ExpiresAt.After(now.Add(MaxTTL + expirySlack)):
		return errors.New("expiresAt is more than 720 h away")
	case s.DeadManSeconds != 0:
		// Dead-man needs capability v2 (Gate B decision 4 v); v1 refuses it.
		return errors.New("deadManSeconds is not supported by this agent")
	case len(s.Allow) == 0 || len(s.Allow) > maxAllowEntries:
		return fmt.Errorf("allow must have 1 to %d entries", maxAllowEntries)
	case s.BreakGlassSecret != nil && len(s.BreakGlassSecret) != breakGlassSecretBytes:
		return errors.New("breakGlassSecret must be 32 bytes")
	}
	for i := range s.Allow {
		if err := validateEntry(&s.Allow[i]); err != nil {
			return fmt.Errorf("allow[%d]: %w", i, err)
		}
	}
	return nil
}

func validateEntry(e *AllowEntry) error {
	switch e.Kind {
	case KindHost:
		if e.CIDR != "" || normaliseHost(e.Host) == "" || strings.ContainsAny(e.Host, " /\\") {
			return errors.New("a host entry needs a host name and no cidr")
		}
		e.Host = normaliseHost(e.Host)
	case KindCIDR:
		p, err := netip.ParsePrefix(e.CIDR)
		if e.Host != "" || err != nil || p.Bits() == 0 {
			return errors.New("a cidr entry needs a non-/0 prefix and no host")
		}
	default:
		return fmt.Errorf("unknown kind %q", e.Kind)
	}
	switch e.Proto {
	case ProtoTCP, ProtoUDP, ProtoUDPTCP:
	default:
		return fmt.Errorf("unknown proto %q", e.Proto)
	}
	switch e.Scope {
	case ScopeBreeze, ScopeAny:
	default:
		return fmt.Errorf("unknown scope %q", e.Scope)
	}
	if len(e.Ports) == 0 || len(e.Ports) > 16 {
		return errors.New("ports must have 1 to 16 entries")
	}
	seen := map[uint16]bool{}
	for _, p := range e.Ports {
		if p == 0 || seen[p] {
			return errors.New("ports must be unique and in 1..65535")
		}
		seen[p] = true
	}
	return nil
}

// parseIsolatePayload reads the execute_containment payload: `parameters`
// carries the spec and the top-level `breakGlassSecret` the secret (Gate B
// decision 4 vii).
func parseIsolatePayload(payload map[string]any, now time.Time) (Spec, error) {
	if at, ok := payload["actionType"]; ok && at != "network_isolation" {
		return Spec{}, fmt.Errorf("actionType %v is not network_isolation", at)
	}
	params, ok := payload["parameters"].(map[string]any)
	if !ok {
		return Spec{}, errors.New("parameters missing")
	}
	data, err := json.Marshal(params)
	if err != nil {
		return Spec{}, err
	}
	var s Spec
	if err := json.Unmarshal(data, &s); err != nil {
		return Spec{}, fmt.Errorf("parameters: %w", err)
	}
	s.BreakGlassSecret = nil // only the top-level field counts
	raw, _ := payload["breakGlassSecret"].(string)
	if raw == "" {
		return Spec{}, errors.New("breakGlassSecret missing")
	}
	secret, err := decodeSecret(raw)
	if err != nil {
		return Spec{}, err
	}
	s.BreakGlassSecret = secret
	if err := validateSpec(&s, now); err != nil {
		return Spec{}, err
	}
	return s, nil
}

func decodeSecret(raw string) ([]byte, error) {
	var b []byte
	if err := json.Unmarshal([]byte(strconv.Quote(raw)), &b); err != nil || len(b) != breakGlassSecretBytes {
		return nil, errors.New("breakGlassSecret must be base64 of 32 bytes")
	}
	return b, nil
}

// ---------------------------------------------------------------------------
// Outcomes

func (o *op) body(reqID string, reqGen int) *CommandResultBody {
	b := &CommandResultBody{IsolationID: reqID, Generation: reqGen, Mechanism: o.cap.Mechanism}
	if o.j != nil {
		b.JournalSeq = o.j.LastSeq()
		if ep := o.j.Episode; ep != nil && (reqID == "" || ep.IsolationID == reqID) {
			b.IsolationID, b.Generation, b.State = ep.IsolationID, ep.Generation, ep.State
			if !ep.AppliedAt.IsZero() {
				t := ep.AppliedAt
				b.AppliedAt = &t
			}
			if ep.State == StateVerified && !ep.LastVerifiedAt.IsZero() {
				t := ep.LastVerifiedAt
				b.VerifiedAt = &t
			}
			if ep.State == StateFailed {
				b.FailureCode = ep.FailureCode
				switch ep.FailureCode {
				case FailApplyError, FailControlPlaneUnreachable, FailEnforcementNotObserved:
					b.Rollback = true
				}
			}
		}
	}
	return b
}

func (o *op) outcome(reqID string, reqGen int) CommandOutcome {
	b := o.body(reqID, reqGen)
	fail := func(code wire.CommandErrorCode, msg string) CommandOutcome {
		return CommandOutcome{Status: "failed", Error: msg, ErrorCode: code, Result: b}
	}
	r := o.report
	switch {
	case o.crashed:
		return fail(wire.ErrCodeIsolationBusy, errCrashedOp.Error())
	case r != nil && r.Refusal != "":
		return fail(r.Refusal, r.Detail)
	case o.lockLost:
		return fail(wire.ErrCodeIsolationBusy, "lost the isolation lock")
	case o.cleanupFailed && o.state.Phase == journal.PhaseReleasing:
		msg := "Breeze-owned rules could not be removed; recovery stays armed"
		if o.j.Episode != nil && o.j.Episode.LastError != "" {
			msg += ": " + o.j.Episode.LastError
		}
		return fail(wire.ErrCodeIsolationApplyError, msg)
	case r == nil:
		return fail(wire.ErrCodeIsolationBusy, "superseded by a concurrent release or rollback")
	case r.State == StateFailed:
		b.State, b.FailureCode = StateFailed, r.FailureCode
		msg := r.FailureCode
		if o.failDetail != "" {
			msg += ": " + o.failDetail
		}
		return fail(failureErrorCode(r.FailureCode), msg)
	}
	if r.State != "" {
		b.State = r.State
	}
	return CommandOutcome{Status: "completed", Result: b}
}

func unsupportedOutcome(id string, gen int, c Capability) CommandOutcome {
	msg := "network isolation is not supported on this device"
	if c.UnsupportedReason != "" {
		msg += ": " + c.UnsupportedReason
	}
	return CommandOutcome{
		Status: "failed", Error: msg, ErrorCode: wire.ErrCodeIsolationUnsupportedPlatform,
		Result: &CommandResultBody{IsolationID: id, Generation: gen, State: StateFailed, FailureCode: FailUnsupportedPlatform},
	}
}

func busyOutcome(id string, gen int, err error) CommandOutcome {
	return CommandOutcome{Status: "failed", Error: "isolation busy: " + err.Error(), ErrorCode: wire.ErrCodeIsolationBusy,
		Result: &CommandResultBody{IsolationID: id, Generation: gen}}
}

func invalidOutcome(err error) CommandOutcome {
	return CommandOutcome{Status: "failed", Error: "invalid isolation spec: " + err.Error(), ErrorCode: wire.ErrCodeIsolationInvalidSpec}
}

// failureErrorCode maps an episode failure code to its wire command code.
func failureErrorCode(code string) wire.CommandErrorCode {
	switch code {
	case FailUnsupportedPlatform:
		return wire.ErrCodeIsolationUnsupportedPlatform
	case FailMechanismUnavailable:
		return wire.ErrCodeIsolationMechanismUnavailable
	case FailApplyError:
		return wire.ErrCodeIsolationApplyError
	case FailControlPlaneUnreachable:
		return wire.ErrCodeIsolationControlPlaneUnreachable
	case FailEnforcementNotObserved:
		return wire.ErrCodeIsolationEnforcementNotObserved
	}
	return wire.ErrCodeIsolationApplyError
}

// ---------------------------------------------------------------------------
// Public operations

// HandleIsolate runs an execute_containment `network_isolation` command.
func (m *Manager) HandleIsolate(ctx context.Context, payload map[string]any) CommandOutcome {
	spec, err := parseIsolatePayload(payload, m.deps.Clock.Now())
	if err != nil {
		return invalidOutcome(err)
	}
	return m.isolate(ctx, spec)
}

// isolate is the apply order (plan W1d Task 2, quorum Q2):
//  1. lock + fresh attemptId; 2. reject stale, terminal or expired specs;
//  3. preflight (capability, recovery, allowlist on both families, journal);
//  4. journal provisional + fsync; 5. arm the one-shot rollback, then expiry;
//  6. re-check the deadline; 7. apply, drop the lock, probe within 60 s;
//  8. retake the lock, re-check attempt, deadline and digest;
//  9. journal committed + fsync, disarm, report verified.
func (m *Manager) isolate(ctx context.Context, spec Spec) CommandOutcome {
	c := m.deps.Isolator.Capability()
	if c.Version < 1 {
		return unsupportedOutcome(spec.IsolationID, spec.Generation, c)
	}
	o, err := m.begin(ctx)
	if err != nil {
		return busyOutcome(spec.IsolationID, spec.Generation, err)
	}
	defer o.end()
	o.cap = c
	o.cleanupOrphans(true)
	if o.crashed {
		return o.outcome(spec.IsolationID, spec.Generation)
	}
	o.isolateLocked(spec)
	return o.outcome(spec.IsolationID, spec.Generation)
}

func (o *op) isolateLocked(spec Spec) {
	o.report = nil
	// A late secret for the episode already held (the heartbeat path).
	if o.state.IsolationID == spec.IsolationID && o.j.Episode != nil && len(o.j.Episode.BreakGlassSecret) == 0 &&
		len(spec.BreakGlassSecret) == breakGlassSecretBytes && activePhase(o.state.Phase) {
		o.j.Episode.BreakGlassSecret = append([]byte(nil), spec.BreakGlassSecret...)
		o.j.SecretAckSeq = o.j.Append(o.now(), "secret_received", spec.IsolationID, o.state.Generation, "")
		if err := o.save(); err != nil {
			o.noteError("store the break-glass secret: " + err.Error())
		}
	}

	// The desired episode differs from the journalled one: release it first.
	if o.state.IsolationID != "" && o.state.IsolationID != spec.IsolationID && activePhase(o.state.Phase) {
		o.run(Event{Kind: EvRelease, ReleaseKind: ReleaseSystem})
		if o.crashed || o.lockLost {
			return
		}
		if activePhase(o.state.Phase) {
			o.report = &Effect{Kind: EffReport, Refusal: wire.ErrCodeIsolationBusy, Detail: "could not release the previous episode first"}
			return
		}
		o.report = nil
	}

	ev := Event{Kind: EvIsolate, IsolationID: spec.IsolationID, Generation: spec.Generation, ExpiresAt: spec.ExpiresAt, AttemptID: newAttemptID()}
	_, dry := Step(o.state, ev, o.m.deps.Clock)
	if len(dry) == 1 && dry[0].Kind == EffReport && dry[0].Refusal != "" {
		r := dry[0]
		o.report = &r
		return
	}
	if o.state.Phase == journal.PhaseCommitted {
		// Retransmission or extend of the applied episode.
		o.run(ev)
		if o.crashed || o.lockLost || o.report == nil || o.report.Refusal != "" {
			return
		}
		if o.j.Episode != nil && !allowEqual(o.j.Episode.Allow, spec.Allow) {
			saved := o.report
			o.refresh(spec.Allow, false)
			if o.report == nil || o.report.Refusal == "" {
				o.report = saved
			}
		}
		return
	}

	// Preflight, before anything is journalled or armed.
	if !o.cap.Ready {
		o.refuse(FailMechanismUnavailable, "isolation mechanism not ready: "+o.cap.UnsupportedReason)
		return
	}
	if ok, why := o.m.deps.Scheduler.Ready(); !ok {
		o.refuse(FailMechanismUnavailable, "recovery not ready: "+why)
		return
	}
	a, err := o.resolveAttempt(spec.IsolationID, spec.Generation, spec.RemoteRelay, spec.Allow)
	if err != nil {
		o.refuse(FailMechanismUnavailable, "allowlist: "+err.Error())
		return
	}
	if err := o.save(); err != nil {
		o.refuse(FailMechanismUnavailable, "journal not writable: "+err.Error())
		return
	}
	a.kind = AttemptApply
	ev.AttemptID = a.id
	o.attempt = a
	o.newEpisode = &journal.EpisodeRecord{
		IsolationID:      spec.IsolationID,
		Generation:       spec.Generation,
		ExpiresAt:        spec.ExpiresAt,
		DeadManSeconds:   spec.DeadManSeconds,
		RemoteRelay:      spec.RemoteRelay,
		Allow:            append([]AllowEntry(nil), spec.Allow...),
		BreakGlassSecret: append([]byte(nil), spec.BreakGlassSecret...),
	}
	if len(spec.BreakGlassSecret) == 0 {
		o.newEpisode.BreakGlassSecret = nil
	}
	o.run(ev)
}

func (o *op) refuse(failureCode, detail string) {
	o.report = &Effect{Kind: EffReport, Refusal: failureErrorCode(failureCode), Detail: detail}
}

// refresh re-installs the committed episode with freshly resolved addresses
// (and, when allow is given, a new allowlist). Failure restores the last
// verified rules.
func (o *op) refresh(allow []AllowEntry, drift bool) {
	ep := o.j.Episode
	if ep == nil || o.state.Phase != journal.PhaseCommitted {
		return
	}
	if allow == nil {
		allow = ep.Allow
	}
	a, err := o.resolveAttempt(ep.IsolationID, ep.Generation, ep.RemoteRelay, allow)
	if err != nil {
		o.noteError("refresh: " + err.Error())
		return
	}
	a.kind, a.drift = AttemptRefresh, drift
	o.attempt = a
	o.run(Event{Kind: EvRefresh, AttemptID: a.id})
}

// reverify re-reads the rules, re-resolves the allowlist and re-runs the
// negative probe; any difference re-installs the rule set.
func (o *op) reverify() {
	ep := o.j.Episode
	if ep == nil || o.state.Phase != journal.PhaseCommitted || o.state.AttemptID != "" {
		return
	}
	o.m.lastReverify = o.now()
	stored, err := priorSpec(o.j)
	if err != nil {
		o.noteError("rebuild the journalled rules: " + err.Error())
		return
	}
	d, verr := o.m.deps.Isolator.Verify(o.ctx, stored)
	if verr != nil || string(d) != ep.RuleDigest {
		log.Warn("isolation rules drifted; re-applying", "isolationId", ep.IsolationID)
		o.refresh(nil, true)
		return
	}
	fresh, err := o.resolveAttempt(ep.IsolationID, ep.Generation, ep.RemoteRelay, ep.Allow)
	if err == nil && fresh.spec.Digest() != stored.Digest() {
		o.refresh(nil, false)
		return
	}
	// Steady-state negative probe, without the lock.
	o.unlock()
	o.unlock = nil
	o.m.opMu.Unlock()
	ctx, cancel := context.WithTimeout(o.ctx, o.m.negativeTimeout+negativeGrace+5*time.Second)
	target, terr := negativeProbeTarget(stored)
	probeErr := terr
	if terr == nil {
		probeErr = negativeProbe(ctx, o.m.deps.Dialer, o.m.deps.Isolator, target, o.m.negativeTimeout)
	}
	cancel()
	o.m.opMu.Lock()
	unlock, err := journal.Lock(o.m.deps.DataDir)
	if err != nil {
		o.lockLost = true
		return
	}
	o.unlock = unlock
	if err := o.load(); err != nil {
		o.lockLost = true
		return
	}
	if probeErr != nil && o.state.Phase == journal.PhaseCommitted && o.state.AttemptID == "" {
		log.Warn("isolation negative probe failed in steady state; re-applying", "error", probeErr.Error())
		o.refresh(nil, true)
	}
}

// HandleRelease runs a release_containment command {isolationId, generation, reason}.
func (m *Manager) HandleRelease(ctx context.Context, payload map[string]any) CommandOutcome {
	id, _ := payload["isolationId"].(string)
	id = strings.ToLower(strings.TrimSpace(id))
	genF, _ := payload["generation"].(float64)
	gen := int(genF)
	if !uuidRE.MatchString(id) || gen < 1 || float64(gen) != genF {
		return invalidOutcome(errors.New("isolationId (UUID) and generation (>= 1) are required"))
	}
	o, err := m.begin(ctx)
	if err != nil {
		return busyOutcome(id, gen, err)
	}
	defer o.end()
	o.cap = m.deps.Isolator.Capability()
	o.cleanupOrphans(false)
	o.report = nil
	o.run(Event{Kind: EvRelease, IsolationID: id, Generation: gen, ReleaseKind: ReleaseConsole})
	return o.outcome(id, gen)
}

// Reconcile applies the heartbeat's desired state. A nil block (an API that
// predates containment) and a nil networkIsolation (nothing asserted) change
// nothing: a release only ever travels as a `released` tombstone.
func (m *Manager) Reconcile(ctx context.Context, desired *DesiredBlock) {
	if desired == nil || desired.NetworkIsolation == nil {
		return
	}
	d := *desired.NetworkIsolation
	switch d.Desired {
	case DesiredIsolated:
		spec := d.Spec
		if err := validateSpec(&spec, m.deps.Clock.Now()); err != nil {
			log.Warn("ignoring an invalid desired isolation", "error", err.Error())
			return
		}
		if snap := m.snapshot(); snap != nil && snap.Episode != nil && snap.Episode.IsolationID == spec.IsolationID {
			ep := snap.Episode
			if spec.Generation < ep.Generation || snap.Phase == journal.PhaseReleased || snap.Phase == journal.PhaseRolledBack {
				return // older generation, or ended locally: nothing to do
			}
			if snap.Phase == journal.PhaseCommitted && spec.Generation == ep.Generation &&
				allowEqual(ep.Allow, spec.Allow) && (len(ep.BreakGlassSecret) > 0 || len(spec.BreakGlassSecret) == 0) {
				return // already applied as desired
			}
		}
		out := m.isolate(ctx, spec)
		if out.Failed() {
			log.Warn("desired isolation not applied", "isolationId", spec.IsolationID, "code", string(out.ErrorCode), "error", out.Error)
		}
	case DesiredReleased:
		id := strings.ToLower(d.IsolationID)
		snap := m.snapshot()
		if snap == nil || snap.Episode == nil || snap.Episode.IsolationID != id || !activePhase(snap.Phase) || d.Generation < snap.Episode.Generation {
			return
		}
		o, err := m.begin(ctx)
		if err != nil {
			log.Warn("isolation busy; release retried next heartbeat", "error", err.Error())
			return
		}
		defer o.end()
		o.cap = m.deps.Isolator.Capability()
		o.run(Event{Kind: EvRelease, IsolationID: id, Generation: d.Generation, ReleaseKind: ReleaseConsole})
	}
}

// Tick evaluates the deadline, expiry and retries, and re-verifies a
// committed episode every ReverifyInterval (or at once after a network
// change or resume).
func (m *Manager) Tick(ctx context.Context) {
	o, err := m.begin(ctx)
	if err != nil {
		log.Warn("isolation tick skipped: lock busy", "error", err.Error())
		return
	}
	defer o.end()
	o.cap = m.deps.Isolator.Capability()
	o.tick()
}

func (o *op) tick() {
	o.cleanupOrphans(o.missing)
	if o.crashed || o.lockLost {
		return
	}
	if o.missing && !o.state.RulesMayExist {
		return // never isolated: nothing to record
	}
	o.run(Event{Kind: EvTick})
	if o.crashed || o.lockLost {
		return
	}
	if o.state.Phase == journal.PhaseCommitted && o.m.expiryUnarmed {
		_ = o.armExpiry()
	}
	force := o.m.forceReverify.Swap(false)
	if o.state.Phase == journal.PhaseCommitted && (force || !o.now().Before(o.m.lastReverify.Add(o.m.reverifyInterval))) {
		o.reverify()
	}
}

// OnNetworkChange re-verifies at once.
func (m *Manager) OnNetworkChange(ctx context.Context) {
	m.forceReverify.Store(true)
	m.Tick(ctx)
}

// OnResume re-verifies at once (and evaluates expiry after sleep).
func (m *Manager) OnResume(ctx context.Context) {
	m.forceReverify.Store(true)
	m.Tick(ctx)
}

// Startup runs once when the agent starts: orphan and corrupt-journal
// cleanup, an immediate retry of an interrupted release, a rollback of any
// attempt the previous process left in flight (a provisional apply is never
// promoted after a restart), re-arming of the recovery tasks, and a
// re-verify.
func (m *Manager) Startup(ctx context.Context) {
	o, err := m.begin(ctx)
	if err != nil {
		log.Warn("isolation startup: lock busy", "error", err.Error())
		return
	}
	defer o.end()
	o.cap = m.deps.Isolator.Capability()
	o.cleanupOrphans(true)
	if o.crashed || o.lockLost {
		return
	}
	switch {
	case o.state.AttemptID != "" && (o.state.Phase == journal.PhaseProvisional || o.state.Phase == journal.PhaseCommitted):
		o.run(Event{Kind: EvAttemptFailed, AttemptID: o.state.AttemptID, Code: FailApplyError, Err: "the agent restarted before the rules were verified"})
	case o.state.Phase == journal.PhaseReleasing:
		o.run(Event{Kind: EvTick})
	}
	if o.crashed || o.lockLost {
		return
	}
	if o.state.Phase == journal.PhaseCommitted {
		_ = o.armExpiry() // a failure is noted and retried by the next tick
	}
	o.m.forceReverify.Store(true)
	o.tick()
}

// LocalRelease is `breeze-agent containment release --code <c> | --force`,
// run by a local administrator. A code is checked against the current hour
// bucket and its neighbours (−1, 0, +1), at most BreakGlassAttemptsPerHour
// times an hour (the count is journalled, so a restart does not reset it).
// --force needs no code and is recorded as released_locally:forced.
func (m *Manager) LocalRelease(ctx context.Context, code string, force bool) error {
	o, err := m.begin(ctx)
	if err != nil {
		return err
	}
	defer o.end()
	o.cap = m.deps.Isolator.Capability()
	o.cleanupOrphans(false)
	if !activePhase(o.state.Phase) || o.state.IsolationID == "" || o.j.Episode == nil {
		return ErrNoActiveIsolation
	}
	id, gen := o.state.IsolationID, o.state.Generation
	kind := ReleaseLocalForced
	if !force {
		secret := o.j.Episode.BreakGlassSecret
		if len(secret) != breakGlassSecretBytes {
			return ErrBreakGlassUnavailable
		}
		now := o.now()
		recent := o.j.BreakGlassAttempts[:0:0]
		for _, at := range o.j.BreakGlassAttempts {
			if now.Sub(at) < time.Hour && !at.After(now.Add(time.Hour)) {
				recent = append(recent, at)
			}
		}
		if len(recent) >= BreakGlassAttemptsPerHour {
			return ErrBreakGlassRateLimited
		}
		o.j.BreakGlassAttempts = append(recent, now)
		if err := o.save(); err != nil {
			return fmt.Errorf("record the attempt: %w", err)
		}
		if !breakGlassMatches(secret, id, gen, now, code) {
			o.j.Append(now, "break_glass_rejected", id, gen, "")
			o.dirty = true
			return ErrBreakGlassInvalid
		}
		kind = ReleaseLocalCode
	}
	o.report = nil
	o.run(Event{Kind: EvRelease, IsolationID: id, Generation: gen, ReleaseKind: kind})
	if o.crashed {
		return errCrashedOp
	}
	if o.state.Phase != journal.PhaseReleased {
		return fmt.Errorf("release did not complete; recovery stays armed (%s)", o.lastError())
	}
	return nil
}

func (o *op) lastError() string {
	if o.j.Episode != nil && o.j.Episode.LastError != "" {
		return o.j.Episode.LastError
	}
	return "Breeze-owned rules could not be removed"
}

func breakGlassMatches(secret []byte, id string, gen int, now time.Time, code string) bool {
	typed := strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "\t", "").Replace(code))
	if len(typed) != 8 {
		return false
	}
	bucket := now.Unix() / 3600
	ok := false
	for _, off := range []int64{-1, 0, 1} {
		want, err := BreakGlassCode(secret, id, gen, bucket+off)
		if err == nil && hmac.Equal([]byte(want), []byte(typed)) {
			ok = true
		}
	}
	return ok
}
