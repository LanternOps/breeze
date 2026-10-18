// Untagged on purpose — see reboot_desktop_delivery.go. Every branch of the
// Linux warning vehicle, including the wall fallback (#9181), is asserted here
// on every platform; only the real seams live behind //go:build linux.
package patching

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
)

// fakeDesktop records every seam call a desktopDelivery makes.
type fakeDesktop struct {
	mu        sync.Mutex
	sessions  []linuxsession.GraphicalSession
	listErr   error
	zenity    bool
	promptAns string
	promptOK  bool
	notifyOK  bool
	wallErr   error

	prompts  int
	notifies int
	walls    []string
}

func (f *fakeDesktop) delivery() desktopDelivery {
	return desktopDelivery{
		listSessions: func(context.Context) ([]linuxsession.GraphicalSession, error) {
			return f.sessions, f.listErr
		},
		zenityAvailable: func() bool { return f.zenity },
		prompt: func(context.Context, linuxsession.GraphicalSession, string, string, []string, time.Duration) (string, bool) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.prompts++
			return f.promptAns, f.promptOK
		},
		notify: func(context.Context, linuxsession.GraphicalSession, string, string, string, time.Duration) bool {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.notifies++
			return f.notifyOK
		},
		wall: func(_ context.Context, msg string) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.walls = append(f.walls, msg)
			return f.wallErr
		},
	}
}

func TestDesktopNotifyWallsWhenNoGraphicalSessionExists(t *testing.T) {
	f := &fakeDesktop{}
	f.delivery().Notify("Restart Scheduled", "Your computer restarts in 15 minutes.", "normal")

	if f.notifies != 0 {
		t.Errorf("notify-send ran %d times with no session to run it in", f.notifies)
	}
	if len(f.walls) != 1 {
		t.Fatalf("wall ran %d times, want 1 — a headless box must still be warned", len(f.walls))
	}
	if !strings.Contains(f.walls[0], "Restart Scheduled") || !strings.Contains(f.walls[0], "15 minutes") {
		t.Errorf("wall message %q lost the title or body", f.walls[0])
	}
}

func TestDesktopNotifyWallsWhenSessionEnumerationFails(t *testing.T) {
	f := &fakeDesktop{listErr: errors.New("loginctl: exit 1"), sessions: fakeSessions(1)}
	f.delivery().Notify("t", "b", "normal")

	if f.notifies != 0 {
		t.Errorf("notify-send ran %d times after enumeration failed", f.notifies)
	}
	if len(f.walls) != 1 {
		t.Fatalf("wall ran %d times, want 1 — not knowing who is signed in is not a reason to warn nobody", len(f.walls))
	}
}

func TestDesktopNotifyWallsWhenNoSessionTookTheNotification(t *testing.T) {
	f := &fakeDesktop{sessions: fakeSessions(2), notifyOK: false}
	f.delivery().Notify("t", "b", "normal")

	if f.notifies != 2 {
		t.Errorf("notify-send ran %d times, want one per session (2)", f.notifies)
	}
	if len(f.walls) != 1 {
		t.Fatalf("wall ran %d times, want 1 — every desktop refused the warning", len(f.walls))
	}
}

func TestDesktopNotifyDoesNotWallWhenADesktopTookIt(t *testing.T) {
	f := &fakeDesktop{sessions: fakeSessions(1), notifyOK: true}
	f.delivery().Notify("t", "b", "normal")

	if f.notifies != 1 {
		t.Errorf("notify-send ran %d times, want 1", f.notifies)
	}
	if len(f.walls) != 0 {
		t.Errorf("wall ran although the desktop took the warning: %q", f.walls)
	}
}

func TestDesktopNotifyWallFailureIsNotSilent(t *testing.T) {
	logs := captureWarnLogs(t)
	f := &fakeDesktop{wallErr: errors.New("wall: executable file not found")}
	f.delivery().Notify("Restart Scheduled", "b", "normal")

	if len(f.walls) != 1 {
		t.Fatalf("wall ran %d times, want 1", len(f.walls))
	}
	if !strings.Contains(logs.String(), "wall") || !strings.Contains(logs.String(), "not found") {
		t.Errorf("a failed last-resort warning left no trace in the log: %q", logs.String())
	}
}

func TestDesktopNotifyWithoutAWallSeamIsSafe(t *testing.T) {
	d := (&fakeDesktop{}).delivery()
	d.wall = nil
	d.Notify("t", "b", "normal") // must not panic
}

func TestDesktopPromptUsesTheSessionWhenOneExists(t *testing.T) {
	f := &fakeDesktop{sessions: fakeSessions(1), zenity: true, promptAns: "Postpone 1 hour", promptOK: true}
	clicked, shown := f.delivery().Prompt("t", "b", "normal", []string{"Restart now", "Postpone 1 hour"}, time.Second)

	if !shown || clicked != "Postpone 1 hour" {
		t.Errorf("Prompt = (%q, %v), want the session's answer", clicked, shown)
	}
	if f.prompts != 1 || len(f.walls) != 0 {
		t.Errorf("prompts=%d walls=%d, want the dialog and no wall", f.prompts, len(f.walls))
	}
}

func TestDesktopPromptReportsNothingShownWithNoSession(t *testing.T) {
	f := &fakeDesktop{zenity: true}
	clicked, shown := f.delivery().Prompt("t", "b", "normal", []string{"a", "b"}, time.Second)

	if shown || clicked != "" {
		t.Errorf("Prompt = (%q, %v), want (\"\", false) so the manager falls back to Notify", clicked, shown)
	}
	// The wall belongs to Notify, which the manager calls next. Prompt walling
	// too would put the same warning on every terminal twice.
	if f.prompts != 0 || len(f.walls) != 0 {
		t.Errorf("prompts=%d walls=%d on a headless box, want neither", f.prompts, len(f.walls))
	}
}

func TestDesktopPromptWithoutZenityStillWarnsTheDesktop(t *testing.T) {
	f := &fakeDesktop{sessions: fakeSessions(1), zenity: false, notifyOK: true}
	_, shown := f.delivery().Prompt("t", "b", "normal", []string{"a", "b"}, time.Second)

	if !shown || f.notifies != 1 || f.prompts != 0 {
		t.Errorf("shown=%v notifies=%d prompts=%d, want a plain desktop warning", shown, f.notifies, f.prompts)
	}
}

func TestWallMessage(t *testing.T) {
	cases := []struct {
		name, title, body, want string
	}{
		{"title and body", "Restart Scheduled", "Save your work.", "Restart Scheduled\n\nSave your work.\n"},
		{"multi-line body survives", "T", "line one\nline two", "T\n\nline one\nline two\n"},
		{"empty body is just the title", "T", "", "T\n"},
		{"control characters are stripped", "T\x1b[31m", "b\x00ody\x07", "T[31m\n\nbody\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := wallMessage(tc.title, tc.body); got != tc.want {
				t.Errorf("wallMessage(%q, %q) = %q, want %q", tc.title, tc.body, got, tc.want)
			}
		})
	}
}

// TestRunWallFeedsTheMessageOnStdin pins the wire shape: the message goes on
// stdin, never argv, so neither util-linux nor BusyBox wall can mistake it for
// a file name or an option.
func TestRunWallFeedsTheMessageOnStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("wall is a Unix tool")
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "got")
	script := filepath.Join(dir, "fake-wall")
	body := "#!/bin/sh\nprintf '%s' \"$#\" > " + out + ".argc\ncat > " + out + "\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}

	msg := wallMessage("Restart Scheduled", "-n --help")
	if err := runWall(context.Background(), script, msg); err != nil {
		t.Fatalf("runWall: %v", err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != msg {
		t.Errorf("wall stdin = %q, want %q", got, msg)
	}
	argc, _ := os.ReadFile(out + ".argc")
	if string(argc) != "0" {
		t.Errorf("wall got %s argv entries, want 0 — the message must not be an argument", argc)
	}
}

func TestRunWallReportsFailure(t *testing.T) {
	err := runWall(context.Background(), filepath.Join(t.TempDir(), "no-such-wall"), "m")
	if err == nil {
		t.Fatal("runWall succeeded with a missing binary")
	}
}

// TestLinuxLadderPromptsInTheSessionAndWallsWithoutOne drives the real reboot
// manager through the Linux vehicle (#9181): a schedule_reboot from a
// maintenance window must reach a signed-in desktop as the interactive prompt,
// and a headless box as a wall broadcast carrying the operator's text.
func TestLinuxLadderPromptsInTheSessionAndWallsWithoutOne(t *testing.T) {
	custom := RebootOptions{
		Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60},
		Prompt:   RebootPromptText{Title: "Neustart geplant"},
	}

	t.Run("desktop session gets the prompt", func(t *testing.T) {
		rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
		f := &fakeDesktop{sessions: fakeSessions(1), zenity: true, promptOK: true}
		d := f.delivery()
		rm.promptFn, rm.notifyFn = d.Prompt, d.Notify

		if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour),
			"Pending reboot — maintenance window", "maintenance_window", custom); err != nil {
			t.Fatalf("ScheduleWithOptions: %v", err)
		}
		timers.runAt(0)

		if f.prompts != 1 {
			t.Errorf("prompts = %d, want 1 — the lead rung must offer Postpone in the session", f.prompts)
		}
		if len(f.walls) != 0 {
			t.Errorf("wall ran although a desktop showed the prompt: %q", f.walls)
		}
	})

	t.Run("headless box gets wall with the custom text", func(t *testing.T) {
		rm, timers, _, _, clock, _ := newDeferralTestManager(t, 3)
		f := &fakeDesktop{zenity: true}
		d := f.delivery()
		rm.promptFn, rm.notifyFn = d.Prompt, d.Notify

		if err := rm.ScheduleWithOptions(15*time.Minute, clock.now().Add(5*time.Hour),
			"Pending reboot — maintenance window", "maintenance_window", custom); err != nil {
			t.Fatalf("ScheduleWithOptions: %v", err)
		}
		timers.runAt(0)

		if f.prompts != 0 {
			t.Errorf("prompts = %d with no session to draw in", f.prompts)
		}
		if len(f.walls) != 1 {
			t.Fatalf("walls = %d, want 1 — the lead warning must still reach terminals", len(f.walls))
		}
		if !strings.Contains(f.walls[0], "Neustart geplant") {
			t.Errorf("wall message %q dropped the operator's custom title (#8030)", f.walls[0])
		}
	})
}
