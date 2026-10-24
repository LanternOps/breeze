// The Linux daemon's reboot-warning vehicle with every OS touchpoint injected.
//
// UNTAGGED for the same reason as reboot_prompt_desktop.go: ./internal/patching
// is not in the test-agent-windows allowlist, and code behind a build tag is
// tested only on its own OS. Keeping the decisions here — prompt or plain
// notification, desktop or wall — means every branch is asserted by tests that
// run on any platform, and reboot_prompt_desktop_linux.go supplies nothing but
// the real seams.
package patching

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
)

const (
	// wallBinary is resolved through $PATH, like shutdown(8) in
	// reboot_os_linux.go and for the same reason: it runs as root, takes no
	// decision from its output, and is setgid tty on most distributions, so
	// linuxsession.ResolveSystemBinary (which refuses setgid binaries, because
	// it guards the tools that run AS another user) would reject it.
	wallBinary = "wall"

	// wallTimeout bounds one wall invocation. wall writes to each tty and
	// exits; it only hangs on a wedged terminal, and the ladder must not.
	wallTimeout = 10 * time.Second
)

// desktopDelivery is DesktopPrompt and DesktopNotify with their seams exposed.
type desktopDelivery struct {
	listSessions    func(ctx context.Context) ([]linuxsession.GraphicalSession, error)
	zenityAvailable func() bool
	prompt          func(ctx context.Context, s linuxsession.GraphicalSession, title, body string, actions []string, timeout time.Duration) (string, bool)
	notify          func(ctx context.Context, s linuxsession.GraphicalSession, title, body, urgency string, expiry time.Duration) bool
	// wall broadcasts to every logged-in terminal. May be nil, in which case a
	// warning no desktop took is logged and dropped.
	wall func(ctx context.Context, message string) error
}

// Prompt is the PromptFunc. See DesktopPrompt for the meaning of each answer.
//
// It never walls. ("", false) makes the manager fall back to its plain
// notification, which is Notify below, and Notify owns the wall fallback;
// walling here too would put every deferrable rung on each terminal twice.
func (d desktopDelivery) Prompt(title, body, urgency string, actions []string, timeout time.Duration) (string, bool) {
	// Two graces: one for the dialog itself and one for the enumeration and
	// process teardown around it. The manager is not holding its lock here, but
	// the rung goroutine is, in effect, the ladder — it must not hang.
	ctx, cancel := context.WithTimeout(context.Background(), timeout+2*desktopDialogGrace)
	defer cancel()

	sessions, err := d.listSessions(ctx)
	if err != nil {
		log.Warn("could not enumerate graphical sessions for the reboot prompt", "error", err.Error())
	} else if len(sessions) == 0 {
		log.Debug("no graphical session to show the reboot prompt in")
	}

	zenityOK := d.zenityAvailable != nil && d.zenityAvailable()
	if !zenityOK && err == nil && len(sessions) > 0 {
		log.Info("zenity is not installed; warning the desktop without a postponement offer",
			"sessions", len(sessions))
	}

	return promptOrNotifyDesktop(ctx, sessions, err, zenityOK,
		func(ctx context.Context, s linuxsession.GraphicalSession) (string, bool) {
			return d.prompt(ctx, s, title, body, actions, timeout)
		},
		func(ctx context.Context, s linuxsession.GraphicalSession) bool {
			return d.notify(ctx, s, title, body, urgency, timeout)
		})
}

// Notify is the NotifyFunc: a plain warning with no buttons, delivered to every
// graphical session, and broadcast with wall(1) when no desktop took it (#9181).
//
// By the time this runs it is the LAST delivery path there is, so it must not
// give up just because nobody is signed in at a desk. A headless server, a box
// whose logind could not be asked, or one where every notify-send failed all
// fall through to wall, which reaches SSH and console sessions — the audience
// the old `shutdown -r +N` maintenance reboot warned, and the only one a
// headless box has. The wall goes out only when the desktop path reached
// nobody, so a signed-in desktop user is not also handed a terminal broadcast.
func (d desktopDelivery) Notify(title, body, urgency string) {
	ctx, cancel := context.WithTimeout(context.Background(), desktopNotifyTimeout)
	defer cancel()

	sessions, err := d.listSessions(ctx)
	switch {
	case err != nil:
		log.Warn("could not enumerate graphical sessions for a reboot notification; falling back to wall",
			"error", err.Error())
	case len(sessions) == 0:
		log.Debug("no graphical session for the reboot notification; falling back to wall")
	default:
		if notifyDesktopSessions(ctx, sessions, func(ctx context.Context, s linuxsession.GraphicalSession) bool {
			// No expiry: a restart warning that disappears on its own is worse
			// than one the user has to dismiss.
			return d.notify(ctx, s, title, body, urgency, 0)
		}) {
			return
		}
		log.Warn("the reboot warning reached no graphical session; falling back to wall",
			"sessions", len(sessions), "title", title)
	}

	if d.wall == nil {
		log.Warn("the reboot warning reached no graphical session and no wall fallback is wired; "+
			"the user may not have been warned", "title", title)
		return
	}
	// A fresh budget: the desktop fan-out may have spent all of ctx.
	wallCtx, wallCancel := context.WithTimeout(context.Background(), wallTimeout)
	defer wallCancel()
	if err := d.wall(wallCtx, wallMessage(title, body)); err != nil {
		log.Warn("the reboot warning reached no graphical session and wall failed; "+
			"the user may not have been warned", "title", title, "error", err.Error())
		return
	}
	// wall exits 0 even when no terminal is open, so this records that the
	// broadcast was attempted, not that anyone read it.
	log.Info("reboot warning broadcast with wall", "title", title)
}

// wallMessage renders a warning for a terminal broadcast: the title, a blank
// line, the body. Control characters are stripped (newline and tab survive)
// because the body can carry the operator's own text (#8030) and an escape
// sequence written to every tty on the box is a terminal-injection vector.
// util-linux wall filters these too; BusyBox wall does not.
func wallMessage(title, body string) string {
	title = sanitizeDialogText(title)
	body = sanitizeDialogText(body)
	if strings.TrimSpace(body) == "" {
		return title + "\n"
	}
	return title + "\n\n" + body + "\n"
}

// runWall broadcasts message with wall(1), passing it on stdin.
//
// Stdin rather than argv because util-linux takes its argument as either a
// message or a FILE NAME, and BusyBox only ever as a file name — a message
// that happened to name a readable file would broadcast that file instead.
// Both read stdin when given no argument.
func runWall(ctx context.Context, binary, message string) error {
	cmd := exec.CommandContext(ctx, binary)
	cmd.Stdin = strings.NewReader(message)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%s: no response after %s, killed", binary, wallTimeout)
	}
	return fmt.Errorf("%s: %w (%s)", binary, err, strings.TrimSpace(string(out)))
}
