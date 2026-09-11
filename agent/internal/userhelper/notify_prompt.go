// The interactive half of the notification path (issue #3207).
//
// A NotifyRequest carrying Actions is a question, not an announcement: the daemon
// is blocked waiting for the answer, and the answer moves a real reboot. This
// file holds everything that decides what the dialog is asked to render and what
// its answer means, deliberately untagged — the two native vehicles behind
// showNotifyPromptFn are windows/darwin-only and so are tested nowhere in CI
// (#3019, #3046).
//
// It reuses the consent-dialog vehicles (MessageBoxTimeoutW, osascript display
// dialog) rather than toast activation buttons. Toast actions are unreliable on
// Server SKUs and in RDS sessions, need a registered COM activator to route the
// click back to a process, and silently degrade to a plain toast when the user
// has notifications muted — which for a reboot prompt means the postponement
// button simply is not there. See the plan's decision D4.
package userhelper

import (
	"strings"
	"sync"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	// defaultNotifyPromptTimeoutMs is how long a prompt waits when the daemon
	// sent no bound. Two minutes: long enough for someone who stepped away from
	// the keyboard to come back, short enough that the reboot's next warning rung
	// is not held up behind it.
	defaultNotifyPromptTimeoutMs = 120_000
	// maxNotifyPromptTimeoutMs caps a hostile or buggy daemon payload. A dialog
	// that never gives up is a dialog the user cannot dismiss.
	maxNotifyPromptTimeoutMs = 600_000
)

// showNotifyPromptFn is the platform dialog seam; tests swap it for a fake.
//
// It blocks until the user answers or the countdown expires, mirroring
// showConsentDialogFn (consent.go) — the same request/response-with-timeout
// shape, which is why this reuses those platform vehicles.
//
// It returns the LABEL of the clicked button, or "" for "no decision". shown
// reports whether a dialog actually rendered: "" with shown=false means the
// platform could not put anything on screen, which the caller must treat as the
// user having been told NOTHING (and fall back to a toast) rather than as a
// silent user.
var showNotifyPromptFn = showNotifyPromptOS

// notifyPromptMu serialises prompts inside one helper process. Both native
// vehicles are system-modal and topmost, so a second prompt raised while one is
// open stacks on top of it and steals focus; the user then answers a dialog they
// did not read. A prompt that cannot take the lock reports shown=false, which
// routes it to the plain toast rather than queueing it behind a dialog whose own
// countdown may still have two minutes to run.
var notifyPromptMu sync.Mutex

// notifyPromptTimeoutMs bounds the countdown the dialog is given.
func notifyPromptTimeoutMs(req ipc.NotifyRequest) int {
	if req.TimeoutMs <= 0 {
		return defaultNotifyPromptTimeoutMs
	}
	if req.TimeoutMs > maxNotifyPromptTimeoutMs {
		return maxNotifyPromptTimeoutMs
	}
	return req.TimeoutMs
}

// notifyPromptAction maps a button position back to the label the daemon sent.
// Out-of-range positions yield "" — no decision — because inventing a label the
// daemon never offered is the one outcome that could move a reboot the user did
// not ask to move.
func notifyPromptAction(actions []string, index int) string {
	if index < 0 || index >= len(actions) {
		return ""
	}
	return actions[index]
}

// notifyPromptLegend spells out which fixed message-box button is which action.
// Windows' MB_YESNO labels cannot be renamed, so "Postpone 1 hour" has to be
// explained in the body text or the dialog reads as a bare Yes/No about nothing.
// Untagged so the copy is asserted in CI, where no windows-tagged code runs.
func notifyPromptLegend(actions []string) string {
	yes := notifyPromptAction(actions, 0)
	no := notifyPromptAction(actions, 1)
	switch {
	case yes != "" && no != "":
		return "Select Yes to " + strings.ToLower(yes) + ", or No to " + strings.ToLower(no) + "."
	case yes != "":
		return "Select Yes to " + strings.ToLower(yes) + "."
	default:
		return ""
	}
}

// maxNotifyPromptDialogButtons is AppleScript's hard limit for `display dialog`.
// The sanitiser already caps Actions at 4, which osascript would reject outright.
const maxNotifyPromptDialogButtons = 3

// notifyPromptDialogButtons turns the wire actions into the button row for a
// dialog that renders real labels (macOS). The order is REVERSED because
// AppleScript draws the last button rightmost, which is where macOS puts the
// default action — so Actions[0], the affirmative, has to go last.
//
// Untagged so the ordering is asserted in CI; getting it backwards would put
// "Restart now" under the user's return key on Windows and under Postpone on
// macOS, and no windows/darwin-tagged test runs anywhere.
func notifyPromptDialogButtons(actions []string) []string {
	buttons := make([]string, 0, len(actions))
	for i := len(actions) - 1; i >= 0; i-- {
		if strings.TrimSpace(actions[i]) == "" {
			continue
		}
		buttons = append(buttons, actions[i])
		if len(buttons) == maxNotifyPromptDialogButtons {
			break
		}
	}
	return buttons
}

// notifyPromptClickedButton reads the clicked label out of an osascript
// `display dialog` record, e.g. "button returned:Restart now, gave up:false".
//
// The label is matched against the buttons we actually offered and anything else
// yields "" — a label the daemon never sent could otherwise be echoed straight
// back and read as a decision.
func notifyPromptClickedButton(output string, buttons []string) string {
	const marker = "button returned:"
	i := strings.Index(output, marker)
	if i < 0 {
		return ""
	}
	rest := output[i+len(marker):]
	if end := strings.Index(rest, ", gave up:"); end >= 0 {
		rest = rest[:end]
	}
	rest = strings.TrimSpace(rest)
	for _, b := range buttons {
		if rest == b {
			return b
		}
	}
	return ""
}

// showNotifyPrompt runs the platform dialog under the single-prompt lock.
func showNotifyPrompt(req ipc.NotifyRequest) (clicked string, shown bool) {
	if !notifyPromptMu.TryLock() {
		log.Warn("a reboot prompt is already on screen; showing this warning as a toast instead",
			"title", req.Title)
		return "", false
	}
	defer notifyPromptMu.Unlock()
	return showNotifyPromptFn(req)
}
