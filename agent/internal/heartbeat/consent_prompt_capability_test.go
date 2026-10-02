package heartbeat

import (
	"encoding/json"
	"testing"
)

// The API refuses to start a desktop session that requires a consent dialog
// or on-screen notice against an agent reporting consentPromptProtocolVersion
// 0, so a build that parses and gates on the `prompt` block
// (parseDesktopPrompt, handlers_desktop.go) MUST declare the capability on
// every beat — under the exact JSON key the server's heartbeat schema reads.
// Same contract as desktopFenceProtocolVersion. Version 2 additionally
// reports whether the prompt was shown and answered, and whether anyone is
// signed in to the captured session, so the server can tell a truthful report
// from a version 1 one.
func TestHeartbeatDeclaresConsentPromptCapability(t *testing.T) {
	caps := compiledSecurityCapabilities()
	if caps.ConsentPromptProtocolVersion != 2 {
		t.Fatalf("ConsentPromptProtocolVersion = %d, want 2", caps.ConsentPromptProtocolVersion)
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
	got, ok := decoded.SecurityCapabilities["consentPromptProtocolVersion"]
	if !ok {
		t.Fatalf("consentPromptProtocolVersion key missing: %v", decoded.SecurityCapabilities)
	}
	if got != float64(2) {
		t.Fatalf("consentPromptProtocolVersion = %v, want 2", got)
	}
}
