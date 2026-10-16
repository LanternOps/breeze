// Untagged on purpose — see reboot_plan.go.
package patching

import (
	"strings"
	"testing"
	"time"
)

// TestPlanRebootCountdownMatchesEachRung pins the per-rung countdown the
// {{countdown}} placeholder is filled from (#8030): it must be the same figure
// the built-in copy quotes on that rung.
func TestPlanRebootCountdownMatchesEachRung(t *testing.T) {
	for _, delay := range []time.Duration{time.Minute, 90 * time.Second, 5 * time.Minute, 15 * time.Minute, 61 * time.Minute, 24 * time.Hour} {
		plan := PlanReboot(delay)
		for i, n := range plan.Notifications {
			if n.Countdown <= 0 {
				t.Fatalf("delay %v rung %d: Countdown = %v, want > 0", delay, i, n.Countdown)
			}
			if got := n.After + n.Countdown; got != plan.TotalDelay {
				t.Errorf("delay %v rung %d: After+Countdown = %v, want TotalDelay %v", delay, i, got, plan.TotalDelay)
			}
			if !strings.Contains(n.Body, humanizeRebootDelay(n.Countdown)) {
				t.Errorf("delay %v rung %d: built-in body %q does not quote its countdown %q",
					delay, i, n.Body, humanizeRebootDelay(n.Countdown))
			}
		}
	}
}

// TestBuiltInRebootCopyIsUnchanged pins today's strings byte-for-byte: with no
// custom text set, #8030 must change nothing a user sees.
func TestBuiltInRebootCopyIsUnchanged(t *testing.T) {
	plan := PlanReboot(60 * time.Minute)
	want := []struct{ title, body string }{
		{"Restart Scheduled", "A system restart for updates is scheduled in 1 hour. Please save your work."},
		{"Restart Soon", "A system restart for updates begins in 15 minutes. Please save your work."},
		{"Restart Imminent", "A system restart for updates begins in 5 minutes. Please save your work."},
		{"Restarting Now", "This computer restarts for updates in 1 minute. Save your work now."},
	}
	if len(plan.Notifications) != len(want) {
		t.Fatalf("notifications = %d, want %d", len(plan.Notifications), len(want))
	}
	for i, w := range want {
		n := plan.Notifications[i]
		if n.Title != w.title || n.Body != w.body {
			t.Errorf("rung %d = (%q, %q), want (%q, %q)", i, n.Title, n.Body, w.title, w.body)
		}
	}
	if RebootActionRestartNow != "Restart now" {
		t.Errorf("RebootActionRestartNow = %q", RebootActionRestartNow)
	}
}

func TestApplyRebootPromptText(t *testing.T) {
	n := RebootNotification{Title: "Restart Soon", Body: "built-in", Countdown: 15 * time.Minute}

	title, body := applyRebootPromptText(n, RebootPromptText{})
	if title != "Restart Soon" || body != "built-in" {
		t.Errorf("empty text changed the copy: (%q, %q)", title, body)
	}

	title, body = applyRebootPromptText(n, RebootPromptText{Title: "Neustart", Body: "Neustart in {{countdown}}. Noch {{countdown}}!"})
	if title != "Neustart" {
		t.Errorf("title = %q", title)
	}
	if body != "Neustart in 15 minutes. Noch 15 minutes!" {
		t.Errorf("body = %q", body)
	}

	// Title-only text keeps the built-in body, and vice versa.
	title, body = applyRebootPromptText(n, RebootPromptText{Title: "Neustart"})
	if title != "Neustart" || body != "built-in" {
		t.Errorf("title-only = (%q, %q)", title, body)
	}
}

func TestSanitizeRebootPromptText(t *testing.T) {
	got, dropped := SanitizeRebootPromptText(RebootPromptText{
		Title:  "  Neustart geplant ",
		Body:   "Zeile 1\nZeile 2\tmit Tab {{countdown}}",
		Button: "Jetzt neu starten",
	})
	if len(dropped) != 0 {
		t.Fatalf("valid text dropped: %v", dropped)
	}
	if got.Title != "Neustart geplant" || got.Body != "Zeile 1\nZeile 2\tmit Tab {{countdown}}" || got.Button != "Jetzt neu starten" {
		t.Errorf("sanitized = %+v", got)
	}

	cases := []struct {
		name string
		in   RebootPromptText
		want []string
	}{
		{"markup in title", RebootPromptText{Title: "<b>x</b>"}, []string{"title"}},
		{"markup in body", RebootPromptText{Body: "a > b"}, []string{"body"}},
		{"newline in title", RebootPromptText{Title: "a\nb"}, []string{"title"}},
		{"tab in button", RebootPromptText{Button: "a\tb"}, []string{"button"}},
		{"NUL in body", RebootPromptText{Body: "a\x00b"}, []string{"body"}},
		{"escape in body", RebootPromptText{Body: "a\x1b[31mb"}, []string{"body"}},
		{"title too long", RebootPromptText{Title: strings.Repeat("é", maxRebootPromptTitleRunes+1)}, []string{"title"}},
		{"body too long", RebootPromptText{Body: strings.Repeat("a", maxRebootPromptBodyRunes+1)}, []string{"body"}},
		{"button too long", RebootPromptText{Button: strings.Repeat("a", maxRebootPromptButtonRunes+1)}, []string{"button"}},
		{"unknown placeholder", RebootPromptText{Body: "in {{countdwon}}"}, []string{"body"}},
		{"invalid utf-8", RebootPromptText{Title: "a\xffb"}, []string{"title"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, dropped := SanitizeRebootPromptText(tc.in)
			if strings.Join(dropped, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("dropped = %v, want %v", dropped, tc.want)
			}
			if got != (RebootPromptText{}) {
				t.Errorf("an invalid field survived: %+v", got)
			}
		})
	}

	// Exactly at the limit (in runes, not bytes) is accepted.
	got, dropped = SanitizeRebootPromptText(RebootPromptText{Title: strings.Repeat("é", maxRebootPromptTitleRunes)})
	if len(dropped) != 0 || got.Title == "" {
		t.Errorf("a title at the rune limit was dropped: %v", dropped)
	}
}

// TestCustomTextReachesEveryRung drives the manager: a custom title/body
// replaces the built-in copy on every warning, with the countdown filled in.
func TestCustomTextReachesEveryRung(t *testing.T) {
	rm, timers, notifications, _, clock, _ := newDeferralTestManager(t, 3)
	opts := RebootOptions{Prompt: RebootPromptText{Title: "Neustart", Body: "Neustart in {{countdown}}."}}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(60*time.Minute), "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	plan := PlanReboot(60 * time.Minute)
	for _, n := range plan.Notifications {
		timers.runAt(n.After)
	}
	want := []string{"Neustart in 1 hour.", "Neustart in 15 minutes.", "Neustart in 5 minutes.", "Neustart in 1 minute."}
	if len(*notifications) != len(want) {
		t.Fatalf("notifications = %d, want %d", len(*notifications), len(want))
	}
	for i, w := range want {
		got := (*notifications)[i]
		if got.title != "Neustart" || got.body != w {
			t.Errorf("rung %d = (%q, %q), want (%q, %q)", i, got.title, got.body, "Neustart", w)
		}
	}
}

// TestCustomButtonIsOfferedAndHonoured: the Restart-now label is the custom
// one, and a click on it is recognised as Restart now.
func TestCustomButtonIsOfferedAndHonoured(t *testing.T) {
	rm, timers, _, _, clock, prompts := newPromptTestManager(t, 3, "Jetzt neu starten")
	opts := allowDeferral(2, 60)
	opts.Prompt = RebootPromptText{Button: "Jetzt neu starten"}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0)

	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	if got := (*prompts)[0].actions[0]; got != "Jetzt neu starten" {
		t.Errorf("actions[0] = %q, want the custom label", got)
	}
	// Restart now collapses the schedule to MinRebootDelay.
	if st := rm.State(); st.ScheduledAt.Sub(clock.now()) != MinRebootDelay {
		t.Errorf("ScheduledAt is %v out, want %v after Restart now", st.ScheduledAt.Sub(clock.now()), MinRebootDelay)
	}
}

// TestBuiltInRestartLabelIsNoLongerHonouredWhenACustomOneWasOffered: only the
// exact label sent counts, same rule as the postponement button.
func TestBuiltInRestartLabelIsNoLongerHonouredWhenACustomOneWasOffered(t *testing.T) {
	rm, timers, _, _, clock, _ := newPromptTestManager(t, 3, RebootActionRestartNow)
	opts := allowDeferral(2, 60)
	opts.Prompt = RebootPromptText{Button: "Jetzt neu starten"}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	if st := rm.State(); st.ScheduledAt.Sub(clock.now()) != 60*time.Minute {
		t.Errorf("an un-offered label moved the reboot: ScheduledAt %v out", st.ScheduledAt.Sub(clock.now()))
	}
}

// TestCustomTextSurvivesAPostponement: Defer re-schedules; dropping the text
// there would switch the user back to English after the first Postpone.
func TestCustomTextSurvivesAPostponement(t *testing.T) {
	rm, timers, notifications, _, clock, prompts := newPromptTestManager(t, 3, rebootActionPostpone(time.Hour))
	opts := allowDeferral(2, 60)
	opts.Prompt = RebootPromptText{Title: "Neustart", Body: "In {{countdown}}.", Button: "Jetzt"}
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0) // prompt -> Postpone 1 hour -> re-scheduled to 75 minutes
	if rm.State().DeferralsUsed != 1 {
		t.Fatalf("DeferralsUsed = %d, want 1", rm.State().DeferralsUsed)
	}
	if (*prompts)[0].title != "Neustart" {
		t.Errorf("first prompt title = %q", (*prompts)[0].title)
	}

	before := len(*notifications)
	timers.runAt(0) // the re-scheduled lead rung: warns only (#4941)
	if len(*notifications) <= before {
		t.Fatal("the re-scheduled lead rung emitted nothing")
	}
	got := (*notifications)[len(*notifications)-1]
	if got.title != "Neustart" || !strings.HasPrefix(got.body, "In 75 minutes.") {
		t.Errorf("after a postponement the lead rung read (%q, %q); custom text was lost", got.title, got.body)
	}
}

// TestCustomTextSurvivesRestartNow: the shortened schedule's closing notice is
// still in the operator's language.
func TestCustomTextSurvivesRestartNow(t *testing.T) {
	rm, timers, notifications, _, clock, _ := newPromptTestManager(t, 3, "Jetzt")
	opts := allowDeferral(2, 60)
	opts.Prompt = RebootPromptText{Title: "Neustart", Body: "In {{countdown}}.", Button: "Jetzt"}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0) // Restart now -> PlanReboot(MinRebootDelay): one collapsed rung at 0

	before := len(*notifications)
	timers.runAt(0)
	if len(*notifications) <= before {
		t.Fatal("the shortened schedule emitted no notice")
	}
	got := (*notifications)[len(*notifications)-1]
	if got.title != "Neustart" || !strings.HasPrefix(got.body, "In 1 minute.") {
		t.Errorf("closing notice after Restart now = (%q, %q)", got.title, got.body)
	}
}

// TestANewScheduleWithoutTextRevertsToBuiltIn: text never leaks from one
// schedule into the next, the same reset rule the deferral budget follows.
func TestANewScheduleWithoutTextRevertsToBuiltIn(t *testing.T) {
	rm, timers, notifications, _, clock, _ := newDeferralTestManager(t, 3)
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(time.Hour), "Patch", "patch_job",
		RebootOptions{Prompt: RebootPromptText{Title: "Neustart"}}); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	if err := rm.Schedule(60*time.Minute, clock.now().Add(time.Hour), "Manual", "manual"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	timers.runAt(0)
	got := (*notifications)[len(*notifications)-1]
	if got.title != "Restart Scheduled" {
		t.Errorf("title = %q, want the built-in title", got.title)
	}
}

// TestCountdownIsFilledInTitleAndButton: the placeholder is accepted in every
// field, so it must be substituted in every field.
func TestCountdownIsFilledInTitleAndButton(t *testing.T) {
	n := RebootNotification{Title: "Restart Soon", Body: "built-in", Countdown: 5 * time.Minute}
	title, _ := applyRebootPromptText(n, RebootPromptText{Title: "Neustart in {{countdown}}"})
	if title != "Neustart in 5 minutes" {
		t.Errorf("title = %q", title)
	}
	if got := rebootActionRestartNowLabel(n, RebootPromptText{Button: "Jetzt ({{countdown}})"}); got != "Jetzt (5 minutes)" {
		t.Errorf("button = %q", got)
	}
	if got := rebootActionRestartNowLabel(n, RebootPromptText{}); got != RebootActionRestartNow {
		t.Errorf("default button = %q", got)
	}
}

// TestCustomButtonEqualToPostponeFallsBackAndPostponeStillDefers: a custom
// label identical to the postponement label must not turn a Postpone click
// into Restart now.
func TestCustomButtonEqualToPostponeFallsBackAndPostponeStillDefers(t *testing.T) {
	postpone := rebootActionPostpone(time.Hour)
	rm, timers, _, _, clock, prompts := newPromptTestManager(t, 3, postpone)
	opts := allowDeferral(2, 60)
	opts.Prompt = RebootPromptText{Button: postpone}
	if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	if got := (*prompts)[0].actions[0]; got != RebootActionRestartNow {
		t.Errorf("actions[0] = %q, want the built-in label when the custom one collides", got)
	}
	if st := rm.State(); st.DeferralsUsed != 1 || st.ScheduledAt.Sub(clock.now()) != 75*time.Minute {
		t.Errorf("Postpone click was not honoured as a postponement: used=%d, ScheduledAt %v out",
			st.DeferralsUsed, st.ScheduledAt.Sub(clock.now()))
	}
}

// TestPerRungCountdownButtonIsHonoured: a button carrying {{countdown}} has a
// different label on each rung; a click on the label actually shown counts.
func TestPerRungCountdownButtonIsHonoured(t *testing.T) {
	rm, timers, _, _, clock, prompts := newPromptTestManager(t, 3, "Jetzt (1 hour)")
	opts := allowDeferral(2, 60)
	opts.Prompt = RebootPromptText{Button: "Jetzt ({{countdown}})"}
	if err := rm.ScheduleWithOptions(60*time.Minute, clock.now().Add(5*time.Hour), "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	if got := (*prompts)[0].actions[0]; got != "Jetzt (1 hour)" {
		t.Fatalf("actions[0] = %q", got)
	}
	if st := rm.State(); st.ScheduledAt.Sub(clock.now()) != MinRebootDelay {
		t.Errorf("Restart now not honoured: ScheduledAt %v out", st.ScheduledAt.Sub(clock.now()))
	}
}
