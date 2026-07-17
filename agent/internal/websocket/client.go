package websocket

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/netcache"
	"github.com/breeze-rmm/agent/internal/observability"
	"github.com/breeze-rmm/agent/internal/secmem"
)

var log = logging.L("websocket")

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	// maxMessageSize bounds inbound WS frames via conn.SetReadLimit. Exceeding
	// it is NOT a graceful rejection: gorilla returns ErrReadLimit and closes
	// the connection, forcing a reconnect — so keep generous headroom over the
	// largest legitimate frame. Audited 2026-07 (issue #2399): the largest
	// legit server→agent frame is a file_write command at ~5.6MB (4MB decoded
	// cap, tools.MaxFileWriteSize, base64-encoded + JSON envelope); the
	// "connected" welcome frame's pending-command batch is budgeted
	// server-side to 6MB of payloads. Everything else (http_request ~1.37MB,
	// tunnel_data ~1.33MB, scripts 1MB, terminal input 256KB, desktop SDP
	// 64KB) is far smaller. 16MB ≈ 2.8x the largest legit frame; the
	// relationship is pinned by TestMaxMessageSizeCoversLargestLegitimateFrame.
	maxMessageSize = 16 * 1024 * 1024
	initialBackoff = 1 * time.Second
	maxBackoff     = 60 * time.Second
	backoffFactor  = 2.0
	jitterFactor   = 0.3
)

const capabilityTerminalOutputBase64 = "terminal_output_base64"

var terminalOutputEnqueueTimeout = 5 * time.Second

// Config holds WebSocket client configuration
type Config struct {
	ServerURL string
	AgentID   string
	AuthToken *secmem.SecureString
	TLSConfig *tls.Config
}

// Command represents a command received via WebSocket
type Command struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

// CommandResult represents the result of a command execution
type CommandResult struct {
	Type      string `json:"type"`
	CommandID string `json:"commandId"`
	Status    string `json:"status"`
	Result    any    `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
}

// outboundResult pairs a marshalled command-result frame with the structured
// result it was encoded from, so writePump can hand the structured value back
// to the outbox owner (OnResultWriteFailed) if the write is dropped — see the
// resultChan handling in writePump. The bytes are marshalled once in
// SendResult so the pump never has to re-encode.
type outboundResult struct {
	data   []byte
	result CommandResult
}

// CommandHandler processes commands received via WebSocket
type CommandHandler func(cmd Command) CommandResult

// Client manages the WebSocket connection to the server
type Client struct {
	config               *Config
	serverURLMu          sync.RWMutex
	tlsConfigMu          sync.RWMutex
	conn                 *websocket.Conn
	connMu               sync.RWMutex
	capabilitiesMu       sync.RWMutex
	terminalOutputBase64 bool
	// serverCapabilities holds the full capability set advertised by the
	// server's most recent "connected" handshake message, keyed by name.
	// Reset to nil on every (re)connect until the next handshake lands, so a
	// dropped connection never leaves a stale capability latched on.
	serverCapabilities map[string]bool
	cmdHandler         CommandHandler
	done               chan struct{}
	sendChan           chan []byte
	// resultChan carries command results on a dedicated path (separate from the
	// generic sendChan) so writePump can distinguish a terminal command result
	// from an ephemeral status/progress frame. A result popped from this
	// channel that then fails to write (conn nil during a teardown gap, or a
	// WriteMessage error) is handed to OnResultWriteFailed instead of being
	// dropped — closing the loss window where SendResult reported success but
	// the frame never reached the wire. Results still buffered in this channel
	// when a pump exits are NOT drained: the next reconnect's writePump drains
	// them onto the fresh connection, so a plain WS blip loses nothing.
	resultChan      chan outboundResult
	binaryFrameChan chan []byte
	stopOnce        sync.Once
	isRunning       bool
	runningMu       sync.RWMutex

	// OnConnected, if set, is invoked synchronously from the read pump once
	// the server's "connected" welcome frame has been parsed — i.e. after a
	// full (re)connect handshake, not just a raw TCP/TLS dial. This is the
	// same message the capability negotiation handshake uses. Callers (e.g.
	// the heartbeat's backup-result outbox) use it to retry anything that
	// couldn't be sent before the last disconnect. Must not block: it runs
	// inline before the pump resumes reading. Set once at construction time,
	// before Start() is called — never mutated afterwards, so it's safe to
	// read without a lock.
	OnConnected func()

	// OnResultWriteFailed, if set, is invoked from writePump when a command
	// result popped off resultChan cannot be delivered to the wire — either the
	// connection was already torn down (conn == nil) or WriteMessage returned an
	// error. Without this, SendResult would have already reported success (the
	// frame made it into the channel) yet the terminal result would be silently
	// lost on a WS blip. The heartbeat layer sets this to re-persist the result
	// to its backup-result outbox, which the next reconnect flushes. Runs inline
	// on the write-pump goroutine and must not block. Set once at construction
	// time (see SetWebSocketClient), before Start(), so it needs no lock.
	//
	// NOTE: this hook fires for EVERY failed command-result write, not just
	// backup results — writePump can't tell them apart. That is deliberately
	// safe: the outbox re-sends via SendResult and the server tolerates a late
	// or duplicate terminal result. The only residual loss window is a result
	// whose WriteMessage returns nil (bytes accepted by the OS TCP buffer) but
	// which the server never processes before the connection drops; closing
	// that fully would need an application-level per-result ACK.
	OnResultWriteFailed func(CommandResult)
}

// New creates a new WebSocket client
func New(cfg *Config, handler CommandHandler) *Client {
	return &Client{
		config:          cfg,
		cmdHandler:      handler,
		done:            make(chan struct{}),
		sendChan:        make(chan []byte, 256),
		resultChan:      make(chan outboundResult, 256),
		binaryFrameChan: make(chan []byte, 30),
	}
}

// SetServerURL updates the control-plane base URL used by future WebSocket
// connection attempts after a backup server promotion.
func (c *Client) SetServerURL(u string) {
	c.serverURLMu.Lock()
	defer c.serverURLMu.Unlock()
	c.config.ServerURL = u
}

func (c *Client) serverURL() string {
	c.serverURLMu.RLock()
	defer c.serverURLMu.RUnlock()
	return c.config.ServerURL
}

// Start begins the WebSocket client
func (c *Client) Start() {
	c.runningMu.Lock()
	if c.isRunning {
		c.runningMu.Unlock()
		return
	}
	c.isRunning = true
	c.runningMu.Unlock()

	c.reconnectLoop()
}

// Stop gracefully closes the connection
func (c *Client) Stop() {
	c.stopOnce.Do(func() {
		c.runningMu.Lock()
		c.isRunning = false
		c.runningMu.Unlock()

		close(c.done)
		c.closeCurrentConn(true)

		log.Info("client stopped")
	})
}

func (c *Client) closeCurrentConn(sendClose bool) {
	c.connMu.Lock()
	defer c.connMu.Unlock()

	if c.conn == nil {
		return
	}

	if sendClose {
		_ = c.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(writeWait),
		)
	}
	_ = c.conn.Close()
	c.conn = nil
	c.resetConnectionCapabilities()
}

func (c *Client) currentTLSConfig() *tls.Config {
	c.tlsConfigMu.RLock()
	defer c.tlsConfigMu.RUnlock()
	return c.config.TLSConfig
}

// UpdateTLSConfig swaps the TLS config used for future dials.
func (c *Client) UpdateTLSConfig(tlsCfg *tls.Config) {
	c.tlsConfigMu.Lock()
	c.config.TLSConfig = tlsCfg
	c.tlsConfigMu.Unlock()
}

// ForceReconnect closes the active connection so the reconnect loop re-dials.
func (c *Client) ForceReconnect() {
	c.closeCurrentConn(false)
}

func (c *Client) connect() error {
	c.resetConnectionCapabilities()

	wsURL, err := c.buildWSURL()
	if err != nil {
		return fmt.Errorf("failed to build WebSocket URL: %w", err)
	}

	if c.config.AuthToken == nil || c.config.AuthToken.IsZeroed() {
		return fmt.Errorf("auth token is nil or zeroed — cannot connect")
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		TLSClientConfig:  c.currentTLSConfig(),
		// Last-known-good DNS cache (#2288) — TCP dial layer only; the TLS
		// handshake above still verifies the URL hostname.
		NetDialContext: netcache.Shared().DialContext,
	}
	headers := http.Header{
		"Authorization": {"Bearer " + c.config.AuthToken.Reveal()},
	}
	conn, _, err := dialer.Dial(wsURL, headers)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()

	conn.SetReadLimit(maxMessageSize)
	log.Info("connected", "server", c.serverURL())
	return nil
}

func (c *Client) buildWSURL() (string, error) {
	serverURL, err := url.Parse(c.serverURL())
	if err != nil {
		return "", err
	}

	switch serverURL.Scheme {
	case "https":
		serverURL.Scheme = "wss"
	case "http":
		serverURL.Scheme = "ws"
	}

	serverURL.Path = fmt.Sprintf("/api/v1/agent-ws/%s/ws", c.config.AgentID)

	return serverURL.String(), nil
}

func (c *Client) reconnectLoop() {
	backoff := initialBackoff

	for {
		select {
		case <-c.done:
			return
		default:
		}

		if err := c.connect(); err != nil {
			log.Warn("connection failed", "error", err.Error())

			jitter := time.Duration(float64(backoff) * jitterFactor * (rand.Float64()*2 - 1))
			sleep := backoff + jitter
			if sleep < 0 {
				sleep = backoff
			}

			log.Info("retrying", "delay", sleep)
			select {
			case <-c.done:
				return
			case <-time.After(sleep):
			}

			backoff = time.Duration(float64(backoff) * backoffFactor)
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}

		// Run read/write pumps — track how long the connection lasted
		connStart := time.Now()
		pumpDone := make(chan struct{})
		writerDone := make(chan struct{})
		go c.writePump(pumpDone, writerDone)
		c.readPump()
		close(pumpDone)
		<-writerDone
		c.closeCurrentConn(false)

		// Only reset backoff if connection was stable (lasted > 30s).
		// Immediate disconnects (e.g. auth rejection) keep exponential backoff
		// so a misconfigured agent doesn't flood the server.
		if time.Since(connStart) > 30*time.Second {
			backoff = initialBackoff
		}

		// Check if we should stop
		c.runningMu.RLock()
		running := c.isRunning
		c.runningMu.RUnlock()
		if !running {
			return
		}
	}
}

func (c *Client) readPump() {
	defer observability.Recoverer("websocket.readPump")
	c.connMu.RLock()
	conn := c.conn
	c.connMu.RUnlock()

	if conn == nil {
		return
	}

	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Warn("read error", "error", err.Error())
			}
			return
		}

		// First, check if this is a server message (has type but no id)
		var msg struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Warn("failed to parse message", "error", err.Error())
			continue
		}

		// Respond to server-side application-level pings so the server
		// doesn't close the connection for pong timeout (code 4008).
		if msg.Type == "ping" {
			pong, _ := json.Marshal(map[string]any{"type": "pong", "timestamp": time.Now().UnixMilli()})
			select {
			case c.sendChan <- pong:
			default:
				log.Warn("pong dropped, send channel full")
			}
			continue
		}

		if msg.Type == "connected" {
			c.handleConnectedMessage(message)
			continue
		}

		// Skip non-command messages (ack, heartbeat_ack, error, etc.)
		// Commands have both an ID and a type like "run_script", "list_processes", etc.
		if msg.ID == "" {
			// Server acknowledgments, errors, etc. - not commands
			continue
		}

		var cmd Command
		if err := json.Unmarshal(message, &cmd); err != nil {
			log.Warn("failed to parse command", "error", err.Error())
			continue
		}

		go c.processCommand(cmd)
	}
}

func (c *Client) handleConnectedMessage(raw []byte) {
	var msg struct {
		Type         string   `json:"type"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		log.Warn("failed to parse connected message", "error", err.Error())
		return
	}

	enabled := false
	caps := make(map[string]bool, len(msg.Capabilities))
	for _, capability := range msg.Capabilities {
		caps[capability] = true
		if capability == capabilityTerminalOutputBase64 {
			enabled = true
		}
	}
	c.setTerminalOutputBase64(enabled)
	c.setServerCapabilities(caps)

	if c.OnConnected != nil {
		c.OnConnected()
	}
}

func (c *Client) resetConnectionCapabilities() {
	c.setTerminalOutputBase64(false)
	c.setServerCapabilities(nil)
}

func (c *Client) setTerminalOutputBase64(enabled bool) {
	c.capabilitiesMu.Lock()
	c.terminalOutputBase64 = enabled
	c.capabilitiesMu.Unlock()
}

func (c *Client) terminalOutputBase64Enabled() bool {
	c.capabilitiesMu.RLock()
	defer c.capabilitiesMu.RUnlock()
	return c.terminalOutputBase64
}

func (c *Client) setServerCapabilities(caps map[string]bool) {
	c.capabilitiesMu.Lock()
	c.serverCapabilities = caps
	c.capabilitiesMu.Unlock()
}

// HasServerCapability reports whether the server advertised the named
// capability in its most recent "connected" handshake message. Returns false
// before the first handshake and after any (re)connect until the next one
// lands — callers must not assume a capability persists across a dropped
// connection.
func (c *Client) HasServerCapability(name string) bool {
	c.capabilitiesMu.RLock()
	defer c.capabilitiesMu.RUnlock()
	return c.serverCapabilities[name]
}

func (c *Client) writePump(done <-chan struct{}, exited chan<- struct{}) {
	defer observability.Recoverer("websocket.writePump")
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer close(exited)

	for {
		select {
		case <-done:
			return
		case <-c.done:
			return

		case message := <-c.sendChan:
			c.connMu.RLock()
			conn := c.conn
			c.connMu.RUnlock()

			if conn == nil {
				continue
			}

			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.TextMessage, message); err != nil {
				log.Warn("write error", "error", err.Error())
				return
			}

		case res := <-c.resultChan:
			c.connMu.RLock()
			conn := c.conn
			c.connMu.RUnlock()

			if conn == nil {
				// Teardown gap: no live connection to write to. Hand the result
				// back to the outbox owner so the next reconnect re-delivers it
				// rather than dropping it silently. (FIX 3)
				c.handleResultWriteFailure(res.result)
				continue
			}

			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.TextMessage, res.data); err != nil {
				log.Warn("result write error", "commandId", res.result.CommandID, "error", err.Error())
				// The write failed with the frame in flight; preserve the result
				// before the pump exits so the reconnect flush re-delivers it,
				// instead of losing a terminal result on a WS blip. (FIX 3)
				c.handleResultWriteFailure(res.result)
				return
			}

		case frame := <-c.binaryFrameChan:
			c.connMu.RLock()
			conn := c.conn
			c.connMu.RUnlock()

			if conn == nil {
				continue
			}

			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				log.Warn("binary write error", "error", err.Error())
				return
			}

		case <-ticker.C:
			c.connMu.RLock()
			conn := c.conn
			c.connMu.RUnlock()

			if conn == nil {
				continue
			}

			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) processCommand(cmd Command) {
	defer observability.Recoverer("websocket.processCommand")
	log.Info("processing command", "commandId", cmd.ID, "commandType", cmd.Type)

	result := c.cmdHandler(cmd)
	result.Type = "command_result"
	result.CommandID = cmd.ID

	if err := c.SendResult(result); err != nil {
		log.Error("failed to send command result", "commandId", cmd.ID, "error", err.Error())
	}
}

// SendResult sends a command result back to the server.
//
// Command results travel on the dedicated resultChan (not the generic
// sendChan) so writePump can preserve them via OnResultWriteFailed if the
// write is dropped. A nil return means the result was accepted into the
// channel — NOT that it reached the wire; the pump completes delivery and
// re-persists it on failure.
func (c *Client) SendResult(result CommandResult) error {
	data, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %w", err)
	}

	select {
	case c.resultChan <- outboundResult{data: data, result: result}:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("send channel is full")
	}
}

// handleResultWriteFailure hands a command result that writePump could not
// deliver back to the outbox owner (if one is registered) so it can be
// re-persisted for redelivery on the next reconnect. Safe to call with no
// hook set.
func (c *Client) handleResultWriteFailure(result CommandResult) {
	if c.OnResultWriteFailed != nil {
		c.OnResultWriteFailed(result)
	}
}

// SendDesktopFrame sends a binary JPEG frame to the server.
// Format: [0x02][36-byte sessionId UTF-8][JPEG data]
// Non-blocking: drops frame if channel is full.
func (c *Client) SendDesktopFrame(sessionId string, data []byte) error {
	// Build binary message: 1 byte type + 36 byte session ID + frame data
	msg := make([]byte, 1+36+len(data))
	msg[0] = 0x02
	copy(msg[1:37], []byte(sessionId))
	copy(msg[37:], data)

	select {
	case c.binaryFrameChan <- msg:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("frame channel full, dropping frame")
	}
}

// BinaryFrameChanStats returns the current depth and capacity of the binary
// frame send channel (used for tunnel data). A full channel stalls
// SendTunnelData, which blocks the tunnel read loop and produces one-directional
// freezes where input still works but server-side bytes stop flowing.
func (c *Client) BinaryFrameChanStats() (length, capacity int) {
	return len(c.binaryFrameChan), cap(c.binaryFrameChan)
}

// SendTunnelData sends binary tunnel data to the server.
// Format: [0x03][36-byte tunnelId UTF-8][payload]
//
// Unlike WebRTC frames, tunnel data is a bidirectional byte stream and dropped
// chunks corrupt the underlying protocol (VNC, proxy, etc.). This call BLOCKS
// when the send channel is full, which naturally pushes back on the TCP read
// loop and lets the OS's TCP flow control throttle the remote end.
func (c *Client) SendTunnelData(tunnelId string, data []byte) error {
	msg := make([]byte, 1+36+len(data))
	msg[0] = 0x03
	copy(msg[1:37], []byte(tunnelId))
	copy(msg[37:], data)

	select {
	case c.binaryFrameChan <- msg:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	}
}

// SendPatchProgress sends a patch download/install progress event to the server.
// Non-blocking: drops if send channel is full.
func (c *Client) SendPatchProgress(commandID string, event any) error {
	msg := map[string]any{
		"type":      "patch_progress",
		"commandId": commandID,
		"progress":  event,
	}
	msgBytes, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal patch progress: %w", err)
	}

	select {
	case c.sendChan <- msgBytes:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("send channel full, dropping progress")
	}
}

// SendUpdateStatus notifies the server that a self-update is about to start.
// Non-blocking: drops if send channel is full.
func (c *Client) SendUpdateStatus(targetVersion string) error {
	msg := map[string]any{
		"type":          "update_status",
		"targetVersion": targetVersion,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal update_status: %w", err)
	}

	select {
	case c.sendChan <- data:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("send channel full, dropping update_status")
	}
}

// SendVerificationProgress sends a backup verification progress event to the server.
// Non-blocking: drops if send channel is full.
func (c *Client) SendVerificationProgress(commandID string, event any) error {
	msg := map[string]any{
		"type":      "verification_progress",
		"commandId": commandID,
		"progress":  event,
	}
	msgBytes, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal verification progress: %w", err)
	}

	select {
	case c.sendChan <- msgBytes:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("send channel full, dropping progress")
	}
}

// SendBackupProgress sends a backup restore/operation progress event to the server.
// Non-blocking: drops if send channel is full.
func (c *Client) SendBackupProgress(commandID string, event any) error {
	msg := map[string]any{
		"type":      "backup_progress",
		"commandId": commandID,
		"progress":  event,
	}
	msgBytes, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal backup progress: %w", err)
	}

	select {
	case c.sendChan <- msgBytes:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("send channel full, dropping progress")
	}
}

// SendTerminalOutput sends terminal output data to the server.
// When the server advertises terminal_output_base64 in its connected handshake,
// output is base64-encoded so non-UTF-8 console bytes are not corrupted by JSON.
func (c *Client) SendTerminalOutput(sessionId string, data []byte) error {
	msg := map[string]any{
		"type":      "terminal_output",
		"sessionId": sessionId,
	}
	if c.terminalOutputBase64Enabled() {
		msg["data"] = base64.StdEncoding.EncodeToString(data)
		msg["encoding"] = "base64"
	} else {
		msg["data"] = string(data)
	}
	msgBytes, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal terminal output: %w", err)
	}

	timer := time.NewTimer(terminalOutputEnqueueTimeout)
	defer timer.Stop()

	select {
	case c.sendChan <- msgBytes:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	case <-timer.C:
		return fmt.Errorf("timed out waiting for terminal output queue")
	}
}
