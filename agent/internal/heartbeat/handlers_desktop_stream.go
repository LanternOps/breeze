package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// Helpers for the WebSocket fallback desktop stream (desktop_stream_start):
// exact-stream cleanup, prompt ownership by start command, and the lease
// watchdog's stop hook.

// desktopPromptOwners records which stream start remembered the prompt held in
// desktopPrompts for a session, so a superseded start never takes (and hides
// the indicator of) the prompt a newer start for the same session showed.
// Guarded by desktopPromptsMu.
var desktopPromptOwners = map[string]string{}

// rememberDesktopPromptFor remembers prompt for sessionID on behalf of the
// start with the given command id.
func rememberDesktopPromptFor(sessionID, commandID string, prompt *ipc.DesktopPrompt) {
	if sessionID == "" || prompt == nil {
		return
	}
	desktopPromptsMu.Lock()
	desktopPrompts[sessionID] = prompt
	desktopPromptOwners[sessionID] = commandID
	desktopPromptsMu.Unlock()
}

// takeDesktopPromptIfOwnedBy takes the remembered prompt for sessionID only
// when the start with commandID remembered it. Otherwise it leaves it for its
// owner and returns nil.
func takeDesktopPromptIfOwnedBy(sessionID, commandID string) *ipc.DesktopPrompt {
	desktopPromptsMu.Lock()
	defer desktopPromptsMu.Unlock()
	prompt := desktopPrompts[sessionID]
	if prompt == nil || desktopPromptOwners[sessionID] != commandID {
		return nil
	}
	delete(desktopPrompts, sessionID)
	delete(desktopPromptOwners, sessionID)
	return prompt
}

// afterDesktopStreamStart is afterDesktopStart for a stream start: the notify
// notice and indicator, with the prompt remembered under the start's command
// id. The WebSocket fallback targets no specific Windows session.
func (h *Heartbeat) afterDesktopStreamStart(sessionID, commandID string, prompt *ipc.DesktopPrompt) {
	if prompt == nil {
		return
	}
	rememberDesktopPromptFor(sessionID, commandID, prompt)
	if prompt.Mode == "notify" {
		h.sendSessionNotify(connectedNotifyBody(prompt), "")
	}
	if prompt.ShowIndicator {
		h.sendBannerShow(sessionID, prompt, "")
	}
}

// endWsStreamUX ends the on-screen session UX for a stream that was stopped:
// the ended notice and indicator hide for a remembered prompt, and an
// unconditional indicator hide — a stop can land after capture but before the
// start remembered its prompt, and the indicator must never outlive the stream.
func (h *Heartbeat) endWsStreamUX(sessionID string) {
	h.handleConsentSessionEnd(sessionID)
	desktopPromptsMu.Lock()
	delete(desktopPromptOwners, sessionID)
	desktopPromptsMu.Unlock()
	h.sendBannerHide(sessionID, "")
}

// endOvertakenStreamUX undoes the notice/indicator of a start that lost to a
// stop, to its stream vanishing, or to a newer start. Only in the last case is
// the session still live under someone else: then only this start's own
// prompt is taken, and a newer start's indicator is left alone.
func (h *Heartbeat) endOvertakenStreamUX(sessionID, commandID string, reason desktopFenceReason) {
	if reason == desktopFenceReasonSuperseded {
		if own := takeDesktopPromptIfOwnedBy(sessionID, commandID); own != nil && own.ShowIndicator {
			h.sendBannerHide(sessionID, "")
		}
		return
	}
	h.endWsStreamUX(sessionID)
}

// stopWsDesktopStreamExact stops exactly the stream a start created. A nil
// stream (test seams only) falls back to stopping by session id.
func (h *Heartbeat) stopWsDesktopStreamExact(sessionID string, stream *desktop.WsStreamSession) {
	if h.wsDesktopMgr == nil {
		return
	}
	if stream == nil {
		h.wsDesktopMgr.StopSession(sessionID)
		return
	}
	h.wsDesktopMgr.StopExact(sessionID, stream)
}

// wsStreamIsCurrent reports whether stream is still the running stream for
// sessionID (a lease stop may have ended it). A nil stream (test seams only)
// is assumed current.
func (h *Heartbeat) wsStreamIsCurrent(sessionID string, stream *desktop.WsStreamSession) bool {
	if stream == nil || h.wsDesktopMgr == nil {
		return true
	}
	return h.wsDesktopMgr.IsCurrent(sessionID, stream)
}

// wireWsDesktopStreamHooks connects the stream manager to this process: lease
// renewals go out over the command socket, and a lease-driven stop is
// reported to the control plane exactly like a WebRTC peer drop (so the
// session row ends and the viewer is told) and ends the on-screen UX.
func (h *Heartbeat) wireWsDesktopStreamHooks() {
	if h.wsDesktopMgr == nil {
		return
	}
	h.wsDesktopMgr.RequestRevocationLeaseRenew = h.requestRevocationLeaseRenew
	h.wsDesktopMgr.OnSessionStopped = func(sessionID, reason string) {
		notify := h.wsStreamStopNotify
		if notify == nil {
			notify = h.sendDesktopDisconnectNotification
		}
		// sendDesktopDisconnectNotification also runs handleConsentSessionEnd.
		notify(sessionID, reason)
		desktopPromptsMu.Lock()
		delete(desktopPromptOwners, sessionID)
		desktopPromptsMu.Unlock()
		h.sendBannerHide(sessionID, "")
	}
}
