//go:build windows

package userhelper

import (
	"strings"
	"testing"
)

// TestLookupSIDWithRetry_ReturnsValidSID verifies that the direct-kernel
// SID lookup returns a well-formed Windows SID when called from a normal
// (non-racing) process. The real race bug it fixes — a kernel token that
// isn't yet materialized after CreateProcessAsUser — can't reasonably be
// simulated in a unit test, so this test is primarily a smoke test for
// "the replacement API works at all and doesn't panic under repeated use".
func TestLookupSIDWithRetry_ReturnsValidSID(t *testing.T) {
	cases := []struct {
		name string
	}{
		{name: "first call"},
		{name: "repeat call 1"},
		{name: "repeat call 2"},
		{name: "repeat call 3"},
		{name: "repeat call 4"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sid, err := lookupSIDWithRetry()
			if err != nil {
				t.Fatalf("lookupSIDWithRetry returned error: %v", err)
			}
			if sid == "" {
				t.Fatal("lookupSIDWithRetry returned empty SID")
			}
			if !strings.HasPrefix(sid, "S-1-5-") {
				t.Errorf("SID %q does not have expected S-1-5- prefix", sid)
			}
			if !looksLikeSID(sid) {
				t.Errorf("SID %q did not pass looksLikeSID", sid)
			}
		})
	}
}

// TestQueryProcessSID_NoPanicInTightLoop calls the direct kernel query in
// a tight loop to confirm we're not leaking token handles and don't panic.
func TestQueryProcessSID_NoPanicInTightLoop(t *testing.T) {
	for i := 0; i < 200; i++ {
		sid, err := queryProcessSID()
		if err != nil {
			t.Fatalf("iteration %d: queryProcessSID error: %v", i, err)
		}
		if !looksLikeSID(sid) {
			t.Fatalf("iteration %d: SID %q not SID-shaped", i, sid)
		}
	}
}

// TestLookupUsernameDirect_ReturnsDomainUser verifies the GetUserNameEx
// wrapper returns a non-empty username. Format is typically DOMAIN\user
// (SAM compatible), but this test only asserts non-empty to stay robust
// across runner identities (SYSTEM, user, CI service account, etc).
func TestLookupUsernameDirect_ReturnsDomainUser(t *testing.T) {
	uname, err := lookupUsernameDirect()
	if err != nil {
		t.Fatalf("lookupUsernameDirect error: %v", err)
	}
	if uname == "" {
		t.Fatal("lookupUsernameDirect returned empty string")
	}
}
