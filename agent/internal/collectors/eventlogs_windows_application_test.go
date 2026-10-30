package collectors

import (
	"strings"
	"testing"
)

func TestApplicationInfoProviderAllowlistIsSmallAndStartsWithMsiInstaller(t *testing.T) {
	if len(applicationInfoProviderAllowlist) == 0 || applicationInfoProviderAllowlist[0] != "MsiInstaller" {
		t.Fatalf("allowlist must start with MsiInstaller, got %v", applicationInfoProviderAllowlist)
	}
	// Bounded on purpose (#8174): every entry adds Information-level volume.
	if len(applicationInfoProviderAllowlist) > 10 {
		t.Fatalf("allowlist has %d providers; keep it small", len(applicationInfoProviderAllowlist))
	}
	for _, p := range applicationInfoProviderAllowlist {
		if strings.ContainsAny(p, "'\"`$;") {
			t.Fatalf("provider %q contains characters unsafe in a PowerShell string literal", p)
		}
	}
}

func TestApplicationInfoProviderAllowlistIncludesAPCPowerChute(t *testing.T) {
	// #10493: collect APC PowerChute Business Edition UPS warnings.
	for _, provider := range applicationInfoProviderAllowlist {
		if provider == "APCPBEAgent" {
			return
		}
	}
	t.Fatalf("allowlist must include APCPBEAgent, got %v", applicationInfoProviderAllowlist)
}
