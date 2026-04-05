package tunnel

import (
	"fmt"
	"sync"
	"time"
)

const (
	defaultMaxSessions = 5
	defaultIdleTimeout = 5 * time.Minute
	reaperInterval     = 30 * time.Second
)

// Manager manages concurrent tunnel sessions for a single agent.
type Manager struct {
	sessions    map[string]*Session
	mu          sync.RWMutex
	maxSessions int
	idleTimeout time.Duration
	done        chan struct{}
	stopOnce    sync.Once
	stopped     bool
}

// NewManager creates a Manager and starts the idle reaper goroutine.
func NewManager() *Manager {
	m := &Manager{
		sessions:    make(map[string]*Session),
		maxSessions: defaultMaxSessions,
		idleTimeout: defaultIdleTimeout,
		done:        make(chan struct{}),
	}
	go m.reapLoop()
	return m
}

// OpenTunnel validates limits, dials the target, and starts a relay session.
func (m *Manager) OpenTunnel(id, host string, port int, tunnelType string, onData DataCallback, onClose CloseCallback) error {
	m.mu.Lock()

	if m.stopped {
		m.mu.Unlock()
		return fmt.Errorf("tunnel manager is stopped")
	}

	if len(m.sessions) >= m.maxSessions {
		m.mu.Unlock()
		return fmt.Errorf("concurrent tunnel limit reached (%d)", m.maxSessions)
	}

	if _, exists := m.sessions[id]; exists {
		m.mu.Unlock()
		return fmt.Errorf("tunnel %s already exists", id)
	}

	// Reserve the slot before unlocking so no race on the limit check.
	m.sessions[id] = nil
	m.mu.Unlock()

	// Wrap onClose to also remove from map.
	wrappedOnClose := func(tunnelID string, err error) {
		m.mu.Lock()
		delete(m.sessions, tunnelID)
		m.mu.Unlock()
		if onClose != nil {
			onClose(tunnelID, err)
		}
	}

	session, err := Open(id, host, port, tunnelType, onData, wrappedOnClose)
	if err != nil {
		m.mu.Lock()
		delete(m.sessions, id) // release reserved slot
		m.mu.Unlock()
		return err
	}

	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()

	return nil
}

// WriteTunnel routes data to the specified tunnel session.
func (m *Manager) WriteTunnel(id string, data []byte) error {
	m.mu.RLock()
	s, ok := m.sessions[id]
	m.mu.RUnlock()

	if !ok || s == nil {
		return fmt.Errorf("tunnel %s not found", id)
	}
	return s.Write(data)
}

// CloseTunnel closes and removes the specified tunnel session.
func (m *Manager) CloseTunnel(id string) {
	m.mu.RLock()
	s, ok := m.sessions[id]
	m.mu.RUnlock()

	if ok && s != nil {
		s.Close()
		// wrappedOnClose removes from map via the read loop exit
	}
}

// ActiveCount returns the number of active tunnels.
func (m *Manager) ActiveCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

// GetTunnelType returns the tunnel type for the given ID, or empty string if not found.
func (m *Manager) GetTunnelType(id string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s, ok := m.sessions[id]; ok && s != nil {
		return s.TunnelType
	}
	return ""
}

// HasVNCTunnels returns true if any active tunnel has type "vnc".
func (m *Manager) HasVNCTunnels() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.sessions {
		if s != nil && s.TunnelType == "vnc" {
			return true
		}
	}
	return false
}

// CleanupOrphanedVNC disables Screen Sharing if it's running but there are
// no active VNC tunnels. Called on agent startup to clean up after crashes.
func (m *Manager) CleanupOrphanedVNC() {
	if !IsScreenSharingRunning() {
		return
	}
	if m.HasVNCTunnels() {
		return
	}
	log.Info("disabling orphaned Screen Sharing (no active VNC tunnels)")
	if err := DisableScreenSharing(); err != nil {
		log.Warn("failed to disable orphaned screen sharing", "error", err.Error())
	}
}

// Stop closes all tunnels and stops the reaper.
func (m *Manager) Stop() {
	m.stopOnce.Do(func() {
		close(m.done)

		m.mu.Lock()
		m.stopped = true
		hasVNC := false
		for id, s := range m.sessions {
			if s != nil {
				if s.TunnelType == "vnc" {
					hasVNC = true
				}
				s.Close()
			}
			delete(m.sessions, id)
		}
		m.mu.Unlock()

		if hasVNC {
			if err := DisableScreenSharing(); err != nil {
				log.Warn("failed to disable screen sharing during shutdown", "error", err.Error())
			}
		}

		log.Info("tunnel manager stopped")
	})
}

func (m *Manager) reapLoop() {
	ticker := time.NewTicker(reaperInterval)
	defer ticker.Stop()

	for {
		select {
		case <-m.done:
			return
		case <-ticker.C:
			m.reapIdle()
		}
	}
}

func (m *Manager) reapIdle() {
	now := time.Now().Unix()
	threshold := int64(m.idleTimeout.Seconds())

	m.mu.RLock()
	var stale []string
	for id, s := range m.sessions {
		if s != nil && (now-s.LastActive()) > threshold {
			stale = append(stale, id)
		}
	}
	m.mu.RUnlock()

	var reapedVNC bool
	for _, id := range stale {
		if m.GetTunnelType(id) == "vnc" {
			reapedVNC = true
		}
		log.Info("reaping idle tunnel", "tunnelId", id)
		m.CloseTunnel(id)
	}

	// If we reaped a VNC tunnel and no others remain, disable Screen Sharing.
	if reapedVNC && !m.HasVNCTunnels() {
		if err := DisableScreenSharing(); err != nil {
			log.Warn("failed to disable screen sharing after idle VNC reap", "error", err.Error())
		}
	}
}
