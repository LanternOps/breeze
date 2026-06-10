package main

import "testing"

func TestParseUnitVersion(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantVer int
		wantOK  bool
	}{
		{"present", "[Service]\n# breeze-unit-version: 2\nType=simple\n", 2, true},
		{"present higher", "# breeze-unit-version: 7\n", 7, true},
		{"missing", "[Service]\nType=simple\n", 0, false},
		{"garbage value", "# breeze-unit-version: abc\n", 0, false},
		{"empty", "", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ver, ok := parseUnitVersion(tc.input)
			if ver != tc.wantVer || ok != tc.wantOK {
				t.Fatalf("parseUnitVersion(%q) = (%d,%v), want (%d,%v)", tc.input, ver, ok, tc.wantVer, tc.wantOK)
			}
		})
	}
}

func TestUnitNeedsReconcile(t *testing.T) {
	cases := []struct {
		name     string
		existing string
		want     int
		expect   bool
	}{
		{"missing marker -> reconcile", "[Service]\nType=simple\n", 2, true},
		{"older -> reconcile", "# breeze-unit-version: 1\n", 2, true},
		{"equal -> skip", "# breeze-unit-version: 2\n", 2, false},
		{"newer -> skip (no downgrade)", "# breeze-unit-version: 3\n", 2, false},
		{"garbage -> reconcile", "# breeze-unit-version: x\n", 2, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := unitNeedsReconcile(tc.existing, tc.want); got != tc.expect {
				t.Fatalf("unitNeedsReconcile(%q,%d) = %v, want %v", tc.existing, tc.want, got, tc.expect)
			}
		})
	}
}
