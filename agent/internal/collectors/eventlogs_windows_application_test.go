package collectors

import (
	"strings"
	"testing"
)

func TestApplicationInfoProviderAllowlistIsSmallAndStartsWithMsiInstaller(t *testing.T) {
	if len(applicationInfoProviderAllowlist) == 0 || applicationInfoProviderAllowlist[0] != "MsiInstaller" {
		t.Fatalf("allowlist must start with MsiInstaller, got %v", applicationInfoProviderAllowlist)
	}
	// Bounded on purpose (#8174): every entry adds Information-level volume.
	if len(applicationInfoProviderAllowlist) > 10 {
		t.Fatalf("allowlist has %d providers; keep it small", len(applicationInfoProviderAllowlist))
	}
	for _, p := range applicationInfoProviderAllowlist {
		if strings.ContainsAny(p, "'\"`$;") {
			t.Fatalf("provider %q contains characters unsafe in a PowerShell string literal", p)
		}
	}
}

func TestApplicationInfoEventsFilterHashtable(t *testing.T) {
	got := applicationInfoEventsFilterHashtable("2026-10-12T00:00:00Z")
	for _, want := range []string{
		"LogName='Application'",
		"ProviderName='MsiInstaller'",
		// Warning + Information only: levels 1-2 already come from the
		// all-provider Application query, so the two queries never overlap.
		"Level=3,4",
		"StartTime='2026-10-12T00:00:00Z'",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("filter hashtable %q missing %q", got, want)
		}
	}
	// Every allowlisted provider must reach the query, not just the first.
	for _, p := range applicationInfoProviderAllowlist {
		if !strings.Contains(got, "'"+p+"'") {
			t.Errorf("filter hashtable %q missing allowlisted provider %q", got, p)
		}
	}
	if strings.Contains(got, "Level=1") || strings.Contains(got, "Level=2") {
		t.Errorf("filter hashtable %q must not re-query error/critical levels", got)
	}
}
