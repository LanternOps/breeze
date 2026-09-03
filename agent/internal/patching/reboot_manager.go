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
	mu sync.Mutex
	// deferMu serialises whole Defer calls, including the ledger write that
	// happens after mu is released — without it two concurrent postponements can
	// write their counts to disk in the wrong order, leaving a lower count
	// persisted than was actually granted. W3 fans the prompt out to every helper
	// session and takes the first answer, so simultaneous requests are the
	// expected shape, not a hypothetical. Always acquired BEFORE mu; never held
	// by anything else, so it cannot invert.
	deferMu          sync.Mutex
	state            RebootState
	notifyTimers     []*time.Timer
	osTimer          *time.Timer
	notifyFn         NotifyFunc
	stopChan         chan struct{}
	stopped          bool
	maxRebootsPerDay int
	rebootHistory    []time.Time
	// osInvoked records that the OS shutdown countdown has actually been
	// started, so Cancel only tries to abort something that exists. Without it
	// Cancel would always fail on macOS, where abortOSReboot can never succeed.
	osInvoked bool
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

// NewRebootManager creates a new RebootManager with circuit breaker protection.
func NewRebootManager(notifyFn NotifyFunc, maxRebootsPerDay int) *RebootManager {
	if maxRebootsPerDay <= 0 {
		maxRebootsPerDay = 3
	}
	rm := &RebootManager{
		notifyFn:         notifyFn,
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
	if r.stopped {
		return fmt.Errorf("reboot manager is stopped")
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
	now := r.nowFn()

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

	for _, n := range plan.Notifications {
		notif := n // capture for closure
		r.notifyTimers = append(r.notifyTimers, r.afterFunc(notif.After, func() {
			r.emitNotification(gen, notif)
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
	// deferMu covers the whole call INCLUDING the ledger write, so two
	// postponements can never write their counts to disk out of order. mu covers
	// the state mutation.
	r.deferMu.Lock()
	defer r.deferMu.Unlock()

	// One atomic section: check, re-schedule, and record the increment without
	// ever releasing mu. Splitting it — checking, unlocking, then re-entering
	// ScheduleWithOptions — leaves a window in which a concurrent Cancel()
	// succeeds and the re-schedule then RESURRECTS the reboot the operator just
	// cancelled. That is not hypothetical: a technician cancelling from the
	// console while the signed-in user answers the prompt is exactly the shape
	// W3 creates, and widening the window by a millisecond reproduces it on the
	// first iteration (TestDeferNeverResurrectsACancelledReboot).
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return 0, fmt.Errorf("reboot manager is stopped")
	}
	if r.osInvoked {
		r.mu.Unlock()
		return 0, fmt.Errorf("the restart countdown has already started and cannot be postponed")
	}
	if !r.state.RebootScheduled {
		r.mu.Unlock()
		return 0, fmt.Errorf("no reboot scheduled")
	}
	outcome := ComputeDeferral(r.deferral, r.deferralsUsed, r.nowFn(), r.state.Deadline)
	if !outcome.Granted {
		r.mu.Unlock()
		return 0, fmt.Errorf("%s", outcome.Reason)
	}
	deadline, reason, source := r.state.Deadline, r.state.Reason, r.state.Source
	used := r.deferralsUsed + 1
	policy := r.deferral

	// Re-schedule under the same options: it cancels the in-flight timers, bumps
	// the generation and emits a fresh lead notification quoting the new time —
	// which is exactly how the user learns the countdown moved.
	if err := r.scheduleLocked(outcome.NewDelay, deadline, reason, source, RebootOptions{Deferral: policy}); err != nil {
		r.mu.Unlock()
		return 0, err
	}

	// scheduleLocked reset the count from the ledger, so the increment is
	// re-applied after it. Ordering matters — do not fold this into the
	// re-schedule; TestDeferRefusesPastTheBudget pins it.
	r.deferralsUsed = used
	r.state.DeferralsUsed = used
	path := r.ledgerPath()
	r.mu.Unlock()

	if err := SaveDeferralLedger(path, deadline, used); err != nil {
		// Best-effort: losing the ledger costs the user an extra postponement
		// after an agent restart, it never lets them exceed the DEADLINE.
		log.Warn("failed to persist reboot deferral ledger", "error", err)
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
	r.mu.Unlock()

	// Abort an OS-level countdown, but only if one was actually started — i.e.
	// the schedule already passed OSInvokeAt. Before that the Go timers above
	// were the whole schedule and there is nothing for the OS to abort. The
	// distinction matters because not every platform can abort at all (BSD
	// shutdown(8), so macOS, has no cancel flag), and an unconditional attempt
	// would make every cancellation there look like a failure.
	if osInvoked && abort != nil {
		if err := abort(); err != nil {
			log.Warn("reboot cancelled locally but the OS countdown could not be aborted", "error", err)
			return fmt.Errorf("reboot schedule cleared, but the OS countdown could not be aborted: %w", err)
		}
	}
	return nil
}

// Stop stops the reboot manager and cancels any pending reboot.
func (r *RebootManager) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.stopped {
		return // already stopped, avoid double-close on stopChan
	}
	r.stopped = true
	r.cancelLocked()
	close(r.stopChan)
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

func (r *RebootManager) emitNotification(gen uint64, n RebootNotification) {
	r.mu.Lock()
	if r.stopped || gen != r.generation {
		r.mu.Unlock()
		return
	}
	notifyFn := r.notifyFn
	r.state.NotifiedUser = true
	r.state.NotificationSent = r.nowFn()
	r.mu.Unlock()

	if notifyFn != nil {
		notifyFn(n.Title, n.Body, n.Urgency)
	}
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
	r.osInvoked = true
	exec := r.execOSReboot
	r.mu.Unlock()

	// Persist history before rebooting
	r.saveRebootHistory()

	if exec == nil {
		log.Error("no OS reboot implementation for this platform")
		r.mu.Lock()
		r.osInvoked = false
		r.state.LastError = "no OS reboot implementation for this platform"
		r.mu.Unlock()
		return
	}
	if err := exec(grace); err != nil {
		r.mu.Lock()
		r.osInvoked = false
		r.state.LastError = fmt.Sprintf("OS reboot invocation failed: %v", err)
		r.mu.Unlock()
		// A failed shutdown invocation used to be discarded entirely: the old
		// code called exec.Command(...).Run() and ignored the error, so a
		// blocked or missing shutdown binary looked identical to a reboot.
		log.Error("failed to invoke OS reboot", "error", err, "grace", grace.String())
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
