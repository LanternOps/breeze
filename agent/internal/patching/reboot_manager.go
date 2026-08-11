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
	// NotificationsPlanned is how many user warnings the current schedule will
	// emit. Always >= 1 for a scheduled reboot (#3197) — a zero here on a
	// scheduled reboot means a silent reboot, which is the defect this field
	// exists to make visible to the console.
	NotificationsPlanned int `json:"notificationsPlanned"`
}

// NotifyFunc is called to send a notification to the logged-in user.
type NotifyFunc func(title, body, urgency string)

// RebootManager handles reboot scheduling, notification, and execution.
type RebootManager struct {
	mu               sync.Mutex
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

	// Injectable seams for deterministic tests, following the repo's nowFn
	// convention (sessionbroker.Broker, watchdog.Clock). afterFunc in
	// particular is what lets the notification ladder be asserted without
	// waiting real minutes — the plan's shortest schedule is a minute long.
	nowFn         func() time.Time
	afterFunc     func(time.Duration, func()) *time.Timer
	execOSReboot  func(grace time.Duration) error
	abortOSReboot func() error
	historyPath   func() string
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
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.stopped {
		return fmt.Errorf("reboot manager is stopped")
	}

	// Cancel any existing schedule (this bumps the generation, orphaning any
	// callback from the superseded schedule).
	r.cancelLocked()
	r.osInvoked = false
	gen := r.generation

	plan := PlanReboot(delay)
	now := r.nowFn()
	r.state = RebootState{
		PendingReboot:        true,
		RebootScheduled:      true,
		ScheduledAt:          now.Add(plan.TotalDelay),
		Deadline:             deadline,
		Reason:               reason,
		Source:               source,
		NotificationsPlanned: len(plan.Notifications),
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
		"source", source)

	return nil
}

// Cancel cancels a scheduled reboot.
func (r *RebootManager) Cancel() error {
	r.mu.Lock()
	scheduled := r.state.RebootScheduled
	if !scheduled {
		r.mu.Unlock()
		return fmt.Errorf("no reboot scheduled")
	}
	r.cancelLocked()
	r.state.RebootScheduled = false
	r.state.ScheduledAt = time.Time{}
	r.state.Deadline = time.Time{}
	r.state.NotificationsPlanned = 0
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
		r.mu.Unlock()
		return
	}
	if err := exec(grace); err != nil {
		r.mu.Lock()
		r.osInvoked = false
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
