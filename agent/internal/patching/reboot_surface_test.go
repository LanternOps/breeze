// Untagged on purpose — see reboot_plan.go.
package patching

import (
	"runtime"
	"sync"
	"testing"
	"time"
)

// The restart prompt surface (#10190 W05): the ladder hands each rung to the
// prompt host first; only a rung the surface did not take goes out as
// today's notification or dialog.

type fakeSurface struct {
	mu        sync.Mutex
	take      bool
	rungs     []RestartRung
	cancelled []uint64
	before    []uint64
	events    *[]string // shared ordering log, optional
}

func (s *fakeSurface) ShowRung(r RestartRung) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rungs = append(s.rungs, r)
	return s.take
}

func (s *fakeSurface) Cancelled(campaign uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancelled = append(s.cancelled, campaign)
}

func (s *fakeSurface) BeforeOSRestart(campaign uint64, _ time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.before = append(s.before, campaign)
	if s.events != nil {
		*s.events = append(*s.events, "after-restart entry")
	}
}

func (s *fakeSurface) last(t *testing.T) RestartRung {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.rungs) == 0 {
		t.Fatal("no rung reached the surface")
	}
	return s.rungs[len(s.rungs)-1]
}

func newSurfaceTestManager(t *testing.T, take bool) (*RebootManager, *fakeTimers, *[]notifyCall, *[]time.Duration, *fakeClock, *[]promptCall, *fakeSurface) {
	t.Helper()
	rm, timers, notifications, osCalls, clock, prompts := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	s := &fakeSurface{take: take}
	rm.SetRestartSurface(s)
	return rm, timers, notifications, osCalls, clock, prompts, s
}

func TestSurfaceTakesTheRungAndTodaysLadderStaysSilent(t *testing.T) {
	rm, timers, notifications, _, clock, prompts, s := newSurfaceTestManager(t, true)
	opts := allowDeferral(3, 60)
	opts.Prompt = RebootPromptText{Title: "Custom {{countdown}}", Button: "Go"}
	if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(5*time.Hour), "Patch", "patch_job", opts); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	if len(*notifications) != 0 || len(*prompts) != 0 {
		t.Fatalf("a rung the surface took also went out today's way: notifications=%v prompts=%v", *notifications, *prompts)
	}
	r := s.last(t)
	if r.Campaign == 0 || r.Final || !r.Resurface {
		t.Fatalf("lead rung = %+v", r)
	}
	if !r.ScheduledAt.Equal(clock.now().Add(2 * time.Hour)) {
		t.Fatalf("ScheduledAt = %v", r.ScheduledAt)
	}
	if !r.DeferralAllowed || r.DeferralsLeft != 3 {
		t.Fatalf("budget = %v/%d", r.DeferralAllowed, r.DeferralsLeft)
	}
	if r.Text.Title != "Custom {{countdown}}" || r.Text.Button != "Go" {
		t.Fatalf("operator copy must reach the surface unrendered (the card substitutes it): %+v", r.Text)
	}
	// Today's warning for this rung, for a session that cannot draw the card.
	if r.LegacyTitle != "Custom 2 hours" || r.LegacyUrgency == "" || r.LegacyBody == "" {
		t.Fatalf("legacy = %q / %q / %q", r.LegacyTitle, r.LegacyBody, r.LegacyUrgency)
	}
}

func TestSurfaceDeclinedRungGoesOutTodaysWay(t *testing.T) {
	rm, timers, notifications, _, clock, prompts, s := newSurfaceTestManager(t, false)
	if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(5*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	if len(s.rungs) != 1 {
		t.Fatalf("the surface was not asked first: %d", len(s.rungs))
	}
	if len(*prompts) != 1 && len(*notifications) != 1 {
		t.Fatalf("a declined rung must go out today's way: prompts=%d notifications=%d", len(*prompts), len(*notifications))
	}
}

func TestRungPostponeUntilEqualsComputeDeferral(t *testing.T) {
	rm, timers, _, _, clock, _, s := newSurfaceTestManager(t, true)
	deadline := clock.now().Add(2*time.Hour + 40*time.Minute)
	if err := rm.ScheduleWithOptions(2*time.Hour, deadline, "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	r := s.last(t)
	out := ComputeDeferral(DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}, 0, clock.now(), r.ScheduledAt, deadline)
	if !out.Granted {
		t.Fatal("precondition: a postponement is available")
	}
	if want := clock.now().Add(out.NewDelay); !r.PostponeUntil.Equal(want) || !r.PostponeUntil.Equal(deadline) {
		t.Fatalf("PostponeUntil = %v, want the clamped %v (deadline %v)", r.PostponeUntil, want, deadline)
	}
}

func TestRungHidesPostponeWhenBudgetUsedClampTooSmallOrFinal(t *testing.T) {
	t.Run("clamp below the minimum gap", func(t *testing.T) {
		rm, timers, _, _, clock, _, s := newSurfaceTestManager(t, true)
		// ComputeDeferral would grant 3 minutes; the card does not offer it.
		if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(2*time.Hour+3*time.Minute), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
			t.Fatal(err)
		}
		timers.runAt(0)
		if r := s.last(t); !r.PostponeUntil.IsZero() {
			t.Fatalf("PostponeUntil = %v, want none (gap below %v)", r.PostponeUntil, minPostponeGap)
		}
	})
	t.Run("budget used", func(t *testing.T) {
		rm, timers, _, _, clock, _, s := newSurfaceTestManager(t, true)
		if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(10*time.Hour), "Patch", "patch_job", allowDeferral(1, 60)); err != nil {
			t.Fatal(err)
		}
		timers.runAt(0)
		c := s.last(t).Campaign
		if err := rm.UserPostpone(c, "assist"); err != nil {
			t.Fatal(err)
		}
		timers.runAt(0) // the re-planned lead rung
		r := s.last(t)
		if !r.PostponeUntil.IsZero() || r.DeferralsLeft != 0 || r.Resurface {
			t.Fatalf("after the last postponement: %+v", r)
		}
	})
	t.Run("final rung", func(t *testing.T) {
		rm, timers, _, _, clock, _, s := newSurfaceTestManager(t, true)
		if err := rm.ScheduleWithOptions(30*time.Minute, clock.now().Add(10*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
			t.Fatal(err)
		}
		timers.runAt(PlanReboot(30 * time.Minute).OSInvokeAt)
		r := s.last(t)
		if !r.Final || !r.PostponeUntil.IsZero() {
			t.Fatalf("closing rung = %+v", r)
		}
	})
}

func TestUserPostponeKeepsTheCampaignAndRefusesOthers(t *testing.T) {
	rm, timers, _, _, clock, _, s := newSurfaceTestManager(t, true)
	if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(10*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	c := s.last(t).Campaign
	if err := rm.UserPostpone(c+1, "assist"); err == nil {
		t.Fatal("a decision on another campaign's card must be refused")
	}
	if err := rm.UserPostpone(c, "assist"); err != nil {
		t.Fatal(err)
	}
	r, ok := rm.RestartRungNow(c)
	if !ok || r.Campaign != c || r.Resurface {
		t.Fatalf("snapshot after a postponement = %+v (%v)", r, ok)
	}
	if !r.ScheduledAt.Equal(clock.now().Add(3*time.Hour)) || r.DeferralsLeft != 2 {
		t.Fatalf("scheduled %v left %d, want +3h and 2", r.ScheduledAt, r.DeferralsLeft)
	}
	if err := rm.UserPostpone(c, "native"); err != nil {
		t.Fatalf("the campaign survives a postponement's re-plan: %v", err)
	}
	if st := rm.State(); st.DeferralsUsed != 2 {
		t.Fatalf("DeferralsUsed = %d", st.DeferralsUsed)
	}
	if err := rm.Cancel(); err != nil {
		t.Fatal(err)
	}
	if err := rm.UserPostpone(c, "assist"); err == nil {
		t.Fatal("a postponement after the operator cancelled must be refused")
	}
	if _, ok := rm.RestartRungNow(c); ok {
		t.Fatal("no snapshot for a cancelled campaign")
	}
	// A new operator schedule is a new campaign.
	if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(10*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	if n := s.last(t).Campaign; n == c {
		t.Fatal("a new schedule must be a new campaign")
	}
}

func TestUserRestartNowShortensAndTheClosingRungFollows(t *testing.T) {
	rm, timers, _, osCalls, clock, _, s := newSurfaceTestManager(t, true)
	if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(10*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	c := s.last(t).Campaign
	if err := rm.UserRestartNow(c, "native"); err != nil {
		t.Fatal(err)
	}
	if len(*osCalls) != 0 {
		t.Fatal("Restart now invoked the OS synchronously")
	}
	timers.runAt(0) // PlanReboot(1 min): the closing rung is the only rung
	r := s.last(t)
	if r.Campaign != c || !r.Final {
		t.Fatalf("after Restart now: %+v", r)
	}
	// The shortest plan hands the OS its countdown at offset zero too, with
	// the full grace minute the closing card announces.
	if len(*osCalls) != 1 || (*osCalls)[0] < time.Minute {
		t.Fatalf("osCalls = %v, want one invocation with at least a minute of grace", *osCalls)
	}
	if err := rm.UserRestartNow(c+7, "native"); err == nil {
		t.Fatal("another campaign's Restart now must be refused")
	}
}

func TestCancelPendingTellsTheSurface(t *testing.T) {
	rm, timers, _, _, clock, _, s := newSurfaceTestManager(t, true)
	if err := rm.Cancel(); err != ErrNoRebootScheduled {
		t.Fatalf("Cancel with nothing = %v", err)
	}
	if len(s.cancelled) != 0 {
		t.Fatal("nothing was pending, nothing to withdraw")
	}
	if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(10*time.Hour), "Patch", "patch_job", RebootOptions{}); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	c := s.last(t).Campaign
	if err := rm.Cancel(); err != nil {
		t.Fatal(err)
	}
	if len(s.cancelled) != 1 || s.cancelled[0] != c {
		t.Fatalf("cancelled = %v, want [%d]", s.cancelled, c)
	}
}

func TestAfterRestartEntryWrittenBeforeOSRestart(t *testing.T) {
	rm, timers, _, _, clock, _, s := newSurfaceTestManager(t, true)
	var events []string
	s.events = &events
	exec := rm.execOSReboot
	rm.execOSReboot = func(grace time.Duration) error {
		events = append(events, "os restart")
		return exec(grace)
	}
	if err := rm.ScheduleWithOptions(30*time.Minute, clock.now().Add(10*time.Hour), "Patch", "patch_job", RebootOptions{}); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	c := s.last(t).Campaign
	timers.runAt(PlanReboot(30 * time.Minute).OSInvokeAt)
	if len(events) != 2 || events[0] != "after-restart entry" || events[1] != "os restart" {
		t.Fatalf("order = %v", events)
	}
	if len(s.before) != 1 || s.before[0] != c {
		t.Fatalf("before = %v", s.before)
	}
}

func TestLastUserActionReported(t *testing.T) {
	rm, timers, _, _, clock, _, s := newSurfaceTestManager(t, true)
	if st := rm.State(); st.LastUserAction != nil {
		t.Fatalf("no decision yet: %+v", st.LastUserAction)
	}
	if err := rm.ScheduleWithOptions(2*time.Hour, clock.now().Add(10*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	c := s.last(t).Campaign
	if err := rm.UserPostpone(c, "assist"); err != nil {
		t.Fatal(err)
	}
	a := rm.State().LastUserAction
	if a == nil || a.Action != UserActionPostponed || a.Renderer != "assist" || !a.At.Equal(clock.now()) {
		t.Fatalf("after Postpone: %+v", a)
	}
	clock.advance(time.Minute)
	if err := rm.UserRestartNow(c, "native"); err != nil {
		t.Fatal(err)
	}
	a = rm.State().LastUserAction
	if a == nil || a.Action != UserActionRestartNow || a.Renderer != "native" || !a.At.Equal(clock.now()) {
		t.Fatalf("after Restart now: %+v", a)
	}
	// A refused decision records nothing.
	before := *a
	if err := rm.UserPostpone(c+1, "assist"); err == nil {
		t.Fatal("expected a refusal")
	}
	if got := rm.State().LastUserAction; *got != before {
		t.Fatalf("a refused decision changed the record: %+v", got)
	}
}

func TestLegacyDialogDecisionIsReportedWithTheLegacyRenderer(t *testing.T) {
	rm, timers, _, _, clock, _ := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job", allowDeferral(2, 60)); err != nil {
		t.Fatal(err)
	}
	timers.runAt(0)
	a := rm.State().LastUserAction
	want := "native"
	if runtime.GOOS == "linux" {
		want = "headless"
	}
	if a == nil || a.Action != UserActionPostponed || a.Renderer != want {
		t.Fatalf("legacy postponement = %+v, want renderer %s", a, want)
	}
}

func TestCampaignIDsAreUniqueAcrossManagers(t *testing.T) {
	seen := map[uint64]bool{}
	for i := 0; i < 50; i++ {
		rm, _, _, _, clock, _, _ := newSurfaceTestManager(t, true)
		if err := rm.ScheduleWithOptions(time.Hour, clock.now().Add(2*time.Hour), "Patch", "patch_job", RebootOptions{}); err != nil {
			t.Fatal(err)
		}
		r, ok := rm.RestartRungNow(rm.currentCampaign())
		if !ok || r.Campaign == 0 || seen[r.Campaign] {
			t.Fatalf("campaign %d repeated or missing (ok=%v)", r.Campaign, ok)
		}
		seen[r.Campaign] = true
	}
}
