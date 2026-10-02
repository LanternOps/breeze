package heartbeat

import (
	"os"
	"strings"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Occupancy of the captured session, as the consent gate evaluates it when the
// prompt could not be shown. Only positive evidence of an empty desktop is
// "unoccupied"; an enumeration error, a truncated list, an unreadable session
// or an unsupported platform is "unknown", which the gate refuses exactly like
// "occupied".
const (
	occupancyOccupied   = "occupied"
	occupancyUnoccupied = "unoccupied"
	occupancyUnknown    = "unknown"
)

// Test seams: the session list and the local X11 displays.
var (
	// listConsentSessionsFn fails with sessionbroker.ErrSessionListIncomplete
	// when the detector skipped a row: an unreadable session may be the one
	// someone is sitting at.
	listConsentSessionsFn = func() ([]sessionbroker.DetectedSession, error) {
		return sessionbroker.ListSessionsComplete(sessionbroker.NewSessionDetector())
	}
	listX11DisplaysFn = listX11Displays
)

// listX11Displays lists X server sockets as display names (":0", ":10"). The
// Linux capturer finds X displays on its own, including ones no logind
// session accounts for, so a display nobody can be matched to is a desktop
// someone may be looking at.
func listX11Displays() ([]string, error) {
	entries, err := os.ReadDir("/tmp/.X11-unix")
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var displays []string
	for _, e := range entries {
		if n, ok := strings.CutPrefix(e.Name(), "X"); ok && n != "" {
			displays = append(displays, ":"+n)
		}
	}
	return displays, nil
}

// classifyConsentOccupancy decides whether anyone is signed in to the session
// the start would capture. target is the Windows session being captured ("" =
// untargeted); x11Displays/x11Err are Linux-only.
func classifyConsentOccupancy(goos string, sessions []sessionbroker.DetectedSession, listErr error, target string, x11Displays []string, x11Err error) string {
	if listErr != nil || len(sessions) >= sessionbroker.MaxDetectedSessions {
		return occupancyUnknown
	}
	switch goos {
	case "windows":
		return classifyWindowsOccupancy(sessions, target)
	case "linux":
		return classifyLinuxOccupancy(sessions, x11Displays, x11Err)
	case "darwin":
		// The console-user API returns the same empty answer for "nobody"
		// and "could not read", and fast-user-switched sessions behind the
		// login window are invisible to it, so a Mac is never positively
		// unoccupied. (A start at the login window is refused earlier.)
		for _, s := range sessions {
			if s.Username != "" && s.Username != "root" && s.Username != "loginwindow" {
				return occupancyOccupied
			}
		}
		return occupancyUnknown
	default:
		return occupancyUnknown
	}
}

func classifyWindowsOccupancy(sessions []sessionbroker.DetectedSession, target string) string {
	if target != "" {
		for _, s := range sessions {
			if s.Session != target {
				continue
			}
			switch {
			case s.UsernameUnknown:
				return occupancyUnknown
			case s.Username != "":
				// Active, locked, disconnected or switched-away: a signed-in
				// user owns this desktop either way.
				return occupancyOccupied
			default:
				// Nobody signed in (Winlogon on a logged-off session).
				return occupancyUnoccupied
			}
		}
		return occupancyUnknown
	}
	// Untargeted: the capture picks a session itself, so any signed-in
	// session counts. Conservative on multi-user hosts by design.
	unknown := false
	for _, s := range sessions {
		if s.Type == "services" {
			continue
		}
		if s.Username != "" {
			return occupancyOccupied
		}
		if s.UsernameUnknown {
			unknown = true
		}
	}
	if unknown {
		return occupancyUnknown
	}
	return occupancyUnoccupied
}

// linuxNonUserClasses are logind session classes that never put a person in
// front of a desktop.
var linuxNonUserClasses = map[string]bool{
	"background":       true,
	"background-light": true,
	"manager":          true,
	"manager-early":    true,
	"lock-screen":      true, // the locked user's own session is listed separately
}

func classifyLinuxOccupancy(sessions []sessionbroker.DetectedSession, x11Displays []string, x11Err error) string {
	unknown := false
	greeterDisplays := map[string]bool{}
	for _, s := range sessions {
		if s.PropertiesUnknown {
			unknown = true
			continue
		}
		switch {
		case strings.HasPrefix(s.Class, "user"):
			// user, user-early, user-light, user-early-light, user-incomplete
			if s.State == "closing" {
				continue // lingering processes after logout, no desktop
			}
			graphical := s.LogindType == "x11" || s.LogindType == "wayland" || s.LogindType == "mir"
			if graphical || s.Seat != "" || s.LogindDisplay != "" {
				// A graphical session (local or remote), anyone at a
				// physical seat (a tty login may be running startx), or a
				// session that owns an X display (xrdp, Xvnc).
				return occupancyOccupied
			}
			// A remote tty (ssh) has no desktop of its own. If it runs an
			// X server anyway, that display is caught below.
		case s.Class == "greeter":
			if s.LogindDisplay != "" {
				greeterDisplays[s.LogindDisplay] = true
			}
		case linuxNonUserClasses[s.Class]:
		default:
			// Missing or unfamiliar class: cannot tell what it is.
			unknown = true
		}
	}
	if unknown || x11Err != nil {
		return occupancyUnknown
	}
	// Every X display must be a login screen: any other one may be a
	// desktop no session accounts for.
	for _, d := range x11Displays {
		if !greeterDisplays[d] {
			return occupancyUnknown
		}
	}
	return occupancyUnoccupied
}

// consentTargetVisible reports whether the user in the consenting helper's
// session could see a prompt: an active session whose screen is known to be
// unlocked. Only Windows can establish that (WTS session state and lock
// flags). Linux cannot — logind's LockedHint stays "no" under screen lockers
// that never set it — and macOS has no lock-state source without cgo, so on
// both an expired prompt is treated as not seen.
func consentTargetVisible(goos string, sessions []sessionbroker.DetectedSession, listErr error, winSessionID string) bool {
	if listErr != nil || goos != "windows" {
		return false
	}
	for _, s := range sessions {
		if s.Session == winSessionID {
			return s.State == "active" && s.LockKnown && !s.Locked
		}
	}
	return false
}
