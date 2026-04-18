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
	sessions        map[string]*Session
	mu              sync.RWMutex
	maxSessions     int
	idleTimeout     time.Duration
	done            chan struct{}
	stopOnce        sync.Once
	stopped         bool
	managedByPolicy bool
	// screenSharingSelfEnabled is true when the agent itself turned on macOS
	// Screen Sharing for a tunnel. When false (e.g. the user had it on
	// manually or via MDM), the agent must not turn it off on tunnel close.
	screenSharingSelfEnabled bool
}

// NewManager creates a Manager and starts the idle reaper goroutine.
// managedByPolicy controls whether Breeze is allowed to enable/disable macOS Screen Sharing.
func NewManager(managedByPolicy bool) *Manager {
	m := &Manager{
		sessions:        make(map[string]*Session),
		maxSessions:     defaultMaxSessions,
		idleTimeout:     defaultIdleTimeout,
		done:            make(chan struct{}),
		managedByPolicy: managedByPolicy,
	}
	go m.reapLoop()
	return m
}

// SetManagedByPolicy updates whether Breeze is allowed to manage Screen Sharing.
func (m *Manager) SetManagedByPolicy(managed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.managedByPolicy = managed
}

// IsManagedByPolicy returns whether Breeze is allowed to manage Screen Sharing.
func (m *Manager) IsManagedByPolicy() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.managedByPolicy
}

// SetScreenSharingSelfEnabled records whether the agent itself turned Screen
// Sharing on for the current tunnel. When false (user or MDM enabled it),
// DisableScreenSharingIfIdle becomes a no-op so we don't tear down the user's
// pre-existing Screen Sharing configuration.
func (m *Manager) SetScreenSharingSelfEnabled(self bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.screenSharingSelfEnabled = self
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
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id) // Remove from map synchronously
	}
	m.mu.Unlock()

	if ok && s != nil {
		s.Close()
		// wrappedOnClose will try to delete again — harmless no-op
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

// DisableScreenSharingIfIdle disables macOS Screen Sharing when no VNC
// tunnels remain active. Called after closing/reaping VNC tunnels and on
// startup to clean up after crashes. No-op when managedByPolicy is false
// or when the agent did not enable Screen Sharing itself (user had it on).
func (m *Manager) DisableScreenSharingIfIdle(context string) {
	m.mu.Lock()
	managed := m.managedByPolicy
	selfEnabled := m.screenSharingSelfEnabled
	m.mu.Unlock()
	if !managed {
		return
	}
	if !selfEnabled {
		log.Info("skipping Screen Sharing disable — agent did not enable it",
			"context", context)
		return
	}
	if m.HasVNCTunnels() {
		return
	}
	if err := DisableScreenSharing(); err != nil {
		log.Warn("failed to disable screen sharing", "context", context, "error", err.Error())
		return
	}
	m.mu.Lock()
	m.screenSharingSelfEnabled = false
	m.mu.Unlock()
}

// CleanupOrphanedVNC disables Screen Sharing if it's running but there are
// no active VNC tunnels. Called on agent startup to clean up after crashes.
// No-op when managedByPolicy is false. We deliberately skip this cleanup on
// startup because we can't tell whether a running Screen Sharing listener is
// ours or the user's.
func (m *Manager) CleanupOrphanedVNC() {
	m.mu.RLock()
	managed := m.managedByPolicy
	m.mu.RUnlock()
	if !managed {
		return
	}
	if !IsScreenSharingRunning() {
		return
	}
	// Don't touch the listener on startup — it may belong to the user.
	// It will either stay running (user's config) or time out naturally.
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
			m.DisableScreenSharingIfIdle("shutdown")
		}

		log.Info("tunnel manager stopped")
	})
}

// StartDiagLogger starts a goroutine that periodically logs per-tunnel byte
// counters plus an optional WebSocket binary-frame channel depth. Gated by the
// caller (typically via env var) so it's off by default. The returned goroutine
// exits when the manager stops.
func (m *Manager) StartDiagLogger(interval time.Duration, chanStats func() (int, int)) {
	go m.diagLoop(interval, chanStats)
}

func (m *Manager) diagLoop(interval time.Duration, chanStats func() (int, int)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-m.done:
			return
		case <-ticker.C:
			m.logDiag(chanStats)
		}
	}
}

func (m *Manager) logDiag(chanStats func() (int, int)) {
	m.mu.RLock()
	snapshot := make(map[string]*Session, len(m.sessions))
	for id, s := range m.sessions {
		snapshot[id] = s
	}
	m.mu.RUnlock()

	if len(snapshot) == 0 {
		return
	}

	var chanLen, chanCap int
	haveChan := false
	if chanStats != nil {
		chanLen, chanCap = chanStats()
		haveChan = true
	}

	now := time.Now().Unix()
	for id, s := range snapshot {
		if s == nil {
			continue
		}
		attrs := []any{
			"tunnelId", id,
			"type", s.TunnelType,
			"bytesRecv", s.BytesRecv(),
			"bytesSent", s.BytesSent(),
			"idleSec", now - s.LastActive(),
		}
		if haveChan {
			attrs = append(attrs, "wsBinChanLen", chanLen, "wsBinChanCap", chanCap)
		}
		log.Info("tunnel diag", attrs...)
	}
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

	if reapedVNC {
		m.DisableScreenSharingIfIdle("idle reap")
	}
}
