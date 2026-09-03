// The prompt half of the reboot warning ladder (issue #3207).
//
// Untagged for the same reason reboot_plan.go and reboot_deferral.go are: the
// dialogs themselves are windows/darwin-only and therefore tested nowhere in CI
// (#3019, #3046), so every decision ABOUT the dialog — which rungs may offer a
// button, how long it may stay on screen, what the buttons say — lives here as
// pure data.
package patching

import (
	"fmt"
	"time"
)

// PromptFunc shows an interactive notification and returns the LABEL of the
// clicked button. "" means no decision: the countdown expired, the dialog could
// not render, or the user dismissed it. A nil PromptFunc means this build has no
// interactive surface at all, which is the normal case on a headless box.
//
// It blocks for up to timeout, so callers must not hold the manager lock across
// it.
type PromptFunc func(title, body, urgency string, actions []string, timeout time.Duration) string

// RebootActionRestartNow is the affirmative button. It is a constant because the
// manager compares what came back against what it sent; the postponement label
// carries a duration and so is built by rebootActionPostpone.
const RebootActionRestartNow = "Restart now"

// maxRebootPromptWindow caps how long a dialog may sit on screen. Two minutes:
// long enough for someone who stepped away to come back, short enough that a
// 24-hour schedule does not leave a system-modal dialog up for an hour.
const maxRebootPromptWindow = 2 * time.Minute

// minRebootPromptWindow is the floor for a tight ladder. Below this the dialog
// would close before a person could read it, so a rung with less room than this
// simply does not offer a button (see planRebootRungs).
const minRebootPromptWindow = 20 * time.Second

// rebootActionPostpone renders the postponement button. The label carries the
// window because "Postpone" alone gives the user no way to judge the offer.
func rebootActionPostpone(d time.Duration) string {
	return "Postpone " + humanizeRebootDelay(d)
}

// rebootRung is one warning in the ladder plus the prompt policy that applies to
// it. Computed up front from the plan, as pure data, so the "never prompt on the
// closing rung" rule is asserted without driving timers.
type rebootRung struct {
	notification RebootNotification
	// deferrable is false for the closing rung, and for any rung with too little
	// room before the next one for a dialog to be worth opening. The closing
	// notice fires at OSInvokeAt, from which moment Defer() is refused because
	// the countdown lives in the OS — a button there could only ever fail.
	deferrable bool
	// promptWindow is how long the dialog may stay open. It never outlives the
	// next rung: a dialog still on screen then would make the helper refuse to
	// stack a second modal, silently costing the ladder a warning.
	promptWindow time.Duration
}

// planRebootRungs pairs every notification in the plan with its prompt policy.
func planRebootRungs(plan RebootPlan) []rebootRung {
	rungs := make([]rebootRung, 0, len(plan.Notifications))
	for i, n := range plan.Notifications {
		rung := rebootRung{notification: n}
		if n.After != plan.OSInvokeAt {
			// The room before the next rung, or before the OS invocation if this
			// is the last rung that precedes it.
			next := plan.OSInvokeAt
			if i+1 < len(plan.Notifications) {
				next = plan.Notifications[i+1].After
			}
			window := next - n.After
			if window > maxRebootPromptWindow {
				window = maxRebootPromptWindow
			}
			if window >= minRebootPromptWindow {
				rung.deferrable = true
				rung.promptWindow = window
			}
		}
		rungs = append(rungs, rung)
	}
	return rungs
}

// rebootDeferralNote is the line appended to a deferrable reboot's warning so the
// user can see where they stand. Empty when the policy is off, which is what
// keeps a non-deferrable reboot's copy byte-for-byte identical to today's.
func rebootDeferralNote(policy DeferralPolicy, used int, canPostpone bool) string {
	if !policy.Allowed || policy.MaxDeferrals <= 0 {
		return ""
	}
	if !canPostpone {
		return "This restart can no longer be postponed."
	}
	remaining := policy.MaxDeferrals - used
	if remaining <= 0 {
		return "This restart can no longer be postponed."
	}
	if remaining == 1 {
		return "You can postpone this restart 1 more time."
	}
	return fmt.Sprintf("You can postpone this restart %d more times.", remaining)
}

// rebootPromptBody joins the plan's warning text with the deferral note.
func rebootPromptBody(body, note string) string {
	if note == "" {
		return body
	}
	if body == "" {
		return note
	}
	return body + "\n\n" + note
}
