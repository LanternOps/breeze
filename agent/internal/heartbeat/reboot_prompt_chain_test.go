package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

func recordingPrompt(clicked string, shown bool, calls *int) patching.PromptFunc {
	return func(string, string, string, []string, time.Duration) (string, bool) {
		*calls++
		return clicked, shown
	}
}

func TestChainedRebootPromptStopsAtTheHelperWhenItReachedSomeone(t *testing.T) {
	helperCalls, localCalls := 0, 0
	chain := chainedRebootPrompt(
		recordingPrompt("Restart now", true, &helperCalls),
		recordingPrompt("Postpone 1 hour", true, &localCalls),
	)
	clicked, shown := chain("t", "b", "critical", []string{"Restart now"}, time.Minute)
	if clicked != "Restart now" || !shown {
		t.Fatalf("got (%q, %v), want (\"Restart now\", true)", clicked, shown)
	}
	if localCalls != 0 {
		t.Error("the daemon dialog ran on top of a helper dialog the user already answered")
	}
}

func TestChainedRebootPromptStopsAtTheHelperEvenWithNoDecision(t *testing.T) {
	// shown=true with an empty label is a user who looked and did nothing.
	// Asking again would put a second dialog in front of them.
	helperCalls, localCalls := 0, 0
	chain := chainedRebootPrompt(
		recordingPrompt("", true, &helperCalls),
		recordingPrompt("Restart now", true, &localCalls),
	)
	clicked, shown := chain("t", "b", "critical", []string{"Restart now"}, time.Minute)
	if clicked != "" || !shown {
		t.Fatalf("got (%q, %v), want (\"\", true)", clicked, shown)
	}
	if localCalls != 0 {
		t.Error("a second dialog was drawn for a user who had already seen one")
	}
}

func TestChainedRebootPromptFallsThroughWhenTheHelperReachedNobody(t *testing.T) {
	// The Linux case: no helper binary ships, so the broker reports
	// delivered=false immediately and the daemon draws the dialog itself.
	helperCalls, localCalls := 0, 0
	chain := chainedRebootPrompt(
		recordingPrompt("", false, &helperCalls),
		recordingPrompt("Postpone 1 hour", true, &localCalls),
	)
	clicked, shown := chain("t", "b", "critical", []string{"Restart now", "Postpone 1 hour"}, time.Minute)
	if clicked != "Postpone 1 hour" || !shown {
		t.Fatalf("got (%q, %v), want (\"Postpone 1 hour\", true)", clicked, shown)
	}
	if helperCalls != 1 || localCalls != 1 {
		t.Errorf("helper called %d times, local %d; want 1 and 1", helperCalls, localCalls)
	}
}

func TestChainedRebootPromptReportsNotShownWhenNeitherVehicleWorked(t *testing.T) {
	// A headless Linux server. The manager must fall back to its plain
	// notification, so shown MUST stay false — reporting true here is how the
	// #3197 always-warn invariant gets lost.
	helperCalls, localCalls := 0, 0
	chain := chainedRebootPrompt(
		recordingPrompt("", false, &helperCalls),
		recordingPrompt("", false, &localCalls),
	)
	if clicked, shown := chain("t", "b", "critical", nil, time.Minute); clicked != "" || shown {
		t.Fatalf("got (%q, %v), want (\"\", false)", clicked, shown)
	}
}

func TestChainedRebootPromptToleratesMissingLinks(t *testing.T) {
	if clicked, shown := chainedRebootPrompt(nil, nil)("t", "b", "low", nil, time.Minute); clicked != "" || shown {
		t.Fatalf("got (%q, %v), want (\"\", false)", clicked, shown)
	}
}

func TestChainedRebootNotifyAddsTheDaemonPathOnlyWithNoHelper(t *testing.T) {
	cases := []struct {
		name          string
		helperPresent bool
		wantLocal     int
	}{
		{name: "a helper session took the broadcast", helperPresent: true, wantLocal: 0},
		{name: "no helper session exists", helperPresent: false, wantLocal: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			broadcasts, locals := 0, 0
			notify := chainedRebootNotify(
				func(string, string, string) { broadcasts++ },
				func(string, string, string) { locals++ },
				func() bool { return tc.helperPresent },
			)
			notify("t", "b", "critical")
			// The broadcast is unconditional so Windows and macOS behaviour is
			// unchanged by this wave.
			if broadcasts != 1 {
				t.Errorf("broadcasts = %d, want 1", broadcasts)
			}
			if locals != tc.wantLocal {
				t.Errorf("daemon notifications = %d, want %d", locals, tc.wantLocal)
			}
		})
	}
}

func TestChainedRebootNotifyToleratesMissingLinks(t *testing.T) {
	// Must not panic: NewRebootManager is also built without a broker.
	chainedRebootNotify(nil, nil, nil)("t", "b", "critical")
}
