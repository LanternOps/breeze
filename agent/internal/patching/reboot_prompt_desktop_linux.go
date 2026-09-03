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

// stderrCaptureLimit bounds how much of a failed dialog's stderr is kept for
// the log line. Enough to see "cannot open display"; not enough to be a hazard.
const stderrCaptureLimit = 512

// DesktopPrompt is the Linux PromptFunc: it puts the reboot dialog in front of
// every signed-in graphical user, as that user, and reports what came back.
//
// The three answers it can give, and why each is what it is:
//
//   - ("", false) — no graphical session, or nothing could be launched. The
//     manager falls back to its ordinary notification and the reboot proceeds
//     on schedule. This is the ORDINARY answer on a headless server and is not
//     an error.
//   - ("", true) — a dialog was on screen and nobody decided. The reboot
//     proceeds unchanged, and the manager emits nothing further, because the
//     dialog already was the warning.
//   - (label, true) — a user pressed one of the buttons we offered.
//
// When zenity is absent the prompt degrades to a plain notify-send warning:
// the user cannot postpone, but they are still told, which is the whole point
// of the #3197 ladder. That is reported as ("", true) so the manager does not
// emit a second, identical notification on top of it.
func DesktopPrompt(title, body, urgency string, actions []string, timeout time.Duration) (string, bool) {
	// Two graces: one for the dialog itself and one for the enumeration and
	// process teardown around it. The manager is not holding its lock here, but
	// the rung goroutine is, in effect, the ladder — it must not hang.
	ctx, cancel := context.WithTimeout(context.Background(), timeout+2*desktopDialogGrace)
	defer cancel()

	sessions, err := linuxsession.List(ctx)
	if err != nil {
		log.Warn("could not enumerate graphical sessions for the reboot prompt", "error", err.Error())
		return "", false
	}
	if len(sessions) == 0 {
		// Headless, or nobody signed in at a desk. The `shutdown -r +N` wall
		// message remains the warning for terminal sessions.
		log.Debug("no graphical session to show the reboot prompt in")
		return "", false
	}

	if _, err := linuxsession.ResolveSystemBinary(zenityBinary); err != nil {
		log.Info("zenity is not installed; warning the desktop without a postponement offer",
			"sessions", len(sessions))
		shown := notifyDesktopSessions(ctx, sessions,
			func(ctx context.Context, s linuxsession.GraphicalSession) bool {
				return runNotifySend(ctx, s, title, body, urgency, timeout)
			})
		return "", shown
	}

	return promptDesktopSessions(ctx, sessions,
		func(ctx context.Context, s linuxsession.GraphicalSession) (string, bool) {
			return runZenityPrompt(ctx, s, title, body, actions, timeout)
		})
}

// DesktopNotify is the Linux NotifyFunc: a plain warning with no buttons,
// delivered to every graphical session. Best-effort and silent on failure —
// this is the fallback path, and there is nothing further to fall back to.
func DesktopNotify(title, body, urgency string) {
	ctx, cancel := context.WithTimeout(context.Background(), desktopNotifyTimeout)
	defer cancel()

	sessions, err := linuxsession.List(ctx)
	if err != nil {
		log.Debug("could not enumerate graphical sessions for a reboot notification", "error", err.Error())
		return
	}
	if len(sessions) == 0 {
		return
	}
	notifyDesktopSessions(ctx, sessions, func(ctx context.Context, s linuxsession.GraphicalSession) bool {
		// No expiry: a restart warning that disappears on its own is worse than
		// one the user has to dismiss.
		return runNotifySend(ctx, s, title, body, urgency, 0)
	})
}

// runZenityPrompt shows one dialog in one session, as that session's user.
//
// The answer comes back as the exit code and stdout of a process this function
// forked itself. That is what makes the reply unspoofable by another local
// user: there is no socket, no file and no shared channel a third party could
// write to — only a pipe between this process and its own child, and the child
// runs as the very user whose decision it reports. A different local user
// cannot influence it without already being able to act as that user, at which
// point they could simply click the button.
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

	if err := cmd.Start(); err != nil {
		log.Warn("could not start the reboot dialog",
			"session", s.ID, "user", s.Username, "error", err.Error())
		return zenityResult(desktopDialogRun{}, actions)
	}

	waitErr := cmd.Wait()
	run := desktopDialogRun{started: true, stdout: stdout.String()}
	switch {
	case ctx.Err() != nil:
		// We killed it for overrunning its window. It was on screen throughout,
		// so this counts as shown even though no decision came back.
		run.timedOut = true
		log.Warn("the reboot dialog outlived its window and was closed",
			"session", s.ID, "user", s.Username)
	case waitErr == nil:
		run.exitCode = zenityExitOK
	default:
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			run.exitCode = exitErr.ExitCode()
		} else {
			// Not an exit status at all — an I/O failure on the pipes. Nothing
			// can be concluded about what the user saw, so take the safe
			// reading and let the manager warn again.
			run.started = false
			log.Warn("the reboot dialog failed while running",
				"session", s.ID, "user", s.Username, "error", waitErr.Error())
		}
	}
	if run.exitCode != zenityExitOK && run.exitCode != zenityExitCancel && run.exitCode != zenityExitTimeout {
		log.Warn("the reboot dialog exited unexpectedly",
			"session", s.ID, "user", s.Username, "exitCode", run.exitCode,
			"stderr", truncateForLog(stderr.String()))
	}
	return zenityResult(run, actions)
}

// runNotifySend delivers one notification to one session, as that user.
func runNotifySend(ctx context.Context, s linuxsession.GraphicalSession, title, body, urgency string, expiry time.Duration) bool {
	ctx, cancel := context.WithTimeout(ctx, desktopNotifyTimeout)
	defer cancel()

	cmd, err := s.Command(ctx, notifySendBinary, notifySendArgs(title, body, urgency, expiry)...)
	if err != nil {
		log.Debug("could not build a desktop notification for a graphical session",
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
