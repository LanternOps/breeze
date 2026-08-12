// Untagged on purpose: this is the regression suite for #3197 and it has to run
// in CI. The `test-agent` job builds ./... for linux; ./internal/patching is not
// in the `test-agent-windows` package allowlist, so a *_windows_test.go here
// would execute nowhere (issues #3019, #3046).
package patching

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestPlanRebootAlwaysWarns is the #3197 regression test. The reported defect was
// a 5-minute delay against a 60/15/5 ladder gated on strict `>`: 5 > 5 is false,
// so zero notifications were scheduled and the workstation rebooted silently.
// The invariant is now "at least one warning, at scheduling time, at every
// delay" — including delays no before-the-reboot threshold could ever cover.
func TestPlanRebootAlwaysWarns(t *testing.T) {
	// Deliberately includes 1 and 2 (below every threshold), 5 (the reported
	// value), 15 (the maintenance-window grace), 6/16/61 (just above each
	// threshold, where a naive `>=` produces near-duplicate toasts) and 1440
	// (the config-policy maximum).
	for _, minutes := range []int{1, 2, 3, 5, 6, 10, 15, 16, 20, 30, 60, 61, 65, 120, 240, 720, 1440} {
		delay := time.Duration(minutes) * time.Minute
		plan := PlanReboot(delay)

		if len(plan.Notifications) == 0 {
			t.Fatalf("delay=%dm: no notifications planned — this is the #3197 silent reboot", minutes)
		}
		if plan.Notifications[0].After != 0 {
			t.Errorf("delay=%dm: first notification at %s, want 0 (the user must be told at scheduling time)",
				minutes, plan.Notifications[0].After)
		}
		if plan.TotalDelay != delay {
			t.Errorf("delay=%dm: TotalDelay=%s, want %s", minutes, plan.TotalDelay, delay)
		}
		if got := plan.OSInvokeAt + plan.OSGrace; got != delay {
			t.Errorf("delay=%dm: OSInvokeAt(%s)+OSGrace(%s)=%s, want %s — the OS countdown must end when the user was told",
				minutes, plan.OSInvokeAt, plan.OSGrace, got, delay)
		}
		if plan.OSGrace <= 0 {
			t.Errorf("delay=%dm: OSGrace=%s, want > 0 — a zero grace is the toast-then-kill-the-session race",
				minutes, plan.OSGrace)
		}

		// The last notification is the closing one and coincides with the OS
		// invocation, so its countdown and the OS countdown are the same.
		last := plan.Notifications[len(plan.Notifications)-1]
		if last.After != plan.OSInvokeAt {
			t.Errorf("delay=%dm: closing notification at %s but OS invoked at %s", minutes, last.After, plan.OSInvokeAt)
		}
		if last.Urgency != "critical" {
			t.Errorf("delay=%dm: closing notification urgency=%q, want critical", minutes, last.Urgency)
		}

		for i, n := range plan.Notifications {
			if n.After < 0 || n.After > delay {
				t.Errorf("delay=%dm: notification %d at %s is outside [0,%s]", minutes, i, n.After, delay)
			}
			if n.Title == "" || n.Body == "" || n.Urgency == "" {
				t.Errorf("delay=%dm: notification %d is missing title/body/urgency: %+v", minutes, i, n)
			}
		}
	}
}

// TestPlanRebootNoNearDuplicateToasts pins the spacing rule. Flipping the old
// strict `>` to `>=` would have fixed the exact-equality case and left this
// broken: at 61 minutes the lead says "in 61 minutes" and a `>=`-gated 60-minute
// reminder says "in 1 hour" sixty seconds later.
func TestPlanRebootNoNearDuplicateToasts(t *testing.T) {
	for _, minutes := range []int{1, 2, 5, 6, 10, 15, 16, 20, 21, 60, 61, 65, 66, 120, 1440} {
		plan := PlanReboot(time.Duration(minutes) * time.Minute)
		for i := 1; i < len(plan.Notifications); i++ {
			gap := plan.Notifications[i].After - plan.Notifications[i-1].After
			if gap <= 0 {
				t.Errorf("delay=%dm: notifications %d and %d are out of order (%s then %s)",
					minutes, i-1, i, plan.Notifications[i-1].After, plan.Notifications[i].After)
				continue
			}
			isClosing := i == len(plan.Notifications)-1
			want := minReminderGap
			if isClosing {
				want = minFinalGap
			}
			if gap < want {
				t.Errorf("delay=%dm: gap between notifications %d and %d is %s, want >= %s (closing=%v)",
					minutes, i-1, i, gap, want, isClosing)
			}
		}
	}
}

// TestPlanRebootReportedDefect walks the exact scenario from the issue.
func TestPlanRebootReportedDefect(t *testing.T) {
	plan := PlanReboot(5 * time.Minute)

	if len(plan.Notifications) != 2 {
		t.Fatalf("5-minute delay: got %d notifications, want 2 (lead + closing): %+v",
			len(plan.Notifications), plan.Notifications)
	}
	lead := plan.Notifications[0]
	if lead.After != 0 {
		t.Errorf("lead notification at %s, want 0", lead.After)
	}
	if !strings.Contains(lead.Body, "5 minutes") {
		t.Errorf("lead body %q should quote the actual delay", lead.Body)
	}
	if lead.Urgency != "critical" {
		t.Errorf("lead urgency=%q at a 5-minute delay, want critical — it is the user's only advance warning", lead.Urgency)
	}
	closing := plan.Notifications[1]
	if closing.After != 4*time.Minute {
		t.Errorf("closing notification at %s, want 4m (delay minus the 1m OS grace)", closing.After)
	}
}

// TestPlanRebootShortDelayCollapsesToOneNotice covers the emergency case: a
// reboot so imminent that a separate lead and closing notice would land in the
// same instant. One critical notice, and the OS still gets a non-zero grace.
func TestPlanRebootShortDelayCollapsesToOneNotice(t *testing.T) {
	for _, d := range []time.Duration{0, -1 * time.Minute, 30 * time.Second, time.Minute} {
		plan := PlanReboot(d)
		if plan.TotalDelay != MinRebootDelay {
			t.Errorf("delay=%s: TotalDelay=%s, want raised to %s", d, plan.TotalDelay, MinRebootDelay)
		}
		if len(plan.Notifications) != 1 {
			t.Fatalf("delay=%s: got %d notifications, want exactly 1: %+v", d, len(plan.Notifications), plan.Notifications)
		}
		n := plan.Notifications[0]
		if n.After != 0 || n.Urgency != "critical" {
			t.Errorf("delay=%s: notification=%+v, want After=0 urgency=critical", d, n)
		}
		if plan.OSInvokeAt != 0 || plan.OSGrace != MinRebootDelay {
			t.Errorf("delay=%s: OSInvokeAt=%s OSGrace=%s, want 0 / %s", d, plan.OSInvokeAt, plan.OSGrace, MinRebootDelay)
		}
	}
}

func TestPlanRebootLadderShape(t *testing.T) {
	tests := []struct {
		name    string
		delay   time.Duration
		offsets []time.Duration
	}{
		{
			// The maintenance-window grace. Pre-#3197 this produced exactly one
			// toast (the 5-minute reminder) and nothing at scheduling time.
			name:    "15 minutes: lead, 5-minute reminder, closing",
			delay:   15 * time.Minute,
			offsets: []time.Duration{0, 10 * time.Minute, 14 * time.Minute},
		},
		{
			// 16 exercises the near-duplicate suppression: the 15-minute
			// reminder would land 1 minute after the lead, so it is dropped.
			name:    "16 minutes: 15-minute reminder suppressed",
			delay:   16 * time.Minute,
			offsets: []time.Duration{0, 11 * time.Minute, 15 * time.Minute},
		},
		{
			name:    "61 minutes: 60-minute reminder suppressed",
			delay:   61 * time.Minute,
			offsets: []time.Duration{0, 46 * time.Minute, 56 * time.Minute, 60 * time.Minute},
		},
		{
			name:    "65 minutes: full ladder",
			delay:   65 * time.Minute,
			offsets: []time.Duration{0, 5 * time.Minute, 50 * time.Minute, 60 * time.Minute, 64 * time.Minute},
		},
		{
			name:    "24 hours: full ladder, first warning at scheduling time",
			delay:   1440 * time.Minute,
			offsets: []time.Duration{0, 1380 * time.Minute, 1425 * time.Minute, 1435 * time.Minute, 1439 * time.Minute},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			plan := PlanReboot(tc.delay)
			got := make([]time.Duration, 0, len(plan.Notifications))
			for _, n := range plan.Notifications {
				got = append(got, n.After)
			}
			if len(got) != len(tc.offsets) {
				t.Fatalf("offsets=%v, want %v", got, tc.offsets)
			}
			for i := range got {
				if got[i] != tc.offsets[i] {
					t.Fatalf("offsets=%v, want %v", got, tc.offsets)
				}
			}
		})
	}
}

func TestHumanizeRebootDelay(t *testing.T) {
	tests := []struct {
		in   time.Duration
		want string
	}{
		{30 * time.Second, "30 seconds"},
		{time.Second, "1 second"},
		{time.Minute, "1 minute"},
		{5 * time.Minute, "5 minutes"},
		{59 * time.Minute, "59 minutes"},
		{60 * time.Minute, "1 hour"},
		{61 * time.Minute, "61 minutes"},
		{120 * time.Minute, "2 hours"},
		{1440 * time.Minute, "24 hours"},
	}
	for _, tc := range tests {
		if got := humanizeRebootDelay(tc.in); got != tc.want {
			t.Errorf("humanizeRebootDelay(%s)=%q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestGraceMinutesAtLeastOne(t *testing.T) {
	tests := []struct {
		in   time.Duration
		want int
	}{
		{0, 1},
		{-time.Minute, 1},
		{time.Second, 1},
		{60 * time.Second, 1},
		{61 * time.Second, 2},
		{5 * time.Minute, 5},
	}
	for _, tc := range tests {
		if got := graceMinutesAtLeastOne(tc.in); got != tc.want {
			t.Errorf("graceMinutesAtLeastOne(%s)=%d, want %d", tc.in, got, tc.want)
		}
	}
}

// TestWindowsRebootArgsUseSeconds pins the unit conversion that shipped as a bug
// once already (#3252: `delay: 15` rebooted in 15 SECONDS on Windows and 15
// MINUTES on Linux, because `shutdown /t` takes seconds). The Windows file that
// consumes these args is behind //go:build windows and therefore tested nowhere
// in CI (#3019, #3046) — this assertion is the only thing standing between that
// trap and production.
func TestWindowsRebootArgsUseSeconds(t *testing.T) {
	tests := []struct {
		grace time.Duration
		want  string
	}{
		{60 * time.Second, "60"},
		{time.Minute, "60"},
		{5 * time.Minute, "300"},
		{0, "0"},
		{-time.Minute, "0"}, // never a negative /t
	}
	for _, tc := range tests {
		args := windowsRebootArgs(tc.grace)
		if len(args) != 5 || args[0] != "/r" || args[1] != "/t" || args[3] != "/d" {
			t.Fatalf("windowsRebootArgs(%s)=%v, want /r /t <seconds> /d <reason>", tc.grace, args)
		}
		if args[2] != tc.want {
			t.Errorf("windowsRebootArgs(%s) countdown=%q, want %q seconds", tc.grace, args[2], tc.want)
		}
		if args[4] != "p:2:17" {
			t.Errorf("windowsRebootArgs(%s) reason code=%q, want p:2:17 (Planned/OS/Installation)", tc.grace, args[4])
		}
	}
}

// TestUnixRebootArgsUseMinutesAndNeverZero is the other half of the #3252 trap:
// BSD/Linux `shutdown -r +N` is MINUTES, and `+0` would take the session down
// before the closing toast rendered.
func TestUnixRebootArgsUseMinutesAndNeverZero(t *testing.T) {
	tests := []struct {
		grace time.Duration
		want  string
	}{
		{time.Minute, "+1"},
		{60 * time.Second, "+1"},
		{90 * time.Second, "+2"},
		{5 * time.Minute, "+5"},
		{0, "+1"},
		{-time.Minute, "+1"},
	}
	for _, tc := range tests {
		args := unixRebootArgs(tc.grace)
		if len(args) < 2 || args[0] != "-r" {
			t.Fatalf("unixRebootArgs(%s)=%v, want -r +<minutes> <message>", tc.grace, args)
		}
		if args[1] != tc.want {
			t.Errorf("unixRebootArgs(%s) countdown=%q, want %q minutes", tc.grace, args[1], tc.want)
		}
		if args[1] == "+0" {
			t.Errorf("unixRebootArgs(%s) produced +0 — the closing toast cannot render", tc.grace)
		}
	}
}

// TestOSGraceMatchesWhatTheUserWasTold ties the two together: whatever grace the
// plan hands the OS, both platforms' argument builders must express that same
// duration, just in their own unit.
func TestOSGraceMatchesWhatTheUserWasTold(t *testing.T) {
	for _, minutes := range []int{1, 2, 5, 15, 60, 1440} {
		plan := PlanReboot(time.Duration(minutes) * time.Minute)

		winSeconds, err := strconv.Atoi(windowsRebootArgs(plan.OSGrace)[2])
		if err != nil {
			t.Fatalf("delay=%dm: windows countdown is not an integer: %v", minutes, err)
		}
		if want := int(plan.OSGrace / time.Second); winSeconds != want {
			t.Errorf("delay=%dm: windows countdown=%ds, want %ds (OSGrace=%s)", minutes, winSeconds, want, plan.OSGrace)
		}

		unixArg := unixRebootArgs(plan.OSGrace)[1]
		if want := fmt.Sprintf("+%d", graceMinutesAtLeastOne(plan.OSGrace)); unixArg != want {
			t.Errorf("delay=%dm: unix countdown=%q, want %q (OSGrace=%s)", minutes, unixArg, want, plan.OSGrace)
		}
	}
}
