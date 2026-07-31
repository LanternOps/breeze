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

// retainDisconnectedSystemHelper reports whether a disconnected session should
// keep its SYSTEM helper (subject to the TTL cap in applyDisconnectedRetention).
// On an RDS host WTSClientProtocolType is unreliable after disconnect (it
// reverts to 0, so the session reports Type="console"), so key on
// state+non-console instead of Type. On a workstation, preserve the historical
// Type=="rdp" truth table exactly (rdsHost=false path is bit-identical).
func retainDisconnectedSystemHelper(s DetectedSession, rdsHost bool, consoleSessionID string) bool {
	if s.State != "disconnected" {
		return false
	}
	if rdsHost {
		return s.Session != consoleSessionID
	}
	return s.Type == "rdp"
}

func helperRoleDesired(s DetectedSession, role ipc.HelperRole, rdsHost bool, consoleSessionID string) bool {
	if s.Session == "0" || s.Type == "services" {
		return false
	}
	switch role {
	case ipc.HelperRoleSystem:
		return s.State == "active" || s.State == "connected" || retainDisconnectedSystemHelper(s, rdsHost, consoleSessionID)
	case ipc.HelperRoleUser:
		return s.State == "active"
	default:
		return false
	}
}

func helperKeyFromDetected(s DetectedSession, role ipc.HelperRole, rdsHost bool, consoleSessionID string) (HelperKey, bool) {
	if !helperRoleDesired(s, role, rdsHost, consoleSessionID) {
		return HelperKey{}, false
	}
	id, err := strconv.ParseUint(s.Session, 10, 32)
	if err != nil || id == 0 {
		return HelperKey{}, false
	}
	return HelperKey{WindowsSessionID: uint32(id), Role: role}, true
}
