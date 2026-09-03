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
