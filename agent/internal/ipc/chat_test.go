package ipc

import (
	"encoding/json"
	"testing"
)

// The Assist helper (Rust, serde camelCase) parses these exact keys and type
// strings (#8743). Pin them.
func TestChatTypeStrings(t *testing.T) {
	for got, want := range map[string]string{
		TypeChatOpen:        "chat_open",
		TypeChatMessage:     "chat_message",
		TypeChatClose:       "chat_close",
		TypeChatReply:       "chat_reply",
		TypeChatPresented:   "chat_presented",
		TypeChatReplyResult: "chat_reply_result",
		ScopeChat:           "chat",
	} {
		if got != want {
			t.Fatalf("got %q want %q", got, want)
		}
	}
}

func TestChatShowWireShape(t *testing.T) {
	raw, err := json.Marshal(ChatShow{
		ConversationID: "c", AllowReply: true,
		Branding: MessageBranding{CompanyName: "co", DisplayName: "d", Accent: "#112233"},
		Messages: []ChatMessage{{MessageID: "m", Direction: "to_user", Body: "hi", SenderName: "Tech", SentAt: "2026-10-17T10:00:00Z"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"conversationId":"c","allowReply":true,"branding":{"companyName":"co","displayName":"d","accent":"#112233"},"messages":[{"messageId":"m","direction":"to_user","body":"hi","senderName":"Tech","sentAt":"2026-10-17T10:00:00Z"}],"replay":false,"closed":false}`
	if string(raw) != want {
		t.Fatalf("ChatShow JSON =\n%s\nwant\n%s", raw, want)
	}
}

func TestChatSmallPayloadWireShapes(t *testing.T) {
	cases := map[string]any{
		`{"conversationId":"c","reason":"technician"}`:             ChatClose{ConversationID: "c", Reason: "technician"},
		`{"conversationId":"c","clientNonce":"n","body":"b"}`:      ChatReply{ConversationID: "c", ClientNonce: "n", Body: "b"},
		`{"conversationId":"c","messageId":"m","status":"failed"}`: ChatPresented{ConversationID: "c", MessageID: "m", Status: "failed"},
		`{"conversationId":"c","clientNonce":"n","status":"sent"}`: ChatReplyResult{ConversationID: "c", ClientNonce: "n", Status: "sent"},
		`{"conversationId":"c","status":""}`:                       ChatPresented{ConversationID: "c"},
	}
	for want, v := range cases {
		raw, _ := json.Marshal(v)
		if string(raw) != want {
			t.Fatalf("got %s want %s", raw, want)
		}
	}
}

func TestAuthRequestSupportsChatIsAdditive(t *testing.T) {
	raw, _ := json.Marshal(AuthRequest{SupportsChat: true})
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if m["supportsChat"] != true {
		t.Fatalf("supportsChat key missing: %s", raw)
	}
	raw, _ = json.Marshal(AuthRequest{})
	m = nil
	_ = json.Unmarshal(raw, &m)
	if _, ok := m["supportsChat"]; ok {
		t.Fatalf("old-style AuthRequest must not carry supportsChat: %s", raw)
	}
}
