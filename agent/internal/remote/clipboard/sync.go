package clipboard

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const defaultPollInterval = 500 * time.Millisecond

const (
	maxClipboardMessageBytes = 2 * 1024 * 1024
	maxClipboardTextBytes    = MaxTextBytes
	maxClipboardRTFBytes     = MaxRTFBytes
	maxClipboardImageBytes   = MaxImageBytes
)

var errClipboardSyncUnconfigured = errors.New("clipboard sync not configured")

type dcSender interface {
	SendText(s string) error
}

type ClipboardSync struct {
	sender       dcSender
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
		sender:       dc,
		provider:     provider,
		pollInterval: defaultPollInterval,
		stop:         make(chan struct{}),
	}
	if dc != nil {
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if err := syncer.Receive(msg); err != nil {
				log.Printf("[clipboard] receive error: %v", err)
			}
		})
	}
	return syncer
}

// newClipboardSyncWithSender is used by tests to inject a mock sender.
func newClipboardSyncWithSender(sender dcSender, provider Provider) *ClipboardSync {
	return &ClipboardSync{
		sender:       sender,
		provider:     provider,
		pollInterval: defaultPollInterval,
		stop:         make(chan struct{}),
	}
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
		var lastErrMsg string
		for {
			select {
			case <-ticker.C:
				content, err := c.provider.GetContent()
				if err != nil {
					// Only log when the error message changes to avoid spam
					msg := err.Error()
					if msg != lastErrMsg {
						log.Printf("[clipboard] failed to get content: %v", err)
						lastErrMsg = msg
					}
					continue
				}
				lastErrMsg = ""
				hash := fingerprint(content)
				c.mu.Lock()
				shouldSend := hash != c.lastSentHash
				c.mu.Unlock()
				if shouldSend {
					if err := c.Send(content); err != nil {
						log.Printf("[clipboard] failed to send content: %v", err)
					}
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
	if c.sender == nil {
		return errClipboardSyncUnconfigured
	}
	if err := ValidateContent(content); err != nil {
		return err
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

	if err := c.sender.SendText(string(encoded)); err != nil {
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
	if len(msg.Data) > maxClipboardMessageBytes {
		return fmt.Errorf("clipboard payload exceeds maximum %d bytes", maxClipboardMessageBytes)
	}

	payload, err := decodeClipboardPayload(msg)
	if err != nil {
		return err
	}
	if err := validateEncodedClipboardPayload(payload); err != nil {
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
	if err := ValidateContent(content); err != nil {
		return err
	}

	if err := c.provider.SetContent(content); err != nil {
		return err
	}

	fp := fingerprint(content)
	c.mu.Lock()
	c.lastSentHash = fp
	c.mu.Unlock()

	if c.sender != nil {
		ack, err := json.Marshal(struct {
			Type string `json:"type"`
			Hash string `json:"hash"`
		}{"ack", fmt.Sprintf("%x", fp)})
		if err == nil {
			_ = c.sender.SendText(string(ack))
		}
	}

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

func validateEncodedClipboardPayload(payload clipboardPayload) error {
	if len(payload.Text) > maxClipboardTextBytes {
		return fmt.Errorf("clipboard text exceeds maximum %d bytes", maxClipboardTextBytes)
	}
	if len(payload.RTF) > maxBase64EncodedLen(maxClipboardRTFBytes) {
		return fmt.Errorf("clipboard RTF exceeds maximum %d bytes", maxClipboardRTFBytes)
	}
	if len(payload.Image) > maxBase64EncodedLen(maxClipboardImageBytes) {
		return fmt.Errorf("clipboard image exceeds maximum %d bytes", maxClipboardImageBytes)
	}
	return nil
}

func maxBase64EncodedLen(decodedLen int) int {
	return ((decodedLen + 2) / 3) * 4
}
