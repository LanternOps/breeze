package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// TestHeartbeatPayloadWireByteIdentity pins the omitempty contract on the
// build-edition telemetry fields at the JSON layer, which is the only layer
// where it actually matters.
//
// TestMigrationSignal asserts migrationSignal() returns ("", false) for a
// self-host build, but that is a Go-level claim: dropping `omitempty` from
// either struct tag would leave it green while every self-hosted agent in
// the field silently starts sending two new keys. The whole point of the
// zero values is that the wire payload stays byte-identical to pre-edition
// agents, so assert on the marshalled bytes.
func TestHeartbeatPayloadWireByteIdentity(t *testing.T) {
	var payload HeartbeatPayload
	payload.AgentEdition, payload.MigrationRequired = migrationSignal("https://selfhosted.example")

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal self-host payload: %v", err)
	}
	for _, key := range []string{`"agentEdition"`, `"migrationRequired"`} {
		if strings.Contains(string(body), key) {
			t.Errorf("self-host heartbeat payload must not carry %s on the wire "+
				"(omitempty dropped from the struct tag?)", key)
		}
	}
}

// TestHeartbeatPayloadWireHostedSignal is the other half of the contract: a
// hosted build talking to a non-allowlisted server MUST put both keys on the
// wire, or the server never learns the device needs migrating and the
// dashboard banner never fires.
func TestHeartbeatPayloadWireHostedSignal(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	var payload HeartbeatPayload
	payload.AgentEdition, payload.MigrationRequired = migrationSignal("https://selfhosted.example")

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal hosted payload: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal hosted payload: %v", err)
	}
	if decoded["agentEdition"] != "hosted" {
		t.Errorf("hosted build: agentEdition = %v, want %q", decoded["agentEdition"], "hosted")
	}
	if decoded["migrationRequired"] != true {
		t.Errorf("hosted build on a non-allowlisted server: migrationRequired = %v, want true",
			decoded["migrationRequired"])
	}
}
