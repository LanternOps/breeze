package collectors

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCleanProductSKU(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "keeps an HP product number", in: "5S3F8EA#ABB", want: "5S3F8EA#ABB"},
		{name: "trims whitespace", in: "  5S3F8EA#ABB\r\n", want: "5S3F8EA#ABB"},
		{name: "keeps a Lenovo machine type", in: "LENOVO_MT_20S0_BU_Think_FM_ThinkPad T14", want: "LENOVO_MT_20S0_BU_Think_FM_ThinkPad T14"},
		{name: "keeps a Dell system id", in: "0A1D", want: "0A1D"},
		{name: "empty", in: "", want: ""},
		{name: "shared placeholder: OEM", in: "To Be Filled By O.E.M.", want: ""},
		{name: "shared placeholder: default string", in: "Default string", want: ""},
		{name: "shared placeholder: VM none", in: "None", want: ""},
		{name: "shared placeholder: not specified", in: "Not Specified", want: ""},
		{name: "SKU placeholder: SKU", in: "SKU", want: ""},
		{name: "SKU placeholder: mixed case and dots", in: "Sku.", want: ""},
		{name: "SKU placeholder: System SKU", in: "System SKU", want: ""},
		{name: "SKU placeholder: SystemSKUNumber", in: "SystemSKUNumber", want: ""},
		{name: "SKU placeholder: System SKU Number", in: "System SKU Number", want: ""},
		{name: "SKU placeholder: Type1Sku0", in: "Type1Sku0", want: ""},
		{name: "SKU placeholder: SKU Number", in: "SKU Number", want: ""},
		// A cut-off product number would misdirect a warranty or parts lookup,
		// so anything over the column width is dropped, not truncated.
		{name: "exactly 100 characters is kept", in: strings.Repeat("a", 100), want: strings.Repeat("a", 100)},
		{name: "over 100 characters is dropped", in: strings.Repeat("a", 101), want: ""},
		{name: "100 multibyte characters is kept", in: strings.Repeat("é", 100), want: strings.Repeat("é", 100)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanProductSKU(tt.in); got != tt.want {
				t.Fatalf("cleanProductSKU(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestParseHardwareJSONReadsSKUFields(t *testing.T) {
	got, err := parseHardwareJSON([]byte(`{"SysSKU":"5S3F8EA#ABB","ProductSKU":"FALLBACK"}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.SysSKU != "5S3F8EA#ABB" || got.ProductSKU != "FALLBACK" {
		t.Fatalf("got SysSKU=%q ProductSKU=%q", got.SysSKU, got.ProductSKU)
	}
}

func TestWindowsProductSKU(t *testing.T) {
	tests := []struct {
		name string
		in   windowsHardwareJSON
		want string
	}{
		{name: "prefers Win32_ComputerSystem", in: windowsHardwareJSON{SysSKU: "5S3F8EA#ABB", ProductSKU: "OTHER"}, want: "5S3F8EA#ABB"},
		{name: "falls back when empty", in: windowsHardwareJSON{ProductSKU: "5S3F8EA#ABB"}, want: "5S3F8EA#ABB"},
		{name: "falls back past a placeholder", in: windowsHardwareJSON{SysSKU: "Default string", ProductSKU: "5S3F8EA#ABB"}, want: "5S3F8EA#ABB"},
		{name: "reports neither", in: windowsHardwareJSON{}, want: ""},
		{name: "drops all placeholders", in: windowsHardwareJSON{SysSKU: "SKU", ProductSKU: "To be filled by O.E.M."}, want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := windowsProductSKU(tt.in); got != tt.want {
				t.Fatalf("windowsProductSKU = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHardwareStateFromCarriesProductSKU(t *testing.T) {
	state := hardwareStateFrom(&HardwareInfo{SerialNumber: "SN-1", ProductSKU: "5S3F8EA#ABB"})
	if state.ProductSKU != "5S3F8EA#ABB" {
		t.Fatalf("ProductSKU = %q", state.ProductSKU)
	}
	if state.SerialNumber != "SN-1" {
		t.Fatalf("SerialNumber = %q", state.SerialNumber)
	}
}

// A snapshot written by an agent older than this field must load with an empty
// SKU: that is what the "first value after upgrade" exemption keys on.
func TestHardwareStateOldSnapshotLoadsEmptySKU(t *testing.T) {
	var state HardwareState
	if err := json.Unmarshal([]byte(`{"serialNumber":"SN-1","motherboard":"Acme"}`), &state); err != nil {
		t.Fatal(err)
	}
	if state.ProductSKU != "" {
		t.Fatalf("ProductSKU = %q", state.ProductSKU)
	}
}

func TestDiffHardwareProductSKU(t *testing.T) {
	tests := []struct {
		name       string
		prev, cur  string
		wantEvents int
	}{
		{name: "unchanged", prev: "5S3F8EA#ABB", cur: "5S3F8EA#ABB", wantEvents: 0},
		{name: "changed emits", prev: "5S3F8EA#ABB", cur: "9X9X9XX#ABB", wantEvents: 1},
		// The snapshot written by an agent older than this field has no SKU.
		// Without this exemption every device reports a false hardware change
		// on its first cycle after upgrading.
		{name: "first value after upgrade is not a change", prev: "", cur: "5S3F8EA#ABB", wantEvents: 0},
		// A failed WMI batch leaves every identity field empty for one cycle.
		{name: "collection gap is not a change", prev: "5S3F8EA#ABB", cur: "", wantEvents: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewChangeTrackerCollector(t.TempDir() + "/snapshot.json")
			c.lastSnapshot = &Snapshot{Hardware: &HardwareState{ProductSKU: tt.prev}}
			changes := c.diffHardware(&Snapshot{Hardware: &HardwareState{ProductSKU: tt.cur}})
			if len(changes) != tt.wantEvents {
				t.Fatalf("got %d events (%+v), want %d", len(changes), changes, tt.wantEvents)
			}
			if tt.wantEvents == 1 && changes[0].Subject != "Product Number" {
				t.Fatalf("subject = %q", changes[0].Subject)
			}
		})
	}
}
