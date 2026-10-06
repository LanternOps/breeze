package heartbeat

import (
	"encoding/json"
	"testing"
)

// The API refuses a desktop start against an agent reporting
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

// The WebSocket desktop fallback (desktop_stream_start) honours the same start
// fence from this build on. Declared separately so the API can require it on
// that path later without another agent release; older fence-capable builds
// report desktopFenceProtocolVersion 1 but ignore the generation there.
func TestHeartbeatDeclaresDesktopWsFenceCapability(t *testing.T) {
	caps := compiledSecurityCapabilities()
	if caps.DesktopWsFenceProtocolVersion != 1 {
		t.Fatalf("DesktopWsFenceProtocolVersion = %d, want 1", caps.DesktopWsFenceProtocolVersion)
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
	if got := decoded.SecurityCapabilities["desktopWsFenceProtocolVersion"]; got != float64(1) {
		t.Fatalf("desktopWsFenceProtocolVersion = %v, want 1 (caps=%v)", got, decoded.SecurityCapabilities)
	}
}
