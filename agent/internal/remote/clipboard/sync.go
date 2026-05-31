package clipboard

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
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

// Policy gates clipboard sync per direction. Enforced agent-side because the
// viewer is untrusted. Finding #7.
type Policy struct {
	HostToViewer bool // stream the host's clipboard to the viewer
	ViewerToHost bool // accept viewer clipboard writes onto the host
}

type ClipboardSync struct {
	sender       dcSender
	provider     Provider
	pollInterval time.Duration
	stop         chan struct{}
	policy       Policy

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

func NewClipboardSync(dc *webrtc.DataChannel, provider Provider, policy Policy) *ClipboardSync {
	syncer := &ClipboardSync{
		sender:       dc,
		provider:     provider,
		pollInterval: defaultPollInterval,
		stop:         make(chan struct{}),
		policy:       policy,
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
func newClipboardSyncWithSender(sender dcSender, provider Provider, policy Policy) *ClipboardSync {
	return &ClipboardSync{
		sender:       sender,
		provider:     provider,
		pollInterval: defaultPollInterval,
		stop:         make(chan struct{}),
		policy:       policy,
	}
}

func (c *ClipboardSync) Watch() {
	if c.provider == nil {
		return
	}

	// Host→viewer streaming disabled by policy: never poll or forward the host
	// clipboard. This is the silent-exfiltration guard — without it, whatever
	// the end user copies (passwords, MFA codes, secrets) streams to the
	// operator within one defaultPollInterval. Finding #7.
	if !c.policy.HostToViewer {
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

	// Audit the egress transfer (finding #8). Host→viewer is the silent
	// exfiltration direction, so make each transfer forensically visible
	// (type + size). NOTE: this lands in the agent diagnostic log stream
	// (slog → agent_logs), not yet the tamper-evident central audit_logs table.
	// TODO(#1012): route clipboard/filedrop transfers to central audit_logs.
	slog.Info("clipboard transfer",
		"direction", "host_to_viewer",
		"type", string(content.Type),
		"bytes", len(content.Text)+len(content.RTF)+len(content.Image))

	c.mu.Lock()
	c.lastSentHash = fingerprint(content)
	c.mu.Unlock()

	return nil
}

func (c *ClipboardSync) Receive(msg webrtc.DataChannelMessage) error {
	if c.provider == nil {
		return errClipboardSyncUnconfigured
	}
	// Viewer→host writes disabled by policy: drop inbound clipboard rather than
	// overwriting the host clipboard. Finding #7. A denied paste is a
	// security-relevant event, so audit it instead of dropping silently. Bytes
	// is the raw inbound message size (payload not decoded on the blocked path).
	// NOTE: diagnostic-log, not central audit_logs (see Send).
	// TODO(#1012): route clipboard/filedrop transfers to central audit_logs.
	if !c.policy.ViewerToHost {
		slog.Info("clipboard transfer blocked by policy",
			"direction", "viewer_to_host",
			"bytes", len(msg.Data))
		return nil
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

	// Audit the ingress transfer (finding #8): the viewer writing the host
	// clipboard. Same diagnostic-log caveat as the egress path above.
	// TODO(#1012): route clipboard/filedrop transfers to central audit_logs.
	slog.Info("clipboard transfer",
		"direction", "viewer_to_host",
		"type", string(content.Type),
		"bytes", len(content.Text)+len(content.RTF)+len(content.Image))

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
