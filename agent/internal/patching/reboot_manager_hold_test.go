// deadlineAction "hold" (#11065 W06): the overnight vendor-update reboot. Its
// deadline is the close of the device's maintenance window, and a restart that
// can no longer begin by then is dropped and reported, never forced into the
// working day. With no action the deadline keeps today's meaning: it bounds
// postponements, and a late restart still happens.
//
// Its own file, so the #3197 and #3207 suites stay unmodified: "absent action
// is today's behaviour" is only a real claim if those never had to change.
package patching

import (
	"strings"
	"testing"
	"time"
)

// holdOptions with max 0 is a hold schedule with deferral off.
func holdOptions(max, minutes int) RebootOptions {
	opts := RebootOptions{DeadlineAction: DeadlineActionHold}
	if max > 0 {
		opts.Deferral = allowDeferral(max, minutes).Deferral
	}
	return opts
}

func hasNotification(calls []notifyCall, title string) bool {
	for _, c := range calls {
		if c.title == title {
			return true
		}
	}
	return false
}

func TestHoldAtDeadlineCancelsInsteadOfForcing(t *testing.T) {
	rm, timers, notifications, osCalls, clock, _ := newDeferralTestManager(t, 3)
	deadline := clock.now().Add(60 * time.Minute)
	if err := rm.ScheduleWithOptions(15*time.Minute, deadline, "Vendor updates", "oem_update", holdOptions(2, 30)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	// The person at the machine postpones once; the restart moves to 45m.
	delay, err := rm.Defer()
	if err != nil {
		t.Fatalf("Defer: %v", err)
	}
	if delay != 45*time.Minute {
		t.Fatalf("postponed delay = %v, want 45m", delay)
	}
	if got := rm.State().DeadlineAction; got != string(DeadlineActionHold) {
		t.Fatalf("a postponement must keep the schedule's deadline action: got %q", got)
	}

	// The machine sleeps through the window close; the timer fires late.
	clock.advance(90 * time.Minute)
	timers.runAt(PlanReboot(delay).OSInvokeAt)

	if len(*osCalls) != 0 {
		t.Fatalf("the OS was told to reboot after the window closed: %v", *osCalls)
	}
	st := rm.State()
	if st.RebootScheduled {
		t.Fatal("a held restart must not stay scheduled")
	}
	if !st.Held || st.HeldAt.IsZero() {
		t.Fatalf("held = %v at %v, want the hold reported", st.Held, st.HeldAt)
	}
	if !strings.HasPrefix(st.LastError, RebootHeldReason) {
		t.Fatalf("LastError = %q, want it to start with %q", st.LastError, RebootHeldReason)
	}
	if len(rm.rebootHistory) != 0 {
		t.Fatal("a restart that never happened must not count against the circuit breaker")
	}
	if !hasNotification(*notifications, rebootHeldTitle) {
		t.Fatalf("the user was told a restart was coming and must be told it moved: %+v", *notifications)
	}

	// A fresh schedule clears the hold.
	if err := rm.Schedule(15*time.Minute, clock.now().Add(15*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if st := rm.State(); st.Held || !st.HeldAt.IsZero() || st.DeadlineAction != "" {
		t.Fatalf("a new schedule must clear the previous hold: %+v", st)
	}
}

func TestAbsentActionKeepsForceAtDeadline(t *testing.T) {
	rm, timers, _, osCalls, clock, _ := newDeferralTestManager(t, 3)
	deadline := clock.now().Add(60 * time.Minute)
	if err := rm.ScheduleWithOptions(15*time.Minute, deadline, "Patch", "patch_job", allowDeferral(2, 30)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	delay, err := rm.Defer()
	if err != nil {
		t.Fatalf("Defer: %v", err)
	}
	clock.advance(90 * time.Minute)
	timers.runAt(PlanReboot(delay).OSInvokeAt)

	if len(*osCalls) != 1 {
		t.Fatalf("osCalls = %v: with no deadline action a late restart still happens", *osCalls)
	}
	if st := rm.State(); st.Held || st.DeadlineAction != "" {
		t.Fatalf("state = %+v, want no hold", st)
	}
}

func TestNotificationsStillFire(t *testing.T) {
	rm, timers, notifications, osCalls, clock, _ := newDeferralTestManager(t, 3)
	const delay = 15 * time.Minute
	if err := rm.ScheduleWithOptions(delay, clock.now().Add(4*time.Hour), "Vendor updates", "oem_update", holdOptions(0, 0)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	plan := PlanReboot(delay)
	if got := rm.State().NotificationsPlanned; got != len(plan.Notifications) || got < 1 {
		t.Fatalf("NotificationsPlanned = %d, want the plan's %d (never zero, #3197)", got, len(plan.Notifications))
	}
	runLadder(timers, plan)
	if got := len(*notifications); got != len(plan.Notifications) {
		t.Fatalf("notifications = %d, want every rung of the ladder (%d)", got, len(plan.Notifications))
	}
	if len(*osCalls) != 1 || (*osCalls)[0] != plan.OSGrace {
		t.Fatalf("osCalls = %v, want one restart inside the window", *osCalls)
	}
	if rm.State().Held {
		t.Fatal("a restart that began inside the window was reported held")
	}
}

// A timer a little late (scheduling jitter) at a deadline the schedule lands on
// exactly is still inside the window.
func TestHoldToleratesTimerJitterAtTheDeadline(t *testing.T) {
	rm, timers, _, osCalls, clock, _ := newDeferralTestManager(t, 3)
	const delay = 15 * time.Minute
	if err := rm.ScheduleWithOptions(delay, clock.now().Add(delay), "Vendor updates", "oem_update", holdOptions(0, 0)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	plan := PlanReboot(delay)
	clock.advance(plan.OSInvokeAt + 20*time.Second)
	timers.runAt(plan.OSInvokeAt)
	if len(*osCalls) != 1 {
		t.Fatalf("osCalls = %v: twenty seconds of jitter must not drop the restart", *osCalls)
	}
}

// A warning rung that fires after the window closed (the machine slept) must
// not tell the user a restart is coming: the restart is dropped there.
func TestHoldDropsALateWarningRung(t *testing.T) {
	rm, timers, notifications, osCalls, clock, _ := newDeferralTestManager(t, 3)
	const delay = 30 * time.Minute
	if err := rm.ScheduleWithOptions(delay, clock.now().Add(40*time.Minute), "Vendor updates", "oem_update", holdOptions(0, 0)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	plan := PlanReboot(delay)
	clock.advance(3 * time.Hour)
	timers.runAt(plan.Notifications[1].After)

	for _, n := range *notifications {
		if n.title != rebootHeldTitle {
			t.Fatalf("a late rung warned of a restart that will not happen: %+v", n)
		}
	}
	if !hasNotification(*notifications, rebootHeldTitle) {
		t.Fatal("the hold was not announced")
	}
	if st := rm.State(); st.RebootScheduled || !st.Held {
		t.Fatalf("state = %+v, want the restart dropped and held", st)
	}
	timers.runAt(plan.OSInvokeAt)
	if len(*osCalls) != 0 {
		t.Fatal("the dropped restart's OS timer still fired")
	}
}

func TestHoldRespectsFlashGuard(t *testing.T) {
	g := useTestGuard(t)
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	rm, timers, _, osCalls, clock, _ := newDeferralTestManager(t, 3)
	const delay = 15 * time.Minute
	if err := rm.ScheduleWithOptions(delay, clock.now().Add(30*time.Minute), "Vendor updates", "oem_update", holdOptions(0, 0)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	plan := PlanReboot(delay)
	clock.advance(plan.OSInvokeAt)
	runLadder(timers, plan)
	if len(*osCalls) != 0 {
		t.Fatal("the OS was told to reboot during a firmware section")
	}
	if st := rm.State(); !st.RebootScheduled || st.Held {
		t.Fatalf("inside the window a flash holds the restart, it does not drop it: %+v", st)
	}

	// The flash runs past the window close. The retry drops the restart and
	// never asks the guard to admit a power action it would not take.
	clock.advance(time.Hour)
	fireHoldRetry(t, timers)
	if len(*osCalls) != 0 {
		t.Fatal("the OS was told to reboot after the window closed")
	}
	st := rm.State()
	if st.RebootScheduled || !st.Held {
		t.Fatalf("state = %+v, want held after the window closed", st)
	}
	if strings.Contains(st.LastError, "firmware update is in progress") {
		t.Fatalf("LastError = %q, want the hold, not the flash", st.LastError)
	}

	// The section ends: the dropped restart stays dropped.
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	fireHoldRetry(t, timers)
	if len(*osCalls) != 0 {
		t.Fatal("a dropped restart came back when the firmware section ended")
	}
}

func TestHoldRestartsWhenTheFlashEndsInsideTheWindow(t *testing.T) {
	g := useTestGuard(t)
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	rm, timers, notifications, osCalls, clock, _ := newDeferralTestManager(t, 3)
	const delay = 15 * time.Minute
	if err := rm.ScheduleWithOptions(delay, clock.now().Add(3*time.Hour), "Vendor updates", "oem_update", holdOptions(0, 0)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	plan := PlanReboot(delay)
	clock.advance(plan.OSInvokeAt)
	runLadder(timers, plan)
	clock.advance(20 * time.Minute)
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	fireHoldRetry(t, timers)
	if len(*osCalls) != 1 {
		t.Fatalf("osCalls = %v, want the restart once the flash ended inside the window", *osCalls)
	}
	if !hasNotification(*notifications, flashHoldResumeTitle) {
		t.Fatal("a restart resumed after a flash hold must be announced again")
	}
}

// Restart now from a hold schedule keeps the hold.
func TestRestartNowKeepsTheDeadlineAction(t *testing.T) {
	rm, _, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(time.Hour), "Vendor updates", "oem_update", holdOptions(0, 0)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	rm.mu.Lock()
	gen := rm.generation
	rm.mu.Unlock()
	if err := rm.restartNow(gen); err != nil {
		t.Fatalf("restartNow: %v", err)
	}
	if got := rm.State().DeadlineAction; got != string(DeadlineActionHold) {
		t.Fatalf("DeadlineAction after Restart now = %q, want hold", got)
	}
}

// Cancel clears the action with the rest of the schedule.
func TestCancelClearsTheDeadlineAction(t *testing.T) {
	rm, _, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(time.Hour), "Vendor updates", "oem_update", holdOptions(0, 0)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	if err := rm.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if st := rm.State(); st.DeadlineAction != "" || st.Held {
		t.Fatalf("state = %+v, want the action cleared and no hold", st)
	}
}
