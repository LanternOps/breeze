// agent/internal/hostpolicy/hostpolicy_test.go
package hostpolicy

import "testing"

func TestSelfHostDefaultAllowsEverything(t *testing.T) {
	// Repo default: allowedHosts is empty => self-host => unrestricted.
	if Enforced() {
		t.Fatalf("repo default must be self-host (Enforced()=false), got hosted")
	}
	if Mode() != "self-host" {
		t.Fatalf("Mode()=%q, want self-host", Mode())
	}
	for _, h := range []string{"anything.example", "attacker.es", ""} {
		if !AllowedHost(h) {
			t.Errorf("self-host must allow %q", h)
		}
	}
	if err := AllowedURL("https://attacker.es/x"); err != nil {
		t.Errorf("self-host AllowedURL must be nil, got %v", err)
	}
}

// TestCommittedLdflagVarsAreEmpty pins the repo-default contract for BOTH
// injected vars, not just allowedHosts. A committed non-empty allowedHosts
// would violate the CLAUDE.md "no internal infrastructure details in public
// code" rule; a committed non-empty strictMode would arm the hard-fail tier
// for every self-hosted build the moment an allowlist appeared. Both must be
// injected at build time only, so both are asserted here.
func TestCommittedLdflagVarsAreEmpty(t *testing.T) {
	if allowedHosts != "" {
		t.Errorf("committed allowedHosts must be empty, got %q "+
			"(hosted values are injected by the release pipeline, never committed)", allowedHosts)
	}
	if strictMode != "" {
		t.Errorf("committed strictMode must be empty, got %q "+
			"(strict is a build-time opt-in, never the repo default)", strictMode)
	}
	if Strict() {
		t.Error("repo default must not be strict")
	}
}

func TestHostedExactMatchAndSuffixAttack(t *testing.T) {
	restore := SetAllowedHostsForTest("hosted-a.example, hosted-b.example")
	defer restore()

	if !Enforced() || Mode() != "hosted-gap" {
		t.Fatalf("expected hosted-gap mode after allowlist override, got %q", Mode())
	}
	if Strict() {
		t.Fatal("strict must be false when only the allowlist is set (gap build)")
	}
	// Allowed: exact, case-insensitive, with port.
	for _, ok := range []string{
		"https://hosted-a.example/api",
		"https://HOSTED-A.Example/api",
		"https://hosted-b.example:443/api",
	} {
		if err := AllowedURL(ok); err != nil {
			t.Errorf("AllowedURL(%q) should pass, got %v", ok, err)
		}
	}
	// Refused: suffix attack, subdomain injection, lookalike, unparseable.
	for _, bad := range []string{
		"https://hosted-a.example.evil.com/api", // suffix attack
		"https://hosted-a.example.evil.com",     // suffix attack
		"https://evil-hosted-a.example",         // not exact
		"https://app.hosted-a.example",          // sibling not allowlisted
		"https://attacker.es",
		"://nonsense",
	} {
		if err := AllowedURL(bad); err == nil {
			t.Errorf("AllowedURL(%q) must be refused in hosted mode", bad)
		}
	}
}

func TestHostedRejectsUnparseableAndEmpty(t *testing.T) {
	restore := SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	for _, bad := range []string{"", "   ", "not a url", "https://"} {
		if err := AllowedURL(bad); err == nil {
			t.Errorf("hosted AllowedURL(%q) must error", bad)
		}
	}
}

func TestStrictModeGate(t *testing.T) {
	// Strict is meaningless without an allowlist.
	rs := SetStrictModeForTest(true)
	defer rs()
	if Strict() {
		t.Fatal("Strict() must be false in self-host even with strictMode set")
	}
	ra := SetAllowedHostsForTest("hosted-a.example")
	defer ra()
	if !Strict() || Mode() != "hosted-strict" {
		t.Fatalf("expected hosted-strict when both set, got Strict()=%v Mode()=%q", Strict(), Mode())
	}
}
