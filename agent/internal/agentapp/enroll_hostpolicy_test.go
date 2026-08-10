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

// gateEnrollResponseBackup refuses, in a hosted build, an enroll response
// backup control-plane URL outside the compiled allowlist — enforced at
// Enforced() tier (gap AND strict), unlike ValidateBackupServerURL's
// Strict()-only gate on the existing-fleet paths it guards. It runs on the
// raw response field, before resolveBackupServerURL's own validation, so a
// strict build cannot swallow this refusal as a soft "dropped" seed instead.
func TestGateEnrollResponseBackup_EnforcedRefusesNonAllowlisted_Gap(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	// strictMode intentionally left off — a gap build must still refuse a
	// non-allowlisted backup at fresh-enroll time, unlike the existing-fleet
	// ValidateBackupServerURL path.

	if err := gateEnrollResponseBackup("https://attacker.es"); err == nil {
		t.Fatal("gap build must refuse a non-allowlisted enroll-response backup")
	}
}

func TestGateEnrollResponseBackup_EnforcedRefusesNonAllowlisted_Strict(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	if err := gateEnrollResponseBackup("https://attacker.es"); err == nil {
		t.Fatal("strict build must refuse a non-allowlisted enroll-response backup")
	}
}

func TestGateEnrollResponseBackup_HostedAllowsAllowlisted(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example,hosted-b.example")
	defer restore()

	if err := gateEnrollResponseBackup("https://hosted-b.example"); err != nil {
		t.Fatalf("hosted build must allow an allowlisted backup, got %v", err)
	}
}

func TestGateEnrollResponseBackup_SelfHostAllowsAny(t *testing.T) {
	if err := gateEnrollResponseBackup("https://attacker.es"); err != nil {
		t.Fatalf("self-host must never refuse a backup, got %v", err)
	}
}

func TestGateEnrollResponseBackup_EmptyIsNoOp(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	if err := gateEnrollResponseBackup(""); err != nil {
		t.Fatalf("no backup in the response must not be refused, got %v", err)
	}
}
