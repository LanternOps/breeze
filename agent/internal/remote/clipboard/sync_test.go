package clipboard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

type stubProvider struct {
	content Content
	sets    int
}

func (p *stubProvider) GetContent() (Content, error) {
	return p.content, nil
}

func (p *stubProvider) SetContent(content Content) error {
	p.content = content
	p.sets++
	return nil
}

func TestClipboardReceiveRejectsOversizedEnvelope(t *testing.T) {
	provider := &stubProvider{}
	syncer := NewClipboardSync(nil, provider)

	msg := webrtc.DataChannelMessage{
		IsString: true,
		Data:     []byte(strings.Repeat("a", maxClipboardMessageBytes+1)),
	}

	if err := syncer.Receive(msg); err == nil {
		t.Fatal("expected oversized clipboard envelope to be rejected")
	}
	if provider.sets != 0 {
		t.Fatalf("expected provider to remain untouched, got %d set calls", provider.sets)
	}
}

func TestClipboardReceiveRejectsOversizedText(t *testing.T) {
	provider := &stubProvider{}
	syncer := NewClipboardSync(nil, provider)

	payload, err := json.Marshal(clipboardPayload{
		Type: ContentTypeText,
		Text: strings.Repeat("a", maxClipboardTextBytes+1),
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	msg := webrtc.DataChannelMessage{
		IsString: true,
		Data:     payload,
	}

	if err := syncer.Receive(msg); err == nil {
		t.Fatal("expected oversized clipboard text to be rejected")
	}
	if provider.sets != 0 {
		t.Fatalf("expected provider to remain untouched, got %d set calls", provider.sets)
	}
}

func TestValidateClipboardContentRejectsOversizedImage(t *testing.T) {
	err := ValidateContent(Content{
		Type:  ContentTypeImage,
		Image: make([]byte, maxClipboardImageBytes+1),
	})
	if err == nil {
		t.Fatal("expected oversized clipboard image to be rejected")
	}
}

type mockSender struct {
	sent []string
}

func (m *mockSender) SendText(s string) error {
	m.sent = append(m.sent, s)
	return nil
}

type failingProvider struct{}

func (p *failingProvider) GetContent() (Content, error) { return Content{}, nil }
func (p *failingProvider) SetContent(_ Content) error   { return errors.New("set failed") }

func TestClipboardReceiveSendsAckAfterSuccessfulSet(t *testing.T) {
	sender := &mockSender{}
	provider := &stubProvider{}
	syncer := newClipboardSyncWithSender(sender, provider)

	text := "test ack content"
	payload, err := json.Marshal(clipboardPayload{
		Type: ContentTypeText,
		Text: text,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	msg := webrtc.DataChannelMessage{IsString: true, Data: payload}
	if err := syncer.Receive(msg); err != nil {
		t.Fatalf("Receive returned error: %v", err)
	}

	if len(sender.sent) != 1 {
		t.Fatalf("expected 1 ack message, got %d", len(sender.sent))
	}

	var ack struct {
		Type string `json:"type"`
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal([]byte(sender.sent[0]), &ack); err != nil {
		t.Fatalf("ack parse error: %v", err)
	}
	if ack.Type != "ack" {
		t.Errorf("expected ack type 'ack', got %q", ack.Type)
	}

	content := Content{Type: ContentTypeText, Text: text}
	expectedHash := fmt.Sprintf("%x", fingerprint(content))
	if ack.Hash != expectedHash {
		t.Errorf("ack hash mismatch: got %q, want %q", ack.Hash, expectedHash)
	}
}

func TestClipboardAckHashMatchesViewerWireContract(t *testing.T) {
	// WHY: cross-language wire contract — viewer hashes sha256("text" + text);
	// Go fingerprint writes Type then Text then nil RTF/Image/ImageFormat (zero bytes),
	// producing identical input bytes for a text-only payload.
	const text = "test ack content"
	// Precomputed: echo -n "texttest ack content" | sha256sum
	const wantHash = "0a84fcbd48a758b11a31594d499890caef655a12fd09f98dd90839e3945e0745"

	// Verify the literal matches what sha256 produces at test time.
	sum := sha256.Sum256([]byte("text" + text))
	if got := hex.EncodeToString(sum[:]); got != wantHash {
		t.Fatalf("literal hash constant is wrong: got %s", got)
	}

	sender := &mockSender{}
	provider := &stubProvider{}
	syncer := newClipboardSyncWithSender(sender, provider)

	payload, err := json.Marshal(clipboardPayload{Type: ContentTypeText, Text: text})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if err := syncer.Receive(webrtc.DataChannelMessage{IsString: true, Data: payload}); err != nil {
		t.Fatalf("Receive returned error: %v", err)
	}
	if len(sender.sent) != 1 {
		t.Fatalf("expected 1 ack message, got %d", len(sender.sent))
	}
	var ack struct {
		Type string `json:"type"`
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal([]byte(sender.sent[0]), &ack); err != nil {
		t.Fatalf("ack parse error: %v", err)
	}
	if ack.Hash != wantHash {
		t.Errorf("ack hash does not match viewer wire contract: got %q, want %q", ack.Hash, wantHash)
	}
}

func TestClipboardReceiveNoAckOnSetContentFailure(t *testing.T) {
	sender := &mockSender{}
	syncer := newClipboardSyncWithSender(sender, &failingProvider{})

	payload, err := json.Marshal(clipboardPayload{
		Type: ContentTypeText,
		Text: "hello",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	msg := webrtc.DataChannelMessage{IsString: true, Data: payload}
	if err := syncer.Receive(msg); err == nil {
		t.Fatal("expected Receive to return error when SetContent fails")
	}

	if len(sender.sent) != 0 {
		t.Errorf("expected no ack on SetContent failure, got %d messages", len(sender.sent))
	}
}
