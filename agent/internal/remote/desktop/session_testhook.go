package desktop

// SetSessionActiveForTest adds (active) or removes a placeholder session
// that HasActiveSessions counts, so callers that must not interrupt a live
// session can be tested from any package without WebRTC. The placeholder
// has no peer connection or capturer: remove it before stopping the manager.
func (m *SessionManager) SetSessionActiveForTest(sessionID string, active bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !active {
		delete(m.sessions, sessionID)
		return
	}
	m.sessions[sessionID] = &Session{id: sessionID, isActive: true}
}
