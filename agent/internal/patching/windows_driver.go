package patching

import (
	"fmt"
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
	// InstallStarted says the install was handed to WUA. With Err set, the update
	// may be staged anyway; without it, nothing was touched.
	InstallStarted bool
}

// driverUpdateFrom builds a DriverUpdate from a property reader. A manufacturer or
// model that cannot be read is an error, not an empty string: empty reads as "not
// Surface", which would report no updates on a broken read. An unreadable class
// stays empty, which classifies as firmware.
func driverUpdateFrom(id string, read func(property string) (string, error)) (DriverUpdate, error) {
	maker, err := read("DriverManufacturer")
	if err != nil {
		return DriverUpdate{}, fmt.Errorf("DriverManufacturer: %w", err)
	}
	model, err := read("DriverModel")
	if err != nil {
		return DriverUpdate{}, fmt.Errorf("DriverModel: %w", err)
	}
	title, _ := read("Title")
	class, _ := read("DriverClass")
	return DriverUpdate{UpdateID: id, Title: title, DriverManufacturer: maker, DriverClass: class, DriverModel: model}, nil
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
	if strings.TrimSpace(u.DriverClass) == "" {
		return DriverKindFirmware
	}
	for _, text := range []string{u.DriverClass, u.Title, u.DriverModel} {
		text = strings.ToLower(text)
		for _, word := range []string{"firmware", "uefi", "bios"} {
			if strings.Contains(text, word) {
				return DriverKindFirmware
			}
		}
	}
	return DriverKindDriver
}

// Manufacturers that name a vendor lane's own updates, on the whole trimmed string,
// as the API matches a device to its lane. UNCONFIRMED for Dell, HP and Lenovo: their
// lab waves capture what Windows Update really says and correct these.
var (
	dellManufacturer   = regexp.MustCompile(`(?i)^dell(?: inc\.?)?$`)
	hpManufacturer     = regexp.MustCompile(`(?i)^(?:hp(?: inc\.?)?|hewlett-packard)$`)
	lenovoManufacturer = regexp.MustCompile(`(?i)^lenovo$`)
)

// pcLaneDriverClasses are the DriverClass values of a PC's own hardware. UNCONFIRMED,
// like the manufacturers above. An allowlist: the vendor's name on a printer, monitor
// or dock does not put it in that PC lane's catalog, and a class nobody has seen yet
// gets the same answer.
var pcLaneDriverClasses = map[string]bool{
	"system": true, "video": true, "display": true, "sound": true, "media": true,
	"net": true, "networking": true, "bluetooth": true, "storage": true, "chipset": true,
}

// isPCLaneDriverClass also takes a class that names firmware. A blank class does not
// count here, though it classifies as firmware: nothing shows the lane would take it.
func isPCLaneDriverClass(class string) bool {
	class = strings.ToLower(strings.TrimSpace(class))
	if pcLaneDriverClasses[class] {
		return true
	}
	for _, word := range []string{"firmware", "uefi", "bios"} {
		if strings.Contains(class, word) {
			return true
		}
	}
	return false
}

// driverUpdateOwner names the vendor lane whose own update this is, or "" for an
// update no lane takes. A lane only delivers its vendor's updates: an Intel display
// driver on a Surface, or a printer driver on any PC, stays with Windows Update, so
// Breeze patch jobs must keep installing it. Surface goes by the rule its lane
// selects with; the other lanes pick for themselves, so this can only be cautious.
func driverUpdateOwner(u DriverUpdate) string {
	if IsSurfaceDriverUpdate(u) {
		return "surface"
	}
	if !isPCLaneDriverClass(u.DriverClass) {
		return ""
	}
	maker := strings.TrimSpace(u.DriverManufacturer)
	switch {
	case dellManufacturer.MatchString(maker):
		return "dell"
	case hpManufacturer.MatchString(maker):
		return "hp"
	case lenovoManufacturer.MatchString(maker):
		return "lenovo"
	}
	return ""
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
