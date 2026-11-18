// Package wakeconfig computes and uploads a device's Wake-on-LAN readiness.
// It is read-only: nothing here writes to the registry, a NIC or firmware.
package wakeconfig

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// Readiness states the agent can report (a subset of the server's).
const (
	StateUnsupportedVM = "unsupported_vm"
	StateNoWired       = "no_wired_adapter"
	StateNotConfigured = "not_configured"
	StateUnproven      = "unproven"
)

// adapterMemoryTTL is how long an adapter that is no longer present (a laptop
// undocked) stays remembered, with its last readings.
const adapterMemoryTTL = 30 * 24 * time.Hour

const maxReasonCodes = 16

// AdapterReading is one wired adapter as read right now.
type AdapterReading struct {
	MAC         string // lowercase, colon separated
	MagicPacket string // enabled|disabled|unsupported|unknown
	EEE         string // enabled|disabled|absent|unknown
}

// WindowsReadings is the Windows layer of one collection.
type WindowsReadings struct {
	FastStartup string // enabled|disabled|unknown
	Adapters    []AdapterReading
	// SkippedAdapters counts wired adapters dropped because their MAC could
	// not be parsed; they cannot be tracked, but they do exist.
	SkippedAdapters int
	// NetAdapterCmdletsUnavailable is set when the host lacks the NetAdapter
	// cmdlets, so no adapter can be read and the device cannot be assessed.
	NetAdapterCmdletsUnavailable bool
}

// AdapterRecord is what the agent remembers about a wired adapter.
type AdapterRecord struct {
	LastSeenAt  time.Time `json:"lastSeenAt"`
	MagicPacket string    `json:"magicPacket"`
	EEE         string    `json:"eee"`
}

// AdapterMemory maps MAC to the last record.
type AdapterMemory map[string]AdapterRecord

// Inputs is everything Compute needs; it does no I/O.
type Inputs struct {
	OS           string
	Manufacturer string
	Model        string
	Virtual      bool
	Windows      *WindowsReadings
	Firmware     biosconfig.Adapter
	Memory       AdapterMemory
	Now          time.Time
}

// Snapshot is the PUT /agents/:id/wake-status body (exact camelCase keys).
type Snapshot struct {
	ReadinessState         string         `json:"readinessState"`
	ReasonCodes            []string       `json:"reasonCodes"`
	Vendor                 *string        `json:"vendor"`
	Fingerprint            string         `json:"fingerprint"`
	CollectedAt            string         `json:"collectedAt"`
	LastApplyAt            *string        `json:"lastApplyAt"`
	LastApplyResult        *string        `json:"lastApplyResult"`
	LastWiredAdapterSeenAt *string        `json:"lastWiredAdapterSeenAt"`
	Details                map[string]any `json:"details"`

	// Memory is the updated adapter memory for the caller to persist.
	Memory AdapterMemory `json:"-"`
}

func normaliseVendor(manufacturer string) *string {
	m := strings.ToLower(strings.TrimSpace(manufacturer))
	if m == "" {
		return nil
	}
	v := m
	switch {
	case strings.HasPrefix(m, "dell"):
		v = "dell"
	case m == "hp" || strings.HasPrefix(m, "hp ") || strings.HasPrefix(m, "hp.") || strings.HasPrefix(m, "hewlett"):
		v = "hp"
	case strings.HasPrefix(m, "lenovo"):
		v = "lenovo"
	case strings.HasPrefix(m, "microsoft"):
		v = "microsoft"
	}
	if len(v) > 32 {
		v = strings.ToValidUTF8(v[:32], "")
	}
	return &v
}

func orUnknown(v string) string {
	if v == "" {
		return "unknown"
	}
	return v
}

// Compute turns one set of readings into a Snapshot. First matching rule wins:
// virtual machine, no wired adapter, a wrong Windows setting (not_configured),
// otherwise unproven. There is no "ready" path in this release: the firmware
// layer cannot be read, and the agent never claims what it did not verify.
func Compute(in Inputs) Snapshot {
	now := in.Now.UTC()
	reasons := map[string]bool{}
	snap := Snapshot{
		Vendor:      normaliseVendor(in.Manufacturer),
		CollectedAt: now.Format(time.RFC3339),
	}

	// Merge present adapters into memory; keep recently seen absent ones.
	mem := AdapterMemory{}
	present := map[string]bool{}
	for mac, rec := range in.Memory {
		if now.Sub(rec.LastSeenAt) <= adapterMemoryTTL {
			mem[mac] = rec
		}
	}
	fast := "unknown"
	if in.Windows != nil {
		fast = orUnknown(in.Windows.FastStartup)
		for _, a := range in.Windows.Adapters {
			mac := strings.ToLower(a.MAC)
			present[mac] = true
			mem[mac] = AdapterRecord{LastSeenAt: now, MagicPacket: orUnknown(a.MagicPacket), EEE: orUnknown(a.EEE)}
		}
	}
	snap.Memory = mem

	macs := make([]string, 0, len(mem))
	for mac := range mem {
		macs = append(macs, mac)
	}
	sort.Strings(macs)

	adapters := make([]map[string]any, 0, len(macs))
	var lastSeen time.Time
	for _, mac := range macs {
		rec := mem[mac]
		adapters = append(adapters, map[string]any{
			"mac": mac, "present": present[mac], "lastSeenAt": rec.LastSeenAt.UTC().Format(time.RFC3339),
			"magicPacket": rec.MagicPacket, "eee": rec.EEE,
		})
		if rec.LastSeenAt.After(lastSeen) {
			lastSeen = rec.LastSeenAt
		}
	}
	if !lastSeen.IsZero() {
		s := lastSeen.UTC().Format(time.RFC3339)
		snap.LastWiredAdapterSeenAt = &s
	}

	firmware := "adapter_unavailable"
	if in.Firmware != nil {
		// Unreachable this release: biosconfig.Detect returns nil for every
		// make. A vendor adapter's firmware read and its reason codes arrive
		// with that vendor's wave, after its hardware has been captured. Until
		// then a non-nil adapter is still reported unproven, never ready.
		firmware = "adapter_unread"
	}

	switch {
	case in.Virtual:
		snap.ReadinessState = StateUnsupportedVM
		reasons["virtual_machine"] = true
	case cmdletsUnavailable(in):
		// No adapter can be read, so remembered readings are not current and
		// "no wired adapter" would be a claim the agent cannot make.
		snap.ReadinessState = StateUnproven
		reasons["nic_cmdlets_unavailable"] = true
	case len(macs) == 0 && in.Windows != nil && in.Windows.SkippedAdapters > 0:
		// A wired adapter exists but could not be read; do not claim none.
		snap.ReadinessState = StateUnproven
		reasons["nic_unreadable"] = true
	case len(macs) == 0:
		snap.ReadinessState = StateNoWired
		reasons["no_wired_adapter"] = true
	default:
		wrong := false
		switch fast {
		case "enabled":
			reasons["fast_startup_enabled"] = true
			wrong = true
		case "unknown":
			reasons["fast_startup_unknown"] = true
		}
		good := false
		for _, mac := range macs {
			if rec := mem[mac]; rec.MagicPacket == "enabled" && rec.EEE != "enabled" {
				good = true
				break
			}
		}
		if !good {
			for _, mac := range macs {
				rec := mem[mac]
				switch rec.MagicPacket {
				case "disabled", "unsupported":
					reasons["nic_magic_packet_disabled"] = true
					wrong = true
				case "enabled":
				default:
					reasons["nic_magic_packet_unknown"] = true
				}
				if rec.EEE == "enabled" {
					reasons["nic_eee_enabled"] = true
					wrong = true
				}
			}
		}
		if wrong {
			snap.ReadinessState = StateNotConfigured
		} else {
			snap.ReadinessState = StateUnproven
			if in.Firmware == nil {
				reasons["firmware_adapter_unavailable"] = true
			}
		}
	}

	snap.ReasonCodes = make([]string, 0, len(reasons))
	for r := range reasons {
		snap.ReasonCodes = append(snap.ReasonCodes, r)
	}
	sort.Strings(snap.ReasonCodes)
	if len(snap.ReasonCodes) > maxReasonCodes {
		snap.ReasonCodes = snap.ReasonCodes[:maxReasonCodes]
	}

	snap.Details = map[string]any{
		"os": in.OS, "manufacturer": in.Manufacturer, "model": in.Model, "virtual": in.Virtual,
		"fastStartup": fast, "firmware": firmware, "adapters": adapters,
	}
	snap.Fingerprint = fingerprint(in, fast, macs, mem, snap.ReadinessState)
	return snap
}

// fingerprint hashes what a wake decision depends on. It covers the remembered
// adapter set (present or not) with each one's last readings, so docking or
// undocking a remembered adapter does not change it.
func fingerprint(in Inputs, fast string, macs []string, mem AdapterMemory, state string) string {
	h := sha256.New()
	w := func(s string) { _, _ = h.Write([]byte(s)); _, _ = h.Write([]byte{0}) }
	w(in.Manufacturer)
	w(in.Model)
	w(fast)
	for _, mac := range macs {
		w(mac)
		w(mem[mac].MagicPacket)
		w(mem[mac].EEE)
	}
	w(state)
	// Written only when set, so hosts with the cmdlets keep the fingerprint
	// their wake proofs were recorded against.
	if cmdletsUnavailable(in) {
		w("nic_cmdlets_unavailable")
	}
	return hex.EncodeToString(h.Sum(nil))
}

func cmdletsUnavailable(in Inputs) bool {
	return in.Windows != nil && in.Windows.NetAdapterCmdletsUnavailable
}
