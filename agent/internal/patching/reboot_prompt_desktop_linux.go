//go:build linux

package patching

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
)

// stderrCaptureLimit bounds how much of a dialog's stderr is kept. Enough to
// hold a "cannot open display" line and the GTK noise around it; not enough to
// be a memory hazard if a child decides to shout.
const stderrCaptureLimit = 4096

// DesktopPrompt is the Linux PromptFunc: it puts the reboot dialog in front of
// every signed-in graphical user, as that user, and reports what came back.
//
// The three answers it can give, and why each is what it is:
//
//   - ("", false) — no graphical session, or nothing could be shown. The manager
//     falls back to its ordinary notification and the reboot proceeds on
//     schedule. This is the ORDINARY answer on a headless server and is not an
//     error.
//   - ("", true) — a dialog was on screen and nobody decided. The reboot
//     proceeds unchanged, and the manager emits nothing further, because the
//     dialog already was the warning.
//   - (label, true) — a user pressed one of the buttons we offered.
//
// When zenity is absent the prompt degrades to a plain notify-send warning:
// the user cannot postpone, but they are still told, which is the whole point
// of the #3197 ladder. That is reported as ("", true) so the manager does not
// emit a second, identical notification on top of it.
//
// The decision itself lives in promptOrNotifyDesktop, untagged, so every branch
// below is covered by tests that run on any platform; this function is just the
// seams.
func DesktopPrompt(title, body, urgency string, actions []string, timeout time.Duration) (string, bool) {
	// Two graces: one for the dialog itself and one for the enumeration and
	// process teardown around it. The manager is not holding its lock here, but
	// the rung goroutine is, in effect, the ladder — it must not hang.
	ctx, cancel := context.WithTimeout(context.Background(), timeout+2*desktopDialogGrace)
	defer cancel()

	sessions, err := linuxsession.List(ctx)
	if err != nil {
		log.Warn("could not enumerate graphical sessions for the reboot prompt", "error", err.Error())
	} else if len(sessions) == 0 {
		log.Debug("no graphical session to show the reboot prompt in")
	}

	_, zenityErr := linuxsession.ResolveSystemBinary(zenityBinary)
	if zenityErr != nil && err == nil && len(sessions) > 0 {
		log.Info("zenity is not installed; warning the desktop without a postponement offer",
			"sessions", len(sessions))
	}

	return promptOrNotifyDesktop(ctx, sessions, err, zenityErr == nil,
		func(ctx context.Context, s linuxsession.GraphicalSession) (string, bool) {
			return runZenityPrompt(ctx, s, title, body, actions, timeout)
		},
		func(ctx context.Context, s linuxsession.GraphicalSession) bool {
			return runNotifySend(ctx, s, title, body, urgency, timeout)
		})
}

// DesktopNotify is the Linux NotifyFunc: a plain warning with no buttons,
// delivered to every graphical session. Best-effort, but not silent — by the
// time this runs it is the LAST delivery path there is, so a failure here means
// the user was never warned at all and the log line is the only trace that will
// ever exist of it.
func DesktopNotify(title, body, urgency string) {
	ctx, cancel := context.WithTimeout(context.Background(), desktopNotifyTimeout)
	defer cancel()

	sessions, err := linuxsession.List(ctx)
	if err != nil {
		log.Warn("could not enumerate graphical sessions for a reboot notification; "+
			"the user may not have been warned", "error", err.Error())
		return
	}
	if len(sessions) == 0 {
		return
	}
	if !notifyDesktopSessions(ctx, sessions, func(ctx context.Context, s linuxsession.GraphicalSession) bool {
		// No expiry: a restart warning that disappears on its own is worse than
		// one the user has to dismiss.
		return runNotifySend(ctx, s, title, body, urgency, 0)
	}) {
		log.Warn("the reboot warning reached no graphical session",
			"sessions", len(sessions), "title", title)
	}
}

// runZenityPrompt shows one dialog in one session, as that session's user.
//
// The answer comes back as the exit code and stdout of a process this function
// forked itself. That is what makes the reply unspoofable by another local
// user: there is no socket, no file and no shared channel a third party could
// write to — only a pipe between this process and its own child, and the child
// runs as the very user whose decision it reports. A different local user
// cannot influence it without already being able to act as that user, at which
// point they could simply click the button. (The remaining lever is the zenity
// BINARY itself, which is why ResolveSystemBinary refuses anything outside a
// root-owned, non-group-writable path.)
func runZenityPrompt(ctx context.Context, s linuxsession.GraphicalSession, title, body string, actions []string, timeout time.Duration) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, timeout+desktopDialogGrace)
	defer cancel()

	cmd, err := s.Command(ctx, zenityBinary, zenityPromptArgs(title, body, actions, timeout)...)
	if err != nil {
		// A refused privilege drop lands here, and must read as "nothing was
		// shown" so the manager still warns through the plain path.
		log.Warn("could not build the reboot dialog for a graphical session",
			"session", s.ID, "user", s.Username, "error", err.Error())
		return zenityResult(desktopDialogRun{}, actions)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	started := time.Now()
	if err := cmd.Start(); err != nil {
		log.Warn("could not start the reboot dialog",
			"session", s.ID, "user", s.Username, "error", err.Error())
		return zenityResult(desktopDialogRun{}, actions)
	}

	waitErr := cmd.Wait()
	elapsed := time.Since(started)

	exitCode := 0
	hasExitStatus := waitErr == nil
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
			hasExitStatus = true
		}
	}
	run := classifyDialogRun(true, hasExitStatus, ctx.Err() != nil,
		exitCode, stdout.String(), truncateForLog(stderr.String()), elapsed)

	clicked, shown := zenityResult(run, actions)
	// Logged on EVERY non-clean exit, not only on codes this code does not
	// recognise. Exit 1 is a recognised code and is also what a display failure
	// produces, so restricting the log to "unexpected" codes is exactly how the
	// failure that matters most ends up with no trace at all.
	if run.exitCode != zenityExitOK || !shown {
		log.Warn("the reboot dialog did not end in a clean decision",
			"session", s.ID, "user", s.Username,
			"exitCode", run.exitCode, "timedOut", run.timedOut,
			"elapsedMs", elapsed.Milliseconds(), "shown", shown,
			"stderr", run.stderr)
	}
	return clicked, shown
}

// runNotifySend delivers one notification to one session, as that user.
func runNotifySend(ctx context.Context, s linuxsession.GraphicalSession, title, body, urgency string, expiry time.Duration) bool {
	ctx, cancel := context.WithTimeout(ctx, desktopNotifyTimeout)
	defer cancel()

	cmd, err := s.Command(ctx, notifySendBinary, notifySendArgs(title, body, urgency, expiry)...)
	if err != nil {
		log.Warn("could not build a desktop notification for a graphical session",
			"session", s.ID, "user", s.Username, "error", err.Error())
		return false
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		log.Warn("desktop notification failed",
			"session", s.ID, "user", s.Username, "error", err.Error(),
			"stderr", truncateForLog(stderr.String()))
		return false
	}
	return true
}

func truncateForLog(s string) string {
	if len(s) > stderrCaptureLimit {
		return s[:stderrCaptureLimit] + "…"
	}
	return s
}
