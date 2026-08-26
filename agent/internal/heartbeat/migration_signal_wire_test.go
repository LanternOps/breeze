package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// TestHeartbeatPayloadWireSelfHostSignal pins the wire contract on the
// build-edition telemetry fields at the JSON layer, which is the only layer
// where it actually matters.
//
// Since #4072 a self-host build MUST put agentEdition:"self-host" on the
// wire: the server treats a reported edition (either value) as "this build
// can accept hosted-edition artifacts" and withholds hosted update offers
// from agents that stay silent (a silent self-host build ≥0.105.0 would
// hard-refuse them and wedge in a permanent retry loop). A regression back
// to the empty string would silently re-strand every future self-host agent
// that later migrates to a hosted control plane. migrationRequired keeps the
// old omitempty contract — false must stay off the wire.
func TestHeartbeatPayloadWireSelfHostSignal(t *testing.T) {
	var payload HeartbeatPayload
	payload.AgentEdition, payload.MigrationRequired = migrationSignal("https://selfhosted.example", "")

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal self-host payload: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal self-host payload: %v", err)
	}
	if decoded["agentEdition"] != "self-host" {
		t.Errorf("self-host build: agentEdition = %v, want %q (#4072 transition-capability signal)",
			decoded["agentEdition"], "self-host")
	}
	if strings.Contains(string(body), `"migrationRequired"`) {
		t.Errorf("self-host heartbeat payload must not carry \"migrationRequired\" on the wire " +
			"(omitempty dropped from the struct tag?)")
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
	payload.AgentEdition, payload.MigrationRequired = migrationSignal("https://selfhosted.example", "")

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
