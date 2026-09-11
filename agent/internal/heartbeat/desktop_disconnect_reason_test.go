package heartbeat

import (
	"strings"
	"testing"
)

// These tests cover the #5300 wiring: a mid-session capture failure recorded
// via Session.StopWithReason/LastStopReason must reach the API in the same
// desk-disconnect command_result the agent already sends on every WebRTC
// peer disconnect, so remote_sessions.errorMessage gets populated the same
// way the startup probe path already does (#5284/#5295).

func TestDesktopDisconnectResultPayload_CarriesReason(t *testing.T) {
	payload := desktopDisconnectResultPayload("sess-1", "GetDIBits failed: Win32 error 87 (0x57)")

	if payload["sessionId"] != "sess-1" {
		t.Errorf("sessionId = %v, want sess-1", payload["sessionId"])
	}
	if payload["event"] != "peer_disconnected" {
		t.Errorf("event = %v, want peer_disconnected", payload["event"])
	}
	got, ok := payload["stopReason"].(string)
	if !ok || got != "GetDIBits failed: Win32 error 87 (0x57)" {
		t.Errorf("stopReason = %v, want the recorded reason", payload["stopReason"])
	}
}

func TestDesktopDisconnectResultPayload_OmitsStopReasonWhenEmpty(t *testing.T) {
	// Every non-#5300 disconnect path (peer-connection grace timeout, lifetime
	// policy, operator stop, darwin handoff) passes "" — the key must be
	// absent entirely, not present-and-empty, so the API's "only fill
	// errorMessage when currently empty" check has a clean signal.
	payload := desktopDisconnectResultPayload("sess-1", "")

	if _, present := payload["stopReason"]; present {
		t.Errorf("stopReason present with value %v, want the key absent for an empty reason", payload["stopReason"])
	}
}

func TestDesktopDisconnectResultPayload_TruncatesOverlongReason(t *testing.T) {
	huge := strings.Repeat("x", desktopStopReasonMaxBytes*3)
	payload := desktopDisconnectResultPayload("sess-1", huge)

	got, ok := payload["stopReason"].(string)
	if !ok {
		t.Fatalf("stopReason missing or not a string: %v", payload["stopReason"])
	}
	if len(got) > desktopStopReasonMaxBytes {
		t.Errorf("stopReason length = %d, want <= %d", len(got), desktopStopReasonMaxBytes)
	}
}
