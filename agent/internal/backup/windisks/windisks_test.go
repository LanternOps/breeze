package windisks

import (
	"encoding/binary"
	"testing"
)

// descriptor builds a STORAGE_DEVICE_DESCRIPTOR: header (36 bytes) then the
// NUL-terminated strings at the recorded offsets. Offset 0 = absent.
func descriptor(removable bool, bus uint32, vendor, product, serial string) []byte {
	b := make([]byte, 36)
	binary.LittleEndian.PutUint32(b[0:], 1)
	if removable {
		b[10] = 1
	}
	put := func(off int, s string) {
		if s == "" {
			return
		}
		binary.LittleEndian.PutUint32(b[off:], uint32(len(b)))
		b = append(b, append([]byte(s), 0)...)
	}
	put(12, vendor)
	put(16, product)
	put(24, serial)
	binary.LittleEndian.PutUint32(b[28:], bus)
	binary.LittleEndian.PutUint32(b[4:], uint32(len(b)))
	return b
}

func TestSkippableProbeErr(t *testing.T) {
	cases := []struct {
		name  string
		errno uint32
		want  bool
	}{
		{"file not found", 2, true},
		{"path not found", 3, true},
		{"not ready", 21, true},
		{"no media in drive", 1112, true},
		{"unrecognized media", 1785, true},
		{"access denied", 5, false},
		{"invalid function", 1, false},
		{"io device error", 1117, false},
		{"zero", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := skippableProbeErr(tc.errno); got != tc.want {
				t.Fatalf("skippableProbeErr(%d) = %v, want %v", tc.errno, got, tc.want)
			}
		})
	}
}

func TestDecodeDeviceDescriptor(t *testing.T) {
	cases := []struct {
		name               string
		in                 []byte
		model, serial      string
		bus                uint32
		removable, wantErr bool
	}{
		{"hyper-v scsi", descriptor(false, 1, "Msft    ", "Virtual Disk    ", "  6002248  "), "Msft Virtual Disk", "6002248", 1, false, false},
		{"nvme no vendor", descriptor(false, 17, "", "Samsung SSD 980", "S64DNX0R"), "Samsung SSD 980", "S64DNX0R", 17, false, false},
		{"usb stick", descriptor(false, 7, "SanDisk", "Ultra", "4C53"), "SanDisk Ultra", "4C53", 7, true, false},
		{"removable flag", descriptor(true, 11, "", "SATA disk", ""), "SATA disk", "", 11, true, false},
		{"no serial", descriptor(false, 11, "", "WDC", ""), "WDC", "", 11, false, false},
		{"short buffer", make([]byte, 20), "", "", 0, false, true},
		{"offset past end", func() []byte {
			b := descriptor(false, 11, "", "X", "")
			binary.LittleEndian.PutUint32(b[16:], 9999)
			return b
		}(), "", "", 0, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			model, serial, bus, rem, err := DecodeDeviceDescriptor(tc.in)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if model != tc.model || serial != tc.serial || bus != tc.bus || rem != tc.removable {
				t.Fatalf("got (%q,%q,%d,%v) want (%q,%q,%d,%v)", model, serial, bus, rem, tc.model, tc.serial, tc.bus, tc.removable)
			}
		})
	}
}
