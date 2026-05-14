package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/patching"
)

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

func TestAvailablePatchesToMaps_WingetExternalIdAndPackageId(t *testing.T) {
	h := &Heartbeat{}
	items := h.availablePatchesToMaps([]patching.AvailablePatch{
		{
			ID:       "Mozilla.Firefox",
			Provider: "winget",
			Title:    "Mozilla Firefox",
			Version:  "121.0",
			// no KBNumber for winget
		},
	})
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	if got := items[0]["externalId"]; got != "Mozilla.Firefox" {
		t.Errorf("externalId = %v, want Mozilla.Firefox", got)
	}
	if got := items[0]["packageId"]; got != "Mozilla.Firefox" {
		t.Errorf("packageId = %v, want Mozilla.Firefox", got)
	}
	if got := items[0]["source"]; got != "third_party" {
		t.Errorf("source = %v, want third_party", got)
	}
}

func TestAvailablePatchesToMaps_WindowsUpdateKeepsKB(t *testing.T) {
	h := &Heartbeat{}
	items := h.availablePatchesToMaps([]patching.AvailablePatch{
		{
			ID:       "KB5034441",
			Provider: "windows-update",
			Title:    "Cumulative Update",
			KBNumber: "KB5034441",
		},
	})
	if got := items[0]["externalId"]; got != "KB5034441" {
		t.Errorf("externalId = %v, want KB5034441", got)
	}
}

func TestInstalledPatchesToMaps_WingetExternalId(t *testing.T) {
	h := &Heartbeat{}
	items := h.installedPatchesToMaps([]patching.InstalledPatch{
		{
			ID:       "Mozilla.Firefox",
			Provider: "winget",
			Title:    "Mozilla Firefox",
			Version:  "121.0",
			// no KBNumber
		},
	})
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	if got := items[0]["externalId"]; got != "Mozilla.Firefox" {
		t.Errorf("externalId = %v, want Mozilla.Firefox", got)
	}
	if got := items[0]["packageId"]; got != "Mozilla.Firefox" {
		t.Errorf("packageId = %v, want Mozilla.Firefox", got)
	}
}
