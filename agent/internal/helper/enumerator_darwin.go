//go:build darwin

package helper

import (
	"strconv"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type darwinEnumerator struct {
	detector sessionbroker.SessionDetector
}

// NewPlatformEnumerator returns the platform session enumerator.
func NewPlatformEnumerator() SessionEnumerator {
	return &darwinEnumerator{detector: sessionbroker.NewSessionDetector()}
}

func (e *darwinEnumerator) ActiveSessions() []SessionInfo {
	if e.detector == nil {
		return nil
	}
	detected, err := e.detector.ListSessions()
	if err != nil {
		return nil
	}

	sessions := make([]SessionInfo, 0, len(detected))
	seen := make(map[uint32]bool)
	for _, s := range detected {
		if s.UID == 0 || seen[s.UID] {
			continue
		}
		seen[s.UID] = true
		sessions = append(sessions, SessionInfo{
			Key:      strconv.FormatUint(uint64(s.UID), 10),
			Username: s.Username,
			UID:      s.UID,
		})
	}
	return sessions
}
