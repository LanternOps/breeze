package sessionbroker

import (
	"context"
	"errors"
	"fmt"
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

	// Locked reports a locked screen for this session; only meaningful when
	// LockKnown is true. Windows reads it from the WTS session flags, Linux
	// from logind's LockedHint. The consent gate treats an unknown lock state
	// as "cannot tell whether the user can see the prompt".
	Locked    bool `json:"-"`
	LockKnown bool `json:"-"`

	// Linux (logind) only: the session Class ("user", "greeter",
	// "background", ...) and raw Type ("x11", "wayland", "tty", ...), and
	// whether `loginctl show-session` could be read at all. When
	// PropertiesUnknown is set, State/Display/Seat/Class are defaults, not
	// facts, and must not be used to conclude that nobody is at a desktop.
	Class             string `json:"-"`
	LogindType        string `json:"-"`
	PropertiesUnknown bool   `json:"-"`
	// LogindDisplay is logind's Display property: the X display (":10")
	// the session owns, set even for sessions whose Type is not graphical
	// (xrdp, Xvnc).
	LogindDisplay string `json:"-"`
}

// ErrSessionListIncomplete is returned by ListSessionsComplete when the
// detector had to skip rows it could not parse. The sessions it did read are
// still returned; callers that need the whole picture treat the list as
// incomplete.
var ErrSessionListIncomplete = errors.New("session list is incomplete: some sessions could not be read")

// countedSessionLister is implemented by detectors that can report how many
// rows they skipped (unparseable or unsafe fields).
type countedSessionLister interface {
	listSessionsCounted() ([]DetectedSession, int, error)
}

// ListSessionsComplete is ListSessions for callers that must not mistake a
// skipped row for an absent session: it fails with ErrSessionListIncomplete
// (alongside the sessions it did read) when any row was skipped.
func ListSessionsComplete(d SessionDetector) ([]DetectedSession, error) {
	counted, ok := d.(countedSessionLister)
	if !ok {
		return d.ListSessions()
	}
	sessions, skipped, err := counted.listSessionsCounted()
	if err != nil {
		return sessions, err
	}
	if skipped > 0 {
		return sessions, fmt.Errorf("%w (%d skipped)", ErrSessionListIncomplete, skipped)
	}
	return sessions, nil
}

// SessionDetector detects user sessions and monitors login/logout events.
type SessionDetector interface {
	// ListSessions returns all currently logged-in sessions.
	ListSessions() ([]DetectedSession, error)

	// WatchSessions returns a channel that emits session change events.
	// The channel is closed when the context is cancelled.
	WatchSessions(ctx context.Context) <-chan SessionEvent
}
