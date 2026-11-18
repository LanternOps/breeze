package clipboard

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// relayRoundTrip is the service encoding a user-helper read and the system helper
// decoding it, across a JSON IPC hop.
func relayRoundTrip(t *testing.T, content Content, err error) (Content, error) {
	t.Helper()
	raw, mErr := json.Marshal(RelayResultFromRead(content, err))
	if mErr != nil {
		t.Fatalf("marshal: %v", mErr)
	}
	var res ipc.DesktopClipboardReadResult
	if uErr := json.Unmarshal(raw, &res); uErr != nil {
		t.Fatalf("unmarshal: %v", uErr)
	}
	return ContentFromRelayResult(res)
}

func TestRelayRoundTripKeepsImage(t *testing.T) {
	got, err := relayRoundTrip(t, Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)
	if err != nil || got.Type != ContentTypeImage || got.ImageFormat != "png" || !bytes.Equal(got.Image, pngBytes) {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestRelayRoundTripKeepsTextAndRTF(t *testing.T) {
	got, err := relayRoundTrip(t, Content{Type: ContentTypeText, Text: "héllo"}, nil)
	if err != nil || got.Type != ContentTypeText || got.Text != "héllo" {
		t.Fatalf("text: got %+v, %v", got, err)
	}
	rtf := []byte(`{\rtf1 hi}`)
	got, err = relayRoundTrip(t, Content{Type: ContentTypeRTF, RTF: rtf}, nil)
	if err != nil || got.Type != ContentTypeRTF || !bytes.Equal(got.RTF, rtf) {
		t.Fatalf("rtf: got %+v, %v", got, err)
	}
}

func TestRelayRoundTripKeepsNoSupportedFormat(t *testing.T) {
	_, err := relayRoundTrip(t, Content{}, ErrNoSupportedFormat)
	if !errors.Is(err, ErrNoSupportedFormat) {
		t.Fatalf("err = %v, want ErrNoSupportedFormat", err)
	}
	// The proxy wraps the helper's error; the meaning must survive that too.
	_, err = relayRoundTrip(t, Content{}, proxyHelperError(ErrNoSupportedFormat.Error()))
	if !errors.Is(err, ErrNoSupportedFormat) {
		t.Fatalf("wrapped: err = %v, want ErrNoSupportedFormat", err)
	}
}

func TestRelayRoundTripKeepsUnavailable(t *testing.T) {
	_, err := relayRoundTrip(t, Content{}, ErrUserClipboardUnavailable)
	if !errors.Is(err, ErrUserClipboardUnavailable) || errors.Is(err, ErrNoSupportedFormat) {
		t.Fatalf("err = %v, want only ErrUserClipboardUnavailable", err)
	}
}

func TestRelayRoundTripReadFailureIsNotEmpty(t *testing.T) {
	_, err := relayRoundTrip(t, Content{}, errors.New("proxy: clipboard get: timeout"))
	if err == nil || errors.Is(err, ErrNoSupportedFormat) || errors.Is(err, ErrUserClipboardUnavailable) {
		t.Fatalf("err = %v, want a plain read failure", err)
	}
}

func TestContentFromRelayResultRejectsBadContent(t *testing.T) {
	cases := map[string]ipc.DesktopClipboardReadResult{
		"oversized image": {Type: "image", Image: make([]byte, MaxImageBytes+1), ImageFormat: "png"},
		"unknown type":    {Type: "files"},
		"empty type":      {},
		"image, no bytes": {Type: "image", ImageFormat: "png"},
		"image, no fmt":   {Type: "image", Image: []byte{1}},
		"rtf, no bytes":   {Type: "rtf"},
	}
	for name, res := range cases {
		if _, err := ContentFromRelayResult(res); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
