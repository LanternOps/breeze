package biosconfig

import "testing"

// IsWow64Process2 reports the native machine; an x64 agent emulated on ARM64
// must report arm64, never its own GOARCH.
func TestArchOf(t *testing.T) {
	for machine, want := range map[uint16]string{0x8664: "amd64", 0xAA64: "arm64", 0x014c: "x86", 0: "unknown", 0x01c4: "unknown"} {
		if got := archOf(machine); got != want {
			t.Errorf("archOf(%#x) = %q, want %q", machine, got, want)
		}
	}
}
