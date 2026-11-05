package helper

import "github.com/breeze-rmm/agent/internal/sessionbroker"

// consoleOnlySessions filters a detector snapshot down to the single session
// attached to the physical console, and only while a user is signed in to it.
// Assist helpers launched into any other session are rejected at broker
// authentication (assist role requires the active console session), so
// spawning them elsewhere is pure waste on multi-session hosts (RDS).
// consoleID is sessionbroker.GetConsoleSessionID(); "0" is its WTS-failure /
// Session-0 sentinel, in which case no session is eligible.
func consoleOnlySessions(detected []sessionbroker.DetectedSession, consoleID string) []SessionInfo {
	if consoleID == "" || consoleID == "0" {
		return nil
	}
	for _, s := range detected {
		if s.Session != consoleID {
			continue
		}
		if !hasSignedInUser(s) {
			return nil
		}
		return []SessionInfo{{Key: s.Session, Username: s.Username}}
	}
	return nil
}

// hasSignedInUser reports whether a Windows session is an interactive user
// session Assist may launch into (#10379): in the WTSActive or WTSConnected
// state, with a user signed in. Session 0 never gets here: consoleOnlySessions
// returns early when it is the console session.
//
// A console session with nobody signed in (the logon screen after boot or
// sign-out, or a fresh fast-user-switch session) is WTSConnected with an empty
// WTSUserName. There is no user token there, and Assist launched as SYSTEM
// exits 101. A locked session keeps its WTSUserName, so it stays eligible.
//
// A failed user-name query (UsernameUnknown) is "could not tell", not "nobody
// is signed in", so it stays eligible: leaving it out would make Apply stop a
// running Assist over one failed query. A launch is still safe, because the
// spawn path only uses a user token and otherwise reports ErrNoActiveSession.
func hasSignedInUser(s sessionbroker.DetectedSession) bool {
	if s.State != "active" && s.State != "connected" {
		return false
	}
	return s.Username != "" || s.UsernameUnknown
}
