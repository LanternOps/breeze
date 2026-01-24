package clipboard

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const defaultPollInterval = 500 * time.Millisecond

var errClipboardSyncUnconfigured = errors.New("clipboard sync not configured")

type ClipboardSync struct {
	dc           *webrtc.DataChannel
	provider     Provider
	pollInterval time.Duration
	stop         chan struct{}

	mu           sync.Mutex
	lastSentHash [32]byte
}

type clipboardPayload struct {
	Type        ContentType `json:"type"`
	Text        string      `json:"text,omitempty"`
	RTF         string      `json:"rtf,omitempty"`
	Image       string      `json:"image,omitempty"`
	ImageFormat string      `json:"image_format,omitempty"`
}

func NewClipboardSync(dc *webrtc.DataChannel, provider Provider) *ClipboardSync {
	syncer := &ClipboardSync{
		dc:           dc,
		provider:     provider,
		pollInterval: defaultPollInterval,
		stop:         make(chan struct{}),
	}
	if dc != nil {
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			_ = syncer.Receive(msg)
		})
	}
	return syncer
}

func (c *ClipboardSync) Watch() {
	if c.provider == nil {
		return
	}

	interval := c.pollInterval
	if interval <= 0 {
		interval = defaultPollInterval
	}

	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				content, err := c.provider.GetContent()
				if err != nil {
					continue
				}
				hash := fingerprint(content)
				c.mu.Lock()
				shouldSend := hash != c.lastSentHash
				c.mu.Unlock()
				if shouldSend {
					_ = c.Send(content)
				}
			case <-c.stop:
				return
			}
		}
	}()
}

func (c *ClipboardSync) Stop() {
	select {
	case <-c.stop:
		return
	default:
		close(c.stop)
	}
}

func (c *ClipboardSync) Send(content Content) error {
	if c.dc == nil {
		return errClipboardSyncUnconfigured
	}

	payload := clipboardPayload{Type: content.Type, Text: content.Text, ImageFormat: content.ImageFormat}
	if len(content.RTF) > 0 {
		payload.RTF = base64.StdEncoding.EncodeToString(content.RTF)
	}
	if len(content.Image) > 0 {
		payload.Image = base64.StdEncoding.EncodeToString(content.Image)
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	if err := c.dc.SendText(string(encoded)); err != nil {
		return err
	}

	c.mu.Lock()
	c.lastSentHash = fingerprint(content)
	c.mu.Unlock()

	return nil
}

func (c *ClipboardSync) Receive(msg webrtc.DataChannelMessage) error {
	if c.provider == nil {
		return errClipboardSyncUnconfigured
	}

	payload, err := decodeClipboardPayload(msg)
	if err != nil {
		return err
	}

	content := Content{Type: payload.Type, Text: payload.Text, ImageFormat: payload.ImageFormat}
	if payload.RTF != "" {
		data, err := base64.StdEncoding.DecodeString(payload.RTF)
		if err != nil {
			return err
		}
		content.RTF = data
	}
	if payload.Image != "" {
		data, err := base64.StdEncoding.DecodeString(payload.Image)
		if err != nil {
			return err
		}
		content.Image = data
	}

	if err := c.provider.SetContent(content); err != nil {
		return err
	}

	c.mu.Lock()
	c.lastSentHash = fingerprint(content)
	c.mu.Unlock()

	return nil
}

func (c *ClipboardSync) GetContent() (Content, error) {
	if c.provider == nil {
		return Content{}, errClipboardSyncUnconfigured
	}
	return c.provider.GetContent()
}

func (c *ClipboardSync) SetContent(content Content) error {
	if c.provider == nil {
		return errClipboardSyncUnconfigured
	}
	if err := c.provider.SetContent(content); err != nil {
		return err
	}

	c.mu.Lock()
	c.lastSentHash = fingerprint(content)
	c.mu.Unlock()

	return nil
}

func decodeClipboardPayload(msg webrtc.DataChannelMessage) (clipboardPayload, error) {
	var payload clipboardPayload
	if !msg.IsString {
		return payload, errors.New("clipboard payload must be text")
	}
	if err := json.Unmarshal(msg.Data, &payload); err != nil {
		return payload, err
	}
	return payload, nil
}
