//go:build windows

package security

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

// These run against the real machine (CI: the elevated windows-latest runner,
// see the "password policy" step in .github/workflows/ci.yml). They are the
// live coverage of #9597: the old Win32_AccountPolicy query failed on every
// Windows build, so a reader that only passes its parser tests proves nothing.

func TestLivePasswordPolicyNetAPI(t *testing.T) {
	got, err := collectPasswordPolicyNetAPI()
	if err != nil {
		t.Fatalf("collectPasswordPolicyNetAPI: %v", err)
	}
	if got["source"] != "netapi" {
		t.Fatalf("source = %v, want netapi", got["source"])
	}
	for _, key := range []string{
		PasswordPolicyKeyMinLength, PasswordPolicyKeyMaxAgeDays, PasswordPolicyKeyMinAgeDays,
		PasswordPolicyKeyHistoryCount, PasswordPolicyKeyLockoutThreshold,
	} {
		if _, ok := got[key].(int); !ok {
			t.Errorf("%s missing or not an int: %#v", key, got)
		}
	}
}

func TestLivePasswordPolicySeceditMatchesNetAPI(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("secedit /export needs an elevated token (the agent runs as SYSTEM)")
	}
	base := t.TempDir()
	prev := seceditExportBaseDir
	seceditExportBaseDir = func() string { return base }
	t.Cleanup(func() { seceditExportBaseDir = prev })

	got, err := collectPasswordPolicySecedit()
	if err != nil {
		t.Fatalf("collectPasswordPolicySecedit: %v", err)
	}
	if got["source"] != "secedit" {
		t.Fatalf("source = %v, want secedit", got["source"])
	}
	if _, ok := got[PasswordPolicyKeyComplexityEnabled].(bool); !ok {
		t.Fatalf("complexityEnabled missing or not a bool: %#v", got)
	}

	// Both sources read the same SAM account policy, so every value they
	// share must agree; a mismatch means one of the two mappings is wrong.
	netapi, err := collectPasswordPolicyNetAPI()
	if err != nil {
		t.Fatalf("collectPasswordPolicyNetAPI: %v", err)
	}
	for _, key := range []string{
		PasswordPolicyKeyMinLength, PasswordPolicyKeyMaxAgeDays, PasswordPolicyKeyMinAgeDays,
		PasswordPolicyKeyHistoryCount, PasswordPolicyKeyLockoutThreshold,
	} {
		if got[key] != netapi[key] {
			t.Errorf("%s: secedit %v, NetUserModalsGet %v", key, got[key], netapi[key])
		}
	}

	// The per-run export directory must be gone afterwards.
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("export directory left behind in %s: %v", base, entries)
	}
}
