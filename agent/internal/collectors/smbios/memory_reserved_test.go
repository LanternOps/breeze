package smbios

import "testing"

// Bit 31 of Extended Size / Extended Speed / Extended Configured Speed is
// reserved and must be masked off, not folded into the value.
func TestParseMemoryMasksReservedBit31(t *testing.T) {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 30, numDevices: 1})
	b.dimm(dimmSpec{handle: 0x11, arrayHandle: 0x10, size: 0x7FFF, extSize: 0x80000000 | 131072,
		speed: 0xFFFF, extSpeed: 0x80000000 | 70000, confSpeed: 0xFFFF, extConfSpeed: 0x80000000 | 68000,
		formFactor: ffDIMM, memType: mtDDR5, locator: "DIMM0"})
	b.end()
	inv, err := ParseMemory(b.bytes())
	if err != nil {
		t.Fatalf("ParseMemory: %v", err)
	}
	d := inv.Devices[0]
	if d.SizeMB == nil || *d.SizeMB != 131072 {
		t.Errorf("SizeMB = %v, want 131072", deref(d.SizeMB))
	}
	if d.SpeedMTs == nil || *d.SpeedMTs != 70000 {
		t.Errorf("SpeedMTs = %v, want 70000", deref(d.SpeedMTs))
	}
	if d.ConfiguredSpeedMTs == nil || *d.ConfiguredSpeedMTs != 68000 {
		t.Errorf("ConfiguredSpeedMTs = %v, want 68000", deref(d.ConfiguredSpeedMTs))
	}
}
