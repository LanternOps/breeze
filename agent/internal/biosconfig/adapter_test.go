package biosconfig

import "testing"

// No vendor adapter ships in this release: Detect must return nil for every
// make, Dell included, so a device can never report firmware state it did not
// read from captured hardware.
func TestDetectReturnsNilForEveryMake(t *testing.T) {
	makes := [][2]string{
		{"Dell Inc.", "OptiPlex 7090"},
		{"HP", "EliteDesk 800 G6"},
		{"Hewlett-Packard", "HP Z2"},
		{"LENOVO", "ThinkCentre M90q"},
		{"Microsoft Corporation", "Surface Pro 9"},
		{"Apple Inc.", "Mac14,3"},
		{"", ""},
		{"  ", "  "},
	}
	for _, m := range makes {
		if a := Detect(m[0], m[1]); a != nil {
			t.Errorf("Detect(%q, %q) = %v, want nil", m[0], m[1], a)
		}
	}
}
