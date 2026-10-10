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

	// RequestRevocationLeaseRenew asks the control plane to renew a stream's
	// revocation lease (fire-and-forget; the answer arrives via
	// ApplyRevocationLease / NoteLeaseUnavailable / RevokeSession).
	RequestRevocationLeaseRenew func(sessionID string)
	// OnSessionStopped is called, on its own goroutine, when the lease
	// watchdog stops a stream — so the caller can hide the on-screen session
	// indicator and send the end notice exactly as an operator stop does.
	OnSessionStopped func(sessionID, reason string)
	// activityObserver is told every time the set of running streams changes,
	// by any path: start, replacement, operator stop, exact stop, StopAll and
	// the lease watchdog. Guarded by mu and invoked with mu held, so it must
	// not block and must not call back into the manager. Set it with
	// SetActivityObserver.
	activityObserver func()
	// clock is the watchdog's time source; nil in production (real clock).
	clock *watchdogClock
	// newCapturer replaces the platform capturer; nil in production. Set only
	// by NewWsSessionManagerForTest, which also skips the wallpaper and input
	// side effects a real stream has on the host.
	newCapturer func() ScreenCapturer
}

// NewWsSessionManagerForTest returns a manager whose streams capture from
// newCapturer instead of the screen, take no input handler and leave the
// desktop wallpaper alone, so StartSession — including its lease watchdog —
// can be driven end to end in tests, from any package.
func NewWsSessionManagerForTest(newCapturer func() ScreenCapturer) *WsSessionManager {
	m := NewWsSessionManager()
	m.newCapturer = newCapturer
	return m
}

// NewWsSessionManager creates a new manager
func NewWsSessionManager() *WsSessionManager {
	return &WsSessionManager{
		sessions: make(map[string]*WsStreamSession),
	}
}

// StartSession creates and starts a new desktop streaming session. lease is
// the server-issued revocation lease from the start payload; a start without
// one is refused before any capture is created, exactly as start_desktop is.
// The returned stream identifies exactly this start, so a caller that must
// undo it can do so with StopExact without touching a newer stream started
// under the same id.
func (m *WsSessionManager) StartSession(id string, displayIndex int, config StreamConfig, lease *RevocationLease, sendFrame SendFrameFunc) (screenWidth, screenHeight int, stream *WsStreamSession, err error) {
	if lease == nil {
		return 0, 0, nil, ErrRevocationLeaseRequired
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Deferred after the unlock, so it runs first: on every exit, including a
	// failed replacement that already stopped the old stream below.
	defer m.notifyActivityLocked()

	// Stop existing session with same ID if any
	if existing, ok := m.sessions[id]; ok {
		existing.Stop()
		delete(m.sessions, id)
	}

	// Create platform capturer
	var capturer ScreenCapturer
	var inputHandler InputHandler
	if m.newCapturer != nil {
		capturer = m.newCapturer()
	} else {
		capturer, err = NewScreenCapturer(CaptureConfig{
			DisplayIndex:   displayIndex,
			DesktopContext: "user_session",
			Quality:        config.Quality,
			ScaleFactor:    config.ScaleFactor,
		})
		if err != nil {
			return 0, 0, nil, fmt.Errorf("failed to create screen capturer: %w", err)
		}
	}

	// Get screen bounds before starting
	w, h, err := capturer.GetScreenBounds()
	if err != nil {
		capturer.Close()
		return 0, 0, nil, fmt.Errorf("failed to get screen bounds: %w", err)
	}

	// Create input handler
	if m.newCapturer == nil {
		inputHandler = NewSafeInput(NewInputHandler("user_session"), id)
	}

	// Create and start session
	session := newWsStreamSession(id, capturer, inputHandler, sendFrame, config)
	session.skipWallpaper = m.newCapturer != nil
	m.sessions[id] = session
	session.Start()
	m.startLeaseWatchdog(id, session, lease)

	slog.Info("Desktop WS stream session started",
		"sessionId", id,
		"displayIndex", displayIndex,
		"width", w,
		"height", h,
		"quality", config.Quality,
		"scaleFactor", config.ScaleFactor,
		"fps", config.MaxFPS,
	)

	return w, h, session, nil
}

// StopExact stops stream and unregisters it only if id still maps to that
// exact stream; a newer stream started under the same id keeps running.
// Reports whether this call removed the current stream.
func (m *WsSessionManager) StopExact(id string, stream *WsStreamSession) bool {
	if stream == nil {
		return false
	}
	return m.stopExact(id, stream)
}

// IsCurrent reports whether stream is still the running stream for id.
func (m *WsSessionManager) IsCurrent(id string, stream *WsStreamSession) bool {
	if stream == nil {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id] == stream
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
	m.notifyActivityLocked()
	return true
}

// SetActivityObserver registers fn to be told whenever the set of running
// streams changes, by any path. It is called once immediately, so an observer
// wired after a stream started still learns about it. fn runs with the
// manager's lock held: it must only record that something changed (e.g. a
// non-blocking channel send) and read the new state later, never block or
// call back into the manager. nil unregisters.
func (m *WsSessionManager) SetActivityObserver(fn func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activityObserver = fn
	m.notifyActivityLocked()
}

// notifyActivityLocked tells the activity observer that the running set may
// have changed. Caller holds m.mu.
func (m *WsSessionManager) notifyActivityLocked() {
	if m.activityObserver != nil {
		m.activityObserver()
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
	defer m.mu.Unlock()
	if len(m.sessions) == 0 {
		return
	}
	for id, session := range m.sessions {
		session.Stop()
		delete(m.sessions, id)
	}
	m.notifyActivityLocked()
}

// ActiveCount returns the number of active sessions
func (m *WsSessionManager) ActiveCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}
