//go:build windows

package collectors

import (
	"strings"
	"testing"
)

// TestWindowsVPNServiceQuery runs the real service query (#8763). It pins the
// two things a pure test cannot: PowerShell exits 0 when the Zscaler drivers
// it looks up by name are absent (CI runners have none) — a non-zero exit
// would make vpnServiceSignals drop every provider's service signal — and the
// output really is "Name<TAB>DisplayName" for running services only.
// Selected by name in .github/workflows/ci.yml (Windows collector job).
func TestWindowsVPNServiceQuery(t *testing.T) {
	out, err := windowsVPNServiceListing()
	if err != nil {
		t.Fatalf("service query failed (exit status must be 0 without Zscaler drivers): %v", err)
	}

	foundRPC := false
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		name, display, ok := strings.Cut(line, "\t")
		if !ok || name == "" {
			t.Fatalf("line %q is not Name<TAB>DisplayName", line)
		}
		// RpcSs always runs and its display name is stable across versions.
		if strings.EqualFold(name, "RpcSs") && display == "Remote Procedure Call (RPC)" {
			foundRPC = true
		}
	}
	if !foundRPC {
		t.Fatalf("expected the always-running RpcSs service with its DisplayName in:\n%s", out)
	}
}
