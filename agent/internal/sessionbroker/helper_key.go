package sessionbroker

import (
	"fmt"
	"strconv"

	"github.com/breeze-rmm/agent/internal/ipc"
)

type HelperKey struct {
	WindowsSessionID uint32
	Role             ipc.HelperRole
}

// helperRoleSpawnable reports whether role is one the lifecycle manager may
// launch a process for. Only the two lifecycle roles qualify: assist and
// watchdog helpers are started by other means and must never be spawned here.
//
// This gate exists because the Windows spawn path selects a token privilege
// level from the role. Anything that is not exactly ipc.HelperRoleUser would
// otherwise take the SYSTEM-token branch, so an empty or misspelled role
// silently escalates.
func helperRoleSpawnable(role ipc.HelperRole) bool {
	return role == ipc.HelperRoleSystem || role == ipc.HelperRoleUser
}

func (k HelperKey) String() string {
	return fmt.Sprintf("%d-%s", k.WindowsSessionID, k.Role)
}

func helperRoleDesired(s DetectedSession, role ipc.HelperRole) bool {
	if s.Session == "0" || s.Type == "services" {
		return false
	}
	switch role {
	case ipc.HelperRoleSystem:
		return s.State == "active" || s.State == "connected" || (s.Type == "rdp" && s.State == "disconnected")
	case ipc.HelperRoleUser:
		return s.State == "active"
	default:
		return false
	}
}

func helperKeyFromDetected(s DetectedSession, role ipc.HelperRole) (HelperKey, bool) {
	if !helperRoleDesired(s, role) {
		return HelperKey{}, false
	}
	id, err := strconv.ParseUint(s.Session, 10, 32)
	if err != nil || id == 0 {
		return HelperKey{}, false
	}
	return HelperKey{WindowsSessionID: uint32(id), Role: role}, true
}
