package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// activeRemoteSessionOverSignInConsole returns the WTS session id of an
// active, signed-in RDP session that a desktop start with no target should use
// instead of the console, or "" to keep the console.
//
// It applies only when the console is at the sign-in screen: enumerated, not
// disconnected, and with no user signed in (a username that could not be read
// does not count as nobody). A technician who pressed Connect Desktop on a
// server whose console shows the sign-in screen while an administrator is
// working over RDP wants that administrator's desktop (#8434, reporter test
// 3). An explicitly targeted session never reaches this; the viewer's session
// switcher still offers the console.
//
// It applies only when exactly one active, signed-in RDP session exists, and
// that session has a capture-capable helper. With several, which user's desktop
// the technician meant is a guess — on a terminal server the console sits at
// the sign-in screen almost permanently — so the console is kept and the
// viewer's session switcher is the way to reach a specific user.
func activeRemoteSessionOverSignInConsole(consoleID string, detected []sessionbroker.DetectedSession, capable func(winSession string) bool) string {
	consoleAtSignIn := false
	for _, ds := range detected {
		if ds.Session == consoleID {
			consoleAtSignIn = ds.Username == "" && !ds.UsernameUnknown && ds.State != "disconnected"
			break
		}
	}
	if !consoleAtSignIn {
		return ""
	}
	candidate := ""
	for _, ds := range detected {
		if ds.Session == consoleID || ds.Type != "rdp" || ds.State != "active" || ds.Username == "" {
			continue
		}
		if candidate != "" {
			return "" // more than one signed-in RDP user: ambiguous
		}
		candidate = ds.Session
	}
	if candidate == "" || !capable(candidate) {
		return ""
	}
	return candidate
}

// activeRemoteHelperOverSignInConsole is the live wiring of
// activeRemoteSessionOverSignInConsole for findActiveHelper: it reads the WTS
// session list and the connected helpers, and returns the helper to use, or
// nil to keep the existing console-first choice. Windows only by the caller.
func (h *Heartbeat) activeRemoteHelperOverSignInConsole(consoleID string) *sessionbroker.Session {
	detected, err := sessionbroker.NewSessionDetector().ListSessions()
	if err != nil {
		log.Warn("findActiveHelper: could not list sessions, so a console at the sign-in screen cannot be detected; keeping the console-first choice",
			"error", err.Error())
		return nil
	}
	// Same selector, and so the same tie-break between several helpers in one
	// session, as every other desktop start: FindCapableSession with an
	// explicit target, which also rejects a disconnected session.
	helperFor := func(winSession string) *sessionbroker.Session {
		s := h.sessionBroker.FindCapableSession("capture", winSession)
		if s == nil || s.WinSessionID != winSession {
			return nil
		}
		return s
	}
	id := activeRemoteSessionOverSignInConsole(consoleID, detected, func(w string) bool {
		return helperFor(w) != nil
	})
	if id == "" {
		return nil
	}
	picked := helperFor(id)
	if picked == nil {
		return nil
	}
	log.Warn("findActiveHelper: console is at the sign-in screen; picked the active RDP session",
		"winSession", picked.WinSessionID, "helperSession", picked.SessionID, "consoleID", consoleID)
	return picked
}
