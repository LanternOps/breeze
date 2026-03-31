//go:build linux

package helper

import (
	"strconv"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type linuxEnumerator struct {
	detector sessionbroker.SessionDetector
}

// NewPlatformEnumerator returns the platform session enumerator.
func NewPlatformEnumerator() SessionEnumerator {
	return &linuxEnumerator{detector: sessionbroker.NewSessionDetector()}
}

func (e *linuxEnumerator) ActiveSessions() []SessionInfo {
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
		if s.State != "" && s.State != "active" && s.State != "online" {
			continue
		}
		if s.Display == "" {
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
