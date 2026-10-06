package tools

import "testing"

func TestIsLinkReparseTag(t *testing.T) {
	cases := []struct {
		name string
		tag  uint32
		link bool
	}{
		{"symlink", 0xA000000C, true},
		{"junction / mount point", 0xA0000003, true},
		{"cloud files placeholder", 0x9000001A, false},
		{"cloud files placeholder variant", 0x9000601A, false},
		{"deduplicated file", 0x80000013, false},
		{"app execution alias", 0x8000001B, false},
		{"wof compressed", 0x80000017, false},
		{"none", 0, false},
	}
	for _, tc := range cases {
		if got := isLinkReparseTag(tc.tag); got != tc.link {
			t.Errorf("%s (%#08x): isLinkReparseTag = %v, want %v", tc.name, tc.tag, got, tc.link)
		}
	}
}

func TestAllowOnUnnamedVolume(t *testing.T) {
	protected := []uint32{0x1111, 0x2222}
	cases := []struct {
		name           string
		volume         uint32
		volumeKnown    bool
		protected      []uint32
		protectedKnown bool
		allow          bool
	}{
		{"different volume", 0x3333, true, protected, true, true},
		{"same volume as agent directory", 0x2222, true, protected, true, false},
		{"handle volume unknown", 0x3333, false, protected, true, false},
		{"protected volumes unknown", 0x3333, true, protected, false, false},
		{"no protected volumes resolved", 0x3333, true, nil, true, false},
	}
	for _, tc := range cases {
		if got := allowOnUnnamedVolume(tc.volume, tc.volumeKnown, tc.protected, tc.protectedKnown); got != tc.allow {
			t.Errorf("%s: allowOnUnnamedVolume = %v, want %v", tc.name, got, tc.allow)
		}
	}
}
