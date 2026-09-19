package collectors

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	sessionRefreshInterval = 5 * time.Minute
	maxIdleMinutes         = 10080 // submitSessionsSchema caps idleMinutes at 7 days

	// maxBufferedSessionEvents bounds the in-memory event backlog. Events are
	// tiny, but a device whose uploads keep failing must not grow the buffer
	// without limit, so the oldest are shed once the cap is reached — loudly,
	// because shedding them is real data loss (#3529).
	maxBufferedSessionEvents = 1024
)

type UserSession struct {
	Username                string    `json:"username"`
	SessionType             string    `json:"sessionType"`
	SessionID               string    `json:"sessionId,omitempty"`
	LoginAt                 time.Time `json:"loginAt"`
	IdleMinutes             *int      `json:"idleMinutes,omitempty"`
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

// DrainEvents removes and returns up to max buffered events, oldest first.
//
// The caller owns the returned events until the server confirms receipt; a
// failed upload must hand them back via RequeueEvents, or they are lost — the
// API never learns they existed and nothing re-derives them (#3529). A backlog
// larger than max keeps its remainder buffered for the next cycle rather than
// being discarded.
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

	out := append([]UserSessionEvent(nil), c.events[:max]...)
	c.events = append(c.events[:0], c.events[max:]...)
	return out
}

// RequeueEvents returns previously drained events to the front of the buffer so
// the next upload retries them.
//
// No dedupe is required: DrainEvents removes what it hands out, so a requeued
// event cannot still be buffered, and anything appended while the upload was in
// flight is a distinct, newer observation. Concurrent drains get disjoint
// batches under the same lock, so requeuing one cannot duplicate another.
func (c *SessionCollector) RequeueEvents(events []UserSessionEvent) {
	if len(events) == 0 {
		return
	}

	// Explicit unlock rather than defer: the shed-count log must not run while
	// the write lock is held, or a slow log writer stalls every Collect().
	// Nothing between Lock and Unlock can panic.
	c.mu.Lock()
	restored := make([]UserSessionEvent, 0, len(events)+len(c.events))
	restored = append(restored, events...)
	restored = append(restored, c.events...)
	c.events = restored
	dropped := c.trimEventsLocked()
	c.mu.Unlock()

	logDroppedSessionEvents(dropped)
}

// trimEventsLocked sheds the oldest events once the buffer exceeds its cap and
// reports how many it dropped. Callers must hold c.mu, and must log the count
// (via logDroppedSessionEvents) only after releasing it.
func (c *SessionCollector) trimEventsLocked() int {
	if len(c.events) <= maxBufferedSessionEvents {
		return 0
	}

	dropped := len(c.events) - maxBufferedSessionEvents
	c.events = append(c.events[:0], c.events[dropped:]...)
	return dropped
}

// logDroppedSessionEvents reports shed events. Shedding is real data loss, so
// it is never silent.
func logDroppedSessionEvents(dropped int) {
	if dropped <= 0 {
		return
	}
	slog.Warn("session event backlog exceeded buffer, dropped oldest events",
		"dropped", dropped,
		"buffered", maxBufferedSessionEvents)
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
		// Skip sessions with empty usernames (e.g. Windows Session 0 / services);
		// the API requires username to be non-empty.
		if strings.TrimSpace(detected.Username) == "" {
			continue
		}
		key := sessionKey(detected.Username, inferSessionType(detected), detected.Session)
		existing, hasExisting := c.sessions[key]

		loginAt := now
		if hasExisting {
			loginAt = existing.LoginAt
		}

		idleMinutes, lastActivityAt := idleFields(detected, now)
		next[key] = UserSession{
			Username:       detected.Username,
			SessionType:    inferSessionType(detected),
			SessionID:      detected.Session,
			LoginAt:        loginAt,
			IdleMinutes:    idleMinutes,
			ActivityState:  mapDetectedState(detected.State),
			IsActive:       true,
			LastActivityAt: lastActivityAt,
		}
	}

	c.sessions = next
}

// idleFields converts a detected session's idle measurement into the wire
// representation: a nil pointer when unknown (so old agents and unmeasurable
// platforms read as "no data", never "0 minutes"), and a LastActivityAt
// anchored to the actual last input rather than the refresh tick.
func idleFields(detected sessionbroker.DetectedSession, now time.Time) (*int, time.Time) {
	if !detected.IdleKnown {
		return nil, now
	}
	minutes := int(detected.IdleFor / time.Minute)
	if minutes < 0 {
		minutes = 0
	}
	if minutes > maxIdleMinutes {
		minutes = maxIdleMinutes
	}
	return &minutes, now.Add(-detected.IdleFor)
}

func (c *SessionCollector) applyEvent(event sessionbroker.SessionEvent, now time.Time) {
	// Skip events with empty usernames (e.g. Windows Session 0 / services);
	// the API requires username to be non-empty.
	if strings.TrimSpace(event.Username) == "" {
		return
	}

	sessionType := inferSessionTypeFromEvent(event)
	key := sessionKey(event.Username, sessionType, event.Session)

	dropped := 0
	c.mu.Lock()
	// Deferred LIFO: the lock is released inside this func before the log runs,
	// so a slow log writer never stalls a concurrent Collect().
	defer func() {
		c.mu.Unlock()
		logDroppedSessionEvents(dropped)
	}()

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

	dropped = c.trimEventsLocked()
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
