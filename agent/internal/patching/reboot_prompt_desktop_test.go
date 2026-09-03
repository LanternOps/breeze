package patching

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
)

var testPromptActions = []string{RebootActionRestartNow, "Postpone 1 hour"}

func TestZenityPromptArgs(t *testing.T) {
	got := zenityPromptArgs("Restart Scheduled",
		"A system restart for updates is scheduled in 15 minutes.",
		testPromptActions, 90*time.Second)
	want := []string{
		"--question",
		"--title", "Restart Scheduled",
		"--text", "A system restart for updates is scheduled in 15 minutes.",
		"--no-markup",
		"--ok-label", "Restart now",
		"--cancel-label", zenityDismissLabel,
		"--extra-button", "Postpone 1 hour",
		"--timeout=90",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("zenityPromptArgs =\n%v\nwant\n%v", got, want)
	}
}

func TestZenityPromptArgsWithoutAPostponeOffer(t *testing.T) {
	// The manager only prompts when a postponement is available, but a
	// single-action call must still produce a valid dialog rather than an
	// --extra-button with no label.
	got := zenityPromptArgs("t", "b", []string{RebootActionRestartNow}, time.Minute)
	for _, arg := range got {
		if arg == "--extra-button" {
			t.Fatalf("single-action prompt emitted --extra-button: %v", got)
		}
	}
}

func TestDialogTimeoutSeconds(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want int
	}{
		{in: 90 * time.Second, want: 90},
		// Rounded up: a fractional second truncated to zero would mean
		// "--timeout=0", which zenity reads as no timeout at all — a modal
		// dialog left on screen forever.
		{in: 1500 * time.Millisecond, want: 2},
		{in: 0, want: 1},
		{in: -time.Second, want: 1},
		// Bounded by the same ceiling the rung planner applies, so a bad
		// caller cannot pin a dialog open past the reboot itself.
		{in: time.Hour, want: int(maxRebootPromptWindow / time.Second)},
	}
	for _, tc := range cases {
		if got := dialogTimeoutSeconds(tc.in); got != tc.want {
			t.Errorf("dialogTimeoutSeconds(%s) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestZenityResult(t *testing.T) {
	// zenity --question exit codes: 0 = OK, 1 = Cancel OR an --extra-button,
	// 5 = timeout. Cancel and extra-button share an exit code and are told
	// apart only by what the child printed on stdout — which is exactly the
	// distinction between "the user postponed" and "the user closed the box".
	cases := []struct {
		name        string
		run         desktopDialogRun
		wantClicked string
		wantShown   bool
	}{
		{
			name:        "ok button restarts now",
			run:         desktopDialogRun{started: true, exitCode: 0},
			wantClicked: RebootActionRestartNow, wantShown: true,
		},
		{
			name:        "extra button postpones",
			run:         desktopDialogRun{started: true, exitCode: 1, stdout: "Postpone 1 hour\n"},
			wantClicked: "Postpone 1 hour", wantShown: true,
		},
		{
			// The window's X, the ESC key and the Cancel button all land here.
			// None of them is a postponement: silence never buys time.
			name:        "dismissed without a decision",
			run:         desktopDialogRun{started: true, exitCode: 1},
			wantClicked: "", wantShown: true,
		},
		{
			name:        "an unrecognised stdout is not a decision",
			run:         desktopDialogRun{started: true, exitCode: 1, stdout: "Restart now"},
			wantClicked: "", wantShown: true,
		},
		{
			name:        "zenity timeout leaves the schedule alone",
			run:         desktopDialogRun{started: true, exitCode: 5},
			wantClicked: "", wantShown: true,
		},
		{
			// We killed it because it outlived its window. It was on screen the
			// whole time, so the user WAS warned — reporting shown=false here
			// would make the manager emit a duplicate notification.
			name:        "killed for overrunning its window still counts as shown",
			run:         desktopDialogRun{started: true, timedOut: true, exitCode: -1},
			wantClicked: "", wantShown: true,
		},
		{
			// Nothing reached a person, so the manager must fall back to the
			// plain notification or the #3197 always-warn invariant is lost.
			name:        "zenity could not be started",
			run:         desktopDialogRun{},
			wantClicked: "", wantShown: false,
		},
		{
			name:        "an unknown exit code is not a decision and not shown",
			run:         desktopDialogRun{started: true, exitCode: 3},
			wantClicked: "", wantShown: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clicked, shown := zenityResult(tc.run, testPromptActions)
			if clicked != tc.wantClicked || shown != tc.wantShown {
				t.Errorf("zenityResult(%+v) = (%q, %v), want (%q, %v)",
					tc.run, clicked, shown, tc.wantClicked, tc.wantShown)
			}
		})
	}
}

func TestNotifySendArgs(t *testing.T) {
	got := notifySendArgs("Restart Scheduled", "in 15 minutes", "critical", 30*time.Second)
	want := []string{
		"--app-name", desktopNotifyAppName,
		"-u", "critical",
		"-t", "30000",
		"--", "Restart Scheduled", "in 15 minutes",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("notifySendArgs =\n%v\nwant\n%v", got, want)
	}
}

func TestNotifySendArgsWithoutATimeoutNeverExpires(t *testing.T) {
	got := notifySendArgs("t", "b", "normal", 0)
	for _, arg := range got {
		if arg == "-t" {
			t.Fatalf("a plain warning must not carry an expiry: %v", got)
		}
	}
}

func TestNotifySendArgsDropsAnUnknownUrgency(t *testing.T) {
	// notify-send exits non-zero on an urgency it does not recognise, which
	// would turn a bad urgency string into a silently undelivered warning.
	got := notifySendArgs("t", "b", "screaming", 0)
	for _, arg := range got {
		if arg == "-u" {
			t.Fatalf("an unknown urgency must be dropped, not forwarded: %v", got)
		}
	}
}

func TestSanitizeDialogText(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{name: "plain text is untouched", in: "Restart in 15 minutes.", want: "Restart in 15 minutes."},
		{name: "newlines survive in a body", in: "line one\nline two", want: "line one\nline two"},
		{name: "NUL is stripped", in: "a\x00b", want: "ab"},
		{name: "carriage returns and escapes are stripped", in: "a\rb\x1b[31mc", want: "ab[31mc"},
		{name: "tabs are kept", in: "a\tb", want: "a\tb"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeDialogText(tc.in); got != tc.want {
				t.Errorf("sanitizeDialogText(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func fakeSessions(n int) []linuxsession.GraphicalSession {
	out := make([]linuxsession.GraphicalSession, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, linuxsession.GraphicalSession{
			ID: string(rune('a' + i)), Username: "u", UID: "100" + string(rune('0'+i)),
			Type: linuxsession.TypeX11, Display: ":0",
		})
	}
	return out
}

func TestPromptDesktopSessionsHeadlessBoxShowsNothing(t *testing.T) {
	// The backward-compatibility contract: no graphical session means
	// shown=false, the manager falls back to its plain notification, and the
	// reboot still happens on schedule.
	clicked, shown := promptDesktopSessions(context.Background(), nil,
		func(context.Context, linuxsession.GraphicalSession) (string, bool) {
			t.Fatal("no session should have been dialed")
			return "", false
		})
	if clicked != "" || shown {
		t.Errorf("got (%q, %v), want (\"\", false) on a headless box", clicked, shown)
	}
}

func TestPromptDesktopSessionsReturnsTheAnswer(t *testing.T) {
	clicked, shown := promptDesktopSessions(context.Background(), fakeSessions(1),
		func(context.Context, linuxsession.GraphicalSession) (string, bool) {
			return "Postpone 1 hour", true
		})
	if clicked != "Postpone 1 hour" || !shown {
		t.Errorf("got (%q, %v), want (\"Postpone 1 hour\", true)", clicked, shown)
	}
}

func TestPromptDesktopSessionsReportsShownWithNoDecision(t *testing.T) {
	// A user looked at the dialog and did nothing. That is NOT the same as
	// "nobody saw it": the manager must not re-warn.
	clicked, shown := promptDesktopSessions(context.Background(), fakeSessions(2),
		func(context.Context, linuxsession.GraphicalSession) (string, bool) {
			return "", true
		})
	if clicked != "" || !shown {
		t.Errorf("got (%q, %v), want (\"\", true)", clicked, shown)
	}
}

func TestPromptDesktopSessionsReportsNotShownWhenEveryDialogFailed(t *testing.T) {
	clicked, shown := promptDesktopSessions(context.Background(), fakeSessions(3),
		func(context.Context, linuxsession.GraphicalSession) (string, bool) {
			return "", false
		})
	if clicked != "" || shown {
		t.Errorf("got (%q, %v), want (\"\", false)", clicked, shown)
	}
}

func TestPromptDesktopSessionsReportsShownIfAnySessionRendered(t *testing.T) {
	var mu sync.Mutex
	seen := 0
	clicked, shown := promptDesktopSessions(context.Background(), fakeSessions(2),
		func(_ context.Context, s linuxsession.GraphicalSession) (string, bool) {
			mu.Lock()
			defer mu.Unlock()
			seen++
			return "", seen == 1
		})
	if clicked != "" || !shown {
		t.Errorf("got (%q, %v), want (\"\", true) when one of two rendered", clicked, shown)
	}
}

func TestPromptDesktopSessionsTakesTheFirstAnswerAndClosesTheRest(t *testing.T) {
	// Two people are signed in. The first to answer decides, and the other
	// dialog must come off the screen instead of sitting there offering a
	// postponement that has already been spent.
	cancelled := make(chan struct{})
	clicked, shown := promptDesktopSessions(context.Background(), fakeSessions(2),
		func(ctx context.Context, s linuxsession.GraphicalSession) (string, bool) {
			if s.ID == "a" {
				return RebootActionRestartNow, true
			}
			// The loser waits to be cancelled.
			<-ctx.Done()
			close(cancelled)
			return "", true
		})
	if clicked != RebootActionRestartNow || !shown {
		t.Fatalf("got (%q, %v), want (%q, true)", clicked, shown, RebootActionRestartNow)
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("the losing dialog was never cancelled")
	}
}

func TestNotifyDesktopSessionsReportsAnySuccess(t *testing.T) {
	cases := []struct {
		name     string
		sessions int
		results  []bool
		want     bool
	}{
		{name: "headless box", sessions: 0, want: false},
		{name: "one delivery", sessions: 1, results: []bool{true}, want: true},
		{name: "every delivery failed", sessions: 2, results: []bool{false, false}, want: false},
		{name: "one of two delivered", sessions: 2, results: []bool{false, true}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			i := 0
			got := notifyDesktopSessions(context.Background(), fakeSessions(tc.sessions),
				func(context.Context, linuxsession.GraphicalSession) bool {
					r := tc.results[i]
					i++
					return r
				})
			if got != tc.want {
				t.Errorf("notifyDesktopSessions = %v, want %v", got, tc.want)
			}
		})
	}
}
