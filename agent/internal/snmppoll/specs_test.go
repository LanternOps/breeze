package snmppoll

import "testing"

func TestDefaultMode(t *testing.T) {
	tests := []struct{ oid, want string }{
		{"1.3.6.1.2.1.1.3.0", ModeGet},
		{".1.3.6.1.2.1.1.5.0", ModeGet},
		{"1.3.6.1.2.1.43.11.1.1.9", ModeWalk},
		{"1.3.6.1.2.1.2.2.1.2", ModeWalk},
		{"", ModeWalk},
	}
	for _, tt := range tests {
		if got := DefaultMode(tt.oid); got != tt.want {
			t.Errorf("DefaultMode(%q) = %q, want %q", tt.oid, got, tt.want)
		}
	}
}

func TestSpecsFromOIDs(t *testing.T) {
	specs := SpecsFromOIDs([]string{"1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.2.2.1.2"})
	if len(specs) != 2 {
		t.Fatalf("SpecsFromOIDs returned %d specs, want 2", len(specs))
	}
	// Legacy OIDs are ALWAYS `get`: a pre-W02 server never asked for a walk, and
	// inferring one would start bulk-walking production switches on upgrade.
	for i, spec := range specs {
		if spec.Mode != ModeGet {
			t.Errorf("spec %d mode = %q, want %q", i, spec.Mode, ModeGet)
		}
		if spec.Cadence != CadenceFast {
			t.Errorf("spec %d cadence = %q, want %q", i, spec.Cadence, CadenceFast)
		}
		if spec.Name != spec.OID {
			t.Errorf("spec %d name = %q, want the OID %q", i, spec.Name, spec.OID)
		}
	}
}

func TestSpecsFromOIDs_SkipsBlanks(t *testing.T) {
	if got := SpecsFromOIDs([]string{"", "   "}); len(got) != 0 {
		t.Fatalf("SpecsFromOIDs(blanks) = %v, want empty", got)
	}
}

func TestInstanceSuffix(t *testing.T) {
	tests := []struct{ name, base, pdu, want string }{
		{"scalar exact match", "1.3.6.1.2.1.1.3.0", ".1.3.6.1.2.1.1.3.0", ""},
		{"leading dots on both sides", ".1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.1.3.0", ""},
		{"single index", "1.3.6.1.2.1.43.11.1.1.9", ".1.3.6.1.2.1.43.11.1.1.9.1", "1"},
		{"compound index", "1.3.6.1.2.1.43.11.1.1.9", ".1.3.6.1.2.1.43.11.1.1.9.1.1", "1.1"},
		{"unrelated oid", "1.3.6.1.2.1.1.3.0", ".1.3.6.1.2.1.2.2.1.2.1", ""},
		// A sibling whose OID merely starts with the same digits is NOT an
		// instance: 1.3.6.1.2.1.43.11.1.1.90 must not read as instance "0".
		{"digit-prefix sibling is not an instance", "1.3.6.1.2.1.43.11.1.1.9", ".1.3.6.1.2.1.43.11.1.1.90", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := InstanceSuffix(tt.base, tt.pdu); got != tt.want {
				t.Errorf("InstanceSuffix(%q, %q) = %q, want %q", tt.base, tt.pdu, got, tt.want)
			}
		})
	}
}

func TestFindSpecForOID(t *testing.T) {
	specs := []OIDSpec{
		{OID: "1.3.6.1.2.1.43.11.1.1", Name: "prtMarkerSupplies", Mode: ModeWalk},
		{OID: "1.3.6.1.2.1.43.11.1.1.9", Name: "prtMarkerSuppliesLevel", Mode: ModeWalk},
		{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet},
	}

	// Longest base wins, or every supply column collapses into the table root.
	if got := FindSpecForOID(specs, ".1.3.6.1.2.1.43.11.1.1.9.1.1"); got == nil || got.Name != "prtMarkerSuppliesLevel" {
		t.Fatalf("FindSpecForOID(level instance) = %v, want prtMarkerSuppliesLevel", got)
	}
	if got := FindSpecForOID(specs, ".1.3.6.1.2.1.1.3.0"); got == nil || got.Name != "sysUpTime" {
		t.Fatalf("FindSpecForOID(scalar) = %v, want sysUpTime", got)
	}
	if got := FindSpecForOID(specs, ".1.3.6.1.4.1.9999.1"); got != nil {
		t.Fatalf("FindSpecForOID(unknown) = %v, want nil", got)
	}
}
