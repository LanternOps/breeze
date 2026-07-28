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
	return consoleOnlySessions(detected, sessionbroker.GetConsoleSessionID())
}
