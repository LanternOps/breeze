package collectors

import (
	"log/slog"
	"os"
	"path/filepath"
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
//   - The optional pointer/omitempty fields (Percent, PluggedIn, the two time
//     estimates) make "the OS did not report this" distinct from a real zero
//     (0% charge, 0 minutes remaining). ChargingState is a string enum that is
//     omitted when empty; collectors set it to batteryStateUnknown rather than
//     leaving it blank when a battery is present but its state is indeterminate.
//   - CollectBattery returns nil when the platform can't report power state at
//     all (unsupported OS, or the query FAILED) so the heartbeat omits the field
//     and the server keeps whatever it last knew rather than clobbering it. This
//     is why a read error must NOT be collapsed to Present:false — that would
//     overwrite a real laptop's last-known snapshot with a bogus "no battery".
//
// Battery HEALTH (design/full capacity, cycle count, condition) is intentionally
// out of scope for v1 — this is operational current state only.

// BatteryChargingState is the closed charging-state vocabulary. Mirrors the
// BatteryChargingState union in packages/shared and the Zod enum in the API
// heartbeat schema — keep the three in sync. Typed (not a bare string) so the
// constants and the struct field are compile-time linked.
type BatteryChargingState string

const (
	batteryStateCharging    BatteryChargingState = "charging"
	batteryStateDischarging BatteryChargingState = "discharging"
	batteryStateFull        BatteryChargingState = "full"
	batteryStateNotCharging BatteryChargingState = "not_charging"
	batteryStateUnknown     BatteryChargingState = "unknown"
)

// BatteryInfo is the agent-side power snapshot serialized into the heartbeat
// payload. JSON tags match the API's battery sub-schema exactly.
type BatteryInfo struct {
	Present              bool                 `json:"present"`
	Percent              *float64             `json:"percent,omitempty"`
	ChargingState        BatteryChargingState `json:"chargingState,omitempty"`
	PluggedIn            *bool                `json:"pluggedIn,omitempty"`
	TimeRemainingMinutes *int                 `json:"timeRemainingMinutes,omitempty"`
	TimeToFullMinutes    *int                 `json:"timeToFullMinutes,omitempty"`
}

// powerSupplyRoot is the Linux sysfs power-supply directory. A package-level
// var (not const) so tests can point collectBatteryFromSysfs at a fixture dir.
var powerSupplyRoot = "/sys/class/power_supply"

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
func normalizeLinuxChargingState(status string) BatteryChargingState {
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
func normalizeDarwinChargingState(state string) BatteryChargingState {
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

func readSysTrim(path string) (string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(b)), true
}

func readSysFloat(path string) (float64, bool) {
	s, ok := readSysTrim(path)
	if !ok {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// collectBatteryFromSysfs walks a Linux power-supply directory (parameterized
// so tests can pass a fixture root). Pure file IO — testable on any platform.
//
// Error handling honors the nil-vs-Present:false contract: a genuinely absent
// subsystem (ENOENT) is a definitive "no battery" (desktop/server), but any
// OTHER read failure (EACCES, EIO, a restricted /sys) means "couldn't
// determine" → return nil so the heartbeat omits the field and the server
// keeps the last-known snapshot rather than flipping a real laptop to a
// permanent no-battery dash.
func collectBatteryFromSysfs(root string) *BatteryInfo {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return &BatteryInfo{Present: false}
		}
		slog.Warn("read power_supply failed", "root", root, "error", err.Error())
		return nil
	}

	var (
		info        BatteryInfo
		acKnown     bool
		pluggedIn   bool
		haveBattery bool
		sawReadErr  bool
	)

	for _, e := range entries {
		dir := filepath.Join(root, e.Name())
		typ, ok := readSysTrim(filepath.Join(dir, "type"))
		if !ok {
			// A supply dir with an unreadable `type` — can't classify it. Note
			// the error so we don't later assert a definitive "no battery" if
			// this was in fact the (unreadable) system battery.
			sawReadErr = true
			continue
		}
		switch typ {
		case "Mains", "USB", "ADP", "Wireless":
			if online, ok := readSysFloat(filepath.Join(dir, "online")); ok {
				acKnown = true
				if online >= 1 {
					pluggedIn = true
				}
			}
		case "Battery":
			// Skip peripheral batteries (wireless mouse/keyboard) — scope=Device.
			if scope, ok := readSysTrim(filepath.Join(dir, "scope")); ok && scope == "Device" {
				continue
			}
			// Skip empty battery bays (present=0).
			if present, ok := readSysFloat(filepath.Join(dir, "present")); ok && present < 1 {
				continue
			}
			if haveBattery {
				continue // headline state comes from the first system battery
			}
			haveBattery = true

			if pct, ok := readSysFloat(filepath.Join(dir, "capacity")); ok {
				info.Percent = floatPtr(clampPercent(pct))
			}
			if status, ok := readSysTrim(filepath.Join(dir, "status")); ok {
				info.ChargingState = normalizeLinuxChargingState(status)
			} else {
				info.ChargingState = batteryStateUnknown
			}

			// Time estimate from energy/power (µWh/µW) or charge/current (µAh/µA).
			reservoirNow, haveNow := readSysFloat(filepath.Join(dir, "energy_now"))
			rate, haveRate := readSysFloat(filepath.Join(dir, "power_now"))
			full, haveFull := readSysFloat(filepath.Join(dir, "energy_full"))
			if !haveNow || !haveRate {
				reservoirNow, haveNow = readSysFloat(filepath.Join(dir, "charge_now"))
				rate, haveRate = readSysFloat(filepath.Join(dir, "current_now"))
				full, haveFull = readSysFloat(filepath.Join(dir, "charge_full"))
			}
			if haveNow && haveRate {
				switch info.ChargingState {
				case batteryStateDischarging:
					info.TimeRemainingMinutes = linuxMinutesFromEnergy(reservoirNow, rate)
				case batteryStateCharging:
					if haveFull && full >= reservoirNow {
						info.TimeToFullMinutes = linuxMinutesFromEnergy(full-reservoirNow, rate)
					}
				}
			}
		}
	}

	// Couldn't positively identify a battery but hit read errors along the way
	// → we don't actually know there's no battery. Omit rather than clobber.
	if !haveBattery && sawReadErr {
		return nil
	}

	info.Present = haveBattery
	if acKnown {
		info.PluggedIn = boolPtr(pluggedIn)
	}
	if info.ChargingState == "" && haveBattery {
		info.ChargingState = batteryStateUnknown
	}
	return &info
}
