package ipc

import (
	"encoding/json"
	"testing"
)

func TestDesktopStartRequestRelayOnlyJSONCompatibility(t *testing.T) {
	t.Run("false is omitted", func(t *testing.T) {
		wire, err := json.Marshal(DesktopStartRequest{SessionID: "desktop-1", RelayOnly: false})
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(wire, &fields); err != nil {
			t.Fatal(err)
		}
		if _, ok := fields["relayOnly"]; ok {
			t.Fatalf("false must be omitted: %s", wire)
		}
	})
	t.Run("old helper ignores true", func(t *testing.T) {
		type oldDesktopStartRequest struct {
			SessionID    string          `json:"sessionId"`
			Offer        string          `json:"offer"`
			ICEServers   json.RawMessage `json:"iceServers,omitempty"`
			DisplayIndex int             `json:"displayIndex"`
		}
		wire, err := json.Marshal(DesktopStartRequest{SessionID: "desktop-1", Offer: "offer", RelayOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(wire, &fields); err != nil {
			t.Fatal(err)
		}
		if string(fields["relayOnly"]) != "true" {
			t.Fatalf("true must be sent: %s", wire)
		}
		var old oldDesktopStartRequest
		if err := json.Unmarshal(wire, &old); err != nil {
			t.Fatal(err)
		}
		if old.SessionID != "desktop-1" || old.Offer != "offer" {
			t.Fatalf("old helper request = %+v", old)
		}
	})
	t.Run("old request defaults false", func(t *testing.T) {
		var req DesktopStartRequest
		if err := json.Unmarshal([]byte(`{"sessionId":"desktop-1","offer":"offer","displayIndex":0}`), &req); err != nil {
			t.Fatal(err)
		}
		if req.RelayOnly {
			t.Fatal("old request must not enable relay-only")
		}
	})
}
