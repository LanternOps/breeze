package clipboard

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
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

	peerChunked       atomic.Bool   // the viewer said hello with chunked:true
	bufferWaitTimeout time.Duration // how long a chunked send waits for the SCTP buffer
	rx                chunkAssembler
	rxBlockedID       string // transfer already counted as blocked (once per transfer)

	statsMu sync.Mutex
	stats   map[string]*TransferCount // key "direction/type"
	blocked int
}

// Summary is what crossed the clipboard channel during a session, for audit.
// Never any content.
type Summary struct {
	Transfers []TransferCount `json:"transfers"`
	Blocked   int             `json:"blocked"`
}

type TransferCount struct {
	Direction string `json:"direction"` // host_to_viewer | viewer_to_host
	Type      string `json:"type"`
	Count     int    `json:"count"`
	Bytes     int    `json:"bytes"`
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
		sender:            dc,
		provider:          provider,
		pollInterval:      defaultPollInterval,
		stop:              make(chan struct{}),
		policy:            policy,
		bufferWaitTimeout: chunkTransferTimeout,
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
		sender:            sender,
		provider:          provider,
		pollInterval:      defaultPollInterval,
		stop:              make(chan struct{}),
		policy:            policy,
		bufferWaitTimeout: chunkTransferTimeout,
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
		baselined := false
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
				// The first readable clipboard is what the end user had before
				// the session. Remember it instead of sending it: pushing it
				// would overwrite the technician's clipboard just for connecting,
				// with whatever the end user last copied. A viewer→host write
				// that landed before this poll has already set the hash; keep it.
				if !baselined {
					baselined = true
					c.mu.Lock()
					if c.lastSentHash == ([32]byte{}) {
						c.lastSentHash = hash
					}
					c.mu.Unlock()
					continue
				}
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

	// Chunk only for a viewer that said it can reassemble; older viewers keep
	// getting one message, exactly as before.
	if c.peerChunked.Load() && len(encoded) > chunkFrameMaxBytes {
		err = c.sendChunked(encoded)
	} else {
		err = c.sender.SendText(string(encoded))
	}
	if err != nil {
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
		"bytes", contentBytes(content))
	c.count("host_to_viewer", content)

	c.mu.Lock()
	c.lastSentHash = fingerprint(content)
	c.mu.Unlock()

	return nil
}

type bufferedSender interface {
	BufferedAmount() uint64
}

// The production sender must keep offering backpressure, or chunked sends
// would queue a whole image in SCTP without pausing.
var _ bufferedSender = (*webrtc.DataChannel)(nil)

// chunkBufferHighWater pauses a chunked send while this much is queued, so a
// slow viewer does not make the agent buffer a whole image in SCTP.
const chunkBufferHighWater = 1 << 20

func (c *ClipboardSync) sendChunked(inner []byte) error {
	frames, err := encodeChunks(newTransferID(), inner)
	if err != nil {
		return err
	}
	bs, _ := c.sender.(bufferedSender)
	for _, f := range frames {
		if bs != nil {
			deadline := time.Now().Add(c.bufferWaitTimeout)
			for bs.BufferedAmount() > chunkBufferHighWater {
				if time.Now().After(deadline) {
					return errors.New("clipboard channel buffer did not drain")
				}
				select {
				case <-c.stop:
					return errors.New("clipboard sync stopped")
				case <-time.After(10 * time.Millisecond):
				}
			}
		}
		if err := c.sender.SendText(string(f)); err != nil {
			return err
		}
	}
	return nil
}

// SendStatus tells the viewer what this channel allows, so it can show
// "disabled by policy" instead of guessing from silence. Viewers that predate
// it ignore an unknown message type.
func (c *ClipboardSync) SendStatus() error {
	if c.sender == nil {
		return errClipboardSyncUnconfigured
	}
	raw, err := json.Marshal(map[string]any{
		"type":               "status",
		"hostToViewer":       c.policy.HostToViewer,
		"viewerToHost":       c.policy.ViewerToHost,
		"chunked":            true,
		"suppressesBaseline": true,
		"maxTextBytes":       MaxTextBytes,
		"maxImageBytes":      MaxImageBytes,
	})
	if err != nil {
		return err
	}
	return c.sender.SendText(string(raw))
}

func contentBytes(content Content) int {
	return len(content.Text) + len(content.RTF) + len(content.Image)
}

func (c *ClipboardSync) count(direction string, content Content) {
	c.statsMu.Lock()
	defer c.statsMu.Unlock()
	if c.stats == nil {
		c.stats = map[string]*TransferCount{}
	}
	key := direction + "/" + string(content.Type)
	tc, ok := c.stats[key]
	if !ok {
		tc = &TransferCount{Direction: direction, Type: string(content.Type)}
		c.stats[key] = tc
	}
	tc.Count++
	tc.Bytes += contentBytes(content)
}

func (c *ClipboardSync) blockedTransfer(bytes int) {
	// A denied paste is security-relevant: audit it rather than dropping it
	// silently (finding #7). TODO(#1012): central audit_logs (W4c, #8261).
	slog.Info("clipboard transfer blocked by policy",
		"direction", "viewer_to_host",
		"bytes", bytes)
	c.statsMu.Lock()
	c.blocked++
	c.statsMu.Unlock()
}

// Summary returns the transfer counters, sorted by direction then type.
func (c *ClipboardSync) Summary() Summary {
	c.statsMu.Lock()
	defer c.statsMu.Unlock()
	out := Summary{Blocked: c.blocked}
	for _, tc := range c.stats {
		out.Transfers = append(out.Transfers, *tc)
	}
	sort.Slice(out.Transfers, func(i, j int) bool {
		if out.Transfers[i].Direction != out.Transfers[j].Direction {
			return out.Transfers[i].Direction < out.Transfers[j].Direction
		}
		return out.Transfers[i].Type < out.Transfers[j].Type
	})
	return out
}

func (c *ClipboardSync) Receive(msg webrtc.DataChannelMessage) error {
	if c.provider == nil {
		return errClipboardSyncUnconfigured
	}
	if !msg.IsString {
		return errors.New("clipboard payload must be text")
	}
	if len(msg.Data) > maxClipboardMessageBytes {
		return fmt.Errorf("clipboard payload exceeds maximum %d bytes", maxClipboardMessageBytes)
	}
	var head struct {
		Type    string `json:"type"`
		Chunked bool   `json:"chunked"`
	}
	if err := json.Unmarshal(msg.Data, &head); err != nil {
		return err
	}

	// hello is the viewer describing itself, not clipboard content: accepted
	// whatever the viewer→host policy says.
	if head.Type == "hello" {
		c.peerChunked.Store(head.Chunked)
		return nil
	}

	// Viewer→host writes disabled by policy: drop inbound clipboard rather than
	// overwriting the host clipboard (finding #7), counting a chunked transfer
	// once rather than per frame.
	if head.Type == "chunk" {
		var f chunkFrame
		if err := json.Unmarshal(msg.Data, &f); err != nil {
			return err
		}
		if !c.policy.ViewerToHost {
			// Once per transfer, not per frame. A frame with no usable id is
			// malformed and counted on its own.
			if f.ID == "" || len(f.ID) > maxTransferIDBytes || f.ID != c.rxBlockedID {
				if len(f.ID) <= maxTransferIDBytes {
					c.rxBlockedID = f.ID
				}
				c.blockedTransfer(len(msg.Data))
			}
			return nil
		}
		inner, done, err := c.rx.add(f)
		if err != nil || !done {
			return err
		}
		return c.applyInbound(inner, f.ID)
	}

	if !c.policy.ViewerToHost {
		c.blockedTransfer(len(msg.Data))
		return nil
	}
	return c.applyInbound(msg.Data, "")
}

// applyInbound writes one complete clipboard message from the viewer onto the
// host clipboard and acks it. transferID is set when it arrived in chunks.
func (c *ClipboardSync) applyInbound(raw []byte, transferID string) error {
	var payload clipboardPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
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
		"bytes", contentBytes(content))
	c.count("viewer_to_host", content)

	fp := fingerprint(content)
	c.mu.Lock()
	c.lastSentHash = fp
	c.mu.Unlock()

	if c.sender != nil {
		ack, err := json.Marshal(struct {
			Type string `json:"type"`
			Hash string `json:"hash"`
			ID   string `json:"id,omitempty"`
		}{"ack", fmt.Sprintf("%x", fp), transferID})
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
