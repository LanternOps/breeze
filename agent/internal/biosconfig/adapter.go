// Package biosconfig is the seam between the wake readiness collector and
// vendor firmware (BIOS/UEFI) settings. It carries no Wake-on-LAN logic: it
// only describes how a vendor adapter reads settings.
//
// At the observe stage (#10838 observe-first amendment) the HP and Lenovo
// adapters read and report; they write nothing. Apply returns ErrNotEnabled,
// and no write class or method name appears in this package's source
// (TestNoWriteMethodReachable).
//
// Dell is not an observe lane: its adapter (native BIOS WMI, Windows only) is
// read for readiness through DetectReadiness, and is read-only in this release
// (Apply returns ErrApplyUnsupported).
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

// Protection says whether the firmware is guarded by a setup password. The
// zero value is ProtectionUnknown, so a forgotten field never reads as "none".
type Protection int

const (
	ProtectionUnknown Protection = iota
	ProtectionNone
	ProtectionSet
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

// ErrNotEnabled is Apply's answer at the observe stage: no adapter writes.
var ErrNotEnabled = errors.New("firmware writes are not enabled for this vendor")

// ErrInterfaceUnavailable means the vendor's firmware interface is not present
// on this machine (for Dell: no native BIOS WMI namespace, as on older models).
var ErrInterfaceUnavailable = errors.New("firmware settings interface not available on this machine")

// ErrApplyUnsupported is returned by the Dell adapter's Apply in this release.
// Firmware writes ship in W04.
var ErrApplyUnsupported = errors.New("firmware writes are not supported in this release")

// Adapter reads (and, from the act stage, writes) firmware settings for one
// vendor.
type Adapter interface {
	Vendor() string
	Read(ctx context.Context) ([]Setting, error)
	Protection(ctx context.Context) (Protection, error)
	Apply(ctx context.Context, name, value string) error
}

// Observer is implemented by an adapter that can report what it reads as a
// bounded observation for the readiness snapshot.
type Observer interface {
	Observe(ctx context.Context) *Observation
}

// Runner runs one read-only PowerShell script, with stdin as data, and returns
// its stdout. Scripts are compile-time constants: nothing from the server or
// the device is ever spliced into one.
type Runner func(ctx context.Context, script string, stdin []byte) ([]byte, error)

// VendorSet is the set of vendors the server has granted observation for
// (wake_on_lan_settings.observe_vendors). It is comparable, so Settings stays
// comparable.
type VendorSet uint8

const (
	VendorHP VendorSet = 1 << iota
	VendorLenovo
	VendorSurface
)

// lanes are the observe_vendors names, the vendorCanary table's keys. Surface
// is a lane name; its snapshot vendor is "microsoft".
var lanes = []struct {
	name string
	set  VendorSet
}{{"hp", VendorHP}, {"lenovo", VendorLenovo}, {"surface", VendorSurface}}

// ParseLane maps one observe_vendors entry to its lane. Anything else,
// including Dell (which follows the plan's own write path), is not a lane.
func ParseLane(name string) (VendorSet, bool) {
	n := strings.ToLower(strings.TrimSpace(name))
	for _, l := range lanes {
		if n == l.name {
			return l.set, true
		}
	}
	return 0, false
}

// Has reports whether every vendor in v is in s.
func (s VendorSet) Has(v VendorSet) bool { return v != 0 && s&v == v }

func (s VendorSet) String() string {
	names := []string{}
	for _, l := range lanes {
		if s.Has(l.set) {
			names = append(names, l.name)
		}
	}
	return strings.Join(names, ",")
}

// MakeOf returns the canonical make for an SMBIOS manufacturer: dell, hp,
// lenovo or microsoft; "other" for a near-miss of Dell or HP (HPE, Hewlett
// Packard Enterprise, Dell EMC, Delltron: vendor-updates plan Review Focus 1);
// or "" for any other make. Dell and HP match the whole trimmed string, never a
// prefix.
func MakeOf(manufacturer string) string {
	m := strings.ToLower(strings.TrimSpace(manufacturer))
	switch m {
	case "":
		return ""
	case "dell", "dell inc", "dell inc.", "dell computer corporation":
		return "dell"
	case "hp", "hp inc", "hp inc.", "hewlett-packard", "hewlett-packard company":
		return "hp"
	}
	switch {
	case strings.HasPrefix(m, "dell"), strings.HasPrefix(m, "hp"), strings.HasPrefix(m, "hewlett"):
		return "other"
	case strings.HasPrefix(m, "lenovo"):
		return "lenovo"
	case strings.HasPrefix(m, "microsoft"):
		return "microsoft"
	}
	return ""
}

// Detect returns the firmware adapter for a machine, or nil when there is none.
//
// An adapter exists only for HP and Lenovo, and only when the server has
// granted that vendor's observation; it reads and never writes. Dell gets none
// here (it follows the plan's own write path: see DetectReadiness), and
// Surface has no firmware settings to read. Without a grant every device
// reports readiness "unproven" with reason firmware_adapter_unavailable.
func Detect(manufacturer, model string, observe VendorSet) Adapter {
	return DetectWith(manufacturer, model, observe, RunReadOnlyPowerShell)
}

// DetectWith is Detect with the script runner supplied.
func DetectWith(manufacturer, model string, observe VendorSet, run Runner) Adapter {
	switch MakeOf(manufacturer) {
	case "hp":
		if observe.Has(VendorHP) {
			return &hpAdapter{run: run}
		}
	case "lenovo":
		if observe.Has(VendorLenovo) {
			return &lenovoAdapter{run: run, model: model}
		}
	}
	return nil
}

// DetectReadiness returns the firmware adapter whose reads readiness trusts,
// or nil when there is none.
//
// Only Dell has one, and only on Windows (native BIOS WMI, read-only in this
// release). It was built against a capture from a lab OptiPlex 7060 (plan Task
// 8 step 1). It needs no observe grant: Dell is not an observe lane. Every
// other make returns nil and reports readiness "unproven" until its own vendor
// wave, after that vendor's hardware has been captured.
func DetectReadiness(manufacturer, model string) Adapter {
	if MakeOf(manufacturer) == "dell" {
		return newDellAdapter()
	}
	return nil
}
