package heartbeat

import (
	"reflect"
	"testing"
)

func TestCompiledSecurityCapabilitiesExportMatchesTheHeartbeatDeclaration(t *testing.T) {
	got := CompiledSecurityCapabilities()
	if want := compiledSecurityCapabilities(); !reflect.DeepEqual(got, want) {
		t.Fatalf("exported capabilities %+v differ from the heartbeat declaration %+v", got, want)
	}
	// The API refuses remote desktop against revocationLeaseProtocolVersion 0;
	// a zero here would make every simulated agent a degraded one.
	if got.RevocationLeaseProtocolVersion == 0 {
		t.Fatal("RevocationLeaseProtocolVersion is 0")
	}
}
