package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestProcessDataDirConsumers is a source guard for #10870. CI runs the agent
// tests on Linux and Windows, where ProcessDataDir equals GetDataDir, so a
// consumer reverted to GetDataDir would pass every behavioural test there and
// silently bring back the macOS helper bug. Each per-process state file must
// resolve through ProcessDataDir on the line that names it.
//
// The inverse holds for code: on macOS ProcessDataDir is user-writable, and
// the TCC-privileged desktop helper must never dlopen from it, so the OpenH264
// loader must not reference it at all.
func TestProcessDataDirConsumers(t *testing.T) {
	uses := []struct {
		file   string
		marker string
	}{
		{"../ech/shared.go", `"ech-cache.json"`},
		{"../netcache/netcache.go", `"dns-cache.json"`},
		{"../remote/desktop/wallpaper.go", "var wallpaperStateDir ="},
	}
	for _, u := range uses {
		src := readSource(t, u.file)
		found := false
		for _, line := range strings.Split(src, "\n") {
			if !strings.Contains(line, u.marker) {
				continue
			}
			found = true
			if !strings.Contains(line, "ProcessDataDir") {
				t.Errorf("%s: %q must resolve through config.ProcessDataDir, got: %s", u.file, u.marker, strings.TrimSpace(line))
			}
		}
		if !found {
			t.Errorf("%s: marker %q not found; update this guard if the file moved", u.file, u.marker)
		}
	}

	codec := readSource(t, "../remote/desktop/encoder_openh264_dl_other.go")
	if strings.Contains(codec, "ProcessDataDir") {
		t.Error("encoder_openh264_dl_other.go must not load or stage the codec through ProcessDataDir: it is user-writable on macOS")
	}
}

func readSource(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.FromSlash(rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}
