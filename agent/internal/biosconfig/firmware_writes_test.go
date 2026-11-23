package biosconfig

import "testing"

// firmware_writes names the vendors the server lets write firmware. Only a
// vendor whose write path ships in this agent is recognised (Dell, W04); HP,
// Lenovo and Surface have no write path, so naming them grants nothing.
func TestParseFirmwareWriteVendor(t *testing.T) {
	for _, name := range []string{"dell", "Dell", " DELL "} {
		if v, ok := ParseFirmwareWriteVendor(name); !ok || v != VendorDell {
			t.Errorf("%q -> %v %v, want VendorDell", name, v, ok)
		}
	}
	for _, name := range []string{"", "hp", "lenovo", "surface", "microsoft", "dell inc", "dell,hp", "dellx", "*"} {
		if v, ok := ParseFirmwareWriteVendor(name); ok || v != 0 {
			t.Errorf("%q -> %v %v, want nothing", name, v, ok)
		}
	}
}

// Dell is not an observe lane, and the write bit never shows up as one.
func TestDellIsNotAnObserveLane(t *testing.T) {
	if _, ok := ParseLane("dell"); ok {
		t.Fatal("dell must not be an observe lane")
	}
	if s := VendorDell.String(); s != "" {
		t.Fatalf("VendorDell.String() = %q, want empty (not a lane)", s)
	}
	if (VendorHP | VendorLenovo | VendorSurface).Has(VendorDell) {
		t.Fatal("the observe lanes must not include the Dell write bit")
	}
}

func TestVendorBitForMake(t *testing.T) {
	for vendor, want := range map[string]VendorSet{"dell": VendorDell, "hp": VendorHP, "lenovo": VendorLenovo, "other": 0, "": 0} {
		if got := VendorBit(vendor); got != want {
			t.Errorf("VendorBit(%q) = %v, want %v", vendor, got, want)
		}
	}
}
