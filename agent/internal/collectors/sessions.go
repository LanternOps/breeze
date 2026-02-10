package collectors

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	sessionRefreshInterval = 5 * time.Minute
)

type UserSession struct {
	Username                string    `json:"username"`
	SessionType             string    `json:"sessionType"`
	SessionID               string    `json:"sessionId,omitempty"`
	LoginAt                 time.Time `json:"loginAt"`
	IdleMinutes             int       `json:"idleMinutes,omitempty"`
	ActivityState           string    `json:"activityState,omitempty"`
	LoginPerformanceSeconds int       `json:"loginPerformanceSeconds,omitempty"`
	IsActive                bool      `json:"isActive"`
	LastActivityAt          time.Time `json:"lastActivityAt,omitempty"`
}

type UserSessionEvent struct {
	Type          string    `json:"type"`
	Username      string    `json:"username"`
	SessionType   string    `json:"sessionType"`
	SessionID     string    `json:"sessionId,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
	ActivityState string    `json:"activityState,omitempty"`
}

type SessionCollector struct {
	detector sessionbroker.SessionDetector

	mu       sync.RWMutex
	sessions map[string]UserSession
	events   []UserSessionEvent
	started  bool
}

func NewSessionCollector() *SessionCollector {
	return &SessionCollector{
		detector: sessionbroker.NewSessionDetector(),
		sessions: make(map[string]UserSession),
		events:   make([]UserSessionEvent, 0, 64),
	}
}

func (c *SessionCollector) Start(stopChan <-chan struct{}) {
	c.mu.Lock()
	if c.started {
		c.mu.Unlock()
		return
	}
	c.started = true
	c.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-stopChan
		cancel()
	}()

	c.refreshSessions(time.Now())
	eventCh := c.detector.WatchSessions(ctx)

	go func() {
		ticker := time.NewTicker(sessionRefreshInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.refreshSessions(time.Now())
			case event, ok := <-eventCh:
				if !ok {
					return
				}
				c.applyEvent(event, time.Now())
			}
		}
	}()
}

func (c *SessionCollector) Collect() ([]UserSession, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	result := make([]UserSession, 0, len(c.sessions))
	for _, session := range c.sessions {
		result = append(result, session)
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].LoginAt.Equal(result[j].LoginAt) {
			return result[i].Username < result[j].Username
		}
		return result[i].LoginAt.After(result[j].LoginAt)
	})

	return result, nil
}

func (c *SessionCollector) LastUser() string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var last UserSession
	for _, session := range c.sessions {
		if !session.IsActive {
			continue
		}
		if last.Username == "" || session.LoginAt.After(last.LoginAt) {
			last = session
		}
	}

	return last.Username
}

func (c *SessionCollector) DrainEvents(max int) []UserSessionEvent {
	if max <= 0 {
		max = 256
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.events) == 0 {
		return nil
	}

	if len(c.events) <= max {
		out := append([]UserSessionEvent(nil), c.events...)
		c.events = c.events[:0]
		return out
	}

	// Keep newest max events and drop older backlog.
	start := len(c.events) - max
	out := append([]UserSessionEvent(nil), c.events[start:]...)
	c.events = c.events[:0]
	return out
}

func (c *SessionCollector) refreshSessions(now time.Time) {
	sessions, err := c.detector.ListSessions()
	if err != nil {
		return
	}

	next := make(map[string]UserSession, len(sessions))

	c.mu.Lock()
	defer c.mu.Unlock()

	for _, detected := range sessions {
		key := sessionKey(detected.Username, inferSessionType(detected), detected.Session)
		existing, hasExisting := c.sessions[key]

		loginAt := now
		if hasExisting {
			loginAt = existing.LoginAt
		}

		next[key] = UserSession{
			Username:       detected.Username,
			SessionType:    inferSessionType(detected),
			SessionID:      detected.Session,
			LoginAt:        loginAt,
			IdleMinutes:    0,
			ActivityState:  mapDetectedState(detected.State),
			IsActive:       true,
			LastActivityAt: now,
		}
	}

	c.sessions = next
}

func (c *SessionCollector) applyEvent(event sessionbroker.SessionEvent, now time.Time) {
	sessionType := inferSessionTypeFromEvent(event)
	key := sessionKey(event.Username, sessionType, event.Session)

	c.mu.Lock()
	defer c.mu.Unlock()

	switch event.Type {
	case sessionbroker.SessionLogin:
		existing, hasExisting := c.sessions[key]
		loginAt := now
		if hasExisting {
			loginAt = existing.LoginAt
		}
		c.sessions[key] = UserSession{
			Username:       event.Username,
			SessionType:    sessionType,
			SessionID:      event.Session,
			LoginAt:        loginAt,
			IdleMinutes:    0,
			ActivityState:  "active",
			IsActive:       true,
			LastActivityAt: now,
		}
	case sessionbroker.SessionLogout:
		delete(c.sessions, key)
	case sessionbroker.SessionLock:
		if current, ok := c.sessions[key]; ok {
			current.ActivityState = "locked"
			current.LastActivityAt = now
			c.sessions[key] = current
		}
	case sessionbroker.SessionUnlock, sessionbroker.SessionSwitch:
		if current, ok := c.sessions[key]; ok {
			current.ActivityState = "active"
			current.LastActivityAt = now
			c.sessions[key] = current
		}
	}

	c.events = append(c.events, UserSessionEvent{
		Type:          string(event.Type),
		Username:      event.Username,
		SessionType:   sessionType,
		SessionID:     event.Session,
		Timestamp:     now,
		ActivityState: mapEventState(event.Type),
	})

	if len(c.events) > 1024 {
		c.events = c.events[len(c.events)-1024:]
	}
}

func inferSessionType(session sessionbroker.DetectedSession) string {
	if session.IsRemote {
		display := strings.ToLower(strings.TrimSpace(session.Display))
		if display == "" || display == "tty" || strings.HasPrefix(display, "pts") {
			return "ssh"
		}
		return "rdp"
	}
	return "console"
}

func inferSessionTypeFromEvent(event sessionbroker.SessionEvent) string {
	if event.IsRemote {
		if strings.TrimSpace(event.Display) == "" {
			return "ssh"
		}
		return "rdp"
	}
	return "console"
}

func mapDetectedState(state string) string {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "active", "online":
		return "active"
	case "idle":
		return "idle"
	case "locked":
		return "locked"
	case "closing", "disconnected":
		return "disconnected"
	default:
		return "away"
	}
}

func mapEventState(eventType sessionbroker.SessionEventType) string {
	switch eventType {
	case sessionbroker.SessionLogin, sessionbroker.SessionUnlock, sessionbroker.SessionSwitch:
		return "active"
	case sessionbroker.SessionLock:
		return "locked"
	case sessionbroker.SessionLogout:
		return "disconnected"
	default:
		return "away"
	}
}

func sessionKey(username, sessionType, sessionID string) string {
	return strings.ToLower(username) + "::" + sessionType + "::" + sessionID
}
