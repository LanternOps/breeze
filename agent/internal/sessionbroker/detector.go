package sessionbroker

import (
	"context"
	"time"
)

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
	Type     string `json:"type,omitempty"`  // "console", "rdp", "services"

	// UsernameUnknown is set when the platform could not read the session's
	// username (a failed WTS query on Windows). An empty Username then means
	// "could not tell", not "nobody is signed in", and callers that gate
	// behavior on a signed-in user must not treat it as the latter.
	UsernameUnknown bool `json:"-"`

	// IdleFor is how long the session has gone without user input. Only
	// meaningful when IdleKnown is true; platforms that cannot measure input
	// idle (or fail to) leave IdleKnown false.
	IdleFor   time.Duration `json:"-"`
	IdleKnown bool          `json:"-"`
}

// SessionDetector detects user sessions and monitors login/logout events.
type SessionDetector interface {
	// ListSessions returns all currently logged-in sessions.
	ListSessions() ([]DetectedSession, error)

	// WatchSessions returns a channel that emits session change events.
	// The channel is closed when the context is cancelled.
	WatchSessions(ctx context.Context) <-chan SessionEvent
}
