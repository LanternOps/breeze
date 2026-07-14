package sessionbroker

import (
	"fmt"
	"strconv"
)

type HelperKey struct {
	WindowsSessionID uint32
	Role             string
}

func (k HelperKey) String() string {
	return fmt.Sprintf("%d-%s", k.WindowsSessionID, k.Role)
}

func helperRoleDesired(s DetectedSession, role string) bool {
	if s.Session == "0" || s.Type == "services" {
		return false
	}
	switch role {
	case "system":
		return s.State == "active" || s.State == "connected"
	case "user":
		return s.State == "active"
	default:
		return false
	}
}

func helperKeyFromDetected(s DetectedSession, role string) (HelperKey, bool) {
	if !helperRoleDesired(s, role) {
		return HelperKey{}, false
	}
	id, err := strconv.ParseUint(s.Session, 10, 32)
	if err != nil || id == 0 {
		return HelperKey{}, false
	}
	return HelperKey{WindowsSessionID: uint32(id), Role: role}, true
}
