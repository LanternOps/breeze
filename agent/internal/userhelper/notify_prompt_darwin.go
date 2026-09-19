//go:build darwin

package userhelper

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showNotifyPromptOS renders the interactive notification with osascript, the
// same no-cgo vehicle consent_dialog_darwin.go and notify_darwin.go use. Unlike
// Windows, `display dialog` takes real button labels, so the actions are shown
// verbatim and no legend is needed.
//
// Button order is reversed relative to the wire order: AppleScript draws the LAST
// button rightmost and that is where macOS puts the default action, so
// Actions[0] ("Restart now") has to go last to sit where a Mac user expects the
// affirmative button.
//
// No `cancel button` is declared, and an Esc/-128 cancel maps to "" rather than
// to a button. The plan originally called for mapping a cancel to the last button
// — but the last button is "Restart now", so a user who hits Escape would
// ACCELERATE their reboot to the shortest schedule the planner allows. "" leaves
// the countdown exactly where it was, which is the fail-safe direction and the
// same rule the manager applies to silence.
func showNotifyPromptOS(req ipc.NotifyRequest) (clicked string, shown bool) {
	buttons := notifyPromptDialogButtons(req.Actions)
	if len(buttons) == 0 {
		return "", false
	}

	title := req.Title
	if title == "" {
		title = "Restart Scheduled"
	}
	quoted := make([]string, 0, len(buttons))
	for _, b := range buttons {
		quoted = append(quoted, `"`+escapeAppleScript(b)+`"`)
	}
	script := fmt.Sprintf(
		`display dialog "%s" with title "%s" buttons {%s} default button "%s" with icon caution giving up after %d`,
		escapeAppleScript(req.Body),
		escapeAppleScript(title),
		strings.Join(quoted, ", "),
		escapeAppleScript(buttons[len(buttons)-1]),
		(notifyPromptTimeoutMs(req)+999)/1000,
	)

	// CombinedOutput, as in consent_dialog_darwin.go: stderr carries the -128
	// cancel marker that distinguishes a user dismissal from an infra failure.
	out, err := exec.Command("osascript", "-e", script).CombinedOutput()
	result := string(out)
	if err != nil {
		if strings.Contains(result, "-128") {
			// The user dismissed the dialog. A real interaction, but not a
			// decision — the restart stays exactly where it was scheduled.
			return "", true
		}
		log.Warn("osascript reboot prompt failed", "error", err.Error())
		return "", false
	}
	if strings.Contains(result, "gave up:true") {
		return "", true
	}
	return notifyPromptClickedButton(result, buttons), true
}
