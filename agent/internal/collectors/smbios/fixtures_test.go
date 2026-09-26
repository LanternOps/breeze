package smbios

import (
	"bytes"
	"encoding/binary"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// The byte fixtures under testdata/ are SYNTHETIC: they are produced by the
// builders in this file, laid out field-for-field per DMTF DSP0134 3.x
// (§7.17 type 16, §7.18 type 17), and modelled on dmidecode output from the
// named hardware classes. Regenerate with:
//
//	go test ./internal/collectors/smbios/ -run TestFixturesUpToDate -update
//
// TestFixturesUpToDate fails if a checked-in .bin drifts from its builder, so
// the builder source is the reviewable form of every fixture.
var updateFixtures = flag.Bool("update", false, "rewrite testdata/*.bin from the fixture builders")

type tableBuilder struct{ buf bytes.Buffer }

// raw appends one structure: 4-byte header, the formatted area after the
// header, then the string set (double-NUL terminated).
func (b *tableBuilder) raw(typ byte, handle uint16, body []byte, strs ...string) *tableBuilder {
	length := 4 + len(body)
	if length > 0xFF {
		panic("structure too long")
	}
	b.buf.WriteByte(typ)
	b.buf.WriteByte(byte(length))
	_ = binary.Write(&b.buf, binary.LittleEndian, handle)
	b.buf.Write(body)
	writeStrings(&b.buf, strs)
	return b
}

func writeStrings(buf *bytes.Buffer, strs []string) {
	if len(strs) == 0 {
		buf.Write([]byte{0, 0})
		return
	}
	for _, s := range strs {
		buf.WriteString(s)
		buf.WriteByte(0)
	}
	buf.WriteByte(0)
}

func (b *tableBuilder) bytes() []byte { return append([]byte(nil), b.buf.Bytes()...) }

// Filler structures so the walker is exercised across non-memory types with
// their own string sets.
func (b *tableBuilder) bios() *tableBuilder {
	body := make([]byte, 0x18-4)
	body[0] = 1 // vendor
	body[1] = 2 // version
	body[4] = 3 // release date
	return b.raw(0, 0x0000, body, "American Megatrends International, LLC.", "1.40", "03/15/2024")
}

func (b *tableBuilder) system(manufacturer, product string) *tableBuilder {
	body := make([]byte, 0x1B-4)
	body[0] = 1
	body[1] = 2
	return b.raw(1, 0x0001, body, manufacturer, product)
}

func (b *tableBuilder) mappedAddress(handle, arrayHandle uint16) *tableBuilder {
	body := make([]byte, 0x1F-4)
	binary.LittleEndian.PutUint16(body[0x0C-4:], arrayHandle)
	return b.raw(19, handle, body)
}

func (b *tableBuilder) end() *tableBuilder {
	return b.raw(127, 0xFEFF, nil)
}

type arraySpec struct {
	handle     uint16
	use        byte
	maxKiB     uint32
	numDevices uint16
	extBytes   uint64
	length     byte // 0 → 0x17 (SMBIOS 2.7+)
}

func (b *tableBuilder) array(a arraySpec) *tableBuilder {
	length := a.length
	if length == 0 {
		length = 0x17
	}
	full := make([]byte, 0x17)
	full[0x04] = 0x03 // location: system board
	full[0x05] = a.use
	full[0x06] = 0x03 // error correction: none
	binary.LittleEndian.PutUint32(full[0x07:], a.maxKiB)
	binary.LittleEndian.PutUint16(full[0x0B:], 0xFFFE)
	binary.LittleEndian.PutUint16(full[0x0D:], a.numDevices)
	binary.LittleEndian.PutUint64(full[0x0F:], a.extBytes)
	return b.raw(16, a.handle, full[4:length])
}

type dimmSpec struct {
	handle       uint16
	arrayHandle  uint16
	size         uint16
	extSize      uint32
	formFactor   byte
	memType      byte
	locator      string
	bank         string
	speed        uint16
	manufacturer string
	serial       string
	asset        string
	part         string
	confSpeed    uint16
	extSpeed     uint32
	extConfSpeed uint32
	length       byte // 0 → 0x5C (SMBIOS 3.3+)
	// strIndexOverride forces a raw string index into the locator slot, for
	// malformed-string-reference cases.
	strIndexOverride byte
}

func (b *tableBuilder) dimm(d dimmSpec) *tableBuilder {
	length := int(d.length)
	if length == 0 {
		length = 0x5C
	}
	full := make([]byte, 0x5C)
	binary.LittleEndian.PutUint16(full[0x04:], d.arrayHandle)
	binary.LittleEndian.PutUint16(full[0x06:], 0xFFFE)
	binary.LittleEndian.PutUint16(full[0x08:], 72)
	binary.LittleEndian.PutUint16(full[0x0A:], 64)
	binary.LittleEndian.PutUint16(full[0x0C:], d.size)
	full[0x0E] = d.formFactor
	full[0x12] = d.memType
	binary.LittleEndian.PutUint16(full[0x13:], 0x0080) // type detail: synchronous
	binary.LittleEndian.PutUint16(full[0x15:], d.speed)
	full[0x1B] = 0x02 // attributes: rank 2
	binary.LittleEndian.PutUint32(full[0x1C:], d.extSize)
	binary.LittleEndian.PutUint16(full[0x20:], d.confSpeed)
	binary.LittleEndian.PutUint16(full[0x22:], 1200)
	binary.LittleEndian.PutUint16(full[0x24:], 1200)
	binary.LittleEndian.PutUint16(full[0x26:], 1200)
	binary.LittleEndian.PutUint32(full[0x54:], d.extSpeed)
	binary.LittleEndian.PutUint32(full[0x58:], d.extConfSpeed)

	// Assign string indices only to string fields that exist at this length.
	var strs []string
	setStr := func(off int, v string) {
		if off >= length || v == "" {
			return
		}
		strs = append(strs, v)
		full[off] = byte(len(strs))
	}
	setStr(0x10, d.locator)
	setStr(0x11, d.bank)
	setStr(0x17, d.manufacturer)
	setStr(0x18, d.serial)
	setStr(0x19, d.asset)
	setStr(0x1A, d.part)
	if d.strIndexOverride != 0 {
		full[0x10] = d.strIndexOverride
	}
	return b.raw(17, d.handle, full[4:length], strs...)
}

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

const (
	ffDIMM   = 0x09
	ffSODIMM = 0x0D
	ffOther  = 0x01
	ffUnk    = 0x02

	mtDDR4  = 0x1A
	mtDDR5  = 0x22
	mtSDRAM = 0x0F
	mtOther = 0x01
	mtUnk   = 0x02
)

// Consumer desktop, SMBIOS 3.2-length type 17 (0x54), 4 slots, 2 populated
// with 16 GiB DDR4-3200 running at 2933, empty slots carry "NO DIMM" fillers.
func fixtureDesktopDDR4() []byte {
	b := &tableBuilder{}
	b.bios().system("Micro-Star International Co., Ltd.", "MS-7C02")
	b.array(arraySpec{handle: 0x1000, use: 0x03, maxKiB: 128 * 1024 * 1024, numDevices: 4})
	empty := func(h uint16, loc, bank string) dimmSpec {
		return dimmSpec{handle: h, arrayHandle: 0x1000, size: 0, formFactor: ffUnk, memType: mtUnk,
			locator: loc, bank: bank, manufacturer: "NO DIMM", serial: "NO DIMM", part: "NO DIMM", length: 0x54}
	}
	full := func(h uint16, loc, bank, serial string) dimmSpec {
		return dimmSpec{handle: h, arrayHandle: 0x1000, size: 16384, formFactor: ffDIMM, memType: mtDDR4,
			locator: loc, bank: bank, speed: 3200, confSpeed: 2933, manufacturer: "Samsung",
			serial: serial, asset: "Not Specified", part: "M378A2K43DB1-CTD    ", length: 0x54}
	}
	b.dimm(empty(0x1100, "DIMM_A1", "BANK 0"))
	b.dimm(full(0x1101, "DIMM_A2", "BANK 1", "12345678"))
	b.dimm(empty(0x1102, "DIMM_B1", "BANK 2"))
	b.dimm(full(0x1103, "DIMM_B2", "BANK 3", "87654321"))
	b.mappedAddress(0x1200, 0x1000)
	b.end()
	return b.bytes()
}

// Laptop, SMBIOS 3.3-length type 17 (0x5C), two DDR5 SODIMMs; one Micron
// module with trailing-space part number, one slot with OEM filler strings.
func fixtureLaptopSODIMM() []byte {
	b := &tableBuilder{}
	b.bios().system("LENOVO", "21K5CTO1WW")
	b.array(arraySpec{handle: 0x0040, use: 0x03, maxKiB: 64 * 1024 * 1024, numDevices: 2})
	b.dimm(dimmSpec{handle: 0x0041, arrayHandle: 0x0040, size: 16384, formFactor: ffSODIMM, memType: mtDDR5,
		locator: "Controller0-ChannelA-DIMM0", bank: "BANK 0", speed: 5600, confSpeed: 5600,
		manufacturer: "Micron Technology", serial: "E5A1B2C3", part: "CT16G56C46S5.M8G1   "})
	b.dimm(dimmSpec{handle: 0x0042, arrayHandle: 0x0040, size: 16384, formFactor: ffSODIMM, memType: mtDDR5,
		locator: "Controller1-ChannelA-DIMM0", bank: "BANK 0", speed: 5600, confSpeed: 5600,
		manufacturer: "Manufacturer1", serial: "SerNum1", part: "PartNum1"})
	b.end()
	return b.bytes()
}

// 2-socket server: two system arrays whose type 16 max capacity uses the
// 0x80000000 sentinel + Extended Maximum Capacity (bytes); identical
// locators under each array; a 64 GiB RDIMM that needs Extended Size; empty
// slots. Type 17 records are interleaved with the arrays out of order.
func fixtureServer2Socket() []byte {
	b := &tableBuilder{}
	b.bios().system("Dell Inc.", "PowerEdge R740")
	b.array(arraySpec{handle: 0x1000, use: 0x03, maxKiB: 0x80000000, numDevices: 3, extBytes: 1 << 40})
	b.array(arraySpec{handle: 0x1001, use: 0x03, maxKiB: 0x80000000, numDevices: 3, extBytes: 1 << 40})
	rdimm := func(h, arr uint16, loc, bank, serial string, size uint16, ext uint32) dimmSpec {
		return dimmSpec{handle: h, arrayHandle: arr, size: size, extSize: ext, formFactor: ffDIMM, memType: mtDDR4,
			locator: loc, bank: bank, speed: 2933, confSpeed: 2666, manufacturer: "Hynix Semiconductor",
			serial: serial, part: "HMA84GR7CJR4N-WM", length: 0x54}
	}
	emptySlot := func(h, arr uint16, loc, bank string) dimmSpec {
		return dimmSpec{handle: h, arrayHandle: arr, size: 0, formFactor: ffDIMM, memType: mtDDR4,
			locator: loc, bank: bank, manufacturer: "Not Specified", serial: "Not Specified", part: "Not Specified", length: 0x54}
	}
	b.dimm(rdimm(0x1100, 0x1000, "A1", "NODE 0", "3A1B2C3D", 0x7FFF, 65536))
	b.dimm(rdimm(0x1101, 0x1000, "A2", "NODE 0", "3A1B2C3E", 0x7FFF, 32768)) // 32 GiB > 0x7FFE MiB → extended
	b.dimm(emptySlot(0x1102, 0x1000, "A3", "NODE 0"))
	b.dimm(rdimm(0x1103, 0x1001, "A1", "NODE 1", "4B1B2C3D", 16384, 0))
	b.dimm(emptySlot(0x1104, 0x1001, "A2", "NODE 1"))
	b.dimm(emptySlot(0x1105, 0x1001, "A3", "NODE 1"))
	b.end()
	return b.bytes()
}

// A system array plus a video-memory array (Use 0x04) whose device must be
// excluded from both the module list and the slot/capacity totals.
func fixtureNonSystemArray() []byte {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x0010, use: 0x03, maxKiB: 32 * 1024 * 1024, numDevices: 2})
	b.array(arraySpec{handle: 0x0020, use: 0x04, maxKiB: 8 * 1024 * 1024, numDevices: 1})
	b.dimm(dimmSpec{handle: 0x0011, arrayHandle: 0x0010, size: 8192, formFactor: ffSODIMM, memType: mtDDR4,
		locator: "ChannelA-DIMM0", bank: "BANK 0", speed: 2666, confSpeed: 2666, manufacturer: "Kingston",
		serial: "0A1B2C3D", part: "KF426S15IB/8", length: 0x28})
	b.dimm(dimmSpec{handle: 0x0012, arrayHandle: 0x0010, size: 0, formFactor: ffSODIMM, memType: mtDDR4,
		locator: "ChannelB-DIMM0", bank: "BANK 2", length: 0x28})
	b.dimm(dimmSpec{handle: 0x0021, arrayHandle: 0x0020, size: 8192, formFactor: ffChip, memType: mtDDR5,
		locator: "VRAM", length: 0x28})
	b.end()
	return b.bytes()
}

const ffChip = 0x05

// DDR5-8000 module reporting Speed/Configured Speed = 0xFFFF, so the values
// come from Extended Speed (0x54) and Extended Configured Speed (0x58).
func fixtureExtendedSpeed() []byte {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x0050, use: 0x03, maxKiB: 256 * 1024 * 1024, numDevices: 2})
	b.dimm(dimmSpec{handle: 0x0051, arrayHandle: 0x0050, size: 24576, formFactor: ffDIMM, memType: mtDDR5,
		locator: "DIMM1", bank: "P0 CHANNEL A", speed: 0xFFFF, extSpeed: 8000, confSpeed: 0xFFFF, extConfSpeed: 7200,
		manufacturer: "G Skill Intl", serial: "00000000", part: "F5-8000J3848H24G"})
	// Same sentinel but the structure is too short (0x54) to carry the
	// extended speed fields → speeds unknown.
	b.dimm(dimmSpec{handle: 0x0052, arrayHandle: 0x0050, size: 24576, formFactor: ffDIMM, memType: mtDDR5,
		locator: "DIMM2", bank: "P0 CHANNEL B", speed: 0xFFFF, extSpeed: 8000, confSpeed: 0xFFFF, extConfSpeed: 7200,
		manufacturer: "G Skill Intl", serial: "FFFFFFFF", part: "F5-8000J3848H24G", length: 0x54})
	b.end()
	return b.bytes()
}

// Size field with bit 15 set = KiB granularity. 0x8000|8192 KiB = 8 MiB;
// 0x8000|512 KiB rounds below one MiB → capacity unknown but populated.
// A third device reports 0xFFFF (installed, size unknown).
func fixtureKiBSize() []byte {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x0060, use: 0x03, maxKiB: 65536, numDevices: 3})
	b.dimm(dimmSpec{handle: 0x0061, arrayHandle: 0x0060, size: 0x8000 | 8192, formFactor: ffChip, memType: mtSDRAM,
		locator: "U1", length: 0x28})
	b.dimm(dimmSpec{handle: 0x0062, arrayHandle: 0x0060, size: 0x8000 | 512, formFactor: ffChip, memType: mtSDRAM,
		locator: "U2", length: 0x28})
	b.dimm(dimmSpec{handle: 0x0063, arrayHandle: 0x0060, size: 0xFFFF, formFactor: ffChip, memType: mtSDRAM,
		locator: "U3", length: 0x28})
	b.end()
	return b.bytes()
}

// SMBIOS 2.1/2.2 era: type 16 without Extended Maximum Capacity (0x0F) and a
// type 17 of length 0x15, which ends before Speed, Manufacturer, Serial and
// Part Number.
func fixtureShortType17() []byte {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x0070, use: 0x03, maxKiB: 512 * 1024, numDevices: 2, length: 0x0F})
	b.dimm(dimmSpec{handle: 0x0071, arrayHandle: 0x0070, size: 256, formFactor: ffDIMM, memType: mtSDRAM,
		locator: "DIMM0", bank: "BANK0", speed: 133, manufacturer: "ignored", length: 0x15})
	b.dimm(dimmSpec{handle: 0x0072, arrayHandle: 0x0070, size: 0, formFactor: ffDIMM, memType: mtSDRAM,
		locator: "DIMM1", bank: "BANK1", length: 0x15})
	b.end()
	return b.bytes()
}

// Hyper-V Gen2 guest shape (per dmidecode on Hyper-V): Type "Other", form
// factor "Unknown", no speed, "None" strings.
func fixtureVMHyperV() []byte {
	b := &tableBuilder{}
	b.bios().system("Microsoft Corporation", "Virtual Machine")
	b.array(arraySpec{handle: 0x0008, use: 0x03, maxKiB: 1024 * 1024 * 1024, numDevices: 1})
	b.dimm(dimmSpec{handle: 0x0009, arrayHandle: 0x0008, size: 4096, formFactor: ffUnk, memType: mtOther,
		locator: "M0001", bank: "M0001", manufacturer: "Microsoft Corporation",
		serial: "None", asset: "None", part: "None", length: 0x28})
	b.end()
	return b.bytes()
}

// --- malformed ---

// Last structure declares a formatted length running past the buffer.
func fixtureMalformedLengthPastEnd() []byte {
	good := fixtureVMHyperV()
	b := &tableBuilder{}
	b.buf.Write(good[:len(good)-6])                       // drop the type 127 end structure
	b.buf.Write([]byte{17, 0x5C, 0x0A, 0x00, 0x08, 0x00}) // type 17, length 0x5C, only 6 bytes present
	return b.bytes()
}

// Final string set is never double-NUL terminated.
func fixtureMalformedMissingStringTerminator() []byte {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x0008, use: 0x03, maxKiB: 1024 * 1024, numDevices: 1})
	body := make([]byte, 0x28-4)
	binary.LittleEndian.PutUint16(body[0x04-4:], 0x0008)
	binary.LittleEndian.PutUint16(body[0x0C-4:], 4096)
	body[0x10-4] = 1
	b.buf.Write([]byte{17, 0x28, 0x09, 0x00})
	b.buf.Write(body)
	b.buf.WriteString("DIMM0\x00BANK0") // no terminators
	return b.bytes()
}

// Type 17 points at an array handle that has no type 16 structure.
func fixtureMalformedDanglingArray() []byte {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x0008, use: 0x03, maxKiB: 1024 * 1024, numDevices: 2})
	b.dimm(dimmSpec{handle: 0x0009, arrayHandle: 0x0008, size: 4096, formFactor: ffDIMM, memType: mtDDR4, locator: "DIMM0", length: 0x28})
	b.dimm(dimmSpec{handle: 0x000A, arrayHandle: 0x9999, size: 4096, formFactor: ffDIMM, memType: mtDDR4, locator: "DIMM1", length: 0x28})
	b.end()
	return b.bytes()
}

var fixtureBuilders = map[string]func() []byte{
	"desktop_ddr4_2of4.bin":               fixtureDesktopDDR4,
	"laptop_sodimm_ddr5.bin":              fixtureLaptopSODIMM,
	"server_2socket.bin":                  fixtureServer2Socket,
	"nonsystem_array.bin":                 fixtureNonSystemArray,
	"extended_speed.bin":                  fixtureExtendedSpeed,
	"kib_size.bin":                        fixtureKiBSize,
	"short_type17.bin":                    fixtureShortType17,
	"vm_hyperv.bin":                       fixtureVMHyperV,
	"malformed_length_past_end.bin":       fixtureMalformedLengthPastEnd,
	"malformed_missing_string_term.bin":   fixtureMalformedMissingStringTerminator,
	"malformed_dangling_array_handle.bin": fixtureMalformedDanglingArray,
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v (regenerate with -update)", name, err)
	}
	return data
}

func TestFixturesUpToDate(t *testing.T) {
	for name, build := range fixtureBuilders {
		want := build()
		path := filepath.Join("testdata", name)
		if *updateFixtures {
			if err := os.MkdirAll("testdata", 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, want, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v (run with -update)", name, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s drifted from its builder (run with -update)", name)
		}
	}
}
