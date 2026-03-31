package clipboard

import (
	"encoding/json"
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
