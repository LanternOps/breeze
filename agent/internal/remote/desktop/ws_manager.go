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

// StartSession creates and starts a new desktop streaming session
func (m *WsSessionManager) StartSession(id string, config StreamConfig, sendFrame SendFrameFunc) (screenWidth, screenHeight int, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Stop existing session with same ID if any
	if existing, ok := m.sessions[id]; ok {
		existing.Stop()
		delete(m.sessions, id)
	}

	// Create platform capturer
	capturer, err := NewScreenCapturer(CaptureConfig{
		DisplayIndex: 0,
		Quality:      config.Quality,
		ScaleFactor:  config.ScaleFactor,
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
	inputHandler := NewInputHandler()

	// Create and start session
	session := newWsStreamSession(id, capturer, inputHandler, sendFrame, config)
	m.sessions[id] = session
	session.Start()

	slog.Info("Desktop WS stream session started",
		"sessionId", id,
		"width", w,
		"height", h,
		"quality", config.Quality,
		"scaleFactor", config.ScaleFactor,
		"fps", config.MaxFPS,
	)

	return w, h, nil
}

// StopSession stops and removes a session
func (m *WsSessionManager) StopSession(id string) {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()

	if session != nil {
		session.Stop()
	}
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
	sessions := make([]*WsStreamSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*WsStreamSession)
	m.mu.Unlock()

	for _, s := range sessions {
		s.Stop()
	}
}

// ActiveCount returns the number of active sessions
func (m *WsSessionManager) ActiveCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}
