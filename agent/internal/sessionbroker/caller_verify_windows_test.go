//go:build windows

package sessionbroker

import "testing"

// The real SID→account ownership check: garbage, empty and well-known
// non-matching identities never own a login.
func TestCallerOwnsLoginOSRefusesNonOwners(t *testing.T) {
	for _, tc := range []struct{ sid, user string }{
		{"not-a-sid", "alex"},
		{"", "alex"},
		{"S-1-5-18", ""},
		{"S-1-5-18", "definitely-not-local-system-" + "alex"},
	} {
		if callerOwnsLoginOS(tc.sid, tc.user) {
			t.Errorf("callerOwnsLoginOS(%q, %q) = true", tc.sid, tc.user)
		}
	}
	// LocalSystem resolves to SYSTEM (domain NT AUTHORITY) on every Windows host.
	if !callerOwnsLoginOS("S-1-5-18", "SYSTEM") || !callerOwnsLoginOS("S-1-5-18", `NT AUTHORITY\SYSTEM`) {
		t.Error("S-1-5-18 must own SYSTEM in both bare and qualified form")
	}
}
