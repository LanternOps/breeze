package heartbeat

import "testing"

func TestTopologyDiagnosticCapabilitiesAdvertiseTraceOnlyWhereSupported(t *testing.T) {
	restore := traceCapabilitySupported
	defer func() { traceCapabilitySupported = restore }()
	for _, supported := range []bool{true, false} {
		traceCapabilitySupported = func() bool { return supported }
		found := false
		for _, capability := range topologyDiagnosticCapabilities(true) {
			if capability.Name == "network_trace" {
				found = true
				if capability.Version != 1 || capability.Supported != supported {
					t.Fatalf("network_trace advertised %#v with platform support %v", capability, supported)
				}
			}
			if capability.Name == "network_diagnostic" && !capability.Supported {
				t.Fatal("trace support must not change the base diagnostic capability")
			}
		}
		if !found {
			t.Fatal("network_trace capability missing; an explicit unsupported entry is required")
		}
	}
}
