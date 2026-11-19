package biosconfig

import (
	"runtime"
	"testing"
)

// Only Dell has an adapter, and only on Windows (the native BIOS WMI interface).
// Every other make stays nil, so it reports readiness "unproven".
func TestDetectNilForOtherMakesIsUnproven(t *testing.T) {
	makes := [][2]string{
		{"HP", "EliteDesk 800 G6"},
		{"Hewlett-Packard", "HP Z2"},
		{"LENOVO", "ThinkCentre M90q"},
		{"Microsoft Corporation", "Surface Pro 9"},
		{"Apple Inc.", "Mac14,3"},
		{"Dellwood Systems", "X1"},
		{"", ""},
		{"  ", "  "},
	}
	for _, m := range makes {
		if a := Detect(m[0], m[1]); a != nil {
			t.Errorf("Detect(%q, %q) = %v, want nil", m[0], m[1], a)
		}
	}
}

func TestDetectDell(t *testing.T) {
	for _, mfr := range []string{"Dell Inc.", "DELL INC.", " Dell Inc. ", "Dell Computer Corporation", "Dell"} {
		a := Detect(mfr, "OptiPlex 7060")
		if runtime.GOOS != "windows" {
			if a != nil {
				t.Errorf("Detect(%q) on %s = %v, want nil", mfr, runtime.GOOS, a)
			}
			continue
		}
		if a == nil || a.Vendor() != "dell" {
			t.Errorf("Detect(%q) = %v, want the dell adapter", mfr, a)
		}
	}
}
