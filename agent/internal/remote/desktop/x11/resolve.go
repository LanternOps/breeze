package x11

import (
	"errors"
	"strconv"
	"strings"
)

var (
	// ErrNoDisplay is returned when no attachable X11 display session exists.
	ErrNoDisplay = errors.New("no attachable X11 display session")
	// ErrWaylandUnsupported is returned when only a Wayland session is present.
	ErrWaylandUnsupported = errors.New("wayland session present but X11 capture unsupported")
	// ErrConnectFailed is returned when a resolved display cannot be reached at
	// the socket level (the X unix socket refuses or fails the dial).
	ErrConnectFailed = errors.New("x11 connect failed")
	// ErrAuthFailed is returned when the socket is reached but the X server
	// rejects the connection handshake/authentication (e.g. a stale cookie).
	ErrAuthFailed = errors.New("x11 authentication failed")
)

// DisplayTarget describes a resolved X (or Wayland) session the agent may mirror.
type DisplayTarget struct {
	Display     string
	XauthPath   string
	OwnerUID    int
	OwnerName   string
	SessionType string // "x11" | "wayland"
	Active      bool
}

type loginctlSession struct {
	id   string
	uid  int
	user string
}

// parseAuthArg returns the value of the "-auth <path>" argument in an X server
// argv, or "" if absent.
func parseAuthArg(argv []string) string {
	for i := 0; i < len(argv)-1; i++ {
		if argv[i] == "-auth" {
			return argv[i+1]
		}
	}
	return ""
}

// parseLoginctlSessions parses `loginctl list-sessions --no-legend` output. The
// column layout is: SESSION UID USER [SEAT] [TTY]. We only need session id, uid,
// and user; extra columns are ignored.
func parseLoginctlSessions(out string) []loginctlSession {
	var sessions []loginctlSession
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		uid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		sessions = append(sessions, loginctlSession{id: fields[0], uid: uid, user: fields[2]})
	}
	return sessions
}
