package heartbeat

import (
	"encoding/json"
	"fmt"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// handleDesktopClipboardRead reads the clipboard through the user-role helper
// for a desktop session hosted by the Windows system helper (#8393). That
// helper runs as SYSTEM, which cannot read the PNG and JFIF data the user
// copies; the user helper in the same Windows session can.
//
// Only the helper that owns the desktop session is answered, and only the user
// helper in that helper's own Windows session is read, so one user's clipboard
// never reaches a session viewing another. Whether host→viewer clipboard is
// allowed at all is enforced in the helper, which never polls when it is not.
// Blocks for up to the proxy's timeout; the caller runs it on its own goroutine.
func (h *Heartbeat) handleDesktopClipboardRead(session *sessionbroker.Session, env *ipc.Envelope) {
	sendDesktopClipboardReadResult(session, env, h.desktopClipboardReadResult(session, env))
}

// sendDesktopClipboardReadResult answers one read. A failed send leaves the
// helper to time out, which it reports as "no answer from the service"; this
// log is where the cause is.
func sendDesktopClipboardReadResult(session *sessionbroker.Session, env *ipc.Envelope, res ipc.DesktopClipboardReadResult) {
	if err := session.SendNotify(env.ID, ipc.TypeDesktopClipboardReadResult, res); err != nil {
		log.Warn("failed to send desktop clipboard read result to helper",
			"requestId", env.ID, "helperSession", session.SessionID, "error", err.Error())
	}
}

func (h *Heartbeat) desktopClipboardReadResult(session *sessionbroker.Session, env *ipc.Envelope) ipc.DesktopClipboardReadResult {
	var req ipc.DesktopClipboardReadRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid desktop clipboard read payload", "helperSession", session.SessionID, "error", err.Error())
		return ipc.DesktopClipboardReadResult{Error: "invalid request"}
	}
	if !desktopSessionIDPattern.MatchString(req.SessionID) {
		log.Warn("dropping desktop clipboard read with invalid session ID",
			"sessionId", req.SessionID, "helperSession", session.SessionID)
		return ipc.DesktopClipboardReadResult{Error: "invalid session ID"}
	}
	if owner := h.desktopOwnerSession(req.SessionID); owner == nil || owner.SessionID != session.SessionID {
		log.Warn("dropping desktop clipboard read for non-owned session",
			"sessionId", req.SessionID, "helperSession", session.SessionID)
		return ipc.DesktopClipboardReadResult{Error: "not the owner of this desktop session"}
	}

	user := h.userClipboardHelper(session.WinSessionID)
	if user == nil {
		return clipboard.RelayResultFromRead(clipboard.Content{}, clipboard.ErrUserClipboardUnavailable)
	}
	content, err := clipboard.NewProxyProvider(user).GetContent()
	if err != nil {
		err = fmt.Errorf("user helper %s: %w", user.SessionID, err)
	}
	return clipboard.RelayResultFromRead(content, err)
}

// userClipboardHelper is the user-role helper that may read the clipboard in
// exactly this Windows session, or nil.
func (h *Heartbeat) userClipboardHelper(winSessionID string) *sessionbroker.Session {
	if h.sessionBroker == nil || winSessionID == "" {
		return nil
	}
	user := h.sessionBroker.FindUserSession(winSessionID)
	if user == nil || user.WinSessionID != winSessionID || !user.HasScope("clipboard") {
		return nil
	}
	return user
}
