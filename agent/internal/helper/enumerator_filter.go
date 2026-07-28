package helper

import "github.com/breeze-rmm/agent/internal/sessionbroker"

// consoleOnlySessions filters a detector snapshot down to the single session
// attached to the physical console. Assist helpers launched into any other
// session are rejected at broker authentication (assist role requires the
// active console session), so spawning them elsewhere is pure waste on
// multi-session hosts (RDS). consoleID is sessionbroker.GetConsoleSessionID();
// "0" is its WTS-failure / Session-0 sentinel, in which case no session is
// eligible.
func consoleOnlySessions(detected []sessionbroker.DetectedSession, consoleID string) []SessionInfo {
	if consoleID == "" || consoleID == "0" {
		return nil
	}
	for _, s := range detected {
		if s.Session != consoleID {
			continue
		}
		if s.State != "active" && s.State != "connected" {
			continue
		}
		return []SessionInfo{{Key: s.Session, Username: s.Username}}
	}
	return nil
}
