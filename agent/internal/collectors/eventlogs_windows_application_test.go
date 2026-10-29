package collectors

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestWinEventFilterStdout(t *testing.T) {
	jsonOutput := []byte(`[{"ProviderName":"MsiInstaller","Id":1033}]`)
	exitErr := errors.New("exit status 1")
	for _, tc := range []struct {
		name   string
		output []byte
		runErr error
		want   []byte
	}{
		{name: "JSON with error", output: jsonOutput, runErr: exitErr, want: jsonOutput},
		{name: "nil with error", runErr: exitErr},
		{name: "whitespace with error", output: []byte(" \t\r\n"), runErr: exitErr},
		{name: "JSON without error", output: jsonOutput, want: jsonOutput},
		{name: "nil without error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := winEventFilterStdout(tc.output, tc.runErr)
			if !bytes.Equal(got, tc.want) || (got == nil) != (tc.want == nil) {
				t.Errorf("winEventFilterStdout(%q, %v) = %q, want %q", tc.output, tc.runErr, got, tc.want)
			}
		})
	}
}

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

func TestApplicationInfoProviderAllowlistIncludesAPCPowerChute(t *testing.T) {
	// #10493: collect APC PowerChute Business Edition UPS warnings.
	for _, provider := range applicationInfoProviderAllowlist {
		if provider == "APCPBEAgent" {
			return
		}
	}
	t.Fatalf("allowlist must include APCPBEAgent, got %v", applicationInfoProviderAllowlist)
}

func TestApplicationInfoEventsFilterHashtable(t *testing.T) {
	got := applicationInfoEventsFilterHashtable("2026-10-12T00:00:00Z")
	for _, want := range []string{
		"LogName='Application'",
		"ProviderName='MsiInstaller','APCPBEAgent'",
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
