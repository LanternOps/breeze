package smbios

import (
	"encoding/binary"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func u64(v uint64) *uint64 { return &v }
func u32(v uint32) *uint32 { return &v }

// dev is a compact expectation for one MemoryDevice.
type dev struct {
	handle, array uint16
	populated     bool
	sizeMB        *uint64
	formFactor    string
	memType       string
	locator, bank string
	manufacturer  string
	serial, part  string
	speed, conf   *uint32
}

func (d dev) toDevice() MemoryDevice {
	return MemoryDevice{
		Handle: d.handle, ArrayHandle: d.array, Populated: d.populated, SizeMB: d.sizeMB,
		FormFactor: d.formFactor, MemoryType: d.memType, Locator: d.locator, BankLocator: d.bank,
		Manufacturer: d.manufacturer, SerialNumber: d.serial, PartNumber: d.part,
		SpeedMTs: d.speed, ConfiguredSpeedMTs: d.conf,
	}
}

func TestParseMemoryFixtures(t *testing.T) {
	tests := []struct {
		name       string
		fixture    string
		slotsTotal int
		maxCapMB   *uint64
		devices    []dev
	}{
		{
			name: "DDR4 desktop, 2 of 4 slots filled", fixture: "desktop_ddr4_2of4.bin",
			slotsTotal: 4, maxCapMB: u64(128 * 1024),
			devices: []dev{
				{handle: 0x1100, array: 0x1000, formFactor: "", memType: "", locator: "DIMM_A1", bank: "BANK 0", manufacturer: "NO DIMM", serial: "NO DIMM", part: "NO DIMM"},
				{handle: 0x1101, array: 0x1000, populated: true, sizeMB: u64(16384), formFactor: "DIMM", memType: "DDR4", locator: "DIMM_A2", bank: "BANK 1", manufacturer: "Samsung", serial: "12345678", part: "M378A2K43DB1-CTD    ", speed: u32(3200), conf: u32(2933)},
				{handle: 0x1102, array: 0x1000, formFactor: "", memType: "", locator: "DIMM_B1", bank: "BANK 2", manufacturer: "NO DIMM", serial: "NO DIMM", part: "NO DIMM"},
				{handle: 0x1103, array: 0x1000, populated: true, sizeMB: u64(16384), formFactor: "DIMM", memType: "DDR4", locator: "DIMM_B2", bank: "BANK 3", manufacturer: "Samsung", serial: "87654321", part: "M378A2K43DB1-CTD    ", speed: u32(3200), conf: u32(2933)},
			},
		},
		{
			name: "DDR5 SODIMM laptop", fixture: "laptop_sodimm_ddr5.bin",
			slotsTotal: 2, maxCapMB: u64(64 * 1024),
			devices: []dev{
				{handle: 0x0041, array: 0x0040, populated: true, sizeMB: u64(16384), formFactor: "SODIMM", memType: "DDR5", locator: "Controller0-ChannelA-DIMM0", bank: "BANK 0", manufacturer: "Micron Technology", serial: "E5A1B2C3", part: "CT16G56C46S5.M8G1   ", speed: u32(5600), conf: u32(5600)},
				{handle: 0x0042, array: 0x0040, populated: true, sizeMB: u64(16384), formFactor: "SODIMM", memType: "DDR5", locator: "Controller1-ChannelA-DIMM0", bank: "BANK 0", manufacturer: "Manufacturer1", serial: "SerNum1", part: "PartNum1", speed: u32(5600), conf: u32(5600)},
			},
		},
		{
			name: "2-socket server, two arrays, duplicate locators, extended size + extended max capacity", fixture: "server_2socket.bin",
			slotsTotal: 6, maxCapMB: u64(2 * 1024 * 1024),
			devices: []dev{
				{handle: 0x1100, array: 0x1000, populated: true, sizeMB: u64(65536), formFactor: "DIMM", memType: "DDR4", locator: "A1", bank: "NODE 0", manufacturer: "Hynix Semiconductor", serial: "3A1B2C3D", part: "HMA84GR7CJR4N-WM", speed: u32(2933), conf: u32(2666)},
				{handle: 0x1101, array: 0x1000, populated: true, sizeMB: u64(32768), formFactor: "DIMM", memType: "DDR4", locator: "A2", bank: "NODE 0", manufacturer: "Hynix Semiconductor", serial: "3A1B2C3E", part: "HMA84GR7CJR4N-WM", speed: u32(2933), conf: u32(2666)},
				{handle: 0x1102, array: 0x1000, formFactor: "DIMM", memType: "DDR4", locator: "A3", bank: "NODE 0", manufacturer: "Not Specified", serial: "Not Specified", part: "Not Specified"},
				{handle: 0x1103, array: 0x1001, populated: true, sizeMB: u64(16384), formFactor: "DIMM", memType: "DDR4", locator: "A1", bank: "NODE 1", manufacturer: "Hynix Semiconductor", serial: "4B1B2C3D", part: "HMA84GR7CJR4N-WM", speed: u32(2933), conf: u32(2666)},
				{handle: 0x1104, array: 0x1001, formFactor: "DIMM", memType: "DDR4", locator: "A2", bank: "NODE 1", manufacturer: "Not Specified", serial: "Not Specified", part: "Not Specified"},
				{handle: 0x1105, array: 0x1001, formFactor: "DIMM", memType: "DDR4", locator: "A3", bank: "NODE 1", manufacturer: "Not Specified", serial: "Not Specified", part: "Not Specified"},
			},
		},
		{
			name: "non-system array excluded from modules and totals", fixture: "nonsystem_array.bin",
			slotsTotal: 2, maxCapMB: u64(32 * 1024),
			devices: []dev{
				{handle: 0x0011, array: 0x0010, populated: true, sizeMB: u64(8192), formFactor: "SODIMM", memType: "DDR4", locator: "ChannelA-DIMM0", bank: "BANK 0", manufacturer: "Kingston", serial: "0A1B2C3D", part: "KF426S15IB/8", speed: u32(2666), conf: u32(2666)},
				{handle: 0x0012, array: 0x0010, formFactor: "SODIMM", memType: "DDR4", locator: "ChannelB-DIMM0", bank: "BANK 2"},
			},
		},
		{
			name: "extended speed (0xFFFF) with and without room for the extended fields", fixture: "extended_speed.bin",
			slotsTotal: 2, maxCapMB: u64(256 * 1024),
			devices: []dev{
				{handle: 0x0051, array: 0x0050, populated: true, sizeMB: u64(24576), formFactor: "DIMM", memType: "DDR5", locator: "DIMM1", bank: "P0 CHANNEL A", manufacturer: "G Skill Intl", serial: "00000000", part: "F5-8000J3848H24G", speed: u32(8000), conf: u32(7200)},
				{handle: 0x0052, array: 0x0050, populated: true, sizeMB: u64(24576), formFactor: "DIMM", memType: "DDR5", locator: "DIMM2", bank: "P0 CHANNEL B", manufacturer: "G Skill Intl", serial: "FFFFFFFF", part: "F5-8000J3848H24G"},
			},
		},
		{
			name: "KiB granularity and unknown size", fixture: "kib_size.bin",
			slotsTotal: 3, maxCapMB: u64(64),
			devices: []dev{
				{handle: 0x0061, array: 0x0060, populated: true, sizeMB: u64(8), formFactor: "Chip", memType: "SDRAM", locator: "U1"},
				{handle: 0x0062, array: 0x0060, populated: true, formFactor: "Chip", memType: "SDRAM", locator: "U2"},
				{handle: 0x0063, array: 0x0060, populated: true, formFactor: "Chip", memType: "SDRAM", locator: "U3"},
			},
		},
		{
			name: "SMBIOS 2.1 short type 17 (length 0x15) and type 16 without extended capacity", fixture: "short_type17.bin",
			slotsTotal: 2, maxCapMB: u64(512),
			devices: []dev{
				{handle: 0x0071, array: 0x0070, populated: true, sizeMB: u64(256), formFactor: "DIMM", memType: "SDRAM", locator: "DIMM0", bank: "BANK0"},
				{handle: 0x0072, array: 0x0070, formFactor: "DIMM", memType: "SDRAM", locator: "DIMM1", bank: "BANK1"},
			},
		},
		{
			name: "Hyper-V guest", fixture: "vm_hyperv.bin",
			slotsTotal: 1, maxCapMB: u64(1024 * 1024),
			devices: []dev{
				{handle: 0x0009, array: 0x0008, populated: true, sizeMB: u64(4096), formFactor: "", memType: "Other", locator: "M0001", bank: "M0001", manufacturer: "Microsoft Corporation", serial: "None", part: "None"},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			inv, err := ParseMemory(readFixture(t, tc.fixture))
			if err != nil {
				t.Fatalf("ParseMemory: %v", err)
			}
			if inv.SlotsTotal != tc.slotsTotal {
				t.Errorf("SlotsTotal = %d, want %d", inv.SlotsTotal, tc.slotsTotal)
			}
			if !reflect.DeepEqual(inv.MaxCapacityMB, tc.maxCapMB) {
				t.Errorf("MaxCapacityMB = %v, want %v", deref(inv.MaxCapacityMB), deref(tc.maxCapMB))
			}
			if len(inv.Devices) != len(tc.devices) {
				t.Fatalf("got %d devices, want %d: %+v", len(inv.Devices), len(tc.devices), inv.Devices)
			}
			for i, want := range tc.devices {
				if got := inv.Devices[i]; !reflect.DeepEqual(got, want.toDevice()) {
					t.Errorf("device[%d]:\n got  %s\n want %s", i, fmtDevice(got), fmtDevice(want.toDevice()))
				}
			}
		})
	}
}

func deref[T any](p *T) any {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func fmtDevice(d MemoryDevice) string {
	return fmt.Sprintf("{h=%#x arr=%#x pop=%v size=%v ff=%q type=%q loc=%q bank=%q mfr=%q sn=%q pn=%q speed=%v conf=%v}",
		d.Handle, d.ArrayHandle, d.Populated, deref(d.SizeMB), d.FormFactor, d.MemoryType, d.Locator, d.BankLocator,
		d.Manufacturer, d.SerialNumber, d.PartNumber, deref(d.SpeedMTs), deref(d.ConfiguredSpeedMTs))
}

func TestParseMemoryMalformedFixtures(t *testing.T) {
	for _, tc := range []struct{ fixture, wantErr string }{
		{"malformed_length_past_end.bin", "past end"},
		{"malformed_missing_string_term.bin", "string set"},
		{"malformed_dangling_array_handle.bin", "array handle"},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			inv, err := ParseMemory(readFixture(t, tc.fixture))
			if err == nil {
				t.Fatalf("expected error, got inventory %+v", inv)
			}
			if inv != nil {
				t.Errorf("malformed input must not return partial output, got %+v", inv)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not mention %q", err, tc.wantErr)
			}
		})
	}
}

func TestParseMemoryMalformedInline(t *testing.T) {
	sysArray := arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 1}
	okDimm := dimmSpec{handle: 0x11, arrayHandle: 0x10, size: 4096, formFactor: ffDIMM, memType: mtDDR4, locator: "DIMM0", length: 0x28}

	tooMany := &tableBuilder{}
	tooMany.array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 257})
	for i := 0; i < 257; i++ {
		d := okDimm
		d.handle = uint16(0x100 + i)
		tooMany.dimm(d)
	}
	tooMany.end()

	tooManySlots := &tableBuilder{}
	tooManySlots.array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 300})
	tooManySlots.dimm(okDimm).end()

	cases := map[string]struct {
		table   []byte
		wantErr string
	}{
		"empty table": {nil, "no memory"},
		"header length below 4": {
			append((&tableBuilder{}).array(sysArray).bytes(), 17, 0x02, 0x11, 0x00, 0, 0), "length",
		},
		"trailing partial header": {
			append((&tableBuilder{}).array(sysArray).dimm(okDimm).bytes(), 0x11, 0x28), "truncated",
		},
		"type 17 shorter than 0x15": {
			(&tableBuilder{}).array(sysArray).dimm(dimmSpec{handle: 0x11, arrayHandle: 0x10, size: 4096, locator: "X", length: 0x10}).end().bytes(), "type 17",
		},
		"type 16 shorter than 0x0F": {
			(&tableBuilder{}).array(arraySpec{handle: 0x10, use: 0x03, length: 0x0C}).dimm(okDimm).end().bytes(), "type 16",
		},
		"duplicate type 17 handle": {
			(&tableBuilder{}).array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 2}).dimm(okDimm).dimm(okDimm).end().bytes(), "duplicate",
		},
		"duplicate type 16 handle": {
			(&tableBuilder{}).array(sysArray).array(sysArray).dimm(okDimm).end().bytes(), "duplicate",
		},
		"no type 17 devices": {
			(&tableBuilder{}).array(sysArray).end().bytes(), "no memory",
		},
		"no system memory array": {
			(&tableBuilder{}).array(arraySpec{handle: 0x10, use: 0x04, maxKiB: 1 << 20, numDevices: 1}).dimm(okDimm).end().bytes(), "no memory",
		},
		"more than 256 devices":           {tooMany.bytes(), "256"},
		"more than 256 slots on an array": {tooManySlots.bytes(), "256"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			inv, err := ParseMemory(tc.table)
			if err == nil {
				t.Fatalf("expected error, got %+v", inv)
			}
			if inv != nil {
				t.Errorf("got partial output %+v", inv)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not mention %q", err, tc.wantErr)
			}
		})
	}
}

// A structure with no strings may be followed by two NULs (the common form)
// and parsing stops at the type 127 end-of-table marker even if trailing
// bytes (padding) follow.
func TestParseMemoryStopsAtEndOfTable(t *testing.T) {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 1})
	b.dimm(dimmSpec{handle: 0x11, arrayHandle: 0x10, size: 4096, formFactor: ffDIMM, memType: mtDDR4, locator: "DIMM0", length: 0x28})
	b.end()
	table := append(b.bytes(), 0xDE, 0xAD, 0xBE, 0xEF, 0x01) // garbage after end marker
	inv, err := ParseMemory(table)
	if err != nil {
		t.Fatalf("ParseMemory: %v", err)
	}
	if len(inv.Devices) != 1 || inv.SlotsTotal != 1 {
		t.Fatalf("unexpected inventory %+v", inv)
	}
}

// Trailing zero padding without an end-of-table structure is tolerated.
func TestParseMemoryToleratesZeroPaddingWithoutEndMarker(t *testing.T) {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 1})
	b.dimm(dimmSpec{handle: 0x11, arrayHandle: 0x10, size: 4096, formFactor: ffDIMM, memType: mtDDR4, locator: "DIMM0", length: 0x28})
	inv, err := ParseMemory(append(b.bytes(), 0, 0, 0))
	if err != nil {
		t.Fatalf("ParseMemory: %v", err)
	}
	if len(inv.Devices) != 1 {
		t.Fatalf("unexpected inventory %+v", inv)
	}
}

// Firmware that under-reports Number of Memory Devices must never produce a
// slot total below the populated count.
func TestParseMemorySlotsTotalNeverBelowLinkedDevices(t *testing.T) {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 1})
	b.dimm(dimmSpec{handle: 0x11, arrayHandle: 0x10, size: 4096, formFactor: ffDIMM, memType: mtDDR4, locator: "DIMM0", length: 0x28})
	b.dimm(dimmSpec{handle: 0x12, arrayHandle: 0x10, size: 4096, formFactor: ffDIMM, memType: mtDDR4, locator: "DIMM1", length: 0x28})
	b.end()
	inv, err := ParseMemory(b.bytes())
	if err != nil {
		t.Fatalf("ParseMemory: %v", err)
	}
	if inv.SlotsTotal != 2 {
		t.Fatalf("SlotsTotal = %d, want 2", inv.SlotsTotal)
	}
}

// Unknown max capacity on any system array makes the total unknown rather
// than a silent under-count.
func TestParseMemoryMaxCapacityUnknownWhenAnyArrayUnknown(t *testing.T) {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 1})
	// 0x80000000 sentinel on a 2.1-length (0x0F) structure: no extended field to read.
	b.array(arraySpec{handle: 0x20, use: 0x03, maxKiB: 0x80000000, numDevices: 1, length: 0x0F})
	b.dimm(dimmSpec{handle: 0x11, arrayHandle: 0x10, size: 4096, locator: "A", length: 0x28})
	b.dimm(dimmSpec{handle: 0x21, arrayHandle: 0x20, size: 4096, locator: "B", length: 0x28})
	b.end()
	inv, err := ParseMemory(b.bytes())
	if err != nil {
		t.Fatalf("ParseMemory: %v", err)
	}
	if inv.MaxCapacityMB != nil {
		t.Fatalf("MaxCapacityMB = %d, want nil", *inv.MaxCapacityMB)
	}
}

// Every truncation of a valid table must either parse successfully or
// return an error — never panic. Guards the length gates.
func TestParseMemoryAllTruncationsSafe(t *testing.T) {
	for name, build := range fixtureBuilders {
		table := build()
		for n := 0; n < len(table); n++ {
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("%s truncated to %d bytes panicked: %v", name, n, r)
					}
				}()
				_, _ = ParseMemory(table[:n])
			}()
		}
	}
}

func FuzzParseMemory(f *testing.F) {
	for _, build := range fixtureBuilders {
		f.Add(build())
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		inv, err := ParseMemory(data)
		if err == nil {
			if inv == nil || len(inv.Devices) == 0 || len(inv.Devices) > MaxMemoryDevices || inv.SlotsTotal < len(inv.Devices) {
				t.Fatalf("invalid success result %+v", inv)
			}
		} else if inv != nil {
			t.Fatalf("error with partial output")
		}
	})
}

func TestMemoryEnums(t *testing.T) {
	types := map[byte]string{0x01: "Other", 0x02: "", 0x0F: "SDRAM", 0x12: "DDR", 0x13: "DDR2", 0x18: "DDR3",
		0x1A: "DDR4", 0x1B: "LPDDR", 0x1E: "LPDDR4", 0x22: "DDR5", 0x23: "LPDDR5", 0x24: "HBM3", 0x15: "", 0x00: "", 0x99: ""}
	for code, want := range types {
		if got := MemoryTypeName(code); got != want {
			t.Errorf("MemoryTypeName(%#x) = %q, want %q", code, got, want)
		}
	}
	forms := map[byte]string{0x01: "Other", 0x02: "", 0x03: "SIMM", 0x09: "DIMM", 0x0C: "RIMM", 0x0D: "SODIMM",
		0x0F: "FB-DIMM", 0x10: "Die", 0x11: "CAMM", 0x00: "", 0x40: ""}
	for code, want := range forms {
		if got := FormFactorName(code); got != want {
			t.Errorf("FormFactorName(%#x) = %q, want %q", code, got, want)
		}
	}
}

// Guard the fixture builder itself: the type 17 offsets the builder writes
// must be the DSP0134 offsets the parser reads.
func TestFixtureBuilderOffsets(t *testing.T) {
	b := &tableBuilder{}
	b.dimm(dimmSpec{handle: 0x1234, arrayHandle: 0xABCD, size: 0x7FFF, extSize: 0x11223344, speed: 0xFFFF,
		confSpeed: 0xFFFF, extSpeed: 0x0000AAAA, extConfSpeed: 0x0000BBBB, locator: "L"})
	s := b.bytes()
	if s[0] != 17 || s[1] != 0x5C {
		t.Fatalf("header = % x", s[:4])
	}
	checks := []struct {
		off  int
		want uint32
		w    int
	}{{0x02, 0x1234, 2}, {0x04, 0xABCD, 2}, {0x0C, 0x7FFF, 2}, {0x15, 0xFFFF, 2}, {0x1C, 0x11223344, 4},
		{0x20, 0xFFFF, 2}, {0x54, 0xAAAA, 4}, {0x58, 0xBBBB, 4}}
	for _, c := range checks {
		var got uint32
		if c.w == 2 {
			got = uint32(binary.LittleEndian.Uint16(s[c.off:]))
		} else {
			got = binary.LittleEndian.Uint32(s[c.off:])
		}
		if got != c.want {
			t.Errorf("offset %#x = %#x, want %#x", c.off, got, c.want)
		}
	}
}
