package patching

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
)

func useTestGuard(t *testing.T) *flashguard.Guard {
	t.Helper()
	g := flashguard.New(t.TempDir(), flashguard.WithLockWait(50*time.Millisecond))
	t.Cleanup(flashguard.SetDefault(g))
	return g
}

// fireHoldRetry runs only the newest hold retry. A real timer fires once; the
// fake keeps every callback it was ever given for an offset.
func fireHoldRetry(t *testing.T, timers *fakeTimers) {
	t.Helper()
	timers.mu.Lock()
	fns := timers.fns[flashHoldRetryInterval]
	timers.mu.Unlock()
	if len(fns) == 0 {
		t.Fatal("no hold retry was armed")
	}
	fns[len(fns)-1]()
}

// runLadder fires every offset in the plan once, ending at the OS invocation. The
// closing notice shares its offset with the invocation, and runAt fires everything
// at an offset, so walking the notifications alone would invoke the OS twice.
func runLadder(timers *fakeTimers, plan RebootPlan) {
	seen := map[time.Duration]bool{plan.OSInvokeAt: true}
	for _, n := range plan.Notifications {
		if !seen[n.After] {
			seen[n.After] = true
			timers.runAt(n.After)
		}
	}
	timers.runAt(plan.OSInvokeAt)
}

func TestRebootTimerHoldsDuringSectionThenFires(t *testing.T) {
	g := useTestGuard(t)
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	rm, timers, notifications, osCalls := newTestManager(t, 3)
	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}

	// The whole ladder still reaches the user: the guard only moves the moment
	// the OS is told.
	plan := PlanReboot(delay)
	runLadder(timers, plan)
	if got := len(*notifications); got != len(plan.Notifications) {
		t.Fatalf("notifications = %d, want the plan's %d", got, len(plan.Notifications))
	}
	if len(*osCalls) != 0 {
		t.Fatal("the OS was told to reboot during a firmware section")
	}
	state := rm.State()
	if !state.RebootScheduled {
		t.Fatal("a held reboot must stay scheduled")
	}
	if !strings.Contains(state.LastError, "firmware update") {
		t.Fatalf("LastError = %q, the console should be able to see why", state.LastError)
	}
	if len(rm.rebootHistory) != 0 {
		t.Fatal("a held reboot must not count against the circuit breaker")
	}

	fireHoldRetry(t, timers)
	if len(*osCalls) != 0 {
		t.Fatal("the OS was told to reboot while the section was still open")
	}

	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	fireHoldRetry(t, timers)
	if len(*osCalls) != 1 || (*osCalls)[0] != plan.OSGrace {
		t.Fatalf("osCalls = %v, want one call with the plan's grace %v", *osCalls, plan.OSGrace)
	}
	if got := rm.State().LastError; got != "" {
		t.Fatalf("LastError = %q after the reboot went ahead", got)
	}

	// The ladder may have finished hours ago. No reboot is ever silent, so the
	// user is told again before it goes ahead.
	if got := len(*notifications); got != len(plan.Notifications)+1 {
		t.Fatalf("notifications = %d, want the plan's %d plus one resume notice", got, len(plan.Notifications))
	}
	if last := (*notifications)[len(*notifications)-1]; last.title != flashHoldResumeTitle {
		t.Fatalf("last notification = %+v, want the resume notice", last)
	}
}

func TestCancelDuringAHoldCallsTheRebootOff(t *testing.T) {
	g := useTestGuard(t)
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	rm, timers, _, osCalls := newTestManager(t, 3)
	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(PlanReboot(delay).OSInvokeAt)

	if err := rm.Cancel(); err != nil {
		t.Fatalf("Cancel during a hold: %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	fireHoldRetry(t, timers)
	if len(*osCalls) != 0 {
		t.Fatal("a cancelled reboot fired from its hold retry")
	}
}

// A reboot rescheduled during a hold starts a clean ladder: no leftover resume
// notice, no second reboot from the old retry.
func TestRescheduleDuringAHoldReplacesIt(t *testing.T) {
	g := useTestGuard(t)
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	rm, timers, notifications, osCalls := newTestManager(t, 3)
	const first = 15 * time.Minute
	if err := rm.Schedule(first, time.Now().Add(first), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(PlanReboot(first).OSInvokeAt)

	const second = 30 * time.Minute
	if err := rm.Schedule(second, time.Now().Add(second), "Patch install", "patch_job"); err != nil {
		t.Fatalf("re-Schedule: %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	fireHoldRetry(t, timers)
	if len(*osCalls) != 0 {
		t.Fatal("the superseded schedule's retry fired")
	}
	timers.runAt(PlanReboot(second).OSInvokeAt)
	if len(*osCalls) != 1 {
		t.Fatalf("osCalls = %d, want 1 from the new schedule", len(*osCalls))
	}
	for _, n := range *notifications {
		if n.title == flashHoldResumeTitle {
			t.Fatal("a fresh schedule sent the resume notice of the one it replaced")
		}
	}
}

// With no section the reboot behaves exactly as it did before the guard.
func TestRebootWithNoSectionIsUnchanged(t *testing.T) {
	useTestGuard(t)
	rm, timers, notifications, osCalls := newTestManager(t, 3)
	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	plan := PlanReboot(delay)
	runLadder(timers, plan)

	if len(*osCalls) != 1 || (*osCalls)[0] != plan.OSGrace {
		t.Fatalf("osCalls = %v, want one call with grace %v", *osCalls, plan.OSGrace)
	}
	if got := len(*notifications); got != len(plan.Notifications) {
		t.Fatalf("notifications = %d, want exactly the plan's %d", got, len(plan.Notifications))
	}
	if got := rm.State().LastError; got != "" {
		t.Fatalf("LastError = %q", got)
	}
	if got := len(timers.fns[flashHoldRetryInterval]); got != 0 {
		t.Fatalf("armed %d hold retries with no section", got)
	}
}

// Admission spans the OS invocation, so a flash cannot start between the check
// and the shutdown.
func TestAdmissionIsHeldThroughTheOSInvocation(t *testing.T) {
	g := useTestGuard(t)
	rm, timers, _, _ := newTestManager(t, 3)
	var enterErr error
	rm.execOSReboot = func(time.Duration) error {
		_, enterErr = g.Enter("bios", "cmd-1", time.Hour)
		return nil
	}
	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(PlanReboot(delay).OSInvokeAt)

	if !errors.Is(enterErr, flashguard.ErrPowerActionPending) {
		t.Fatalf("Enter during the invocation = %v, want ErrPowerActionPending", enterErr)
	}
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("admission was not released after the invocation: %v", err)
	}
	_ = release()
}

// Every path out of the invocation lets go of the admission.
func TestAdmissionIsReleasedWhenTheCircuitBreakerRefuses(t *testing.T) {
	g := useTestGuard(t)
	rm, timers, _, osCalls := newTestManager(t, 1)
	rm.rebootHistory = []time.Time{time.Now().Add(-time.Hour)}
	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(PlanReboot(delay).OSInvokeAt)
	if len(*osCalls) != 0 {
		t.Fatal("setup: the breaker should have refused")
	}
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("the refused reboot kept its admission: %v", err)
	}
	_ = release()
}

func TestOSCountdownArmedFollowsTheCountdown(t *testing.T) {
	useTestGuard(t)
	rm, timers, _, _ := newTestManager(t, 3)
	now := time.Now()
	rm.nowFn = func() time.Time { return now }
	if rm.OSCountdownArmed() {
		t.Fatal("armed before anything was scheduled")
	}
	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, now.Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if rm.OSCountdownArmed() {
		t.Fatal("a schedule still on the agent's timers is not an OS countdown: it would hold for a flash")
	}
	plan := PlanReboot(delay)
	timers.runAt(plan.OSInvokeAt)
	if !rm.OSCountdownArmed() {
		t.Fatal("not armed after the OS was told")
	}
	if err := rm.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if rm.OSCountdownArmed() {
		t.Fatal("still armed after the countdown was aborted")
	}
}

// A countdown someone aborted outside Breeze must not refuse flashes for ever.
func TestOSCountdownArmedAgesOut(t *testing.T) {
	useTestGuard(t)
	rm, timers, _, _ := newTestManager(t, 3)
	now := time.Now()
	rm.nowFn = func() time.Time { return now }
	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, now.Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	plan := PlanReboot(delay)
	timers.runAt(plan.OSInvokeAt)
	now = now.Add(plan.OSGrace + flashguard.CountdownSlack)
	if rm.OSCountdownArmed() {
		t.Fatal("armed past the end of the countdown")
	}
}
