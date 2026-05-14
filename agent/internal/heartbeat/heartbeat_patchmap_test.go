package heartbeat

import "testing"

func TestMapPatchProviderSource(t *testing.T) {
	h := &Heartbeat{}
	cases := []struct {
		provider string
		want     string
	}{
		{"windows-update", "microsoft"},
		{"apple-softwareupdate", "apple"},
		{"homebrew", "third_party"},
		{"chocolatey", "third_party"},
		{"winget", "third_party"},
		{"apt", "linux"},
		{"yum", "linux"},
		{"unknown", "custom"},
	}
	for _, c := range cases {
		t.Run(c.provider, func(t *testing.T) {
			if got := h.mapPatchProviderSource(c.provider); got != c.want {
				t.Errorf("mapPatchProviderSource(%q) = %q, want %q", c.provider, got, c.want)
			}
		})
	}
}

func TestMapPatchProviderCategory(t *testing.T) {
	h := &Heartbeat{}
	cases := []struct {
		provider string
		want     string
	}{
		{"windows-update", "system"},
		{"apple-softwareupdate", "system"},
		{"homebrew", "application"},
		{"chocolatey", "application"},
		{"winget", "application"},
		{"apt", "system"},
		{"yum", "system"},
		{"unknown", "application"},
	}
	for _, c := range cases {
		t.Run(c.provider, func(t *testing.T) {
			if got := h.mapPatchProviderCategory(c.provider); got != c.want {
				t.Errorf("mapPatchProviderCategory(%q) = %q, want %q", c.provider, got, c.want)
			}
		})
	}
}
