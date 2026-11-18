// Package biosconfig is the seam between the wake readiness collector and
// vendor firmware (BIOS/UEFI) settings. It carries no Wake-on-LAN logic: it
// only describes how a vendor adapter reads settings.
package biosconfig

import "context"

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

// Adapter reads (and, from W04, writes) firmware settings for one vendor.
//
// Apply ships in W04. Nothing in this release calls it, and no adapter in this
// release implements a write path.
type Adapter interface {
	Vendor() string
	Read(ctx context.Context) ([]Setting, error)
	Protection(ctx context.Context) (Protection, error)
	Apply(ctx context.Context, name, value string) error
}

// Detect returns the firmware adapter for a machine, or nil when there is none.
//
// It returns nil for every make in this release. Vendor adapters are added one
// per wave, and only after that vendor's hardware has been captured and the
// adapter tested against the capture (plan Task 8 step 1). Until then every
// device reports readiness "unproven" with reason firmware_adapter_unavailable.
func Detect(manufacturer, model string) Adapter {
	return nil
}
