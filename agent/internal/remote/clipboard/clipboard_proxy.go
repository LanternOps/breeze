package clipboard

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

var proxyLog = logging.L("clipboard.proxy")

// proxyProvider implements the clipboard Provider interface by delegating
// to a user helper via IPC. This allows clipboard access from the user's
// session context even when the root daemon has no display access.
type proxyProvider struct {
	session *sessionbroker.Session
}

// NewProxyProvider creates a clipboard provider that delegates via IPC.
func NewProxyProvider(session *sessionbroker.Session) Provider {
	return &proxyProvider{session: session}
}

func (p *proxyProvider) GetContent() (Content, error) {
	resp, err := p.session.SendCommand(
		fmt.Sprintf("clip-get-%d", time.Now().UnixNano()),
		ipc.TypeClipboardGet,
		nil,
		5*time.Second,
	)
	if err != nil {
		return Content{}, fmt.Errorf("proxy: clipboard get: %w", err)
	}

	if resp.Error != "" {
		return Content{}, fmt.Errorf("proxy: user helper error: %s", resp.Error)
	}

	var data struct {
		Type        string `json:"type"`
		Text        string `json:"text,omitempty"`
		Image       []byte `json:"image,omitempty"`
		ImageFormat string `json:"imageFormat,omitempty"`
	}
	if err := json.Unmarshal(resp.Payload, &data); err != nil {
		return Content{}, fmt.Errorf("proxy: unmarshal clipboard: %w", err)
	}

	return Content{
		Type:        ContentType(data.Type),
		Text:        data.Text,
		Image:       data.Image,
		ImageFormat: data.ImageFormat,
	}, nil
}

func (p *proxyProvider) SetContent(content Content) error {
	payload := map[string]any{
		"type":        string(content.Type),
		"text":        content.Text,
		"image":       content.Image,
		"imageFormat": content.ImageFormat,
	}

	resp, err := p.session.SendCommand(
		fmt.Sprintf("clip-set-%d", time.Now().UnixNano()),
		ipc.TypeClipboardSet,
		payload,
		5*time.Second,
	)
	if err != nil {
		return fmt.Errorf("proxy: clipboard set: %w", err)
	}
	if resp.Error != "" {
		return fmt.Errorf("proxy: user helper error: %s", resp.Error)
	}
	return nil
}
