// Package wakeconfig computes and uploads a device's Wake-on-LAN readiness and,
// once activated, applies the fixed list of Windows and NIC settings (apply.go).
// Writes are inactive until writesActivated is flipped in the activation wave;
// until then nothing here writes to the registry, a NIC or firmware.
package wakeconfig

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// Readiness states the agent can report (a subset of the server's).
const (
	StateReady         = "ready"
	StateUnsupportedVM = "unsupported_vm"
	StateNoWired       = "no_wired_adapter"
	StateNotConfigured = "not_configured"
	StateUnproven      = "unproven"
	StateNeedsReboot   = "needs_reboot"
	StateApplyFailed   = "apply_failed"
	// StateFirmwareProtected: a firmware setting is wrong and writes are on,
	// but a BIOS password or the BitLocker guard stops the write.
	StateFirmwareProtected = "firmware_protected"
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
	// ShutdownWake is the Realtek S5WakeOnLan keyword: enabled|disabled|absent|unknown.
	// Empty reads as absent.
	ShutdownWake string
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
	// ShutdownWake is empty in records written before it was read (absent).
	ShutdownWake string `json:"shutdownWake,omitempty"`
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
	// Firmware is nil when the make has no firmware adapter (ReadFirmware).
	Firmware *FirmwareReadings
	// FirmwareAdapter is the adapter that read Firmware; the apply pass
	// writes through it. Compute never uses it.
	FirmwareAdapter biosconfig.Adapter
	// VirtualPlatform is the VM rule's platform name when Virtual (the Surface
	// observation records which rule decided).
	VirtualPlatform string
	// Observation is this cycle's vendor observation, or nil. It goes into
	// details.vendorObservation and never into the state or fingerprint.
	Observation *biosconfig.Observation
	Memory      AdapterMemory
	Now         time.Time
	// Apply is the apply status from this cycle; nil when nothing was applied
	// or this OS has no writer.
	Apply *ApplyStatus
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
	// observation is Details["vendorObservation"], kept typed for uploadKey.
	observation *biosconfig.Observation
}

// normaliseVendor labels the snapshot's vendor. Dell and HP match the whole
// make (biosconfig.MakeOf), so HPE servers and other near-misses are "other",
// never hp or dell; any other make is its own lowercased name.
func normaliseVendor(manufacturer string) *string {
	m := strings.ToLower(strings.TrimSpace(manufacturer))
	if m == "" {
		return nil
	}
	v := biosconfig.MakeOf(m)
	if v == "" {
		v = m
	}
	if len(v) > 32 {
		v = strings.ToValidUTF8(v[:32], "")
	}
	return &v
}

func orAbsent(v string) string {
	if v == "" {
		return "absent"
	}
	return v
}

func orUnknown(v string) string {
	if v == "" {
		return "unknown"
	}
	return v
}

// Compute turns one set of readings into a Snapshot. First matching rule wins:
// virtual machine, no wired adapter, a wrong Windows, NIC or firmware setting
// (not_configured), every layer read and correct (ready), otherwise unproven.
// Ready needs a firmware adapter (Dell only in this release), Fast Startup
// known off, and one wired adapter with magic packet on and EEE known off or
// absent: the agent never claims what it did not read.
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
			mem[mac] = AdapterRecord{LastSeenAt: now, MagicPacket: orUnknown(a.MagicPacket), EEE: orUnknown(a.EEE),
				ShutdownWake: orAbsent(a.ShutdownWake)}
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
			"magicPacket": rec.MagicPacket, "eee": rec.EEE, "shutdownWake": orAbsent(rec.ShutdownWake),
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
	switch {
	case in.Observation != nil:
		// Observe stage: the vendor interface was read and reported, but
		// nothing it says is trusted for readiness yet.
		firmware = "observe_only"
	case in.Firmware != nil:
		firmware = in.Firmware.Status
	}
	var firmwareCurrent map[string]string

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
		ap := in.Apply
		pendingMAC := map[string]bool{}
		if ap != nil {
			for _, key := range ap.Pending {
				if mac := keyMAC(key); mac != "" {
					pendingMAC[mac] = true
				}
			}
		}
		// good: no adapter setting is known wrong and in effect. A good
		// adapter whose settings await a reboot is good after reboot. proven:
		// one adapter is known right on every reading, which ready requires.
		// While any wired adapter is present, only a present one can prove
		// ready; with none present (undocked) the remembered ones keep
		// readiness for 30 days.
		anyPresent := len(present) > 0
		good, goodAfterReboot, proven := false, false, false
		for _, mac := range macs {
			rec := mem[mac]
			if rec.MagicPacket == "enabled" && rec.EEE != "enabled" && rec.ShutdownWake != "disabled" {
				if pendingMAC[mac] {
					goodAfterReboot = true
					continue
				}
				good = true
				if (rec.EEE == "disabled" || rec.EEE == "absent") && (present[mac] || !anyPresent) {
					proven = true
				}
			}
		}
		if good && !proven {
			reasons["nic_eee_unknown"] = true
		}
		if !good && !goodAfterReboot {
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
				if rec.ShutdownWake == "disabled" {
					reasons["nic_shutdown_wake_disabled"] = true
					wrong = true
				}
			}
		}
		var verdict firmwareVerdict
		verdict, firmwareCurrent = evaluateFirmware(in.Firmware, reasons)
		if verdict == firmwareWrong {
			wrong = true
		}
		configuring := ap != nil && ap.Configure
		protected := ""
		if configuring && verdict == firmwareWrong {
			protected = ap.FirmwareProtected
		}
		if protected != "" {
			reasons[protected] = true
		}
		// A firmware value written but not yet in effect (Breeze never
		// reboots) holds a correct read at needs_reboot.
		firmwarePending := ap != nil && verdict == firmwareOK && hasFirmwarePending(ap.Pending)
		switch {
		case wrong && configuring && len(ap.Failed) > 0:
			snap.ReadinessState = StateApplyFailed
			reasons["apply_failed"] = true
			if len(ap.Blocked) > 0 {
				reasons["apply_blocked"] = true
			}
		case wrong && protected != "":
			snap.ReadinessState = StateFirmwareProtected
		case wrong:
			snap.ReadinessState = StateNotConfigured
			if configuring && len(ap.Deferred) > 0 {
				reasons["apply_deferred"] = true
			}
		case (!good && goodAfterReboot) || (firmwarePending && (good || goodAfterReboot)):
			snap.ReadinessState = StateNeedsReboot
			reasons["reboot_pending"] = true
		case verdict == firmwareOK && fast == "disabled" && proven:
			snap.ReadinessState = StateReady
		default:
			snap.ReadinessState = StateUnproven
			switch {
			case in.Observation != nil:
				reasons["vendor_observe_only"] = true
			case in.Firmware == nil:
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
	if in.Firmware != nil {
		// Only the target settings are reported, never the whole BIOS list.
		if firmwareCurrent != nil {
			snap.Details["firmwareSettings"] = firmwareCurrent
		}
		snap.Details["firmwareProtection"] = in.Firmware.Protection.String()
	}
	if in.Observation != nil {
		snap.Details["vendorObservation"] = in.Observation
		snap.observation = in.Observation
	}
	if ap := in.Apply; ap != nil {
		apply := map[string]any{
			"configure": ap.Configure, "pending": nonNil(ap.Pending), "failed": nonNil(ap.Failed),
			"blocked": nonNil(ap.Blocked), "deferred": nonNil(ap.Deferred),
		}
		if ap.Configure && ap.FirmwareProtected != "" {
			// Only when set, so snapshots without it are unchanged.
			apply["firmwareProtected"] = ap.FirmwareProtected
		}
		snap.Details["apply"] = apply
		if !ap.LastApplyAt.IsZero() {
			at := ap.LastApplyAt.UTC().Format(time.RFC3339)
			snap.LastApplyAt = &at
		}
		if ap.LastApplyResult != "" {
			r := ap.LastApplyResult
			snap.LastApplyResult = &r
		}
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
		// Shutdown wake is written only when it reads disabled, so every
		// machine whose readings are unchanged keeps its W02 fingerprint, and a
		// one-off read error cannot move it (the server resets its timeout
		// block on a fingerprint change).
		if mem[mac].ShutdownWake == "disabled" {
			w("s5:disabled")
		}
	}
	w(state)
	// Written only when set, so hosts with the cmdlets keep the fingerprint
	// their wake proofs were recorded against.
	if cmdletsUnavailable(in) {
		w("nic_cmdlets_unavailable")
	}
	// Also written only with a firmware adapter, so makes without one keep
	// their fingerprint. Covers the target settings only (name, current value,
	// whether the target is allowed); protection does not decide a wake.
	if fw := in.Firmware; fw != nil {
		w("firmware")
		w(fw.Vendor)
		w(fw.Status)
		byName := make(map[string]biosconfig.Setting, len(fw.Settings))
		for _, s := range fw.Settings {
			byName[s.Name] = s
		}
		for _, t := range firmwareTargets[fw.Vendor] {
			w(t.Name)
			if s, ok := byName[t.Name]; ok {
				w("=" + s.Value)
				if slices.Contains(s.Allowed, t.Value) {
					w("allowed")
				}
			} else {
				w("absent")
			}
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func nonNil(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}

func cmdletsUnavailable(in Inputs) bool {
	return in.Windows != nil && in.Windows.NetAdapterCmdletsUnavailable
}
