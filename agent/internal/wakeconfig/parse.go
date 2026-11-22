package wakeconfig

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"
)

// rawReadings is the JSON the Windows collector's PowerShell emits. Adapters
// are decided only by magicPacket (the WakeOnMagicPacket enum) and eee (the raw
// RegistryValue of the *EEE keyword). The script emits no localised text.
type rawReadings struct {
	Hiberboot any `json:"hiberboot"`
	// NetAdapter is false when the NetAdapter cmdlets are missing. Absent is
	// read as available.
	NetAdapter *bool        `json:"netAdapter"`
	Adapters   []rawAdapter `json:"adapters"`
}

type rawAdapter struct {
	Name        string  `json:"name"`
	MAC         string  `json:"mac"`
	MagicPacket *string `json:"magicPacket"`
	EEE         *string `json:"eee"`
	// S5 is the raw RegistryValue of Realtek's S5WakeOnLan keyword; null or
	// missing means the driver has no such keyword.
	S5 *string `json:"s5"`
}

// ParseWindowsReadings turns the collector's JSON into readings. It is pure and
// platform independent. Any value it does not recognise maps to "unknown"; an
// adapter without a parseable MAC cannot be tracked and is skipped.
func ParseWindowsReadings(raw []byte) (*WindowsReadings, error) {
	var r rawReadings
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("parse wake readings: %w", err)
	}
	out := &WindowsReadings{FastStartup: "unknown"}
	if r.NetAdapter != nil && !*r.NetAdapter {
		out.NetAdapterCmdletsUnavailable = true
	}
	// HiberbootEnabled: 1 -> enabled, 0 -> disabled, anything else unknown.
	switch v := r.Hiberboot.(type) {
	case float64:
		switch v {
		case 1:
			out.FastStartup = "enabled"
		case 0:
			out.FastStartup = "disabled"
		}
	case string:
		switch strings.TrimSpace(v) {
		case "1":
			out.FastStartup = "enabled"
		case "0":
			out.FastStartup = "disabled"
		}
	}
	for _, a := range r.Adapters {
		mac, ok := normaliseMAC(a.MAC)
		if !ok {
			out.SkippedAdapters++
			continue
		}
		reading := AdapterReading{MAC: mac, MagicPacket: "unknown", EEE: "unknown"}
		if a.MagicPacket != nil {
			switch strings.ToLower(strings.TrimSpace(*a.MagicPacket)) {
			case "enabled":
				reading.MagicPacket = "enabled"
			case "disabled":
				reading.MagicPacket = "disabled"
			case "unsupported":
				reading.MagicPacket = "unsupported"
			}
		}
		if a.EEE == nil {
			reading.EEE = "absent" // keyword not present on this driver
		} else {
			switch strings.TrimSpace(*a.EEE) {
			case "1":
				reading.EEE = "enabled"
			case "0":
				reading.EEE = "disabled"
			}
		}
		reading.ShutdownWake = "absent"
		if a.S5 != nil {
			switch strings.TrimSpace(*a.S5) {
			case "1":
				reading.ShutdownWake = "enabled"
			case "0":
				reading.ShutdownWake = "disabled"
			default:
				reading.ShutdownWake = "unknown"
			}
		}
		out.Adapters = append(out.Adapters, reading)
	}
	if out.SkippedAdapters > 0 {
		log.Warn("wired adapters skipped: MAC unparseable", "count", out.SkippedAdapters)
	}
	return out, nil
}

// normaliseMAC accepts aa-bb-..., aa:bb:... and returns lowercase colon form.
func normaliseMAC(s string) (string, bool) {
	hw, err := net.ParseMAC(strings.TrimSpace(s))
	if err != nil || len(hw) != 6 {
		return "", false
	}
	return strings.ToLower(hw.String()), true
}
