package collectors

import (
	"encoding/json"
	"os"
	"sort"
	"testing"
)

// Cross-language contract for VPN provider ids (#8763). The API's
// vpnProviderSchema is a closed enum and ingest drops an entry whose provider
// it doesn't know without failing the report, so an id that exists here but
// not in packages/shared would simply never appear in the UI. Both sides
// assert against the same fixture; the TS half is
// packages/shared/src/validators/vpnProviders.contract.test.ts.
const vpnProviderFixturePath = "../../../packages/shared/src/fixtures/vpn-providers.json"

// allVPNProviders is every provider id this collector can emit.
var allVPNProviders = []string{
	vpnWireGuard, vpnTailscale, vpnNetBird, vpnZeroTier, vpnOpenVPN, vpnCloudflareWARP,
	vpnZscaler, vpnGlobalProtect, vpnCiscoSecureClient, vpnFortiClient, vpnNetskope,
	vpnGeneric,
}

func TestVPNProvidersMatchSharedContract(t *testing.T) {
	raw, err := os.ReadFile(vpnProviderFixturePath)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		Providers []string `json:"providers"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}

	got := append([]string(nil), allVPNProviders...)
	want := append([]string(nil), fixture.Providers...)
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("agent providers %v != shared contract %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("agent providers %v != shared contract %v", got, want)
		}
	}

	known := make(map[string]bool, len(allVPNProviders))
	for _, p := range allVPNProviders {
		known[p] = true
	}
	tables := map[string]map[string][]string{
		"vpnProcessSignatures":          vpnProcessSignatures,
		"vpnProcessExactNames":          vpnProcessExactNames,
		"vpnServiceSignatures":          vpnServiceSignatures,
		"vpnAgentDescriptionSignatures": vpnAgentDescriptionSignatures,
	}
	for name, table := range tables {
		for provider := range table {
			if !known[provider] {
				t.Errorf("%s has provider %q missing from allVPNProviders", name, provider)
			}
		}
	}
}
