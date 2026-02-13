package mgmtdetect

import (
	"testing"
)

func TestDetectionStatusActive(t *testing.T) {
	d := Detection{Name: "Test", Status: StatusActive}
	if d.Status != StatusActive {
		t.Errorf("expected active, got %s", d.Status)
	}
}

func TestDetectionStatusInstalled(t *testing.T) {
	d := Detection{Name: "Test", Status: StatusInstalled}
	if d.Status != StatusInstalled {
		t.Errorf("expected installed, got %s", d.Status)
	}
}

func TestCheckTypeConstants(t *testing.T) {
	checks := []CheckType{
		CheckFileExists, CheckServiceRunning, CheckProcessRunning,
		CheckRegistryValue, CheckCommand, CheckLaunchDaemon,
	}
	seen := make(map[CheckType]bool)
	for _, c := range checks {
		if seen[c] {
			t.Errorf("duplicate check type: %s", c)
		}
		seen[c] = true
		if c == "" {
			t.Error("empty check type constant")
		}
	}
}

func TestSignatureMatchesOS(t *testing.T) {
	sig := Signature{Name: "Test", OS: []string{"windows", "darwin"}}
	if !sig.MatchesOS("windows") {
		t.Error("should match windows")
	}
	if !sig.MatchesOS("darwin") {
		t.Error("should match darwin")
	}
	if sig.MatchesOS("linux") {
		t.Error("should not match linux")
	}
}

func TestCategoryConstants(t *testing.T) {
	cats := []Category{
		CategoryMDM, CategoryRMM, CategoryRemoteAccess,
		CategoryEndpointSecurity, CategoryPolicyEngine, CategoryBackup,
		CategoryIdentityMFA, CategorySIEM, CategoryDNSFiltering,
		CategoryZeroTrustVPN, CategoryPatchManagement,
	}
	if len(cats) != 11 {
		t.Errorf("expected 11 categories, got %d", len(cats))
	}
}
