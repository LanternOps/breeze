package collectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Fixture provenance (testdata/spmemory/):
//   - apple_silicon_m_series.json — REAL, unedited capture of
//     `system_profiler SPMemoryDataType -json` on a Mac17,6 (Apple Silicon,
//     128 GB LPDDR5 on-package), 2026-09-26.
//   - intel_imac_2of4.json — SYNTHETIC, modelled on the Intel-Mac shape: one
//     "memory" entry whose _items list every slot, empty slots reported as
//     "empty", JEDEC-hex manufacturer codes and hex-ASCII part numbers.
func readSPFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "spmemory", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseSPMemoryJSONAppleSilicon(t *testing.T) {
	info, err := parseSPMemoryJSON(readSPFixture(t, "apple_silicon_m_series.json"))
	if err != nil {
		t.Fatalf("parseSPMemoryJSON: %v", err)
	}
	got, _ := json.Marshal(info)
	want := `{"soldered":true,"modules":[{"slotKey":"macos:on-package","locator":"On-package","populated":true,"capacityMb":131072,"memoryType":"LPDDR5","manufacturer":"Samsung"}]}`
	if string(got) != want {
		t.Fatalf("wire JSON mismatch\n got  %s\n want %s", got, want)
	}
}

func TestParseSPMemoryJSONIntelSlots(t *testing.T) {
	info, err := parseSPMemoryJSON(readSPFixture(t, "intel_imac_2of4.json"))
	if err != nil {
		t.Fatalf("parseSPMemoryJSON: %v", err)
	}
	got, _ := json.Marshal(info)
	want := `{"slotsTotal":4,"soldered":false,"modules":[` +
		`{"slotKey":"macos:BANK 0/ChannelA-DIMM0","locator":"ChannelA-DIMM0","bankLabel":"BANK 0","populated":true,"capacityMb":8192,"memoryType":"DDR4","speedMts":2667,"manufacturer":"SK Hynix","partNumber":"HMA81GS6AFR8C-VK","serialNumber":"0x12AB34CD"},` +
		`{"slotKey":"macos:BANK 0/ChannelA-DIMM1","locator":"ChannelA-DIMM1","bankLabel":"BANK 0","populated":false},` +
		`{"slotKey":"macos:BANK 1/ChannelB-DIMM0","locator":"ChannelB-DIMM0","bankLabel":"BANK 1","populated":true,"capacityMb":16384,"memoryType":"DDR4","speedMts":2667,"manufacturer":"Micron","partNumber":"16ATF20646HZ-2G3E1"},` +
		`{"slotKey":"macos:BANK 1/ChannelB-DIMM1","locator":"ChannelB-DIMM1","bankLabel":"BANK 1","populated":false}]}`
	if string(got) != want {
		t.Fatalf("wire JSON mismatch\n got  %s\n want %s", got, want)
	}
}

func TestParseSPMemoryJSONEdgeCases(t *testing.T) {
	errCases := map[string]string{
		"not json":            `{`,
		"no entries":          `{"SPMemoryDataType":[]}`,
		"missing key":         `{}`,
		"entry with nothing":  `{"SPMemoryDataType":[{"_name":"memory"}]}`,
		"empty items":         `{"SPMemoryDataType":[{"_name":"memory","_items":[]}]}`,
		"duplicate slot name": `{"SPMemoryDataType":[{"_items":[{"_name":"DIMM0","dimm_size":"8 GB"},{"_name":"DIMM0","dimm_size":"8 GB"}]}]}`,
	}
	for name, in := range errCases {
		if info, err := parseSPMemoryJSON([]byte(in)); err == nil {
			t.Errorf("%s: expected error, got %+v", name, info)
		}
	}

	// An "empty" slot never reports module fields even if some are filled in.
	stale, err := parseSPMemoryJSON([]byte(`{"SPMemoryDataType":[{"_items":[{"_name":"DIMM0","dimm_status":"empty","dimm_size":"empty","dimm_type":"DDR4","dimm_speed":"2667 MHz","dimm_manufacturer":"Micron"}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if m := stale.Modules[0]; m.Populated || m.MemoryType != nil || m.SpeedMts != nil || m.Manufacturer != nil {
		t.Fatalf("empty slot carries module fields: %+v", m)
	}

	// Nameless slots get positional keys and "Slot n" locators.
	info, err := parseSPMemoryJSON([]byte(`{"SPMemoryDataType":[{"_items":[{"dimm_size":"4 GB","dimm_status":"ok"},{"_name":"","dimm_size":"empty","dimm_status":"empty"}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if info.Modules[0].SlotKey != "macos:slot1" || info.Modules[0].Locator != "Slot 1" ||
		info.Modules[1].SlotKey != "macos:slot2" || info.Modules[1].Locator != "Slot 2" || info.Modules[1].Populated {
		t.Fatalf("nameless slots = %+v", info.Modules)
	}
}

func TestParseMacSize(t *testing.T) {
	for in, want := range map[string]int{"8 GB": 8192, "128 GB": 131072, "512 MB": 512, "1 TB": 1048576, "1.5 GB": 1536} {
		got := parseMacSizeMB(in)
		if got == nil || *got != want {
			t.Errorf("parseMacSizeMB(%q) = %v, want %d", in, got, want)
		}
	}
	for _, in := range []string{"", "empty", "GB", "lots"} {
		if got := parseMacSizeMB(in); got != nil {
			t.Errorf("parseMacSizeMB(%q) = %d, want nil", in, *got)
		}
	}
}

func TestDecodeMacHexString(t *testing.T) {
	cases := map[string]string{
		"0x484D41383147533641465238432D564B2020": "HMA81GS6AFR8C-VK  ",
		"CT8G4SFS824A.C8FE":                      "CT8G4SFS824A.C8FE", // not hex-prefixed
		"0x12AB34CD":                             "0x12AB34CD",        // decodes to non-printable → keep raw
		"0xZZ":                                   "0xZZ",
		"0x80AD":                                 "SK Hynix",
		"0x802C":                                 "Micron",
		"0x80CE":                                 "Samsung",
	}
	for in, want := range cases {
		if got := decodeMacMemoryString(in); got != want {
			t.Errorf("decodeMacMemoryString(%q) = %q, want %q", in, got, want)
		}
	}
}
