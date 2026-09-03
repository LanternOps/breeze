// The Linux vehicle for the reboot warning ladder (issue #3207, wave 4).
//
// Windows and macOS deliver the prompt through the desktop helper over the
// session-broker IPC. No helper binary ships for Linux — release.yml builds it
// for darwin only — so on Linux the broker has no session to talk to and every
// interactive rung was silently swallowed. The daemon therefore draws the
// dialog itself, dropping to the signed-in user to do it.
//
// This file is UNTAGGED and holds every decision: what argv zenity and
// notify-send are handed, what each exit code means, and how a fan-out across
// several signed-in users resolves to one answer. Only the exec — which needs
// syscall.Credential — is behind //go:build linux, in
// reboot_prompt_desktop_linux.go. The package is not in the
// test-agent-windows allowlist (#3019, #3046), so anything a build tag hides
// here is tested nowhere; that is why the split falls where it does.
package patching

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
)

const (
	zenityBinary     = "zenity"
	notifySendBinary = "notify-send"

	// desktopNotifyAppName is what the notification names itself as in the
	// shell's tray and notification list.
	desktopNotifyAppName = "Breeze"

	// zenityDismissLabel is the Cancel button. It must read as "do nothing",
	// because zenity gives the Cancel button, the window's close box and the
	// ESC key the same exit code — so whatever this says is also what a user
	// gets by dismissing the dialog, and neither may be read as a postponement.
	zenityDismissLabel = "Close"

	// desktopDialogGrace is how much longer than its own --timeout a dialog is
	// allowed to live before the agent kills it. zenity honours --timeout, but
	// a wedged X connection or a compositor mid-restart can leave the process
	// alive; without this the rung goroutine would block forever.
	desktopDialogGrace = 15 * time.Second

	// desktopNotifyTimeout bounds the whole notify-send fan-out. Notifications
	// are fire-and-forget; nothing downstream waits on the result.
	desktopNotifyTimeout = 20 * time.Second
)

// Both platform variants must satisfy the manager's seams exactly. Asserted
// here, in the untagged file, so a signature drift in either one is a compile
// error on every OS rather than on the one nobody builds locally.
var (
	_ PromptFunc = DesktopPrompt
	_ NotifyFunc = DesktopNotify
)

// zenityExit* are zenity's documented --question exit codes.
//
// 1 is the ambiguous one: Cancel, the window close box, ESC, AND every
// --extra-button all exit 1. They are told apart only by what the child printed
// on stdout, which is why the postponement is an --extra-button rather than the
// Cancel button. Putting "Postpone" on Cancel would turn every dismissal into a
// spent postponement.
const (
	zenityExitOK      = 0
	zenityExitCancel  = 1
	zenityExitTimeout = 5
)

// desktopDialogRun is everything the caller learned from one dialog process.
// A struct rather than an (int, error) pair so the "we killed it" case, which
// is neither a clean exit nor a start failure, has somewhere to live.
type desktopDialogRun struct {
	// started is false when the process never ran at all: zenity missing, the
	// privilege drop refused, fork failed. Nothing reached a person.
	started bool
	// timedOut is true when the agent's own context killed it. The dialog was
	// on screen for its whole window, so the user WAS warned.
	timedOut bool
	exitCode int
	stdout   string
}

// dialogTimeoutSeconds converts a rung's prompt window into zenity's --timeout,
// which takes whole seconds.
//
// Rounded UP and floored at 1: truncating a sub-second window to 0 would mean
// "--timeout=0", which zenity reads as no timeout at all, leaving a modal
// dialog on a user's screen indefinitely. Capped at maxRebootPromptWindow for
// the same reason the planner caps it — a dialog must never outlive the reboot
// it is announcing.
func dialogTimeoutSeconds(d time.Duration) int {
	if d > maxRebootPromptWindow {
		d = maxRebootPromptWindow
	}
	secs := int((d + time.Second - 1) / time.Second)
	if secs < 1 {
		secs = 1
	}
	return secs
}

// zenityPromptArgs builds the dialog's argv.
//
// argv, never a shell string: no part of this path goes through sh, so a quote,
// a semicolon or a backtick in a title or body is inert. --no-markup is the
// matching protection one level up, stopping Pango markup in the body from
// being rendered as markup.
//
// actions[0] is the affirmative and takes the OK button (exit 0). actions[1],
// when present, is the postponement and takes an --extra-button, so that it is
// distinguishable from a dismissal; see the exit-code comment above.
func zenityPromptArgs(title, body string, actions []string, timeout time.Duration) []string {
	args := []string{
		"--question",
		"--title", sanitizeDialogText(title),
		"--text", sanitizeDialogText(body),
		"--no-markup",
	}
	if len(actions) > 0 {
		args = append(args, "--ok-label", sanitizeDialogText(actions[0]))
	}
	args = append(args, "--cancel-label", zenityDismissLabel)
	if len(actions) > 1 {
		args = append(args, "--extra-button", sanitizeDialogText(actions[1]))
	}
	return append(args, "--timeout="+strconv.Itoa(dialogTimeoutSeconds(timeout)))
}

// zenityResult maps one dialog run onto the PromptFunc contract.
//
// The two return values answer different questions and the manager branches on
// both: clicked is WHICH offer was taken, shown is whether anything reached a
// person at all. Conflating them is how "nobody saw the dialog" becomes "the
// user ignored it" — the manager suppresses its fallback notification on
// shown=true, so a false positive there loses the #3197 always-warn invariant.
func zenityResult(run desktopDialogRun, actions []string) (string, bool) {
	if !run.started {
		return "", false
	}
	if run.timedOut {
		// Killed for overrunning its window. It was on screen throughout.
		return "", true
	}
	switch run.exitCode {
	case zenityExitOK:
		if len(actions) > 0 {
			return actions[0], true
		}
		return "", true
	case zenityExitCancel:
		// Cancel, ESC and the close box print nothing; an --extra-button prints
		// its own label. Only an exact match counts, so an unexpected line is
		// read as no decision rather than guessed at.
		printed := strings.TrimSpace(run.stdout)
		if len(actions) > 1 && printed == actions[1] {
			return actions[1], true
		}
		return "", true
	case zenityExitTimeout:
		return "", true
	default:
		// zenity crashed, or was never really a zenity. Report not-shown so the
		// manager still warns the user through the ordinary path.
		return "", false
	}
}

// notifySendUrgencies is the set notify-send accepts. Anything else makes it
// exit non-zero, which would turn a bad urgency string into an undelivered
// warning rather than an ugly one.
var notifySendUrgencies = map[string]bool{"low": true, "normal": true, "critical": true}

// notifySendArgs builds the argv for a plain desktop notification.
//
// A zero or negative expiry omits -t entirely, which leaves the notification up
// until the user dismisses it. That is the right default for a restart warning:
// one that vanishes after a few seconds is worse than one that lingers.
func notifySendArgs(title, body, urgency string, expiry time.Duration) []string {
	args := []string{"--app-name", desktopNotifyAppName}
	if notifySendUrgencies[urgency] {
		args = append(args, "-u", urgency)
	}
	if expiry > 0 {
		args = append(args, "-t", strconv.FormatInt(expiry.Milliseconds(), 10))
	}
	// "--" so a title or body that happens to start with a dash is a summary,
	// not a flag.
	return append(args, "--", sanitizeDialogText(title), sanitizeDialogText(body))
}

// sanitizeDialogText strips control characters that would corrupt a dialog or
// truncate an argument.
//
// Defence in depth rather than a fix for a live hole: every string on this path
// is built by reboot_plan.go and reboot_prompt.go from durations and constants,
// with no API- or user-supplied text anywhere in it. Tab and newline survive
// because a multi-line body is the normal shape (the deferral note is appended
// on its own line); NUL in particular is stripped because it would end the
// argument at the exec boundary.
func sanitizeDialogText(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

// desktopSessionPrompt shows one dialog in one session and reports the outcome.
type desktopSessionPrompt func(ctx context.Context, s linuxsession.GraphicalSession) (clicked string, shown bool)

// desktopSessionNotify delivers one notification to one session.
type desktopSessionNotify func(ctx context.Context, s linuxsession.GraphicalSession) bool

// promptDesktopSessions fans one prompt out to every signed-in graphical
// session and resolves them to a single answer.
//
// Same shape as W3's helper fan-out, and for the same reason: with fast user
// switching or multiple seats there can be several signed-in users, and any of
// them is entitled to answer for the machine. FIRST answer wins, and the losing
// dialogs are cancelled rather than left offering a postponement that has
// already been spent.
//
// Returning early leaves the losing goroutines to unwind on their own. The
// results channel is buffered to the session count so none of them can block on
// a send after this function has returned.
func promptDesktopSessions(ctx context.Context, sessions []linuxsession.GraphicalSession, run desktopSessionPrompt) (string, bool) {
	if len(sessions) == 0 {
		// A headless box. Not an error: the manager turns shown=false into its
		// ordinary notification and the reboot proceeds on schedule.
		return "", false
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type answer struct {
		clicked string
		shown   bool
	}
	results := make(chan answer, len(sessions))
	var wg sync.WaitGroup
	for _, s := range sessions {
		wg.Add(1)
		go func(s linuxsession.GraphicalSession) {
			defer wg.Done()
			clicked, shown := run(ctx, s)
			results <- answer{clicked: clicked, shown: shown}
		}(s)
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	shown := false
	for r := range results {
		shown = shown || r.shown
		if r.clicked != "" {
			// A decision. Take every other dialog off screen; the deferred
			// cancel would do it, but doing it here makes the intent explicit.
			cancel()
			return r.clicked, true
		}
	}
	return "", shown
}

// notifyDesktopSessions delivers a plain notification to every graphical
// session, reporting whether it reached at least one.
//
// Sequential, unlike the prompt fan-out: notify-send returns as soon as the
// notification daemon has taken the message, so there is nothing to overlap,
// and a serial loop keeps the delivery order deterministic.
func notifyDesktopSessions(ctx context.Context, sessions []linuxsession.GraphicalSession, notify desktopSessionNotify) bool {
	delivered := false
	for _, s := range sessions {
		if notify(ctx, s) {
			delivered = true
		}
	}
	return delivered
}
