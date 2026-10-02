package heartbeat

import "github.com/breeze-rmm/agent/internal/ipc"

// Quick Support "a technician is viewing your screen" indicator (#7684).
//
// An installed agent shows its notify notice and on-screen indicator through
// a desktop helper over IPC (afterDesktopStart / sendBannerShow). A Quick
// Support client has no helper: it IS the process in the user's session. So
// instead of pushing UI from here, the heartbeat exposes two facts — is any
// desktop capture running, and who is viewing — and pokes the support client
// whenever the first may have changed. The client draws the indicator from
// those facts (internal/agentapp/support_indicator.go).
//
// The activity truth is read from the stream managers themselves, not from
// remembered prompts, so every stop path is covered by construction: End,
// session end, revocation (lease watchdog), an overtaken start, a failed
// replacement and teardown all change the managers' running set.

// noteSupportViewer records who the support indicator should name, from a
// desktop start's prompt block. Callers record it only once the start has
// passed the consent gate, so a denied start never renames the indicator of a
// viewing already on screen. No-op on an installed agent, or for a start
// without a prompt (the previous viewer, if any, is kept).
func (h *Heartbeat) noteSupportViewer(prompt *ipc.DesktopPrompt) {
	if h == nil || !h.supportMode || prompt == nil {
		return
	}
	line := technicianLine(prompt)
	h.supportViewerMu.Lock()
	h.supportViewer = line
	h.supportViewerMu.Unlock()
}

// SupportViewer is who the Quick Support indicator names ("Billy from Olive
// Technology", "A technician"), or "" before any start carried a prompt.
func (h *Heartbeat) SupportViewer() string {
	if h == nil {
		return ""
	}
	h.supportViewerMu.Lock()
	defer h.supportViewerMu.Unlock()
	return h.supportViewer
}

// SupportDesktopActive reports whether any desktop capture is running: a
// WebSocket fallback stream, or a WebRTC session.
func (h *Heartbeat) SupportDesktopActive() bool {
	if h == nil {
		return false
	}
	if h.wsDesktopMgr != nil && h.wsDesktopMgr.ActiveCount() > 0 {
		return true
	}
	return h.desktopMgr != nil && h.desktopMgr.HasActiveSessions()
}

// SetSupportViewingObserver registers changed to be poked whenever desktop
// activity may have changed. changed must not block: the WebSocket manager
// invokes it with its lock held. The caller re-reads SupportDesktopActive and
// SupportViewer afterwards. The WebRTC hooks are CHAINED onto whatever the
// heartbeat already registered (the peer-disconnect report to the API), never
// replaced.
//
// Only a Quick Support client wires it. Must be called right after startAgent
// returns: the WebRTC manager's hooks are plain fields (the WebSocket
// manager's observer is lock-guarded and reports current state on
// registration, so a stream that started first is not missed).
func (h *Heartbeat) SetSupportViewingObserver(changed func()) {
	if h == nil || !h.supportMode || changed == nil {
		return
	}
	if h.wsDesktopMgr != nil {
		h.wsDesktopMgr.SetActivityObserver(changed)
	}
	if h.desktopMgr != nil {
		// A direct stop (stop_desktop, teardown) fires no peer hook of its
		// own until the connection reports Closed; this makes it prompt.
		h.desktopMgr.SetActivityObserver(changed)
		previousStart := h.desktopMgr.OnSessionStarted
		previousStop := h.desktopMgr.OnSessionStopped
		h.desktopMgr.OnSessionStarted = func(sessionID string) {
			if previousStart != nil {
				previousStart(sessionID)
			}
			changed()
		}
		h.desktopMgr.OnSessionStopped = func(sessionID, reason string) {
			if previousStop != nil {
				previousStop(sessionID, reason)
			}
			changed()
		}
	}
}
