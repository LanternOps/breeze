// Package biosconfig is the seam between the wake readiness collector and
// vendor firmware (BIOS/UEFI) settings. It carries no Wake-on-LAN logic: it
// only describes how a vendor adapter reads settings.
package biosconfig

import (
	"context"
	"errors"
	"strings"
)

// Setting is one firmware setting as the vendor tooling reports it.
type Setting struct {
	Name    string
	Value   string
	Allowed []string
}

// Protection says whether the firmware is guarded by a setup password.
type Protection int

const (
	ProtectionNone Protection = iota
	ProtectionSet
	ProtectionUnknown
)

// String names a Protection for logs and snapshot details.
func (p Protection) String() string {
	switch p {
	case ProtectionNone:
		return "none"
	case ProtectionSet:
		return "set"
	default:
		return "unknown"
	}
}

// Adapter reads (and, from W04, writes) firmware settings for one vendor.
//
// Apply ships in W04. Nothing in this release calls it, and every adapter in
// this release returns ErrApplyUnsupported without running anything.
type Adapter interface {
	Vendor() string
	Read(ctx context.Context) ([]Setting, error)
	Protection(ctx context.Context) (Protection, error)
	Apply(ctx context.Context, name, value string) error
}

// ErrInterfaceUnavailable means the vendor's firmware interface is not present
// on this machine (for Dell: no native BIOS WMI namespace, as on older models).
var ErrInterfaceUnavailable = errors.New("firmware settings interface not available on this machine")

// ErrApplyUnsupported is returned by every Apply in this release. Firmware
// writes ship in W04.
var ErrApplyUnsupported = errors.New("firmware writes are not supported in this release")

// Detect returns the firmware adapter for a machine, or nil when there is none.
//
// Only Dell has an adapter, and only on Windows (native BIOS WMI, read-only in
// this release). It was built against a capture from a lab OptiPlex 7060 (plan
// Task 8 step 1). Every other make returns nil and reports readiness
// "unproven" with reason firmware_adapter_unavailable until its own vendor
// wave, after that vendor's hardware has been captured.
func Detect(manufacturer, model string) Adapter {
	if isDell(manufacturer) {
		return newDellAdapter()
	}
	return nil
}

// isDell matches Dell's SMBIOS manufacturer strings ("Dell Inc.", "Dell
// Computer Corporation", "Dell") without matching other names that only start
// with the same letters.
func isDell(manufacturer string) bool {
	m := strings.ToLower(strings.TrimSpace(manufacturer))
	return m == "dell" || strings.HasPrefix(m, "dell ") || strings.HasPrefix(m, "dell.") || strings.HasPrefix(m, "dell,")
}
