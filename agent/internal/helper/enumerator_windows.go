//go:build windows

package helper

import "github.com/breeze-rmm/agent/internal/sessionbroker"

type windowsEnumerator struct {
	detector sessionbroker.SessionDetector
}

// NewPlatformEnumerator returns the platform session enumerator.
func NewPlatformEnumerator() SessionEnumerator {
	return &windowsEnumerator{detector: sessionbroker.NewSessionDetector()}
}

func (e *windowsEnumerator) ActiveSessions() []SessionInfo {
	if e.detector == nil {
		return nil
	}
	detected, err := e.detector.ListSessions()
	if err != nil {
		return nil
	}

	sessions := make([]SessionInfo, 0, len(detected))
	seen := make(map[string]bool)
	for _, s := range detected {
		if s.Session == "0" || s.Type == "services" {
			continue
		}
		if s.State != "active" && s.State != "connected" {
			continue
		}
		if seen[s.Session] {
			continue
		}
		seen[s.Session] = true
		sessions = append(sessions, SessionInfo{
			Key:      s.Session,
			Username: s.Username,
		})
	}
	return sessions
}
