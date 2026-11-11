package oemupdates

import (
	"errors"
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/privilege"
)

// minFlashBatteryPercent is the battery floor for a firmware install even on
// AC: Surface capsules fail below it (vendor doc), and "AC connected" alone is
// what the patch preflight accepts today.
const minFlashBatteryPercent = 25

// SYSTEM_POWER_STATUS values.
const (
	acOnline         = 1
	batteryNoBattery = 128
	batteryUnknown   = 255
	percentUnknown   = 255
)

// CheckFlashPower decides whether a firmware install may start. AC power is
// mandatory whatever PatchRequireACPower says; a machine with a battery also
// needs it at or above the floor. Anything unknown refuses.
func CheckFlashPower(p PowerStatus) (ok bool, reason string) {
	if p.ACLineStatus != acOnline {
		if p.ACLineStatus == 255 {
			return false, "AC power status unknown"
		}
		return false, "not on AC power"
	}
	if p.BatteryFlag == batteryUnknown {
		return false, "battery status unknown"
	}
	if p.BatteryFlag&batteryNoBattery != 0 {
		return true, ""
	}
	if p.BatteryLifePercent == percentUnknown {
		return false, "battery charge unknown"
	}
	if p.BatteryLifePercent < minFlashBatteryPercent {
		return false, fmt.Sprintf("battery at %d%%, needs %d%%", p.BatteryLifePercent, minFlashBatteryPercent)
	}
	return true, ""
}

// CheckRecoveryKey decides whether Breeze holds a current recovery key.
//
// "Current" (spec §4.5): BitLocker is on for the OS volume, and at least one
// recovery-password protector read live immediately before the install is in
// the escrowed set the API sent. Matching is by protector id only, never by an
// escrow timestamp or status, because an unchanged snapshot is not resent and
// those fields cannot show freshness. A protector rotated since dispatch fails
// the match, which is the safe direction.
func CheckRecoveryKey(onVolume []string, escrowed []string, bitlockerOn bool) bool {
	if !bitlockerOn {
		return true
	}
	want := make(map[string]bool, len(escrowed))
	for _, id := range escrowed {
		if n := normalizeProtectorID(id); n != "" {
			want[n] = true
		}
	}
	for _, id := range onVolume {
		if n := normalizeProtectorID(id); n != "" && want[n] {
			return true
		}
	}
	return false
}

func normalizeProtectorID(id string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(id), "{}"))
}

// isElevated is a variable so tests can run the refusal either way.
var isElevated = privilege.IsRunningAsRoot

var errNotElevated = errors.New("oem_update_run needs the agent to run elevated")

// RefuseUnlessElevated refuses a run unless the agent is SYSTEM/root. This is
// its own check: the heartbeat's generic privilege check only warns.
func RefuseUnlessElevated() error {
	if !isElevated() {
		return runErr("not_elevated", errNotElevated)
	}
	return nil
}
