package collectors

import (
	"regexp"
	"strconv"
	"strings"
)

// Battery / power current-state telemetry (#2142).
//
// Unlike the hardware inventory (sent daily), battery state is dynamic — charge
// level, charging vs discharging, and AC connection change minute to minute — so
// it rides the fast heartbeat alongside CPU/RAM/disk metrics. The server stores
// the latest snapshot on the devices row and surfaces it as an optional "Power"
// column and a device-detail section.
//
// Design notes:
//   - Present distinguishes a genuine no-battery desktop (false) from a device
//     whose OS/agent could not determine battery state. When there is no battery,
//     we still report Present=false so the server can render a definitive dash
//     instead of "unknown".
//   - Every other field is a pointer/omitempty so "the OS did not report this"
//     is distinct from a real zero (0% charge, 0 minutes remaining).
//   - CollectBattery returns nil when the platform can't report power state at
//     all (unsupported OS, or the query failed) so the heartbeat omits the field
//     and the server keeps whatever it last knew rather than clobbering it.
//
// Battery HEALTH (design/full capacity, cycle count, condition) is intentionally
// out of scope for v1 — this is operational current state only.

// Charging-state vocabulary. Mirrors the BatteryChargingState union in
// packages/shared and the Zod enum in the API heartbeat schema — keep the three
// in sync.
const (
	batteryStateCharging    = "charging"
	batteryStateDischarging = "discharging"
	batteryStateFull        = "full"
	batteryStateNotCharging = "not_charging"
	batteryStateUnknown     = "unknown"
)

// BatteryInfo is the agent-side power snapshot serialized into the heartbeat
// payload. JSON tags match the API's battery sub-schema exactly.
type BatteryInfo struct {
	Present              bool     `json:"present"`
	Percent              *float64 `json:"percent,omitempty"`
	ChargingState        string   `json:"chargingState,omitempty"`
	PluggedIn            *bool    `json:"pluggedIn,omitempty"`
	TimeRemainingMinutes *int     `json:"timeRemainingMinutes,omitempty"`
	TimeToFullMinutes    *int     `json:"timeToFullMinutes,omitempty"`
}

// CollectBattery returns the current power state, or nil when the platform
// cannot determine it (so the heartbeat omits the field entirely).
func (c *HardwareCollector) CollectBattery() *BatteryInfo {
	return collectPlatformBattery()
}

// floatPtr / intPtr / boolPtr are small helpers so platform collectors can set
// optional fields inline.
func floatPtr(v float64) *float64 { return &v }
func intPtr(v int) *int           { return &v }
func boolPtr(v bool) *bool        { return &v }

// clampPercent keeps a reported charge within 0-100. Some sources (Windows
// BatteryLifePercent) use sentinel values like 255 for "unknown", which callers
// should filter out before calling this; clamp only guards ordinary noise.
func clampPercent(p float64) float64 {
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// ---------------------------------------------------------------------------
// Pure mapping/parsing helpers.
//
// These live in the shared (build-tag-free) file so they compile and unit-test
// on every platform, mirroring how extractWindowsBuild in hardware.go is tested
// cross-platform. The platform files (battery_{windows,linux,darwin}.go) do the
// OS-specific IO (syscall / /sys reads / pmset) and hand raw values here.
// ---------------------------------------------------------------------------

// Windows GetSystemPowerStatus sentinels (SYSTEM_POWER_STATUS).
const (
	winFlagCharging  = 0x08
	winFlagNoBattery = 0x80
	winByteUnknown   = 0xFF
	winTimeUnknown   = 0xFFFFFFFF
)

// mapWindowsPowerStatus converts the raw SYSTEM_POWER_STATUS fields into a
// BatteryInfo. Pure so it can be exhaustively table-tested without Windows.
func mapWindowsPowerStatus(acLine, batteryFlag, lifePercent byte, lifeTime uint32) *BatteryInfo {
	// BatteryFlag 128 = "no system battery" (desktop). Report a definitive
	// no-battery snapshot rather than nil so the server renders a dash.
	if batteryFlag == winFlagNoBattery {
		return &BatteryInfo{Present: false, PluggedIn: boolPtr(true)}
	}

	info := &BatteryInfo{Present: true}

	if lifePercent != winByteUnknown {
		info.Percent = floatPtr(clampPercent(float64(lifePercent)))
	}

	plugged := false
	acKnown := false
	switch acLine {
	case 0:
		plugged, acKnown = false, true
	case 1:
		plugged, acKnown = true, true
	}
	if acKnown {
		info.PluggedIn = boolPtr(plugged)
	}

	charging := batteryFlag != winByteUnknown && batteryFlag&winFlagCharging != 0
	switch {
	case charging:
		info.ChargingState = batteryStateCharging
	case acKnown && plugged && info.Percent != nil && *info.Percent >= 100:
		info.ChargingState = batteryStateFull
	case acKnown && plugged:
		info.ChargingState = batteryStateNotCharging
	case acKnown && !plugged:
		info.ChargingState = batteryStateDischarging
	default:
		info.ChargingState = batteryStateUnknown
	}

	// BatteryLifeTime is the estimated seconds remaining on battery; only
	// meaningful while discharging, 0xFFFFFFFF when unknown. Windows does not
	// report time-to-full.
	if lifeTime != winTimeUnknown && info.ChargingState == batteryStateDischarging {
		info.TimeRemainingMinutes = intPtr(int(lifeTime) / 60)
	}
	return info
}

// normalizeLinuxChargingState maps a /sys/class/power_supply/BAT*/status value
// ("Charging", "Discharging", "Full", "Not charging", "Unknown") to our
// vocabulary.
func normalizeLinuxChargingState(status string) string {
	switch normalizeToken(status) {
	case "charging":
		return batteryStateCharging
	case "discharging":
		return batteryStateDischarging
	case "full":
		return batteryStateFull
	case "notcharging":
		return batteryStateNotCharging
	default:
		return batteryStateUnknown
	}
}

// normalizeDarwinChargingState maps the state word from `pmset -g batt`
// ("charging", "discharging", "charged", "finishing charge", "AC attached") to
// our vocabulary.
func normalizeDarwinChargingState(state string) string {
	switch normalizeToken(state) {
	case "charging", "finishingcharge":
		return batteryStateCharging
	case "discharging":
		return batteryStateDischarging
	case "charged":
		return batteryStateFull
	default:
		return batteryStateUnknown
	}
}

// normalizeToken lowercases and strips whitespace so "Not charging" == "notcharging".
func normalizeToken(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.NewReplacer(" ", "", "\t", "", "\n", "", "\r", "").Replace(s)
}

var (
	pmsetPercentRe = regexp.MustCompile(`(\d+)%`)
	// State word between "%;" and the next ";" — e.g. "; charged;", "; discharging;".
	pmsetStateRe = regexp.MustCompile(`%;\s*([^;]+?)\s*;`)
	// Time estimate "H:MM" (maps to time-to-full while charging, else remaining).
	pmsetTimeRe = regexp.MustCompile(`(\d+):(\d{2})`)
)

// parsePmsetBatt parses `pmset -g batt` output into a BatteryInfo. Pure so the
// darwin collector's IO is separated from parsing and this is unit-testable on
// any platform. Returns Present=false (no battery line) for desktop Macs.
func parsePmsetBatt(output string) *BatteryInfo {
	var pluggedIn *bool
	if strings.Contains(output, "'AC Power'") {
		pluggedIn = boolPtr(true)
	} else if strings.Contains(output, "'Battery Power'") {
		pluggedIn = boolPtr(false)
	}

	line := ""
	for _, l := range strings.Split(output, "\n") {
		if strings.Contains(l, "InternalBattery") ||
			(strings.Contains(l, "%;") && strings.Contains(l, "present:")) {
			line = l
			break
		}
	}
	if line == "" {
		// No battery detail line ⇒ desktop / no battery.
		return &BatteryInfo{Present: false, PluggedIn: pluggedIn}
	}

	info := &BatteryInfo{Present: true, PluggedIn: pluggedIn}

	if m := pmsetPercentRe.FindStringSubmatch(line); len(m) == 2 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			info.Percent = floatPtr(clampPercent(v))
		}
	}

	state := ""
	if m := pmsetStateRe.FindStringSubmatch(line); len(m) == 2 {
		state = m[1]
	}
	info.ChargingState = normalizeDarwinChargingState(state)

	if m := pmsetTimeRe.FindStringSubmatch(line); len(m) == 3 {
		hours, herr := strconv.Atoi(m[1])
		mins, merr := strconv.Atoi(m[2])
		if herr == nil && merr == nil {
			if total := hours*60 + mins; total > 0 {
				switch info.ChargingState {
				case batteryStateCharging:
					info.TimeToFullMinutes = intPtr(total)
				case batteryStateDischarging:
					info.TimeRemainingMinutes = intPtr(total)
				}
			}
		}
	}
	return info
}

// linuxMinutesFromEnergy estimates minutes from a Linux power-supply reservoir
// and drain/fill rate. energy_now/power_now are µWh/µW; charge_now/current_now
// are µAh/µA — either pair works since the ratio is hours. Returns nil when the
// rate is unusable (0 while idle) so the field is simply omitted.
func linuxMinutesFromEnergy(reservoir, ratePerHour float64) *int {
	if ratePerHour <= 0 || reservoir < 0 {
		return nil
	}
	minutes := int((reservoir / ratePerHour) * 60.0)
	if minutes <= 0 {
		return nil
	}
	return intPtr(minutes)
}
