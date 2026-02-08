package sessionbroker

import "context"

// SessionEventType identifies login/logout/switch events.
type SessionEventType string

const (
	SessionLogin  SessionEventType = "login"
	SessionLogout SessionEventType = "logout"
	SessionLock   SessionEventType = "lock"
	SessionUnlock SessionEventType = "unlock"
	SessionSwitch SessionEventType = "switch"
)

// SessionEvent represents a user session change detected by the OS.
type SessionEvent struct {
	Type     SessionEventType `json:"type"`
	UID      uint32           `json:"uid"`
	Username string           `json:"username"`
	Session  string           `json:"session"`
	IsRemote bool             `json:"isRemote"`
	Display  string           `json:"display,omitempty"`
}

// DetectedSession is a snapshot of a currently logged-in session.
type DetectedSession struct {
	UID      uint32 `json:"uid"`
	Username string `json:"username"`
	Session  string `json:"session"`
	IsRemote bool   `json:"isRemote"`
	Display  string `json:"display,omitempty"`
	Seat     string `json:"seat,omitempty"`
	State    string `json:"state,omitempty"` // "active", "online", "closing"
}

// SessionDetector detects user sessions and monitors login/logout events.
type SessionDetector interface {
	// ListSessions returns all currently logged-in sessions.
	ListSessions() ([]DetectedSession, error)

	// WatchSessions returns a channel that emits session change events.
	// The channel is closed when the context is cancelled.
	WatchSessions(ctx context.Context) <-chan SessionEvent
}
