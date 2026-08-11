package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// gateBootstrapServer is the extracted, testable gate (implemented in Step 3).
func TestGateBootstrapServer_HostedRefusesNonAllowlisted(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	if err := gateBootstrapServer("https://attacker.es"); err == nil {
		t.Fatal("hosted build must refuse non-allowlisted bootstrap server before redeem")
	}
	if err := gateBootstrapServer("https://hosted-a.example"); err != nil {
		t.Fatalf("hosted build must allow allowlisted bootstrap server, got %v", err)
	}
}

func TestGateBootstrapServer_SelfHostAllowsAll(t *testing.T) {
	if err := gateBootstrapServer("https://anything.example"); err != nil {
		t.Fatalf("self-host must allow any bootstrap server, got %v", err)
	}
}

func TestGateRedeemResponse_RefusesRedirectToC2(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	// Attacker points filename at an allowlisted-looking host that redeems and
	// hands back a C2 serverUrl — must be refused before adoption.
	res := bootstrapResult{ServerURL: "https://c2.attacker.es", BackupServerURL: ""}
	if err := gateRedeemResponse(res); err == nil {
		t.Fatal("must refuse redeem-response serverUrl on non-allowlisted host")
	}
	res2 := bootstrapResult{ServerURL: "https://hosted-a.example", BackupServerURL: "https://c2.attacker.es"}
	if err := gateRedeemResponse(res2); err == nil {
		t.Fatal("must refuse redeem-response backupServerUrl on non-allowlisted host")
	}
	res3 := bootstrapResult{ServerURL: "https://hosted-a.example", BackupServerURL: "https://hosted-a.example"}
	if err := gateRedeemResponse(res3); err != nil {
		t.Fatalf("must allow all-allowlisted redeem response, got %v", err)
	}
}
