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
	// Cache the state so late-connecting viewers receive it on control-channel open.
	m.mu.Lock()
	m.lastDesktopState = state
	m.lastDesktopUsername = userName
	m.mu.Unlock()

	payload, err := buildDesktopStatePayload(state, userName)
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

// SendDesktopStateTo sends the current cached desktop state to a single session
// identified by sessionID. No-op when the session is not found, its control
// channel is not open, or no state has been cached yet.
//
// Called when a new viewer's control data channel opens so it receives an
// immediate initial state without waiting for the next event-driven broadcast.
func (m *SessionManager) SendDesktopStateTo(sessionID string) {
	m.mu.RLock()
	state := m.lastDesktopState
	userName := m.lastDesktopUsername
	session := m.sessions[sessionID]
	m.mu.RUnlock()

	if state == "" || session == nil {
		return
	}

	payload, err := buildDesktopStatePayload(state, userName)
	if err != nil {
		slog.Warn("SendDesktopStateTo: failed to marshal message", "session", sessionID, "error", err.Error())
		return
	}

	session.mu.RLock()
	dc := session.controlDC
	active := session.isActive
	session.mu.RUnlock()

	if !active || dc == nil {
		return
	}
	if dc.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	if err := dc.SendText(string(payload)); err != nil {
		slog.Warn("SendDesktopStateTo: send failed",
			"session", sessionID,
			"state", state,
			"error", err.Error(),
		)
	}
}

// buildDesktopStatePayload marshals a desktop_state control message.
func buildDesktopStatePayload(state, userName string) ([]byte, error) {
	msg := map[string]any{
		"type":  "desktop_state",
		"state": state,
	}
	if userName != "" {
		msg["username"] = userName
	}
	return json.Marshal(msg)
}
