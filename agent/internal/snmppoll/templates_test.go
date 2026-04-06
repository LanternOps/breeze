package snmppoll

import (
	"testing"
)

func TestGetTemplate_CommonOIDsAlwaysIncluded(t *testing.T) {
	types := []string{"router", "switch", "printer", "unknown", ""}
	for _, dt := range types {
		result := GetTemplate(dt)
		if len(result) < len(commonOIDs) {
			t.Fatalf("GetTemplate(%q) returned %d OIDs, want at least %d common OIDs",
				dt, len(result), len(commonOIDs))
		}
		for _, oid := range commonOIDs {
			if !containsOID(result, oid) {
				t.Errorf("GetTemplate(%q) missing common OID %s", dt, oid)
			}
		}
	}
}

func TestGetTemplate_RouterIncludesRouterOIDs(t *testing.T) {
	for _, dt := range []string{"router", "routers", "Router", "ROUTER", " router "} {
		result := GetTemplate(dt)
		for _, oid := range routerOIDs {
			if !containsOID(result, oid) {
				t.Errorf("GetTemplate(%q) missing router OID %s", dt, oid)
			}
		}
	}
}

func TestGetTemplate_SwitchIncludesSwitchOIDs(t *testing.T) {
	for _, dt := range []string{"switch", "switches", "Switch", "SWITCHES", " switch "} {
		result := GetTemplate(dt)
		for _, oid := range switchOIDs {
			if !containsOID(result, oid) {
				t.Errorf("GetTemplate(%q) missing switch OID %s", dt, oid)
			}
		}
	}
}

func TestGetTemplate_PrinterIncludesPrinterOIDs(t *testing.T) {
	for _, dt := range []string{"printer", "printers", "Printer", "PRINTERS", " printer "} {
		result := GetTemplate(dt)
		for _, oid := range printerOIDs {
			if !containsOID(result, oid) {
				t.Errorf("GetTemplate(%q) missing printer OID %s", dt, oid)
			}
		}
	}
}

func TestGetTemplate_UnknownTypeReturnsOnlyCommon(t *testing.T) {
	for _, dt := range []string{"unknown", "firewall", "server", "", "  "} {
		result := GetTemplate(dt)
		if len(result) != len(commonOIDs) {
			t.Errorf("GetTemplate(%q) returned %d OIDs, want exactly %d (common only)",
				dt, len(result), len(commonOIDs))
		}
	}
}

func TestGetTemplate_RouterExcludesSwitchAndPrinter(t *testing.T) {
	result := GetTemplate("router")
	for _, oid := range switchOIDs {
		if containsOID(result, oid) {
			t.Errorf("GetTemplate(\"router\") should not contain switch OID %s", oid)
		}
	}
	for _, oid := range printerOIDs {
		if containsOID(result, oid) {
			t.Errorf("GetTemplate(\"router\") should not contain printer OID %s", oid)
		}
	}
}

func TestGetTemplate_SwitchExcludesRouterAndPrinter(t *testing.T) {
	result := GetTemplate("switch")
	for _, oid := range routerOIDs {
		if containsOID(result, oid) {
			t.Errorf("GetTemplate(\"switch\") should not contain router OID %s", oid)
		}
	}
	for _, oid := range printerOIDs {
		if containsOID(result, oid) {
			t.Errorf("GetTemplate(\"switch\") should not contain printer OID %s", oid)
		}
	}
}

func TestGetTemplate_PrinterExcludesRouterAndSwitch(t *testing.T) {
	result := GetTemplate("printer")
	for _, oid := range routerOIDs {
		if containsOID(result, oid) {
			t.Errorf("GetTemplate(\"printer\") should not contain router OID %s", oid)
		}
	}
	for _, oid := range switchOIDs {
		if containsOID(result, oid) {
			t.Errorf("GetTemplate(\"printer\") should not contain switch OID %s", oid)
		}
	}
}

func TestGetTemplate_ReturnsNewSlice(t *testing.T) {
	a := GetTemplate("router")
	b := GetTemplate("router")
	// Mutate a and verify b is not affected.
	a[0] = "mutated"
	if b[0] == "mutated" {
		t.Fatal("GetTemplate should return a new slice each call, not a shared reference")
	}
}

func TestGetTemplate_DoesNotMutateCommonOIDs(t *testing.T) {
	original := make([]string, len(commonOIDs))
	copy(original, commonOIDs)

	result := GetTemplate("router")
	result[0] = "mutated"

	for i, oid := range commonOIDs {
		if oid != original[i] {
			t.Fatalf("GetTemplate mutated commonOIDs[%d]: got %q, want %q", i, oid, original[i])
		}
	}
}

func TestGetTemplate_ExpectedOIDCounts(t *testing.T) {
	tests := []struct {
		deviceType string
		wantCount  int
	}{
		{"router", len(commonOIDs) + len(routerOIDs)},
		{"switch", len(commonOIDs) + len(switchOIDs)},
		{"printer", len(commonOIDs) + len(printerOIDs)},
		{"unknown", len(commonOIDs)},
	}
	for _, tt := range tests {
		result := GetTemplate(tt.deviceType)
		if len(result) != tt.wantCount {
			t.Errorf("GetTemplate(%q) = %d OIDs, want %d", tt.deviceType, len(result), tt.wantCount)
		}
	}
}

func containsOID(oids []string, target string) bool {
	for _, o := range oids {
		if o == target {
			return true
		}
	}
	return false
}
