// RebootManager: scheduling, user notification, circuit breaking and execution
// of a deferred reboot.
//
// Intentionally untagged. Before #3197 the whole manager lived in
// reboot_windows.go behind //go:build windows, with reboot_other.go providing a
// no-op stub for every other platform. Two consequences, both fixed here:
//
//   - Nothing about it was testable. ./internal/patching is not in the
//     test-agent-windows package allowlist, so a windows-tagged test would run
//     nowhere in CI (issues #3019, #3046). Now the manager, its notification
//     timers and its circuit breaker all compile and test on linux.
//   - Linux and macOS silently never rebooted. patchJobExecutor dispatches
//     schedule_reboot with no OS check, the stub's Schedule() returned nil
//     without doing anything, and the patch job recorded a clean result. A
//     "patch reboots now warn the user" fix that is Windows-only would have
//     left that in place.
//
// Only the OS invocation is platform-specific now; see reboot_os_*.go.
package patching

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// RebootState tracks the current reboot scheduling state. Serialised to the API
// by the get_reboot_status command handler.
type RebootState struct {
	PendingReboot    bool      `json:"pendingReboot"`
	RebootScheduled  bool      `json:"rebootScheduled"`
	ScheduledAt      time.Time `json:"scheduledAt,omitempty"`
	Deadline         time.Time `json:"deadline,omitempty"`
	Reason           string    `json:"reason,omitempty"`
	NotifiedUser     bool      `json:"notifiedUser"`
	NotificationSent time.Time `json:"notificationSent,omitempty"`
	Source           string    `json:"source"` // "patch_install", "manual", "policy"
	// NotificationsPlanned is how many user warnings the most recently scheduled
	// reboot will emit. Read it together with RebootScheduled, which is what
	// tracks liveness: while RebootScheduled is true this is always >= 1 (#3197
	// — a zero there would mean a silent reboot, which is why this field is
	// surfaced to the console at all). Cancel resets it to 0; a reboot that has
	// already fired deliberately leaves it set, so a status dump can still show
	// that the reboot which took the machine down had been announced.
	NotificationsPlanned int `json:"notificationsPlanned"`
	// LastError records why the most recent reboot attempt did not happen — an
	// OS shutdown invocation that failed, or a circuit-breaker block. Without it
	// RebootScheduled:false is ambiguous between "the machine is going down right
	// now" and "the reboot failed and the machine is still up", which left a
	// failed reboot visible only in agent logs. Cleared by the next Schedule.
	LastError string `json:"lastError,omitempty"`

	// Deferral budget for the current schedule (#3207). Zero-valued when the
	// policy did not enable it, which is the default and reproduces the
	// pre-#3207 behaviour exactly. Not omitempty: the console needs to tell
	// "this restart cannot be postponed" apart from "this agent predates
	// deferral", and an omitted field reads as the latter.
	DeferralAllowed bool `json:"deferralAllowed"`
	DeferralsUsed   int  `json:"deferralsUsed"`
	MaxDeferrals    int  `json:"maxDeferrals"`
	DeferralMinutes int  `json:"deferralMinutes"`
}

// RebootOptions carries everything about a schedule that is not part of the
// pre-#3207 signature. A zero RebootOptions is exactly today's behaviour, which
// is what lets Schedule stay a thin wrapper and every old call site stay put.
type RebootOptions struct {
	Deferral DeferralPolicy
}

// NotifyFunc is called to send a notification to the logged-in user.
type NotifyFunc func(title, body, urgency string)

// RebootManager handles reboot scheduling, notification, and execution.
type RebootManager struct {
	// mu guards everything below it. Defer holds it for its whole
	// decide-reschedule-persist sequence — W3 fans the prompt out to every
	// helper session and takes the first answer, so simultaneous postponement
	// requests are the expected shape, not a hypothetical.
	mu               sync.Mutex
	state            RebootState
	notifyTimers     []*time.Timer
	osTimer          *time.Timer
	notifyFn         NotifyFunc
	promptFn         PromptFunc
	stopChan         chan struct{}
	stopped          bool
	maxRebootsPerDay int
	rebootHistory    []time.Time
	// osInvoked records that the OS shutdown countdown has actually been
	// started, so Cancel only tries to abort something that exists. Without it
	// Cancel would always fail on macOS, where abortOSReboot can never succeed.
	//
	// Set only AFTER execOSReboot returns successfully. Setting it before, as
	// this did originally, opened a window in which Cancel and a re-schedule both
	// took the abort path while there was still nothing to abort: the abort
	// "succeeded", the caller was told the reboot was off, and exec then ran and
	// took the machine down anyway. osInvoking covers that window instead.
	osInvoked bool
	// osInvoking is true from the moment runOSReboot commits to the shutdown
	// until execOSReboot returns. Nothing can be aborted in that window, so
	// Cancel, Defer and a re-schedule are all REFUSED there rather than handed a
	// success they cannot deliver — the same honesty rule Cancel already applies
	// to a platform whose abort cannot work.
	osInvoking bool
	// osInvokeDone is non-nil exactly while osInvoking is true, and is closed
	// when the invocation finishes. It is how Stop waits out a reboot that has
	// already been committed to the OS without holding mu across the exec.
	osInvokeDone chan struct{}
	// osAborting is true from the moment Cancel decides to abort an in-flight
	// OS countdown until abortOSReboot returns.
	//
	// Cancel runs the abort OUTSIDE the lock on purpose: it is an exec with a
	// thirty-second ceiling, and holding mu across it would stall State(),
	// every timer callback and every other operation for that long. The price
	// is a window in which the manager holds no OS countdown but a `shutdown
	// -c` is still in the air — and a schedule armed inside that window would
	// reach OSInvokeAt, register a NEW countdown, and then have the pending
	// abort silently cancel it. The manager would go on reporting a reboot the
	// OS had already been told to forget.
	//
	// So the window is closed by refusal rather than by holding the lock:
	// scheduleLockedAt declines while this is set, exactly as it declines while
	// osInvoking is set, and for the same reason — the manager cannot honour a
	// promise it is about to contradict.
	osAborting bool
	// generation identifies the current schedule. time.Timer.Stop() does not
	// wait for an AfterFunc callback that has already started — those run on
	// their own goroutines — so stopping the timers is not enough on its own:
	// a Cancel racing the closing timer could return success and still have the
	// machine reboot, and a re-Schedule could have the superseded schedule's
	// callback fire against the new state. Every callback captures the
	// generation it was armed under and does nothing if it no longer matches.
	generation uint64

	// deferral is the budget the API sent with the current schedule, and
	// deferralsUsed how much of it this campaign has spent. Both are reset by
	// every Schedule: an absent policy must never mean "enabled".
	deferral      DeferralPolicy
	deferralsUsed int

	// Injectable seams for deterministic tests, following the repo's nowFn
	// convention (sessionbroker.Broker, watchdog.Clock). afterFunc in
	// particular is what lets the notification ladder be asserted without
	// waiting real minutes — the plan's shortest schedule is a minute long.
	nowFn          func() time.Time
	afterFunc      func(time.Duration, func()) *time.Timer
	execOSReboot   func(grace time.Duration) error
	abortOSReboot  func() error
	historyPath    func() string
	deferralLedger func() string
}

// NewRebootManager creates a new RebootManager with circuit breaker protection
// and no interactive surface: every warning is a fire-and-forget notification,
// exactly as before #3207.
func NewRebootManager(notifyFn NotifyFunc, maxRebootsPerDay int) *RebootManager {
	return NewRebootManagerWithPrompt(notifyFn, nil, maxRebootsPerDay)
}

// NewRebootManagerWithPrompt adds the interactive seam. promptFn may be nil,
// which is the same manager NewRebootManager builds — a headless box, or a build
// with no helper, must still warn the user and still reboot on time.
func NewRebootManagerWithPrompt(notifyFn NotifyFunc, promptFn PromptFunc, maxRebootsPerDay int) *RebootManager {
	if maxRebootsPerDay <= 0 {
		maxRebootsPerDay = 3
	}
	rm := &RebootManager{
		notifyFn:         notifyFn,
		promptFn:         promptFn,
		stopChan:         make(chan struct{}),
		maxRebootsPerDay: maxRebootsPerDay,
		nowFn:            time.Now,
		afterFunc:        time.AfterFunc,
		execOSReboot:     execOSReboot,
		abortOSReboot:    abortOSReboot,
		historyPath:      rebootHistoryPath,
		deferralLedger:   deferralLedgerPath,
	}
	rm.loadRebootHistory()
	return rm
}

// State returns the current reboot state.
func (r *RebootManager) State() RebootState {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Refresh pending reboot detection
	pending, _ := DetectPendingReboot()
	r.state.PendingReboot = pending
	return r.state
}

// Schedule schedules a reboot after the given delay with a hard deadline.
//
// Cancels any schedule already in flight. That is a deliberate last-writer-wins:
// the API is the authority on when a device reboots, and a second dispatch
// carries a fresh reason. It does mean a user warned "15 minutes" by an earlier
// dispatch gets a new countdown — the new schedule's own lead notification
// (always emitted, #3197) is what tells them, which is precisely why the lead
// notification is unconditional rather than threshold-gated.
func (r *RebootManager) Schedule(delay time.Duration, deadline time.Time, reason, source string) error {
	return r.ScheduleWithOptions(delay, deadline, reason, source, RebootOptions{})
}

// ScheduleWithOptions is Schedule plus the #3207 deferral budget. Kept as a
// separate entry point rather than a wider Schedule signature so that every
// pre-existing caller — and every pre-existing test — keeps today's behaviour
// with no edit at all.
func (r *RebootManager) ScheduleWithOptions(delay time.Duration, deadline time.Time, reason, source string, opts RebootOptions) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.scheduleLocked(delay, deadline, reason, source, opts)
}

// scheduleLocked is the whole of ScheduleWithOptions with r.mu already held, so
// that Defer can run its checks and its re-schedule as ONE atomic step. Callers
// must hold r.mu.
func (r *RebootManager) scheduleLocked(delay time.Duration, deadline time.Time, reason, source string, opts RebootOptions) error {
	return r.scheduleLockedAt(r.nowFn(), delay, deadline, reason, source, opts)
}

// scheduleLockedAt takes the instant the delay is measured from, so a caller
// that has already sampled the clock uses that ONE sample. Defer needs this:
// re-sampling here would place the reboot at (second sample + a delay computed
// against the first), which lands just past the deadline whenever the deferral
// was clamped to it — and arbitrarily past it if the wall clock steps. Callers
// must hold r.mu.
func (r *RebootManager) scheduleLockedAt(now time.Time, delay time.Duration, deadline time.Time, reason, source string, opts RebootOptions) error {
	if r.stopped {
		return fmt.Errorf("reboot manager is stopped")
	}

	// The shutdown command is being handed to the OS right now. There is nothing
	// to abort yet and no way to recall it once it lands, so refuse rather than
	// arm a new schedule on top of a reboot that is already going to happen.
	if r.osInvoking {
		return fmt.Errorf("the restart command is being handed to the operating system and cannot be superseded")
	}

	// A cancellation's `shutdown -c` is still in flight. Arming a countdown now
	// would hand it to an abort that was never about it; see osAborting.
	if r.osAborting {
		return fmt.Errorf("a previous restart is being aborted and a new one cannot be scheduled until that completes")
	}

	// An OS-level countdown may already be running: runOSReboot fires at
	// OSInvokeAt, a minute before the machine actually goes down. That countdown
	// lives in the OS, not this process, so simply re-arming Go timers on top of
	// it would leave two reboots racing — and worse, would clear osInvoked and so
	// make a later Cancel() report success while the ORIGINAL countdown still
	// took the machine down at the old time. Abort it first, and refuse the
	// reschedule outright if it cannot be aborted rather than promising a new
	// time we cannot deliver (macOS has no cancel flag).
	if r.osInvoked {
		if r.abortOSReboot == nil {
			return fmt.Errorf("an OS reboot countdown is already running and cannot be aborted on this platform")
		}
		if err := r.abortOSReboot(); err != nil {
			return fmt.Errorf("an OS reboot countdown is already running and could not be aborted: %w", err)
		}
		log.Warn("aborted an in-flight OS reboot countdown to honour a new schedule")
		r.osInvoked = false
	}

	// Cancel any existing schedule (this bumps the generation, orphaning any
	// callback from the superseded schedule).
	r.cancelLocked()
	r.osInvoked = false
	gen := r.generation

	plan := PlanReboot(delay)

	// Reset the budget from the incoming policy on every schedule. A schedule
	// that says nothing about deferral is not deferrable, whatever the previous
	// one allowed.
	r.deferral = opts.Deferral
	r.deferralsUsed = 0
	if opts.Deferral.Allowed {
		// Resume a count from a previous process lifetime, but only for THIS
		// campaign (same deadline). Best-effort: a missing ledger means zero,
		// which costs at most one extra postponement and can never push past
		// the deadline.
		r.deferralsUsed = LoadDeferralLedger(r.ledgerPath(), deadline, now)
	}

	r.state = RebootState{
		PendingReboot:        true,
		RebootScheduled:      true,
		ScheduledAt:          now.Add(plan.TotalDelay),
		Deadline:             deadline,
		Reason:               reason,
		Source:               source,
		NotificationsPlanned: len(plan.Notifications),
		DeferralAllowed:      opts.Deferral.Allowed,
		DeferralsUsed:        r.deferralsUsed,
		MaxDeferrals:         opts.Deferral.MaxDeferrals,
		DeferralMinutes:      opts.Deferral.DeferralMinutes,
		// LastError intentionally omitted: a fresh schedule clears any previous
		// failure, so the field describes only the most recent attempt.
	}

	for _, rung := range planRebootRungs(plan) {
		rung := rung // capture for closure
		r.notifyTimers = append(r.notifyTimers, r.afterFunc(rung.notification.After, func() {
			r.emitNotification(gen, rung)
		}))
	}

	// The OS shutdown command runs at OSInvokeAt with OSGrace still to run, so
	// the OS countdown is the same one the closing notification announces. The
	// old code fired the closing toast on the line before `shutdown /r /t 0`,
	// which raced session teardown and never rendered.
	r.osTimer = r.afterFunc(plan.OSInvokeAt, func() {
		r.runOSReboot(gen, plan.OSGrace)
	})

	log.Info("reboot scheduled",
		"delay", plan.TotalDelay.String(),
		"notifications", len(plan.Notifications),
		"osInvokeAt", plan.OSInvokeAt.String(),
		"osGrace", plan.OSGrace.String(),
		"reason", reason,
		"source", source,
		"deferralAllowed", opts.Deferral.Allowed,
		"deferralsUsed", r.deferralsUsed,
		"maxDeferrals", opts.Deferral.MaxDeferrals)

	return nil
}

// Defer postpones the scheduled reboot by the policy's deferral window, clamped
// to the hard deadline. Returns the new delay, or an error whose message is
// intended to be shown to the user.
//
// Refused once osInvoked is true: past OSInvokeAt the countdown lives in the OS
// and abortOSReboot cannot be honoured on every platform (macOS BSD shutdown(8)
// has no cancel flag), so granting a deferral there would report success while
// the machine still went down — the same class of lie Cancel() documents.
func (r *RebootManager) Defer() (time.Duration, error) {
	return r.deferSchedule(nil)
}

// deferForGeneration is Defer bound to the schedule that was live when the
// caller started, refusing once that schedule has been superseded.
//
// The prompt needs this and the public Defer cannot provide it. A dialog blocks
// for up to two minutes, and Defer's own checks only ask whether SOME reboot is
// scheduled — so a user answering a prompt for the reboot that was replaced while
// they read it would postpone the REPLACEMENT and spend its budget. That is the
// same resurrection class Defer's comment describes for Cancel, one schedule
// along: not a reboot brought back from the dead, but a different administrator's
// reboot moved by a click that was never about it.
func (r *RebootManager) deferForGeneration(gen uint64) (time.Duration, error) {
	return r.deferSchedule(&gen)
}

// deferSchedule is the whole of Defer. gen, when non-nil, is the generation the
// caller's decision belongs to.
func (r *RebootManager) deferSchedule(gen *uint64) (time.Duration, error) {
	// ONE atomic section: check, re-schedule, record the increment and persist
	// it, without ever releasing mu. Every split version of this has a hole:
	//
	//   - Unlocking before re-entering ScheduleWithOptions lets a concurrent
	//     Cancel() succeed inside the gap, after which the re-schedule
	//     RESURRECTS the reboot the operator just cancelled. Not hypothetical —
	//     a technician cancelling from the console while the signed-in user
	//     answers the prompt is exactly the shape W3 creates, and widening the
	//     window by a millisecond reproduces it on the first iteration
	//     (TestDeferNeverResurrectsACancelledReboot).
	//   - Unlocking before the ledger write lets a concurrent schedule for the
	//     same campaign reload the stale on-disk count and hand back a
	//     postponement that was already spent.
	//
	// The cost is a small file write under the lock, which briefly blocks
	// State() and the timer callbacks. That is the right trade: the write is a
	// few syscalls, and the alternative is a budget the user can exceed.
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.stopped {
		return 0, fmt.Errorf("reboot manager is stopped")
	}
	if r.osInvoked || r.osInvoking {
		return 0, fmt.Errorf("the restart countdown has already started and cannot be postponed")
	}
	if r.osAborting {
		return 0, fmt.Errorf("this restart is being cancelled and can no longer be postponed")
	}
	if !r.state.RebootScheduled {
		return 0, fmt.Errorf("no reboot scheduled")
	}
	if gen != nil && *gen != r.generation {
		return 0, fmt.Errorf("the restart was cancelled or rescheduled while the prompt was open")
	}

	// One clock sample for both the decision and the re-schedule; see
	// scheduleLockedAt.
	now := r.nowFn()
	outcome := ComputeDeferral(r.deferral, r.deferralsUsed, now, r.state.ScheduledAt, r.state.Deadline)
	if !outcome.Granted {
		return 0, fmt.Errorf("%s", outcome.Reason)
	}
	deadline, reason, source := r.state.Deadline, r.state.Reason, r.state.Source
	used := r.deferralsUsed + 1
	policy := r.deferral

	// Re-schedule under the same options: it cancels the in-flight timers, bumps
	// the generation and emits a fresh lead notification quoting the new time —
	// which is exactly how the user learns the countdown moved.
	if err := r.scheduleLockedAt(now, outcome.NewDelay, deadline, reason, source, RebootOptions{Deferral: policy}); err != nil {
		return 0, err
	}

	// scheduleLockedAt reset the count from the ledger, so the increment is
	// re-applied after it. Ordering matters — do not fold this into the
	// re-schedule; TestDeferRefusesPastTheBudget pins it.
	r.deferralsUsed = used
	r.state.DeferralsUsed = used

	path := r.ledgerPath()
	if err := SaveDeferralLedger(path, deadline, used); err != nil {
		// Best-effort: losing the ledger costs the user an extra postponement
		// after an agent restart, it never lets them exceed the DEADLINE.
		log.Warn("failed to persist reboot deferral ledger",
			"path", path, "deadline", deadline, "used", used, "error", err)
	}
	log.Info("reboot postponed by user",
		"newDelay", outcome.NewDelay.String(), "used", used, "max", policy.MaxDeferrals)
	return outcome.NewDelay, nil
}

// ledgerPath resolves the deferral ledger location through the test seam,
// falling back to the real data dir. Nil-safe because RebootManager is also
// built as a struct literal in tests.
func (r *RebootManager) ledgerPath() string {
	if r.deferralLedger != nil {
		return r.deferralLedger()
	}
	return deferralLedgerPath()
}

// Cancel cancels a scheduled reboot.
//
// The gate deliberately admits r.osInvoked as well as r.state.RebootScheduled.
// runOSReboot clears RebootScheduled *before* it invokes the OS command, so for
// the whole OSGrace window — the final minute, when the OS countdown is really
// running and abortOSReboot is the only thing that can still stop the machine —
// RebootScheduled is already false. Gating on RebootScheduled alone made the
// abort path unreachable in precisely the scenario it exists for, and returned a
// misleading "no reboot scheduled" while a countdown was live.
func (r *RebootManager) Cancel() error {
	r.mu.Lock()
	// The shutdown command is mid-flight. abortOSReboot has nothing to abort yet,
	// so running it here would report a cancellation that never happened while
	// exec still took the machine down. Refuse instead — the window is the length
	// of one exec call.
	if r.osInvoking {
		r.mu.Unlock()
		return fmt.Errorf("the restart command is being handed to the operating system and can no longer be cancelled")
	}
	if !r.state.RebootScheduled && !r.osInvoked {
		r.mu.Unlock()
		return fmt.Errorf("no reboot scheduled")
	}
	r.cancelLocked()
	r.state.RebootScheduled = false
	r.state.ScheduledAt = time.Time{}
	r.state.Deadline = time.Time{}
	r.state.NotificationsPlanned = 0
	// A cancelled reboot has no budget left to spend, and no deadline to clamp
	// one against. Clearing both the reported and the internal copy keeps the
	// two from disagreeing if a prompt answer arrives after the cancellation.
	r.deferral = DeferralPolicy{}
	r.deferralsUsed = 0
	r.state.DeferralAllowed = false
	r.state.DeferralsUsed = 0
	r.state.MaxDeferrals = 0
	r.state.DeferralMinutes = 0
	abort := r.abortOSReboot
	osInvoked := r.osInvoked
	r.osInvoked = false
	// Claim the abort window before releasing the lock, so nothing can arm a
	// countdown that the abort below would then kill. See osAborting.
	aborting := osInvoked && abort != nil
	if aborting {
		r.osAborting = true
	}
	r.mu.Unlock()

	// Abort an OS-level countdown, but only if one was actually started — i.e.
	// the schedule already passed OSInvokeAt. Before that the Go timers above
	// were the whole schedule and there is nothing for the OS to abort. The
	// distinction matters because not every platform can abort at all (BSD
	// shutdown(8), so macOS, has no cancel flag), and an unconditional attempt
	// would make every cancellation there look like a failure.
	if !aborting {
		return nil
	}
	err := abort()
	r.mu.Lock()
	r.osAborting = false
	r.mu.Unlock()
	if err != nil {
		log.Warn("reboot cancelled locally but the OS countdown could not be aborted", "error", err)
		return fmt.Errorf("reboot schedule cleared, but the OS countdown could not be aborted: %w", err)
	}
	return nil
}

// Stop stops the reboot manager and cancels any pending reboot.
//
// One reboot it deliberately does NOT cancel: one whose shutdown command has
// already been handed to the operating system. Past that point the countdown
// lives in the OS, not in this process, and no platform can be relied on to
// recall it (BSD shutdown(8), so macOS, has no cancel flag) — the same honesty
// rule Cancel documents. Stop's obligation is therefore not to stop it but to
// refuse to RETURN while the invocation is mid-flight: a Stop that returned
// there told its caller the manager was quiescent moments before the machine
// went down, and agent shutdown would then race a reboot it did not know about.
//
// The wait is bounded twice over. runOSReboot always clears osInvoking, success
// or failure, and the shutdown invocation it wraps carries its own thirty-second
// ceiling — but the invocation window also spans saveRebootHistory, a file write
// with no deadline of its own, so a wedged filesystem could otherwise park Stop
// forever. stopInvokeWaitTimeout is the backstop for that: past it, Stop gives
// up the guarantee and says so, rather than never returning.
func (r *RebootManager) Stop() {
	r.mu.Lock()
	if r.stopped {
		// Already stopped. Still wait out an invocation in flight, so a second
		// caller gets the same guarantee as the first.
		done := r.osInvokeDone
		r.mu.Unlock()
		waitForOSInvoke(done)
		return // avoid double-close on stopChan
	}
	r.stopped = true
	r.cancelLocked()
	close(r.stopChan)
	// Read under the lock and waited on outside it: runOSReboot needs mu to
	// close this channel, so waiting while holding mu would deadlock.
	done := r.osInvokeDone
	r.mu.Unlock()

	waitForOSInvoke(done)
}

// stopInvokeWaitTimeout bounds Stop's wait for a committed OS reboot. Comfortably
// past osRebootCommandTimeout, so it only ever fires when something outside the
// shutdown command itself has wedged.
var stopInvokeWaitTimeout = 60 * time.Second

// waitForOSInvoke blocks until a committed OS reboot invocation finishes, or
// until the backstop expires.
func waitForOSInvoke(done <-chan struct{}) {
	if done == nil {
		return
	}
	timer := time.NewTimer(stopInvokeWaitTimeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		// Loud: the caller is about to proceed believing the manager is
		// quiescent while a shutdown may still be in flight, which is exactly
		// the state this wait exists to prevent.
		log.Error("gave up waiting for an in-flight OS reboot invocation; "+
			"agent shutdown continues while a restart may still fire",
			"waited", stopInvokeWaitTimeout.String())
	}
}

// cancelLocked stops the in-flight timers and bumps the generation so any
// callback already running is orphaned. Callers must hold r.mu.
func (r *RebootManager) cancelLocked() {
	r.generation++
	if r.osTimer != nil {
		r.osTimer.Stop()
		r.osTimer = nil
	}
	for _, t := range r.notifyTimers {
		t.Stop()
	}
	r.notifyTimers = nil
}

// emitNotification delivers one rung of the warning ladder, as an interactive
// prompt when this rung may offer a postponement and as a plain notification
// otherwise.
//
// Nothing here holds r.mu across the delivery. The prompt blocks for up to
// maxRebootPromptWindow, and holding the lock would stall State(), Cancel(), the
// OS timer callback and every sibling rung behind a dialog nobody is looking at.
func (r *RebootManager) emitNotification(gen uint64, rung rebootRung) {
	n := rung.notification

	r.mu.Lock()
	if r.stopped || gen != r.generation {
		r.mu.Unlock()
		return
	}
	notifyFn := r.notifyFn
	promptFn := r.promptFn
	policy := r.deferral
	used := r.deferralsUsed
	// ComputeDeferral is the single authority on whether a postponement is
	// available, so the button offered here can never be one Defer() would then
	// refuse. It is pure, so calling it under the lock costs nothing.
	canPostpone := policy.Allowed && ComputeDeferral(
		policy, used, r.nowFn(), r.state.ScheduledAt, r.state.Deadline).Granted
	r.state.NotifiedUser = true
	r.state.NotificationSent = r.nowFn()
	r.mu.Unlock()

	body := rebootPromptBody(n.Body, rebootDeferralNote(policy, used, canPostpone))

	offerPrompt := rung.deferrable && promptFn != nil && canPostpone
	if !offerPrompt {
		if notifyFn != nil {
			notifyFn(n.Title, body, n.Urgency)
		}
		return
	}

	actions := []string{
		RebootActionRestartNow,
		rebootActionPostpone(time.Duration(policy.DeferralMinutes) * time.Minute),
	}
	clicked, shown := promptFn(n.Title, body, n.Urgency, actions, rung.promptWindow)
	if !shown {
		// The prompt reached nobody: no helper session, an IPC failure, or a
		// helper that could put nothing on screen. The user must still be TOLD,
		// so fall back to the notification this rung would have sent with
		// deferral off. Without this the interactive path SWALLOWS every
		// deferrable rung on any device with no signed-in helper — a headless
		// server, a Windows box at the logon screen, a crashed helper — leaving
		// only the closing notice and quietly reintroducing #3197 for exactly the
		// machines the ladder was written for.
		if notifyFn != nil {
			notifyFn(n.Title, body, n.Urgency)
		}
		return
	}

	switch clicked {
	case "":
		// No decision. Proceed exactly as scheduled — silence is never a
		// postponement and never an acceleration. The prompt itself was the
		// warning, so nothing more is emitted.
	case RebootActionRestartNow:
		if err := r.restartNow(gen); err != nil {
			log.Warn("could not honour Restart now", "error", err.Error())
			r.notifyUser("Restart Could Not Be Started", err.Error(), "critical")
		}
	case actions[1]:
		// Compared against the label we sent rather than a well-known constant:
		// the helper echoes back a string, and only the exact offer counts.
		if _, err := r.deferForGeneration(gen); err != nil {
			// Refused after the fact — the operator cancelled or replaced the
			// schedule while the dialog was open, or the deadline moved. Say so
			// rather than leaving the click looking like it worked.
			log.Info("postponement refused", "reason", err.Error())
			r.notifyUser("Restart Cannot Be Postponed", err.Error(), "critical")
		}
	default:
		log.Warn("reboot prompt returned a label that was never offered", "clicked", clicked)
	}
}

// notifyUser sends a one-off notification outside the ladder, used to tell the
// user why a button they pressed did not do what it promised.
func (r *RebootManager) notifyUser(title, body, urgency string) {
	r.mu.Lock()
	notifyFn := r.notifyFn
	r.mu.Unlock()
	if notifyFn != nil {
		notifyFn(title, body, urgency)
	}
}

// restartNow collapses the countdown to the shortest schedule the planner allows.
//
// NOT an immediate reboot: PlanReboot(MinRebootDelay) still emits the closing
// notice and still hands the OS a non-zero grace, which is the race #3197 exists
// to prevent. The deferral policy is carried over so a user who changes their
// mind at the new lead rung is not silently locked out.
//
// gen is checked under the lock because ScheduleWithOptions has no generation
// check of its own: a "Restart now" answered after the operator cancelled would
// otherwise arm a brand-new reboot they had just called off — the same
// resurrection hazard Defer() documents.
func (r *RebootManager) restartNow(gen uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.stopped {
		return fmt.Errorf("reboot manager is stopped")
	}
	if gen != r.generation || !r.state.RebootScheduled {
		return fmt.Errorf("the restart was cancelled or rescheduled while the prompt was open")
	}
	return r.scheduleLockedAt(r.nowFn(), MinRebootDelay, r.state.Deadline,
		r.state.Reason, r.state.Source, RebootOptions{Deferral: r.deferral})
}

func (r *RebootManager) runOSReboot(gen uint64, grace time.Duration) {
	r.mu.Lock()

	if r.stopped || gen != r.generation {
		// Cancelled, stopped, or superseded while this callback was starting.
		r.mu.Unlock()
		return
	}

	// Circuit breaker: check reboot frequency
	now := r.nowFn()
	cutoff := now.Add(-24 * time.Hour)
	recentCount := 0
	for _, t := range r.rebootHistory {
		if t.After(cutoff) {
			recentCount++
		}
	}

	if recentCount >= r.maxRebootsPerDay {
		r.state.RebootScheduled = false
		r.state.LastError = fmt.Sprintf("blocked by circuit breaker: %d reboots in 24h (max %d)",
			recentCount, r.maxRebootsPerDay)
		notifyFn := r.notifyFn
		maxPerDay := r.maxRebootsPerDay
		r.mu.Unlock()

		log.Warn("reboot blocked by circuit breaker",
			"recentReboots", recentCount, "maxPerDay", maxPerDay)

		if notifyFn != nil {
			notifyFn("Restart Blocked",
				fmt.Sprintf("Too many restarts detected (%d in 24h, max %d). Restart cancelled to prevent a restart loop.",
					recentCount, maxPerDay),
				"critical")
		}
		return
	}

	// Record this reboot
	r.rebootHistory = append(r.rebootHistory, now)
	r.state.RebootScheduled = false
	// osInvoking, NOT osInvoked: the shutdown command has not been issued yet.
	// Marking it invoked here — as this did originally — meant that for the whole
	// duration of the exec call, Cancel() and a re-schedule both took the abort
	// path, abortOSReboot found nothing to abort and returned success, and the
	// machine then went down anyway at the original time. Only exec's own success
	// promotes this to osInvoked, from which point the abort is real.
	r.osInvoking = true
	// Opened here, under the same lock hold that passed the stopped/generation
	// check, so there is no instant at which the reboot is committed but Stop
	// cannot see that it must wait.
	r.osInvokeDone = make(chan struct{})
	exec := r.execOSReboot
	r.mu.Unlock()

	// Persist history before rebooting
	r.saveRebootHistory()

	if exec == nil {
		log.Error("no OS reboot implementation for this platform")
		r.mu.Lock()
		r.finishOSInvokeLocked()
		r.state.LastError = "no OS reboot implementation for this platform"
		r.mu.Unlock()
		return
	}
	err := exec(grace)
	r.mu.Lock()
	r.finishOSInvokeLocked()
	if err != nil {
		r.state.LastError = fmt.Sprintf("OS reboot invocation failed: %v", err)
		r.mu.Unlock()
		// A failed shutdown invocation used to be discarded entirely: the old
		// code called exec.Command(...).Run() and ignored the error, so a
		// blocked or missing shutdown binary looked identical to a reboot.
		log.Error("failed to invoke OS reboot", "error", err, "grace", grace.String())
		return
	}
	r.osInvoked = true
	r.mu.Unlock()
}

// finishOSInvokeLocked releases the invocation window: it clears osInvoking and
// wakes any Stop that is waiting the invocation out. Callers must hold r.mu,
// and must call it on EVERY path out of the invocation — a missed call leaves
// Stop blocked until the process exits. Callers must hold r.mu.
func (r *RebootManager) finishOSInvokeLocked() {
	r.osInvoking = false
	if r.osInvokeDone != nil {
		close(r.osInvokeDone)
		r.osInvokeDone = nil
	}
}

func rebootHistoryPath() string {
	return filepath.Join(config.GetDataDir(), "reboot_history.json")
}

func (r *RebootManager) loadRebootHistory() {
	data, err := os.ReadFile(r.historyPath())
	if err != nil {
		return
	}

	var history []time.Time
	if err := json.Unmarshal(data, &history); err != nil {
		// Loud, not Debug: the history file IS the reboot-loop circuit breaker's
		// memory, so a corrupt file silently resets the count to zero and
		// disarms the one protection against rebooting a machine repeatedly.
		log.Warn("reboot history file is unreadable; circuit-breaker count resets to zero",
			"path", r.historyPath(), "error", err)
		return
	}

	// Only keep entries from last 24 hours
	cutoff := r.nowFn().Add(-24 * time.Hour)
	filtered := make([]time.Time, 0, len(history))
	for _, t := range history {
		if t.After(cutoff) {
			filtered = append(filtered, t)
		}
	}

	r.rebootHistory = filtered
}

func (r *RebootManager) saveRebootHistory() {
	r.mu.Lock()
	history := make([]time.Time, len(r.rebootHistory))
	copy(history, r.rebootHistory)
	r.mu.Unlock()

	data, err := json.Marshal(history)
	if err != nil {
		return
	}

	path := r.historyPath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Debug("failed to create reboot history dir", "error", err)
		return
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		log.Debug("failed to write reboot history", "error", err)
	}
}
