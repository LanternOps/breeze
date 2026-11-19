package biosconfig

import (
	"context"
	"errors"
	"testing"
)

var allMakes = [][2]string{
	{"Dell Inc.", "OptiPlex 7090"},
	{"HP", "EliteDesk 800 G6"},
	{"Hewlett-Packard", "HP Z2"},
	{"LENOVO", "20U9CTO1WW"},
	{"Microsoft Corporation", "Surface Pro 9"},
	{"Apple Inc.", "Mac14,3"},
	{"", ""},
	{"  ", "  "},
}

// With no observe grant, Detect returns nil for every make, so a device can
// never report firmware state it was not authorized to read.
func TestDetectNilWithoutObserveGrant(t *testing.T) {
	for _, m := range allMakes {
		if a := Detect(m[0], m[1], 0); a != nil {
			t.Errorf("Detect(%q, %q, 0) = %v, want nil", m[0], m[1], a)
		}
	}
}

// Dell follows the plan's own write path, and Surface has no firmware
// adapter: neither gets one from any grant.
func TestDetectNilForDellAndSurfaceWhateverTheGrant(t *testing.T) {
	all := VendorHP | VendorLenovo | VendorSurface
	for _, m := range [][2]string{{"Dell Inc.", "OptiPlex 7090"}, {"Microsoft Corporation", "Surface Pro 9"}, {"Apple Inc.", "Mac14,3"}, {"", ""}} {
		if a := Detect(m[0], m[1], all); a != nil {
			t.Errorf("Detect(%q, %q, all) = %v, want nil", m[0], m[1], a)
		}
	}
}

func TestDetectOnlyTheGrantedVendor(t *testing.T) {
	if a := Detect("HP", "EliteBook 840", VendorLenovo|VendorSurface); a != nil {
		t.Fatalf("HP adapter without an HP grant: %v", a)
	}
	if a := Detect("LENOVO", "20U9CTO1WW", VendorHP|VendorSurface); a != nil {
		t.Fatalf("Lenovo adapter without a Lenovo grant: %v", a)
	}
	if a := Detect("HP", "EliteBook 840", VendorHP); a == nil || a.Vendor() != "hp" {
		t.Fatalf("HP grant: %v", a)
	}
	if a := Detect("LENOVO", "20U9CTO1WW", VendorLenovo); a == nil || a.Vendor() != "lenovo" {
		t.Fatalf("Lenovo grant: %v", a)
	}
}

// Review Focus 1 near-misses (vendor-updates plan): none of these is HP,
// Dell or Lenovo, and none gets an adapter.
func TestMakeNearMisses(t *testing.T) {
	cases := map[string]string{
		"Dell Inc.":                  "dell",
		"Dell":                       "dell",
		"HP":                         "hp",
		"HP Inc.":                    "hp",
		"Hewlett-Packard":            "hp",
		"  hewlett-packard  ":        "hp",
		"LENOVO":                     "lenovo",
		"Lenovo":                     "lenovo",
		"Microsoft Corporation":      "microsoft",
		"HPE":                        "other",
		"Hewlett Packard Enterprise": "other",
		"Hewlett-Packard Enterprise": "other",
		"Dell EMC":                   "other",
		"Delltron":                   "other",
		"CHP Systems":                "",
		"Apple Inc.":                 "",
		"":                           "",
	}
	for in, want := range cases {
		if got := MakeOf(in); got != want {
			t.Errorf("MakeOf(%q) = %q, want %q", in, got, want)
		}
	}
	all := VendorHP | VendorLenovo | VendorSurface
	for _, m := range []string{"HPE", "Hewlett Packard Enterprise", "Dell EMC", "Delltron", "CHP Systems"} {
		if a := Detect(m, "ProLiant DL380", all); a != nil {
			t.Errorf("Detect(%q) = %v, want nil", m, a)
		}
	}
}

func TestParseLane(t *testing.T) {
	for in, want := range map[string]VendorSet{"hp": VendorHP, "HP": VendorHP, " lenovo ": VendorLenovo, "surface": VendorSurface} {
		if got, ok := ParseLane(in); !ok || got != want {
			t.Errorf("ParseLane(%q) = %v %v", in, got, ok)
		}
	}
	for _, in := range []string{"", "dell", "microsoft", "hp,lenovo", "hpe", "toString", "__proto__"} {
		if _, ok := ParseLane(in); ok {
			t.Errorf("ParseLane(%q) accepted", in)
		}
	}
}

// Apply is not enabled at the observe stage: it returns ErrNotEnabled and runs
// nothing on the machine.
func TestApplyNotEnabled(t *testing.T) {
	for _, m := range [][2]string{{"HP", "EliteDesk 800 G6"}, {"LENOVO", "20U9CTO1WW"}} {
		f := newFakeRunner()
		a := DetectWith(m[0], m[1], VendorHP|VendorLenovo, f.run)
		if a == nil {
			t.Fatalf("no adapter for %s", m[0])
		}
		if err := a.Apply(context.Background(), "WakeOnLAN", "ACOnly"); !errors.Is(err, ErrNotEnabled) {
			t.Errorf("%s Apply = %v, want ErrNotEnabled", m[0], err)
		}
		if calls := f.Calls(); len(calls) != 0 {
			t.Errorf("%s Apply ran %d scripts", m[0], len(calls))
		}
	}
}
