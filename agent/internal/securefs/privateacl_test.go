package securefs

import "testing"

func TestPrivateDACLConforms(t *testing.T) {
	const own = "S-1-5-21-1-2-3-1001"
	created := privateDACLPolicy{
		allowed:          map[string]bool{"SY": true, "BA": true, own: true},
		fullAccess:       map[string]bool{"SY": true, own: true},
		requireProtected: true,
	}
	existing := created
	existing.requireProtected = false

	for _, tc := range []struct {
		name     string
		sddl     string
		created  bool
		existing bool
	}{
		{"protected system and administrators", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + own + ")", true, true},
		{"protected without auto-inherited flag", "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + own + ")", true, true},
		{"inherited system and administrators only", "D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;" + own + ")", false, true},
		{"unprotected explicit allowed entries", "D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;" + own + ")", false, true},
		{"inherited entry for another trustee", "D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;" + own + ")(A;OICIID;0x1200a9;;;BU)", false, false},
		{"another trustee", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;" + own + ")(A;OICI;FA;;;WD)", false, false},
		{"authenticated users", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;" + own + ")(A;OICI;0x1200a9;;;AU)", false, false},
		{"deny entry", "D:PAI(D;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;" + own + ")", false, false},
		{"system read only", "D:PAI(A;OICI;FR;;;SY)(A;OICI;FA;;;" + own + ")", false, false},
		{"service account read only", "D:PAI(A;OICI;FA;;;SY)(A;OICI;FR;;;" + own + ")", false, false},
		{"no system entry", "D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;" + own + ")", false, false},
		{"system full access as a mask", "D:PAI(A;OICI;0x1f01ff;;;SY)(A;OICI;FA;;;" + own + ")", true, true},
		{"not inherited by files", "D:PAI(A;CI;FA;;;SY)(A;OICI;FA;;;" + own + ")", false, false},
		{"not inherited by folders", "D:PAI(A;OI;FA;;;SY)(A;OICI;FA;;;" + own + ")", false, false},
		// Flags are read as two-letter tokens: CI IO ID has no OI token,
		// although "OI" appears across the IO and ID tokens.
		{"no file inheritance flag among other flags", "D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;" + own + ")(A;CIIOID;FA;;;BA)", false, false},
		// CI OI is not inherit-only, although "IO" appears across the CI
		// and OI tokens.
		{"inheritance flags in another order", "D:PAI(A;CIOI;FA;;;SY)(A;OICI;FA;;;" + own + ")", true, true},
		{"odd-length flags", "D:PAI(A;OICIO;FA;;;SY)(A;OICI;FA;;;" + own + ")", false, false},
		{"null access list", "D:NO_ACCESS_CONTROL", false, false},
		{"empty protected list", "D:PAI", false, false},
		{"missing list", "", false, false},
		{"other section", "O:SYD:PAI(A;OICI;FA;;;SY)", false, false},
		{"malformed entry", "D:PAI(A;OICI;FA;;SY)", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := privateDACLConforms(tc.sddl, created); got != tc.created {
				t.Fatalf("created policy: privateDACLConforms(%q) = %v, want %v", tc.sddl, got, tc.created)
			}
			if got := privateDACLConforms(tc.sddl, existing); got != tc.existing {
				t.Fatalf("existing-root policy: privateDACLConforms(%q) = %v, want %v", tc.sddl, got, tc.existing)
			}
		})
	}
}
