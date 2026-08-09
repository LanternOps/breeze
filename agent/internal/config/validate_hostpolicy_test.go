package config

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// GAP-MODEL: this is an existing-fleet runtime path. Enforcement must gate on
// hostpolicy.Strict() (allowlist set AND strictMode on), not Enforced()
// (allowlist set alone). A gap build (allowlist set, strict off) must keep
// accepting non-allowlisted backup/primary URLs — the migration is signaled
// elsewhere, not enforced on this path. Only the later strict build rejects
// them. See hostpolicy package docs and Task 4 brief GAP-MODEL banner.

func TestValidateBackupServerURL_HostedAllowlist_StrictRejects(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example,hosted-b.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	if err := ValidateBackupServerURL("https://attacker.es"); err == nil {
		t.Fatal("strict hosted build must reject non-allowlisted backup_server_url")
	}
	if err := ValidateBackupServerURL("https://hosted-b.example"); err != nil {
		t.Fatalf("strict hosted build must accept allowlisted backup, got %v", err)
	}
	if err := ValidateBackupServerURL(""); err != nil {
		t.Fatalf("empty backup must remain valid (clears backup), got %v", err)
	}
}

func TestValidateBackupServerURL_GapModeAcceptsNonAllowlisted(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example,hosted-b.example")
	defer restoreHosts()
	// strictMode intentionally left off (gap build default).

	if err := ValidateBackupServerURL("https://attacker.es"); err != nil {
		t.Fatalf("gap build must accept non-allowlisted backup_server_url (no hard enforcement yet), got %v", err)
	}
}

func TestValidateBackupServerURL_SelfHostUnrestricted(t *testing.T) {
	if err := ValidateBackupServerURL("https://anything.example"); err != nil {
		t.Fatalf("self-host must accept any https backup, got %v", err)
	}
}

func TestValidateTiered_HostedRejectsNonAllowlistedPrimary_Strict(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	c := &Config{ServerURL: "https://attacker.es"}
	res := c.ValidateTiered()
	if !res.HasFatals() {
		t.Fatal("strict hosted build must fatal on non-allowlisted server_url")
	}

	c2 := &Config{ServerURL: "https://hosted-a.example"}
	if c2.ValidateTiered().HasFatals() {
		t.Fatal("strict hosted build must accept allowlisted server_url")
	}
}

func TestValidateTiered_GapModeAcceptsNonAllowlistedPrimary(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	// strictMode intentionally left off (gap build default).

	c := &Config{ServerURL: "https://attacker.es"}
	if c.ValidateTiered().HasFatals() {
		t.Fatal("gap build must accept non-allowlisted server_url (no hard enforcement yet)")
	}
}
