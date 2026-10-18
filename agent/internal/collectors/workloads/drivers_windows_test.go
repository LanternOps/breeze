package workloads

import "testing"

func TestWindowsRegistersDockerAndHyperV(t *testing.T) {
	got := map[Runtime]bool{}
	for _, d := range DefaultDrivers() {
		got[d.Runtime()] = true
	}
	if !got[RuntimeDocker] || !got[RuntimeHyperV] || len(got) != 2 {
		t.Fatalf("registered %v, want docker and hyperv", got)
	}
}

// The production driver must point at an absolute System32 PowerShell that the
// read-only allowlist accepts with the fixed script.
func TestWindowsHyperVDriverUsesAllowlistedPowerShell(t *testing.T) {
	d, ok := newHyperVDriver().(*hypervDriver)
	if !ok {
		t.Fatal("newHyperVDriver did not return *hypervDriver")
	}
	if !allowedCommand(d.powershell, hypervArgs) {
		t.Fatalf("powershell path %q is not allowlisted", d.powershell)
	}
	if d.service == nil || d.version == nil || d.run == nil || d.now == nil {
		t.Fatalf("driver wiring: %+v", d)
	}
}
