package syscleanup

import "testing"

// apt reports 1000-based units with a two-character suffix ("12.3 MB"); dnf
// and journalctl report 1024-based units with a single letter ("1.2G"). Using
// one parser for both is wrong by 7% at MB and 10% at GB — enough to turn a
// truthful "up to 4.0 GB" into "up to 4.3 GB" on a estimate the UI already
// labels an upper bound.
func TestParseDecimalSizeUsesThousandBasedUnits(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"0 B", 0, true},
		{"512 B", 512, true},
		{"12.3 kB", 12_300, true},
		{"12.3 MB", 12_300_000, true},
		{"1.5 GB", 1_500_000_000, true},
		{"2 TB", 2_000_000_000_000, true},
		{"12.3MB", 12_300_000, true},
		{"", 0, false},
		{"lots", 0, false},
		{"12.3 QB", 0, false},
		{"MB", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseDecimalSize(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseDecimalSize(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestParseBinarySizeUses1024BasedUnits(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"0B", 0, true},
		{"512", 512, true},
		{"1.2G", 1_288_490_188, true},
		{"1.2GiB", 1_288_490_188, true},
		{"256M", 268_435_456, true},
		{"4.0K", 4_096, true},
		{"1T", 1_099_511_627_776, true},
		{"", 0, false},
		{"some", 0, false},
		{"1.2Q", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseBinarySize(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseBinarySize(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
