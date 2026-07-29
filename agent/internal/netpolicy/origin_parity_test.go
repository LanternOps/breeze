package netpolicy

import (
	"encoding/json"
	"os"
	"testing"
)

// The Go half of the shared accept-set parity contract. The TS half is
// packages/shared/src/validators/softwareDownloadPolicy.parity.test.ts, and both
// read the SAME fixture file — a table of host spellings checked identically on
// both sides. See the fixture's own "_contract" block for the invariant.
//
// Why this exists (finding C1 of the Wave 6 whole-branch review): the server-side
// Zod validator had no equivalent of isNumericLookingHost, so `https://192.168.1.x`
// — exactly how a tech writes a subnet — validated and persisted, and then
// parseOrigin refused it on the agent. newOriginSet aborts on the first bad entry,
// so one hand-edited allowlist row denied an entire org every managed-software
// install. A fixture shared by both languages is the only thing that keeps the two
// accept-sets from drifting again; a table duplicated per language does not.

type parityCase struct {
	Origin string `json:"origin"`
	// GoAcceptsRaw documents whether parseOrigin takes the operator-typed
	// string. It is NOT the safety property — see TSNormalized.
	GoAcceptsRaw bool `json:"goAcceptsRaw"`
	// TSNormalized is the exact value the TS validator stores, or nil when it
	// rejects. Whatever it stores, parseOrigin MUST accept: that string is what
	// reaches the agent.
	TSNormalized *string `json:"tsNormalized"`
	Note         string  `json:"note"`
}

func loadParityCases(t *testing.T) []parityCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/origin_accept_parity.json")
	if err != nil {
		t.Fatalf("read parity fixture: %v", err)
	}
	var fixture struct {
		Cases []parityCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse parity fixture: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("parity fixture has no cases")
	}
	return fixture.Cases
}

// TestOriginAcceptSetParity_RawMatchesFixture pins parseOrigin's verdict on every
// operator-typed spelling in the fixture, so a change to checkHostShape that
// silently widens or narrows the Go accept-set has to update the shared table (and
// therefore has to be reconciled against the TS side).
func TestOriginAcceptSetParity_RawMatchesFixture(t *testing.T) {
	for _, tc := range loadParityCases(t) {
		t.Run(tc.Origin, func(t *testing.T) {
			_, err := parseOrigin(tc.Origin)
			if tc.GoAcceptsRaw && err != nil {
				t.Fatalf("parseOrigin(%q) = %v, fixture says Go accepts it (%s)", tc.Origin, err, tc.Note)
			}
			if !tc.GoAcceptsRaw && err == nil {
				t.Fatalf("parseOrigin(%q) succeeded, fixture says Go rejects it (%s)", tc.Origin, tc.Note)
			}
		})
	}
}

// TestOriginAcceptSetParity_TSSubsetOfGo is the load-bearing assertion: every
// value the TS validator is allowed to STORE must be parseable here. A failure
// here means the server can persist an allowlist entry that costs the org every
// managed-software install (pre-degradation) or silently narrows its approved set
// to empty (post-degradation).
func TestOriginAcceptSetParity_TSSubsetOfGo(t *testing.T) {
	stored := 0
	for _, tc := range loadParityCases(t) {
		if tc.TSNormalized == nil {
			continue
		}
		stored++
		t.Run(*tc.TSNormalized, func(t *testing.T) {
			if _, err := parseOrigin(*tc.TSNormalized); err != nil {
				t.Fatalf("TS stores %q (from %q) but parseOrigin rejects it: %v (%s)",
					*tc.TSNormalized, tc.Origin, err, tc.Note)
			}
		})
	}
	// Guard against a fixture edited down to nothing but rejection cases, which
	// would make the subset assertion vacuously true.
	if stored < 5 {
		t.Fatalf("parity fixture has only %d storable cases; the subset assertion needs real accept cases to mean anything", stored)
	}
}

// TestOriginAcceptSetParity_NumericLookingHostsRejected states the specific claim
// C1 turned on, independently of the fixture's bookkeeping: a partially-written
// subnet or hex shorthand must never be a parseable origin.
func TestOriginAcceptSetParity_NumericLookingHostsRejected(t *testing.T) {
	for _, host := range []string{"192.168.1.x", "172.16.x.x", "0xdead.beef", "0x1.0x2.ba.be"} {
		if !isNumericLookingHost(host) {
			t.Errorf("isNumericLookingHost(%q) = false, want true", host)
		}
		if _, err := parseOrigin("https://" + host); err == nil {
			t.Errorf("parseOrigin(https://%s) succeeded, want invalid_origin", host)
		}
	}
	// Over-rejection guards: these are real names, not addresses.
	for _, host := range []string{"beef.cafe", "x.x", "files.corp.internal", "cdn-1.example.com"} {
		if isNumericLookingHost(host) {
			t.Errorf("isNumericLookingHost(%q) = true, want false", host)
		}
	}
}
