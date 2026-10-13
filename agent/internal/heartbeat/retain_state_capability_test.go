package heartbeat

import (
	"encoding/json"
	"testing"
)

// A build that honours HeartbeatResponse.RetainState (#8258) must declare
// retainStateProtocolVersion on every beat, under the exact JSON key the API
// reads: the API sends retainState only to a beat advertising exactly 1, so a
// dropped or renamed declaration silently returns the agent to legacy
// semantics.
func TestHeartbeatDeclaresRetainStateCapability(t *testing.T) {
	caps := compiledSecurityCapabilities()
	if caps.RetainStateProtocolVersion != 1 {
		t.Fatalf("RetainStateProtocolVersion = %d, want 1", caps.RetainStateProtocolVersion)
	}

	body, err := json.Marshal(HeartbeatPayload{SecurityCapabilities: caps})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		SecurityCapabilities map[string]any `json:"securityCapabilities"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got, ok := decoded.SecurityCapabilities["retainStateProtocolVersion"]
	if !ok {
		t.Fatalf("retainStateProtocolVersion key missing: %v", decoded.SecurityCapabilities)
	}
	if got != float64(1) {
		t.Fatalf("retainStateProtocolVersion = %v, want 1", got)
	}
}
