package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// #8318: this build declares securityCapabilities.rebindProtocolVersion = 1
// on every main and parked heartbeat (the same payload; the server tells them
// apart); exactly 1 is what the API counts. A Quick Support client never
// declares it.
func TestRebindCapabilityIsDeclaredOnEveryBeat(t *testing.T) {
	if got := compiledSecurityCapabilities().RebindProtocolVersion; got != 1 {
		t.Fatalf("compiled rebindProtocolVersion = %d, want 1", got)
	}
	if RebindProtocolVersion != 1 {
		t.Fatalf("RebindProtocolVersion = %d, want 1", RebindProtocolVersion)
	}
	h := &Heartbeat{config: &config.Config{}}
	raw, err := json.Marshal(HeartbeatPayload{Status: "ok", AgentVersion: "1.2.3", SecurityCapabilities: h.securityCapabilitiesForBeat()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"rebindProtocolVersion":1`) {
		t.Fatalf("heartbeat payload does not declare the rebind protocol: %s", raw)
	}

	h.config.SupportMode = true
	raw, _ = json.Marshal(HeartbeatPayload{Status: "ok", AgentVersion: "1.2.3", SecurityCapabilities: h.securityCapabilitiesForBeat()})
	if strings.Contains(string(raw), "rebindProtocolVersion") {
		t.Fatalf("a Quick Support client declares the rebind protocol: %s", raw)
	}
}
