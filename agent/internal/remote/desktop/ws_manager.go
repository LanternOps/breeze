package desktop

import (
	"fmt"
	"log/slog"
	"sync"
)

// WsSessionManager manages multiple WebSocket desktop streaming sessions
type WsSessionManager struct {
	sessions map[string]*WsStreamSession
	mu       sync.RWMutex
}

// NewWsSessionManager creates a new manager
func NewWsSessionManager() *WsSessionManager {
	return &WsSessionManager{
		sessions: make(map[string]*WsStreamSession),
	}
}

// StartSession creates and starts a new desktop streaming session.
func (m *WsSessionManager) StartSession(id string, displayIndex int, config StreamConfig, sendFrame SendFrameFunc) (screenWidth, screenHeight int, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Stop existing session with same ID if any
	if existing, ok := m.sessions[id]; ok {
		existing.Stop()
		delete(m.sessions, id)
	}

	// Create platform capturer
	capturer, err := NewScreenCapturer(CaptureConfig{
		DisplayIndex:   displayIndex,
		DesktopContext: "user_session",
		Quality:        config.Quality,
		ScaleFactor:    config.ScaleFactor,
	})
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create screen capturer: %w", err)
	}

	// Get screen bounds before starting
	w, h, err := capturer.GetScreenBounds()
	if err != nil {
		capturer.Close()
		return 0, 0, fmt.Errorf("failed to get screen bounds: %w", err)
	}

	// Create input handler
	inputHandler := NewInputHandler("user_session")

	// Create and start session
	session := newWsStreamSession(id, capturer, inputHandler, sendFrame, config)
	m.sessions[id] = session
	session.Start()

	slog.Info("Desktop WS stream session started",
		"sessionId", id,
		"displayIndex", displayIndex,
		"width", w,
		"height", h,
		"quality", config.Quality,
		"scaleFactor", config.ScaleFactor,
		"fps", config.MaxFPS,
	)

	return w, h, nil
}

// StopSession stops and removes a session. It holds the manager lock through
// physical stop completion so a racing redelivery cannot report
// already_absent while capture is still shutting down.
func (m *WsSessionManager) StopSession(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[id]
	if !ok {
		return false
	}

	delete(m.sessions, id)
	session.Stop()
	return true
}

// HandleInput routes an input event to the correct session
func (m *WsSessionManager) HandleInput(id string, event InputEvent) error {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("desktop session %s not found", id)
	}

	return session.HandleInput(event)
}

// UpdateConfig routes a config change to the correct session
func (m *WsSessionManager) UpdateConfig(id string, config StreamConfig) error {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("desktop session %s not found", id)
	}

	session.UpdateConfig(config)
	return nil
}

// StopAll stops all active sessions
func (m *WsSessionManager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, session := range m.sessions {
		session.Stop()
		delete(m.sessions, id)
	}
}

// ActiveCount returns the number of active sessions
func (m *WsSessionManager) ActiveCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}
