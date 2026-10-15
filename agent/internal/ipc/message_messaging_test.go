package ipc

import (
	"encoding/json"
	"testing"
)

// The Assist helper (Rust, serde camelCase) parses these exact keys; a rename
// here silently breaks the card. Pin the wire shape.
func TestMessageShowWireShape(t *testing.T) {
	raw, err := json.Marshal(MessageShow{
		MessageID: "m", BatchID: "b", Title: "t", Body: "x", Severity: "info",
		RequiresAck: true, ExpiresAt: "2026-10-13T10:00:00Z",
		Branding: MessageBranding{CompanyName: "c", DisplayName: "d", Accent: "#112233"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"messageId":"m","batchId":"b","title":"t","body":"x","severity":"info","requiresAck":true,"expiresAt":"2026-10-13T10:00:00Z","branding":{"companyName":"c","displayName":"d","accent":"#112233"}}`
	if string(raw) != want {
		t.Fatalf("MessageShow JSON =\n%s\nwant\n%s", raw, want)
	}
}

func TestAuthRequestSupportsMessagingIsAdditive(t *testing.T) {
	raw, _ := json.Marshal(AuthRequest{SupportsMessaging: true})
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if m["supportsMessaging"] != true {
		t.Fatalf("supportsMessaging key missing: %s", raw)
	}
	raw, _ = json.Marshal(AuthRequest{})
	var fresh map[string]any
	_ = json.Unmarshal(raw, &fresh)
	if _, ok := fresh["supportsMessaging"]; ok {
		t.Fatalf("an old-style AuthRequest must not carry supportsMessaging: %s", raw)
	}
}

func TestMessagingTypeStrings(t *testing.T) {
	for got, want := range map[string]string{
		TypeMessageShow:      "message_show",
		TypeMessageRetract:   "message_retract",
		TypeMessagePresented: "message_presented",
		TypeMessageAck:       "message_ack",
		TypeMessageDismissed: "message_dismissed",
		ScopeMessaging:       "messaging",
	} {
		if got != want {
			t.Fatalf("got %q want %q", got, want)
		}
	}
}
