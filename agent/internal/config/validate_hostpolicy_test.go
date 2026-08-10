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

// TestValidateTiered_StrictDegradesNonAllowlistedPersistedBackup is the
// LOAD-path degrade: a strict build with an allowlisted primary but a
// non-allowlisted PERSISTED backup must not fatal startup (config load ->
// os.Exit(1) in runAgent/runWatchdog) over an existing-fleet backup that
// predates a hosted flip. It must instead warn and clear the field —
// mirroring the backup==primary self-heal a few lines below in
// ValidateTiered. This is deliberately narrower than
// ValidateBackupServerURL's own Strict()-tier error, which ingestion paths
// (heartbeat configUpdate push, enroll-response adoption, bootstrap redeem
// response) still rely on to reject a NEW non-allowlisted backup outright —
// see TestValidateBackupServerURL_HostedAllowlist_StrictRejects above, which
// calls ValidateBackupServerURL directly and must keep failing.
func TestValidateTiered_StrictDegradesNonAllowlistedPersistedBackup(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	c := &Config{ServerURL: "https://hosted-a.example", BackupServerURL: "https://attacker.es"}
	res := c.ValidateTiered()

	if res.HasFatals() {
		t.Fatalf("strict build must not fatal on a non-allowlisted persisted backup, got fatals: %v", res.Fatals)
	}
	if len(res.Warnings) == 0 {
		t.Fatal("strict build must warn about a non-allowlisted persisted backup being cleared")
	}
	if c.BackupServerURL != "" {
		t.Errorf("non-allowlisted persisted backup must be cleared, got %q", c.BackupServerURL)
	}
}

// TestValidateTiered_StrictNonAllowlistedPrimaryStillFatal is the negative
// control: the primary ServerURL fatal must be completely unaffected by the
// backup degrade above.
func TestValidateTiered_StrictNonAllowlistedPrimaryStillFatal(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	c := &Config{ServerURL: "https://attacker.es"}
	if !c.ValidateTiered().HasFatals() {
		t.Fatal("strict build must still fatal on a non-allowlisted PRIMARY server_url")
	}
}

// TestValidateTiered_GapModeDoesNotClearNonAllowlistedBackup proves gap mode
// must not degrade either: the persisted backup is left untouched, exactly
// like the pre-existing gap-mode primary behavior above. ValidateBackupServerURL
// itself doesn't hostpolicy-check under gap, so this also confirms the load
// path adds no gap-mode enforcement.
func TestValidateTiered_GapModeDoesNotClearNonAllowlistedBackup(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	// strictMode intentionally left off (gap build default).

	c := &Config{ServerURL: "https://hosted-a.example", BackupServerURL: "https://attacker.es"}
	res := c.ValidateTiered()
	if res.HasFatals() {
		t.Fatalf("gap build must not fatal on a non-allowlisted persisted backup, got: %v", res.Fatals)
	}
	if c.BackupServerURL != "https://attacker.es" {
		t.Errorf("gap build must not clear a non-allowlisted persisted backup, got %q", c.BackupServerURL)
	}
}

// TestValidateTiered_GapModeMalformedNonAllowlistedBackupStaysFatal is the
// edge case that makes the degrade's own Strict() guard load-bearing rather
// than redundant: hostpolicy.AllowedURL gates on Enforced() (gap OR strict),
// not Strict(), so a gap build with the allowlist compiled in still sees
// AllowedURL return non-nil for a non-allowlisted host. Without an explicit
// Strict() check in the degrade condition, a persisted backup that is BOTH
// a genuine scheme violation (non-https, non-localhost — unconditionally
// fatal in every build) AND non-allowlisted would be misclassified as the
// hostpolicy case and incorrectly warn+cleared in gap mode instead of
// fataling like every other malformed backup.
func TestValidateTiered_GapModeMalformedNonAllowlistedBackupStaysFatal(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	// strictMode intentionally left off (gap build default).

	c := &Config{ServerURL: "https://hosted-a.example", BackupServerURL: "http://attacker.es"}
	res := c.ValidateTiered()
	if !res.HasFatals() {
		t.Fatal("gap build must still fatal on a malformed (non-https) backup, even when it is also non-allowlisted")
	}
	if c.BackupServerURL != "http://attacker.es" {
		t.Errorf("a fatal validation failure must not clear the field, got %q", c.BackupServerURL)
	}
}
