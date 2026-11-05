package patching

import (
	"regexp"
	"strings"
)

// Windows Update driver search for vendor lanes (#11065). The search itself is
// COM, in windows.go; what decides which updates a lane may touch is here, pure
// and testable on any OS.
//
// UNCONFIRMED: the strings below come from documentation and reading, not from a
// Surface. The Surface lab wave (W12, leg S1) captures real DriverManufacturer,
// DriverClass and DriverModel values and corrects this file. Until then every
// guess leans the safe way: a doubtful manufacturer is not Surface, and a
// doubtful class is firmware.

// driverSearchCriteria is the IUpdateSearcher query for pending, visible drivers.
const driverSearchCriteria = "Type='Driver' and IsInstalled=0 and IsHidden=0"

// maxDriverUpdates is the result contract's item cap.
const maxDriverUpdates = 200

// DriverUpdate is one pending driver or firmware update, from IWindowsDriverUpdate.
// Every string is untrusted catalog text.
type DriverUpdate struct {
	UpdateID           string
	Title              string
	DriverManufacturer string
	DriverClass        string
	DriverModel        string
}

// DriverKind says how an update must be treated.
type DriverKind string

const (
	// DriverKindDriver is a plain driver.
	DriverKindDriver DriverKind = "driver"
	// DriverKindFirmware writes firmware, cannot be rolled back, and takes every
	// firmware gate.
	DriverKindFirmware DriverKind = "firmware"
)

// DriverInstallOutcome is what happened to one update.
type DriverInstallOutcome struct {
	UpdateID string
	Result   InstallResult
	Err      error
}

// surfaceManufacturers name Surface on their own. "Microsoft" does not: it also
// ships generic drivers, so it needs a Surface model too.
var (
	surfaceManufacturers   = map[string]bool{"surface": true, "microsoft surface": true}
	microsoftManufacturers = map[string]bool{"microsoft": true, "microsoft corporation": true}
	surfaceModel           = regexp.MustCompile(`(?i)^surface\s`)
)

// IsSurfaceDriverUpdate matches on the whole manufacturer string, never a
// substring: a near-miss must not authorize a flash (Review Focus 1).
func IsSurfaceDriverUpdate(u DriverUpdate) bool {
	maker := strings.ToLower(strings.TrimSpace(u.DriverManufacturer))
	if surfaceManufacturers[maker] {
		return true
	}
	return microsoftManufacturers[maker] && surfaceModel.MatchString(strings.TrimSpace(u.DriverModel))
}

// ClassifyDriverUpdate is deliberately one-sided. A firmware update taken for a
// driver would flash with BitLocker on and none of the firmware gates; a driver
// taken for firmware only waits behind stricter gates.
func ClassifyDriverUpdate(u DriverUpdate) DriverKind {
	class := strings.ToLower(strings.TrimSpace(u.DriverClass))
	if class == "" || class == "firmware" {
		return DriverKindFirmware
	}
	for _, text := range []string{u.Title, u.DriverModel} {
		text = strings.ToLower(text)
		for _, word := range []string{"firmware", "uefi", "bios"} {
			if strings.Contains(text, word) {
				return DriverKindFirmware
			}
		}
	}
	return DriverKindDriver
}

// SurfaceDriverPlan is what a Surface run may install.
type SurfaceDriverPlan struct {
	Drivers  []DriverUpdate
	Firmware []DriverUpdate
}

// SelectSurfaceDriverUpdates keeps Surface updates, drops blocked ids, and splits
// the rest by kind. Everything else on the machine (an Intel display driver, say)
// is left to Windows Update as before.
func SelectSurfaceDriverUpdates(all []DriverUpdate, blocked []string) SurfaceDriverPlan {
	drop := make(map[string]bool, len(blocked))
	for _, id := range blocked {
		if n := normalizeUpdateID(id); n != "" {
			drop[n] = true
		}
	}
	seen := make(map[string]bool, len(all))
	var plan SurfaceDriverPlan
	taken := 0
	for _, u := range all {
		id := normalizeUpdateID(u.UpdateID)
		if id == "" || drop[id] || seen[id] || !IsSurfaceDriverUpdate(u) {
			continue
		}
		seen[id] = true
		if taken >= maxDriverUpdates {
			break
		}
		taken++
		if ClassifyDriverUpdate(u) == DriverKindFirmware {
			plan.Firmware = append(plan.Firmware, u)
		} else {
			plan.Drivers = append(plan.Drivers, u)
		}
	}
	return plan
}

func normalizeUpdateID(id string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(id), "{}"))
}
