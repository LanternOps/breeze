package providers

import (
	"regexp"
	"strings"
	"testing"
)

var accessEntryPattern = regexp.MustCompile(`\(([^)]*)\)`)

// privateACLEntryViolation returns the first access entry in sddl, the string
// form of a DACL, that is not an allow entry for a trustee isAllowed accepts,
// or "" when every entry is. A DACL without entries is reported as well.
//
// The trustee is passed exactly as SDDL renders it. SDDL writes a well-known
// account as its alias (the built-in Administrator account is "LA", SYSTEM is
// "SY") and any other account as an S-1-... string, so isAllowed has to
// resolve the text to a SID rather than compare it with a SID string.
func privateACLEntryViolation(sddl string, isAllowed func(trustee string) bool) string {
	entries := accessEntryPattern.FindAllStringSubmatch(sddl, -1)
	if len(entries) == 0 {
		return "empty access list"
	}
	for _, entry := range entries {
		fields := strings.Split(entry[1], ";")
		if len(fields) != 6 || fields[0] != "A" || !isAllowed(fields[5]) {
			return entry[0]
		}
	}
	return ""
}

// TestPrivateACLEntryViolation runs the entry check with a resolver that
// renders trustees the way SDDL does, for an agent running as the built-in
// Administrator account.
func TestPrivateACLEntryViolation(t *testing.T) {
	const (
		system         = "S-1-5-18"
		administrators = "S-1-5-32-544"
		own            = "S-1-5-21-1-2-3-500"
		otherAccount   = "S-1-5-21-1-2-3-1001"
	)
	aliases := map[string]string{"SY": system, "BA": administrators, "LA": own, "WD": "S-1-1-0", "BU": "S-1-5-32-545"}
	allowedSIDs := map[string]bool{system: true, administrators: true, own: true}
	isAllowed := func(trustee string) bool {
		sid, ok := aliases[trustee]
		if !ok {
			if !strings.HasPrefix(trustee, "S-1-") {
				return false
			}
			sid = trustee
		}
		return allowedSIDs[sid]
	}

	for _, tc := range []struct {
		name string
		sddl string
		want string
	}{
		{"own account rendered as an alias", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)", ""},
		{"own account rendered as a SID", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + own + ")", ""},
		{"inherited entries", "D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;LA)", ""},
		{"everyone", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)(A;OICI;FA;;;WD)", "(A;OICI;FA;;;WD)"},
		{"users", "D:PAI(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)", "(A;OICI;0x1200a9;;;BU)"},
		{"another account", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;" + otherAccount + ")", "(A;OICI;FA;;;" + otherAccount + ")"},
		{"unknown alias", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LG)", "(A;OICI;FA;;;LG)"},
		{"deny entry", "D:PAI(D;OICI;FA;;;SY)(A;OICI;FA;;;LA)", "(D;OICI;FA;;;SY)"},
		{"malformed entry", "D:PAI(A;OICI;FA;;LA)", "(A;OICI;FA;;LA)"},
		{"no entries", "D:PAI", "empty access list"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := privateACLEntryViolation(tc.sddl, isAllowed); got != tc.want {
				t.Fatalf("privateACLEntryViolation(%q) = %q, want %q", tc.sddl, got, tc.want)
			}
		})
	}
}
