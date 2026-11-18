package sessionbroker

import (
	"encoding/json"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// SendNotification sends a desktop notification (TypeNotify) to this session's
// helper without making the caller wait for it to be shown, and consumes the
// notify_result the helper sends back (#10224).
//
// Use this, not SendNotify, for TypeNotify. The helper's handleNotify answers
// every notify on the envelope id it was given — it has to, because
// RequestNotificationDecision and SendCommandAndWait depend on that answer. A
// notify sent through SendNotify registers nothing, so the answer matches no
// waiter and dispatchHelperMessage logs "dropping unsolicited or unauthorized
// helper message type=notify_result" at WARN on every notice. That is the bug
// class #9266 fixed for BroadcastNotification and #10209 for the restart
// prompt; the remote-session start/end notice was the last sender still doing
// it.
//
// The send happens before this returns (only the wait is on a goroutine), so a
// caller keeps the on-the-wire ordering a synchronous send gave it. A nil
// error means the notice was handed to the helper, not that it was shown. The
// id must be unique among this session's in-flight commands: a duplicate is
// refused with ErrDuplicateCommand rather than mis-routing the answer.
//
// Choosing this over a helper-side "no reply" flag is deliberate: every helper
// already in the field answers, so only registering the reply here silences
// the WARN without a protocol or version change.
func (s *Session) SendNotification(id string, req ipc.NotifyRequest) error {
	// Read once, on the caller's goroutine: tests shorten it, and the waiter
	// goroutine reading the package var could race that write.
	timeout := broadcastNotifyResultTimeout
	wait, err := s.startCommand(id, ipc.TypeNotify, req)
	if err != nil {
		return err
	}
	go s.awaitNotificationResult(id, wait, timeout)
	return nil
}

// awaitNotificationResult consumes the reply SendNotification is owed and logs
// its outcome. Nothing depends on the answer, so a missing or unreadable reply
// is Info (the helper may simply have exited), and an undelivered notice is
// Info with the helper's error — the user-visible failure was already logged
// by the helper itself.
func (s *Session) awaitNotificationResult(id string, wait func(time.Duration) (*ipc.Envelope, error), timeout time.Duration) {
	resp, err := wait(timeout)
	if err != nil {
		log.Info("no notify_result for notification",
			"id", id, "sessionId", s.SessionID, "role", s.HelperRole, "error", err.Error())
		return
	}
	var res ipc.NotifyResult
	if resp.Error == "" {
		if err := json.Unmarshal(resp.Payload, &res); err != nil {
			log.Info("undecodable notify_result for notification",
				"id", id, "sessionId", s.SessionID, "role", s.HelperRole, "error", err.Error())
			return
		}
	}
	if res.Delivered {
		log.Debug("notification delivered", "id", id, "sessionId", s.SessionID, "role", s.HelperRole)
		return
	}
	log.Info("notification not delivered",
		"id", id, "sessionId", s.SessionID, "role", s.HelperRole, "helperError", resp.Error)
}
