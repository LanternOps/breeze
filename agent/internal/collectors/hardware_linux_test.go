//go:build linux

package collectors

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func swapLspciProbe(t *testing.T, present bool) *int {
	t.Helper()
	detects := 0
	prev := lspciAvailable
	lspciAvailable = newCachedHostProbe(time.Hour, func() bool { detects++; return present })
	t.Cleanup(func() { lspciAvailable = prev })
	return &detects
}

func TestCollectLinuxGPUModelLspciAbsentDoesNotSpawn(t *testing.T) {
	detects := swapLspciProbe(t, false)
	rec := recordCollectorCommands(t)
	for i := 0; i < 3; i++ {
		collectLinuxGPUModel()
	}
	if rec.count() != 0 {
		t.Fatalf("spawned %v with lspci absent", rec.calls)
	}
	if *detects != 1 {
		t.Fatalf("detect ran %d times, want 1", *detects)
	}
}

func TestCollectLinuxGPUModelLspciPresent(t *testing.T) {
	swapLspciProbe(t, true)
	useFakeBinary(t, "lspci", `printf '00:00.0 Host bridge: Intel Corporation Bar\n00:02.0 VGA compatible controller: Intel Corporation Foo\n01:00.0 3D controller: NVIDIA Corp Baz\n'`)
	rec := recordCollectorCommands(t)
	if got := collectLinuxGPUModel(); got != "Intel Corporation Foo" {
		t.Fatalf("got %q", got)
	}
	if rec.count() != 1 {
		t.Fatalf("spawn count %d, want 1", rec.count())
	}
}

func writePCIDevice(t *testing.T, root, name string, files map[string]string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for f, v := range files {
		if err := os.WriteFile(filepath.Join(dir, f), []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGPUModelFromPCISysfs(t *testing.T) {
	dev := func(class, vendor, device string) map[string]string {
		return map[string]string{"class": class, "vendor": vendor, "device": device}
	}
	tests := []struct {
		name    string
		devices map[string]map[string]string
		want    string
	}{
		{"empty dir", nil, ""},
		{"non-gpu skipped", map[string]map[string]string{"0000:00:00.0": dev("0x060000", "0x8086", "0x1234")}, ""},
		{"display controller 0380 not a gpu", map[string]map[string]string{"0000:00:01.0": dev("0x038000", "0x8086", "0x1234")}, ""},
		{"vga intel", map[string]map[string]string{
			"0000:00:00.0": dev("0x060000", "0x8086", "0x1111"),
			"0000:00:02.0": dev("0x030000", "0x8086", "0x9a49")}, "Intel Device 9a49"},
		{"3d nvidia", map[string]map[string]string{"0000:01:00.0": dev("0x030200", "0x10de", "0x1eb8")}, "NVIDIA Device 1eb8"},
		{"amd", map[string]map[string]string{"0000:03:00.0": dev("0x030000", "0x1002", "0x73ff")}, "AMD Device 73ff"},
		{"unknown vendor", map[string]map[string]string{"0000:00:05.0": dev("0x030000", "0x1af4", "0x1050")}, "Device 1af4:1050"},
		{"first match wins", map[string]map[string]string{
			"0000:00:02.0": dev("0x030000", "0x8086", "0x9a49"),
			"0000:01:00.0": dev("0x030200", "0x10de", "0x1eb8")}, "Intel Device 9a49"},
		{"malformed class skipped", map[string]map[string]string{
			"0000:00:02.0": dev("zzz", "0x8086", "0x9a49"),
			"0000:01:00.0": dev("0x030000", "0x10de", "0x1eb8")}, "NVIDIA Device 1eb8"},
		{"missing vendor skipped", map[string]map[string]string{
			"0000:00:02.0": {"class": "0x030000", "device": "0x1"}}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			for name, files := range tc.devices {
				writePCIDevice(t, root, name, files)
			}
			if got := gpuModelFromPCISysfs(root); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
	if got := gpuModelFromPCISysfs(filepath.Join(t.TempDir(), "missing")); got != "" {
		t.Fatalf("missing dir: got %q", got)
	}
}
