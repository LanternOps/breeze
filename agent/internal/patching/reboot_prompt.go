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
	"strings"
	"time"
	"unicode/utf8"
)

// PromptFunc shows an interactive notification and reports what came back.
//
// clicked is the LABEL of the clicked button, or "" for no decision: the
// countdown expired, or the user dismissed the dialog.
//
// shown reports whether anything was actually put in front of a person. It is
// the difference between "a user looked at the prompt and did nothing" and "no
// user was reachable at all", and the caller MUST branch on it: a reboot warning
// that rendered nowhere still has to reach the user through the ordinary
// notification path, or the #3197 always-warn invariant is lost on every device
// with no signed-in helper. Returning ("", false) is the normal, expected answer
// on a headless box, and is not an error.
//
// It blocks for up to timeout, so callers must not hold the manager lock across
// it.
type PromptFunc func(title, body, urgency string, actions []string, timeout time.Duration) (clicked string, shown bool)

// RebootActionRestartNow is the affirmative button. It is a constant because the
// manager compares what came back against what it sent; the postponement label
// carries a duration and so is built by rebootActionPostpone.
const RebootActionRestartNow = "Restart now"

// RebootPromptText is operator-supplied replacement copy for the restart
// warnings (#8030), resolved server-side from the patch policy and delivered on
// the schedule_reboot payload. Each field is independent; an empty field keeps
// the built-in English text for that part. The zero value is exactly today's
// behaviour, which is what an old API (that never sends the keys) produces.
type RebootPromptText struct {
	// Title replaces every rung's title.
	Title string
	// Body replaces every rung's body. RebootPromptCountdownPlaceholder is
	// replaced by the time left on that rung.
	Body string
	// Button replaces the "Restart now" label. Postponement labels are not
	// affected.
	Button string
}

// RebootPromptCountdownPlaceholder is the one placeholder a custom body or
// title may carry.
const RebootPromptCountdownPlaceholder = "{{countdown}}"

// Limits in runes, mirroring the API validator and the DB varchar lengths. The
// API rejects anything longer at write time; these re-check a payload that did
// not come from that path.
const (
	maxRebootPromptTitleRunes  = 100
	maxRebootPromptBodyRunes   = 500
	maxRebootPromptButtonRunes = 40
)

// SanitizeRebootPromptText re-validates custom prompt text from a command
// payload with the same rules the API applies on write: trimmed, valid UTF-8,
// within its length limit, no control characters (newline and tab are allowed
// in the body only), no '<' or '>', and no placeholder but {{countdown}}.
//
// A field that fails is DROPPED, not truncated or escaped, and its name is
// returned so the caller can log it. Dropping is deliberately the failure mode
// rather than rejecting the command: the reboot and its warnings still go out,
// in the built-in English, so bad copy can never cost a user their warning
// (#3197) — and text that was never validated never reaches a screen.
//
// Every rendering path already treats this text as data (exec arguments with
// no shell, AppleScript string escaping, toast XML escaping, zenity
// --no-markup); refusing markup characters here covers notify-send, which may
// render a body as markup and has no portable switch to stop it.
func SanitizeRebootPromptText(in RebootPromptText) (RebootPromptText, []string) {
	var out RebootPromptText
	var dropped []string
	check := func(name, value string, maxRunes int, multiline bool) string {
		value = strings.TrimSpace(value)
		if value == "" {
			return ""
		}
		if !validRebootPromptText(value, maxRunes, multiline) {
			dropped = append(dropped, name)
			return ""
		}
		return value
	}
	out.Title = check("title", in.Title, maxRebootPromptTitleRunes, false)
	out.Body = check("body", in.Body, maxRebootPromptBodyRunes, true)
	out.Button = check("button", in.Button, maxRebootPromptButtonRunes, false)
	return out, dropped
}

func validRebootPromptText(value string, maxRunes int, multiline bool) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, r := range value {
		if multiline && (r == '\n' || r == '\t') {
			continue
		}
		if r < 0x20 || r == 0x7f || r == '<' || r == '>' {
			return false
		}
	}
	rest := strings.ReplaceAll(value, RebootPromptCountdownPlaceholder, "")
	return !strings.Contains(rest, "{{") && !strings.Contains(rest, "}}")
}

// applyRebootPromptText returns the title and body one rung should show. With
// no custom text it returns the rung's built-in copy untouched.
func applyRebootPromptText(n RebootNotification, text RebootPromptText) (title, body string) {
	title, body = n.Title, n.Body
	countdown := humanizeRebootDelay(n.Countdown)
	if text.Title != "" {
		title = strings.ReplaceAll(text.Title, RebootPromptCountdownPlaceholder, countdown)
	}
	if text.Body != "" {
		body = strings.ReplaceAll(text.Body, RebootPromptCountdownPlaceholder, countdown)
	}
	return title, body
}

// rebootActionRestartNowLabel is the affirmative button for one rung. The
// manager compares the clicked label against exactly this string, so a custom
// label is honoured and the built-in one is not once a custom one was offered.
func rebootActionRestartNowLabel(n RebootNotification, text RebootPromptText) string {
	if text.Button != "" {
		return strings.ReplaceAll(text.Button, RebootPromptCountdownPlaceholder, humanizeRebootDelay(n.Countdown))
	}
	return RebootActionRestartNow
}

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

// planRebootRungsQuietLead is planRebootRungs for a schedule that a user's own
// postponement just re-planned (#4941).
//
// The lead rung of any plan fires at offset zero, so re-planning arms it at the
// instant the postponement was granted. Left deferrable it reopens the very
// dialog the user just answered — same question, counter decremented — which
// reads as the click not having worked. The warning itself is untouched: it is
// how the user learns the new restart time (#3197). Only the dialog goes away,
// and only on that one rung, so the rest of the budget is still offered by the
// reminder rungs of the new ladder.
func planRebootRungsQuietLead(plan RebootPlan) []rebootRung {
	rungs := planRebootRungs(plan)
	if len(rungs) > 0 {
		rungs[0].deferrable = false
		rungs[0].promptWindow = 0
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
