// Lifecycle invariants around the moment a reboot stops being the agent's and
// becomes the operating system's (issue #3207, wave 4 review findings).
//
// Three windows live in here, all of them found by reading rather than by a
// failure in the field, and all three able to take a machine down at a time
// nobody asked for:
//
//   - Cancel's abort runs outside the lock, so a schedule armed during it would
//     be killed by an abort that was never about it.
//   - A deadline equal to the current schedule bought a postponement that moved
//     nothing while spending the user's budget.
//   - Stop could return while the shutdown command was still being handed to
//     the OS, so a caller believed the manager was quiescent while a reboot was
//     already committed.
package patching

import (
	"strings"
	"testing"
	"time"
)

// scheduleAndReachTheOSCountdown schedules a reboot and drives the ladder to
// the point where the OS-level countdown is live.
func scheduleAndReachTheOSCountdown(t *testing.T, rm *RebootManager, timers *fakeTimers, delay time.Duration) {
	t.Helper()
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(PlanReboot(delay).OSInvokeAt)
}

// TestCancelsAbortCannotKillANewerCountdown pins the fix for the first window.
//
// Cancel deliberately runs abortOSReboot outside the lock — the abort is an
// exec with a thirty-second timeout, and holding the lock across it would stall
// State(), the timer callbacks and every other operation. The cost was that a
// Schedule landing inside that window could arm a fresh countdown which the
// still-pending `shutdown -c` would then cancel: the manager would report a
// scheduled reboot that the OS had already been told to forget.
func TestCancelsAbortCannotKillANewerCountdown(t *testing.T) {
	rm, timers, _, _ := newTestManager(t, 3)
	entered := make(chan struct{})
	release := make(chan struct{})
	rm.abortOSReboot = func() error {
		close(entered)
		<-release
		return nil
	}

	const delay = 15 * time.Minute
	scheduleAndReachTheOSCountdown(t, rm, timers, delay)

	rm.mu.Lock()
	live := rm.osInvoked
	rm.mu.Unlock()
	if !live {
		t.Fatal("expected an OS countdown to be live after OSInvokeAt")
	}

	cancelled := make(chan error, 1)
	go func() { cancelled <- rm.Cancel() }()
	<-entered

	err := rm.Schedule(delay, time.Now().Add(delay), "A different patch job", "patch_job")
	if err == nil {
		t.Fatal("a reboot was scheduled while a shutdown abort was still in flight; " +
			"the abort would have silently killed it")
	}
	if !strings.Contains(err.Error(), "abort") {
		t.Errorf("refusal %q does not tell the caller an abort is in flight", err)
	}

	close(release)
	if err := <-cancelled; err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	// Once the abort has landed there is nothing left to race, so the manager
	// must accept work again — a permanent refusal would be its own bug.
	if err := rm.Schedule(delay, time.Now().Add(delay), "A different patch job", "patch_job"); err != nil {
		t.Fatalf("Schedule after the abort completed: %v", err)
	}
}

// TestDeferIsRefusedWhileAnAbortIsInFlight is the same window seen from the
// other entry point: a postponement re-schedules, so it must be refused for
// exactly as long as a new schedule is.
func TestDeferIsRefusedWhileAnAbortIsInFlight(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	entered := make(chan struct{})
	release := make(chan struct{})
	rm.abortOSReboot = func() error {
		close(entered)
		<-release
		return nil
	}

	const delay = 15 * time.Minute
	if err := rm.ScheduleWithOptions(delay, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(3, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(PlanReboot(delay).OSInvokeAt)

	cancelled := make(chan error, 1)
	go func() { cancelled <- rm.Cancel() }()
	<-entered

	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer succeeded while a shutdown abort was in flight")
	}

	close(release)
	if err := <-cancelled; err != nil {
		t.Fatalf("Cancel: %v", err)
	}
}

// TestComputeDeferralRefusesADeadlineThatMovesNothing pins the second window.
//
// With deadline == scheduledAt the clamp pulled the target back onto the time
// the reboot was already set for. That is not "before base", so the old guard
// let it through: the user spent a postponement, the countdown did not move,
// and the ladder simply re-armed at the same instant.
func TestComputeDeferralRefusesADeadlineThatMovesNothing(t *testing.T) {
	now := time.Now()
	scheduled := now.Add(30 * time.Minute)
	policy := DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}

	out := ComputeDeferral(policy, 0, now, scheduled, scheduled)
	if out.Granted {
		t.Fatalf("granted a postponement to the time already scheduled: %+v", out)
	}
	if out.Reason != deferralReasonDeadlineReached {
		t.Errorf("reason = %q, want %q", out.Reason, deferralReasonDeadlineReached)
	}
}

// TestComputeDeferralRefusesADeadlineInsideTheCurrentSchedule covers the
// neighbouring case: a deadline that would drag the restart FORWARD. Already
// refused before this change; asserted here so the tightened comparison cannot
// be loosened back without a failure.
func TestComputeDeferralRefusesADeadlineBeforeTheCurrentSchedule(t *testing.T) {
	now := time.Now()
	scheduled := now.Add(30 * time.Minute)
	policy := DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}

	out := ComputeDeferral(policy, 0, now, scheduled, now.Add(20*time.Minute))
	if out.Granted {
		t.Fatalf("granted a postponement that pulls the restart forward: %+v", out)
	}
}

// TestComputeDeferralStillGrantsASecondOfRoom guards the other direction: the
// tightened comparison must not refuse a genuine, if tiny, postponement.
func TestComputeDeferralStillGrantsASecondOfRoom(t *testing.T) {
	now := time.Now()
	scheduled := now.Add(30 * time.Minute)
	policy := DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}

	out := ComputeDeferral(policy, 0, now, scheduled, scheduled.Add(time.Second))
	if !out.Granted {
		t.Fatalf("refused a postponement with a second of room: %+v", out)
	}
	if want := 30*time.Minute + time.Second; out.NewDelay != want {
		t.Errorf("NewDelay = %s, want %s", out.NewDelay, want)
	}
}

// TestNoBudgetIsSpentWhenTheDeadlineLeavesNoRoom is the manager-level half of
// the second fix: the rung must offer no button, spend nothing, write nothing —
// and still warn the user, because a rung that goes quiet is #3197 again.
func TestNoBudgetIsSpentWhenTheDeadlineLeavesNoRoom(t *testing.T) {
	rm, timers, notifications, _, clock, prompts := newPromptTestManager(t, 3,
		rebootActionPostpone(time.Hour))
	ledger := rm.ledgerPath()
	scheduled := clock.now().Add(30 * time.Minute)
	if err := rm.ScheduleWithOptions(30*time.Minute, scheduled, "Patch", "patch_job",
		allowDeferral(3, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer granted a postponement onto the time already scheduled")
	}
	if used := rm.State().DeferralsUsed; used != 0 {
		t.Errorf("DeferralsUsed = %d, want 0 — a refused postponement spends nothing", used)
	}
	if got := LoadDeferralLedger(ledger, scheduled, clock.now()); got != 0 {
		t.Errorf("ledger recorded %d, want 0", got)
	}

	timers.runAt(0)
	// No dialog: offering a button ComputeDeferral would refuse is worse than
	// offering none.
	if len(*prompts) != 0 {
		t.Errorf("a postponement was offered with no room to postpone into: %+v", *prompts)
	}
	// But the warning still lands.
	if len(*notifications) == 0 {
		t.Fatal("the rung emitted no warning at all")
	}
	last := (*notifications)[len(*notifications)-1]
	if !strings.Contains(last.body, "no longer be postponed") {
		t.Errorf("warning body %q does not tell the user postponement is unavailable", last.body)
	}
}

// TestStopWaitsForACommittedOSReboot pins the third window.
//
// The decision recorded here: once execOSReboot has been entered the reboot
// belongs to the operating system and proceeds. Stop cannot recall it — that is
// the same honesty rule Cancel already applies — so Stop's job is not to try,
// but to refuse to RETURN while the invocation is mid-flight. A Stop that
// returned there told its caller the manager was quiescent moments before the
// machine went down.
func TestStopWaitsForACommittedOSReboot(t *testing.T) {
	rm, timers, _, _ := newTestManager(t, 3)
	entered := make(chan struct{})
	release := make(chan struct{})
	rm.execOSReboot = func(time.Duration) error {
		close(entered)
		<-release
		return nil
	}

	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	go timers.runAt(PlanReboot(delay).OSInvokeAt)
	<-entered

	stopped := make(chan struct{})
	go func() {
		rm.Stop()
		close(stopped)
	}()

	select {
	case <-stopped:
		t.Fatal("Stop returned while the shutdown command was still being handed to the OS")
	case <-time.After(200 * time.Millisecond):
	}

	close(release)
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop never returned after the OS invocation completed")
	}

	rm.mu.Lock()
	invoked := rm.osInvoked
	rm.mu.Unlock()
	if !invoked {
		t.Error("the committed reboot was forgotten; a status dump would deny a reboot that is happening")
	}
}

// TestStopBeforeTheInvokePreventsTheReboot is the other side of the same
// decision: before the command is handed over, Stop really does call it off.
func TestStopBeforeTheInvokePreventsTheReboot(t *testing.T) {
	rm, timers, _, osCalls := newTestManager(t, 3)

	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	rm.Stop()
	timers.runAt(PlanReboot(delay).OSInvokeAt)

	if len(*osCalls) != 0 {
		t.Fatalf("the OS reboot fired after Stop: %v", *osCalls)
	}
}

// TestStopIsIdempotentWhileAnInvokeIsInFlight guards the added wait against the
// obvious way to get it wrong: a second Stop must not block on a channel the
// first one already consumed, and must not double-close stopChan.
func TestStopIsIdempotentWhileAnInvokeIsInFlight(t *testing.T) {
	rm, timers, _, _ := newTestManager(t, 3)
	entered := make(chan struct{})
	release := make(chan struct{})
	rm.execOSReboot = func(time.Duration) error {
		close(entered)
		<-release
		return nil
	}

	const delay = 15 * time.Minute
	if err := rm.Schedule(delay, time.Now().Add(delay), "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	go timers.runAt(PlanReboot(delay).OSInvokeAt)
	<-entered

	first := make(chan struct{})
	go func() { rm.Stop(); close(first) }()
	second := make(chan struct{})
	go func() { rm.Stop(); close(second) }()

	close(release)
	for _, ch := range []chan struct{}{first, second} {
		select {
		case <-ch:
		case <-time.After(5 * time.Second):
			t.Fatal("a concurrent Stop never returned")
		}
	}
}
