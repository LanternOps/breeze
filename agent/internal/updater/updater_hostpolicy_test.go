package updater

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// TestFilterControlPlaneOrigins_Strict verifies that a strict hosted build
// drops any origin outside the compiled allowlist.
func TestFilterControlPlaneOrigins_Strict(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	in := []string{"https://hosted-a.example", "https://stale.attacker.es", ""}
	got := filterControlPlaneOrigins(in)
	want := []string{"https://hosted-a.example"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filterControlPlaneOrigins=%v, want %v", got, want)
	}
}

// TestFilterControlPlaneOrigins_Gap verifies that an existing-fleet gap
// build (allowlist compiled in, but strict mode off) leaves origins
// untouched — matching the runtime GAP-MODEL: identity in self-host AND
// gap, filtering only in strict.
func TestFilterControlPlaneOrigins_Gap(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(false)
	defer restoreStrict()

	in := []string{"https://hosted-a.example", "https://stale.attacker.es", ""}
	got := filterControlPlaneOrigins(in)
	if !reflect.DeepEqual(got, in) {
		t.Fatalf("gap build must not filter origins; got %v, want %v", got, in)
	}
}

// TestFilterControlPlaneOrigins_SelfHostIdentity verifies that a self-host
// build (no compiled allowlist) never filters origins.
func TestFilterControlPlaneOrigins_SelfHostIdentity(t *testing.T) {
	in := []string{"https://a.example", "https://b.example"}
	got := filterControlPlaneOrigins(in)
	if !reflect.DeepEqual(got, in) {
		t.Fatalf("self-host must not filter origins; got %v", got)
	}
}

// TestUpdaterPolicy_StrictExcludesNonAllowlistedBackup proves updaterPolicy
// (the real assembly function every production Updater is built from — see
// New) actually applies filterControlPlaneOrigins to the origins that reach
// netpolicy.Policy.ControlPlaneOrigins, not just that the filter function
// works in isolation.
func TestUpdaterPolicy_StrictExcludesNonAllowlistedBackup(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	cfg := &Config{
		ServerURL:       func() string { return "https://hosted-a.example" },
		BackupServerURL: "https://stale.attacker.es",
	}
	policy := updaterPolicy(cfg)
	want := []string{"https://hosted-a.example"}
	if !reflect.DeepEqual(policy.ControlPlaneOrigins, want) {
		t.Fatalf("strict build: updaterPolicy().ControlPlaneOrigins = %v, want %v (non-allowlisted backup excluded)",
			policy.ControlPlaneOrigins, want)
	}
}

// TestUpdaterPolicy_GapIdentity is the companion: a gap build must pass both
// origins through updaterPolicy unfiltered — matching the runtime GAP-MODEL
// (existing-fleet agents on a gap build keep functioning unchanged).
func TestUpdaterPolicy_GapIdentity(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	// strictMode intentionally left off (gap build default).

	cfg := &Config{
		ServerURL:       func() string { return "https://hosted-a.example" },
		BackupServerURL: "https://stale.attacker.es",
	}
	policy := updaterPolicy(cfg)
	want := []string{"https://hosted-a.example", "https://stale.attacker.es"}
	if !reflect.DeepEqual(policy.ControlPlaneOrigins, want) {
		t.Fatalf("gap build: updaterPolicy().ControlPlaneOrigins = %v, want %v (unfiltered)",
			policy.ControlPlaneOrigins, want)
	}
}
