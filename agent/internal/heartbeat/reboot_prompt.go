package heartbeat

import (
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// notifyDecisionRequester is the one broker call the reboot prompt needs, taken
// as a function rather than an interface so the nil-broker case stays a plain nil
// check at the call site — a nil *sessionbroker.Broker stored in an interface is
// not a nil interface, and that distinction has no business in this logic.
type notifyDecisionRequester func(ipc.NotifyRequest, time.Duration) (ipc.NotifyResult, error)

// rebootPromptFunc adapts the broker's correlated notification request to the
// reboot manager's prompt seam.
//
// It exists as a named function rather than a closure inside the manager's
// construction so this translation is directly testable: it is the exact hop at
// which "the helper told us it showed nothing" could be mistaken for "the user
// looked at a dialog and chose not to click", and those two demand opposite
// behaviour from the manager.
//
//   - shown=false means nothing reached a person — no helper session, a dead
//     transport, or a helper that could put neither a dialog nor a toast on
//     screen. The manager falls back to the ordinary notification, which is what
//     keeps the #3197 always-warn invariant true on a headless box.
//   - shown=true with an empty label means a real person saw the prompt and did
//     nothing. The reboot proceeds exactly as scheduled and no second warning is
//     emitted, because the dialog already was the warning.
func rebootPromptFunc(request notifyDecisionRequester) patching.PromptFunc {
	return func(title, body, urgency string, actions []string, timeout time.Duration) (string, bool) {
		res, err := request(ipc.NotifyRequest{
			Title:     title,
			Body:      body,
			Urgency:   urgency,
			Actions:   actions,
			TimeoutMs: int(timeout.Milliseconds()),
		}, timeout)
		if err != nil {
			if errors.Is(err, sessionbroker.ErrCommandTimeout) {
				// The helper had the prompt and the user did not answer inside the
				// window. Ordinary, and not worth a warning on every rung — but it
				// is still "nothing was confirmed shown", so the manager falls back
				// rather than assuming a dialog the helper never acknowledged.
				log.Debug("reboot prompt went unanswered; proceeding as scheduled")
				return "", false
			}
			// A transport or helper error. This one IS worth seeing: it means the
			// interactive path is broken on this device, which is invisible from
			// the console.
			log.Warn("reboot prompt could not be delivered; falling back to a plain notification",
				"error", err.Error())
			return "", false
		}
		return res.ActionClicked, res.Delivered
	}
}

// chainedRebootPrompt tries the desktop helper first and the daemon-drawn
// dialog second (issue #3207, wave 4).
//
// Two delivery vehicles exist because only one of them works on any given
// platform. Windows and macOS ship a desktop helper and the broker talks to it.
// Linux ships none — release.yml builds the helper for darwin only — so on
// Linux the broker has no notify-scoped session, RequestNotificationDecision
// returns "delivered: false" immediately, and every interactive rung was
// silently swallowed. The second link is patching.DesktopPrompt, which draws
// the dialog from the daemon as the signed-in user; it is a no-op off Linux.
//
// The order matters and only one direction is safe. The helper is asked first
// because where it exists it IS the user's session, and falling through to it
// second would mean drawing two dialogs on the same screen.
//
// shown=false, not the clicked label, is what advances the chain: it is the
// only value that means "nothing reached a person". A helper that answered
// shown=true with an empty label is a user who looked and did nothing, and
// asking again would put a second dialog in front of someone who has already
// decided not to decide.
//
// Note on the timeout budget: today the fallthrough costs nothing, because a
// broker with no notify session refuses instantly rather than waiting out the
// window. If a Linux helper ever ships, a helper that times out would be
// followed by a full second window here — at which point this should take the
// remaining time rather than the whole of it.
func chainedRebootPrompt(helper, local patching.PromptFunc) patching.PromptFunc {
	return func(title, body, urgency string, actions []string, timeout time.Duration) (string, bool) {
		if helper != nil {
			if clicked, shown := helper(title, body, urgency, actions, timeout); shown {
				return clicked, shown
			}
		}
		if local != nil {
			return local(title, body, urgency, actions, timeout)
		}
		return "", false
	}
}

// chainedRebootNotify is the same chain for the plain, buttonless warning.
//
// broadcast is always called, so Windows and macOS behaviour is byte-identical
// to before this wave. The daemon-drawn notification is added only when no
// helper session took the broadcast — otherwise a future Linux helper would put
// the same warning on screen twice.
func chainedRebootNotify(broadcast, local patching.NotifyFunc, helperPresent func() bool) patching.NotifyFunc {
	return func(title, body, urgency string) {
		if broadcast != nil {
			broadcast(title, body, urgency)
		}
		if helperPresent != nil && helperPresent() {
			return
		}
		if local != nil {
			local(title, body, urgency)
		}
	}
}
