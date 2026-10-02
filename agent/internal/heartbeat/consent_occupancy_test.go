package heartbeat

import (
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Whether anyone is signed in to the session being captured. The answer
// decides between "nobody to ask" (policy applies) and "someone could not be
// asked" (always refused), so anything short of positive evidence of an empty
// desktop must be occupied or unknown — never unoccupied.
func TestClassifyConsentOccupancy(t *testing.T) {
	win := func(id, user, state string) sessionbroker.DetectedSession {
		typ := "console"
		if id == "0" {
			typ = "services"
		}
		return sessionbroker.DetectedSession{Session: id, Username: user, State: state, Type: typ}
	}
	lx := func(class, typ, state, seat string, remote bool) sessionbroker.DetectedSession {
		return sessionbroker.DetectedSession{Username: "u", Session: "c1", Class: class, LogindType: typ, State: state, Seat: seat, IsRemote: remote}
	}
	greeter := func(display string) sessionbroker.DetectedSession {
		s := lx("greeter", "x11", "active", "seat0", false)
		s.LogindDisplay = display
		return s
	}
	withDisplay := func(s sessionbroker.DetectedSession, display string) sessionbroker.DetectedSession {
		s.LogindDisplay = display
		return s
	}
	many := make([]sessionbroker.DetectedSession, sessionbroker.MaxDetectedSessions)
	for i := range many {
		many[i] = win("9", "", "connected")
	}

	tests := []struct {
		name     string
		goos     string
		sessions []sessionbroker.DetectedSession
		listErr  error
		target   string
		x11      []string
		x11Err   error
		want     string
	}{
		// Windows, targeted: exactly the captured WTS session.
		{"win target signed in", "windows", []sessionbroker.DetectedSession{win("0", "", "active"), win("2", "bob", "active")}, nil, "2", nil, nil, occupancyOccupied},
		{"win target disconnected user is still occupied", "windows", []sessionbroker.DetectedSession{win("2", "bob", "disconnected")}, nil, "2", nil, nil, occupancyOccupied},
		{"win target logged-off console", "windows", []sessionbroker.DetectedSession{win("1", "", "connected"), win("3", "carol", "active")}, nil, "1", nil, nil, occupancyUnoccupied},
		{"win target username unreadable", "windows", []sessionbroker.DetectedSession{{Session: "2", UsernameUnknown: true, State: "active", Type: "console"}}, nil, "2", nil, nil, occupancyUnknown},
		{"win target missing", "windows", []sessionbroker.DetectedSession{win("1", "", "connected")}, nil, "4", nil, nil, occupancyUnknown},
		// Windows, untargeted: conservative, any signed-in session counts.
		{"win untargeted nobody", "windows", []sessionbroker.DetectedSession{win("0", "", "active"), win("1", "", "connected")}, nil, "", nil, nil, occupancyUnoccupied},
		{"win untargeted someone anywhere", "windows", []sessionbroker.DetectedSession{win("1", "", "connected"), win("3", "carol", "disconnected")}, nil, "", nil, nil, occupancyOccupied},
		{"win untargeted unreadable username", "windows", []sessionbroker.DetectedSession{win("1", "", "connected"), {Session: "3", UsernameUnknown: true, Type: "rdp"}}, nil, "", nil, nil, occupancyUnknown},
		{"win enumeration failed", "windows", nil, errors.New("wts"), "", nil, nil, occupancyUnknown},
		{"win enumeration truncated", "windows", many, nil, "", nil, nil, occupancyUnknown},

		// Linux (logind).
		{"linux graphical user", "linux", []sessionbroker.DetectedSession{lx("user", "wayland", "active", "seat0", false)}, nil, "", nil, nil, occupancyOccupied},
		{"linux locked graphical user", "linux", []sessionbroker.DetectedSession{lx("user", "x11", "online", "seat0", false)}, nil, "", []string{":0"}, nil, occupancyOccupied},
		{"linux early user class", "linux", []sessionbroker.DetectedSession{lx("user-early", "x11", "active", "seat0", false)}, nil, "", []string{":0"}, nil, occupancyOccupied},
		{"linux local tty on a seat (startx)", "linux", []sessionbroker.DetectedSession{lx("user", "tty", "active", "seat0", false)}, nil, "", []string{":0"}, nil, occupancyOccupied},
		{"linux remote graphical (xrdp)", "linux", []sessionbroker.DetectedSession{lx("user", "x11", "active", "", true)}, nil, "", []string{":0"}, nil, occupancyOccupied},
		{"linux ssh only", "linux", []sessionbroker.DetectedSession{lx("user", "tty", "active", "", true)}, nil, "", nil, nil, occupancyUnoccupied},
		{"linux lingering closing session", "linux", []sessionbroker.DetectedSession{lx("user", "x11", "closing", "seat0", false)}, nil, "", nil, nil, occupancyUnoccupied},
		{"linux background manager", "linux", []sessionbroker.DetectedSession{lx("manager", "unspecified", "active", "", false), lx("background", "unspecified", "active", "", false)}, nil, "", nil, nil, occupancyUnoccupied},
		{"linux greeter only", "linux", []sessionbroker.DetectedSession{greeter(":0")}, nil, "", []string{":0"}, nil, occupancyUnoccupied},
		{"linux greeter plus an X display it does not own", "linux", []sessionbroker.DetectedSession{greeter(":0")}, nil, "", []string{":0", ":10"}, nil, occupancyUnknown},
		{"linux greeter without a display property", "linux", []sessionbroker.DetectedSession{greeter("")}, nil, "", []string{":0"}, nil, occupancyUnknown},
		// xrdp / Xvnc: a user session with no seat and a non-graphical logind
		// Type, but an X display of its own.
		{"linux xrdp session with a display", "linux", []sessionbroker.DetectedSession{withDisplay(lx("user", "unspecified", "online", "", true), ":10"), greeter(":0")}, nil, "", []string{":0", ":10"}, nil, occupancyOccupied},
		{"linux xrdp session without a display property", "linux", []sessionbroker.DetectedSession{lx("user", "tty", "online", "", true), greeter(":0")}, nil, "", []string{":0", ":10"}, nil, occupancyUnknown},
		{"linux listing incomplete", "linux", []sessionbroker.DetectedSession{greeter(":0")}, sessionbroker.ErrSessionListIncomplete, "", []string{":0"}, nil, occupancyUnknown},
		{"linux no sessions, no displays", "linux", nil, nil, "", nil, nil, occupancyUnoccupied},
		{"linux X display nobody accounts for", "linux", nil, nil, "", []string{":0"}, nil, occupancyUnknown},
		{"linux display enumeration failed", "linux", nil, nil, "", nil, errors.New("readdir"), occupancyUnknown},
		{"linux properties unreadable", "linux", []sessionbroker.DetectedSession{{Username: "u", Session: "c1", State: "active", PropertiesUnknown: true}}, nil, "", nil, nil, occupancyUnknown},
		{"linux unfamiliar class", "linux", []sessionbroker.DetectedSession{lx("wizard", "x11", "active", "seat0", false)}, nil, "", nil, nil, occupancyUnknown},
		{"linux missing class", "linux", []sessionbroker.DetectedSession{lx("", "x11", "active", "seat0", false)}, nil, "", nil, nil, occupancyUnknown},
		{"linux occupied wins over unknown", "linux", []sessionbroker.DetectedSession{{Username: "u", Session: "c0", PropertiesUnknown: true}, lx("user", "x11", "active", "seat0", false)}, nil, "", []string{":0"}, nil, occupancyOccupied},
		{"linux loginctl failed", "linux", nil, errors.New("no logind"), "", nil, nil, occupancyUnknown},

		// macOS: the console-user API cannot tell "nobody" from "could not
		// read", and fast-user-switched sessions are invisible to it.
		{"mac console user", "darwin", []sessionbroker.DetectedSession{{Username: "dana", Session: "console"}}, nil, "", nil, nil, occupancyOccupied},
		{"mac no console user", "darwin", nil, nil, "", nil, nil, occupancyUnknown},
		{"mac login window", "darwin", []sessionbroker.DetectedSession{{Username: "loginwindow", Session: "console"}}, nil, "", nil, nil, occupancyUnknown},
		{"mac detection failed", "darwin", nil, errors.New("stat"), "", nil, nil, occupancyUnknown},

		{"unsupported platform", "plan9", nil, nil, "", nil, nil, occupancyUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyConsentOccupancy(tt.goos, tt.sessions, tt.listErr, tt.target, tt.x11, tt.x11Err)
			if got != tt.want {
				t.Fatalf("classifyConsentOccupancy = %q, want %q", got, tt.want)
			}
		})
	}
}

// Whether the user in the consenting session could see the prompt when its
// countdown ran out. Only a positively unlocked, active session counts.
func TestConsentTargetVisible(t *testing.T) {
	tests := []struct {
		name     string
		goos     string
		sessions []sessionbroker.DetectedSession
		listErr  error
		winID    string
		want     bool
	}{
		{"win active unlocked", "windows", []sessionbroker.DetectedSession{{Session: "2", State: "active", LockKnown: true}}, nil, "2", true},
		{"win locked", "windows", []sessionbroker.DetectedSession{{Session: "2", State: "active", LockKnown: true, Locked: true}}, nil, "2", false},
		{"win lock state unknown", "windows", []sessionbroker.DetectedSession{{Session: "2", State: "active"}}, nil, "2", false},
		{"win disconnected", "windows", []sessionbroker.DetectedSession{{Session: "2", State: "disconnected", LockKnown: true}}, nil, "2", false},
		{"win other session", "windows", []sessionbroker.DetectedSession{{Session: "3", State: "active", LockKnown: true}}, nil, "2", false},
		{"win enumeration failed", "windows", nil, errors.New("x"), "2", false},
		// logind's LockedHint is only set by some screen lockers, so Linux can
		// never positively establish an unlocked screen.
		{"linux active graphical", "linux", []sessionbroker.DetectedSession{{UID: 1000, Class: "user", LogindType: "x11", State: "active", LockKnown: true}}, nil, "", false},
		{"linux locked", "linux", []sessionbroker.DetectedSession{{UID: 1000, Class: "user", LogindType: "x11", State: "active", LockKnown: true, Locked: true}}, nil, "", false},
		{"linux lock unknown", "linux", []sessionbroker.DetectedSession{{UID: 1000, Class: "user", LogindType: "x11", State: "active"}}, nil, "", false},
		{"linux inactive (switched away)", "linux", []sessionbroker.DetectedSession{{UID: 1000, Class: "user", LogindType: "x11", State: "online", LockKnown: true}}, nil, "", false},
		{"linux other user", "linux", []sessionbroker.DetectedSession{{UID: 1001, Class: "user", LogindType: "x11", State: "active", LockKnown: true}}, nil, "", false},
		{"mac cannot tell", "darwin", []sessionbroker.DetectedSession{{Username: "dana"}}, nil, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := consentTargetVisible(tt.goos, tt.sessions, tt.listErr, tt.winID); got != tt.want {
				t.Fatalf("consentTargetVisible = %v, want %v", got, tt.want)
			}
		})
	}
}
