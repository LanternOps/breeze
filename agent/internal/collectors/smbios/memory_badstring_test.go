package smbios

import "testing"

// A string reference past the end of an otherwise well-formed string set is a
// common OEM firmware bug (dmidecode prints "<BAD INDEX>"). It degrades only
// that field to unset; the device and the rest of the inventory survive.
func TestParseMemoryBadStringIndexDegradesField(t *testing.T) {
	b := &tableBuilder{}
	b.array(arraySpec{handle: 0x10, use: 0x03, maxKiB: 1 << 20, numDevices: 2})
	b.dimm(dimmSpec{handle: 0x11, arrayHandle: 0x10, size: 16384, formFactor: ffDIMM, memType: mtDDR4,
		locator: "DIMM0", bank: "BANK 0", manufacturer: "Samsung", serial: "12345678", part: "M378A2K43DB1-CTD",
		speed: 3200, length: 0x28, partIndexOverride: 9})
	b.dimm(dimmSpec{handle: 0x12, arrayHandle: 0x10, size: 16384, formFactor: ffDIMM, memType: mtDDR4,
		locator: "DIMM1", bank: "BANK 1", manufacturer: "Samsung", length: 0x28, strIndexOverride: 200})
	b.end()

	inv, err := ParseMemory(b.bytes())
	if err != nil {
		t.Fatalf("ParseMemory: %v", err)
	}
	if len(inv.Devices) != 2 || inv.SlotsTotal != 2 {
		t.Fatalf("inventory = %+v", inv)
	}
	d0 := inv.Devices[0]
	if d0.PartNumber != "" {
		t.Errorf("bad part-number index resolved to %q, want unset", d0.PartNumber)
	}
	if d0.Locator != "DIMM0" || d0.BankLocator != "BANK 0" || d0.Manufacturer != "Samsung" || d0.SerialNumber != "12345678" {
		t.Errorf("valid strings on the same device lost: %s", fmtDevice(d0))
	}
	if d0.SizeMB == nil || *d0.SizeMB != 16384 || d0.SpeedMTs == nil || *d0.SpeedMTs != 3200 {
		t.Errorf("numeric fields lost: %s", fmtDevice(d0))
	}
	d1 := inv.Devices[1]
	if d1.Locator != "" || d1.BankLocator != "BANK 1" || d1.Manufacturer != "Samsung" {
		t.Errorf("bad locator index: %s", fmtDevice(d1))
	}
}
