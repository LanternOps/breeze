package collectors

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/collectors/smbios"
)

func TestNormalizeMemoryString(t *testing.T) {
	tests := []struct {
		name       string
		in         string
		identifier bool
		max        int
		want       string // "" = nil
	}{
		{"plain", "Samsung", true, 128, "Samsung"},
		{"trim spaces", "  M378A2K43DB1-CTD    ", true, 128, "M378A2K43DB1-CTD"},
		{"trim NULs and tabs", "\x00Kingston\t\x00", true, 128, "Kingston"},
		{"embedded NUL removed", "Sam\x00sung", true, 128, "Samsung"},
		{"control chars removed", "Mic\x01ron\x7f", true, 128, "Micron"},
		{"invalid utf8 dropped", "Hynix\xff\xfe", true, 128, "Hynix"},
		{"empty", "", true, 128, ""},
		{"whitespace only", "   \x00 ", true, 128, ""},
		{"Unknown", "Unknown", true, 128, ""},
		{"unknown lower", " unknown ", true, 128, ""},
		{"Not Specified", "Not Specified", true, 128, ""},
		{"None", "None", true, 128, ""},
		{"OEM filler", "To Be Filled By O.E.M.", true, 128, ""},
		{"NO DIMM", "NO DIMM", true, 128, ""},
		{"Empty", "Empty", true, 128, ""},
		{"empty lower", "empty", true, 128, ""},
		{"SerNum filler", "SerNum0", true, 128, ""},
		{"SerNum filler spaced", "SerNum 3", true, 128, ""},
		{"PartNum filler", "PartNum1", true, 128, ""},
		{"Manufacturer filler", "Manufacturer00", true, 128, ""},
		{"bare Manufacturer filler", "Manufacturer", true, 128, ""},
		{"all zero serial", "00000000", true, 128, ""},
		{"all zero hex serial", "0x00000000", true, 128, ""},
		{"all F serial", "FFFFFFFF", true, 128, ""},
		{"all f lower", "ffff", true, 128, ""},
		{"zero rule not applied to locators", "0", false, 128, "0"},
		{"real serial with zeros", "00A1B2C3", true, 128, "00A1B2C3"},
		{"manufacturer containing Unknown kept", "Unknown Corp Ltd", true, 128, "Unknown Corp Ltd"},
		{"truncated to limit", strings.Repeat("a", 200), true, 128, strings.Repeat("a", 128)},
		{"truncation counts UTF-16 units", strings.Repeat("😀", 20), true, 32, strings.Repeat("😀", 16)},
		{"truncation retrims", "abc   def", false, 5, "abc"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeMemoryString(tc.in, tc.max, tc.identifier)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("got %q, want nil", *got)
				}
				return
			}
			if got == nil || *got != tc.want {
				t.Fatalf("got %v, want %q", derefStr(got), tc.want)
			}
		})
	}
}

func derefStr(p *string) any {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func readSMBIOSFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("smbios", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The full wire shape for the desktop fixture: empty slots keep slot-level
// facts (locator, bank) but carry no module identity, OEM fillers become
// absent keys, and trailing part-number padding is trimmed.
func TestMemoryInfoFromSMBIOSTableWireJSON(t *testing.T) {
	info, err := memoryInfoFromSMBIOSTable(readSMBIOSFixture(t, "desktop_ddr4_2of4.bin"))
	if err != nil {
		t.Fatalf("memoryInfoFromSMBIOSTable: %v", err)
	}
	got, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"slotsTotal":4,"maxCapacityMb":131072,"soldered":false,"modules":[` +
		`{"slotKey":"smbios:0x1100","locator":"DIMM_A1","bankLabel":"BANK 0","populated":false},` +
		`{"slotKey":"smbios:0x1101","locator":"DIMM_A2","bankLabel":"BANK 1","populated":true,"capacityMb":16384,"memoryType":"DDR4","formFactor":"DIMM","speedMts":3200,"configuredSpeedMts":2933,"manufacturer":"Samsung","partNumber":"M378A2K43DB1-CTD","serialNumber":"12345678"},` +
		`{"slotKey":"smbios:0x1102","locator":"DIMM_B1","bankLabel":"BANK 2","populated":false},` +
		`{"slotKey":"smbios:0x1103","locator":"DIMM_B2","bankLabel":"BANK 3","populated":true,"capacityMb":16384,"memoryType":"DDR4","formFactor":"DIMM","speedMts":3200,"configuredSpeedMts":2933,"manufacturer":"Samsung","partNumber":"M378A2K43DB1-CTD","serialNumber":"87654321"}]}`
	if string(got) != want {
		t.Fatalf("wire JSON mismatch\n got  %s\n want %s", got, want)
	}
}

func TestMemoryInfoFromSMBIOSTableServerAndFillers(t *testing.T) {
	info, err := memoryInfoFromSMBIOSTable(readSMBIOSFixture(t, "server_2socket.bin"))
	if err != nil {
		t.Fatalf("memoryInfoFromSMBIOSTable: %v", err)
	}
	if *info.SlotsTotal != 6 || *info.MaxCapacityMb != 2*1024*1024 || info.Soldered {
		t.Fatalf("summary = %+v", info)
	}
	keys := map[string]bool{}
	for _, m := range info.Modules {
		if keys[m.SlotKey] {
			t.Fatalf("duplicate slotKey %s", m.SlotKey)
		}
		keys[m.SlotKey] = true
	}
	// Duplicate locators across the two sockets are kept; slotKey disambiguates.
	if info.Modules[0].Locator != "A1" || info.Modules[3].Locator != "A1" {
		t.Fatalf("locators = %q, %q", info.Modules[0].Locator, info.Modules[3].Locator)
	}
	// Empty server slots still describe the slot's type/form factor.
	empty := info.Modules[2]
	if empty.Populated || empty.CapacityMb != nil || empty.Manufacturer != nil || empty.SerialNumber != nil || empty.PartNumber != nil || empty.SpeedMts != nil {
		t.Fatalf("empty slot carries module identity: %+v", empty)
	}
	if empty.MemoryType == nil || *empty.MemoryType != "DDR4" || empty.FormFactor == nil || *empty.FormFactor != "DIMM" {
		t.Fatalf("empty slot lost slot type: %+v", empty)
	}

	laptop, err := memoryInfoFromSMBIOSTable(readSMBIOSFixture(t, "laptop_sodimm_ddr5.bin"))
	if err != nil {
		t.Fatal(err)
	}
	filler := laptop.Modules[1]
	if filler.Manufacturer != nil || filler.SerialNumber != nil || filler.PartNumber != nil {
		t.Fatalf("OEM fillers not nulled: %+v", filler)
	}
	if !filler.Populated || filler.CapacityMb == nil || *filler.CapacityMb != 16384 {
		t.Fatalf("filler module lost capacity: %+v", filler)
	}

	speed, err := memoryInfoFromSMBIOSTable(readSMBIOSFixture(t, "extended_speed.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if speed.Modules[0].SerialNumber != nil || speed.Modules[1].SerialNumber != nil {
		t.Fatalf("all-zero / all-F serials not nulled")
	}
	if *speed.Modules[0].SpeedMts != 8000 || *speed.Modules[0].ConfiguredSpeedMts != 7200 {
		t.Fatalf("extended speed = %+v", speed.Modules[0])
	}
}

func TestMemoryInfoFromSMBIOSTableErrors(t *testing.T) {
	for _, name := range []string{"malformed_length_past_end.bin", "malformed_missing_string_term.bin", "malformed_dangling_array_handle.bin"} {
		info, err := memoryInfoFromSMBIOSTable(readSMBIOSFixture(t, name))
		if err == nil || info != nil {
			t.Errorf("%s: want error and nil info, got %+v, %v", name, info, err)
		}
	}
}

func TestMemoryInfoFromInventoryPlaceholderLocator(t *testing.T) {
	mb := uint64(8192)
	inv := &smbios.MemoryInventory{SlotsTotal: 3, Devices: []smbios.MemoryDevice{
		{Handle: 0x20, Populated: true, SizeMB: &mb, Locator: "Not Specified"},
		{Handle: 0x21, Locator: "   "},
		{Handle: 0x22, Locator: "DIMM 3"},
	}}
	info, err := memoryInfoFromInventory(inv)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"Slot 1", "Slot 2", "DIMM 3"} {
		if info.Modules[i].Locator != want {
			t.Errorf("module %d locator = %q, want %q", i, info.Modules[i].Locator, want)
		}
	}
	if info.MaxCapacityMb != nil {
		t.Errorf("MaxCapacityMb = %d, want nil", *info.MaxCapacityMb)
	}
}

// Some firmware leaves stale module data on an empty slot's type 17; an
// unpopulated slot must never report capacity, speed or module identity.
func TestMemoryInfoFromInventoryEmptySlotDropsStaleModuleData(t *testing.T) {
	mb := uint64(8192)
	speed := uint32(3200)
	inv := &smbios.MemoryInventory{SlotsTotal: 1, Devices: []smbios.MemoryDevice{{
		Handle: 0x20, Populated: false, SizeMB: &mb, SpeedMTs: &speed, ConfiguredSpeedMTs: &speed,
		Locator: "DIMM0", MemoryType: "DDR4", FormFactor: "DIMM",
		Manufacturer: "Samsung", PartNumber: "M378A1K43CB2-CTD", SerialNumber: "1234ABCD",
	}}}
	info, err := memoryInfoFromInventory(inv)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(info.Modules[0])
	want := `{"slotKey":"smbios:0x0020","locator":"DIMM0","populated":false,"memoryType":"DDR4","formFactor":"DIMM"}`
	if string(got) != want {
		t.Fatalf("empty slot\n got  %s\n want %s", got, want)
	}
}

// Values that cannot fit the API's int4 columns become "not reported" rather
// than making the API reject the whole memory block.
func TestMemoryInfoFromInventoryDropsOutOfRangeIntegers(t *testing.T) {
	huge := uint64(1 << 40)
	speed := uint32(1 << 31)
	inv := &smbios.MemoryInventory{SlotsTotal: 1, MaxCapacityMB: &huge, Devices: []smbios.MemoryDevice{
		{Handle: 0x20, Populated: true, SizeMB: &huge, Locator: "A", SpeedMTs: &speed},
	}}
	info, err := memoryInfoFromInventory(inv)
	if err != nil {
		t.Fatal(err)
	}
	if info.MaxCapacityMb != nil || info.Modules[0].CapacityMb != nil || info.Modules[0].SpeedMts != nil {
		t.Fatalf("out-of-range values kept: %+v %+v", info, info.Modules[0])
	}
}

func TestValidateMemoryInfo(t *testing.T) {
	mod := func(key, loc string) MemoryModule { return MemoryModule{SlotKey: key, Locator: loc} }
	many := make([]MemoryModule, 257)
	for i := range many {
		many[i] = mod("k"+strings.Repeat("x", i%3)+string(rune('a'+i%26))+strings.Repeat("y", i/26), "L")
	}
	cases := map[string]*MemoryInfo{
		"nil":                   nil,
		"no modules":            {Modules: nil},
		"more than 256 modules": {Modules: many},
		"duplicate slotKey":     {Modules: []MemoryModule{mod("a", "A"), mod("a", "B")}},
		"empty slotKey":         {Modules: []MemoryModule{mod("", "A")}},
		"slotKey over 160":      {Modules: []MemoryModule{mod(strings.Repeat("k", 161), "A")}},
		"empty locator":         {Modules: []MemoryModule{mod("a", "")}},
		"locator over 128":      {Modules: []MemoryModule{mod("a", strings.Repeat("l", 129))}},
		"slotsTotal over 256":   {SlotsTotal: intPtr(257), Modules: []MemoryModule{mod("a", "A")}},
	}
	for name, info := range cases {
		if err := validateMemoryInfo(info); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if err := validateMemoryInfo(&MemoryInfo{SlotsTotal: intPtr(1), Modules: []MemoryModule{mod("a", "A")}}); err != nil {
		t.Errorf("valid info rejected: %v", err)
	}
}

func TestParseRawSMBIOSData(t *testing.T) {
	table := readSMBIOSFixture(t, "vm_hyperv.bin")
	mk := func(length uint32, body []byte) []byte {
		hdr := []byte{0, 3, 4, 0, 0, 0, 0, 0}
		binary.LittleEndian.PutUint32(hdr[4:], length)
		return append(hdr, body...)
	}
	good := mk(uint32(len(table)), table)

	got, major, minor, err := parseRawSMBIOSData(good, uint32(len(good)))
	if err != nil || major != 3 || minor != 4 || string(got) != string(table) {
		t.Fatalf("good buffer: err=%v version=%d.%d len=%d", err, major, minor, len(got))
	}
	// Returned size larger than the buffer (API contract violation).
	if _, _, _, err := parseRawSMBIOSData(good, uint32(len(good)+1)); err == nil {
		t.Error("returned size past buffer accepted")
	}
	// Shorter than the 8-byte header.
	if _, _, _, err := parseRawSMBIOSData(good[:6], 6); err == nil {
		t.Error("short header accepted")
	}
	// Header Length claims more table than was returned.
	if _, _, _, err := parseRawSMBIOSData(good, uint32(len(good)-1)); err == nil {
		t.Error("header Length past returned size accepted")
	}
	// Zero-length table.
	if _, _, _, err := parseRawSMBIOSData(mk(0, nil), 8); err == nil {
		t.Error("empty table accepted")
	}
	// Oversized table.
	if _, _, _, err := parseRawSMBIOSData(mk(smbios.MaxTableSize+1, nil), 8); err == nil {
		t.Error("oversized Length accepted")
	}
}

func TestReadSMBIOSTableFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "DMI")
	table := readSMBIOSFixture(t, "desktop_ddr4_2of4.bin")
	if err := os.WriteFile(path, table, 0o400); err != nil {
		t.Fatal(err)
	}
	got, err := readSMBIOSTableFile(path)
	if err != nil || string(got) != string(table) {
		t.Fatalf("read: err=%v len=%d", err, len(got))
	}
	if _, err := readSMBIOSTableFile(filepath.Join(dir, "missing")); err == nil {
		t.Error("missing file accepted")
	}
	empty := filepath.Join(dir, "empty")
	_ = os.WriteFile(empty, nil, 0o400)
	if _, err := readSMBIOSTableFile(empty); err == nil {
		t.Error("empty file accepted")
	}
	big := filepath.Join(dir, "big")
	_ = os.WriteFile(big, make([]byte, smbios.MaxTableSize+1), 0o400)
	if _, err := readSMBIOSTableFile(big); err == nil {
		t.Error("oversized file accepted")
	}
}
