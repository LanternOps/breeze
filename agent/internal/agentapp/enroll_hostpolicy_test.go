package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

func TestGateEnrollPrimary_HostedAllowlist(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	if err := gateEnrollPrimary("https://evil.example"); err == nil {
		t.Fatal("hosted build must refuse --server on non-allowlisted host")
	}
	if err := gateEnrollPrimary("https://hosted-a.example"); err != nil {
		t.Fatalf("hosted build must allow allowlisted --server, got %v", err)
	}
}

func TestGateEnrollPrimary_SelfHostAllowsAll(t *testing.T) {
	if err := gateEnrollPrimary("https://anything.example"); err != nil {
		t.Fatalf("self-host must allow any --server, got %v", err)
	}
}
