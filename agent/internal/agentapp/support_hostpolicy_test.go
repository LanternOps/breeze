package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// gateSupportServer is the Quick Support redeem-path gate — the same
// signed-binary-obeys-arbitrary-server primitive bootstrap and enrollment
// already gate, applied to the support-code redeem flow. See
// bootstrap_hostpolicy_test.go for the sibling gates on that path.
func TestGateSupportServer_SelfHostAllowsAny(t *testing.T) {
	if err := gateSupportServer("https://anything.example"); err != nil {
		t.Fatalf("self-host must allow any support server, got %v", err)
	}
	if err := gateSupportServer("https://attacker.es"); err != nil {
		t.Fatalf("self-host must allow any support server, got %v", err)
	}
}

func TestGateSupportServer_HostedRefusesNonAllowlisted(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	if err := gateSupportServer("https://attacker.es"); err == nil {
		t.Fatal("hosted build must refuse a non-allowlisted support server")
	}
	if err := gateSupportServer("https://hosted-a.example"); err != nil {
		t.Fatalf("hosted build must allow the allowlisted support server, got %v", err)
	}
}
