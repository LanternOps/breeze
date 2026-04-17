package desktop

import (
	"encoding/json"
	"log/slog"

	"github.com/pion/webrtc/v4"
)

// BroadcastDesktopState sends a desktop_state event over the control data
// channel of every active WebRTC desktop session. No-op when no sessions are
// active or when a session's control channel is not yet open.
//
// Called from the macOS handoff reconciler (heartbeat/desktop_handoff_darwin.go)
// on helper attach and on every login/logout/fast-user-switch event. The viewer
// uses these events to decide whether to auto-fall-back to VNC (loginwindow) or
// offer a switch back to WebRTC (user_session).
//
// state must be "loginwindow" or "user_session".
// userName is included in the message only when non-empty.
func (m *SessionManager) BroadcastDesktopState(state string, userName string) {
	msg := map[string]any{
		"type":  "desktop_state",
		"state": state,
	}
	if userName != "" {
		msg["userName"] = userName
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		slog.Warn("BroadcastDesktopState: failed to marshal message", "error", err.Error())
		return
	}

	m.mu.RLock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.RUnlock()

	for _, s := range sessions {
		s.mu.RLock()
		dc := s.controlDC
		active := s.isActive
		s.mu.RUnlock()

		if !active || dc == nil {
			continue
		}
		if dc.ReadyState() != webrtc.DataChannelStateOpen {
			continue
		}
		if err := dc.SendText(string(payload)); err != nil {
			slog.Warn("BroadcastDesktopState: send failed",
				"session", s.id,
				"state", state,
				"error", err.Error(),
			)
		}
	}
}
