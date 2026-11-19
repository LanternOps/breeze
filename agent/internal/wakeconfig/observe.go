package wakeconfig

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// Vendor observation (#10838 observe-first amendment). The server grants
// observation per vendor in wake_on_lan_settings.observe_vendors; the grant is
// held in memory only and lapses 24 h after the last heartbeat that carried it
// (Manager.observeGrant). Observation reads and reports; it writes nothing,
// never moves the readiness state past unproven, and never changes the
// fingerprint the server keys its wake-proof and timeout counters on.

// observeTimeout bounds one cycle's whole vendor read.
const observeTimeout = 4 * time.Minute

// ObserveFunc reads the granted vendor's interface for one collection. It
// returns nil when the machine is not a granted vendor.
type ObserveFunc func(ctx context.Context, in Inputs, grant biosconfig.VendorSet) *biosconfig.Observation

// NewObserver is the production observer.
func NewObserver(agentVersion string) ObserveFunc {
	return observerWith(biosconfig.RunReadOnlyPowerShell, biosconfig.NativeArch, agentVersion, time.Now)
}

func observerWith(run biosconfig.Runner, arch func() string, agentVersion string, now func() time.Time) ObserveFunc {
	return func(ctx context.Context, in Inputs, grant biosconfig.VendorSet) *biosconfig.Observation {
		if grant == 0 {
			return nil
		}
		start := now()
		o := readVendor(ctx, run, in, grant)
		if o == nil {
			return nil
		}
		stampCommon(o, arch(), agentVersion)
		if d := now().Sub(start).Milliseconds(); d > 0 {
			o.DurationMs = d
		}
		return o
	}
}

// readVendor runs the granted vendor's read. A panic inside it is an error
// observation for that vendor, returned here so the caller still stamps the
// common fields the server's schema requires.
func readVendor(ctx context.Context, run biosconfig.Runner, in Inputs, grant biosconfig.VendorSet) (o *biosconfig.Observation) {
	defer func() {
		if r := recover(); r != nil {
			log.Warn("wake vendor observation panicked; reported as an error")
			o = biosconfig.Failed(observationVendor(in.Manufacturer), "panic")
		}
	}()
	if a := biosconfig.DetectWith(in.Manufacturer, in.Model, grant, run); a != nil {
		if ob, ok := a.(biosconfig.Observer); ok {
			return ob.Observe(ctx)
		}
		return nil
	}
	if grant.Has(biosconfig.VendorSurface) && isSurfaceMake(in.Manufacturer) {
		return observeSurface(ctx, run, in)
	}
	return nil
}

// stampCommon fills the common block every observation must carry to pass
// the server's strict schema.
func stampCommon(o *biosconfig.Observation, arch, agentVersion string) {
	o.Schema = 1
	switch arch {
	case "amd64", "arm64", "x86":
		o.NativeArch = arch
	default:
		o.NativeArch = "unknown"
	}
	o.CollectedWith = biosconfig.CleanText(agentVersion, 32)
	if o.CollectedWith == "" {
		o.CollectedWith = "unknown"
	}
}

// observationVendor is the snapshot vendor an observation for this make
// would carry, or "" when the make is not an observe vendor.
func observationVendor(manufacturer string) string {
	switch m := biosconfig.MakeOf(manufacturer); m {
	case "hp", "lenovo", "microsoft":
		return m
	}
	return ""
}

// uploadKey decides whether a snapshot is re-uploaded before the 24 h
// keepalive. Without an observation it is the fingerprint, as before. With one
// it also covers the observation (minus its timing), so fresh evidence is sent
// promptly while the fingerprint the server keys on stays put.
func uploadKey(s Snapshot) string {
	if s.observation == nil {
		return s.Fingerprint
	}
	o := *s.observation
	o.DurationMs = 0
	raw, err := json.Marshal(o)
	if err != nil {
		return s.Fingerprint
	}
	sum := sha256.Sum256(raw)
	return s.Fingerprint + "|obs:" + hex.EncodeToString(sum[:8])
}
