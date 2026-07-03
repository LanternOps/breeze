//go:build linux

package collectors

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const powerSupplyRoot = "/sys/class/power_supply"

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

// collectPlatformBattery reads /sys/class/power_supply/*. Pure file reads, cheap
// enough per heartbeat. Returns Present=false for desktops/servers (AC-only or
// no power-supply subsystem at all).
func collectPlatformBattery() *BatteryInfo {
	entries, err := os.ReadDir(powerSupplyRoot)
	if err != nil {
		// No power-supply subsystem (common on servers/VMs) — no battery.
		return &BatteryInfo{Present: false}
	}

	var (
		info        BatteryInfo
		acKnown     bool
		pluggedIn   bool
		haveBattery bool
	)

	for _, e := range entries {
		dir := filepath.Join(powerSupplyRoot, e.Name())
		typ, _ := readSysTrim(filepath.Join(dir, "type"))
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

	info.Present = haveBattery
	if acKnown {
		info.PluggedIn = boolPtr(pluggedIn)
	}
	if info.ChargingState == "" && haveBattery {
		info.ChargingState = batteryStateUnknown
	}
	return &info
}
