// Untagged on purpose — see reboot_plan.go. The prompt seam exists precisely so
// the state machine behind the dialog is asserted without a UI.
package patching

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type promptCall struct {
	title   string
	body    string
	urgency string
	actions []string
	timeout time.Duration
}

// newPromptTestManager extends newDeferralTestManager with a scripted prompt
// seam. replies is consulted per call, in order; a short list means every later
// call returns "" (no decision).
func newPromptTestManager(t *testing.T, maxPerDay int, replies ...string) (
	*RebootManager, *fakeTimers, *[]notifyCall, *[]time.Duration, *fakeClock, *[]promptCall,
) {
	t.Helper()
	rm, timers, notifications, osCalls, clock, _ := newDeferralTestManager(t, maxPerDay)
	var mu sync.Mutex
	prompts := []promptCall{}
	rm.promptFn = func(title, body, urgency string, actions []string, timeout time.Duration) (string, bool) {
		mu.Lock()
		i := len(prompts)
		prompts = append(prompts, promptCall{title, body, urgency, append([]string{}, actions...), timeout})
		mu.Unlock()
		if i < len(replies) {
			return replies[i], true
		}
		return "", true
	}
	return rm, timers, notifications, osCalls, clock, &prompts
}

// TestPromptOfferedOnlyWhileDeferralsRemain: offering a button that Defer() will
// refuse is worse than offering none.
func TestPromptOfferedOnlyWhileDeferralsRemain(t *testing.T) {
	rm, timers, _, _, clock, prompts := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(1, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0) // lead rung: budget available -> prompt with two buttons
	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	if len((*prompts)[0].actions) != 2 {
		t.Fatalf("actions = %v, want 2 buttons", (*prompts)[0].actions)
	}
	if rm.State().DeferralsUsed != 1 {
		t.Fatalf("DeferralsUsed = %d, want 1", rm.State().DeferralsUsed)
	}

	before := len(*prompts)
	timers.runAt(0) // the re-scheduled lead rung: budget now exhausted
	if len(*prompts) != before {
		t.Errorf("a prompt was offered with zero deferrals remaining: %v", (*prompts)[before].actions)
	}
}

// TestPostponeClickDefersTheSchedule proves the click really moves the countdown
// rather than just recording an intention.
func TestPostponeClickDefersTheSchedule(t *testing.T) {
	rm, timers, _, osCalls, clock, _ := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	st := rm.State()
	if st.DeferralsUsed != 1 {
		t.Errorf("DeferralsUsed = %d, want 1", st.DeferralsUsed)
	}
	if !st.RebootScheduled {
		t.Error("RebootScheduled = false after a postponement")
	}
	if len(*osCalls) != 0 {
		t.Fatal("a postponement invoked the OS reboot")
	}
	// W2 adds the window to the SCHEDULED time, not to now, so a 15-minute
	// schedule postponed by 60 minutes now lands 75 minutes out.
	want := PlanReboot(75 * time.Minute).OSInvokeAt
	found := false
	for _, off := range timers.offsets() {
		if off == want {
			found = true
		}
	}
	if !found {
		t.Errorf("no timer armed at %v after the postponement; offsets = %v", want, timers.offsets())
	}
}

// TestRestartNowShortensTheCountdownWithoutSkippingTheClosingNotice: "Restart
// now" must NOT reboot instantly. The closing notice still has to render before
// the session goes away, which is the exact race #3197 fixed.
func TestRestartNowShortensTheCountdownWithoutSkippingTheClosingNotice(t *testing.T) {
	rm, timers, notifications, osCalls, clock, _ := newPromptTestManager(t, 3, RebootActionRestartNow)
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*osCalls) != 0 {
		t.Fatal("Restart now invoked the OS reboot synchronously")
	}
	if rm.State().DeferralsUsed != 0 {
		t.Error("Restart now consumed a postponement")
	}

	plan := PlanReboot(MinRebootDelay)
	before := len(*notifications)
	timers.runAt(plan.OSInvokeAt)
	if len(*notifications) <= before {
		t.Error("the shortened schedule emitted no closing notice before the OS invocation")
	}
	if len(*osCalls) != 1 {
		t.Fatalf("osCalls = %d, want 1 after the shortened countdown elapsed", len(*osCalls))
	}
	if (*osCalls)[0] < time.Minute {
		t.Errorf("OS grace = %v, want at least a minute so the closing toast renders", (*osCalls)[0])
	}
}

// TestNoAnswerLeavesTheScheduleExactlyAsItWas: silence is never a postponement
// and never an acceleration.
func TestNoAnswerLeavesTheScheduleExactlyAsItWas(t *testing.T) {
	rm, timers, _, osCalls, clock, prompts := newPromptTestManager(t, 3) // no replies -> ""
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	scheduledAt := rm.State().ScheduledAt
	offsetsBefore := len(timers.offsets())

	timers.runAt(0)

	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	st := rm.State()
	if st.DeferralsUsed != 0 {
		t.Error("silence granted a postponement")
	}
	if !st.ScheduledAt.Equal(scheduledAt) {
		t.Errorf("ScheduledAt moved from %v to %v on no answer", scheduledAt, st.ScheduledAt)
	}
	if got := len(timers.offsets()); got != offsetsBefore {
		t.Errorf("silence re-armed the schedule: %d timers, want %d", got, offsetsBefore)
	}
	if len(*osCalls) != 0 {
		t.Error("silence invoked the OS reboot early")
	}
}

// TestPromptIsNeverOfferedOnTheClosingRung: the critical notice fires at
// OSInvokeAt, and Defer() is refused from that moment on because the countdown is
// in the OS. A button there would always fail.
func TestPromptIsNeverOfferedOnTheClosingRung(t *testing.T) {
	rm, timers, notifications, _, clock, prompts := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	plan := PlanReboot(60 * time.Minute)
	timers.runAt(plan.OSInvokeAt)

	if len(*prompts) != 0 {
		t.Fatalf("the closing rung offered a button: %v", (*prompts)[0].actions)
	}
	if len(*notifications) == 0 {
		t.Fatal("the closing rung emitted no notification at all")
	}
}

// TestPromptIsNeverOfferedWhenTheWholeScheduleCollapses covers PlanReboot's
// single-notification case (a delay at or near MinRebootDelay), where the only
// rung IS the closing one and its offset is zero.
func TestPromptIsNeverOfferedWhenTheWholeScheduleCollapses(t *testing.T) {
	rm, timers, notifications, _, clock, prompts := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	if err := rm.ScheduleWithOptions(MinRebootDelay, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*prompts) != 0 {
		t.Fatalf("the collapsed schedule's only rung offered a button: %v", (*prompts)[0].actions)
	}
	if len(*notifications) != 1 {
		t.Fatalf("notifications = %d, want 1 — the user must still be warned", len(*notifications))
	}
}

// TestPromptAbsentFallsBackToAPlainNotification: no helper session (every Linux
// box before W4, and Windows at the logon screen). The #3197 invariant does not
// depend on the prompt.
func TestPromptAbsentFallsBackToAPlainNotification(t *testing.T) {
	rm, timers, notifications, _, clock, _ := newDeferralTestManager(t, 3) // promptFn stays nil
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*notifications) != 1 {
		t.Fatalf("notifications = %d, want 1 — the user must still be warned", len(*notifications))
	}
	if rm.State().DeferralsUsed != 0 {
		t.Error("a nil prompt seam deferred something")
	}
}

// TestDeferralOffTakesTheIdenticalPathItTakesToday is the W3 acceptance criterion
// that protects every existing deployment: with deferral off, nothing about the
// notification path may change.
func TestDeferralOffTakesTheIdenticalPathItTakesToday(t *testing.T) {
	rm, timers, notifications, _, clock, prompts := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	if err := rm.Schedule(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}

	timers.runAt(0)

	if len(*prompts) != 0 {
		t.Fatalf("a non-deferrable reboot offered a postponement: %v", (*prompts)[0].actions)
	}
	if len(*notifications) != 1 {
		t.Fatalf("notifications = %d, want 1", len(*notifications))
	}
	if body := (*notifications)[0].body; strings.Contains(strings.ToLower(body), "postpone") {
		t.Errorf("a non-deferrable reboot mentioned postponement: %q", body)
	}
}

// TestPromptBodyStatesTheRemainingPostponements: a user who cannot tell how much
// budget is left cannot plan around it.
func TestPromptBodyStatesTheRemainingPostponements(t *testing.T) {
	rm, timers, _, _, clock, prompts := newPromptTestManager(t, 3) // no answer
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(3, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	body := (*prompts)[0].body
	if !strings.Contains(body, "3 more times") {
		t.Errorf("prompt body %q does not say how many postponements remain", body)
	}
	if !strings.Contains(body, "restart") && !strings.Contains(body, "Restart") {
		t.Errorf("prompt body %q lost the original warning text", body)
	}
}

// TestExhaustedBudgetTellsTheUserTheyCannotPostponeAgain: the button is gone, but
// silently dropping it would leave a user who postponed twice expecting a third
// chance.
func TestExhaustedBudgetTellsTheUserTheyCannotPostponeAgain(t *testing.T) {
	rm, timers, notifications, _, clock, prompts := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(1, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0) // spends the only postponement
	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	before := len(*notifications)

	timers.runAt(0) // the re-scheduled lead rung, budget now exhausted
	if len(*notifications) <= before {
		t.Fatal("the re-scheduled lead rung emitted no notification")
	}
	body := (*notifications)[len(*notifications)-1].body
	if !strings.Contains(strings.ToLower(body), "no longer be postponed") {
		t.Errorf("notification body %q does not tell the user the budget is spent", body)
	}
}

// TestPromptIsNotOfferedOnceTheDeadlineLeavesNoRoom: the counter is a UX
// affordance, the DEADLINE is the guarantee (#3253). A budget with postponements
// left on paper still yields no button once the deadline sits before the
// currently scheduled time, because clamping to it would pull the restart
// FORWARD — which ComputeDeferral refuses outright.
func TestPromptIsNotOfferedOnceTheDeadlineLeavesNoRoom(t *testing.T) {
	rm, timers, notifications, _, clock, prompts := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	// Five postponements left on paper, but the deadline is already behind the
	// scheduled time — a stale deadline, or a clock step.
	if err := rm.ScheduleWithOptions(30*time.Minute, clock.now().Add(5*time.Minute), "Patch", "patch_job",
		allowDeferral(5, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*prompts) != 0 {
		t.Fatalf("a postponement was offered past the deadline: %v", (*prompts)[0].actions)
	}
	if len(*notifications) != 1 {
		t.Fatalf("notifications = %d, want 1 — the user must still be warned", len(*notifications))
	}
}

// TestPromptDoesNotHoldTheManagerLock: the dialog blocks for up to two minutes.
// Holding r.mu across it would stall State(), Cancel() and every timer callback —
// including the OS invocation.
func TestPromptDoesNotHoldTheManagerLock(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	inPrompt := make(chan struct{})
	release := make(chan struct{})
	rm.promptFn = func(string, string, string, []string, time.Duration) (string, bool) {
		close(inPrompt)
		<-release
		return "", true
	}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	done := make(chan struct{})
	go func() {
		timers.runAt(0)
		close(done)
	}()
	<-inPrompt

	stated := make(chan RebootState, 1)
	go func() { stated <- rm.State() }()
	select {
	case <-stated:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("State() blocked while a prompt was on screen — the manager lock is held across the dialog")
	}

	close(release)
	<-done
}

// TestPostponeIsRefusedAfterACancelAndTheUserIsTold: a technician cancelling from
// the console while the signed-in user answers the prompt is exactly the shape
// this wave creates. The click must not resurrect the cancelled reboot, and the
// user must not be left thinking their postponement worked.
func TestPostponeIsRefusedAfterACancelAndTheUserIsTold(t *testing.T) {
	rm, timers, notifications, osCalls, clock, _ := newDeferralTestManager(t, 3)
	inPrompt := make(chan struct{})
	release := make(chan struct{})
	rm.promptFn = func(_, _, _ string, actions []string, _ time.Duration) (string, bool) {
		close(inPrompt)
		<-release
		return actions[1], true // Postpone
	}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	done := make(chan struct{})
	go func() {
		timers.runAt(0)
		close(done)
	}()
	<-inPrompt

	if err := rm.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	close(release)
	<-done

	st := rm.State()
	if st.RebootScheduled {
		t.Fatal("a postponement answered after Cancel resurrected the reboot")
	}
	if st.DeferralsUsed != 0 {
		t.Errorf("DeferralsUsed = %d after a cancelled reboot, want 0", st.DeferralsUsed)
	}
	if len(*osCalls) != 0 {
		t.Error("the cancelled reboot still invoked the OS")
	}
	var told bool
	for _, n := range *notifications {
		if strings.Contains(n.title, "Cannot Be Postponed") {
			told = true
		}
	}
	if !told {
		t.Errorf("the user was never told the postponement failed; notifications = %+v", *notifications)
	}
}

// TestRestartNowIsRefusedAfterACancel is the same race for the other button.
// ScheduleWithOptions has no generation check of its own, so a "Restart now"
// answered after a cancellation would arm a brand-new reboot the operator had
// just called off.
func TestRestartNowIsRefusedAfterACancel(t *testing.T) {
	rm, timers, _, osCalls, clock, _ := newDeferralTestManager(t, 3)
	inPrompt := make(chan struct{})
	release := make(chan struct{})
	rm.promptFn = func(string, string, string, []string, time.Duration) (string, bool) {
		close(inPrompt)
		<-release
		return RebootActionRestartNow, true
	}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	done := make(chan struct{})
	go func() {
		timers.runAt(0)
		close(done)
	}()
	<-inPrompt

	if err := rm.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	close(release)
	<-done

	if rm.State().RebootScheduled {
		t.Fatal("Restart now answered after Cancel resurrected the reboot")
	}
	if len(*osCalls) != 0 {
		t.Error("the cancelled reboot still invoked the OS")
	}
}

// TestPromptTimeoutNeverOutlivesTheNextRung: a dialog still on screen when the
// next warning fires means the next warning cannot be shown (the helper refuses to
// stack modal dialogs), so the ladder would silently lose a rung.
func TestPromptTimeoutNeverOutlivesTheNextRung(t *testing.T) {
	t.Parallel()
	for _, delay := range []time.Duration{
		MinRebootDelay, 2 * time.Minute, 6 * time.Minute, 16 * time.Minute,
		61 * time.Minute, 4 * time.Hour, 24 * time.Hour,
	} {
		t.Run(delay.String(), func(t *testing.T) {
			plan := PlanReboot(delay)
			rungs := planRebootRungs(plan)
			if len(rungs) != len(plan.Notifications) {
				t.Fatalf("rungs = %d, want %d", len(rungs), len(plan.Notifications))
			}
			for i, r := range rungs {
				if !r.deferrable {
					continue
				}
				if r.promptWindow <= 0 {
					t.Errorf("rung %d: promptWindow = %v, want positive", i, r.promptWindow)
				}
				if r.promptWindow > maxRebootPromptWindow {
					t.Errorf("rung %d: promptWindow = %v, want at most %v", i, r.promptWindow, maxRebootPromptWindow)
				}
				next := plan.OSInvokeAt
				if i+1 < len(plan.Notifications) {
					next = plan.Notifications[i+1].After
				}
				if got := plan.Notifications[i].After + r.promptWindow; got > next {
					t.Errorf("rung %d: prompt would still be open at %v, past the next rung at %v", i, got, next)
				}
			}
			// The closing rung is the last notification, and only it is
			// non-deferrable.
			for i, r := range rungs {
				wantDeferrable := plan.Notifications[i].After != plan.OSInvokeAt
				if r.deferrable != wantDeferrable {
					t.Errorf("rung %d (After=%v, OSInvokeAt=%v): deferrable = %v, want %v",
						i, plan.Notifications[i].After, plan.OSInvokeAt, r.deferrable, wantDeferrable)
				}
			}
		})
	}
}

// TestPromptTimeoutIsPassedToTheSeam pins that the computed window actually
// reaches the dialog rather than being recomputed as a constant.
func TestPromptTimeoutIsPassedToTheSeam(t *testing.T) {
	rm, timers, _, _, clock, prompts := newPromptTestManager(t, 3)
	if err := rm.ScheduleWithOptions(4*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	want := planRebootRungs(PlanReboot(4 * time.Minute))[0].promptWindow
	if got := (*prompts)[0].timeout; got != want {
		t.Errorf("prompt timeout = %v, want %v", got, want)
	}
}

func TestRebootActionPostponeReadsLikeAButton(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   time.Duration
		want string
	}{
		{time.Hour, "Postpone 1 hour"},
		{30 * time.Minute, "Postpone 30 minutes"},
		{2 * time.Hour, "Postpone 2 hours"},
		{90 * time.Minute, "Postpone 90 minutes"},
		{time.Minute, "Postpone 1 minute"},
	}
	for _, tc := range cases {
		if got := rebootActionPostpone(tc.in); got != tc.want {
			t.Errorf("rebootActionPostpone(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestCancelIsRefusedWhileTheOSCommandIsBeingIssued closes the window codex
// flagged during the W2 review: runOSReboot used to set osInvoked BEFORE
// execOSReboot ran, so a Cancel arriving in between took the abort path, found
// nothing to abort, reported success — and the machine still went down. The
// prompt's "Restart now" widens that window because it re-enters
// scheduleLockedAt, which takes the same abort path.
func TestCancelIsRefusedWhileTheOSCommandIsBeingIssued(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	inExec := make(chan struct{})
	release := make(chan struct{})
	var aborts int
	var mu sync.Mutex
	rm.abortOSReboot = func() error {
		mu.Lock()
		aborts++
		mu.Unlock()
		return nil
	}
	rm.execOSReboot = func(time.Duration) error {
		close(inExec)
		<-release
		return nil
	}
	if err := rm.ScheduleWithOptions(5*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	plan := PlanReboot(5 * time.Minute)
	done := make(chan struct{})
	go func() {
		timers.runAt(plan.OSInvokeAt)
		close(done)
	}()
	<-inExec

	if err := rm.Cancel(); err == nil {
		t.Error("Cancel reported success while the shutdown command was still being issued; the machine reboots anyway")
	}
	if _, err := rm.Defer(); err == nil {
		t.Error("Defer was granted while the shutdown command was being issued")
	}
	if err := rm.Schedule(time.Hour, clock.now().Add(6*time.Hour), "Later", "manual"); err == nil {
		t.Error("a re-schedule was accepted while the shutdown command was being issued")
	}

	mu.Lock()
	got := aborts
	mu.Unlock()
	if got != 0 {
		t.Errorf("abortOSReboot called %d time(s) before the OS command had been issued", got)
	}

	close(release)
	<-done

	// Once exec has returned, the countdown really is live and Cancel must go
	// back to attempting the abort.
	if err := rm.Cancel(); err != nil {
		t.Fatalf("Cancel after the OS command was issued: %v", err)
	}
	mu.Lock()
	got = aborts
	mu.Unlock()
	if got != 1 {
		t.Errorf("abortOSReboot called %d time(s) after the countdown started, want 1", got)
	}
}

// TestFailedOSInvocationLeavesNothingToAbort: exec failing must clear the
// in-flight marker too, or every later Cancel would report the transient refusal
// forever.
func TestFailedOSInvocationLeavesNothingToAbort(t *testing.T) {
	rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
	rm.execOSReboot = func(time.Duration) error { return fmt.Errorf("shutdown binary missing") }
	if err := rm.ScheduleWithOptions(5*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(PlanReboot(5 * time.Minute).OSInvokeAt)

	if got := rm.State().LastError; !strings.Contains(got, "shutdown binary missing") {
		t.Errorf("LastError = %q, want the invocation failure", got)
	}
	// A failed invocation left no countdown, so a fresh schedule must be accepted
	// rather than refused as "an OS reboot is being invoked".
	if err := rm.Schedule(time.Hour, clock.now().Add(6*time.Hour), "Retry", "manual"); err != nil {
		t.Fatalf("re-schedule after a failed OS invocation: %v", err)
	}
}

// TestPostponeIsRefusedAfterTheScheduleWasReplaced is the review finding this
// wave created and the public Defer() cannot catch on its own.
//
// Defer() asks only whether SOME reboot is scheduled. A dialog blocks for up to
// two minutes, so a user answering a prompt for the reboot that was REPLACED
// while they read it would postpone the replacement and spend its budget — a
// different administrator's reboot moved by a click that was never about it.
// Cancel-without-replacement was already caught; this is the same hazard one
// schedule along.
func TestPostponeIsRefusedAfterTheScheduleWasReplaced(t *testing.T) {
	rm, timers, notifications, _, clock, _ := newDeferralTestManager(t, 3)
	inPrompt := make(chan struct{})
	release := make(chan struct{})
	rm.promptFn = func(_, _, _ string, actions []string, _ time.Duration) (string, bool) {
		close(inPrompt)
		<-release
		return actions[1], true // Postpone
	}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "First", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	done := make(chan struct{})
	go func() {
		timers.runAt(0)
		close(done)
	}()
	<-inPrompt

	// A second, unrelated dispatch supersedes the first while the dialog is open.
	if err := rm.ScheduleWithOptions(30*time.Minute, clock.now().Add(5*time.Hour), "Second", "manual",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("replacement ScheduleWithOptions: %v", err)
	}
	replacementAt := rm.State().ScheduledAt

	close(release)
	<-done

	st := rm.State()
	if st.DeferralsUsed != 0 {
		t.Errorf("DeferralsUsed = %d — the stale answer spent the replacement's budget", st.DeferralsUsed)
	}
	if !st.ScheduledAt.Equal(replacementAt) {
		t.Errorf("the replacement moved from %v to %v because of a click about the schedule it replaced",
			replacementAt, st.ScheduledAt)
	}
	if st.Reason != "Second" {
		t.Errorf("Reason = %q, want the replacement's", st.Reason)
	}
	var told bool
	for _, n := range *notifications {
		if strings.Contains(n.title, "Cannot Be Postponed") {
			told = true
		}
	}
	if !told {
		t.Errorf("the user was never told their postponement did not apply; notifications = %+v", *notifications)
	}
}

// TestPublicDeferStillWorksWithoutAGeneration guards against the generation
// check leaking into the public API, which the console's own postpone command
// calls with no prompt and no generation in hand.
func TestPublicDeferStillWorksWithoutAGeneration(t *testing.T) {
	rm, _, _, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	if _, err := rm.Defer(); err != nil {
		t.Fatalf("Defer: %v", err)
	}
	if got := rm.State().DeferralsUsed; got != 1 {
		t.Errorf("DeferralsUsed = %d, want 1", got)
	}
}

// TestHeadlessBoxStillGetsEveryWarning is the production shape my earlier
// headless test missed. TestPromptAbsentFallsBackToAPlainNotification uses a NIL
// promptFn — but the heartbeat always wires one, so on a real headless box (or a
// Windows server at the logon screen, or a machine whose helper crashed) promptFn
// is non-nil and simply reports that nothing was shown. Every deferrable rung
// must still warn through the ordinary notification path.
func TestHeadlessBoxStillGetsEveryWarning(t *testing.T) {
	rm, timers, notifications, _, clock, _ := newDeferralTestManager(t, 3)
	rm.promptFn = func(string, string, string, []string, time.Duration) (string, bool) {
		return "", false // no session, nothing rendered
	}
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*notifications) != 1 {
		t.Fatalf("notifications = %d, want 1 — a deferrable rung warned nobody at all (#3197)", len(*notifications))
	}
	if rm.State().DeferralsUsed != 0 {
		t.Error("a prompt that never rendered deferred something")
	}
}

// TestAShownPromptIsNotFollowedByARedundantToast: when the dialog really did
// render, it WAS the warning. Emitting a toast on top would double every rung.
func TestAShownPromptIsNotFollowedByARedundantToast(t *testing.T) {
	rm, timers, notifications, _, clock, _ := newDeferralTestManager(t, 3)
	rm.promptFn = func(string, string, string, []string, time.Duration) (string, bool) {
		return "", true // shown, user did nothing
	}
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job",
		allowDeferral(2, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*notifications) != 0 {
		t.Errorf("notifications = %d, want 0 — the dialog was the warning: %+v", len(*notifications), *notifications)
	}
}
