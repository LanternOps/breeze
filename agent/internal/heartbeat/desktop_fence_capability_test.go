package heartbeat

import (
	"encoding/json"
	"testing"
)

// The API (SEC-038 W06) refuses a desktop start against an agent reporting
// desktopFenceProtocolVersion 0 once REMOTE_DESKTOP_FENCE_REQUIRED is on, so
// a build that carries the durable start fence (W04/W05) MUST declare the
// capability on every beat — under the exact JSON key the server's heartbeat
// schema reads. Same contract as revocationLeaseProtocolVersion (#5481).
func TestHeartbeatDeclaresDesktopFenceCapability(t *testing.T) {
	caps := compiledSecurityCapabilities()
	if caps.DesktopFenceProtocolVersion != 1 {
		t.Fatalf("DesktopFenceProtocolVersion = %d, want 1", caps.DesktopFenceProtocolVersion)
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
	got, ok := decoded.SecurityCapabilities["desktopFenceProtocolVersion"]
	if !ok {
		t.Fatalf("desktopFenceProtocolVersion key missing: %v", decoded.SecurityCapabilities)
	}
	if got != float64(1) {
		t.Fatalf("desktopFenceProtocolVersion = %v, want 1", got)
	}
}
