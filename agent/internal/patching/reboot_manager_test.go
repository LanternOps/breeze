// Untagged on purpose — see reboot_plan_test.go. Before #3197 the whole
// RebootManager lived behind //go:build windows and had no test at all.
package patching

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type notifyCall struct {
	title   string
	body    string
	urgency string
}

// fakeTimers captures what Schedule handed to afterFunc so the ladder can be
// driven deterministically instead of waiting real minutes.
type fakeTimers struct {
	mu    sync.Mutex
	fired []time.Duration
	fns   map[time.Duration][]func()
	order []time.Duration
}

func newFakeTimers() *fakeTimers {
	return &fakeTimers{fns: map[time.Duration][]func(){}}
}

func (f *fakeTimers) afterFunc(d time.Duration, fn func()) *time.Timer {
	f.mu.Lock()
	f.fns[d] = append(f.fns[d], fn)
	f.order = append(f.order, d)
	f.mu.Unlock()
	// A stopped timer: the returned handle only ever has Stop() called on it.
	t := time.NewTimer(time.Hour)
	t.Stop()
	return t
}

// runAt invokes every callback registered for the given offset.
func (f *fakeTimers) runAt(d time.Duration) {
	f.mu.Lock()
	fns := append([]func(){}, f.fns[d]...)
	f.fired = append(f.fired, d)
	f.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
}

func (f *fakeTimers) offsets() []time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]time.Duration{}, f.order...)
}

// newTestManager builds a manager with every OS- and disk-touching seam faked.
func newTestManager(t *testing.T, maxPerDay int) (*RebootManager, *fakeTimers, *[]notifyCall, *[]time.Duration) {
	t.Helper()
	timers := newFakeTimers()
	var mu sync.Mutex
	notifications := []notifyCall{}
	osCalls := []time.Duration{}
	dir := t.TempDir()

	rm := &RebootManager{
		notifyFn: func(title, body, urgency string) {
			mu.Lock()
			defer mu.Unlock()
			notifications = append(notifications, notifyCall{title, body, urgency})
		},
		stopChan:         make(chan struct{}),
		maxRebootsPerDay: maxPerDay,
		nowFn:            time.Now,
		afterFunc:        timers.afterFunc,
		execOSReboot: func(grace time.Duration) error {
			mu.Lock()
			defer mu.Unlock()
			osCalls = append(osCalls, grace)
			return nil
		},
		abortOSReboot: func() error { return nil },
		historyPath:   func() string { return filepath.Join(dir, "reboot_history.json") },
	}
	return rm, timers, &notifications, &osCalls
}

// TestScheduleEmitsLeadNotificationImmediately is the #3197 end-to-end
// assertion at the manager level: a 5-minute reboot — the exact delay the API
// used to hardcode — now produces a warning the instant it is scheduled.
func TestScheduleEmitsLeadNotificationImmediately(t *testing.T) {
	rm, timers, notifications, osCalls := newTestManager(t, 3)

	if err := rm.Schedule(5*time.Minute, time.Now().Add(5*time.Minute), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}

	state := rm.State()
	if !state.RebootScheduled {
		t.Fatal("RebootScheduled=false after Schedule")
	}
	if state.NotificationsPlanned < 1 {
		t.Fatalf("NotificationsPlanned=%d, want >= 1 — zero here is the silent reboot", state.NotificationsPlanned)
	}

	// The lead notification is registered at offset zero.
	timers.runAt(0)
	if len(*notifications) != 1 {
		t.Fatalf("after the zero-offset timer: %d notifications, want 1: %+v", len(*notifications), *notifications)
	}
	if (*notifications)[0].urgency != "critical" {
		t.Errorf("lead urgency=%q, want critical at a 5-minute delay", (*notifications)[0].urgency)
	}
	if !rm.State().NotifiedUser {
		t.Error("NotifiedUser=false after a notification fired")
	}
	if len(*osCalls) != 0 {
		t.Errorf("OS reboot invoked at offset 0: %v — it belongs at the closing notice", *osCalls)
	}

	// The closing notice and the OS invocation share the 4-minute offset.
	timers.runAt(4 * time.Minute)
	if len(*notifications) != 2 {
		t.Fatalf("after the closing timer: %d notifications, want 2: %+v", len(*notifications), *notifications)
	}
	if len(*osCalls) != 1 {
		t.Fatalf("OS reboot invocations=%d, want 1", len(*osCalls))
	}
	if (*osCalls)[0] != time.Minute {
		t.Errorf("OS grace=%s, want 1m so the closing toast can render", (*osCalls)[0])
	}
	if rm.State().RebootScheduled {
		t.Error("RebootScheduled=true after the reboot was invoked")
	}
}

func TestScheduleRegistersEveryPlannedNotification(t *testing.T) {
	rm, timers, _, _ := newTestManager(t, 3)

	if err := rm.Schedule(65*time.Minute, time.Time{}, "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}

	plan := PlanReboot(65 * time.Minute)
	got := timers.offsets()
	// One timer per notification plus the OS timer.
	if len(got) != len(plan.Notifications)+1 {
		t.Fatalf("registered %d timers at %v, want %d (notifications) + 1 (OS)",
			len(got), got, len(plan.Notifications))
	}
	for i, n := range plan.Notifications {
		if got[i] != n.After {
			t.Errorf("timer %d at %s, want %s", i, got[i], n.After)
		}
	}
	if got[len(got)-1] != plan.OSInvokeAt {
		t.Errorf("OS timer at %s, want %s", got[len(got)-1], plan.OSInvokeAt)
	}
	if rm.State().NotificationsPlanned != len(plan.Notifications) {
		t.Errorf("NotificationsPlanned=%d, want %d", rm.State().NotificationsPlanned, len(plan.Notifications))
	}
}

func TestRescheduleReplacesTheEarlierScheduleAndRewarns(t *testing.T) {
	rm, timers, notifications, _ := newTestManager(t, 3)

	if err := rm.Schedule(60*time.Minute, time.Time{}, "First", "maintenance_window"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	first := len(timers.offsets())
	if err := rm.Schedule(15*time.Minute, time.Time{}, "Second", "patch_job"); err != nil {
		t.Fatalf("re-Schedule: %v", err)
	}

	if rm.State().Reason != "Second" {
		t.Errorf("Reason=%q, want the newest dispatch to win", rm.State().Reason)
	}
	// The replacement schedule registers its own zero-offset lead, so the user
	// whose countdown just changed is told about the new one.
	timers.runAt(0)
	if len(*notifications) == 0 {
		t.Fatal("a rescheduled reboot emitted no notification — the user's countdown changed silently")
	}
	if len(timers.offsets()) <= first {
		t.Error("re-Schedule registered no new timers")
	}
}

func TestCircuitBreakerBlocksRebootAndTellsTheUser(t *testing.T) {
	rm, timers, notifications, osCalls := newTestManager(t, 1)
	rm.rebootHistory = []time.Time{time.Now().Add(-time.Hour)}

	if err := rm.Schedule(5*time.Minute, time.Time{}, "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(4 * time.Minute)

	if len(*osCalls) != 0 {
		t.Errorf("OS reboot invoked despite the circuit breaker: %v", *osCalls)
	}
	if len(*notifications) == 0 {
		t.Fatal("circuit breaker fired with no user notification")
	}
	last := (*notifications)[len(*notifications)-1]
	if last.title != "Restart Blocked" {
		t.Errorf("last notification title=%q, want %q", last.title, "Restart Blocked")
	}
	if rm.State().RebootScheduled {
		t.Error("RebootScheduled=true after the circuit breaker blocked the reboot")
	}
}

func TestCancelBeforeOSCountdownDoesNotAbortTheOS(t *testing.T) {
	rm, timers, notifications, osCalls := newTestManager(t, 3)
	aborts := 0
	rm.abortOSReboot = func() error {
		aborts++
		return errors.New("no cancel flag on this platform")
	}

	if err := rm.Schedule(30*time.Minute, time.Time{}, "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if err := rm.Cancel(); err != nil {
		// The OS countdown never started, so a platform that cannot abort must
		// not turn this into a failure.
		t.Fatalf("Cancel before the OS countdown: %v", err)
	}
	if aborts != 0 {
		t.Errorf("abortOSReboot called %d times before the OS countdown started", aborts)
	}
	if rm.State().RebootScheduled {
		t.Error("RebootScheduled=true after Cancel")
	}

	// Timers were stopped, so the fake's callbacks are no longer wired to
	// anything the manager will honour — but assert nothing fires side effects.
	timers.runAt(29 * time.Minute)
	if len(*osCalls) != 0 {
		t.Errorf("OS reboot invoked after Cancel: %v", *osCalls)
	}
	_ = notifications
}

func TestCancelAfterOSCountdownSurfacesAbortFailure(t *testing.T) {
	rm, timers, _, _ := newTestManager(t, 3)
	rm.abortOSReboot = func() error { return errors.New("no cancel flag on this platform") }

	if err := rm.Schedule(5*time.Minute, time.Time{}, "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(4 * time.Minute) // OS countdown starts here

	// Schedule was cleared by the reboot invocation, so re-arm state the way a
	// console cancel arriving inside the final minute would find it.
	rm.mu.Lock()
	rm.state.RebootScheduled = true
	rm.mu.Unlock()

	if err := rm.Cancel(); err == nil {
		t.Fatal("Cancel returned nil while the OS countdown could not be aborted — that reports a cancellation that did not happen")
	}
}

func TestCancelWithNothingScheduled(t *testing.T) {
	rm, _, _, _ := newTestManager(t, 3)
	if err := rm.Cancel(); err == nil {
		t.Fatal("Cancel with no reboot scheduled returned nil, want an error")
	}
}

func TestStopPreventsNotificationsAndReboot(t *testing.T) {
	rm, timers, notifications, osCalls := newTestManager(t, 3)

	if err := rm.Schedule(5*time.Minute, time.Time{}, "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	rm.Stop()
	rm.Stop() // idempotent — must not double-close stopChan

	timers.runAt(0)
	timers.runAt(4 * time.Minute)

	if len(*notifications) != 0 {
		t.Errorf("notifications fired after Stop: %+v", *notifications)
	}
	if len(*osCalls) != 0 {
		t.Errorf("OS reboot invoked after Stop: %v", *osCalls)
	}
	if err := rm.Schedule(5*time.Minute, time.Time{}, "again", "patch_job"); err == nil {
		t.Error("Schedule after Stop returned nil, want an error")
	}
}

func TestOSRebootFailureIsNotSilent(t *testing.T) {
	rm, timers, _, _ := newTestManager(t, 3)
	called := 0
	rm.execOSReboot = func(time.Duration) error {
		called++
		return errors.New("shutdown: command not found")
	}

	if err := rm.Schedule(5*time.Minute, time.Time{}, "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(4 * time.Minute)

	if called != 1 {
		t.Fatalf("execOSReboot called %d times, want 1", called)
	}
	// A failed invocation must not leave the manager believing an OS countdown
	// is running, or a subsequent Cancel would try to abort a countdown that
	// never started.
	rm.mu.Lock()
	osInvoked := rm.osInvoked
	rm.mu.Unlock()
	if osInvoked {
		t.Error("osInvoked=true after the OS reboot invocation failed")
	}
}
