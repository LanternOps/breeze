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

// linuxDesktop wires the real Linux seams into the untagged desktopDelivery,
// where every decision below — and the wall fallback (#9181) — lives and is
// tested on any platform.
var linuxDesktop = desktopDelivery{
	listSessions: linuxsession.List,
	zenityAvailable: func() bool {
		_, err := linuxsession.ResolveSystemBinary(zenityBinary)
		return err == nil
	},
	prompt: runZenityPrompt,
	notify: runNotifySend,
	wall: func(ctx context.Context, message string) error {
		return runWall(ctx, wallBinary, message)
	},
}

// DesktopPrompt is the Linux PromptFunc: it puts the reboot dialog in front of
// every signed-in graphical user, as that user, and reports what came back.
//
// The three answers it can give, and why each is what it is:
//
//   - ("", false) — no graphical session, or nothing could be shown. The manager
//     falls back to its ordinary notification (DesktopNotify, which walls on a
//     headless box) and the reboot proceeds on schedule. This is the ORDINARY
//     answer on a headless server and is not an error.
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
	return linuxDesktop.Prompt(title, body, urgency, actions, timeout)
}

// DesktopNotify is the Linux NotifyFunc: a plain warning with no buttons,
// delivered to every graphical session, or broadcast with wall(1) to terminal
// sessions when no desktop took it (#9181). See desktopDelivery.Notify.
func DesktopNotify(title, body, urgency string) {
	linuxDesktop.Notify(title, body, urgency)
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
	// Which outcomes deserve a WARN is a decision about the dialog's semantics,
	// so it lives in the untagged file with the rest of them and is tested on
	// every platform (#4941). This file only supplies the evidence.
	logDialogOutcome(s.ID, s.Username, run, actions, shown)
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
