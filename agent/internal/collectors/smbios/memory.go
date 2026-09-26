package smbios

import (
	"fmt"
	"math"
)

// MaxMemoryDevices caps the number of slots/devices reported. Above this the
// table is treated as implausible and the parse fails (the API also caps the
// module list at 256 and rejects — never truncates — a longer one).
const MaxMemoryDevices = 256

const (
	typePhysicalMemoryArray = 16
	typeMemoryDevice        = 17

	// Array Use (DSP0134 §7.17.2).
	arrayUseSystemMemory = 0x03

	// Minimum formatted lengths (SMBIOS 2.1).
	minType16Len = 0x0F
	minType17Len = 0x15
)

// Type 16 (Physical Memory Array) field offsets, DSP0134 §7.17.
const (
	t16Use            = 0x05 // BYTE
	t16MaxCapacity    = 0x07 // DWORD, KiB; 0x80000000 → Extended Maximum Capacity
	t16NumDevices     = 0x0D // WORD
	t16ExtMaxCapacity = 0x0F // QWORD, bytes (2.7+)

	maxCapacityUseExtended = 0x80000000
)

// Type 17 (Memory Device) field offsets, DSP0134 §7.18.
const (
	t17ArrayHandle     = 0x04 // WORD
	t17Size            = 0x0C // WORD
	t17FormFactor      = 0x0E // BYTE
	t17Locator         = 0x10 // STRING
	t17BankLocator     = 0x11 // STRING
	t17MemoryType      = 0x12 // BYTE
	t17Speed           = 0x15 // WORD, MT/s (2.3+)
	t17Manufacturer    = 0x17 // STRING (2.3+)
	t17SerialNumber    = 0x18 // STRING (2.3+)
	t17PartNumber      = 0x1A // STRING (2.3+)
	t17ExtendedSize    = 0x1C // DWORD, MiB, bit 31 reserved (2.7+)
	t17ConfiguredSpeed = 0x20 // WORD, MT/s (2.7+)
	t17ExtSpeed        = 0x54 // DWORD, MT/s, bit 31 reserved (3.3+)
	t17ExtConfSpeed    = 0x58 // DWORD, MT/s, bit 31 reserved (3.3+)

	sizeNotInstalled = 0x0000
	sizeUnknown      = 0xFFFF
	sizeUseExtended  = 0x7FFF
	sizeKiBFlag      = 0x8000

	speedUnknown     = 0x0000
	speedUseExtended = 0xFFFF
)

// MemoryDevice is one type 17 structure linked to a system-memory array.
// Strings are raw firmware values (not trimmed or placeholder-filtered);
// normalisation is the caller's job. Nil pointers mean "not reported".
type MemoryDevice struct {
	Handle             uint16
	ArrayHandle        uint16
	Populated          bool
	SizeMB             *uint64
	FormFactor         string
	MemoryType         string
	Locator            string
	BankLocator        string
	Manufacturer       string
	SerialNumber       string
	PartNumber         string
	SpeedMTs           *uint32
	ConfiguredSpeedMTs *uint32
}

// MemoryInventory is the system-memory view of the table: only arrays with
// Use == System Memory and the devices linked to them.
type MemoryInventory struct {
	// SlotsTotal sums, per system array, max(Number of Memory Devices,
	// linked type 17 count) — so it never undercounts the listed devices.
	SlotsTotal int
	// MaxCapacityMB sums the arrays' maximum capacity; nil when any system
	// array does not report one.
	MaxCapacityMB *uint64
	// Devices are in table order.
	Devices []MemoryDevice
}

type memoryArray struct {
	handle     uint16
	use        byte
	numDevices int
	maxCapMB   *uint64
	linked     int
}

// ParseMemory parses the table and returns the system-memory inventory. Any
// malformed structure, a type 17 whose array handle has no type 16, duplicate
// handles, no system-memory devices at all, or more than MaxMemoryDevices
// slots is an error.
func ParseMemory(table []byte) (*MemoryInventory, error) {
	structs, err := ParseStructures(table)
	if err != nil {
		return nil, err
	}

	arrays := map[uint16]*memoryArray{}
	var arrayOrder []uint16
	var devStructs []Structure
	seenDev := map[uint16]bool{}
	for _, s := range structs {
		switch s.Type {
		case typePhysicalMemoryArray:
			a, err := decodeArray(s)
			if err != nil {
				return nil, err
			}
			if _, dup := arrays[a.handle]; dup {
				return nil, fmt.Errorf("smbios: duplicate type 16 handle %#04x", a.handle)
			}
			arrays[a.handle] = a
			arrayOrder = append(arrayOrder, a.handle)
		case typeMemoryDevice:
			if s.Length() < minType17Len {
				return nil, fmt.Errorf("smbios: type 17 handle %#04x length %#x below minimum %#x", s.Handle, s.Length(), minType17Len)
			}
			if seenDev[s.Handle] {
				return nil, fmt.Errorf("smbios: duplicate type 17 handle %#04x", s.Handle)
			}
			seenDev[s.Handle] = true
			devStructs = append(devStructs, s)
		}
	}

	var devices []MemoryDevice
	for _, s := range devStructs {
		arrayHandle, _ := s.word(t17ArrayHandle)
		a, ok := arrays[arrayHandle]
		if !ok {
			return nil, fmt.Errorf("smbios: type 17 handle %#04x references missing array handle %#04x", s.Handle, arrayHandle)
		}
		if a.use != arrayUseSystemMemory {
			continue
		}
		d, err := decodeDevice(s)
		if err != nil {
			return nil, err
		}
		a.linked++
		devices = append(devices, d)
		if len(devices) > MaxMemoryDevices {
			return nil, fmt.Errorf("smbios: more than %d system memory devices", MaxMemoryDevices)
		}
	}
	if len(devices) == 0 {
		return nil, fmt.Errorf("smbios: no memory devices linked to a system memory array")
	}

	inv := &MemoryInventory{Devices: devices}
	var capSum uint64
	capKnown := true
	for _, h := range arrayOrder {
		a := arrays[h]
		if a.use != arrayUseSystemMemory {
			continue
		}
		inv.SlotsTotal += max(a.numDevices, a.linked)
		if a.maxCapMB == nil {
			capKnown = false
		} else if capKnown {
			if capSum > math.MaxUint64-*a.maxCapMB {
				capKnown = false
			} else {
				capSum += *a.maxCapMB
			}
		}
	}
	if inv.SlotsTotal > MaxMemoryDevices {
		return nil, fmt.Errorf("smbios: %d memory slots exceeds limit of %d", inv.SlotsTotal, MaxMemoryDevices)
	}
	if capKnown {
		inv.MaxCapacityMB = &capSum
	}
	return inv, nil
}

func decodeArray(s Structure) (*memoryArray, error) {
	if s.Length() < minType16Len {
		return nil, fmt.Errorf("smbios: type 16 handle %#04x length %#x below minimum %#x", s.Handle, s.Length(), minType16Len)
	}
	a := &memoryArray{handle: s.Handle}
	a.use, _ = s.byteAt(t16Use)
	n, _ := s.word(t16NumDevices)
	a.numDevices = int(n)

	maxKiB, _ := s.dword(t16MaxCapacity)
	switch {
	case maxKiB == maxCapacityUseExtended:
		if ext, ok := s.qword(t16ExtMaxCapacity); ok && ext > 0 {
			mb := ext / (1024 * 1024)
			if mb > 0 {
				a.maxCapMB = &mb
			}
		}
	case maxKiB > 0:
		mb := uint64(maxKiB) / 1024
		if mb > 0 {
			a.maxCapMB = &mb
		}
	}
	return a, nil
}

func decodeDevice(s Structure) (MemoryDevice, error) {
	d := MemoryDevice{Handle: s.Handle}
	d.ArrayHandle, _ = s.word(t17ArrayHandle)

	size, _ := s.word(t17Size)
	switch {
	case size == sizeNotInstalled:
		d.Populated = false
	case size == sizeUnknown:
		d.Populated = true
	case size == sizeUseExtended:
		d.Populated = true
		if ext, ok := s.dword(t17ExtendedSize); ok {
			if mb := uint64(ext & 0x7FFFFFFF); mb > 0 {
				d.SizeMB = &mb
			}
		}
	case size&sizeKiBFlag != 0:
		d.Populated = true
		// Sub-MiB modules round to 0 → reported as unknown rather than 0 MB.
		if mb := uint64(size&^sizeKiBFlag) / 1024; mb > 0 {
			d.SizeMB = &mb
		}
	default:
		d.Populated = true
		mb := uint64(size)
		d.SizeMB = &mb
	}

	ff, _ := s.byteAt(t17FormFactor)
	d.FormFactor = FormFactorName(ff)
	mt, _ := s.byteAt(t17MemoryType)
	d.MemoryType = MemoryTypeName(mt)

	var err error
	for _, f := range []struct {
		off int
		dst *string
	}{
		{t17Locator, &d.Locator},
		{t17BankLocator, &d.BankLocator},
		{t17Manufacturer, &d.Manufacturer},
		{t17SerialNumber, &d.SerialNumber},
		{t17PartNumber, &d.PartNumber},
	} {
		if *f.dst, err = s.str(f.off); err != nil {
			return MemoryDevice{}, err
		}
	}

	d.SpeedMTs = decodeSpeed(s, t17Speed, t17ExtSpeed)
	d.ConfiguredSpeedMTs = decodeSpeed(s, t17ConfiguredSpeed, t17ExtConfSpeed)
	return d, nil
}

// decodeSpeed reads a WORD speed field, falling back to its DWORD extended
// field when the WORD is 0xFFFF. Values are reported as MT/s exactly as the
// firmware gives them (no doubling). 0 or an absent field → nil.
func decodeSpeed(s Structure, off, extOff int) *uint32 {
	v, ok := s.word(off)
	if !ok || v == speedUnknown {
		return nil
	}
	if v != speedUseExtended {
		out := uint32(v)
		return &out
	}
	ext, ok := s.dword(extOff)
	if !ok {
		return nil
	}
	ext &= 0x7FFFFFFF
	if ext == 0 {
		return nil
	}
	return &ext
}
